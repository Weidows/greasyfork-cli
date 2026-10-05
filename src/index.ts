/**
 * Library entry point.
 *
 * The CLI lives in `cli.ts`; everything here is the importable surface:
 *
 *   import { Client } from 'greasyfork-cli';
 *   const c = new Client({ locale: 'zh-CN' });
 *   const res = await c.search({ query: 'bilibili', perPage: 10 });
 */

export * from './types.js';
export * from './client.js';
export * from './meta.js';
export * from './format.js';
export * from './proxy.js';
export * from './args.js';
export { HttpError, NotFoundError, RateLimitError, NetworkError } from './http.js';
export type { HttpResponse, RequestOptions } from './http.js';
