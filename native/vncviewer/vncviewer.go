// Package vncviewer bundles a minimal noVNC client (vendored under
// assets/, MPL 2.0 — see assets/NOVNC-LICENSE.txt) and a WebSocket↔TCP
// proxy, so this app can offer a "view the VM's actual screen" debugging
// escape hatch without depending on any VNC client already being
// installed on the user's machine.
//
// Why this exists: exec_darwin.go's helper VM runs fully headless
// (-display none) — the user only sees whatever gets streamed as SSH
// output. Real bugs hit during this project's own development (a
// kernel panic, a hung cloud-init, corrupted podman storage) were only
// diagnosable by manually SSHing in; there was no way to just look at
// what the VM was doing. See tuna-os/iso-builder#12.
//
// Deliberately not wired into the default write path: this is an
// opt-in, debugging-only escape hatch (matches the pattern already
// established by the boot-check feature's own "off by default, real
// cost when on" framing — see bootcheck_linux.go). Headless + streamed
// logs stays right for the common case.
package vncviewer

import (
	"embed"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"

	"golang.org/x/net/websocket"
)

//go:embed all:assets
var assetsFS embed.FS

// Serve starts a local HTTP server offering a bundled noVNC client at
// "/vnc_lite.html", proxying its WebSocket connection (the default
// "/websockify" path noVNC's vnc_lite.html connects to when no `path`
// query param is given) to a real VNC server listening at vncAddr
// (typically "127.0.0.1:<port>" — see QEMU's -vnc flag in
// exec_darwin.go). Returns the URL to open in a browser and a stop
// function; the caller is responsible for calling stop once the VM
// (and therefore the viewer) is no longer needed.
func Serve(vncAddr string) (viewerURL string, stop func(), err error) {
	assets, err := fs.Sub(assetsFS, "assets")
	if err != nil {
		return "", nil, err
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", nil, err
	}
	port := ln.Addr().(*net.TCPAddr).Port
	origin := fmt.Sprintf("http://127.0.0.1:%d", port)

	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.FS(assets)))
	mux.Handle("/websockify", websocket.Server{
		Handshake: ownOriginOnly(origin),
		Handler: func(ws *websocket.Conn) {
			proxyToVNC(ws, vncAddr)
		},
	})

	srv := &http.Server{Handler: mux}
	go srv.Serve(ln)

	viewerURL = origin + "/vnc_lite.html"
	stop = func() { srv.Close() }
	return viewerURL, stop, nil
}

// ownOriginOnly accepts a WebSocket handshake only from the page this server
// serves. A browser lets a page from any site open a WebSocket to a loopback
// port and leaves the decision to the server, which learns the page's origin
// from the Origin header. websocket.Handler accepts every origin that parses
// as a URL, so without this any page open on the machine could reach the
// VM's console through the proxy. The comparison is exact, which also
// refuses a page that reaches this port through a host name it controls.
func ownOriginOnly(origin string) func(*websocket.Config, *http.Request) error {
	return func(config *websocket.Config, req *http.Request) error {
		if got := req.Header.Get("Origin"); got != origin {
			return fmt.Errorf("websocket origin %q is not %q", got, origin)
		}
		parsed, err := websocket.Origin(config, req)
		if err != nil {
			return err
		}
		config.Origin = parsed
		return nil
	}
}

// proxyToVNC dials the real VNC server and shuttles raw bytes between it
// and the WebSocket connection in both directions — the same job
// "websockify" does for dockur/windows's noVNC viewer (see
// tuna-os/iso-builder#12's research), just as a Go goroutine pair
// instead of a separate process.
func proxyToVNC(ws *websocket.Conn, vncAddr string) {
	ws.PayloadType = websocket.BinaryFrame

	conn, err := net.Dial("tcp", vncAddr)
	if err != nil {
		ws.Close()
		return
	}
	defer conn.Close()
	defer ws.Close()

	done := make(chan struct{}, 2)
	go func() { io.Copy(conn, ws); done <- struct{}{} }()
	go func() { io.Copy(ws, conn); done <- struct{}{} }()
	<-done
}
