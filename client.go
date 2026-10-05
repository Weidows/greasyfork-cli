// Package greasyfork is a zero-dependency Go client for Greasy Fork's
// read-only JSON API.
//
// Greasy Fork publishes no formal API documentation, but every page links its
// machine-readable sibling via <link rel="alternate" type="application/json">.
// The endpoints below were verified against the live site:
//
//	search / list : https://api.greasyfork.org/scripts.json?q=&page=&per_page=&sort=&locale=
//	by site       : https://api.greasyfork.org/scripts/by-site/<site>.json
//	site chart    : https://api.greasyfork.org/scripts/by-site.json  (returns {site: count})
//	detail        : https://api.greasyfork.org/scripts/<id>-<slug>.json
//	resolve slug  : https://greasyfork.org/<locale>/scripts/<id>.json
//	versions      : https://greasyfork.org/<locale>/scripts/<id>/versions.json
//	user          : https://greasyfork.org/<locale>/users/<id|slug>.json
//	raw code      : https://update.greasyfork.org/scripts/<id>/<name>.user.js
//
// Gotcha: greasyfork.org/<locale>/scripts.json IGNORES q/page/sort and always
// returns the default chart. Search must go through the api. subdomain.
package greasyfork

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path"
	"strconv"
	"strings"
	"time"
)

// Known hosts.
const (
	MainSite   = "https://greasyfork.org"
	APIHost    = "https://api.greasyfork.org"
	UpdateHost = "https://update.greasyfork.org"
)

// Version is stamped at build time with
// -ldflags "-X github.com/Weidows/greasyfork-cli.Version=v1.2.3".
var Version = "dev"

// UserAgent identifies this client, as the site's help page recommends.
var UserAgent = "greasyfork-cli/" + Version + " (+https://greasyfork.org/help/api)"

// Sentinel errors so callers can react without string matching.
var (
	ErrNotFound    = errors.New("greasyfork: not found")
	ErrRateLimited = errors.New("greasyfork: rate limited")
)

// Client talks to Greasy Fork. The zero value is not usable; call NewClient.
type Client struct {
	APIHost  string
	MainSite string
	Locale   string
	Verbose  bool
	Log      io.Writer
	HTTP     *http.Client

	proxy   string
	noProxy bool
}

// Option customises a Client.
type Option func(*Client)

// WithProxy sets an explicit proxy URL (e.g. http://127.0.0.1:7890).
func WithProxy(raw string) Option { return func(c *Client) { c.proxy = raw } }

// WithNoProxy disables proxy use entirely, ignoring the environment.
func WithNoProxy() Option { return func(c *Client) { c.noProxy = true } }

// WithLocale sets the site locale used for page and detail endpoints.
func WithLocale(l string) Option { return func(c *Client) { c.Locale = l } }

// WithTimeout sets the per-request timeout.
func WithTimeout(d time.Duration) Option {
	return func(c *Client) { c.HTTP = &http.Client{Timeout: d} }
}

// WithVerbose logs every request to w.
func WithVerbose(w io.Writer) Option {
	return func(c *Client) {
		c.Verbose = true
		if w != nil {
			c.Log = w
		}
	}
}

// NewClient builds a Client. When no proxy is configured explicitly it reuses
// whatever the machine already uses (environment, then `git config
// --global https.proxy`), which matters because greasyfork.org is unreachable
// from mainland China without one.
func NewClient(opts ...Option) *Client {
	c := &Client{
		APIHost:  APIHost,
		MainSite: MainSite,
		Locale:   "en",
		Log:      os.Stderr,
	}
	for _, o := range opts {
		o(c)
	}
	if !c.noProxy && c.proxy == "" {
		c.proxy = DetectProxy()
	}
	if c.noProxy {
		c.proxy = ""
	}
	transport := &http.Transport{
		Proxy:                 nil,
		MaxIdleConns:          8,
		IdleConnTimeout:       30 * time.Second,
		TLSHandshakeTimeout:   15 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
	}
	if c.proxy != "" {
		if u, err := url.Parse(c.proxy); err == nil {
			transport.Proxy = http.ProxyURL(u)
		}
	}
	if c.HTTP == nil {
		c.HTTP = &http.Client{Timeout: 30 * time.Second}
	}
	c.HTTP.Transport = transport
	return c
}

// Proxy reports the proxy in use, if any.
func (c *Client) Proxy() string { return c.proxy }

// DetectProxy looks for a proxy the machine already uses. It checks the
// environment first, then git's global config, which is where a local proxy is
// usually recorded even when no shell variable is exported.
func DetectProxy() string {
	for _, v := range []string{
		"GREASYFORK_CLI_PROXY",
		"https_proxy", "HTTPS_PROXY",
		"http_proxy", "HTTP_PROXY",
	} {
		if s := strings.TrimSpace(os.Getenv(v)); s != "" {
			return s
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "git", "config", "--global", "--get", "https.proxy").Output()
	if err == nil {
		if s := strings.TrimSpace(string(out)); s != "" {
			return s
		}
	}
	return ""
}

// --------------------------------------------------------------------------- //
// transport
// --------------------------------------------------------------------------- //

func (c *Client) get(ctx context.Context, rawURL, accept string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", UserAgent)
	if accept != "" {
		req.Header.Set("Accept", accept)
	}
	if c.Verbose && c.Log != nil {
		fmt.Fprintf(c.Log, "GET %s\n", rawURL)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, c.netError(rawURL, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("greasyfork: reading %s: %w", rawURL, err)
	}
	switch {
	case resp.StatusCode == http.StatusNotFound:
		return nil, fmt.Errorf("%w: %s", ErrNotFound, rawURL)
	case resp.StatusCode == http.StatusTooManyRequests:
		return nil, fmt.Errorf("%w: %s (robots.txt asks for Crawl-delay: 1)", ErrRateLimited, rawURL)
	case resp.StatusCode >= 400:
		return nil, fmt.Errorf("greasyfork: HTTP %d for %s", resp.StatusCode, rawURL)
	}
	return body, nil
}

func (c *Client) netError(rawURL string, err error) error {
	hint := ""
	if c.proxy == "" {
		hint = "\n  hint: no proxy detected — if greasyfork.org is unreachable from your" +
			" network, set one with --proxy http://127.0.0.1:7890"
	}
	return fmt.Errorf("greasyfork: cannot reach %s: %w%s", rawURL, err, hint)
}

func (c *Client) getJSON(ctx context.Context, rawURL string, out any) error {
	body, err := c.get(ctx, rawURL, "application/json")
	if err != nil {
		return err
	}
	if err := json.Unmarshal(body, out); err != nil {
		// .json endpoints occasionally answer with an HTML error page and a 200.
		head := string(body)
		if len(head) > 80 {
			head = head[:80]
		}
		return fmt.Errorf("greasyfork: %s did not return JSON (%v): %q", rawURL, err, head)
	}
	return nil
}

// Raw fetches an arbitrary resource (script source, meta block) by URL.
func (c *Client) Raw(ctx context.Context, rawURL string) ([]byte, error) {
	return c.get(ctx, rawURL, "text/javascript")
}

// --------------------------------------------------------------------------- //
// endpoints
// --------------------------------------------------------------------------- //

// Search runs a search or listing query. An empty Options.Query returns the
// top chart.
func (c *Client) Search(ctx context.Context, o SearchOptions) (*SearchResult, error) {
	var endpoint string
	if o.Site != "" {
		endpoint = fmt.Sprintf("%s/scripts/by-site/%s.json", c.APIHost, url.PathEscape(o.Site))
	} else {
		endpoint = c.APIHost + "/scripts.json"
	}

	q := url.Values{}
	if o.Page > 0 {
		q.Set("page", strconv.Itoa(o.Page))
	}
	if o.PerPage > 0 {
		perPage := o.PerPage
		if perPage > 100 {
			perPage = 100
		}
		q.Set("per_page", strconv.Itoa(perPage))
	}
	if o.Query != "" {
		q.Set("q", o.Query)
	}
	if key, ok := SortKeys[o.Sort]; ok && key != "" {
		q.Set("sort", key)
	}
	locale := o.Locale
	if locale == "" {
		locale = c.Locale
	}
	if locale != "" {
		q.Set("locale", locale)
	}
	if o.ScriptType != 0 {
		q.Set("script_type", strconv.Itoa(o.ScriptType))
	}
	if len(q) > 0 {
		endpoint += "?" + q.Encode()
	}

	var out SearchResult
	if err := c.getJSON(ctx, endpoint, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Slug resolves a script's URL slug. The slug is required because
// /scripts/<id>.json (with no slug) answers 404.
func (c *Client) Slug(ctx context.Context, id int64) (string, error) {
	endpoint := fmt.Sprintf("%s/%s/scripts/%d.json", c.MainSite, c.Locale, id)
	var m struct {
		URL string `json:"url"`
	}
	if err := c.getJSON(ctx, endpoint, &m); err != nil {
		return "", err
	}
	tail := path.Base(m.URL)
	if i := strings.IndexByte(tail, '-'); i >= 0 {
		return tail[i+1:], nil
	}
	return "", nil
}

// Script returns a script's detail record.
func (c *Client) Script(ctx context.Context, id int64) (*Script, error) {
	slug, err := c.Slug(ctx, id)
	if err != nil {
		return nil, err
	}
	endpoint := fmt.Sprintf("%s/scripts/%d", c.APIHost, id)
	if slug != "" {
		endpoint += "-" + url.PathEscape(slug)
	}
	endpoint += ".json"

	var out Script
	if err := c.getJSON(ctx, endpoint, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Versions lists every released version of a script, newest first.
func (c *Client) Versions(ctx context.Context, id int64) ([]ScriptVersion, error) {
	endpoint := fmt.Sprintf("%s/%s/scripts/%d/versions.json", c.MainSite, c.Locale, id)
	var out []ScriptVersion
	if err := c.getJSON(ctx, endpoint, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// User returns a user's profile plus their published scripts.
func (c *Client) User(ctx context.Context, who string) (*UserDetail, error) {
	endpoint := fmt.Sprintf("%s/%s/users/%s.json", c.MainSite, c.Locale, url.PathEscape(who))
	var out UserDetail
	if err := c.getJSON(ctx, endpoint, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Sites returns the number of scripts per targeted site (the server sends a
// plain {"site": count} map, not a list).
func (c *Client) Sites(ctx context.Context) (map[string]int, error) {
	endpoint := c.APIHost + "/scripts/by-site.json"
	out := map[string]int{}
	if err := c.getJSON(ctx, endpoint, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// CodeURL resolves the raw-source URL for a script, optionally for one version.
func (c *Client) CodeURL(ctx context.Context, id int64, version string) (string, *Script, error) {
	if version != "" {
		versions, err := c.Versions(ctx, id)
		if err != nil {
			return "", nil, err
		}
		for _, v := range versions {
			if v.Version == version {
				return v.CodeURL, &Script{ID: id, Version: v.Version}, nil
			}
		}
		return "", nil, fmt.Errorf("greasyfork: script %d has no version %q", id, version)
	}
	s, err := c.Script(ctx, id)
	if err != nil {
		return "", nil, err
	}
	return s.CodeURL, s, nil
}
