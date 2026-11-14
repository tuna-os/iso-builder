module github.com/tuna-os/iso-builder/desktop/helper

go 1.26.3

// The tacklebox pin MUST equal native/go.mod's (TestTackleboxPinMatchesNative).
// The engine shipped beside the helper is built from this exact pin by
// `go run ./cmd/build-engine` (see desktop/README.md).
require (
	github.com/tuna-os/tacklebox v0.1.0
	golang.org/x/sys v0.50.0
	howett.net/plist v1.0.1
)
