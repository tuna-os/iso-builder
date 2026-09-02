package vncviewer

// Tests for proxyToVNC (was 0%): the WebSocket<->TCP shuttle is the only
// thing standing between the bundled noVNC client and QEMU's -vnc socket,
// and it is the part that cannot be eyeballed from a screenshot. These
// drive it through the real Serve() mux with a real WebSocket client and a
// stand-in VNC server, so the assertions cover the wiring (binary frames,
// both copy directions, teardown) rather than the function in isolation.

import (
	"bytes"
	"io"
	"net"
	"net/url"
	"strings"
	"testing"
	"time"

	"golang.org/x/net/websocket"
)

// fakeVNCServer accepts exactly one connection and hands it to the caller.
// It stands in for QEMU's -vnc listener: proxyToVNC does not speak RFB, it
// only shuttles bytes, so a raw TCP peer is a faithful stand-in.
func fakeVNCServer(t *testing.T) (addr string, accepted <-chan net.Conn) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { ln.Close() })

	conns := make(chan net.Conn, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			close(conns)
			return
		}
		conns <- conn
	}()
	return ln.Addr().String(), conns
}

// dialWebsockify opens the proxy endpoint that noVNC's vnc_lite.html uses
// by default.
func dialWebsockify(t *testing.T, viewerURL string) *websocket.Conn {
	t.Helper()
	wsURL := strings.Replace(viewerURL, "/vnc_lite.html", "/websockify", 1)
	u, err := url.Parse(wsURL)
	if err != nil {
		t.Fatalf("parse %q: %v", wsURL, err)
	}
	u.Scheme = "ws"

	ws, err := websocket.Dial(u.String(), "", "http://"+u.Host)
	if err != nil {
		t.Fatalf("websocket dial %s: %v", u, err)
	}
	t.Cleanup(func() { ws.Close() })
	ws.PayloadType = websocket.BinaryFrame
	return ws
}

func TestProxyToVNC_CopiesClientBytesToVNCServer(t *testing.T) {
	vncAddr, accepted := fakeVNCServer(t)

	viewerURL, stop, err := Serve(vncAddr)
	if err != nil {
		t.Fatalf("Serve: %v", err)
	}
	defer stop()

	ws := dialWebsockify(t, viewerURL)

	// RFB's first client message is a version handshake; any byte string
	// exercises the same copy direction.
	want := []byte("RFB 003.008\n")
	if _, err := ws.Write(want); err != nil {
		t.Fatalf("ws write: %v", err)
	}

	var conn net.Conn
	select {
	case conn = <-accepted:
		if conn == nil {
			t.Fatal("VNC listener closed without accepting a connection")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("proxyToVNC never dialled the VNC server")
	}
	defer conn.Close()

	got := make([]byte, len(want))
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := io.ReadFull(conn, got); err != nil {
		t.Fatalf("read from VNC side: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Errorf("VNC server received %q, want %q", got, want)
	}
}

func TestProxyToVNC_CopiesVNCServerBytesToClient(t *testing.T) {
	vncAddr, accepted := fakeVNCServer(t)

	viewerURL, stop, err := Serve(vncAddr)
	if err != nil {
		t.Fatalf("Serve: %v", err)
	}
	defer stop()

	ws := dialWebsockify(t, viewerURL)

	// The dial is lazy: nothing connects to the VNC server until the
	// handler runs, so nudge the proxy into existence first.
	if _, err := ws.Write([]byte("hello")); err != nil {
		t.Fatalf("ws write: %v", err)
	}

	var conn net.Conn
	select {
	case conn = <-accepted:
		if conn == nil {
			t.Fatal("VNC listener closed without accepting a connection")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("proxyToVNC never dialled the VNC server")
	}
	defer conn.Close()

	// The server-to-client direction carries the framebuffer, which is
	// binary and must survive unmodified — including bytes that are not
	// valid UTF-8, which a text WebSocket frame would mangle.
	want := []byte{0x00, 0xff, 0x10, 0x80, 0xfe, 0x01}
	if _, err := conn.Write(want); err != nil {
		t.Fatalf("write from VNC side: %v", err)
	}

	got := make([]byte, len(want))
	ws.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := io.ReadFull(ws, got); err != nil {
		t.Fatalf("ws read: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Errorf("client received %x, want %x", got, want)
	}
}

func TestProxyToVNC_ClosesClientWhenVNCServerHangsUp(t *testing.T) {
	vncAddr, accepted := fakeVNCServer(t)

	viewerURL, stop, err := Serve(vncAddr)
	if err != nil {
		t.Fatalf("Serve: %v", err)
	}
	defer stop()

	ws := dialWebsockify(t, viewerURL)
	if _, err := ws.Write([]byte("hello")); err != nil {
		t.Fatalf("ws write: %v", err)
	}

	var conn net.Conn
	select {
	case conn = <-accepted:
		if conn == nil {
			t.Fatal("VNC listener closed without accepting a connection")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("proxyToVNC never dialled the VNC server")
	}

	// A VM that shuts down takes its VNC socket with it. The viewer tab
	// must see the connection end rather than hang on a dead proxy.
	conn.Close()

	ws.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := io.ReadAll(ws); err != nil && err != io.EOF {
		t.Errorf("client read after VNC hangup = %v, want EOF", err)
	}
}

func TestProxyToVNC_ClosesClientWhenVNCUnreachable(t *testing.T) {
	// Bind then release a port so the address is routable but nothing is
	// listening — the same shape as opening the viewer before QEMU's VNC
	// socket is up.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	deadAddr := ln.Addr().String()
	ln.Close()

	viewerURL, stop, err := Serve(deadAddr)
	if err != nil {
		t.Fatalf("Serve: %v", err)
	}
	defer stop()

	ws := dialWebsockify(t, viewerURL)

	// The dial failure must close the WebSocket instead of leaving the
	// browser waiting on a proxy that will never carry anything.
	ws.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := io.ReadAll(ws); err != nil && err != io.EOF {
		t.Errorf("client read against unreachable VNC = %v, want EOF", err)
	}
}
