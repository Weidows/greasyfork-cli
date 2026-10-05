/**
 * Userscript metadata, id parsing and version comparison.
 *
 * All pure functions — no I/O — so they are cheap to unit test.
 */

/** Parsed `// ==UserScript==` block. Keys are lowercase; repeated keys keep all values. */
export type UserscriptMeta = Map<string, string[]>;

const META_BLOCK = /\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/;
const META_LINE = /^\s*\/\/\s*@(\S+)\s+(.*?)\s*$/gm;
const SCRIPT_ID_IN_URL = /\/scripts\/(\d+)/;
const LEADING_ID = /^(\d+)/;

/**
 * Extract metadata from userscript source. When the file has no
 * `==UserScript==` fence the whole text is scanned anyway, matching how managers
 * tolerate hand-written headers.
 */
export function parseUserscriptMeta(source: string): UserscriptMeta {
  const block = META_BLOCK.exec(source)?.[1] ?? source;
  const meta: UserscriptMeta = new Map();
  for (const match of block.matchAll(META_LINE)) {
    const key = match[1]!.toLowerCase();
    const value = match[2]!;
    const existing = meta.get(key);
    if (existing) existing.push(value);
    else meta.set(key, [value]);
  }
  return meta;
}

/** First value for `key` (case-insensitive), or '' when absent. */
export function metaFirst(meta: UserscriptMeta, key: string): string {
  return meta.get(key.toLowerCase())?.[0] ?? '';
}

/** Every value for `key` (case-insensitive). */
export function metaAll(meta: UserscriptMeta, key: string): string[] {
  return meta.get(key.toLowerCase()) ?? [];
}

/**
 * Accept `405130`, `405130-slug` or a full Greasy Fork URL and return the id.
 * Throws when no id can be found, so a typo fails loudly instead of querying 0.
 */
export function parseScriptId(input: string): number {
  const trimmed = input.trim();
  const fromUrl = SCRIPT_ID_IN_URL.exec(trimmed)?.[1];
  if (fromUrl) return Number.parseInt(fromUrl, 10);
  const leading = LEADING_ID.exec(trimmed)?.[1];
  if (leading) return Number.parseInt(leading, 10);
  throw new Error(`cannot parse a script id from ${JSON.stringify(input)}`);
}

/** Derive the `.meta.js` / `.meta.css` URL from a code URL. */
export function metaUrlFrom(codeUrl: string): string {
  // Drop any query/hash first: versioned code URLs look like
  // `.../style.user.js?version=1284070`, and appending to that would produce a
  // broken `.user.js?version=1284070.meta.js`.
  const base = codeUrl.replace(/[?#].*$/, '');
  if (base.endsWith('.user.js')) return `${base.slice(0, -'.user.js'.length)}.meta.js`;
  if (base.endsWith('.user.css')) return `${base.slice(0, -'.user.css'.length)}.meta.css`;
  if (base.endsWith('.js')) return `${base.slice(0, -'.js'.length)}.meta.js`;
  if (base.endsWith('.css')) return `${base.slice(0, -'.css'.length)}.meta.css`;
  return `${base}.meta.js`;
}

const VERSION_SEP = /[.\-_+]/;

function segment(parts: string[], index: number): string {
  return parts[index] ?? '';
}

function isZeroSegment(value: string): boolean {
  return value.length > 0 && [...value].every((ch) => ch === '0');
}

/**
 * Compare two loose version strings, numerically where possible:
 * `compareVersions('6.10', '6.9') > 0`.
 *
 * Segments split on `[.\-_+]`; numbers rank below text; a missing segment ties
 * with a zero one, so `1.0` and `1.0.0` compare equal. Pre-release ordering
 * (`1.0-beta` > `1.0` here) is out of scope — update checks only compare
 * released versions.
 */
export function compareVersions(a: string, b: string): number {
  const as = a.split(VERSION_SEP);
  const bs = b.split(VERSION_SEP);
  const len = Math.max(as.length, bs.length);

  for (let i = 0; i < len; i++) {
    const sa = segment(as, i);
    const sb = segment(bs, i);
    if (sa === sb) continue;
    if (sa === '') {
      if (isZeroSegment(sb)) continue;
      return -1;
    }
    if (sb === '') {
      if (isZeroSegment(sa)) continue;
      return 1;
    }
    const na = /^\d+$/.test(sa) ? Number.parseInt(sa, 10) : null;
    const nb = /^\d+$/.test(sb) ? Number.parseInt(sb, 10) : null;
    if (na !== null && nb !== null) {
      if (na !== nb) return na < nb ? -1 : 1;
      continue;
    }
    if (na !== null) return -1; // numbers sort before text
    if (nb !== null) return 1;
    const cmp = sa < sb ? -1 : sa > sb ? 1 : 0;
    if (cmp !== 0) return cmp;
  }
  return 0;
}

/** Whether `remote` is a newer version than `local`. */
export function isNewer(remote: string, local: string): boolean {
  return compareVersions(remote, local) > 0;
}

const UNSAFE_FILENAME = /[<>:"/\\|?*\u0000-\u001f]/g;

/**
 * Strip characters Windows rejects, keeping CJK and emoji (script names are
 * full of both). Falls back to "script" when nothing is left.
 */
export function safeFilename(name: string): string {
  const cleaned = name.replace(UNSAFE_FILENAME, '_').replace(/[ .]+$/, '');
  return cleaned || 'script';
}

/**
 * Percent-decode the final path element of a URL, dropping any query or hash.
 *
 * The query matters: `versions.json` hands out code URLs like
 * `.../style.user.js?version=1284070`, and keeping the query would produce a
 * filename of `style.user.js?version=1284070` (invalid on Windows).
 */
export function baseName(url: string): string {
  const pathOnly = url.replace(/[?#].*$/, '');
  const last = pathOnly.slice(pathOnly.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}
