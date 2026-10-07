import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseCookieHeader, CookieJar } from '../src/cookie.js';
import { percentEncode } from '../src/form.js';
import {
  clearSession,
  configDir,
  loadSession,
  saveSession,
  SESSION_COOKIE_NAME,
  sessionCookieFromInput,
  sessionPath,
} from '../src/session.js';

/** The env keys this suite moves; everything else is left alone. */
const ENV_KEYS = ['XDG_CONFIG_HOME', 'APPDATA', 'GF_CONFIG_DIR', 'GF_SESSION'] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) snap[key] = process.env[key];
  return snap;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    const value = snap[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe('configDir', () => {
  it('defaults to ~/.config/gf and never the Windows roaming profile', () => {
    // The regression lock for the requirement. An explicit *empty* env is passed
    // so a developer's own XDG_CONFIG_HOME / GF_CONFIG_DIR cannot make this pass
    // vacuously, and `%APPDATA%` is the *roaming* profile — Windows syncs it to
    // the domain server, so a session cookie must not live there.
    const dir = configDir({});
    expect(dir).toBe(join(homedir(), '.config', 'gf'));
    expect(dir).not.toMatch(/AppData|Roaming/i);
  });

  it('honours XDG_CONFIG_HOME on every platform', () => {
    expect(configDir({ XDG_CONFIG_HOME: '/xdg' })).toBe(join('/xdg', 'gf'));
  });

  it('lets GF_CONFIG_DIR win over everything', () => {
    expect(configDir({ GF_CONFIG_DIR: '/explicit', XDG_CONFIG_HOME: '/xdg' })).toBe('/explicit');
  });
});

describe('sessionPath', () => {
  const snap = snapshotEnv();
  afterEach(() => restoreEnv(snap));

  it('sits inside configDir, and GF_SESSION overrides it outright', () => {
    delete process.env.GF_SESSION;
    delete process.env.GF_CONFIG_DIR;
    process.env.XDG_CONFIG_HOME = '/xdg';
    expect(sessionPath()).toBe(join('/xdg', 'gf', 'session.json'));

    process.env.GF_SESSION = '/pinned/session.json';
    expect(sessionPath()).toBe('/pinned/session.json');
  });
});

describe('session file: the move off %APPDATA%', () => {
  let root = '';
  let newDir = '';
  let legacyRoot = '';
  let legacyFile = '';
  let defaultFile = '';
  const snap = snapshotEnv();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gf-cfg-'));
    newDir = join(root, 'config');
    legacyRoot = join(root, 'roaming');
    legacyFile = join(legacyRoot, 'gf', 'session.json');
    defaultFile = join(newDir, 'gf', 'session.json');

    // XDG_CONFIG_HOME pins configDir() to a temp dir, so the DEFAULT path is
    // deterministic and the migration (which only applies to the default) can be
    // exercised without touching this machine's real session.
    process.env.XDG_CONFIG_HOME = newDir;
    process.env.APPDATA = legacyRoot;
    delete process.env.GF_CONFIG_DIR;
    delete process.env.GF_SESSION;
  });

  afterEach(() => {
    restoreEnv(snap);
    rmSync(root, { recursive: true, force: true });
  });

  /** Write a session file the way pre-0.2.3 Windows builds did. */
  function writeLegacy(username?: string, value = 'legacysession'): void {
    mkdirSync(join(legacyRoot, 'gf'), { recursive: true });
    writeFileSync(
      legacyFile,
      `${JSON.stringify(
        {
          savedAt: '2026-01-01T00:00:00.000Z',
          ...(username ? { username } : {}),
          cookies: [{ name: SESSION_COOKIE_NAME, value, path: '/' }],
        },
        null,
        2,
      )}\n`,
    );
  }

  function freshJar(value: string): CookieJar {
    const jar = new CookieJar();
    jar.set(sessionCookieFromInput(value)!);
    return jar;
  }

  it('moves a pre-0.2.3 %APPDATA% session to the new directory on read', () => {
    writeLegacy('LegacyUser');

    const jar = loadSession()!;

    expect(jar.header()).toBe(`${SESSION_COOKIE_NAME}=legacysession`);
    expect(existsSync(defaultFile)).toBe(true);
    // Without this the user would be signed out at the next run for no reason.
    expect(existsSync(legacyFile)).toBe(false);
    // The account name has to survive the move, or `whoami` loses it.
    expect(JSON.parse(readFileSync(defaultFile, 'utf8')).username).toBe('LegacyUser');
  });

  it('prefers the new directory and leaves a stale legacy file untouched', () => {
    writeLegacy();
    saveSession(freshJar('newsession'), 'NewUser');
    // A stale copy reappearing must NOT win over a live session.
    writeLegacy(undefined, 'stale');

    expect(loadSession()!.header()).toBe(`${SESSION_COOKIE_NAME}=newsession`);
    expect(existsSync(legacyFile)).toBe(true);
  });

  it('does not raid %APPDATA% when GF_CONFIG_DIR names the directory', () => {
    // The bug this locks. Setting GF_CONFIG_DIR makes configDir() *return* that
    // directory, so a plain `path === join(configDir(env), 'session.json')` check
    // sees an explicitly chosen directory as the default one and migrates into it.
    // Measured: it moved a live session out of %APPDATA% during a verification run,
    // which would silently sign out every user who sets GF_CONFIG_DIR.
    writeLegacy();
    const explicit = join(root, 'explicit-dir');
    process.env.GF_CONFIG_DIR = explicit;

    expect(loadSession()).toBeUndefined();
    // The legacy file must be left exactly where it was.
    expect(existsSync(legacyFile)).toBe(true);
    expect(existsSync(join(explicit, 'session.json'))).toBe(false);
  });

  it('does not migrate into an explicitly requested path', () => {
    writeLegacy();
    const explicit = join(root, 'explicit.json');
    // The caller named an exact file, so nothing may be moved into or out of it.
    expect(loadSession(explicit)).toBeUndefined();
    expect(existsSync(explicit)).toBe(false);
    expect(existsSync(legacyFile)).toBe(true);
  });

  it('does not migrate when GF_SESSION pins the location', () => {
    writeLegacy();
    process.env.GF_SESSION = join(root, 'pinned.json');
    expect(loadSession()).toBeUndefined();
    expect(existsSync(legacyFile)).toBe(true);
  });

  it('drops the legacy file when a session is saved', () => {
    writeLegacy();
    saveSession(freshJar('fresh'), 'NewUser');
    // If the legacy copy survived, a later read would "migrate" a dead session
    // back over the live one.
    expect(existsSync(legacyFile)).toBe(false);
    expect(existsSync(defaultFile)).toBe(true);
  });

  it('removes both locations on logout', () => {
    writeLegacy();
    saveSession(freshJar('fresh'), 'NewUser');
    writeLegacy();

    expect(clearSession()).toBe(true);
    expect(existsSync(legacyFile)).toBe(false);
    expect(existsSync(defaultFile)).toBe(false);
  });

  it('reports nothing removed when there is no session anywhere', () => {
    expect(clearSession()).toBe(false);
  });

  it('returns undefined for a corrupt session file instead of throwing', () => {
    mkdirSync(join(newDir, 'gf'), { recursive: true });
    writeFileSync(defaultFile, '{ this is not json');
    expect(loadSession()).toBeUndefined();
  });
});

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
    expect(parseCookieHeader(jar.header())).toEqual([
      { name: SESSION_COOKIE_NAME, value: 'abc123' },
    ]);
  });
});

describe('percentEncode', () => {
  it('escapes the four characters encodeURIComponent leaves alone', () => {
    expect(percentEncode("!*'()")).toBe('%21%2A%27%28%29');
  });

  it('keeps spaces as %20 (the form encoder is what turns them into +)', () => {
    expect(percentEncode('a b')).toBe('a%20b');
  });

  it('is not a fixed point, so a decoded value really is transformed', () => {
    expect(percentEncode(percentEncode('a+b=='))).not.toBe(percentEncode('a+b=='));
  });
});
