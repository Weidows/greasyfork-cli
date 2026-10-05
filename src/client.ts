/**
 * Greasy Fork API client.
 *
 * Greasy Fork publishes no formal API documentation, but every page links its
 * machine-readable sibling via `<link rel="alternate" type="application/json">`.
 * The endpoints below were verified against the live site:
 *
 *   search / list : https://api.greasyfork.org/scripts.json?q=&page=&per_page=&sort=&locale=
 *   by site       : https://api.greasyfork.org/scripts/by-site/<site>.json
 *   site chart    : https://api.greasyfork.org/scripts/by-site.json  (returns {site: count})
 *   detail        : https://api.greasyfork.org/scripts/<id>-<slug>.json
 *   resolve slug  : https://greasyfork.org/<locale>/scripts/<id>.json
 *   versions      : https://greasyfork.org/<locale>/scripts/<id>/versions.json
 *   user          : https://greasyfork.org/<locale>/users/<id|slug>.json
 *   raw code      : https://update.greasyfork.org/scripts/<id>/<name>.user.js
 *
 * Gotcha: `greasyfork.org/<locale>/scripts.json` IGNORES q/page/sort and always
 * returns the default chart. Search must go through the `api.` subdomain.
 */

import { get, getJson, NetworkError } from './http.js';
import { resolveProxy } from './proxy.js';
import {
  SORT_KEYS,
  type Script,
  type ScriptVersion,
  type SearchResult,
  type SortName,
  type UserDetail,
} from './types.js';

/** Known Greasy Fork hosts. */
export const MAIN_SITE = 'https://greasyfork.org';
export const API_HOST = 'https://api.greasyfork.org';
export const UPDATE_HOST = 'https://update.greasyfork.org';

/** Build-time version, injected from package.json by scripts/gen-version.mjs. */
export const VERSION = '__VERSION__';

/** Identifies this client, as the site's help page recommends. */
export const USER_AGENT = `greasyfork-cli/${VERSION} (+https://greasyfork.org/help/api)`;

/** Search / listing parameters. */
export interface SearchOptions {
  /** Empty or omitted returns the top chart. */
  query?: string;
  page?: number;
  /** Capped at 100 by the server. */
  perPage?: number;
  sort?: SortName;
  /** Overrides the client locale for this call. */
  locale?: string;
  /** Restrict to one site, e.g. `bilibili.com`. */
  site?: string;
}

export interface ClientOptions {
  /** Explicit proxy; otherwise detected from the environment or git config. */
  proxy?: string;
  /** Never use a proxy, even if one is configured. */
  noProxy?: boolean;
  /** Site locale for page and detail endpoints. Defaults to `en`. */
  locale?: string;
  timeoutMs?: number;
  /** Log each request; receives a line per request. */
  onRequest?: (line: string) => void;
  /** Override the API host (mainly for tests). */
  apiHost?: string;
  mainSite?: string;
}

export class Client {
  readonly apiHost: string;
  readonly mainSite: string;
  locale: string;
  readonly timeoutMs: number;

  private proxy: string | undefined;
  private readonly noProxy: boolean;
  private readonly onRequest: ((line: string) => void) | undefined;
  private proxyResolved = false;

  constructor(options: ClientOptions = {}) {
    this.apiHost = options.apiHost ?? API_HOST;
    this.mainSite = options.mainSite ?? MAIN_SITE;
    this.locale = options.locale ?? 'en';
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.noProxy = options.noProxy ?? false;
    this.onRequest = options.onRequest;
    if (options.proxy) this.proxy = options.proxy;
  }

  /** Resolve the proxy once, on first use. */
  private async proxyFor(): Promise<string | undefined> {
    if (this.noProxy) return undefined;
    if (!this.proxyResolved) {
      this.proxy = await resolveProxy(this.proxy);
      this.proxyResolved = true;
    }
    return this.proxy;
  }

  /** The proxy in use, if any. */
  get activeProxy(): string | undefined {
    return this.proxy;
  }

  private async request(url: string, accept?: string): Promise<string> {
    const proxy = await this.proxyFor();
    this.onRequest?.(`GET ${url}`);
    const hint = proxy
      ? undefined
      : '\n  hint: no proxy detected — if greasyfork.org is unreachable from your network,' +
        ' pass --proxy http://127.0.0.1:7890';
    try {
      const res = await get(url, {
        proxy,
        timeoutMs: this.timeoutMs,
        accept,
        userAgent: USER_AGENT,
        proxyHint: hint,
      });
      return res.body;
    } catch (err) {
      if (err instanceof NetworkError && hint) throw new NetworkError(url, err.cause, hint);
      throw err;
    }
  }

  private async json<T>(url: string): Promise<T> {
    const proxy = await this.proxyFor();
    this.onRequest?.(`GET ${url}`);
    const hint = proxy
      ? undefined
      : '\n  hint: no proxy detected — if greasyfork.org is unreachable from your network,' +
        ' pass --proxy http://127.0.0.1:7890';
    try {
      return await getJson<T>(url, {
        proxy,
        timeoutMs: this.timeoutMs,
        userAgent: USER_AGENT,
        proxyHint: hint,
      });
    } catch (err) {
      if (err instanceof NetworkError && hint) throw new NetworkError(url, err.cause, hint);
      throw err;
    }
  }

  /** Run a search, or list the top chart when no query is given. */
  async search(options: SearchOptions = {}): Promise<SearchResult> {
    const params = new URLSearchParams();
    if (options.page) params.set('page', String(options.page));
    if (options.perPage) {
      params.set('per_page', String(Math.min(Math.max(options.perPage, 1), 100)));
    }
    if (options.query) params.set('q', options.query);
    const sortKey = options.sort ? SORT_KEYS[options.sort] : '';
    if (sortKey) params.set('sort', sortKey);
    const locale = options.locale ?? this.locale;
    if (locale) params.set('locale', locale);

    const base = options.site
      ? `${this.apiHost}/scripts/by-site/${encodeURIComponent(options.site)}.json`
      : `${this.apiHost}/scripts.json`;
    const query = params.toString();
    return this.json<SearchResult>(query ? `${base}?${query}` : base);
  }

  /**
   * Resolve a script's URL slug. Required because `/scripts/<id>.json` without a
   * slug answers 404.
   */
  async slug(id: number): Promise<string> {
    const data = await this.json<{ url?: string }>(
      `${this.mainSite}/${this.locale}/scripts/${id}.json`,
    );
    const tail = (data.url ?? '').slice((data.url ?? '').lastIndexOf('/') + 1);
    const dash = tail.indexOf('-');
    if (dash < 0) return '';
    try {
      return decodeURIComponent(tail.slice(dash + 1));
    } catch {
      return tail.slice(dash + 1);
    }
  }

  /** Full detail record for one script. */
  async script(id: number): Promise<Script> {
    const slug = await this.slug(id);
    const suffix = slug ? `-${encodeURIComponent(slug)}` : '';
    return this.json<Script>(`${this.apiHost}/scripts/${id}${suffix}.json`);
  }

  /** Every released version of a script, newest first. */
  async versions(id: number): Promise<ScriptVersion[]> {
    return this.json<ScriptVersion[]>(
      `${this.mainSite}/${this.locale}/scripts/${id}/versions.json`,
    );
  }

  /** A user's profile plus their published scripts. */
  async user(who: string | number): Promise<UserDetail> {
    return this.json<UserDetail>(
      `${this.mainSite}/${this.locale}/users/${encodeURIComponent(String(who))}.json`,
    );
  }

  /** Number of scripts per targeted site (the server sends a `{site: count}` map). */
  async sites(): Promise<Record<string, number>> {
    return this.json<Record<string, number>>(`${this.apiHost}/scripts/by-site.json`);
  }

  /**
   * Resolve the raw-source URL for a script, optionally for one version.
   * Returns the script record too when it had to be fetched.
   */
  async codeUrl(
    id: number,
    version?: string,
  ): Promise<{ codeUrl: string; script?: Script; version?: string }> {
    if (version) {
      const versions = await this.versions(id);
      const match = versions.find((v) => v.version === version);
      if (!match) throw new Error(`script ${id} has no version ${JSON.stringify(version)}`);
      return { codeUrl: match.code_url, version: match.version };
    }
    const script = await this.script(id);
    return { codeUrl: script.code_url ?? '', script };
  }

  /** Fetch an arbitrary resource (script source, meta block) by URL. */
  async raw(url: string): Promise<string> {
    return this.request(url, 'text/javascript');
  }
}

export function createClient(options: ClientOptions = {}): Client {
  return new Client(options);
}
