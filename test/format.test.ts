import { describe, expect, it } from 'vitest';

import {
  codePointWidth,
  human,
  orDash,
  padRight,
  shortDate,
  stringWidth,
  table,
  truncate,
} from '../src/format.js';

describe('codePointWidth / stringWidth', () => {
  it('counts CJK and emoji as two cells', () => {
    expect(stringWidth('abc')).toBe(3);
    expect(stringWidth('')).toBe(0);
    expect(stringWidth('中文')).toBe(4);
    expect(stringWidth('a中')).toBe(3);
    expect(stringWidth('🔥')).toBe(2);
    expect(stringWidth('🔥文本')).toBe(6);
    expect(stringWidth('かわいいね')).toBe(10);
  });

  it('gives control and zero-width code points no width', () => {
    expect(codePointWidth(0x0a)).toBe(0);
    expect(codePointWidth(0x200d)).toBe(0); // ZWJ
    expect(codePointWidth(0xfe0f)).toBe(0); // variation selector
  });
});

describe('truncate', () => {
  it('cuts on cell boundaries and marks the cut', () => {
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(stringWidth(truncate('中文测试', 5))).toBeLessThanOrEqual(5);
    expect(truncate('abc', 10)).toBe('abc'); // never pads
  });
});

describe('padRight', () => {
  it('pads to a cell width, truncating when too long', () => {
    expect(padRight('中', 4)).toBe('中  ');
    expect(stringWidth(padRight('abcdef', 4))).toBe(4);
    expect(padRight('abc', 3)).toBe('abc');
  });
});

describe('table', () => {
  it('aligns CJK/emoji rows to the same display width', () => {
    const rendered = table(
      ['ID', 'Name', 'Updated'],
      [
        ['405130', '🔥🔥🔥文本选中复制🔥🔥🔥', '2026-01-03'],
        ['1', 'short', '2023-11-22'],
      ],
      {},
    );
    const lines = rendered.trimEnd().split('\n');
    expect(lines).toHaveLength(4); // header + separator + 2 rows

    // The separator and every data row must share one display width. If emoji or
    // CJK were counted as a single cell the emoji row would come out narrower —
    // this is the assertion that catches a broken width table.
    const bodyWidth = stringWidth(lines[1]!);
    for (const line of lines.slice(1)) expect(stringWidth(line)).toBe(bodyWidth);

    // The header is never allowed to exceed the body (its last column is unpadded).
    expect(stringWidth(lines[0]!)).toBeLessThanOrEqual(bodyWidth);
  });

  it('caps the columns named in maxWidth', () => {
    const rendered = table(['Name'], [['x'.repeat(100)]], { 0: 10 });
    expect(Math.max(...rendered.split('\n').map(stringWidth))).toBeLessThanOrEqual(10);
  });
});

describe('human', () => {
  it('renders compact magnitudes', () => {
    expect(human(2845841)).toBe('2.8M');
    expect(human(75632)).toBe('75.6k');
    expect(human(0)).toBe('0');
    expect(human(999)).toBe('999');
    expect(human(1_000)).toBe('1k');
    expect(human(1_200_000_000)).toBe('1.2B');
  });

  it('renders missing numbers as a dash', () => {
    expect(human(null)).toBe('-');
    expect(human(undefined)).toBe('-');
  });
});

describe('shortDate / orDash', () => {
  it('trims ISO timestamps to a date', () => {
    expect(shortDate('2026-01-03T17:37:19.000Z')).toBe('2026-01-03');
    expect(shortDate('2026-01-03')).toBe('2026-01-03');
    expect(shortDate(null)).toBe('-');
    expect(shortDate('')).toBe('-');
  });

  it('replaces empty values with a dash', () => {
    expect(orDash('x')).toBe('x');
    expect(orDash(null)).toBe('-');
    expect(orDash(undefined)).toBe('-');
    expect(orDash('')).toBe('-');
  });
});
