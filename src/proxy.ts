/**
 * Proxy support.
 *
 * Node's global `fetch` (undici) and `node:https` both IGNORE `HTTP_PROXY` /
 * `HTTPS_PROXY`. Greasy Fork is unreachable from mainland China without a proxy,
 * so this cannot be left to the environment: the proxy is discovered and the
 * tunnel is built by hand.
 *
 * `ProxyAgent` below implements HTTPS-over-proxy with `CONNECT` + a TLS upgrade,
 * using only `node:http`/`node:https`/`node:tls`. Measured against a local
 * http proxy (127.0.0.1:7890) this returns 200 in ~2s where bare `fetch` times
 * out after 10s.
 */

import { execFile } from 'node:child_process';
import http from 'node:http';
import type { RequestOptions } from 'node:http';
import https from 'node:https';
import type { Duplex } from 'node:stream';
import tls from 'node:tls';

/** Environment variables checked, in priority order. */
const PROXY_ENV_KEYS = [
  'GREASYFORK_CLI_PROXY',
  'https_proxy',
  'HTTPS_PROXY',
  'http_proxy',
  'HTTP_PROXY',
] as const;

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
 * a proxy configured only for git, with no shell variable exported, so the git
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
    throw new Error(`unsupported proxy scheme ${url.protocol} (only http:// and https:// are supported)`);
  }
  return url;
}

interface ConnectTarget {
  host: string;
  port: number;
}

/**
 * An `https.Agent` that routes every connection through an HTTP proxy using the
 * CONNECT method, then upgrades the tunnel to TLS.
 */
export class ProxyAgent extends https.Agent {
  private readonly proxyUrl: URL;
  private readonly connectTimeout: number;

  constructor(proxy: string | URL, options: { timeoutMs?: number } = {}) {
    super({ keepAlive: false, maxSockets: 4 });
    this.proxyUrl = typeof proxy === 'string' ? parseProxyUrl(proxy) : proxy;
    this.connectTimeout = options.timeoutMs ?? 30_000;
  }

  /** Open a CONNECT tunnel and wrap it in TLS. */
  private tunnel({ host, port }: ConnectTarget): Promise<tls.TLSSocket> {
    return new Promise((resolve, reject) => {
      const isTlsProxy = this.proxyUrl.protocol === 'https:';
      const connectOptions: RequestOptions = {
        host: this.proxyUrl.hostname,
        port: Number(this.proxyUrl.port) || (isTlsProxy ? 443 : 80),
        method: 'CONNECT',
        path: `${host}:${port}`,
        headers: { host: `${host}:${port}`, 'user-agent': 'greasyfork-cli' },
        timeout: this.connectTimeout,
      };
      // The proxy's own certificate is not ours to verify.
      const request = isTlsProxy
        ? https.request({ ...connectOptions, rejectUnauthorized: false })
        : http.request(connectOptions);

      request.once('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          reject(new Error(`proxy refused CONNECT to ${host}:${port} (HTTP ${res.statusCode})`));
          return;
        }
        const secure = tls.connect({ socket, servername: host }, () => resolve(secure));
        secure.once('error', reject);
      });
      request.once('timeout', () =>
        request.destroy(new Error(`proxy CONNECT to ${host}:${port} timed out`)),
      );
      request.once('error', reject);
      request.end();
    });
  }

  // Public and typed against the base class exactly: `Agent` declares
  // createConnection public, so narrowing it to protected (or widening the
  // callback's socket type) makes the whole agent unassignable to `Agent`.
  override createConnection(
    options: RequestOptions,
    callback?: (err: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    const host = options.host ?? options.hostname;
    if (!host) throw new Error('proxy agent: no host to connect to');
    const port = typeof options.port === 'number' ? options.port : Number(options.port) || 443;
    this.tunnel({ host, port }).then(
      (socket) => callback?.(null, socket),
      (err: Error) => callback?.(err, undefined as unknown as Duplex),
    );
    return undefined;
  }
}
