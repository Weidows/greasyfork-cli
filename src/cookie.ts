/**
 * A cookie jar for Greasy Fork's session (`_greasyfork_session`).
 *
 * Hand-written because the project has no runtime dependencies and because the
 * only thing needed is "remember what the server set, send it back" — not a
 * general-purpose RFC 6265 store.
 *
 * All of this is pure, so it is unit tested offline in test/cookie.test.ts.
 */

export interface Cookie {
  name: string;
  value: string;
  /** Defaults to `/`. */
  path: string;
  domain?: string;
  secure?: boolean;
  /** Raw `Expires` value; kept for round-tripping, not for expiry decisions. */
  expires?: string;
}

/**
 * Split on `;` but never inside a quoted value — `Expires=Wed, 21 Oct 2015
 * 07:28:00 GMT` is one attribute, and a naive split on `,` or `;` mangles it.
 */
function splitAttributes(line: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    if (ch === ';' && !quoted) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Parse one `Set-Cookie` header line. Returns null when it is not parsable. */
export function parseSetCookie(line: string): Cookie | null {
  const parts = splitAttributes(line);
  const pair = parts.shift();
  if (!pair) return null;
  const eq = pair.indexOf('=');
  if (eq <= 0) return null;

  const cookie: Cookie = {
    name: pair.slice(0, eq).trim(),
    value: pair.slice(eq + 1).trim(),
    path: '/',
  };
  if (!cookie.name) return null;

  for (const attr of parts) {
    const eq2 = attr.indexOf('=');
    const key = (eq2 < 0 ? attr : attr.slice(0, eq2)).trim().toLowerCase();
    const value = eq2 < 0 ? '' : attr.slice(eq2 + 1).trim();
    if (key === 'path' && value.startsWith('/')) cookie.path = value;
    else if (key === 'domain') cookie.domain = value.replace(/^\./, '').toLowerCase();
    else if (key === 'secure') cookie.secure = true;
    else if (key === 'expires') cookie.expires = value;
    else if (key === 'max-age' && value === '0') cookie.expires = 'Thu, 01 Jan 1970 00:00:00 GMT';
  }
  return cookie;
}

/** Parse the value of a `Cookie:` request header into pairs. */
export function parseCookieHeader(header: string): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    out.push({ name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim() });
  }
  return out;
}

const EXPIRED = Date.parse('Thu, 01 Jan 1970 00:00:00 GMT');

/** A minimal store keyed by `name` + `path`, the way a browser keys cookies. */
export class CookieJar {
  private readonly cookies = new Map<string, Cookie>();

  private static key(cookie: Cookie): string {
    return `${cookie.name}\u0000${cookie.path}`;
  }

  get size(): number {
    return this.cookies.size;
  }

  set(cookie: Cookie): void {
    const key = CookieJar.key(cookie);
    // An explicit past expiry is how a server deletes a cookie.
    if (cookie.expires && Date.parse(cookie.expires) <= EXPIRED) {
      this.cookies.delete(key);
      return;
    }
    this.cookies.set(key, cookie);
  }

  /** Absorb every `Set-Cookie` header line from one response. */
  absorb(setCookieHeaders: string[]): void {
    for (const line of setCookieHeaders) {
      const cookie = parseSetCookie(line);
      if (cookie) this.set(cookie);
    }
  }

  all(): Cookie[] {
    return [...this.cookies.values()];
  }

  /** The value for a `Cookie:` request header, or '' when empty. */
  header(): string {
    return this.all()
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }

  toJSON(): Cookie[] {
    return this.all();
  }

  /** Rebuild a jar from `session.json`; tolerates anything malformed. */
  static fromJSON(raw: unknown): CookieJar {
    const jar = new CookieJar();
    if (!Array.isArray(raw)) return jar;
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const { name, value, path, domain, secure, expires } = entry as Record<string, unknown>;
      if (typeof name !== 'string' || typeof value !== 'string' || !name) continue;
      const cookie: Cookie = { name, value, path: typeof path === 'string' ? path : '/' };
      if (typeof domain === 'string') cookie.domain = domain;
      if (secure === true) cookie.secure = true;
      if (typeof expires === 'string') cookie.expires = expires;
      jar.set(cookie);
    }
    return jar;
  }
}
