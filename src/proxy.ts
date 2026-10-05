/**
 * Proxy discovery and socket establishment.
 *
 * Two measured facts drive the shape of this file:
 *
 * 1. `node:https` and global `fetch` (undici) both IGNORE `HTTP_PROXY` /
 *    `HTTPS_PROXY`. Greasy Fork is unreachable from mainland China without a
 *    proxy, so the tunnel has to be built by hand.
 * 2. **Bun ignores `https.Agent#createConnection` entirely.** Same code, same
 *    machine: Node invokes it once per request, Bun invokes it zero times and the
 *    request then goes straight at the proxy address (ECONNREFUSED). The release
 *    binaries are compiled by Bun, so an agent-based proxy cannot work there.
 *
 * This module therefore exports no Agent at all. `openSocket` returns a
 * ready-to-use socket — direct or through a hand-written CONNECT tunnel — and
 * `src/http.ts` speaks HTTP/1.1 over it. Only `node:net` and `node:tls` are
 * involved, and both behave identically on Node and Bun.
 *
 * Measured against a local http proxy (127.0.0.1:7890): 200 in ~2s, where bare
 * `fetch` times out after 10s.
 */

import { execFile } from 'node:child_process';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import tls from 'node:tls';

/** Environment variables checked, in priority order. */
const PROXY_ENV_KEYS = [
  'GREASYFORK_CLI_PROXY',
  'GF_PROXY',
  'https_proxy',
  'HTTPS_PROXY',
  'http_proxy',
  'HTTP_PROXY',
] as const;

/** Refuse a CONNECT response head larger than this. */
const MAX_CONNECT_HEAD = 64 * 1024;

/** First proxy URL found in the environment, or undefined. */
export function detectProxy(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const key of PROXY_ENV_KEYS) {
    const value = env[key];
    if (value && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * Read `git config --global https.proxy`. Many machines (this one included) have
 * a proxy configured only for git, with no shell variable exported, so git's
 * config is the most reliable single source.
 */
export function detectGitProxy(timeoutMs = 3000): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['config', '--global', '--get', 'https.proxy'],
      { timeout: timeoutMs, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(undefined);
        const value = stdout.trim();
        resolve(value || undefined);
      },
    );
  });
}

/**
 * Environment first, then git config. Returns undefined when the machine has no
 * proxy configured at all.
 */
export async function resolveProxy(explicit?: string): Promise<string | undefined> {
  if (explicit) return explicit;
  return detectProxy() ?? (await detectGitProxy());
}

/** Normalise a proxy string, defaulting the scheme to http://. */
export function parseProxyUrl(raw: string): URL {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  const url = new URL(withScheme);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(
      `unsupported proxy scheme ${url.protocol} (only http:// and https:// are supported)`,
    );
  }
  return url;
}

export interface OpenSocketOptions {
  host: string;
  port: number;
  /** Wrap the connection in TLS (https targets). */
  secure: boolean;
  /** Proxy URL; undefined connects directly. */
  proxy?: string;
  /** Timeout for establishing the connection, in ms. */
  timeoutMs?: number;
}

/**
 * Return a connected socket to `host:port`, directly or through a proxy CONNECT
 * tunnel. Already TLS-wrapped when `secure` is set.
 */
export function openSocket(options: OpenSocketOptions): Promise<Duplex> {
  const { host, port, secure, proxy, timeoutMs = 30_000 } = options;
  if (proxy) return tunnelThroughProxy(parseProxyUrl(proxy), options);
  return secure ? connectTls({ host, port, timeoutMs }) : connectPlain({ host, port, timeoutMs });
}

/**
 * TLS connect. ALPN explicitly offers http/1.1 so a server can never answer with
 * HTTP/2, which this transport does not speak.
 */
function connectTls({
  host,
  port,
  timeoutMs,
  socket,
}: {
  host: string;
  port: number;
  timeoutMs: number;
  socket?: Duplex;
}): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const secure = tls.connect(
      {
        ...(socket ? { socket } : { host, port }),
        servername: host,
        ALPNProtocols: ['http/1.1'],
      },
      () => {
        settled = true;
        secure.setTimeout(0);
        resolve(secure);
      },
    );
    const fail = (err: Error): void => {
      if (settled) return; // a later error belongs to the request, not the handshake
      settled = true;
      secure.destroy();
      reject(err);
    };
    secure.setTimeout(timeoutMs, () =>
      fail(new Error(`TLS handshake with ${host}:${port} timed out after ${timeoutMs}ms`)),
    );
    secure.once('error', fail);
  });
}

/** Plain TCP connect. */
function connectPlain({
  host,
  port,
  timeoutMs,
}: {
  host: string;
  port: number;
  timeoutMs: number;
}): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = net.connect({ host, port }, () => {
      settled = true;
      socket.setTimeout(0);
      resolve(socket);
    });
    const fail = (err: Error): void => {
      if (settled) return; // a later error belongs to the request, not the connect
      settled = true;
      socket.destroy();
      reject(err);
    };
    socket.setTimeout(timeoutMs, () =>
      fail(new Error(`connection to ${host}:${port} timed out after ${timeoutMs}ms`)),
    );
    socket.once('error', fail);
  });
}

/**
 * Open a CONNECT tunnel through an HTTP(S) proxy, then TLS-upgrade it.
 *
 * The CONNECT exchange is written by hand rather than via
 * `http.request({ method: 'CONNECT' })`, because that `'connect'` event is not
 * implemented outside Node.
 */
async function tunnelThroughProxy(
  proxy: URL,
  { host, port, secure, timeoutMs = 30_000 }: OpenSocketOptions,
): Promise<Duplex> {
  const isTlsProxy = proxy.protocol === 'https:';
  const proxyPort = Number(proxy.port) || (isTlsProxy ? 443 : 80);
  const target = `${host}:${port}`;

  let base: net.Socket;
  if (isTlsProxy) {
    base = await new Promise<tls.TLSSocket>((resolve, reject) => {
      // The proxy's own certificate is not ours to verify: this hop carries
      // nothing but the CONNECT request.
      const s = tls.connect(
        { host: proxy.hostname, port: proxyPort, rejectUnauthorized: false },
        () => resolve(s),
      );
      s.setTimeout(timeoutMs, () => {
        s.destroy();
        reject(new Error(`connection to proxy ${proxy.host} timed out after ${timeoutMs}ms`));
      });
      s.once('error', reject);
    });
  } else {
    base = await connectPlain({ host: proxy.hostname, port: proxyPort, timeoutMs });
  }

  const leftover = await negotiateConnect(base, target, timeoutMs);
  // A fast proxy can already have forwarded the server's first TLS record.
  if (leftover.length > 0) base.unshift(leftover);
  if (!secure) return base;
  return connectTls({ host, port, timeoutMs, socket: base });
}

/** Send CONNECT, require a 200, and return whatever followed the response head. */
function negotiateConnect(socket: net.Socket, target: string, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let head = Buffer.alloc(0);

    const cleanup = (): void => {
      socket.off('data', onData);
      socket.setTimeout(0);
    };
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(err);
    };
    const onData = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) {
        if (head.length > MAX_CONNECT_HEAD) {
          fail(new Error('proxy sent an oversized CONNECT response'));
        }
        return;
      }
      if (settled) return;

      const status = Number(head.subarray(0, end).toString('latin1').split(' ')[1] ?? 0);
      if (status !== 200) {
        fail(new Error(`proxy refused CONNECT to ${target} (HTTP ${status || '???'})`));
        return;
      }
      settled = true;
      cleanup();
      resolve(Buffer.from(head.subarray(end + 4)));
    };

    socket.setTimeout(timeoutMs, () =>
      fail(new Error(`proxy CONNECT to ${target} timed out after ${timeoutMs}ms`)),
    );
    socket.on('error', fail);
    socket.on('data', onData);
    socket.write(
      `CONNECT ${target} HTTP/1.1\r\n` +
        `Host: ${target}\r\n` +
        `Proxy-Connection: keep-alive\r\n` +
        `User-Agent: gf\r\n\r\n`,
    );
  });
}
