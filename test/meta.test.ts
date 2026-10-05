import { describe, expect, it } from 'vitest';

import {
  baseName,
  compareVersions,
  isNewer,
  metaAll,
  metaFirst,
  metaUrlFrom,
  parseScriptId,
  parseUserscriptMeta,
  safeFilename,
} from '../src/meta.js';

describe('parseScriptId', () => {
  it('accepts a bare id, an id-slug and a full URL', () => {
    expect(parseScriptId('405130')).toBe(405130);
    expect(parseScriptId('405130-text-copy')).toBe(405130);
    expect(parseScriptId('https://greasyfork.org/zh-CN/scripts/405130-slug')).toBe(405130);
    expect(parseScriptId('  405130  ')).toBe(405130);
  });

  it('rejects anything without an id', () => {
    expect(() => parseScriptId('https://greasyfork.org/en/users/584991-windrunnermax')).toThrow();
    expect(() => parseScriptId('not-a-script')).toThrow();
    expect(() => parseScriptId('')).toThrow();
  });
});

describe('compareVersions', () => {
  const cases: Array<[string, string, number]> = [
    ['6.10', '6.9', 1],
    ['6.9', '6.10', -1],
    ['6.2.10', '1.0.0', 1],
    ['1.0.0', '1.0.0', 0],
    ['1.0', '1.0.0', 0],
    ['1.0.1', '1.0', 1],
    ['1.0', '1.0.1', -1],
    ['2.0', '10.0', -1],
    ['20231121.2', '20231121', 1],
    ['1.212', '1.2', 1],
    ['v0.5.0', '0.5.0', 1], // 'v' is a text segment, and text ranks above numbers
  ];

  it.each(cases)('compareVersions(%s, %s)', (a, b, want) => {
    expect(Math.sign(compareVersions(a, b))).toBe(want);
  });
});

describe('isNewer', () => {
  it('detects updates and equal versions', () => {
    expect(isNewer('6.2.10', '1.0.0')).toBe(true);
    expect(isNewer('6.2.10', '6.2.9')).toBe(true);
    expect(isNewer('6.2.10', '6.2.10')).toBe(false);
  });
});

describe('metaUrlFrom', () => {
  it('swaps the .user.js/.user.css suffix for .meta.js/.meta.css', () => {
    expect(metaUrlFrom('https://update.greasyfork.org/scripts/1/a.user.js')).toBe(
      'https://update.greasyfork.org/scripts/1/a.meta.js',
    );
    expect(metaUrlFrom('https://update.greasyfork.org/scripts/1/a.user.css')).toBe(
      'https://update.greasyfork.org/scripts/1/a.meta.css',
    );
    expect(metaUrlFrom('https://update.greasyfork.org/scripts/1/a.js')).toBe(
      'https://update.greasyfork.org/scripts/1/a.meta.js',
    );
  });

  it('drops a query string instead of appending past it', () => {
    expect(metaUrlFrom('https://x/scripts/1/style.user.js?version=1284070')).toBe(
      'https://x/scripts/1/style.meta.js',
    );
  });
});

describe('safeFilename', () => {
  it('keeps CJK and emoji, strips characters Windows rejects', () => {
    expect(safeFilename('🔥🔥文本选中复制🔥🔥.user.js')).toBe('🔥🔥文本选中复制🔥🔥.user.js');
    expect(safeFilename('a<b>c:d"e/f\\g|h?i*j.user.js')).toBe('a_b_c_d_e_f_g_h_i_j.user.js');
    expect(safeFilename('trailing.  ')).toBe('trailing');
    expect(safeFilename('')).toBe('script');
  });
});

describe('baseName', () => {
  it('percent-decodes the last path segment', () => {
    expect(baseName('https://x/scripts/1/%E6%96%87.user.js')).toBe('文.user.js');
    expect(baseName('https://x/a/b.user.js')).toBe('b.user.js');
    expect(baseName('https://x/a/%E0%A4%A.user.js')).toBe('%E0%A4%A.user.js'); // malformed stays raw
  });

  // Regression: a versioned code URL carries `?version=N`; keeping it produced a
  // filename like `style.user.js?version=1284070`, which Windows rejects.
  it('strips a query string and a hash', () => {
    expect(baseName('https://x/scripts/1/style.user.js?version=1284070')).toBe('style.user.js');
    expect(baseName('https://x/a/b.user.js#frag')).toBe('b.user.js');
    expect(baseName('https://x/a/b%20c.user.js?version=1#f')).toBe('b c.user.js');
  });
});

describe('parseUserscriptMeta', () => {
  it('reads a full block, keeping repeated keys and ignoring case', () => {
    const src = `// ==UserScript==
// @name        Test Script
// @version     6.2.10
// @match       *://a.example/*
// @match       *://b.example/*
// @updateURL   https://update.greasyfork.org/scripts/1/a.meta.js
// ==/UserScript==
(function(){})();
`;
    const meta = parseUserscriptMeta(src);
    expect(metaFirst(meta, 'name')).toBe('Test Script');
    expect(metaFirst(meta, 'VERSION')).toBe('6.2.10');
    expect(metaAll(meta, 'match')).toEqual(['*://a.example/*', '*://b.example/*']);
    expect(metaFirst(meta, 'updateurl')).toBe('https://update.greasyfork.org/scripts/1/a.meta.js');
    expect(metaFirst(meta, 'missing')).toBe('');
  });

  it('parses a hand-written header with no fence', () => {
    expect(metaFirst(parseUserscriptMeta('// @version 1.2.3\n'), 'version')).toBe('1.2.3');
  });
});
