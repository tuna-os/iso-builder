# Runbook — deploying and rolling back iso.tunaos.org

Covers the two production surfaces of the browser ISO builder and what to do
when a deploy makes either of them worse.

| Surface | Worker name | Source | Serves |
| --- | --- | --- | --- |
| `iso.tunaos.org` | `tunaos-iso-builder` | `app/` (`wrangler.jsonc`, static assets from `app/public/`) | The app itself: `index.html`, `app.js`, `tbox.wasm`, `wasm_exec.js` |
| `relay.tunaos.org` | `ghcr-shim` | `worker/` (`wrangler.toml`, `cors-shim.js`) | The CORS relay for GHCR, Flathub search, repology search and Frostyard DDI artifacts |

Both are deployed by the `deploy` job in `.github/workflows/ci.yml`, which runs
only on a push to `main` and only after the `wasm` and `e2e` jobs pass. Both can
also be deployed by hand with `npx wrangler deploy` from `app/` or `worker/`.

## What the deploy gate does and does not prove

`e2e` runs Playwright against `http://127.0.0.1:8931` — a local static server over
`app/public/` — with the freshly built engine dropped in. It proves the committed
source works when served locally, against the live relay and live GHCR.

It proves nothing about production. Nothing in CI has ever fetched
`https://iso.tunaos.org/`. A `wrangler deploy` that exits 0 means the Cloudflare
API accepted an upload; it does not mean the custom domain resolves, that the
route is attached to the new version, or that the asset the browser downloads is
the one CI built.

The relay is also a hard dependency of every build: if `relay.tunaos.org` stops
answering, the app loads fine and then fails at the first layer pull. Treat a
healthy-looking `iso.tunaos.org` as insufficient evidence on its own.

## Detect

User-visible symptoms, in the order they are usually reported:

- The page loads but "Inspect" or "Build" fails immediately — usually the relay,
  not the app.
- The page does not load at all, or loads without the engine — the app deploy.
- Builds fail partway through a layer pull — usually upstream (GHCR) or the
  engine, not a deploy. Check `/healthz` before assuming a deploy caused it.

Checks, from cheapest to most expensive:

```sh
# 1. App is served and references the engine.
curl -sS -o /tmp/idx -w '%{http_code}\n' https://iso.tunaos.org/
grep -c tbox.wasm /tmp/idx                    # expect >= 1

# 2. The engine the browser would download.
curl -sSI https://iso.tunaos.org/tbox.wasm | grep -i '^content-length'

# 3. Relay readiness — checks ghcr.io token issuance, not just the Worker.
curl -sS https://relay.tunaos.org/healthz     # expect HTTP 200, {"status":"ok"}

# 4. The exact first call the engine makes.
curl -sS -o /dev/null -w '%{http_code}\n' \
  'https://relay.tunaos.org/token?scope=repository:tuna-os/flounder:pull'  # expect 200
```

`/healthz` returns 503 with `{"status":"degraded", …}` when the upstream token
endpoint is unreachable or answers non-200. It checks reachability and token
issuance only — it deliberately does not pull a manifest, so it stays green when
a single image tag is retired (that failure mode belongs to
`scripts/verify-catalog.py`, which the `catalog` job runs weekly).

## Verify a deploy

Run the four checks above immediately after the `deploy` job goes green, and
compare check 2 against the size of the artifact that run built (the `wasm` job's
`report` step prints `ls -l app/public/tbox.wasm`). A mismatch means users are
downloading a different engine than CI tested — that is a rollback, not a
"wait and see".

## Roll back

Both surfaces are plain Workers, so both roll back the same way. Use the Worker
name, not the hostname.

```sh
# What is live now, and what was live before.
npx wrangler deployments list --name ghcr-shim
npx wrangler versions list    --name ghcr-shim

# Roll back to the previous version (omit the id) or to a named one.
npx wrangler rollback --name ghcr-shim --message "relay 5xx after <sha>"
npx wrangler rollback <VERSION_ID> --name ghcr-shim --message "…"
```

Substitute `--name tunaos-iso-builder` for the app. A rollback creates a new
deployment of the older version and takes effect on every route and custom domain
of that Worker immediately; there is no partial or per-route rollback here.
Static assets are part of the app Worker's version, so rolling the app back rolls
`tbox.wasm` back with it.

If Cloudflare credentials are not to hand, the git-side path is to re-run the
`deploy` job of the last known-good CI run on `main` (Actions → that run → Re-run
jobs). That checks out the same commit and rebuilds the engine from the tacklebox
version pinned at that commit, so it reproduces the same artifact rather than
whatever `main` now points at. It is slower than `wrangler rollback` — prefer the
rollback when the outage is user-visible, and use the re-run to get `main` and
production back into agreement afterwards.

Do not roll forward with a fix commit while users are broken. The deploy job only
fires on a push to `main`, so a roll-forward carries the full `wasm` + `e2e` wait
(~30 min on a healthy runner) before it reaches production.

## After the rollback

- Production and `main` now disagree. Either revert the offending commit on
  `main` or land the fix, then let the normal `deploy` job restore agreement, and
  re-run the verification checks above.
- Record what the four checks returned during the incident. There is no external
  uptime monitoring on either hostname, so those curl outputs are the only
  evidence that will exist afterwards.

## Known gaps

- No post-deploy verification runs automatically. Until CI performs the checks
  above, the first detector of a bad deploy is a user.
- No external monitoring polls `/healthz`, so relay downtime between deploys is
  detected only by the weekly scheduled CI run (Mondays, 05:40 UTC) — and that
  run exercises the relay through a local copy of the app, so it would not catch
  a broken `iso.tunaos.org` at all.
- The `deploy` job deploys the app before the relay. If the relay step fails,
  production is left with a new app and an older relay — the ordering that breaks
  a change requiring both (for example a new org in the relay's allowlist).
