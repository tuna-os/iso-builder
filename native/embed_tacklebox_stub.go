//go:build linux && !embedtacklebox

package main

// embeddedTackleboxPath returns "" in normal (non-embedded) builds; tackleboxPath
// (exec_linux.go) then resolves tacklebox next to the executable or on PATH.
// The embedded implementation lives in embed_tacklebox.go, behind the
// `embedtacklebox` build tag used for distributable single-binary builds.
func embeddedTackleboxPath() string { return "" }
