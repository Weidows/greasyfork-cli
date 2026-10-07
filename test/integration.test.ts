/**
 * End-to-end tests against a real (local) HTTP server.
 *
 * Everything else in `test/` is a pure function under test. These prove the
 * *pipeline*: a POST is actually written to a socket with the right method,
 * headers and body, the cookie jar actually carries `Set-Cookie` forward through
 * a redirect, redirects are followed with the right method semantics, and "the
 * publish succeeded" is decided from the final URL rather than a status code —
 * because a rejected publish is also a 200.
 *
 * A local server is used rather than greasyfork.org so the suite stays offline
 * and cannot touch a real account. The fixtures are trimmed from the live pages.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Client } from '../src/client.js';
import { CookieJar } from '../src/cookie.js';
import { inspectSource, publish, PublishError } from '../src/publish.js';
import { clearSession, currentUser, loadSession, login, saveSession, SESSION_COOKIE_NAME } from '../src/session.js';

const SCRIPT = `// ==UserScript==
// @name         Fixture Script
// @namespace    https://example.invalid/
// @version      2.1.0
// @match        https://example.invalid/*
// ==/UserScript==
console.log('hi');
`;

interface Recorded {
  method: string;
  url: string;
  body: string;
  cookie: string;
  referer?: string;
  contentType?: string;
}

/** Every request the fake site received, so tests can assert what was sent. */
const seen: Recorded[] = [];

const SCRIPT_PAGE = '/en/scripts/98765-fixture-script';
const FRESH_COOKIE = '_greasyfork_session=fresh; path=/; httponly';
/** The cookie Rails plants on the sign-in GET, which the POST must echo back. */
const SESSION_COOKIE = SESSION_COOKIE_NAME;
/** Makes each sign-in GET hand out a distinct session, as Rails does. */
let signInSessionCounter = 0;

const NAV =
  '<div id="site-nav"><div id="nav-user-info">' +
  '<span class="user-profile-link"><a href="/en/users/1-testuser">TestUser</a></span>' +
  '<span class="sign-out-link">[ <a href="/en/users/sign_out">Sign out</a> ]</span>' +
  '</div></div>';

/**
 * The sign-in page, which deliberately carries TWO forms with different tokens.
 * Only the token belonging to the form actually submitted is valid, so picking
 * the wrong one is a real, silent CSRF failure.
 *
 * `sid` is mirrored into the form's action so the POST can be checked against the
 * cookie — see `SIGN_IN_SESSION` below for why that matters.
 */
function signInPage(flash = '', sid = ''): string {
  return `<!DOCTYPE html><html><head>
<meta name="csrf-param" content="authenticity_token" />
<meta name="csrf-token" content="META_TOKEN" />
</head><body>
<form class="language-selector" action="/users/sign_in">
  <input type="hidden" name="authenticity_token" value="LOCALE_FORM_TOKEN" />
</form>
<form class="new_user" id="new_user" action="/en/users/sign_in?sid=${sid}" method="post">
  <input type="hidden" name="authenticity_token" value="LOGIN_FORM_TOKEN" />
  <input autocomplete="email" type="email" name="user[email]" id="user_email" />
  <input type="password" name="user[password]" id="user_password" />
  <input type="submit" name="commit" value="Log in" />
</form>
${flash}
</body></html>`;
}

/** The publish form. No class and no id, exactly like the real one. */
function publishFormPage(action: string, warnings = '', errors = ''): string {
  return `<html><body>
${errors}
<form action="${action}" method="post" enctype="multipart/form-data">
  <input type="hidden" name="authenticity_token" value="PUB_TOKEN" />
  <input type="hidden" name="language" value="js" />
  <input type="radio" name="script[script_type]" value="1" checked />
  <select name="script[locale_id]"><option value="">Auto</option><option value="33">English</option></select>
  <textarea name="script_version[code]"></textarea>
  <input type="file" name="code_upload" />
  ${warnings}
  <input type="submit" name="commit" value="Post script" />
</form></body></html>`;
}

/** A Rails checkbox pair: the hidden one always ships, the box only when ticked. */
const warningCheckbox = (field: string): string =>
  `<input type="hidden" name="script_version[${field}]" value="0" />` +
  `<input type="checkbox" name="script_version[${field}]" value="true" />`;

/** Paths a logged-out visitor is bounced from, exactly as the real site does. */
function isProtected(url: string, method: string): boolean {
  if (url.startsWith('/en/users/webhook-info')) return true;
  if (url.startsWith('/en/script_versions/new')) return true;
  if (/^\/en\/scripts\/\d+\/versions\/new$/.test(url)) return true;
  if (method === 'POST' && /^\/en\/(script_versions|scripts\/\d+\/versions)$/.test(url)) return true;
  return false;
}

function handler(req: IncomingMessage, res: ServerResponse): void {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk: string) => (body += chunk));
  req.on('end', () => {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';
    const cookie = String(req.headers.cookie ?? '');
    seen.push({
      method,
      url,
      body,
      cookie,
      ...(req.headers.referer ? { referer: String(req.headers.referer) } : {}),
      ...(req.headers['content-type'] ? { contentType: String(req.headers['content-type']) } : {}),
    });
    const signedIn = cookie.includes('_greasyfork_session=fresh');

    const html = (page: string): void => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page);
    };
    /** Any status, with headers — needed to reproduce a bare 422, not just 200s. */
    const respond = (
      status: number,
      headers: Record<string, string | string[]>,
      page: string,
    ): void => {
      res.writeHead(status, headers);
      res.end(page);
    };
    const redirect = (to: string, setCookie?: string[]): void => {
      const headers: Record<string, string | string[]> = { Location: to };
      if (setCookie) headers['Set-Cookie'] = setCookie;
      res.writeHead(302, headers);
      res.end();
    };

    // The sign-in form itself is never protected, or nobody could ever log in.
    if (url.startsWith('/en/users/sign_in') && method === 'GET') {
      // Hand out a session exactly as Rails does. Binding the CSRF token to it is
      // the whole point: the real site answers a POST that arrives WITHOUT this
      // cookie with a bare 422 and an EMPTY body, and that is indistinguishable
      // from a wrong password unless the fake server reproduces it. Every other
      // test here pre-loads a jar, so this is the only path that can catch a
      // first-ever login dropping the login page's cookies.
      const sid = `s${++signInSessionCounter}`;
      return respond(
        200,
        { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': [`${SESSION_COOKIE}=${sid}; path=/; httponly`] },
        signInPage('', sid),
      );
    }

    if (url.startsWith('/en/users/sign_in') && method === 'POST') {
      // CSRF/session check, like Rails: the token is only valid with the session
      // that issued it.
      const sid = new URL(url, 'http://x').searchParams.get('sid') ?? '';
      if (!sid || !cookie.includes(`${SESSION_COOKIE}=${sid}`)) {
        return respond(422, { 'Content-Type': 'text/html; charset=utf-8' }, '');
      }
      // A TOTP code was supplied, or the password is simply right.
      if (body.includes('user%5Botp_attempt%5D')) return redirect('/en/', [FRESH_COOKIE]);
      if (body.includes('user%5Bemail%5D=good%40example.invalid')) {
        return redirect('/en/', [FRESH_COOKIE]);
      }
      if (body.includes('user%5Bemail%5D=2fa%40example.invalid')) {
        // A 2FA account: the first POST re-renders with an OTP field instead of
        // signing in. Trimming to just that field is what makes the difference
        // from the ordinary sign-in form detectable.
        return html(
          '<form class="new_user" action="/en/users/sign_in" method="post">' +
            '<input name="user[password]" type="password" />' +
            '<input name="user[otp_attempt]" /></form>',
        );
      }
      // Any other password: Devise re-renders the form with a flash.
      return html(signInPage('<p class="alert">Invalid email or password.</p>'));
    }

    // Everything below needs a session, and answers a logged-out request with a
    // redirect to the sign-in form — which is what makes "signed out" detectable
    // by content rather than by status code.
    if (isProtected(url, method) && !signedIn) return redirect('/en/users/sign_in');

    if (url === '/en/' || url === '/') {
      if (!signedIn) return redirect('/en/users/sign_in');
      return html(`<html><body>${NAV}<p>home</p></body></html>`);
    }

    if (url.startsWith('/en/users/webhook-info')) {
      return html(`<html><body>${NAV}<h2>Source Syncing</h2></body></html>`);
    }

    // The unauthenticated lookup the update path makes before posting.
    if (/^\/en\/scripts\/\d+\.json$/.test(url)) {
      res.writeHead(404, { 'Content-Type': 'application/json' }).end('{}');
      return;
    }

    if (url.startsWith('/en/script_versions/new')) {
      return html(publishFormPage('/en/script_versions'));
    }
    const updateForm = /^(\/en\/scripts\/\d+)\/versions\/new$/.exec(url);
    if (updateForm) return html(publishFormPage(`${updateForm[1]}/versions`));

    if (method === 'POST' && /^\/en\/(script_versions|scripts\/\d+\/versions)$/.test(url)) {
      // Behaviour switches are driven by markers inside the submitted code.
      if (body.includes('MODE_REJECT')) {
        return html(
          publishFormPage(
            url,
            '',
            '<div class="validation-errors"><p>There were errors:</p><p>Code is invalid</p></div>',
          ),
        );
      }
      if (body.includes('MODE_WARN') && !body.includes('version_check_override')) {
        return html(publishFormPage(url, warningCheckbox('version_check_override')));
      }
      return redirect(SCRIPT_PAGE);
    }

    if (url === SCRIPT_PAGE) return html('<html><body><h1>Fixture Script</h1></body></html>');

    res.writeHead(404, { 'Content-Type': 'text/html' }).end('<p>not found</p>');
  });
}

let server: Server;
let base = '';
let dir = '';

beforeAll(async () => {
  server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = mkdtempSync(join(tmpdir(), 'gf-test-'));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

/** A client aimed at the fake site, with proxy detection bypassed. */
function localClient(jar?: CookieJar): Client {
  return new Client({
    mainSite: base,
    apiHost: base,
    locale: 'en',
    noProxy: true,
    ...(jar ? { jar } : {}),
  });
}

/** A jar the fake server treats as signed in. */
function signedInJar(): CookieJar {
  const jar = new CookieJar();
  jar.absorb([FRESH_COOKIE]);
  return jar;
}

const writeFixture = (name: string, code: string): string => {
  const path = join(dir, name);
  writeFileSync(path, code);
  return path;
};

describe('transport: POST with a body, cookies and redirects', () => {
  it('sends the method, content type, referer and cookie, then follows the redirect', async () => {
    seen.length = 0;
    const res = await localClient(signedInJar()).submitForm(
      `${base}/en/script_versions`,
      [
        ['authenticity_token', 'PUB_TOKEN'],
        ['script_version[code]', 'hello world'],
      ],
      { referer: `${base}/en/script_versions/new` },
    );

    const post = seen.find((r) => r.method === 'POST')!;
    expect(post.contentType).toBe('application/x-www-form-urlencoded');
    expect(post.referer).toBe(`${base}/en/script_versions/new`);
    expect(post.cookie).toBe('_greasyfork_session=fresh');
    // Brackets encoded, spaces as "+": the form convention, NOT encodeURIComponent's.
    expect(post.body).toBe('authenticity_token=PUB_TOKEN&script_version%5Bcode%5D=hello+world');

    // The 302 was followed, and the hop was a GET.
    expect(res.status).toBe(200);
    expect(res.finalUrl).toBe(`${base}${SCRIPT_PAGE}`);
    expect(seen.some((r) => r.method === 'GET' && r.url === SCRIPT_PAGE)).toBe(true);
  });

  it('does not retry a POST whose connection failed', async () => {
    const dead = new Client({
      mainSite: 'http://127.0.0.1:1',
      apiHost: 'http://127.0.0.1:1',
      noProxy: true,
    });
    await expect(
      dead.submitForm('http://127.0.0.1:1/en/script_versions', [['a', '1']]),
    ).rejects.toThrow(/cannot reach/);
  });
});

describe('login', () => {
  it('signs in, takes the token from the form submitted, and keeps the cookie', async () => {
    seen.length = 0;
    const jar = new CookieJar();
    const result = await login(localClient(jar), 'good@example.invalid', 'pw');

    expect(result.username).toBe('TestUser');
    const post = seen.find((r) => r.method === 'POST')!;
    // The other form on the page carries a DIFFERENT token; sending that one is a
    // CSRF failure that the site reports as a generic error page.
    expect(post.body).toContain('authenticity_token=LOGIN_FORM_TOKEN');
    expect(post.body).not.toContain('LOCALE_FORM_TOKEN');
    expect(post.body).toContain('user%5Bemail%5D=good%40example.invalid');
    expect(jar.header()).toContain('_greasyfork_session=fresh');
    // The cookie from the sign-in response had to be sent on the next hop, or the
    // post-login page (which requires it) would have bounced us back to the form.
    expect(seen.some((r) => r.url === '/en/' && r.cookie.includes('fresh'))).toBe(true);
  });

  it('reports a bad password instead of pretending to succeed', async () => {
    await expect(login(localClient(new CookieJar()), 'bad@example.invalid', 'pw')).rejects.toThrow(
      /Invalid email or password/,
    );
  });

  it('asks for a TOTP code when the account needs one', async () => {
    await expect(login(localClient(new CookieJar()), '2fa@example.invalid', 'pw')).rejects.toThrow(
      /two-factor/,
    );
  });

  it('accepts a TOTP code and reports that it was used', async () => {
    seen.length = 0;
    const jar = new CookieJar();
    const result = await login(localClient(jar), '2fa@example.invalid', 'pw', '123456');

    expect(result.usedOtp).toBe(true);
    expect(seen.find((r) => r.method === 'POST')!.body).toContain('user%5Botp_attempt%5D=123456');
    expect(jar.header()).toContain('_greasyfork_session=fresh');
  });

  it('signs in on a first-ever attempt, with no session on disk', async () => {
    // The bug this test exists for: with no stored session the client used to be
    // built WITHOUT a cookie jar, so the login page's own Set-Cookie was dropped
    // and the POST went out bare. Rails answers that with a 422 and an EMPTY body,
    // which reads as "no error text" and looks like a wrong password.
    //
    // No jar is passed on purpose — that is what `buildClient` does before the
    // first login, and every other test here pre-loads one, which is exactly why
    // this path was missed.
    seen.length = 0;
    const client = new Client({ mainSite: base, apiHost: base, locale: 'en', noProxy: true });

    const result = await login(client, 'good@example.invalid', 'pw');
    expect(result.username).toBe('TestUser');

    // The session handed out by the GET has to come back on the POST, or the CSRF
    // token is not valid and the site answers 422.
    const post = seen.find((r) => r.method === 'POST')!;
    const sid = new URL(post.url, base).searchParams.get('sid')!;
    expect(sid).not.toBe('');
    expect(post.cookie).toContain(`${SESSION_COOKIE}=${sid}`);

    // And after a successful sign-in the session is ROTATED (Rails' session
    // fixation protection), so the jar must hold the new one — asserting the old
    // value here would silently pass a client that never stored the new cookie.
    expect(client.jar.header()).toContain('_greasyfork_session=fresh');
    expect(client.jar.header()).not.toContain(`${SESSION_COOKIE}=${sid}`);
  });

  it('reports "not signed in" for an empty jar', async () => {
    expect(await currentUser(localClient(new CookieJar()))).toBeNull();
  });
});

describe('publish', () => {
  it('creates a script: posts the code, follows the redirect, reads the name back', async () => {
    seen.length = 0;
    const file = writeFixture('create.user.js', SCRIPT);
    const result = await publish(localClient(signedInJar()), file, { scriptType: 'public' });

    expect(result.created).toBe(true);
    expect(result.scriptId).toBe(98765);
    expect(result.name).toBe('Fixture Script');
    expect(result.version).toBe('2.1.0');
    expect(result.url).toBe(`${base}${SCRIPT_PAGE}`);

    const post = seen.find((r) => r.method === 'POST')!;
    expect(post.url).toBe('/en/script_versions');
    expect(post.body).toContain('script_version%5Bcode%5D=');
    expect(post.body).toContain('script%5Bscript_type%5D=1');
    expect(post.body).toContain('language=js');
    expect(post.referer).toBe(`${base}/en/script_versions/new`);
  });

  it('updates an existing script, and never creates a duplicate', async () => {
    seen.length = 0;
    const file = writeFixture('update.user.js', SCRIPT);
    const result = await publish(localClient(signedInJar()), file, {
      scriptId: 98765,
      force: true,
    });

    expect(result.created).toBe(false);
    const post = seen.find((r) => r.method === 'POST')!;
    expect(post.url).toBe('/en/scripts/98765/versions');
    // The create-only fields must not be sent on an update: they would rename or
    // re-type an existing script.
    expect(post.body).not.toContain('script%5Bscript_type%5D');
    expect(post.body).not.toContain('language=js');
  });

  it('surfaces server-side validation errors instead of a bare failure', async () => {
    const file = writeFixture('reject.user.js', SCRIPT.replace("('hi')", "('MODE_REJECT')"));
    try {
      await publish(localClient(signedInJar()), file, { scriptType: 'public' });
      throw new Error('expected a PublishError');
    } catch (e) {
      expect(e).toBeInstanceOf(PublishError);
      expect((e as PublishError).problems).toContain('Code is invalid');
    }
  });

  it('reports pending warnings rather than silently confirming them', async () => {
    const file = writeFixture('warn.user.js', SCRIPT.replace("('hi')", "('MODE_WARN')"));
    try {
      await publish(localClient(signedInJar()), file, { scriptType: 'public' });
      throw new Error('expected a PublishError');
    } catch (e) {
      expect(e).toBeInstanceOf(PublishError);
      expect((e as PublishError).message).toMatch(/not published/);
      expect((e as PublishError).problems).toContain('warning: version_check_override');
    }
  });

  it('confirms the warnings and resubmits when --force is given', async () => {
    seen.length = 0;
    const file = writeFixture('warn-force.user.js', SCRIPT.replace("('hi')", "('MODE_WARN')"));
    const result = await publish(localClient(signedInJar()), file, {
      scriptType: 'public',
      force: true,
    });

    expect(result.overrides).toContain('version_check_override');
    expect(result.name).toBe('Fixture Script');
    const posts = seen.filter((r) => r.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[0]!.body).not.toContain('version_check_override');
    expect(posts[1]!.body).toContain('script_version%5Bversion_check_override%5D=true');
  });

  it('refuses to run without a session, with an actionable message', async () => {
    const file = writeFixture('nosession.user.js', SCRIPT);
    await expect(
      publish(localClient(new CookieJar()), file, { scriptType: 'public' }),
    ).rejects.toThrow(/not signed in/);
  });

  it('does not POST at all in dry-run mode', async () => {
    seen.length = 0;
    const file = writeFixture('dry.user.js', SCRIPT);
    const result = await publish(localClient(signedInJar()), file, {
      scriptType: 'public',
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(seen.filter((r) => r.method === 'POST')).toHaveLength(0);
    expect(seen.some((r) => r.method === 'GET' && r.url === '/en/script_versions/new')).toBe(true);
  });
});

describe('session file', () => {
  it('round-trips a jar', () => {
    const path = join(dir, 'session.json');
    const jar = new CookieJar();
    jar.absorb(['_greasyfork_session=fresh; path=/; secure']);
    saveSession(jar, 'TestUser', path);

    expect(loadSession(path)!.header()).toBe('_greasyfork_session=fresh');
    expect(clearSession(path)).toBe(true);
    expect(loadSession(path)).toBeUndefined();
  });
});

describe('inspectSource', () => {
  it('accepts a well-formed script', () => {
    const { info } = inspectSource(writeFixture('ok.user.js', SCRIPT));
    expect(info.name).toBe('Fixture Script');
    expect(info.version).toBe('2.1.0');
    expect(info.kind).toBe('js');
    expect(info.targets).toEqual(['https://example.invalid/*']);
  });

  it('rejects a script with no @match/@include before wasting a request', () => {
    const file = writeFixture(
      'nomatch.user.js',
      '// ==UserScript==\n// @name X\n// @version 1\n// ==/UserScript==\nvar a = 1;\n',
    );
    expect(() => inspectSource(file)).toThrow(/no @match or @include/);
  });

  it('rejects a script with no meta block', () => {
    const file = writeFixture('nometa.user.js', 'console.log("nothing here at all");\n');
    expect(() => inspectSource(file)).toThrow(/no \/\/ ==UserScript==/);
  });

  it('reads a userstyle block', () => {
    const file = writeFixture(
      'style.user.css',
      '/* ==UserStyle==\n@name My Style\n@version 1.0\n==/UserStyle== */\nbody { color: red; }\n',
    );
    const { info } = inspectSource(file);
    expect(info.kind).toBe('css');
    expect(info.name).toBe('My Style');
  });
});
