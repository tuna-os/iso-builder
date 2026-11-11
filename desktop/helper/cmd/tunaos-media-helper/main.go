// Command tunaos-media-helper is the TunaOS Media Writer's backend: the
// macOS, Windows and Linux GUIs spawn it and read JSON Lines events. See
// desktop/PROTOCOL.md for the contract.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"runtime/debug"
	"strings"

	"github.com/tuna-os/iso-builder/desktop/helper/internal/buildreq"
	"github.com/tuna-os/iso-builder/desktop/helper/internal/catalog"
	"github.com/tuna-os/iso-builder/desktop/helper/internal/drives"
	"github.com/tuna-os/iso-builder/desktop/helper/internal/engine"
	"github.com/tuna-os/iso-builder/desktop/helper/internal/protocol"
	"github.com/tuna-os/iso-builder/desktop/helper/internal/writer"
)

// version is the helper's semver; release builds set it with
// -ldflags "-X main.version=1.2.3".
var version = "0.1.0"

const tackleboxModule = "github.com/tuna-os/tacklebox"

const usage = `usage: tunaos-media-helper <command> [flags]

commands:
  version
  catalog [--base-url URL]
  build (--target ID | --request FILE) --out PATH [--workdir DIR] [--flatpaks default|none|id,id] [--base-url URL]
  drives [--exclude PATH]
  write --iso PATH --device ID [--fd N] [--no-verify]

every command: [--events PATH] [--cancel-file PATH]
`

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

// engineVersion is the tacklebox module version linked into this binary,
// which is the version the shipped engine is built from (same go.mod pin).
func engineVersion() string {
	if bi, ok := debug.ReadBuildInfo(); ok {
		for _, d := range bi.Deps {
			if d.Path == tackleboxModule {
				if d.Replace != nil {
					return d.Replace.Version
				}
				return d.Version
			}
		}
	}
	return "unknown"
}

func run(args []string, stdout, stderr io.Writer) int {
	usageErr := func(format string, a ...any) int {
		fmt.Fprint(stderr, usage)
		protocol.NewEmitter(stdout).Error(protocol.Errorf(protocol.KindUsage, format, a...))
		return protocol.ExitUsage
	}
	if len(args) == 0 {
		return usageErr("No command given.")
	}
	name := args[0]
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(stderr)
	events := fs.String("events", "", "append events to this file instead of stdout")
	cancelFile := fs.String("cancel-file", "", "cancel when this file appears (polled every second)")

	var cmd func(ctx context.Context, em *protocol.Emitter) error
	switch name {
	case "version":
		cmd = func(_ context.Context, em *protocol.Emitter) error {
			em.Emit(struct {
				Event    string `json:"event"`
				Helper   string `json:"helper"`
				Engine   string `json:"engine"`
				Protocol int    `json:"protocol"`
			}{"version", version, engineVersion(), protocol.Version})
			return nil
		}
	case "catalog":
		baseURL := fs.String("base-url", catalog.DefaultBaseURL, "where catalog-snapshot.json, builder-config.json and guided-catalog.json are served")
		cmd = func(ctx context.Context, em *protocol.Emitter) error {
			c, err := catalog.Load(ctx, *baseURL, em.Warn)
			if err != nil {
				return protocol.Wrap(protocol.KindNetwork, err, "Could not load the list of images.")
			}
			em.Emit(c.Model())
			return nil
		}
	case "build":
		target := fs.String("target", "", "catalog target ID, e.g. yellowfin:gnome:linux/amd64")
		request := fs.String("request", "", "build-request.json exported from iso.tunaos.org")
		out := fs.String("out", "", "where to save the ISO")
		workdir := fs.String("workdir", "", "parent directory for temporary files (default: the user cache directory)")
		flatpaks := fs.String("flatpaks", "default", "default | none | comma-separated Flatpak IDs")
		baseURL := fs.String("base-url", catalog.DefaultBaseURL, "catalog location")
		cmd = func(ctx context.Context, em *protocol.Emitter) error {
			if (*target == "") == (*request == "") || *out == "" {
				return protocol.Errorf(protocol.KindUsage, "build needs exactly one of --target or --request, and --out.")
			}
			return build(ctx, em, stderr, *target, *request, *out, *workdir, *flatpaks, *baseURL)
		}
	case "drives":
		exclude := fs.String("exclude", "", "never list the disk holding this path (the ISO)")
		cmd = func(_ context.Context, em *protocol.Emitter) error {
			list, err := drives.List(*exclude)
			if err != nil {
				return err
			}
			em.Emit(drives.Event{Event: "drives", Drives: list})
			return nil
		}
	case "write":
		iso := fs.String("iso", "", "ISO file to write")
		device := fs.String("device", "", "drive id from `drives`")
		fd := fs.Int("fd", -1, "inherited writable+readable descriptor for the device (Linux)")
		noVerify := fs.Bool("no-verify", false, "skip the read-back check")
		cmd = func(ctx context.Context, em *protocol.Emitter) error {
			if *iso == "" || *device == "" {
				return protocol.Errorf(protocol.KindUsage, "write needs --iso and --device.")
			}
			d, err := drives.Resolve(*device, *fd >= 0)
			if err != nil {
				return err
			}
			fmt.Fprintf(stderr, "writing %s to %s (%s, %d bytes)\n", *iso, d.Path, d.Name, d.SizeBytes)
			res, err := writer.Run(ctx, writer.Options{ISO: *iso, Device: d, FD: *fd, Verify: !*noVerify, Emitter: em})
			if err != nil {
				return err
			}
			em.Emit(res)
			return nil
		}
	case "-h", "--help", "help":
		fmt.Fprint(stdout, usage)
		return protocol.ExitOK
	default:
		return usageErr("Unknown command %q.", name)
	}

	if err := fs.Parse(args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return protocol.ExitOK
		}
		return usageErr("%v", err)
	}
	if fs.NArg() != 0 {
		return usageErr("Unexpected argument %q.", fs.Arg(0))
	}
	em, err := protocol.OpenEmitter(*events, stdout)
	if err != nil {
		fmt.Fprintln(stderr, "error:", err)
		protocol.NewEmitter(stdout).Error(protocol.Wrap(protocol.KindPermission, err, "Could not open the events file."))
		return protocol.ExitFailure
	}
	defer em.Close()
	ctx, stop := protocol.CancelContext(context.Background(), *cancelFile)
	defer stop()
	err = cmd(ctx, em)
	if err != nil && ctx.Err() != nil { // cancellation explains whatever else failed
		err = protocol.Cancelled
	}
	if err != nil {
		fmt.Fprintln(stderr, "error:", err)
		em.Error(err)
	}
	return protocol.ExitCode(err)
}

func build(ctx context.Context, em *protocol.Emitter, stderr io.Writer, target, request, out, workdir, flatpaks, baseURL string) error {
	enginePath, err := engine.Locate()
	if err != nil {
		return err
	}
	var doc []byte
	var compressed int64
	if target != "" {
		c, err := catalog.Load(ctx, baseURL, em.Warn)
		if err != nil {
			return protocol.Wrap(protocol.KindNetwork, err, "Could not load the list of images.")
		}
		t, ok := c.Lookup(target)
		if !ok {
			return protocol.Errorf(protocol.KindUsage, "%s is not an available image.", target)
		}
		ids, err := buildreq.FlatpakChoice(c, t.Desktop, flatpaks)
		if err != nil {
			return protocol.Wrap(protocol.KindUsage, err, "The app list is not valid.")
		}
		req, _, err := buildreq.FromTarget(c, target, ids)
		if err != nil {
			return protocol.Wrap(protocol.KindUsage, err, "This image cannot be built.")
		}
		if doc, err = json.Marshal(req); err != nil {
			return err
		}
		compressed = t.CompressedSize
	} else {
		raw, r, err := buildreq.LoadFile(request)
		if err != nil {
			return protocol.Wrap(protocol.KindUsage, err, "The build request file could not be read.")
		}
		doc = raw
		if flatpaks != "default" {
			ids, err := buildreq.FlatpakChoice(nil, "", flatpaks)
			if err != nil {
				return protocol.Wrap(protocol.KindUsage, err, "The app list is not valid.")
			}
			if doc, err = buildreq.SetFlatpaks(doc, ids); err != nil {
				return err
			}
		}
		// Size the disk check from the catalog when it knows this image.
		if c, err := catalog.Load(ctx, baseURL, func(string, ...any) {}); err == nil && r.Target != nil {
			key := r.Target.Variant + ":" + r.Target.Flavor + ":" + r.Target.Platform
			if e, ok := c.Entry(key); ok && strings.TrimPrefix(e.Publication.Ref, "ghcr.io/") == strings.TrimPrefix(r.Image, "ghcr.io/") {
				compressed = e.Facts.CompressedSize
			}
		}
	}
	native, err := buildreq.Native(doc)
	if err != nil {
		return err
	}
	fmt.Fprintf(stderr, "engine %s (tacklebox %s)\nrequest:\n%s\n", enginePath, engineVersion(), native)
	res, err := engine.Build(ctx, engine.Options{
		Engine: enginePath, Request: native, Out: out, WorkParent: workdir,
		CompressedSize: compressed, Emitter: em, Stderr: stderr,
	})
	if err != nil {
		return err
	}
	em.Emit(struct {
		Event string `json:"event"`
		engine.Result
	}{"done", res})
	return nil
}
