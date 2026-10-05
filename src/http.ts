/**
 * HTTP transport.
 *
 * Deliberately built on `node:http`/`node:https` rather than global `fetch`, for
 * two reasons: `fetch` ignores `HTTP_PROXY`/`HTTPS_PROXY` (see proxy.ts), and the
 * direct path needs no dependency at all.
 */

import http from 'node:http';
import https from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { ProxyAgent } from './proxy.js';

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

/** A transport-level failure, i.e. the request never completed. */
export class NetworkError extends Error {
  constructor(
    readonly url: string,
    cause: unknown,
    readonly hint?: string,
  ) {
    super(`cannot reach ${url}: ${cause instanceof Error ? cause.message : String(cause)}${hint ?? ''}`);
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
  /** Included in the error hint when the transport fails. */
  proxyHint?: string;
  /** Maximum redirects to follow (default 5). */
  maxRedirects?: number;
}

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.message?.includes('404');
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/**
 * GET a URL, following redirects, and read the whole body as text.
 *
 * Redirect following is not optional: `greasyfork.org/<locale>/scripts/<id>.json`
 * answers **308** to `api.greasyfork.org/...` (verified), and `node:http` does not
 * follow redirects the way Go's http.Client does. Without this, every endpoint on
 * the main site yields an empty 308 body — which looks like an empty JSON reply.
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
    if (REDIRECT_STATUS.has(res.status) && location) {
      if (hop >= maxRedirects) {
        throw new HttpError(res.status, url, `too many redirects (stopped at ${current})`);
      }
      current = new URL(location, current).toString();
      continue;
    }
    return res;
  }
}

/** One request, no redirect following. */
function getOnce(url: string, options: RequestOptions): Promise<HttpResponse> {
  const { proxy, timeoutMs = 30_000, accept, userAgent } = options;

  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const secure = target.protocol === 'https:';
    const transport = secure ? https : http;

    const headers: Record<string, string> = {};
    if (userAgent) headers['user-agent'] = userAgent;
    if (accept) headers.accept = accept;

    const request = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (secure ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers,
        // Through a proxy we only implement CONNECT, which is HTTPS-only.
        agent: proxy ? new ProxyAgent(proxy, { timeoutMs }) : false,
        signal: AbortSignal.timeout(timeoutMs),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (status === 404) return reject(new NotFoundError(url));
          if (status === 429) return reject(new RateLimitError(url));
          if (status >= 400) return reject(new HttpError(status, url));
          resolve({ status, headers: res.headers, body });
        });
      },
    );

    request.once('error', (err: Error) => {
      if (err instanceof HttpError || isNotFound(err)) return reject(err);
      reject(new NetworkError(url, err, options.proxyHint));
    });
    request.end();
  });
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
