// Stateless CORS shim for ghcr.io — the only server-side piece of the
// browser ISO builder (ADR 0002). ghcr.io sends no Access-Control-Allow-Origin
// headers, so browser JS cannot read its responses; this Worker relays the
// three read-only endpoints the puller needs and adds the header. It stores
// nothing, publishes nothing, and needs no updates when images change.
//
// Deploy: wrangler deploy (route e.g. ghcr-shim.tunaos.org/*).
//
//   GET /healthz   readiness — 200 only when ghcr.io answers
//   GET /token?scope=repository:<org>/<image>:pull
//   GET /v2/<org>/<image>/manifests/<ref>
//   GET /v2/<org>/<image>/blobs/sha256:<digest>

const UPSTREAM = "https://ghcr.io";
// Only public images in these orgs — the shim must never become a general
// relay, so this stays a short hand-curated list, not a pattern. tuna-os is
// the product; projectbluefin and ublue-os host the known-good reference
// images (dakota:stable, aurora:stable) that CI builds alongside the TunaOS
// editions, so a red cell distinguishes "our pipeline broke" from "our
// still-stabilising images broke" (ci.yml full-matrix).
const ORGS = ["tuna-os", "projectbluefin", "ublue-os"];

const PATH_ALLOW = new RegExp(
  `^/(token$|v2/?$|v2/(?:${ORGS.join("|")})/[a-z0-9._-]+/(manifests|blobs)/[A-Za-z0-9._:@-]+$)`
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Accept, Range",
  "Access-Control-Expose-Headers":
    "Content-Length, Content-Type, Docker-Content-Digest, WWW-Authenticate, Content-Range, Accept-Ranges",
  "Access-Control-Max-Age": "86400",
};

// ── logging ────────────────────────────────────────────────────────────────
//
// Workers Logs (`[observability]` in wrangler.toml) already records one
// invocation entry per request with method, response status and wall-clock
// duration, so nothing here logs a successful relay: an ISO build pulls ~65
// blobs, and re-stating the platform's own record 65 times per build is
// volume, not signal. What the platform cannot see is *why* a request failed
// — which of the five upstreams answered, with what status, and on which
// relay path. That is all this emits.
//
// Every field is bounded on purpose. `route` is a fixed label rather than the
// request path, because paths carry image names and blob digests; the
// repology and Flathub query strings are user input and are never logged;
// neither is the Authorization header. Nothing leaves the account — these are
// the Worker's own logs, not an exporter.
//
// Limit worth knowing before trusting these numbers: `fetch` resolves when the
// upstream's *headers* arrive and the body is relayed as a stream, so a
// duration recorded here is time-to-headers. A body that stalls mid-transfer
// produces a normal-looking log line.
function logEvent(level, route, fields) {
  const line = JSON.stringify({ level, route, ...fields });
  if (level === "error") console.error(line);
  else console.warn(line);
}

// Upstream failures used to surface as a Cloudflare 1101 ("Worker threw
// exception"): no CORS headers, no body, and nothing in the response telling
// the browser console which upstream died. This gives the client a readable
// status it can distinguish from a 403 or an upstream 5xx.
function relayError(message) {
  return new Response(JSON.stringify({ error: message }) + "\n", {
    status: 502,
    headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    // Readiness probe (runbooks/deploy-and-rollback.md).
    //
    // Deliberately not a static 200. This Worker exists to reach ghcr.io, and
    // /token is the first call the engine makes — every manifest and blob
    // fetch after it carries the bearer token that call returns. A probe that
    // answered without touching the upstream would report healthy while every
    // build in the browser died at layer 0.
    //
    // The scope names a repo in the allowlist, and GHCR issues an anonymous
    // pull token for public repos, so a 200 proves reachability and token
    // issuance without tying relay health to any one image still existing
    // (that failure mode belongs to scripts/verify-catalog.py). The upstream
    // call is edge-cached for 30s so this endpoint cannot be used to hammer
    // ghcr.io, and bounded at 5s so a hung upstream reports degraded rather
    // than hanging the prober.
    if (url.pathname === "/healthz") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("method not allowed", { status: 405, headers: CORS });
      }
      const started = Date.now();
      let status = 0;
      let error = null;
      try {
        const probe = await fetch(
          `${UPSTREAM}/token?scope=repository:${ORGS[0]}/flounder:pull`,
          {
            signal: AbortSignal.timeout(5000),
            cf: { cacheEverything: true, cacheTtl: 30 },
          }
        );
        status = probe.status;
      } catch (e) {
        error = String(e);
      }
      const ok = status === 200;
      const latencyMs = Date.now() - started;
      // A degraded probe is the one signal in this Worker that means every
      // in-flight browser build is about to fail at layer 0. Nothing polls
      // this endpoint on a schedule (runbooks/deploy-and-rollback.md, "Known
      // gaps"), so without a log line a 503 is only ever seen by whoever
      // happened to curl it.
      if (!ok) {
        logEvent("error", "healthz", { upstream_status: status, error, latency_ms: latencyMs });
      }
      const body = {
        status: ok ? "ok" : "degraded",
        upstream: { url: `${UPSTREAM}/token`, status, error },
        latency_ms: latencyMs,
      };
      return new Response(JSON.stringify(body, null, 2) + "\n", {
        status: ok ? 200 : 503,
        headers: {
          ...CORS,
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      });
    }

    // Flathub search relay: flathub.org's API only answers CORS for its
    // own origins, so the builder's Flathub autocomplete goes through
    // here. POST, tiny JSON bodies, generously cacheable per query.
    if (url.pathname === "/flathub/search") {
      if (request.method !== "POST") {
        return new Response("method not allowed", { status: 405, headers: CORS });
      }
      const body = await request.text();
      if (body.length > 2048) {
        return new Response("query too large", { status: 413, headers: CORS });
      }
      let resp;
      try {
        resp = await fetch("https://flathub.org/api/v2/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
      } catch (e) {
        logEvent("error", "flathub", { error: String(e) });
        return relayError("flathub search upstream unreachable");
      }
      // The upstream body is still relayed verbatim on a non-2xx — the log
      // exists so a Flathub outage is distinguishable from an empty result
      // set, which is what the picker shows for both.
      if (!resp.ok) {
        logEvent("warn", "flathub", { upstream_status: resp.status });
      }
      const out = new Response(resp.body, { status: resp.status, headers: CORS });
      out.headers.set("Content-Type", "application/json");
      return out;
    }

    // Cross-distro package search relay: repology maps a package across
    // every distro family (dnf/zypper/pacman/apt/...), so one search box
    // works for any base image. No CORS on repology → proxy it here.
    // ?q=<term>&family=<fedora|opensuse|arch|debian|...>
    if (url.pathname === "/pkgsearch") {
      const q = (url.searchParams.get("q") || "").toLowerCase().replace(/[^a-z0-9._+-]/g, "");
      const family = url.searchParams.get("family") || "";
      if (q.length < 2) {
        return new Response(JSON.stringify([]), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
      }
      const UA = { "User-Agent": "tunaos-iso-builder (+https://iso.tunaos.org)", "Accept": "application/json" };
      let projects = {};
      // `upstreamFailed` separates "repology said there is no such package"
      // from "repology did not answer". Both used to produce an empty array
      // and a 200, so a repology outage was indistinguishable from a typo in
      // the search box — for the user and for anyone reading the logs.
      let upstreamFailed = false;
      try {
        const rr = await fetch(`https://repology.org/api/v1/projects/?search=${encodeURIComponent(q)}`, { headers: UA });
        if (rr.ok) {
          projects = await rr.json();
        } else {
          upstreamFailed = true;
          logEvent("warn", "pkgsearch", { upstream: "repology_projects", upstream_status: rr.status });
        }
      } catch (e) {
        upstreamFailed = true;
        projects = {};
        logEvent("error", "pkgsearch", { upstream: "repology_projects", error: String(e) });
      }
      // The exact-name project is often buried under plugins in search;
      // fetch it directly so the base package always surfaces first.
      try {
        const er = await fetch(`https://repology.org/api/v1/project/${encodeURIComponent(q)}`, { headers: UA });
        if (er.ok) {
          const ee = await er.json();
          if (Array.isArray(ee) && ee.length) projects = { [q]: ee, ...projects };
        } else if (er.status !== 404) {
          // A 404 is the normal answer for "no project by that exact name"
          // and is the reason this lookup is best-effort — only anything
          // else is worth a line.
          logEvent("warn", "pkgsearch", { upstream: "repology_project", upstream_status: er.status });
        }
      } catch (e) {
        logEvent("error", "pkgsearch", { upstream: "repology_project", error: String(e) });
      }
      // repology repo prefixes per family (best-effort match).
      const prefixes = {
        fedora: ["fedora"], opensuse: ["opensuse"], arch: ["arch"],
        debian: ["debian", "ubuntu"], gentoo: ["gentoo"], alpine: ["alpine"],
      }[family] || [];
      let out = [];
      for (const [name, entries] of Object.entries(projects || {})) {
        let pick = null;
        for (const e of entries) {
          if (prefixes.some((p) => (e.repo || "").startsWith(p))) { pick = e; break; }
        }
        const any = pick || entries[0];
        if (!any) continue;
        out.push({
          project: name,
          pkg: (pick && (pick.binname || pick.srcname || pick.visiblename)) || name,
          summary: any.summary || "",
          available: !!pick,
          version: any.version || "",
        });
      }
      // Rank: available-in-this-family first, then exact/prefix name match,
      // then shorter names (the base package over its plugins).
      out.sort((a, b) => {
        if (a.available !== b.available) return a.available ? -1 : 1;
        const ax = a.project === q ? 0 : a.project.startsWith(q) ? 1 : 2;
        const bx = b.project === q ? 0 : b.project.startsWith(q) ? 1 : 2;
        if (ax !== bx) return ax - bx;
        return a.project.length - b.project.length;
      });
      out = out.slice(0, 12);
      // Don't cache an outage. `max-age=600` on an empty array produced only
      // because repology was down pins that emptiness at the edge for ten
      // minutes, so the search box keeps returning nothing for the term long
      // after repology recovers.
      const degraded = upstreamFailed && out.length === 0;
      if (degraded) {
        // `family` is an unvalidated query param, so it is collapsed to the
        // six keys the prefix table knows plus "other" — a raw echo would let
        // a caller mint an unbounded number of distinct log labels.
        logEvent("warn", "pkgsearch", {
          result: "empty_after_upstream_failure",
          family: prefixes.length ? family : "other",
        });
      }
      const o = new Response(JSON.stringify(out), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
      o.headers.set("Cache-Control", degraded ? "no-store" : "public, max-age=600");
      return o;
    }

    // DDI artifact relay (tacklebox#172): the Frostyard sysupdate
    // repository serves no CORS headers (verified: plain 200, no
    // Access-Control-*), so the browser DDI build path goes through
    // here. Channels are a short hand-curated list, same posture as the
    // GHCR org allowlist — never a general relay. Filenames are a single
    // path segment; versioned artifacts are immutable and edge-cached,
    // the SHA256SUMS index is not (it moves on every publish).
    {
      const m = url.pathname.match(/^\/ddi\/(snowfield|snow|cayo)\/([A-Za-z0-9._+-]+)$/);
      if (m) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return new Response("method not allowed", { status: 405, headers: CORS });
        }
        const upstream = `https://repository.frostyard.org/os/native/v1/${m[1]}/x86-64/${m[2]}`;
        const cacheable = m[2] !== "SHA256SUMS";
        let resp;
        // Only the channel is logged. The filename is a version string and
        // would be a new label per published artifact.
        try {
          resp = await fetch(upstream, {
            method: request.method,
            redirect: "follow",
            cf: cacheable ? { cacheEverything: true, cacheTtl: 604800 } : undefined,
          });
        } catch (e) {
          logEvent("error", "ddi", { channel: m[1], error: String(e) });
          return relayError("ddi upstream unreachable");
        }
        if (!resp.ok) {
          logEvent("warn", "ddi", { channel: m[1], upstream_status: resp.status });
        }
        const out = new Headers(resp.headers);
        for (const [k, v] of Object.entries(CORS)) out.set(k, v);
        return new Response(resp.body, { status: resp.status, headers: out });
      }
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed", { status: 405, headers: CORS });
    }
    if (!PATH_ALLOW.test(url.pathname)) {
      // The rejected path itself is caller-controlled and deliberately not
      // logged; the count is the signal. A sustained rate here means either
      // an org the allowlist should have (a real deploy bug — see the
      // "Known gaps" note about the app deploying ahead of the relay) or
      // someone probing the relay for general-purpose proxying.
      logEvent("warn", "denied", { method: request.method });
      return new Response("path not allowed", { status: 403, headers: CORS });
    }

    const upstream = new URL(url.pathname + url.search, UPSTREAM);
    const headers = new Headers();
    // Range must be forwarded, or the engine's resume path is structurally
    // impossible: it reopens a stalled blob with `Range: bytes=<offset>-` and
    // requires a 206 back. Dropping the header made ghcr.io answer 200 with
    // the whole blob (measured: `Range: bytes=66587081-66587580` against
    // relay.tunaos.org returned 200 + content-length 73082744, while the same
    // request straight to ghcr.io returned 206 + content-range
    // bytes 66587081-66587580/73082744), so every resume restarted the layer
    // from byte 0 at best.
    for (const h of ["authorization", "accept", "range"]) {
      const v = request.headers.get(h);
      if (v) headers.set(h, v);
    }

    // Blobs are content-addressed and immutable — let Cloudflare's edge cache
    // absorb repeat pulls so ghcr.io isn't hammered.
    //
    // Ranged requests deliberately opt out of that cache: a range and the full
    // blob share a cache key here, and serving a recovery request out of a
    // cache entry the failing request is still filling is not a state worth
    // reasoning about. Resume is a rare path, so going to origin for it costs
    // almost no hit rate and keeps it predictable.
    //
    // This opt-out is NOT the fix for iso-builder#49 (the red gnome cells
    // dying at `reopen: layer download stalled: … no response headers within
    // 60s`). It was originally committed as if it were, on a theory that the
    // reopen queues behind the stalled fill. That theory is REFUTED: a ranged
    // GET issued during an in-flight full fetch of the same blob returned 206
    // in 0.19 s — faster than the same request with no contention at all
    // (0.46 s). The relay is exonerated for #49 by three further measurements
    // — full 74 MB blob in 3.7 s, the same blob throttled to 700 KB/s (slower
    // than the browser) completing at 104 s with no stall, and an identical
    // 104 s straight to ghcr.io. Whatever kills those cells is browser- or
    // wasm-side. Do not re-open this file looking for it.
    const cacheable = url.pathname.includes("/blobs/") && !headers.has("range");

    // Fixed label, not the path: the path carries the org, image and blob
    // digest, and digests are the definition of an unbounded label.
    const route = url.pathname.startsWith("/token")
      ? "token"
      : url.pathname.includes("/blobs/")
        ? "blobs"
        : url.pathname.includes("/manifests/")
          ? "manifests"
          : "v2";
    const ranged = headers.has("range");
    const started = Date.now();

    let resp;
    try {
      resp = await fetch(upstream, {
        method: request.method,
        headers,
        redirect: "follow",
        cf: cacheable ? { cacheEverything: true, cacheTtl: 604800 } : undefined,
      });
    } catch (e) {
      logEvent("error", route, { error: String(e), ranged, cacheable });
      return relayError("ghcr upstream unreachable");
    }

    // A 401 on /token or a 429 from ghcr.io breaks every build in progress
    // and is invisible from this side today — the response is relayed and
    // the Worker's own status stays whatever ghcr.io said. Successful
    // relays are left to the platform's invocation log (see logEvent).
    if (!resp.ok) {
      logEvent("warn", route, {
        upstream_status: resp.status,
        ranged,
        cacheable,
        upstream_headers_ms: Date.now() - started,
      });
    }

    const out = new Headers(resp.headers);
    for (const [k, v] of Object.entries(CORS)) out.set(k, v);
    return new Response(resp.body, { status: resp.status, headers: out });
  },
};
