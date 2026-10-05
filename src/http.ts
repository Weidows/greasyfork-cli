/**
 * HTTP transport.
 *
 * Hand-rolled over `node:net` / `node:tls` rather than `node:http(s).request`:
 *
 *  - `fetch` ignores `HTTP_PROXY` / `HTTPS_PROXY` (see proxy.ts).
 *  - **Bun ignores `https.Agent#createConnection`** (measured: 0 calls against
 *    Node's 1), so the Bun-compiled release binaries cannot tunnel via an agent.
 *  - `node:http` does not follow redirects, and every main-site JSON endpoint on
 *    greasyfork.org answers 308.
 *
 * Speaking HTTP/1.1 over a socket we opened ourselves behaves identically on Node
 * and Bun, and the response parsing lives in http1.ts, which is pure and unit
 * tested offline.
 */

import type { IncomingHttpHeaders } from 'node:http';
import type { Duplex } from 'node:stream';

import { BodyReader, parseHead } from './http1.js';
import { openSocket } from './proxy.js';

/** HTTP-level failure carrying the status code. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    message?: string,
  ) {
    super(message ?? `HTTP ${status} for ${url}`);
    this.name = 'HttpError';
  }
}

/** The resource does not exist (404). */
export class NotFoundError extends HttpError {
  constructor(url: string) {
    super(404, url, `not found: ${url}`);
    this.name = 'NotFoundError';
  }
}

/** The server is rate limiting us (429). */
export class RateLimitError extends HttpError {
  constructor(url: string) {
    super(429, url, `rate limited (429) for ${url} — robots.txt asks for Crawl-delay: 1`);
    this.name = 'RateLimitError';
  }
}

/** A transport-level failure: the request never completed. */
export class NetworkError extends Error {
  constructor(
    readonly url: string,
    cause: unknown,
    readonly hint?: string,
  ) {
    super(
      `cannot reach ${url}: ${cause instanceof Error ? cause.message : String(cause)}${hint ?? ''}`,
    );
    this.name = 'NetworkError';
  }
}

export interface HttpResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface RequestOptions {
  /** Proxy URL; when omitted the request goes direct. */
  proxy?: string;
  timeoutMs?: number;
  accept?: string;
  userAgent?: string;
  /** Appended to the transport error, so the CLI can explain a proxy fix. */
  proxyHint?: string;
  /** Maximum redirects to follow (default 5). */
  maxRedirects?: number;
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const DEFAULT_USER_AGENT = 'gf';
const MAX_HEAD = 64 * 1024;

/**
 * GET a URL, following redirects, and read the whole body as text.
 *
 * Redirect following is not optional: `greasyfork.org/<locale>/scripts/<id>.json`
 * answers **308** to `api.greasyfork.org/...` (verified). Without it every
 * main-site endpoint yields an empty body that reads as an empty JSON reply.
 *
 * Non-2xx responses raise `NotFoundError` / `RateLimitError` / `HttpError`, so
 * callers never mistake an error page for content.
 */
export async function get(url: string, options: RequestOptions = {}): Promise<HttpResponse> {
  const maxRedirects = options.maxRedirects ?? 5;
  let current = url;

  for (let hop = 0; ; hop++) {
    const res = await getOnce(current, options);
    const location = res.headers.location;
    if (REDIRECT_STATUS.has(res.status) && typeof location === 'string' && location) {
      if (hop >= maxRedirects) {
        throw new HttpError(res.status, url, `too many redirects (stopped at ${current})`);
      }
      current = new URL(location, current).toString();
      continue;
    }
    return res;
  }
}

/** One request on one socket; no redirect following. */
async function getOnce(url: string, options: RequestOptions): Promise<HttpResponse> {
  const { proxy, timeoutMs = 30_000, accept, userAgent = DEFAULT_USER_AGENT, proxyHint } = options;
  const target = new URL(url);
  const secure = target.protocol === 'https:';
  const port = Number(target.port) || (secure ? 443 : 80);

  let sock: Duplex | undefined;
  let lastError: unknown;
  // One retry, connection stage only: a fresh CONNECT+TLS through a proxy
  // occasionally stalls on first use, and retrying is harmless for a GET.
  for (let attempt = 0; attempt < 2 && !sock; attempt++) {
    try {
      sock = await openSocket({ host: target.hostname, port, secure, proxy, timeoutMs });
    } catch (err) {
      lastError = err;
    }
  }
  if (!sock) throw new NetworkError(url, lastError, proxyHint);
  // Bind to a const: TypeScript will not keep the narrowing inside the closures
  // below for a mutable binding, and `socket.destroy()` there would be an error.
  const socket: Duplex = sock;

  return new Promise<HttpResponse>((resolve, reject) => {
    let settled = false;
    let head: Buffer = Buffer.alloc(0);
    let reader: BodyReader | undefined;
    let status = 0;
    let headers: IncomingHttpHeaders = {};

    const timer = setTimeout(
      () => fail(new NetworkError(url, new Error(`timed out after ${timeoutMs}ms`), proxyHint)),
      timeoutMs,
    );

    function fail(err: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    }

    function succeed(): void {
      if (settled || !reader) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      try {
        resolve(build(status, headers, reader.body(), url));
      } catch (err) {
        reject(err);
      }
    }

    socket.on('data', (chunk: Buffer) => {
      if (settled) return;
      if (!reader) {
        head = Buffer.concat([head, chunk]);
        let parsed;
        try {
          parsed = parseHead(head);
        } catch (err) {
          fail(new NetworkError(url, err, proxyHint));
          return;
        }
        if (!parsed) {
          if (head.length > MAX_HEAD) {
            fail(new NetworkError(url, new Error('response head too large'), proxyHint));
          }
          return;
        }
        status = parsed.status;
        headers = parsed.headers as IncomingHttpHeaders;
        try {
          reader = new BodyReader(parsed);
        } catch (err) {
          fail(new NetworkError(url, err, proxyHint));
          return;
        }
      } else {
        try {
          reader.push(chunk);
        } catch (err) {
          fail(new NetworkError(url, err, proxyHint));
          return;
        }
      }
      if (reader.done) succeed();
    });

    socket.on('end', () => {
      if (settled) return;
      if (!reader) {
        fail(
          new NetworkError(
            url,
            new Error('connection closed before the response head completed'),
            proxyHint,
          ),
        );
        return;
      }
      // Close-delimited bodies only finish here.
      reader.end();
      succeed();
    });

    socket.once('error', (err: Error) => fail(new NetworkError(url, err, proxyHint)));

    socket.write(requestHead(target, port, secure, { accept, userAgent }));
  });
}

/** Turn a raw response into the public shape, raising on error statuses. */
function build(
  status: number,
  headers: IncomingHttpHeaders,
  body: Buffer,
  url: string,
): HttpResponse {
  if (status === 404) throw new NotFoundError(url);
  if (status === 429) throw new RateLimitError(url);
  if (status >= 400) throw new HttpError(status, url);
  return { status, headers, body: body.toString('utf8') };
}

/**
 * Serialise a GET request head.
 *
 * `Accept-Encoding: identity` keeps bodies free of compression (nothing to gunzip
 * and no dependency), and `Connection: close` makes the body framing obvious.
 */
function requestHead(
  target: URL,
  port: number,
  secure: boolean,
  { accept, userAgent }: { accept?: string; userAgent: string },
): string {
  const defaultPort = secure ? 443 : 80;
  const hostHeader = port === defaultPort ? target.hostname : `${target.hostname}:${port}`;
  const lines = [
    `GET ${target.pathname}${target.search} HTTP/1.1`,
    `Host: ${hostHeader}`,
    'Accept-Encoding: identity',
    'Connection: close',
    `User-Agent: ${userAgent}`,
  ];
  if (accept) lines.push(`Accept: ${accept}`);
  return `${lines.join('\r\n')}\r\n\r\n`;
}

/** GET a URL and parse the body as JSON. */
export async function getJson<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const res = await get(url, { accept: 'application/json', ...options });
  try {
    return JSON.parse(res.body) as T;
  } catch (err) {
    // A few `.json` endpoints answer with an HTML error page and status 200.
    const head = res.body.slice(0, 120).replace(/\s+/g, ' ');
    throw new Error(
      `${url} did not return JSON (${err instanceof Error ? err.message : String(err)}): ${head}`,
    );
  }
}
