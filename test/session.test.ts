import { describe, expect, it } from 'vitest';

import { parseCookieHeader, CookieJar } from '../src/cookie.js';
import { percentEncode } from '../src/form.js';
import { SESSION_COOKIE_NAME, sessionCookieFromInput } from '../src/session.js';

describe('sessionCookieFromInput', () => {
  it('takes a bare value and escapes it for the wire', () => {
    const cookie = sessionCookieFromInput('abc+def==')!;
    expect(cookie.name).toBe(SESSION_COOKIE_NAME);
    // A pasted decoded value has to end up percent-escaped, or the site decodes
    // it into something else entirely.
    expect(cookie.value).toBe('abc%2Bdef%3D%3D');
    expect(cookie.path).toBe('/');
  });

  it('decodes nothing when the value is already escaped', () => {
    // `%2F` / `%3D` are the tells — a base64 session value never contains `%`,
    // so an escaped value must be sent through untouched rather than double-escaped.
    const wire = 'yQYA0ax9%2FEvPHKwjk%3D%3D--RViswcUo--21jNB5fY%3D%3D';
    const cookie = sessionCookieFromInput(wire)!;
    expect(cookie.value).toBe(wire);
    expect(cookie.value).not.toContain('%25');
  });

  it('accepts a name=value pair', () => {
    const cookie = sessionCookieFromInput('_greasyfork_session=abc123')!;
    expect(cookie.value).toBe('abc123');
  });

  it('accepts a whole Cookie header, keeping only our session cookie', () => {
    const cookie = sessionCookieFromInput(
      'locale_messaged=true; _greasyfork_session=abc123; something_else=zzz',
    )!;
    expect(cookie.value).toBe('abc123');
  });

  it('accepts a "Cookie:" prefix as devtools shows it', () => {
    const cookie = sessionCookieFromInput('Cookie: _greasyfork_session=abc123')!;
    expect(cookie.value).toBe('abc123');
  });

  it('leaves a plain value containing no "=" alone', () => {
    // A bare value has no "=" — the `name=value` branch must not swallow the whole
    // string when the name is different, and this must not be mistaken for a pair.
    const cookie = sessionCookieFromInput('plainvalue')!;
    expect(cookie.value).toBe('plainvalue');
  });

  it('handles a value with an embedded "=" (the common trailing "==")', () => {
    const cookie = sessionCookieFromInput('abc==')!;
    expect(cookie.value).toBe('abc%3D%3D');
  });

  it('trims surrounding whitespace/newlines from a paste', () => {
    const cookie = sessionCookieFromInput('\n  abc123  \n')!;
    expect(cookie.value).toBe('abc123');
  });

  it('returns null for empty or blank input', () => {
    expect(sessionCookieFromInput('')).toBeNull();
    expect(sessionCookieFromInput('   \n ')).toBeNull();
  });

  it('produces a cookie the jar renders back as a valid request header', () => {
    const jar = new CookieJar();
    jar.set(sessionCookieFromInput('abc123')!);
    expect(jar.header()).toBe('_greasyfork_session=abc123');
    // And it round-trips: what we send is what a server-set cookie would be.
    expect(parseCookieHeader(jar.header())).toEqual([{ name: SESSION_COOKIE_NAME, value: 'abc123' }]);
  });
});

describe('percentEncode', () => {
  it('escapes the four characters encodeURIComponent leaves alone', () => {
    expect(percentEncode("!*'()")).toBe('%21%2A%27%28%29');
  });

  it('keeps spaces as %20 (the form encoder is what turns them into +)', () => {
    expect(percentEncode('a b')).toBe('a%20b');
  });

  it('is a fixed point for an already-escaped value', () => {
    expect(percentEncode(percentEncode('a+b=='))).not.toBe(percentEncode('a+b=='));
  });
});
