package greasyfork

import "testing"

func TestParseScriptID(t *testing.T) {
	cases := []struct {
		in   string
		want int64
		ok   bool
	}{
		{"405130", 405130, true},
		{"405130-text-copy", 405130, true},
		{"https://greasyfork.org/zh-CN/scripts/405130-slug", 405130, true},
		{"https://greasyfork.org/en/scripts/1", 1, true},
		{"  405130  ", 405130, true},
		{"https://greasyfork.org/en/users/584991-windrunnermax", 0, false},
		{"not-a-script", 0, false},
		{"", 0, false},
	}
	for _, c := range cases {
		got, err := ParseScriptID(c.in)
		if c.ok && err != nil {
			t.Errorf("ParseScriptID(%q) unexpected error: %v", c.in, err)
			continue
		}
		if !c.ok {
			if err == nil {
				t.Errorf("ParseScriptID(%q) expected error, got %d", c.in, got)
			}
			continue
		}
		if got != c.want {
			t.Errorf("ParseScriptID(%q) = %d, want %d", c.in, got, c.want)
		}
	}
}

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"6.10", "6.9", 1},
		{"6.9", "6.10", -1},
		{"6.2.10", "1.0.0", 1},
		{"1.0.0", "1.0.0", 0},
		{"1.0", "1.0.0", 0},
		{"1.0.1", "1.0", 1},
		{"1.0", "1.0.1", -1},
		{"2.0", "10.0", -1},
		{"20231121.2", "20231121", 1},
		{"1.212", "1.2", 1},
		{"v0.5.0", "0.5.0", 1}, // 'v' is a text segment, which ranks above numbers
	}
	for _, c := range cases {
		got := CompareVersions(c.a, c.b)
		got = sign64(got)
		if got != c.want {
			t.Errorf("CompareVersions(%q,%q) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestIsNewer(t *testing.T) {
	if !IsNewer("6.2.10", "1.0.0") {
		t.Error("6.2.10 should be newer than 1.0.0")
	}
	if IsNewer("6.2.10", "6.2.10") {
		t.Error("equal versions are not newer")
	}
	if !IsNewer("6.2.10", "6.2.9") {
		t.Error("6.2.10 should be newer than 6.2.9")
	}
}

func TestMetaURLFrom(t *testing.T) {
	cases := []struct{ in, want string }{
		{"https://update.greasyfork.org/scripts/1/a.user.js",
			"https://update.greasyfork.org/scripts/1/a.meta.js"},
		{"https://update.greasyfork.org/scripts/1/a.user.css",
			"https://update.greasyfork.org/scripts/1/a.meta.css"},
		{"https://update.greasyfork.org/scripts/1/a.js",
			"https://update.greasyfork.org/scripts/1/a.meta.js"},
	}
	for _, c := range cases {
		if got := MetaURLFrom(c.in); got != c.want {
			t.Errorf("MetaURLFrom(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestSafeFilename(t *testing.T) {
	cases := []struct{ in, want string }{
		{"🔥🔥文本选中复制🔥🔥.user.js", "🔥🔥文本选中复制🔥🔥.user.js"},
		{`a<b>c:d"e/f\g|h?i*j.user.js`, "a_b_c_d_e_f_g_h_i_j.user.js"},
		{"trailing.  ", "trailing"},
		{"", "script"},
	}
	for _, c := range cases {
		if got := SafeFilename(c.in); got != c.want {
			t.Errorf("SafeFilename(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestParseUserscriptMeta(t *testing.T) {
	src := `// ==UserScript==
// @name        Test Script
// @version     6.2.10
// @match       *://a.example/*
// @match       *://b.example/*
// @updateURL   https://update.greasyfork.org/scripts/1/a.meta.js
// ==/UserScript==
(function(){})();
`
	m := ParseUserscriptMeta(src)
	if got := m.First("name"); got != "Test Script" {
		t.Errorf("name = %q", got)
	}
	if got := m.First("VERSION"); got != "6.2.10" {
		t.Errorf("version (case-insensitive) = %q", got)
	}
	if got := m.All("match"); len(got) != 2 {
		t.Errorf("match values = %v, want 2", got)
	}
	if got := m.First("updateURL"); got != "https://update.greasyfork.org/scripts/1/a.meta.js" {
		t.Errorf("updateURL = %q", got)
	}
}

func TestParseUserscriptMetaNoBlock(t *testing.T) {
	// Hand-written headers without the ==UserScript== fence still parse.
	m := ParseUserscriptMeta("// @version 1.2.3\n")
	if got := m.First("version"); got != "1.2.3" {
		t.Errorf("version = %q", got)
	}
}
