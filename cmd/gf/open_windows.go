//go:build windows

package main

import "os/exec"

// openBrowser opens url in the default browser. Kept in a build-tagged file
// because the launcher differs per OS.
func openBrowser(url string) error {
	return exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
}
