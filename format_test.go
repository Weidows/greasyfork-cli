package greasyfork

import (
	"strings"
	"testing"
)

func TestStringWidth(t *testing.T) {
	cases := []struct {
		in   string
		want int
	}{
		{"abc", 3},
		{"", 0},
		{"中文", 4},
		{"a中", 3},
		{"🔥", 2},
		{"🔥文本", 6},
	}
	for _, c := range cases {
		if got := StringWidth(c.in); got != c.want {
			t.Errorf("StringWidth(%q) = %d, want %d", c.in, got, c.want)
		}
	}
}

func TestTruncate(t *testing.T) {
	if got := Truncate("abcdef", 4); StringWidth(got) > 4 || got != "abc…" {
		t.Errorf("Truncate(abcdef,4) = %q", got)
	}
	if got := Truncate("abc", 10); got != "abc" {
		t.Errorf("Truncate should not pad: %q", got)
	}
	if got := Truncate("中文测试", 5); StringWidth(got) > 5 {
		t.Errorf("Truncate(中文测试,5) = %q (width %d)", got, StringWidth(got))
	}
}

func TestPadRight(t *testing.T) {
	if got := PadRight("中", 4); got != "中  " {
		t.Errorf("PadRight(中,4) = %q (width %d)", got, StringWidth(got))
	}
	if got := PadRight("abcdef", 4); StringWidth(got) != 4 {
		t.Errorf("PadRight should truncate to width: %q (width %d)", got, StringWidth(got))
	}
}

func TestTableAlignment(t *testing.T) {
	out := Table(
		[]string{"ID", "Name", "Updated"},
		[][]string{
			{"405130", "🔥🔥🔥文本选中复制🔥🔥🔥", "2026-01-03"},
			{"1", "short", "2023-11-22"},
		},
		map[int]int{1: 40})
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	if len(lines) != 4 { // header, separator, 2 rows
		t.Fatalf("expected 4 lines, got %d:\n%s", len(lines), out)
	}
	// The last column is not padded (trailing spaces are trimmed), so the header
	// can be narrower than the body when its text is shorter than the widest
	// cell. What must hold is that the separator and every data row share one
	// width, and that the header never exceeds it.
	want := StringWidth(lines[1])
	for i, l := range lines {
		got := StringWidth(l)
		if i == 0 {
			if got > want {
				t.Errorf("header wider than body: %d > %d\n%s", got, want, out)
			}
			continue
		}
		if got != want {
			t.Errorf("line %d width = %d, want %d\n%s", i, got, want, out)
		}
	}
	// Equal display width across the separator and every data row is the real
	// alignment property: if emoji or CJK were counted as one cell, the row
	// holding them would come out narrower than the others.
}

func TestHumanishHelpers(t *testing.T) {
	// shortDate / human live in the CLI, but StringWidth drives their layout;
	// this guards the wide-char table path used by every list command.
	if StringWidth(Truncate("2026-01-03", 10)) != 10 {
		t.Error("ascii dates should keep full width")
	}
}
