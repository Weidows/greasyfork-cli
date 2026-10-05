package main

import (
	"net/url"
	"strings"
)

// unescapeBase returns the final path element of a URL, percent-decoded. Script
// code URLs embed the script name (often with CJK and emoji), so decoding keeps
// the saved filename readable.
func unescapeBase(raw string) string {
	base := raw
	if i := strings.LastIndexByte(base, '/'); i >= 0 {
		base = base[i+1:]
	}
	if dec, err := url.PathUnescape(base); err == nil {
		return dec
	}
	return base
}
