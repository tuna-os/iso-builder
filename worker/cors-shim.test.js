import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "./cors-shim.js";

function req(url, opts) {
  return new Request(url, opts);
}

test("OPTIONS preflight returns 204 with CORS headers", async () => {
  const res = await worker.fetch(req("https://relay.tunaos.org/v2/tuna-os/foo/manifests/latest", { method: "OPTIONS" }));
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
});

test("unknown path is rejected with 403", async () => {
  const res = await worker.fetch(req("https://relay.tunaos.org/evil"));
  assert.equal(res.status, 403);
  assert.equal(await res.text(), "path not allowed");
});

test("manifest path for an org outside the allowlist is rejected", async () => {
  const res = await worker.fetch(req("https://relay.tunaos.org/v2/evil-org/foo/manifests/latest"));
  assert.equal(res.status, 403);
});

test("token request with a disallowed scope is rejected", async () => {
  const res = await worker.fetch(req("https://relay.tunaos.org/token?scope=repository:evil-org/foo:pull"));
  assert.equal(res.status, 403);
  assert.equal(await res.text(), "scope not allowed");
});

test("token request with an allowed scope forwards only the accept header, never authorization", async (t) => {
  let capturedUrl, capturedHeaders;
  t.mock.method(globalThis, "fetch", async (url, opts) => {
    capturedUrl = url.toString();
    capturedHeaders = opts.headers;
    return new Response("{}", { status: 200 });
  });
  const res = await worker.fetch(
    req("https://relay.tunaos.org/token?scope=repository:tuna-os/foo:pull", {
      headers: { Authorization: "Bearer secret", Accept: "application/json" },
    })
  );
  assert.equal(res.status, 200);
  assert.ok(capturedUrl.startsWith("https://ghcr.io/token"));
  assert.equal(capturedHeaders.get("accept"), "application/json");
  assert.equal(capturedHeaders.has("authorization"), false);
});

test("manifest request forwards authorization and range headers", async (t) => {
  let capturedHeaders;
  t.mock.method(globalThis, "fetch", async (_url, opts) => {
    capturedHeaders = opts.headers;
    return new Response("m", { status: 200 });
  });
  const res = await worker.fetch(
    req("https://relay.tunaos.org/v2/tuna-os/foo/manifests/latest", {
      headers: { Authorization: "Bearer tok", Range: "bytes=0-10" },
    })
  );
  assert.equal(res.status, 200);
  assert.equal(capturedHeaders.get("authorization"), "Bearer tok");
  assert.equal(capturedHeaders.get("range"), "bytes=0-10");
});

test("non-GET/HEAD method on the main relay path is rejected", async () => {
  const res = await worker.fetch(req("https://relay.tunaos.org/v2/tuna-os/foo/manifests/latest", { method: "DELETE" }));
  assert.equal(res.status, 405);
});

test("upstream network failure returns a 502 with a readable body", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("boom");
  });
  const res = await worker.fetch(req("https://relay.tunaos.org/v2/tuna-os/foo/manifests/latest"));
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.match(body.error, /ghcr upstream unreachable/);
});

test("ranged blob request opts out of edge caching", async (t) => {
  let captured;
  t.mock.method(globalThis, "fetch", async (_url, opts) => {
    captured = opts;
    return new Response("x", { status: 206 });
  });
  await worker.fetch(
    req("https://relay.tunaos.org/v2/tuna-os/foo/blobs/sha256:abc", { headers: { Range: "bytes=0-10" } })
  );
  assert.equal(captured.cf, undefined);
});

test("full blob request enables edge caching", async (t) => {
  let captured;
  t.mock.method(globalThis, "fetch", async (_url, opts) => {
    captured = opts;
    return new Response("x", { status: 200 });
  });
  await worker.fetch(req("https://relay.tunaos.org/v2/tuna-os/foo/blobs/sha256:abc"));
  assert.ok(captured.cf && captured.cf.cacheEverything === true);
});

test("healthz rejects non-GET/HEAD", async () => {
  const res = await worker.fetch(req("https://relay.tunaos.org/healthz", { method: "POST" }));
  assert.equal(res.status, 405);
});

test("healthz reports ok when the upstream token endpoint answers 200", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("{}", { status: 200 }));
  const res = await worker.fetch(req("https://relay.tunaos.org/healthz"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "ok");
});

test("healthz reports degraded and logs when upstream fails", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("", { status: 500 }));
  const errSpy = t.mock.method(console, "error", () => {});
  const res = await worker.fetch(req("https://relay.tunaos.org/healthz"));
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.status, "degraded");
  assert.equal(errSpy.mock.calls.length, 1);
});

test("flathub search rejects non-POST", async () => {
  const res = await worker.fetch(req("https://relay.tunaos.org/flathub/search"));
  assert.equal(res.status, 405);
});

test("flathub search rejects an oversized body", async () => {
  const res = await worker.fetch(
    req("https://relay.tunaos.org/flathub/search", { method: "POST", body: "x".repeat(2049) })
  );
  assert.equal(res.status, 413);
});

test("flathub search relays the request body and upstream response", async (t) => {
  let captured;
  t.mock.method(globalThis, "fetch", async (url, opts) => {
    captured = { url: url.toString(), opts };
    return new Response("[]", { status: 200 });
  });
  const res = await worker.fetch(
    req("https://relay.tunaos.org/flathub/search", { method: "POST", body: JSON.stringify({ query: "gimp" }) })
  );
  assert.equal(res.status, 200);
  assert.equal(captured.url, "https://flathub.org/api/v2/search");
  assert.equal(captured.opts.body, JSON.stringify({ query: "gimp" }));
});

test("pkgsearch returns an empty array for a too-short query without calling upstream", async (t) => {
  const fetchSpy = t.mock.method(globalThis, "fetch", async () => new Response("{}", { status: 200 }));
  const res = await worker.fetch(req("https://relay.tunaos.org/pkgsearch?q=a"));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), []);
  assert.equal(fetchSpy.mock.calls.length, 0);
});

test("pkgsearch lowercases and strips disallowed characters from the query", async (t) => {
  const seen = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    seen.push(url.toString());
    return new Response("{}", { status: 200 });
  });
  await worker.fetch(req("https://relay.tunaos.org/pkgsearch?q=GIMP%3Cscript%3E&family=fedora"));
  assert.ok(seen.some((u) => u.includes(encodeURIComponent("gimpscript"))));
});

test("pkgsearch marks the result degraded and non-cacheable when repology is down", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("", { status: 500 }));
  const res = await worker.fetch(req("https://relay.tunaos.org/pkgsearch?q=gimp"));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await res.json(), []);
});

test("pkgsearch ranks the family-available package ahead of one from another family", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => {
    const u = url.toString();
    if (u.includes("/projects/")) {
      return new Response(
        JSON.stringify({
          gimp: [{ repo: "debian_12", binname: "gimp" }],
          "gimp-fedora-fork": [{ repo: "fedora_40", binname: "gimp-fedora-fork" }],
        }),
        { status: 200 }
      );
    }
    return new Response("[]", { status: 404 });
  });
  const res = await worker.fetch(req("https://relay.tunaos.org/pkgsearch?q=gimp&family=fedora"));
  const body = await res.json();
  assert.equal(body[0].project, "gimp-fedora-fork");
  assert.equal(body[0].available, true);
});

test("ddi endpoint relays a known channel and filename to Frostyard", async (t) => {
  let capturedUrl;
  t.mock.method(globalThis, "fetch", async (url) => {
    capturedUrl = url;
    return new Response("data", { status: 200 });
  });
  const res = await worker.fetch(req("https://relay.tunaos.org/ddi/snowfield/foo-1.0.raw"));
  assert.equal(res.status, 200);
  assert.equal(capturedUrl, "https://repository.frostyard.org/os/native/v1/snowfield/x86-64/foo-1.0.raw");
});

test("ddi endpoint with an unknown channel falls through to the path allowlist rejection", async () => {
  const res = await worker.fetch(req("https://relay.tunaos.org/ddi/unknown-channel/foo.raw"));
  assert.equal(res.status, 403);
});

test("ddi endpoint rejects non-GET/HEAD methods", async () => {
  const res = await worker.fetch(req("https://relay.tunaos.org/ddi/snowfield/foo.raw", { method: "POST" }));
  assert.equal(res.status, 405);
});
