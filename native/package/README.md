# Packaging

`just build-linux` / `just build-macos-app` / `just build-windows` (see `../justfile`)
produce real, runnable artifacts for each platform. None of them are signed yet —
that's the honest state, not an oversight to paper over.

## What's missing, and why it's not done here

- **macOS**: code signing + notarization need a real Apple Developer Program
  membership (paid, tied to an identity this project doesn't have yet). Without
  it, Gatekeeper blocks the unsigned `.app` on first launch. Workaround for now:
  right-click the app → Open → confirm the dialog. That's a real, if clunky,
  path for early testers — not something to build around with a `curl | sh`
  installer that trains people to bypass Gatekeeper generally.
- **Windows**: code signing needs a certificate (either a paid EV cert for
  instant SmartScreen trust, or a standard cert that still triggers a
  "Windows protected your PC" warning until enough install telemetry
  accumulates). Workaround for now: "More info" → "Run anyway" on the
  SmartScreen prompt.
- **Linux**: no signing convention to speak of for a plain binary; not blocked
  on anything, just needs `tacklebox` reachable (see `../README.md`).

## When this should get revisited

Once there's a real distribution channel (a GitHub release, a download page on
iso.tunaos.org) is the right time to get proper certificates — signing a build
nobody can download yet doesn't buy anything. Track that decision as its own
piece of work rather than blocking everything else on it now.
