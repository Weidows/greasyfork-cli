package greasyfork

import (
	"strings"
	"unicode"
)

// RuneWidth returns the number of terminal cells r occupies: 0 for combining
// marks and zero-width joiners, 2 for East Asian Wide/Fullwidth characters and
// emoji, 1 otherwise. It exists because text/tabwriter counts runes, which
// misaligns tables full of CJK names and emoji.
func RuneWidth(r rune) int {
	if r == 0 || r < 0x20 || (r >= 0x7f && r < 0xa0) {
		return 0
	}
	if unicode.Is(unicode.Mn, r) || unicode.Is(unicode.Me, r) || unicode.Is(unicode.Cf, r) {
		return 0
	}
	if isWide(r) {
		return 2
	}
	return 1
}

// isWide reports whether r is East Asian Wide or Fullwidth.
func isWide(r rune) bool {
	switch {
	case r >= 0x1100 && (r <= 0x115f || // Hangul Jamo
		r == 0x2329 || r == 0x232a ||
		r >= 0x2e80 && r <= 0x303e || // CJK radicals .. Kangxi
		r >= 0x3041 && r <= 0x33ff || // Hiragana .. CJK compat
		r >= 0x3400 && r <= 0x4dbf || // CJK ext A
		r >= 0x4e00 && r <= 0x9fff || // CJK unified
		r >= 0xa000 && r <= 0xa4cf || // Yi
		r >= 0xa960 && r <= 0xa97f ||
		r >= 0xac00 && r <= 0xd7a3 || // Hangul syllables
		r >= 0xf900 && r <= 0xfaff || // CJK compat ideographs
		r >= 0xfe10 && r <= 0xfe19 ||
		r >= 0xfe30 && r <= 0xfe6f ||
		r >= 0xff00 && r <= 0xff60 || // fullwidth forms
		r >= 0xffe0 && r <= 0xffe6 ||
		r >= 0x1f300 && r <= 0x1f64f || // emoji
		r >= 0x1f900 && r <= 0x1f9ff ||
		r >= 0x1fa70 && r <= 0x1faff ||
		r >= 0x20000 && r <= 0x3fffd):
		return true
	}
	switch r {
	case 0x231a, 0x231b, 0x23e9, 0x23ea, 0x23eb, 0x23ec, 0x23f0, 0x23f3,
		0x25fd, 0x25fe, 0x2614, 0x2615, 0x2648, 0x2649, 0x264a, 0x264b, 0x264c,
		0x264d, 0x264e, 0x264f, 0x2650, 0x2651, 0x2652, 0x2653, 0x267f, 0x2693,
		0x26a1, 0x26aa, 0x26ab, 0x26bd, 0x26be, 0x26c4, 0x26c5, 0x26ce, 0x26d4,
		0x26ea, 0x26f2, 0x26f3, 0x26f5, 0x26fa, 0x26fd, 0x2705, 0x270a, 0x270b,
		0x2728, 0x274c, 0x274e, 0x2753, 0x2754, 0x2755, 0x2757, 0x2795, 0x2796,
		0x2797, 0x27b0, 0x27bf, 0x2b1b, 0x2b1c, 0x2b50, 0x2b55:
		return true
	}
	return false
}

// StringWidth returns the display width of s in terminal cells.
func StringWidth(s string) int {
	w := 0
	for _, r := range s {
		w += RuneWidth(r)
	}
	return w
}

// Truncate shortens s to fit width cells, appending an ellipsis when cut.
func Truncate(s string, width int) string {
	if StringWidth(s) <= width {
		return s
	}
	var b strings.Builder
	w := 0
	for _, r := range s {
		rw := RuneWidth(r)
		if w+rw > width-1 {
			break
		}
		b.WriteRune(r)
		w += rw
	}
	return b.String() + "…"
}

// PadRight pads s with spaces to width cells (truncating first when needed).
func PadRight(s string, width int) string {
	if StringWidth(s) > width {
		s = Truncate(s, width)
	}
	return s + strings.Repeat(" ", width-StringWidth(s))
}

// Table renders a width-aware aligned table. maxWidth optionally caps specific
// columns (by index) so long names do not blow up the layout.
func Table(headers []string, rows [][]string, maxWidth map[int]int) string {
	cols := len(headers)
	widths := make([]int, cols)
	for i, h := range headers {
		widths[i] = StringWidth(h)
	}
	prepared := make([][]string, len(rows))
	for r, row := range rows {
		prepared[r] = make([]string, cols)
		for i := 0; i < cols; i++ {
			cell := ""
			if i < len(row) {
				cell = row[i]
			}
			if maxWidth != nil {
				if cap, ok := maxWidth[i]; ok {
					cell = Truncate(cell, cap)
				}
			}
			prepared[r][i] = cell
			if w := StringWidth(cell); w > widths[i] {
				widths[i] = w
			}
		}
	}

	var b strings.Builder
	for i, h := range headers {
		if i > 0 {
			b.WriteString("  ")
		}
		b.WriteString(PadRight(h, widths[i]))
	}
	writeTrimmedLine(&b)
	for i := 0; i < cols; i++ {
		if i > 0 {
			b.WriteString("  ")
		}
		b.WriteString(strings.Repeat("-", widths[i]))
	}
	writeTrimmedLine(&b)
	for _, row := range prepared {
		for i := 0; i < cols; i++ {
			if i > 0 {
				b.WriteString("  ")
			}
			b.WriteString(PadRight(row[i], widths[i]))
		}
		writeTrimmedLine(&b)
	}
	return b.String()
}

func writeTrimmedLine(b *strings.Builder) {
	s := strings.TrimRight(b.String(), " ")
	b.Reset()
	b.WriteString(s)
	b.WriteString("\n")
}
