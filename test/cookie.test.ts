import { describe, expect, it } from 'vitest';

import { CookieJar, parseCookieHeader, parseSetCookie } from '../src/cookie.js';

describe('parseSetCookie', () => {
  it('reads the name, value and default path', () => {
    expect(parseSetCookie('a=1')).toEqual({ name: 'a', value: '1', path: '/' });
  });

  it('reads attributes case-insensitively', () => {
    const cookie = parseSetCookie('sid=abc; Path=/en; Secure; HttpOnly; SameSite=Lax')!;
    expect(cookie.name).toBe('sid');
    expect(cookie.value).toBe('abc');
    expect(cookie.path).toBe('/en');
    expect(cookie.secure).toBe(true);
  });

  it('keeps an Expires value that contains a comma in one piece', () => {
    // The whole reason set-cookie is not joined with other header values: a naive
    // split on "," would turn the date into a bogus "21 Oct 2026" attribute.
    const cookie = parseSetCookie(
      's=1; path=/; expires=Wed, 21 Oct 2026 07:28:00 GMT; secure',
    )!;
    expect(cookie.expires).toBe('Wed, 21 Oct 2026 07:28:00 GMT');
  });

  it('keeps a value containing "=" or ";" quoted', () => {
    const cookie = parseSetCookie('t=abc=def; path=/')!;
    expect(cookie.value).toBe('abc=def');
  });

  it('strips a leading dot from Domain', () => {
    expect(parseSetCookie('a=1; Domain=.greasyfork.org')!.domain).toBe('greasyfork.org');
  });

  it('rejects a line with no name', () => {
    expect(parseSetCookie('=1; path=/')).toBeNull();
    expect(parseSetCookie('')).toBeNull();
  });
});

describe('parseCookieHeader', () => {
  it('splits a request Cookie header into pairs', () => {
    expect(parseCookieHeader('a=1; b=2=3')).toEqual([
      { name: 'a', value: '1' },
      { name: 'b', value: '2=3' },
    ]);
  });

  it('ignores empty segments', () => {
    expect(parseCookieHeader('a=1;; ;b=2')).toEqual([
      { name: 'a', value: '1' },
      { name: 'b', value: '2' },
    ]);
  });
});

describe('CookieJar', () => {
  it('absorbs Set-Cookie headers and renders a request header', () => {
    const jar = new CookieJar();
    jar.absorb(['locale_messaged=true; path=/', '_greasyfork_session=abc; path=/; httponly']);
    expect(jar.size).toBe(2);
    expect(jar.header()).toBe('locale_messaged=true; _greasyfork_session=abc');
  });

  it('replaces a cookie with the same name and path', () => {
    const jar = new CookieJar();
    jar.absorb(['s=old; path=/']);
    jar.absorb(['s=new; path=/']);
    expect(jar.size).toBe(1);
    expect(jar.header()).toBe('s=new');
  });

  it('treats the same name on a different path as a separate cookie', () => {
    const jar = new CookieJar();
    jar.absorb(['s=root; path=/', 's=admin; path=/admin']);
    expect(jar.size).toBe(2);
  });

  it('deletes a cookie the server expires', () => {
    const jar = new CookieJar();
    jar.absorb(['s=1; path=/']);
    jar.absorb(['s=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT']);
    expect(jar.size).toBe(0);
    expect(jar.header()).toBe('');
  });

  it('treats Max-Age=0 as a deletion too', () => {
    const jar = new CookieJar();
    jar.absorb(['s=1; path=/']);
    jar.absorb(['s=; path=/; max-age=0']);
    expect(jar.size).toBe(0);
  });

  it('round-trips through JSON, dropping anything malformed', () => {
    const jar = new CookieJar();
    jar.absorb(['s=abc; path=/; secure']);
    const restored = CookieJar.fromJSON(JSON.parse(JSON.stringify(jar.toJSON())));
    expect(restored.header()).toBe('s=abc');
    expect(restored.all()[0]!.secure).toBe(true);
  });

  it('ignores a session file that is not an array', () => {
    expect(CookieJar.fromJSON({ nope: true }).size).toBe(0);
    expect(CookieJar.fromJSON([{ name: 'a' }, null, 5]).size).toBe(0);
  });
});
