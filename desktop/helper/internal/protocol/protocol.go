// Package protocol implements the tunaos-media-helper JSON Lines event stream
// described in desktop/PROTOCOL.md: one JSON object per line on stdout or an
// --events file, typed errors with protocol kinds, and exit codes.
package protocol

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
)

// Version is the protocol version reported by `version`.
const Version = 1

// Exit codes (PROTOCOL.md "Transport").
const (
	ExitOK        = 0
	ExitFailure   = 1
	ExitUsage     = 2
	ExitCancelled = 130
)

// Kind is the `kind` of an error event.
type Kind string

const (
	KindNetwork        Kind = "network"
	KindStorage        Kind = "storage"
	KindPermission     Kind = "permission"
	KindDeviceChanged  Kind = "device-changed"
	KindVerifyMismatch Kind = "verify-mismatch"
	KindEngine         Kind = "engine"
	KindCancelled      Kind = "cancelled"
	KindUsage          Kind = "usage"
)

// Phases of a progress event.
const (
	PhaseDownload = "download"
	PhaseUnpack   = "unpack"
	PhaseOverlay  = "overlay"
	PhaseErofs    = "erofs"
	PhaseEsp      = "esp"
	PhaseIso      = "iso"
	PhaseWrite    = "write"
	PhaseVerify   = "verify"
)

// Units of a progress event.
const (
	UnitBytes  = "bytes"
	UnitLayers = "layers"
	UnitSteps  = "steps"
)

// Error is a failure carrying its protocol kind. Message is the one-sentence,
// jargon-free text the GUI shows; Err keeps the technical cause for stderr.
type Error struct {
	Kind    Kind
	Message string
	Err     error
	// Extra fields merged into the error event (e.g. requiredBytes).
	Extra map[string]any
}

func (e *Error) Error() string {
	if e.Err != nil {
		return e.Message + ": " + e.Err.Error()
	}
	return e.Message
}

func (e *Error) Unwrap() error { return e.Err }

// Errorf builds an *Error with a formatted message and no cause.
func Errorf(kind Kind, format string, args ...any) *Error {
	return &Error{Kind: kind, Message: fmt.Sprintf(format, args...)}
}

// Wrap attaches a protocol kind and user-facing message to a cause.
func Wrap(kind Kind, err error, message string) *Error {
	return &Error{Kind: kind, Message: message, Err: err}
}

// Cancelled is the error every subcommand returns when its context ends.
var Cancelled = &Error{Kind: KindCancelled, Message: "Cancelled."}

// Classify maps any error to its protocol kind and user-facing message.
func Classify(err error) (Kind, string) {
	var pe *Error
	if errors.As(err, &pe) {
		return pe.Kind, pe.Message
	}
	if errors.Is(err, context.Canceled) {
		return KindCancelled, Cancelled.Message
	}
	return KindEngine, "Something went wrong. Show details for more information."
}

// ExitCode maps an error to the process exit code.
func ExitCode(err error) int {
	if err == nil {
		return ExitOK
	}
	switch kind, _ := Classify(err); kind {
	case KindCancelled:
		return ExitCancelled
	case KindUsage:
		return ExitUsage
	default:
		return ExitFailure
	}
}

// Emitter writes events, one JSON object per line. Safe for concurrent use:
// each event is a single Write so appends to a shared --events file never
// interleave.
type Emitter struct {
	mu     sync.Mutex
	w      io.Writer
	closer io.Closer
}

// NewEmitter writes events to w.
func NewEmitter(w io.Writer) *Emitter { return &Emitter{w: w} }

// OpenEmitter writes to eventsPath (append, created 0644 so a non-elevated GUI
// can read what an elevated helper wrote) or to stdout when eventsPath is "".
func OpenEmitter(eventsPath string, stdout io.Writer) (*Emitter, error) {
	if eventsPath == "" {
		return NewEmitter(stdout), nil
	}
	f, err := os.OpenFile(eventsPath, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o644)
	if err != nil {
		return nil, err
	}
	return &Emitter{w: f, closer: f}, nil
}

// Close closes an --events file.
func (e *Emitter) Close() error {
	if e.closer != nil {
		return e.closer.Close()
	}
	return nil
}

// Emit writes one event. v must marshal to a JSON object with an "event" key.
func (e *Emitter) Emit(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		// Only programming errors reach here; never drop silently.
		b, _ = json.Marshal(LogEvent{Event: "log", Level: "warn", Message: "internal: unencodable event: " + err.Error()})
	}
	e.write(b)
}

func (e *Emitter) write(b []byte) {
	b = append(b, '\n')
	e.mu.Lock()
	defer e.mu.Unlock()
	_, _ = e.w.Write(b)
}

// ProgressEvent is {"event":"progress",...}.
type ProgressEvent struct {
	Event   string `json:"event"`
	Phase   string `json:"phase"`
	Current int64  `json:"current"`
	Total   int64  `json:"total"`
	Unit    string `json:"unit"`
	Message string `json:"message"`
}

// LogEvent is {"event":"log",...}.
type LogEvent struct {
	Event   string `json:"event"`
	Level   string `json:"level"`
	Message string `json:"message"`
}

// Progress emits a progress event. total is 0 when unknown.
func (e *Emitter) Progress(phase, unit string, current, total int64, message string) {
	e.Emit(ProgressEvent{Event: "progress", Phase: phase, Current: current, Total: total, Unit: unit, Message: message})
}

// Info emits a log event at level info.
func (e *Emitter) Info(format string, args ...any) {
	e.Emit(LogEvent{Event: "log", Level: "info", Message: fmt.Sprintf(format, args...)})
}

// Warn emits a log event at level warn.
func (e *Emitter) Warn(format string, args ...any) {
	e.Emit(LogEvent{Event: "log", Level: "warn", Message: fmt.Sprintf(format, args...)})
}

// Error emits the error event for err. An *Error's Extra fields (which must
// not reuse the keys event/kind/message) follow the three protocol keys.
func (e *Emitter) Error(err error) {
	kind, msg := Classify(err)
	b, _ := json.Marshal(struct {
		Event   string `json:"event"`
		Kind    string `json:"kind"`
		Message string `json:"message"`
	}{"error", string(kind), msg})
	var pe *Error
	if errors.As(err, &pe) && len(pe.Extra) > 0 {
		if xb, xerr := json.Marshal(pe.Extra); xerr == nil {
			b = append(append(b[:len(b)-1], ','), xb[1:]...)
		}
	}
	e.write(b)
}
