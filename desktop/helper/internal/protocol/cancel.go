package protocol

import (
	"context"
	"os"
	"os/signal"
	"syscall"
	"time"
)

// CancelPollInterval is how often --cancel-file is checked.
const CancelPollInterval = time.Second

// CancelContext returns a context cancelled on SIGINT/SIGTERM (Go delivers
// Windows CTRL_C and CTRL_BREAK as os.Interrupt) or when cancelFile starts to
// exist. stop releases the signal handler and the poller.
func CancelContext(parent context.Context, cancelFile string) (ctx context.Context, stop func()) {
	ctx, cancel := signal.NotifyContext(parent, os.Interrupt, syscall.SIGTERM)
	if cancelFile == "" {
		return ctx, cancel
	}
	if _, err := os.Stat(cancelFile); err == nil {
		cancel() // already requested before we started
		return ctx, cancel
	}
	done := make(chan struct{})
	go func() {
		t := time.NewTicker(CancelPollInterval)
		defer t.Stop()
		for {
			if _, err := os.Stat(cancelFile); err == nil {
				cancel()
				return
			}
			select {
			case <-ctx.Done():
				return
			case <-done:
				return
			case <-t.C:
			}
		}
	}()
	return ctx, func() { close(done); cancel() }
}
