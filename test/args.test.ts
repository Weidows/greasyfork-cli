import { describe, expect, it } from 'vitest';

import {
  booleanValue,
  locateSubcommand,
  numberValue,
  parseCommand,
  stringValue,
} from '../src/args.js';

const searchOptions = {
  page: { type: 'string' as const, short: 'p' },
  limit: { type: 'string' as const, short: 'n' },
  sort: { type: 'string' as const },
};

const downloadOptions = {
  output: { type: 'string' as const, short: 'o' },
  version: { type: 'string' as const },
  'with-meta': { type: 'boolean' as const },
};

describe('locateSubcommand', () => {
  it('splits leading global flags from the subcommand', () => {
    const located = locateSubcommand(['--locale', 'zh-CN', '-v', 'search', 'video', '-n', '5']);
    expect(located.sub).toBe('search');
    expect(located.rest).toEqual(['video', '-n', '5']);
    expect(located.inherited).toEqual({ locale: 'zh-CN', verbose: true });
  });

  it('supports --flag=value and boolean short flags', () => {
    const located = locateSubcommand(['--locale=ja', 'search', 'x']);
    expect(located.inherited).toEqual({ locale: 'ja' });
    expect(located.sub).toBe('search');
  });

  it('stops at the first positional', () => {
    expect(locateSubcommand(['search', '--locale', 'ja']).sub).toBe('search');
  });

  it('throws on an unknown leading flag rather than swallowing it', () => {
    expect(() => locateSubcommand(['--bogus', 'search'])).toThrow(/unknown flag/);
  });
});

describe('parseCommand: global flags before the subcommand are inherited', () => {
  // Regression guard: `gfc --locale zh-CN search video` used to drop the locale,
  // because the command re-parsed only its own tail.
  it('inherits --locale from before the subcommand', () => {
    const parsed = parseCommand(['--locale', 'zh-CN', 'search', 'video', '-n', '5'], searchOptions);
    expect(parsed.sub).toBe('search');
    expect(stringValue(parsed.values, 'locale')).toBe('zh-CN');
    expect(parsed.positionals).toEqual(['video']);
    expect(numberValue(parsed.values, 'limit', 20)).toBe(5);
  });

  it('lets a command-local flag beat the inherited one', () => {
    const parsed = parseCommand(['--locale', 'zh-CN', 'search', 'x', '--locale', 'ja'], searchOptions);
    expect(stringValue(parsed.values, 'locale')).toBe('ja');
  });

  it('also accepts a global flag after the subcommand', () => {
    const parsed = parseCommand(['search', 'x', '--locale', 'ja'], searchOptions);
    expect(stringValue(parsed.values, 'locale')).toBe('ja');
  });
});

describe('parseCommand: flags and positionals interleave', () => {
  // `gfc download 405130 -o dir --with-meta` must keep -o; the stdlib flag parser
  // in other languages stops at the first positional.
  it('keeps a flag placed after a positional', () => {
    const parsed = parseCommand(
      ['download', '405130', '-o', 'dir', '--with-meta'],
      downloadOptions,
    );
    expect(parsed.positionals).toEqual(['405130']);
    expect(stringValue(parsed.values, 'output')).toBe('dir');
    expect(booleanValue(parsed.values, 'with-meta')).toBe(true);
  });
});
