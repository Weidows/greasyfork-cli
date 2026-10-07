/**
 * Session handling: the cookie that keeps a Greasy Fork login alive.
 *
 * Greasy Fork has no API for logging in — only Devise's HTML form — so this
 * drives `POST /<locale>/users/sign_in` exactly as a browser would: fetch the
 * form, take its `authenticity_token`, post the credentials, keep the cookie.
 *
 * The password is never written to disk and never accepted as a command-line
 * argument (that would leak it into shell history and `ps`): it is read from the
 * `GF_PASSWORD` environment variable, or from a hidden interactive prompt.
 *
 * Only the resulting session cookie is persisted.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Client } from './client.js';
import { CookieJar, parseCookieHeader, type Cookie } from './cookie.js';
import { percentEncode } from './form.js';
import { findAuthenticityToken, findFormHtml, findFlash, hasOtpField, looksLikeSignIn, stripTags } from './htmlform.js';
import { HttpError, NetworkError, type HttpResponse } from './http.js';

/** The one cookie that *is* the session. */
export const SESSION_COOKIE_NAME = '_greasyfork_session';

/**
 * Build the session cookie from whatever the user pasted.
 *
 * Only the cookie is ever needed, and the reason this exists at all: an account
 * created through an external provider (GitHub / GitLab / Google) can have **no
 * password at all** — the site offers `remove_password` and refuses to let such an
 * account post until it has a "secure login". For those accounts a pasted session
 * is the only way in.
 *
 * Accepts a bare value, a `name=value` pair, or a whole `Cookie:` header, because
 * which of those a browser's devtools hands over depends on where you copy from.
 */
export function sessionCookieFromInput(input: string): Cookie | null {
  const raw = input.trim();
  if (!raw) return null;

  const withoutPrefix = raw.replace(/^cookie\s*:\s*/i, '');
  const pairs = parseCookieHeader(withoutPrefix);
  const named = pairs.find((p) => p.name === SESSION_COOKIE_NAME);
  const value = named ? named.value : raw;

  // The wire form is percent-escaped (a captured `Set-Cookie` reads
  // `…%2F…--…%3D%3D`), but devtools usually shows the decoded value, and a
  // decoded base64 value never contains `%` — so `%` is the tell.
  const looksEscaped = /%[0-9A-Fa-f]{2}/.test(value);
  return {
    name: SESSION_COOKIE_NAME,
    value: looksEscaped ? value : percentEncode(value),
    path: '/',
  };
}

/** Where the session lives; `GF_CONFIG_DIR` overrides it. */
export function configDir(): string {
  const explicit = process.env.GF_CONFIG_DIR;
  if (explicit) return explicit;
  if (process.platform === 'win32' && process.env.APPDATA) return join(process.env.APPDATA, 'gf');
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, 'gf');
  return join(homedir(), '.config', 'gf');
}

export function sessionPath(): string {
  return process.env.GF_SESSION ?? join(configDir(), 'session.json');
}

export interface SessionFile {
  /** ISO timestamp, for a "logged in 3 days ago" hint. */
  savedAt: string;
  /** The account the cookie belonged to when it was saved. */
  username?: string;
  cookies: Cookie[];
}

export function loadSession(path = sessionPath()): CookieJar | undefined {
  if (!existsSync(path)) return undefined;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SessionFile>;
    const jar = CookieJar.fromJSON(parsed.cookies);
    return jar.size > 0 ? jar : undefined;
  } catch {
    return undefined;
  }
}

export function saveSession(jar: CookieJar, username?: string, path = sessionPath()): void {
  const payload: SessionFile = {
    savedAt: new Date().toISOString(),
    ...(username ? { username } : {}),
    cookies: jar.toJSON(),
  };
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

export function clearSession(path = sessionPath()): boolean {
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

/** The login form's `action` is what to POST to, so a locale prefix is never guessed. */
function signInPath(client: Client, formAction: string | undefined): string {
  if (formAction) return formAction.startsWith('http') ? formAction : `${client.mainSite}${formAction}`;
  return `${client.mainSite}/${client.locale}/users/sign_in`;
}

export interface LoginResult {
  username: string;
  /** True when the login needed a TOTP code (so the caller knows to offer --otp). */
  usedOtp: boolean;
}

/**
 * Whether the current cookie is still accepted.
 *
 * `/<locale>/users/webhook-info` requires a login: signed out, the site answers
 * 200 after a redirect to the sign-in form, so the reliable signal is the page
 * *content*, not the status code. `new_user`/`user[password]` in the body means
 * the redirect landed on the sign-in form.
 */
export async function currentUser(client: Client): Promise<string | null> {
  const res = await client.fetchHtml(`${client.mainSite}/${client.locale}/users/webhook-info`);
  if (looksLikeSignIn(res.body)) return null;
  const name = /class=["']user-profile-link["'][^>]*>\s*<a[^>]*>([^<]+)</i.exec(res.body);
  if (name?.[1]) return stripTags(name[1]);
  // A protected page that is neither the sign-in form nor a profile link means
  // the session is valid but the marker moved — say "signed in" without a name
  // rather than wrongly reporting a logout.
  return isProtectedPage(res.body) ? '' : null;
}

/** A page that only a logged-in user can see. */
function isProtectedPage(html: string): boolean {
  return /webhook|Source Syncing|sign-out-link/i.test(html);
}

/**
 * Sign in. Returns once the session cookie is stored.
 *
 * `otp` is a TOTP code, only needed when the account has 2FA enabled; when it is
 * missing and the account requires it, the thrown error says so rather than
 * silently reporting a bad password.
 */
export async function login(
  client: Client,
  email: string,
  password: string,
  otp?: string,
): Promise<LoginResult> {
  const signInUrl = `${client.mainSite}/${client.locale}/users/sign_in`;
  const page = await client.fetchHtml(signInUrl);
  if (!looksLikeSignIn(page.body)) {
    // Already signed in via a stored cookie — nothing to do.
    const existing = await currentUser(client);
    if (existing !== null) return { username: existing || email, usedOtp: false };
  }

  const form = findFormHtml(page.body, (attrs) => (attrs.class ?? '').includes('new_user'));
  if (!form) throw new Error(`could not find the sign-in form at ${signInUrl}`);
  const postUrl = signInPath(client, form.action);
  const token = findAuthenticityToken(form.html) || findAuthenticityToken(page.body);

  const submit = async (extra: Array<[string, string]>): Promise<HttpResponse> =>
    client.submitForm(
      postUrl,
      [
        ['authenticity_token', token],
        ['user[email]', email],
        ['user[password]', password],
        ...extra,
      ],
      { referer: signInUrl },
    );

  const res = await submit(otp ? [['user[otp_attempt]', otp]] : []);

  if (hasOtpField(res.body)) {
    throw new Error(
      otp
        ? 'the two-factor code was rejected — check the current code and retry'
        : 'this account has two-factor authentication enabled — re-run with --otp <code>',
    );
  }

  const username = await verifyAfterLogin(client, res);
  if (username === null) throw new Error(explainSignInFailure(res));
  return { username, usedOtp: Boolean(otp) };
}

/**
 * After a sign-in POST, confirm the cookie works.
 *
 * Devise re-renders the form with a flash on failure, so a body that still looks
 * like the sign-in form is a failure; anything else is confirmed by asking a
 * protected page directly (the POST's own redirect target varies by account
 * state — unconfirmed e-mail, no scripts yet, etc.).
 */
async function verifyAfterLogin(client: Client, res: HttpResponse): Promise<string | null> {
  if (res.status >= 400) return null;
  if (res.finalUrl.includes('/users/sign_in') && looksLikeSignIn(res.body)) return null;
  const user = await currentUser(client);
  return user;
}

/**
 * The most specific diagnosis available for a rejected sign-in.
 *
 * The order matters: the site's own flash text is the best answer, and a CSRF
 * rejection is the confusing one, so it is named explicitly instead of being left
 * to fall through to "check the e-mail and password" — which sends the user
 * hunting for a wrong password that was never wrong.
 */
function explainSignInFailure(res: HttpResponse): string {
  const html = res.body;
  const flash = findFlash(html);
  const text = `${flash.alert ?? ''} ${flash.notice ?? ''}`.trim();
  if (/invalid|incorrect|not found/i.test(text)) return `sign-in failed: ${text}`;
  if (text) return `sign-in failed: ${text}`;
  if (html.includes('two_fa') || hasOtpField(html)) {
    return 'sign-in needed a two-factor code — re-run with --otp <code>';
  }
  if (html.includes('not confirmed') || /confirm your/i.test(html)) {
    return 'sign-in blocked: the account e-mail has not been confirmed yet — confirm it on the site first';
  }
  // A bare 422 with an empty body is Rails rejecting the CSRF token, which happens
  // when the POST does not carry the session the login page handed out.
  if (res.status === 422 && html.trim().length === 0) {
    return (
      'the site rejected the sign-in POST (422, empty body) — the session cookie from the ' +
      'login page did not come back with it. Re-run with -v to see the requests; if it ' +
      'persists, `gf login --cookie -` with a session copied from a browser works around it'
    );
  }
  if (html.trim().length === 0) {
    return `the site answered the sign-in with an empty body (HTTP ${res.status})`;
  }
  return 'sign-in failed (no error text in the response) — check the e-mail and password';
}

/** A readable message for a transport failure against the site. */
export function describeError(err: unknown): string {
  if (err instanceof HttpError) return `${err.message}`;
  if (err instanceof NetworkError) return err.message;
  return err instanceof Error ? err.message : String(err);
}
