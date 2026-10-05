package greasyfork

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

var (
	metaBlockRe = regexp.MustCompile(`(?s)//\s*==UserScript==(.*?)//\s*==/UserScript==`)
	metaLineRe  = regexp.MustCompile(`(?m)^\s*//\s*@(\S+)\s+(.*?)\s*$`)
	scriptIDRe  = regexp.MustCompile(`/scripts/(\d+)`)
	leadingIDRe = regexp.MustCompile(`^(\d+)`)
	versionSep  = regexp.MustCompile(`[.\-_+]`)
	unsafeFile  = regexp.MustCompile(`[<>:"/\\|?*\x00-\x1f]`)
)

// UserscriptMeta holds the parsed // ==UserScript== block. Keys are lowercased;
// repeated keys (e.g. several @match lines) keep every value.
type UserscriptMeta map[string][]string

// First returns the first value for key (case-insensitive), or "".
func (m UserscriptMeta) First(key string) string {
	if vs := m[strings.ToLower(key)]; len(vs) > 0 {
		return vs[0]
	}
	return ""
}

// All returns every value for key (case-insensitive).
func (m UserscriptMeta) All(key string) []string { return m[strings.ToLower(key)] }

// ParseUserscriptMeta extracts metadata from userscript source. When the file
// has no ==UserScript== block the whole text is scanned anyway, which matches
// how managers tolerate hand-written headers.
func ParseUserscriptMeta(source string) UserscriptMeta {
	block := source
	if m := metaBlockRe.FindStringSubmatch(source); m != nil {
		block = m[1]
	}
	out := UserscriptMeta{}
	for _, m := range metaLineRe.FindAllStringSubmatch(block, -1) {
		key := strings.ToLower(m[1])
		out[key] = append(out[key], m[2])
	}
	return out
}

// ParseScriptID accepts "405130", "405130-slug" or a full Greasy Fork URL and
// returns the numeric id.
func ParseScriptID(s string) (int64, error) {
	s = strings.TrimSpace(s)
	if m := scriptIDRe.FindStringSubmatch(s); m != nil {
		return strconv.ParseInt(m[1], 10, 64)
	}
	if m := leadingIDRe.FindStringSubmatch(s); m != nil {
		return strconv.ParseInt(m[1], 10, 64)
	}
	return 0, fmt.Errorf("greasyfork: cannot parse a script id from %q", s)
}

// MetaURLFrom derives the .meta.js / .meta.css URL from a code URL.
func MetaURLFrom(codeURL string) string {
	switch {
	case strings.HasSuffix(codeURL, ".user.js"):
		return strings.TrimSuffix(codeURL, ".user.js") + ".meta.js"
	case strings.HasSuffix(codeURL, ".user.css"):
		return strings.TrimSuffix(codeURL, ".user.css") + ".meta.css"
	case strings.HasSuffix(codeURL, ".js"):
		return strings.TrimSuffix(codeURL, ".js") + ".meta.js"
	case strings.HasSuffix(codeURL, ".css"):
		return strings.TrimSuffix(codeURL, ".css") + ".meta.css"
	}
	return codeURL + ".meta.js"
}

// CompareVersions compares two loose version strings, numerically where
// possible: CompareVersions("6.10", "6.9") > 0. Segments split on [.\-_+];
// numbers rank below text; a missing segment ties with a zero one, so "1.0" and
// "1.0.0" compare equal. Pre-release ordering (1.0-beta > 1.0 here) is out of
// scope — update checks only compare released versions.
func CompareVersions(a, b string) int {
	as, bs := versionSep.Split(a, -1), versionSep.Split(b, -1)
	n := len(as)
	if len(bs) > n {
		n = len(bs)
	}
	for i := 0; i < n; i++ {
		sa, sb := segment(as, i), segment(bs, i)
		if sa == sb {
			continue
		}
		switch {
		case sa == "":
			if isZeroSegment(sb) {
				continue
			}
			return -1
		case sb == "":
			if isZeroSegment(sa) {
				continue
			}
			return 1
		}
		na, ea := strconv.ParseInt(sa, 10, 64)
		nb, eb := strconv.ParseInt(sb, 10, 64)
		switch {
		case ea == nil && eb == nil:
			if na != nb {
				return sign(na - nb)
			}
		case ea == nil: // numbers sort before text
			return -1
		case eb == nil:
			return 1
		default:
			return sign64(strings.Compare(sa, sb))
		}
	}
	return 0
}

func segment(parts []string, i int) string {
	if i < len(parts) {
		return parts[i]
	}
	return ""
}

func isZeroSegment(s string) bool {
	for _, r := range s {
		if r != '0' {
			return false
		}
	}
	return true
}

// IsNewer reports whether remote is a newer version than local.
func IsNewer(remote, local string) bool {
	return CompareVersions(remote, local) > 0
}

func sign(n int64) int {
	switch {
	case n < 0:
		return -1
	case n > 0:
		return 1
	}
	return 0
}

func sign64(n int) int { return sign(int64(n)) }

// SafeFilename strips characters that Windows rejects, keeping CJK and emoji
// (script names are full of both).
func SafeFilename(name string) string {
	cleaned := strings.TrimRight(unsafeFile.ReplaceAllString(name, "_"), " .")
	if cleaned == "" {
		return "script"
	}
	return cleaned
}
