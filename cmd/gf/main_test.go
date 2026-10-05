package main

import "testing"

// resetGlobals clears the inherited-flag state between tests.
func resetGlobals() func() {
	globals = map[string]string{}
	return func() { globals = map[string]string{} }
}

// TestGlobalFlagsInheritedBySubcommand guards the regression where
// `gf --locale zh-CN search video` silently dropped the locale because run()
// parsed the leading flags and then never handed them to the subcommand.
func TestGlobalFlagsInheritedBySubcommand(t *testing.T) {
	defer resetGlobals()()

	lead := baseFlags()
	if err := lead.parse([]string{"--locale", "zh-CN"}); err != nil {
		t.Fatal(err)
	}
	globals = lead.vals

	fl := baseFlags()
	fl.add("limit", "n", fInt)
	if err := parseCmdFlags(fl, []string{"video", "-n", "5"}); err != nil {
		t.Fatal(err)
	}
	if got := fl.str("locale", "en"); got != "zh-CN" {
		t.Errorf("inherited locale = %q, want zh-CN", got)
	}
	if got := fl.arg(0); got != "video" {
		t.Errorf("positional arg = %q, want video", got)
	}
	if got := fl.num("limit", 20); got != 5 {
		t.Errorf("local limit = %d, want 5", got)
	}
}

// A flag given after the subcommand must beat the inherited global value.
func TestLocalFlagWinsOverGlobal(t *testing.T) {
	defer resetGlobals()()
	globals = map[string]string{"locale": "zh-CN"}

	fl := baseFlags()
	if err := parseCmdFlags(fl, []string{"--locale", "ja"}); err != nil {
		t.Fatal(err)
	}
	if got := fl.str("locale", "en"); got != "ja" {
		t.Errorf("locale = %q, want ja (command-local should win)", got)
	}
}

func TestClientInheritsLocale(t *testing.T) {
	defer resetGlobals()()
	globals = map[string]string{"locale": "zh-CN"}

	fl := baseFlags()
	if err := parseCmdFlags(fl, nil); err != nil {
		t.Fatal(err)
	}
	if c := clientFrom(fl); c.Locale != "zh-CN" {
		t.Errorf("client locale = %q, want zh-CN", c.Locale)
	}
}

// Flags and positional args must interleave: `gf download 405130 -o _t` has to
// see both, which the stdlib flag package would not.
func TestFlagPermutation(t *testing.T) {
	fl := newFlags()
	fl.add("output", "o", fStr)
	fl.add("with-meta", "", fBool)
	if err := fl.parse([]string{"405130", "-o", "_t", "--with-meta"}); err != nil {
		t.Fatal(err)
	}
	if fl.arg(0) != "405130" {
		t.Errorf("pos = %v", fl.pos)
	}
	if fl.str("output", "") != "_t" {
		t.Errorf("output = %q", fl.str("output", ""))
	}
	if !fl.boolean("with-meta") {
		t.Error("with-meta not set")
	}
}

func TestUnknownFlagErrors(t *testing.T) {
	fl := newFlags()
	fl.add("known", "", fBool)
	if err := fl.parse([]string{"--nope"}); err == nil {
		t.Error("expected an error for an unknown flag")
	}
}

func TestHasHelp(t *testing.T) {
	if !hasHelp([]string{"405130", "--help"}) || !hasHelp([]string{"-h"}) {
		t.Error("hasHelp missed a help flag")
	}
	if hasHelp([]string{"405130", "-o", "dir"}) {
		t.Error("hasHelp false positive")
	}
}
