package greasyfork

import (
	"encoding/json"
	"net/url"
	"strings"
)

// FlexString tolerates a JSON value that is sometimes a string and sometimes a
// number. Greasy Fork ships fan_score as a string ("88.6") but the field is a
// score, so treat a numeric value as valid too instead of failing the decode.
type FlexString string

// UnmarshalJSON implements json.Unmarshaler.
func (f *FlexString) UnmarshalJSON(b []byte) error {
	if len(b) == 0 || string(b) == "null" {
		*f = ""
		return nil
	}
	if b[0] == '"' {
		var s string
		if err := json.Unmarshal(b, &s); err != nil {
			return err
		}
		*f = FlexString(s)
		return nil
	}
	*f = FlexString(strings.TrimSpace(string(b)))
	return nil
}

func (f FlexString) String() string { return string(f) }

// User is the trimmed author object embedded in a Script.
type User struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	CreatedAt string `json:"created_at"`
	URL       string `json:"url"`
}

// Script mirrors one Greasy Fork script record. Search results and the
// /scripts/<id>-<slug>.json detail endpoint return the same shape, so one type
// serves both.
type Script struct {
	ID                 int64      `json:"id"`
	DailyInstalls      int64      `json:"daily_installs"`
	TotalInstalls      int64      `json:"total_installs"`
	FanScore           FlexString `json:"fan_score"`
	GoodRatings        int        `json:"good_ratings"`
	OKRatings          int        `json:"ok_ratings"`
	BadRatings         int        `json:"bad_ratings"`
	CreatedAt          string     `json:"created_at"`
	CodeUpdatedAt      string     `json:"code_updated_at"`
	Namespace          string     `json:"namespace"`
	SupportURL         string     `json:"support_url"`
	ContributionURL    string     `json:"contribution_url"`
	ContributionAmount any        `json:"contribution_amount"`
	Users              []User     `json:"users"`
	Name               string     `json:"name"`
	Description        string     `json:"description"`
	URL                string     `json:"url"`
	CodeURL            string     `json:"code_url"`
	CodeSize           int64      `json:"code_size"`
	License            string     `json:"license"`
	Version            string     `json:"version"`
	Locale             string     `json:"locale"`
	Deleted            bool       `json:"deleted"`
}

// Author returns the comma-joined author names.
func (s Script) Author() string {
	names := make([]string, 0, len(s.Users))
	for _, u := range s.Users {
		names = append(names, u.Name)
	}
	return strings.Join(names, ", ")
}

// Slug returns the human-readable part of the script URL (the tail after the
// leading "<id>-"), percent-decoded so it is usable as a filename. Empty when
// the URL is absent.
func (s Script) Slug() string {
	tail := s.URL
	if i := strings.LastIndexByte(tail, '/'); i >= 0 {
		tail = tail[i+1:]
	}
	i := strings.IndexByte(tail, '-')
	if i < 0 {
		return ""
	}
	tail = tail[i+1:]
	if dec, err := url.PathUnescape(tail); err == nil {
		return dec
	}
	return tail
}

// SearchOptions controls a search / listing request.
type SearchOptions struct {
	Query      string
	Page       int
	PerPage    int
	Sort       string // key of SortKeys; empty means the API default
	Locale     string // overrides Client.Locale when non-empty
	Site       string // restrict to one site, e.g. "bilibili.com"
	ScriptType int    // 0 = server default (1 = public scripts)
}

// searchEcho is the query the server actually executed; useful to confirm that
// a parameter took effect instead of being silently ignored.
type searchEcho struct {
	Fields  []string          `json:"fields"`
	BoostBy []string          `json:"boost_by"`
	Where   map[string]any    `json:"where"`
	Order   map[string]string `json:"order"`
	Page    int               `json:"page"`
	PerPage int               `json:"per_page"`
}

// SearchResult is the envelope returned by scripts.json.
type SearchResult struct {
	Model   string          `json:"model"`
	Term    string          `json:"term"`
	Options searchEcho      `json:"options"`
	Query   []Script        `json:"query"`
	Execute json.RawMessage `json:"execute"` // array of terms, unused
}

// ScriptVersion is one historical release of a script. (Named ScriptVersion
// rather than Version so it does not collide with the build-stamp Version var.)
type ScriptVersion struct {
	Version   string `json:"version"`
	CreatedAt string `json:"created_at"`
	URL       string `json:"url"`
	CodeURL   string `json:"code_url"`
	Changelog string `json:"changelog"`
}

// UserDetail is returned by /<locale>/users/<id|slug>.json.
type UserDetail struct {
	ID        int64    `json:"id"`
	Name      string   `json:"name"`
	CreatedAt string   `json:"created_at"`
	URL       string   `json:"url"`
	Scripts   []Script `json:"scripts"`
}

// SortKeys maps a friendly sort name to the value the API expects. Keys with an
// empty value mean "let the server decide" (relevance with a query, daily
// installs without one).
var SortKeys = map[string]string{
	"relevant": "",
	"daily":    "",
	"installs": "installs",
	"created":  "created",
	"updated":  "updated",
	"rating":   "rating",
	"name":     "name",
}

// SortNames returns the friendly sort names, sorted.
func SortNames() []string {
	out := make([]string, 0, len(SortKeys))
	for k := range SortKeys {
		out = append(out, k)
	}
	sortStrings(out)
	return out
}

func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}
