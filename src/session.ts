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

/**
 * Where the session lives: `~/.config/gf`, on every platform.
 *
 * Deliberately **not** `%APPDATA%` on Windows. That is the *roaming* profile — on
 * a domain-joined machine Windows copies it to the server at logon and logoff,
 * so a session cookie would travel with it. A second reason: one documented
 * directory instead of three, so every message and doc quotes the same path.
 *
 * `GF_CONFIG_DIR` wins outright; `XDG_CONFIG_HOME` is honoured on any platform
 * (that is what the spec says it means, and it is what makes this testable).
 * `env` is injectable so a test can prove the default without running on Windows.
 */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GF_CONFIG_DIR) return env.GF_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'gf');
  return join(homedir(), '.config', 'gf');
}

export function sessionPath(): string {
  return process.env.GF_SESSION ?? join(configDir(), 'session.json');
}

/** Where Windows builds before 0.2.3 kept the session. */
function legacySessionPath(env: NodeJS.ProcessEnv): string | undefined {
  return env.APPDATA ? join(env.APPDATA, 'gf', 'session.json') : undefined;
}

/**
 * The legacy file that belongs to `path`, or undefined when none does.
 *
 * Migration and the cleanup in `clearSession` apply to the **default** location
 * only: an explicit `path` argument or `GF_SESSION` means "use exactly this
 * file", and moving data into or out of it uninvited would be surprising.
 */
function legacyFor(path: string, env: NodeJS.ProcessEnv): string | undefined {
  // Any explicit override means "use exactly where I said" — never raid %APPDATA%.
  //
  // GF_CONFIG_DIR must be named separately from the path comparison below, because
  // setting it makes configDir() *return* that directory: `path` then equals
  // `join(configDir(env), 'session.json')`, so an explicitly chosen directory
  // looks identical to the default and gets migrated into. Measured — that moved a
  // live session out of %APPDATA% during a verification run.
  if (env.GF_SESSION) return undefined;
  if (env.GF_CONFIG_DIR) return undefined;
  if (path !== join(configDir(env), 'session.json')) return undefined;
  return legacySessionPath(env);
}

export interface SessionFile {
  /** ISO timestamp, for a "logged in 3 days ago" hint. */
  savedAt: string;
  /** The account the cookie belonged to when it was saved. */
  username?: string;
  cookies: Cookie[];
}

/** One parsed session file. */
interface StoredSession {
  jar: CookieJar;
  username?: string;
}

/** Read one session file; undefined when it is missing, blank or corrupt. */
function readSessionFile(path: string): StoredSession | undefined {
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
    if (jar.size === 0) return undefined;
    return {
      jar,
      ...(typeof parsed.username === 'string' ? { username: parsed.username } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Read the stored session, moving it off the pre-0.2.3 Windows location once.
 *
 * Without the migration, changing the default directory would silently sign out
 * every existing Windows user. It is deliberately one-way and best-effort: the
 * read already succeeded, so a failed move must not cost the user their session.
 */
export function loadSession(path = sessionPath()): CookieJar | undefined {
  const stored = readSessionFile(path);
  if (stored) return stored.jar;

  const legacy = legacyFor(path, process.env);
  const old = legacy ? readSessionFile(legacy) : undefined;
  if (!old || !legacy) return undefined;
  try {
    saveSession(old.jar, old.username, path);
    rmSync(legacy, { force: true });
  } catch {
    // Keep the old file; the caller still gets the jar that was just read.
  }
  return old.jar;
}

export function saveSession(jar: CookieJar, username?: string, path = sessionPath()): void {
  const payload: SessionFile = {
    savedAt: new Date().toISOString(),
    ...(username ? { username } : {}),
    cookies: jar.toJSON(),
  };
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });

  // Drop the pre-0.2.3 copy, or a later `gf logout` would leave it behind to be
  // "migrated" straight back on the next read.
  const legacy = legacyFor(path, process.env);
  if (legacy) rmSync(legacy, { force: true });
}

export function clearSession(path = sessionPath()): boolean {
  let removed = false;
  if (existsSync(path)) {
    rmSync(path);
    removed = true;
  }
  // The legacy file too, for the same reason as in saveSession.
  const legacy = legacyFor(path, process.env);
  if (legacy && existsSync(legacy)) {
    rmSync(legacy, { force: true });
    removed = true;
  }
  return removed;
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
