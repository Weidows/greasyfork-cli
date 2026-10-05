// Command gf is the Greasy Fork CLI: browse, search and download userscripts
// from the terminal.
//
// It is a thin shell over github.com/Weidows/greasyfork-cli, the importable
// client library.
//
//	go install github.com/Weidows/greasyfork-cli/cmd/gf@latest
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	greasyfork "github.com/Weidows/greasyfork-cli"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

// --------------------------------------------------------------------------- //
// flag parsing (permuting: flags and positional args may interleave)
// --------------------------------------------------------------------------- //

type fkind int

const (
	fBool fkind = iota
	fStr
	fInt
)

type fspec struct {
	long  string
	short string
	kind  fkind
}

// flags is a minimal permuting flag parser. The standard library's flag package
// stops at the first non-flag argument, which would silently drop the -o in
// `gf download 405130 -o dir`; this one accepts flags anywhere.
type flags struct {
	specs   []fspec
	byLong  map[string]fspec
	byShort map[string]fspec
	vals    map[string]string
	pos     []string
}

func newFlags() *flags {
	return &flags{
		byLong:  map[string]fspec{},
		byShort: map[string]fspec{},
		vals:    map[string]string{},
	}
}

func (fl *flags) add(long, short string, k fkind) {
	s := fspec{long: long, short: short, kind: k}
	fl.specs = append(fl.specs, s)
	fl.byLong[long] = s
	if short != "" {
		fl.byShort[short] = s
	}
}

func (fl *flags) lookup(name string) (fspec, bool) {
	if s, ok := fl.byLong[name]; ok {
		return s, true
	}
	if s, ok := fl.byShort[name]; ok {
		return s, true
	}
	return fspec{}, false
}

func (fl *flags) parse(args []string) error {
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			fl.pos = append(fl.pos, args[i+1:]...)
			break
		}
		if len(a) < 2 || a[0] != '-' {
			fl.pos = append(fl.pos, a)
			continue
		}
		name := strings.TrimLeft(a, "-")
		inline := ""
		hasInline := false
		if j := strings.IndexByte(name, '='); j >= 0 {
			inline, hasInline = name[j+1:], true
			name = name[:j]
		}
		spec, ok := fl.lookup(name)
		if !ok {
			return fmt.Errorf("unknown flag: %s", a)
		}
		switch spec.kind {
		case fBool:
			if hasInline {
				b, err := strconv.ParseBool(inline)
				if err != nil {
					return fmt.Errorf("flag --%s expects a boolean, got %q", spec.long, inline)
				}
				fl.vals[spec.long] = strconv.FormatBool(b)
			} else {
				fl.vals[spec.long] = "true"
			}
		default:
			if !hasInline {
				if i+1 >= len(args) {
					return fmt.Errorf("flag --%s needs a value", spec.long)
				}
				i++
				inline = args[i]
			}
			fl.vals[spec.long] = inline
		}
	}
	return nil
}

func (fl *flags) has(name string) bool { _, ok := fl.vals[name]; return ok }
func (fl *flags) boolean(name string) bool {
	v, _ := strconv.ParseBool(fl.vals[name])
	return v
}

func (fl *flags) str(name, def string) string {
	if v, ok := fl.vals[name]; ok {
		return v
	}
	return def
}

func (fl *flags) num(name string, def int) int {
	if v, ok := fl.vals[name]; ok {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func (fl *flags) arg(i int) string {
	if i < len(fl.pos) {
		return fl.pos[i]
	}
	return ""
}

// baseFlags registers the global options, accepted before or after the
// subcommand.
func baseFlags() *flags {
	fl := newFlags()
	fl.add("proxy", "", fStr)
	fl.add("no-proxy", "", fBool)
	fl.add("timeout", "", fInt)
	fl.add("locale", "", fStr)
	fl.add("verbose", "v", fBool)
	fl.add("help", "h", fBool)
	return fl
}

func clientFrom(fl *flags) *greasyfork.Client {
	var opts []greasyfork.Option
	if fl.has("proxy") {
		opts = append(opts, greasyfork.WithProxy(fl.str("proxy", "")))
	}
	if fl.boolean("no-proxy") {
		opts = append(opts, greasyfork.WithNoProxy())
	}
	if fl.has("locale") {
		opts = append(opts, greasyfork.WithLocale(fl.str("locale", "en")))
	}
	if fl.has("timeout") {
		opts = append(opts, greasyfork.WithTimeout(time.Duration(fl.num("timeout", 30))*time.Second))
	}
	if fl.boolean("verbose") {
		opts = append(opts, greasyfork.WithVerbose(os.Stderr))
	}
	return greasyfork.NewClient(opts...)
}

// --------------------------------------------------------------------------- //
// output helpers
// --------------------------------------------------------------------------- //

func human(n int64) string {
	switch {
	case n >= 1_000_000_000:
		return trimZero(float64(n)/1e9) + "B"
	case n >= 1_000_000:
		return trimZero(float64(n)/1e6) + "M"
	case n >= 1_000:
		return trimZero(float64(n)/1e3) + "k"
	}
	return strconv.FormatInt(n, 10)
}

func trimZero(f float64) string {
	s := strconv.FormatFloat(f, 'f', 1, 64)
	return strings.TrimSuffix(s, ".0")
}

func shortDate(s string) string {
	if len(s) >= 10 {
		return s[:10]
	}
	if s == "" {
		return "-"
	}
	return s
}

func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

func fan(s greasyfork.FlexString) string { return orDash(s.String()) }

func printJSON(v any) error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	enc.SetEscapeHTML(false)
	return enc.Encode(v)
}

// --------------------------------------------------------------------------- //
// dispatch
// --------------------------------------------------------------------------- //

type command struct {
	name  string
	alias []string
	usage string
	brief string
	run   func(ctx context.Context, args []string) error
}

func commands() []command {
	return []command{
		{"search", []string{"s"}, "search [query] [-n N] [--sort S] [--site D] [--json]",
			"search scripts (no query = top chart)", cmdSearch},
		{"info", []string{"show"}, "info <script> [--json]", "show script details", cmdInfo},
		{"download", []string{"dl"}, "download <script> [-o DIR] [--version V] [--with-meta] [--short-name]",
			"download the .user.js (and .meta.js)", cmdDownload},
		{"cat", nil, "cat <script> [--version V]", "print script source to stdout", cmdCat},
		{"versions", nil, "versions <script> [--json]", "list released versions", cmdVersions},
		{"user", nil, "user <id|slug> [--json]", "list a user's published scripts", cmdUser},
		{"sites", nil, "sites [-n N] [--json]", "list sites that scripts target", cmdSites},
		{"open", nil, "open <script> [--launch]", "print the script page URL", cmdOpen},
		{"check", nil, "check <path...>", "check local userscripts for updates", cmdCheck},
	}
}

// globals carries the values of global flags that appeared before the
// subcommand, so `gf --locale zh-CN search x` reaches the command that needs
// them. Command-local flags always win.
var globals = map[string]string{}

// parseCmdFlags parses a command's arguments and then folds in the inherited
// global flags for anything the command did not set itself.
func parseCmdFlags(fl *flags, args []string) error {
	if err := fl.parse(args); err != nil {
		return err
	}
	for k, v := range globals {
		if _, set := fl.vals[k]; !set {
			fl.vals[k] = v
		}
	}
	return nil
}

// hasHelp reports whether args contain -h or --help.
func hasHelp(args []string) bool {
	for _, a := range args {
		if a == "-h" || a == "--help" {
			return true
		}
	}
	return false
}

// printCommandHelp prints the usage line for one subcommand.
func printCommandHelp(name string) {
	for _, c := range commands() {
		if c.name == name || contains(c.alias, name) {
			fmt.Printf("usage: gf %s\n\n%s\n\nGlobal flags: %s\n", c.usage, c.brief,
				"--proxy URL | --no-proxy | --timeout SECS | --locale CODE | -v | -h")
			return
		}
	}
	usage()
}

func run(args []string) error {
	// Consume leading global flags so the subcommand can be located even when
	// values follow their flag (e.g. --proxy http://x search foo). Their values
	// are remembered in globals and merged into the subcommand's flags.
	lead := baseFlags()
	i := 0
	for i < len(args) {
		a := args[i]
		if len(a) < 2 || a[0] != '-' {
			break
		}
		name := strings.TrimLeft(a, "-")
		hasInline := strings.Contains(name, "=")
		if j := strings.IndexByte(name, '='); j >= 0 {
			name = name[:j]
		}
		spec, ok := lead.lookup(name)
		if !ok {
			return fmt.Errorf("unknown flag: %s", a)
		}
		if hasInline || spec.kind == fBool {
			if err := lead.parse(args[i : i+1]); err != nil {
				return err
			}
			i++
			continue
		}
		if i+1 >= len(args) {
			return fmt.Errorf("flag --%s needs a value", spec.long)
		}
		if err := lead.parse(args[i : i+2]); err != nil {
			return err
		}
		i += 2
	}
	globals = lead.vals

	if i >= len(args) {
		usage()
		return nil
	}
	sub := args[i]
	rest := args[i+1:]

	if sub == "help" {
		if len(rest) > 0 {
			printCommandHelp(rest[0])
			return nil
		}
		usage()
		return nil
	}
	if sub == "version" {
		fmt.Println("gf", greasyfork.Version)
		return nil
	}
	if hasHelp(rest) {
		printCommandHelp(sub)
		return nil
	}

	for _, c := range commands() {
		if c.name == sub || contains(c.alias, sub) {
			ctx := context.Background()
			return c.run(ctx, rest)
		}
	}
	usage()
	return fmt.Errorf("unknown command %q", sub)
}

func contains(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}

func usage() {
	fmt.Print(`gf — browse, search and download Greasy Fork userscripts

Usage:
  gf [global flags] <command> [flags] [args]

Commands:
`)
	for _, c := range commands() {
		line := "  " + greasyfork.PadRight(c.usage, 74)
		fmt.Printf("%s %s\n", line, c.brief)
	}
	fmt.Print(`
Global flags:
  --proxy URL     proxy, e.g. http://127.0.0.1:7890 (auto-detected from
                  env / git config https.proxy)
  --no-proxy      disable proxy use entirely
  --timeout SECS  per-request timeout (default 30)
  --locale CODE   site locale, e.g. en or zh-CN (default en)
  -v, --verbose   log requests to stderr
  -h, --help      show help
      --version   print gf version

Endpoints: api.greasyfork.org (JSON) · update.greasyfork.org (raw code)
`)
}

// --------------------------------------------------------------------------- //
// commands
// --------------------------------------------------------------------------- //

func cmdSearch(ctx context.Context, args []string) error {
	fl := baseFlags()
	fl.add("page", "p", fInt)
	fl.add("limit", "n", fInt)
	fl.add("sort", "", fStr)
	fl.add("site", "", fStr)
	fl.add("json", "", fBool)
	if err := fl.parse(args); err != nil {
		return err
	}
	c := clientFrom(fl)

	sortKey := fl.str("sort", "relevant")
	if _, ok := greasyfork.SortKeys[sortKey]; !ok {
		return fmt.Errorf("unknown --sort %q (expected one of %s)", sortKey,
			strings.Join(greasyfork.SortNames(), ", "))
	}
	limit := fl.num("limit", 20)
	res, err := c.Search(ctx, greasyfork.SearchOptions{
		Query:   fl.arg(0),
		Page:    fl.num("page", 1),
		PerPage: limit,
		Sort:    sortKey,
		Site:    fl.str("site", ""),
	})
	if err != nil {
		return err
	}
	if fl.boolean("json") {
		return printJSON(res.Query)
	}
	scripts := res.Query
	if len(scripts) > limit {
		scripts = scripts[:limit]
	}
	if len(scripts) == 0 {
		fmt.Printf("no scripts matched %q\n", fl.arg(0))
		return nil
	}
	rows := make([][]string, 0, len(scripts))
	for _, s := range scripts {
		rows = append(rows, []string{
			strconv.FormatInt(s.ID, 10), s.Name, s.Author(),
			human(s.DailyInstalls), human(s.TotalInstalls),
			fan(s.FanScore), shortDate(s.CodeUpdatedAt),
		})
	}
	fmt.Print(greasyfork.Table(
		[]string{"ID", "Name", "Author", "Daily", "Total", "Fan", "Updated"},
		rows, map[int]int{1: 52, 2: 18}))
	fmt.Printf("\n%d shown (page %d) · %s\n", len(scripts), fl.num("page", 1), c.APIHost)
	return nil
}

func cmdInfo(ctx context.Context, args []string) error {
	fl := baseFlags()
	fl.add("json", "", fBool)
	if err := fl.parse(args); err != nil {
		return err
	}
	if fl.arg(0) == "" {
		return fmt.Errorf("usage: gf info <script>")
	}
	c := clientFrom(fl)
	id, err := greasyfork.ParseScriptID(fl.arg(0))
	if err != nil {
		return err
	}
	s, err := c.Script(ctx, id)
	if err != nil {
		return err
	}
	if fl.boolean("json") {
		return printJSON(s)
	}
	fmt.Printf("%s  [id %d]\n", s.Name, s.ID)
	fmt.Printf("Author     : %s\n", orDash(s.Author()))
	for _, row := range [][2]string{
		{"Version", s.Version}, {"Locale", s.Locale}, {"License", s.License},
		{"Namespace", s.Namespace}, {"Created", s.CreatedAt}, {"Updated", s.CodeUpdatedAt},
	} {
		if row[1] != "" {
			fmt.Printf("%-11s: %s\n", row[0], row[1])
		}
	}
	if s.CodeSize > 0 {
		fmt.Printf("%-11s: %s\n", "Code size", human(s.CodeSize))
	}
	fmt.Printf("%-11s: %d daily / %d total · fan %s · ratings %d★ %d~ %d✗\n",
		"Installs", s.DailyInstalls, s.TotalInstalls, fan(s.FanScore),
		s.GoodRatings, s.OKRatings, s.BadRatings)
	if s.Description != "" {
		fmt.Printf("\n%s\n", s.Description)
	}
	fmt.Printf("\nPage    : %s/scripts/%d\n", c.MainSite, s.ID)
	fmt.Printf("Install : %s\n", s.CodeURL)
	if s.CodeURL != "" {
		fmt.Printf("Meta    : %s\n", greasyfork.MetaURLFrom(s.CodeURL))
	}
	return nil
}

func cmdDownload(ctx context.Context, args []string) error {
	fl := baseFlags()
	fl.add("output", "o", fStr)
	fl.add("version", "", fStr)
	fl.add("with-meta", "", fBool)
	fl.add("short-name", "", fBool)
	if err := fl.parse(args); err != nil {
		return err
	}
	if fl.arg(0) == "" {
		return fmt.Errorf("usage: gf download <script> [-o DIR]")
	}
	c := clientFrom(fl)
	id, err := greasyfork.ParseScriptID(fl.arg(0))
	if err != nil {
		return err
	}
	codeURL, info, err := c.CodeURL(ctx, id, fl.str("version", ""))
	if err != nil {
		return err
	}
	if codeURL == "" {
		return fmt.Errorf("script %d has no downloadable code (deleted?)", id)
	}

	name := unescapeBase(codeURL)
	if fl.boolean("short-name") {
		if slug := info.Slug(); slug != "" {
			ext := ".user.js"
			if strings.HasSuffix(name, ".user.css") {
				ext = ".user.css"
			}
			name = fmt.Sprintf("%d-%s%s", id, slug, ext)
		}
	}
	name = greasyfork.SafeFilename(name)
	dir := fl.str("output", ".")
	dest := filepath.Join(dir, name)
	n, err := save(ctx, c, codeURL, dest)
	if err != nil {
		return err
	}
	fmt.Printf("saved %s  (%d bytes)\n", dest, n)

	if fl.boolean("with-meta") {
		metaURL := greasyfork.MetaURLFrom(codeURL)
		metaName := metaNameFor(name)
		mdest := filepath.Join(dir, metaName)
		n2, err := save(ctx, c, metaURL, mdest)
		if err != nil {
			return err
		}
		fmt.Printf("saved %s  (%d bytes)\n", mdest, n2)
	}
	return nil
}

func metaNameFor(name string) string {
	switch {
	case strings.HasSuffix(name, ".user.js"):
		return strings.TrimSuffix(name, ".user.js") + ".meta.js"
	case strings.HasSuffix(name, ".user.css"):
		return strings.TrimSuffix(name, ".user.css") + ".meta.css"
	}
	return name + ".meta.js"
}

func save(ctx context.Context, c *greasyfork.Client, url, dest string) (int, error) {
	body, err := c.Raw(ctx, url)
	if err != nil {
		return 0, err
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return 0, err
	}
	if err := os.WriteFile(dest, body, 0o644); err != nil {
		return 0, err
	}
	return len(body), nil
}

func cmdCat(ctx context.Context, args []string) error {
	fl := baseFlags()
	fl.add("version", "", fStr)
	if err := fl.parse(args); err != nil {
		return err
	}
	if fl.arg(0) == "" {
		return fmt.Errorf("usage: gf cat <script>")
	}
	c := clientFrom(fl)
	id, err := greasyfork.ParseScriptID(fl.arg(0))
	if err != nil {
		return err
	}
	codeURL, _, err := c.CodeURL(ctx, id, fl.str("version", ""))
	if err != nil {
		return err
	}
	body, err := c.Raw(ctx, codeURL)
	if err != nil {
		return err
	}
	_, err = os.Stdout.Write(body)
	return err
}

func cmdVersions(ctx context.Context, args []string) error {
	fl := baseFlags()
	fl.add("json", "", fBool)
	if err := fl.parse(args); err != nil {
		return err
	}
	if fl.arg(0) == "" {
		return fmt.Errorf("usage: gf versions <script>")
	}
	c := clientFrom(fl)
	id, err := greasyfork.ParseScriptID(fl.arg(0))
	if err != nil {
		return err
	}
	vs, err := c.Versions(ctx, id)
	if err != nil {
		return err
	}
	if fl.boolean("json") {
		return printJSON(vs)
	}
	rows := make([][]string, 0, len(vs))
	for _, v := range vs {
		rows = append(rows, []string{v.Version, shortDate(v.CreatedAt), v.CodeURL})
	}
	fmt.Print(greasyfork.Table([]string{"Version", "Created", "Code URL"}, rows, map[int]int{2: 60}))
	return nil
}

func cmdUser(ctx context.Context, args []string) error {
	fl := baseFlags()
	fl.add("json", "", fBool)
	if err := fl.parse(args); err != nil {
		return err
	}
	if fl.arg(0) == "" {
		return fmt.Errorf("usage: gf user <id|slug>")
	}
	c := clientFrom(fl)
	u, err := c.User(ctx, fl.arg(0))
	if err != nil {
		return err
	}
	if fl.boolean("json") {
		return printJSON(u)
	}
	fmt.Printf("%s  [id %d] · joined %s\n", u.Name, u.ID, shortDate(u.CreatedAt))
	fmt.Printf("page: %s\n\n", u.URL)
	rows := make([][]string, 0, len(u.Scripts))
	for _, s := range u.Scripts {
		rows = append(rows, []string{
			strconv.FormatInt(s.ID, 10), s.Name, human(s.DailyInstalls),
			human(s.TotalInstalls), fan(s.FanScore), shortDate(s.CodeUpdatedAt),
		})
	}
	fmt.Print(greasyfork.Table([]string{"ID", "Name", "Daily", "Total", "Fan", "Updated"},
		rows, map[int]int{1: 56}))
	return nil
}

func cmdSites(ctx context.Context, args []string) error {
	fl := baseFlags()
	fl.add("limit", "n", fInt)
	fl.add("json", "", fBool)
	if err := fl.parse(args); err != nil {
		return err
	}
	c := clientFrom(fl)
	sites, err := c.Sites(ctx)
	if err != nil {
		return err
	}
	if fl.boolean("json") {
		return printJSON(sites)
	}
	type kv struct {
		site string
		n    int
	}
	list := make([]kv, 0, len(sites))
	for s, n := range sites {
		list = append(list, kv{s, n})
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].n != list[j].n {
			return list[i].n > list[j].n
		}
		return list[i].site < list[j].site
	})
	limit := fl.num("limit", 30)
	if limit > len(list) {
		limit = len(list)
	}
	rows := make([][]string, 0, limit)
	for _, e := range list[:limit] {
		rows = append(rows, []string{e.site, strconv.Itoa(e.n)})
	}
	fmt.Print(greasyfork.Table([]string{"Site", "Scripts"}, rows, map[int]int{0: 60}))
	fmt.Printf("\n%d shown\n", limit)
	return nil
}

func cmdOpen(ctx context.Context, args []string) error {
	fl := baseFlags()
	fl.add("launch", "", fBool)
	if err := fl.parse(args); err != nil {
		return err
	}
	if fl.arg(0) == "" {
		return fmt.Errorf("usage: gf open <script>")
	}
	id, err := greasyfork.ParseScriptID(fl.arg(0))
	if err != nil {
		return err
	}
	// <site>/scripts/<id> redirects to the canonical <id>-<slug> URL, so the
	// short form is both readable and correct — and avoids a request.
	url := fmt.Sprintf("%s/scripts/%d", greasyfork.MainSite, id)
	fmt.Println(url)
	if fl.boolean("launch") {
		return openBrowser(url)
	}
	return nil
}

func cmdCheck(ctx context.Context, args []string) error {
	fl := baseFlags()
	if err := parseCmdFlags(fl, args); err != nil {
		return err
	}
	if len(fl.pos) == 0 {
		return fmt.Errorf("usage: gf check <path...>")
	}
	c := clientFrom(fl)

	var files []string
	for _, p := range fl.pos {
		info, err := os.Stat(p)
		if err != nil {
			fmt.Printf("skip (not found): %s\n", p)
			continue
		}
		if info.IsDir() {
			for _, pat := range []string{"*.user.js", "*.user.css"} {
				matches, _ := filepath.Glob(filepath.Join(p, pat))
				sort.Strings(matches)
				files = append(files, matches...)
			}
			continue
		}
		files = append(files, p)
	}
	if len(files) == 0 {
		return fmt.Errorf("no .user.js files found to check")
	}

	rows := make([][]string, 0, len(files))
	outdated := 0
	for _, f := range files {
		src, err := os.ReadFile(f)
		if err != nil {
			rows = append(rows, []string{filepath.Base(f), "?", "-", "", "read error"})
			continue
		}
		meta := greasyfork.ParseUserscriptMeta(string(src))
		local := orDash(meta.First("version"))
		upd := meta.First("updateURL")
		if upd == "" {
			upd = meta.First("downloadURL")
		}
		if upd == "" {
			rows = append(rows, []string{filepath.Base(f), local, "-", "", "no @updateURL"})
			continue
		}
		body, err := c.Raw(ctx, upd)
		if err != nil {
			rows = append(rows, []string{filepath.Base(f), local, "-", "", "fetch error"})
			continue
		}
		remote := orDash(greasyfork.ParseUserscriptMeta(string(body)).First("version"))
		status := "ok"
		if greasyfork.IsNewer(remote, local) {
			status = "UPDATE"
			outdated++
		}
		rows = append(rows, []string{filepath.Base(f), local, remote, "", status})
	}
	fmt.Print(greasyfork.Table([]string{"File", "Local", "Remote", "", "Status"}, rows,
		map[int]int{0: 46}))
	fmt.Printf("\n%d checked · %d outdated\n", len(files), outdated)
	return nil
}
