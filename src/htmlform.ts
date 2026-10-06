/**
 * HTML scraping helpers for the logged-in form flows.
 *
 * Greasy Fork's write paths are plain Rails forms — no API — so `gf login` and
 * `gf publish` have to read a hidden `authenticity_token` out of a page and post
 * the right field names back. These are deliberately regex-based rather than a
 * DOM parser: the project has zero runtime dependencies, and the shapes being
 * extracted are a handful of `<input>` tags.
 *
 * Everything here is pure and unit tested offline in test/laconic.test.ts.
 */

/** Decode the five entities Rails' `html_escape` can produce. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Every attribute of one tag, as a name → value map. */
function parseAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  for (let m = re.exec(tag); m; m = re.exec(tag)) {
    attrs[m[1]!.toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? '');
  }
  return attrs;
}

export interface FormField {
  name: string;
  value: string;
}

/**
 * The hidden CSRF token of a page.
 *
 * A page can carry several (Greasy Fork's login page has one per form), and the
 * first is not necessarily the one on the form being submitted — so `scope` can
 * pin the search to one `<form>` when the caller knows where to look.
 */
export function findAuthenticityToken(html: string): string {
  const meta = /<meta[^>]*name=["']csrf-token["'][^>]*>/i.exec(html);
  if (meta) {
    const content = parseAttributes(meta[0]).content;
    if (content) return content;
  }
  const re = /<input[^>]*>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const attrs = parseAttributes(m[0]);
    if (attrs.name === 'authenticity_token' && attrs.value) return attrs.value;
  }
  return '';
}

/** Every `<input>` in a fragment, as name → value (submit buttons included). */
export function findInputs(html: string): FormField[] {
  const out: FormField[] = [];
  const re = /<input[^>]*>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const attrs = parseAttributes(m[0]);
    if (attrs.name !== undefined) out.push({ name: attrs.name, value: attrs.value ?? '' });
  }
  return out;
}

/** A `<select name=…>` and its candidate values, in document order. */
export interface SelectField {
  name: string;
  values: string[];
  selected: string;
}

export function findSelects(html: string): SelectField[] {
  const out: SelectField[] = [];
  const re = /<select[^>]*>([\s\S]*?)<\/select>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const attrs = parseAttributes(m[0]!.slice(0, m[0]!.indexOf('>')));
    if (attrs.name === undefined) continue;
    const body = m[1] ?? '';
    const values: string[] = [];
    let selected = '';
    const opt = /<option[^>]*>/gi;
    for (let o = opt.exec(body); o; o = opt.exec(body)) {
      const oa = parseAttributes(o[0]);
      const value = oa.value ?? '';
      values.push(value);
      if (oa.selected !== undefined) selected = value;
    }
    out.push({ name: attrs.name, values, selected });
  }
  return out;
}

/**
 * Whether a page is the sign-in form.
 *
 * Used as the "your session is gone" probe: Greasy Fork answers a logged-out
 * request for a protected page with a redirect to this form, and following that
 * redirect silently would otherwise look like success.
 */
export function looksLikeSignIn(html: string): boolean {
  return /<form[^>]*class=["'][^"']*new_user["']/i.test(html) && /user\[password\]/i.test(html);
}

/** Rails' flash notice / alert text, if the page renders one. */
export function findFlash(html: string): { notice?: string; alert?: string } {
  const out: { notice?: string; alert?: string } = {};
  const notice = /<p[^>]*class=["'][^"']*\bnotice\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i.exec(html);
  if (notice) out.notice = stripTags(notice[1] ?? '');
  const alert = /<p[^>]*class=["'][^"']*\balert\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i.exec(html);
  if (alert) out.alert = stripTags(alert[1] ?? '');
  return out;
}

/** All text inside `<div class="validation-errors">`, one error per line. */
export function findValidationErrors(html: string): string[] {
  const block = /<div[^>]*class=["'][^"']*validation-errors[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(
    html,
  );
  if (!block) return [];
  const body = block[1] ?? '';
  const messages: string[] = [];
  const re = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    const text = stripTags(m[1] ?? '');
    if (text) messages.push(text);
  }
  return messages;
}

/**
 * The first `<form>` matching `predicate`, with its inner HTML.
 *
 * The inner HTML matters: a page can carry several `authenticity_token` inputs
 * (Greasy Fork's sign-in page has one per form), and only the one inside the form
 * being submitted is valid. HTML forbids nested forms, so the first `</form>` is
 * always this form's.
 */
export function findFormHtml(
  html: string,
  predicate: (attrs: Record<string, string>) => boolean,
): { action: string; method: string; html: string } | undefined {
  const re = /<form\b[^>]*>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const attrs = parseAttributes(m[0]!);
    if (!predicate(attrs)) continue;
    const start = m.index + m[0]!.length;
    const end = html.toLowerCase().indexOf('</form>', start);
    return {
      action: attrs.action ?? '',
      method: (attrs.method ?? 'get').toUpperCase(),
      html: html.slice(start, end < 0 ? undefined : end),
    };
  }
  return undefined;
}

/** Whether the page is the 2FA code step rather than a finished sign-in. */
export function hasOtpField(html: string): boolean {
  return /name=["']user\[otp_attempt\]["']/i.test(html);
}

/**
 * The first form whose *contents* contain `marker`.
 *
 * Identifying a form by an attribute is not always possible — the publish form
 * carries no distinguishing class or id, only a `script_version[code]` textarea
 * inside it — and the marker is what actually identifies it.
 */
export function findFormContaining(
  html: string,
  marker: string,
): { action: string; method: string; html: string } | undefined {
  const re = /<form\b[^>]*>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const start = m.index + m[0]!.length;
    const end = html.toLowerCase().indexOf('</form>', start);
    const inner = html.slice(start, end < 0 ? undefined : end);
    if (!inner.includes(marker)) continue;
    const attrs = parseAttributes(m[0]!);
    return {
      action: attrs.action ?? '',
      method: (attrs.method ?? 'get').toUpperCase(),
      html: inner,
    };
  }
  return undefined;
}

/**
 * The human-readable part of an error page.
 *
 * Greasy Fork renders its "you cannot post right now" states (rate limited,
 * e-mail unconfirmed, disposable address, read-only mode) as a bare paragraph
 * with no form at all, so the paragraph *is* the diagnosis.
 */
export function pageSummary(html: string): string {
  const main = /<div[^>]*id=["']main["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/i.exec(html);
  const body = main?.[1] ?? html;
  const paragraphs: string[] = [];
  const re = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    const text = stripTags(m[1] ?? '');
    if (text) paragraphs.push(text);
    if (paragraphs.length >= 3) break;
  }
  return paragraphs.join(' ').trim();
}

/**
 * The title of the script page a successful publish redirects to, e.g.
 * "Foo Bar". Returns '' when the page does not look like a script page.
 */
export function findScriptName(html: string): string {
  const m = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  return m ? stripTags(m[1] ?? '') : '';
}

/** Collapse a fragment to plain, single-spaced text. */
export function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}
