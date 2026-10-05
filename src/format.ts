/**
 * Terminal formatting helpers.
 *
 * Everything here is width-aware in *display cells*, not UTF-16 code units or
 * code points: userscript names are full of CJK and emoji, and `padEnd`-style
 * padding would misalign every column. There is no runtime dependency, so the
 * East Asian Width table below is a curated subset covering CJK, kana, Hangul,
 * fullwidth forms and the emoji blocks.
 */

/** Display width of one code point, in terminal cells. */
export function codePointWidth(cp: number): number {
  if (cp === 0 || cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  // Combining marks and format characters (ZWJ, variation selectors) take no space.
  if (isZeroWidth(cp)) return 0;
  return isWide(cp) ? 2 : 1;
}

function isZeroWidth(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) || // combining diacritics
    (cp >= 0x0483 && cp <= 0x0489) ||
    (cp >= 0x0591 && cp <= 0x05bd) ||
    (cp >= 0x0610 && cp <= 0x061a) ||
    (cp >= 0x064b && cp <= 0x065f) ||
    (cp >= 0x0e31 && cp <= 0x0e3a) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20f0) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    cp === 0x200b ||
    cp === 0x200c ||
    cp === 0x200d || // zero-width joiner
    cp === 0x2060 ||
    cp === 0xfeff
  );
}

/** East Asian Wide / Fullwidth, plus the emoji ranges terminals render double. */
function isWide(cp: number): boolean {
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals .. Kangxi radicals
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana .. CJK compatibility
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified ideographs
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) || // emoji & pictographs
    (cp >= 0x1f680 && cp <= 0x1f6ff) || // transport & map symbols
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x1fa70 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK ext B and beyond
  ) {
    return true;
  }
  return WIDE_MISC.has(cp);
}

const WIDE_MISC = new Set<number>([
  0x231a, 0x231b, 0x23e9, 0x23ea, 0x23eb, 0x23ec, 0x23f0, 0x23f3, 0x25fd, 0x25fe,
  0x2614, 0x2615, 0x2648, 0x2649, 0x264a, 0x264b, 0x264c, 0x264d, 0x264e, 0x264f,
  0x2650, 0x2651, 0x2652, 0x2653, 0x267f, 0x2693, 0x26a1, 0x26aa, 0x26ab, 0x26bd,
  0x26be, 0x26c4, 0x26c5, 0x26ce, 0x26d4, 0x26ea, 0x26f2, 0x26f3, 0x26f5, 0x26fa,
  0x26fd, 0x2705, 0x270a, 0x270b, 0x2728, 0x274c, 0x274e, 0x2753, 0x2754, 0x2755,
  0x2757, 0x2795, 0x2796, 0x2797, 0x27b0, 0x27bf, 0x2b1b, 0x2b1c, 0x2b50, 0x2b55,
  0x1f004, 0x1f0cf, 0x1f18e, 0x1f191, 0x1f192, 0x1f193, 0x1f194, 0x1f195, 0x1f196,
  0x1f197, 0x1f198, 0x1f199, 0x1f19a,
]);

/** Display width of a string, in terminal cells. */
export function stringWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += codePointWidth(ch.codePointAt(0) as number);
  return w;
}

/** Shorten `s` to fit `width` cells, appending an ellipsis when cut. */
export function truncate(s: string, width: number): string {
  if (stringWidth(s) <= width) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = codePointWidth(ch.codePointAt(0) as number);
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

/** Pad `s` on the right to `width` cells (truncating first when too long). */
export function padRight(s: string, width: number): string {
  const v = stringWidth(s) > width ? truncate(s, width) : s;
  return v + ' '.repeat(Math.max(0, width - stringWidth(v)));
}

/**
 * Render a width-aware aligned table.
 *
 * `maxWidth` caps specific columns (keyed by index) so long names cannot blow up
 * the layout. Trailing whitespace is trimmed per line, so the last column is
 * unpadded and the header may be narrower than a wide body row.
 */
export function table(
  headers: string[],
  rows: string[][],
  maxWidth: Record<number, number> = {},
): string {
  const cols = headers.length;
  const widths = headers.map((h) => stringWidth(h));

  const prepared = rows.map((row) => {
    const out: string[] = [];
    for (let i = 0; i < cols; i++) {
      let cell = row[i] ?? '';
      const cap = maxWidth[i];
      if (cap !== undefined) cell = truncate(cell, cap);
      out.push(cell);
      if (stringWidth(cell) > widths[i]) widths[i] = stringWidth(cell);
    }
    return out;
  });

  const lines: string[] = [];
  const join = (cells: string[], pad: (v: string, i: number) => string) =>
    cells
      .map((c, i) => (i === cols - 1 ? pad(c, i).trimEnd() : pad(c, i)))
      .join('  ')
      .trimEnd();

  lines.push(join(headers, (h, i) => padRight(h, widths[i])));
  lines.push(join(widths.map((w) => '-'.repeat(w)), (v) => v));
  for (const row of prepared) lines.push(join(row, (v, i) => padRight(v, widths[i])));
  return lines.join('\n') + '\n';
}

/** 75632 -> "75.6k", 2845841 -> "2.8M". */
export function human(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '-';
  const abs = Math.abs(n);
  const fmt = (v: number, unit: string) => `${String(Number(v.toFixed(1)))}${unit}`;
  if (abs >= 1e9) return fmt(n / 1e9, 'B');
  if (abs >= 1e6) return fmt(n / 1e6, 'M');
  if (abs >= 1e3) return fmt(n / 1e3, 'k');
  return String(n);
}

/** "2026-01-03T17:37:19.000Z" -> "2026-01-03". */
export function shortDate(s: string | null | undefined): string {
  if (!s) return '-';
  return s.length >= 10 ? s.slice(0, 10) : s;
}

/** Render a possibly-missing value as "-". */
export function orDash(s: string | null | undefined): string {
  return s === null || s === undefined || s === '' ? '-' : String(s);
}
