/* Layer cache + parallel layer download for the tacklebox WASM engine
 * (tuna-os/iso-builder#191).
 *
 * The engine pulls every OCI layer through fetch() and applies them strictly
 * in order, with only two downloads in flight. Two costs fell out of that:
 * the link idled through most of a 65-layer unpack, and every inspect pulled
 * the whole image again — a rebuild of the same edition re-downloaded
 * gigabytes it already had.
 *
 * This file sits between the engine and the network and changes neither the
 * engine nor what it sees:
 *
 *   - When a manifest response passes through, every layer it lists is
 *     queued and downloaded PARALLEL at a time, in layer order, so the layer
 *     the engine needs next is always the one furthest along.
 *   - Layer bytes land in origin-private storage (OPFS), keyed by digest.
 *     A digest names its content, so a cached layer never goes stale and is
 *     shared by every image and tag that carries it.
 *   - The downloads run in a Worker (layerworker.js), so they never take
 *     main-thread time from the engine, which unpacks on that thread.
 *   - The engine's blob request is answered from that store at once. Its
 *     body streams each chunk as soon as it is on disk, so the engine starts
 *     on a layer while the rest of it is still arriving.
 *
 * Why chunks: an OPFS writable only becomes readable on close(), so one file
 * per layer could not be read until the whole layer was in. Each CHUNK is its
 * own file, closed as soon as it is full, and a closed chunk is complete by
 * construction. That also makes an interrupted download resumable — across
 * page reloads too — from the last whole chunk.
 *
 * Why draining to disk fixes stalls (iso-builder#49): the engine used to read
 * the network in 32 KB steps, awaiting an OPFS write between each. Chrome's
 * HTTP/2 receive window filled and the registry stopped sending. The
 * downloader reads the network as fast as it arrives and writes 4 MB at a
 * time, so the window never fills behind a slow consumer.
 *
 * The engine still verifies every layer's sha256 as it reads, so a bad cache
 * entry fails the build loudly; it can never produce a corrupt ISO. A layer is
 * also checked against the size its manifest gives before it counts as
 * cached. Without OPFS writables the wrapper steps aside and the engine reads
 * the network directly, as it did before.
 */
(function () {
  "use strict";

  const CHUNK = 4 << 20;
  // Enough to fill a home link through the relay; few enough that the layer
  // the engine waits on keeps a fair share of the bandwidth.
  const PARALLEL = 4;
  const DIR = "tbox-layer-cache";
  // The engine's arenas (layer bodies, post-unpack writes, EROFS) need about
  // 3–4× the compressed image (see checkStorageQuota in app.js). The cache
  // only takes the space that is left after that.
  const ARENA_FACTOR = 3.5;

  const BLOB_RE = /\/v2\/.+\/blobs\/sha256:([0-9a-f]{64})(?:[?#]|$)/;
  const MANIFEST_RE = /\/v2\/.+\/manifests\/[^/?#]+(?:[?#]|$)/;

  const netFetch = window.fetch.bind(window);
  const say = (m) => (typeof log === "function" ? log(m) : console.log(m));
  const gb = (n) => (n / 1e9).toFixed(2) + " GB";

  // A query parameter that differs on every retry makes Chrome open a fresh
  // connection instead of reusing an HTTP/2 connection left wedged by the
  // stream that was abandoned (iso-builder#49).
  const bust = (url) => url + (url.includes("?") ? "&" : "?") + "_tbox_retry=" + Date.now();
  const unbust = (url) => url.replace(/[?&]_tbox_retry=\d+/, "");

  const cacheDir = (async () => {
    try {
      if (!navigator.storage?.getDirectory) return null;
      if (typeof FileSystemFileHandle === "undefined" ||
          typeof FileSystemFileHandle.prototype.createWritable !== "function") return null;
      const root = await navigator.storage.getDirectory();
      return await root.getDirectoryHandle(DIR, { create: true });
    } catch {
      return null;
    }
  })();

  // Digests the current manifest could not fit; their requests go straight
  // to the network.
  const bypass = new Set();

  // ── Entries ─────────────────────────────────────────────────────────────
  // One per layer digest seen this session. State on disk:
  //   <DIR>/<hex>/c0, c1, …   CHUNK-sized files, the last one shorter
  //   <DIR>/<hex>/meta.json   {size, used}; present only once complete
  const entries = new Map(); // hex -> Promise<Entry>

  function entryFor(dir, hex) {
    if (!entries.has(hex)) entries.set(hex, loadEntry(dir, hex));
    return entries.get(hex);
  }

  async function loadEntry(dir, hex) {
    const d = await dir.getDirectoryHandle(hex, { create: true });
    const e = {
      hex, dir: d, url: "", headers: new Headers(),
      want: -1, chunks: 0, bytes: 0, done: false, verified: false,
      running: null, failed: null, waiters: [],
    };
    const meta = await readMeta(d);
    if (meta) {
      e.done = true;
      e.bytes = meta.size;
      e.chunks = Math.ceil(meta.size / CHUNK);
      return e;
    }
    // A download cut short earlier: keep every whole chunk. A short file is
    // the unfinished tail of that download and is rewritten.
    for (;;) {
      const f = await chunkFile(e, e.chunks);
      if (!f || f.size !== CHUNK) break;
      e.chunks++;
      e.bytes += CHUNK;
    }
    return e;
  }

  async function readMeta(d) {
    try {
      const f = await (await d.getFileHandle("meta.json")).getFile();
      return JSON.parse(await f.text());
    } catch {
      return null;
    }
  }

  async function touch(e) {
    const w = await (await e.dir.getFileHandle("meta.json", { create: true })).createWritable();
    await w.write(JSON.stringify({ size: e.bytes, used: Date.now() }));
    await w.close();
  }

  async function chunkFile(e, i) {
    try {
      return await (await e.dir.getFileHandle("c" + i)).getFile();
    } catch {
      return null;
    }
  }

  function notify(e) {
    const w = e.waiters;
    e.waiters = [];
    for (const f of w) f();
  }

  // ── Download ────────────────────────────────────────────────────────────
  const queue = [];
  let active = 0;

  function start(e) {
    if (e.done || e.running) return e.running;
    e.failed = null;
    e.running = download(e)
      .catch((err) => {
        e.failed = err;
        say(`layer cache: ${e.hex.slice(0, 12)} failed: ${err}`);
      })
      .finally(() => {
        e.running = null;
        notify(e);
      });
    return e.running;
  }

  function pump() {
    while (active < PARALLEL && queue.length) {
      const e = queue.shift();
      if (e.done || e.running) continue;
      active++;
      start(e).finally(() => {
        active--;
        pump();
      });
    }
  }

  // The downloads themselves run in layerworker.js, off the thread the engine
  // unpacks on. This side only tracks how many chunks are readable.
  let worker = null;
  const jobs = new Map(); // hex -> {e, resolve, reject}

  function download(e) {
    if (!worker) {
      worker = new Worker("layerworker.js");
      worker.onmessage = ({ data: m }) => {
        const j = jobs.get(m.hex);
        if (!j) return;
        if (m.log) return say(`layer cache: ${m.hex.slice(0, 12)} ${m.log}`);
        if (m.bytes !== undefined) {
          j.e.bytes = m.bytes;
          j.e.chunks = Math.ceil(m.bytes / CHUNK);
        }
        if (m.done) {
          j.e.done = true;
          // These bytes were just written by this session's worker.
          j.e.verified = true;
        }
        if (m.done || m.error) {
          jobs.delete(m.hex);
          if (m.error) j.reject(new Error(m.error));
          else j.resolve();
        }
        notify(j.e);
      };
    }
    return new Promise((resolve, reject) => {
      jobs.set(e.hex, { e, resolve, reject });
      // Only whole chunks count: a short file is an unfinished tail.
      const bytes = e.bytes - (e.bytes % CHUNK);
      worker.postMessage({ hex: e.hex, url: e.url, headers: [...e.headers], bytes, want: e.want });
    });
  }

  // Minimal incremental SHA-256 (FIPS 180-4). crypto.subtle only offers
  // one-shot digests, and per-chunk digests do not combine into the layer
  // digest, so the serve path hashes chunk files with this as they are read.
  const SHA256_K = new Int32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
    0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
    0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  function sha256Rotr(x, n) {
    return (x >>> n) | (x << (32 - n));
  }

  function sha256Block(H, b, o) {
    const w = new Int32Array(64);
    for (let i = 0; i < 16; i++) {
      w[i] = (b[o + i * 4] << 24) | (b[o + i * 4 + 1] << 16) | (b[o + i * 4 + 2] << 8) | b[o + i * 4 + 3];
    }
    for (let i = 16; i < 64; i++) {
      const s0 = sha256Rotr(w[i - 15], 7) ^ sha256Rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = sha256Rotr(w[i - 2], 17) ^ sha256Rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = H[0], bb = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let i = 0; i < 64; i++) {
      const S1 = sha256Rotr(e, 6) ^ sha256Rotr(e, 11) ^ sha256Rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA256_K[i] + w[i]) | 0;
      const S0 = sha256Rotr(a, 2) ^ sha256Rotr(a, 13) ^ sha256Rotr(a, 22);
      const mj = (a & bb) ^ (a & c) ^ (bb & c);
      const t2 = (S0 + mj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + bb) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }

  // Single-use: feed chunk bytes with update(), then read the hex digest with
  // hex(). At most one chunk file (4 MiB) is held at a time.
  class Sha256 {
    constructor() {
      this.H = new Int32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
      this.b = new Uint8Array(64);
      this.nb = 0;
      this.count = 0;
    }
    update(d) {
      this.count += d.length;
      this.write(d);
      return this;
    }
    write(d) {
      let off = 0;
      if (this.nb) {
        const take = Math.min(64 - this.nb, d.length);
        this.b.set(d.subarray(0, take), this.nb);
        this.nb += take;
        off = take;
        if (this.nb === 64) {
          sha256Block(this.H, this.b, 0);
          this.nb = 0;
        }
      }
      for (; off + 64 <= d.length; off += 64) sha256Block(this.H, d, off);
      if (off < d.length) {
        this.b.set(d.subarray(off));
        this.nb = d.length - off;
      }
    }
    hex() {
      const total = this.count;
      const zeros = (56 - ((total + 1) % 64) + 64) % 64;
      const pad = new Uint8Array(1 + zeros + 8);
      pad[0] = 0x80;
      const bits = total * 8;
      const dv = new DataView(pad.buffer, pad.byteOffset, pad.byteLength);
      dv.setUint32(pad.length - 8, Math.floor(bits / 4294967296));
      dv.setUint32(pad.length - 4, bits >>> 0);
      this.write(pad);
      let s = "";
      for (let i = 0; i < 8; i++) s += (this.H[i] >>> 0).toString(16).padStart(8, "0");
      return s;
    }
  }

  // Incrementally hashes every chunk file of a complete layer and compares
  // the digest against the entry key, the expected sha256 hex. A missing or
  // short chunk file, a byte total that disagrees with the entry, or a
  // digest mismatch all report false.
  async function verifyLayer(e) {
    const h = new Sha256();
    let total = 0;
    for (let i = 0; i < e.chunks; i++) {
      const f = await chunkFile(e, i);
      if (!f) return false;
      const u8 = new Uint8Array(await f.arrayBuffer());
      h.update(u8);
      total += u8.length;
    }
    if (total !== e.bytes) return false;
    if (h.hex() !== e.hex) return false;
    e.verified = true;
    return true;
  }

  // Deletes every file of a rejected layer (meta.json + c*) and resets the
  // entry so the next pull re-downloads it from the network.
  async function evictLayer(e) {
    let names = null;
    try {
      if (typeof e.dir.entries === "function") {
        names = [];
        for await (const [name] of e.dir.entries()) names.push(name);
      }
    } catch {
      names = null;
    }
    if (!names) {
      names = ["meta.json"];
      for (let i = 0; i <= e.chunks; i++) names.push("c" + i);
    }
    for (const name of names) {
      await e.dir.removeEntry(name, { recursive: true }).catch(() => {});
    }
    e.done = false;
    e.bytes = 0;
    e.chunks = 0;
    e.failed = null;
    e.verified = false;
  }

  // ── Serving the engine ──────────────────────────────────────────────────
  // A digest names its content, so a complete layer whose bytes no longer
  // hash to its digest is not that layer and is rejected before a single
  // byte reaches the engine. OPFS stays writable by page script after the
  // worker commits, so even a layer this session verified is re-read from
  // disk and checked here — the check costs disk reads, never network, which
  // keeps warm builds transfer-free while catching tamper (flipped bytes, a
  // rewritten tail) on the very next request. A rejected layer is evicted
  // and re-downloaded, and the same response streams the fresh bytes.
  // The response exists at once, so the engine's header timeout never sees
  // the queue. Each pull hands over the next chunk the moment it is closed.
  async function serve(e, from) {
    if (e.done && !(await verifyLayer(e).catch(() => false))) {
      say(`layer cache: ${e.hex.slice(0, 12)} failed verification; re-downloading`);
      await evictLayer(e);
      start(e);
    }
    let idx = Math.floor(from / CHUNK);
    let skip = from % CHUNK;
    const body = new ReadableStream({
      async pull(c) {
        while (idx >= e.chunks) {
          if (e.done) return c.close();
          if (!e.running) {
            if (e.failed) return c.error(e.failed);
            start(e);
          }
          await new Promise((r) => e.waiters.push(r));
        }
        const f = await chunkFile(e, idx);
        if (!f) return c.error(new Error(`layer cache: chunk ${idx} of ${e.hex.slice(0, 12)} missing`));
        idx++;
        const u8 = new Uint8Array(await f.slice(skip).arrayBuffer());
        skip = 0;
        c.enqueue(u8);
      },
    }, { highWaterMark: 0 });
    const headers = new Headers({ "Content-Type": "application/octet-stream" });
    if (e.done) headers.set("Content-Length", String(e.bytes - from));
    return new Response(body, { status: from > 0 ? 206 : 200, headers });
  }

  async function passthrough(url, init) {
    // Same #49 workaround the engine got before this file: a resume goes out
    // on a fresh connection.
    if (new Headers(init?.headers).has("range")) url = bust(url);
    return netFetch(url, init);
  }

  async function blobFetch(url, hex, init) {
    const dir = await cacheDir;
    if (!dir || bypass.has(hex)) return passthrough(url, init);
    const h = new Headers(init?.headers);
    const m = /bytes=(\d+)-/.exec(h.get("range") || "");
    h.delete("range");
    const e = await entryFor(dir, hex);
    // The engine's request carries the freshest token; prefetch reuses it.
    e.url = unbust(url);
    e.headers = h;
    if (!e.done && !e.running) start(e);
    return serve(e, m ? Number(m[1]) : 0);
  }

  // ── Prefetch ────────────────────────────────────────────────────────────
  async function plan(url, manifest, init) {
    const layers = (manifest.layers || []).filter((l) => /^sha256:[0-9a-f]{64}$/.test(l.digest || ""));
    if (!layers.length) return;
    const dir = await cacheDir;
    if (!dir) return;
    const base = url.replace(/\/manifests\/[^/?#]+.*$/, "/blobs/");
    const h = new Headers(init?.headers);
    h.delete("accept");
    const list = [];
    let total = 0;
    let missing = 0;
    for (const l of layers) {
      const e = await entryFor(dir, l.digest.slice(7));
      if (!e.url) {
        e.url = base + l.digest;
        e.headers = h;
      }
      e.want = l.size ?? -1;
      total += l.size || 0;
      if (!e.done) missing += Math.max(0, (l.size || 0) - e.bytes);
      list.push(e);
    }
    const keep = new Set(list.map((e) => e.hex));
    if (!(await makeRoom(dir, missing + ARENA_FACTOR * total, keep))) {
      for (const e of list) if (!e.done && !e.running) bypass.add(e.hex);
      say(`layer cache: not enough storage to keep ${gb(missing)} of layers; downloading them uncached`);
      return;
    }
    const cached = list.filter((e) => e.done).length;
    say(`layer cache: ${cached}/${list.length} layers on disk, ` +
        (missing ? `downloading ${gb(missing)} ${PARALLEL} at a time` : "nothing to download"));
    for (const e of list) {
      if (e.done) touch(e).catch(() => {}); // marks it recently used
      else queue.push(e);
    }
    const t0 = performance.now();
    pump();
    if (missing) {
      Promise.all(list.map((e) => waitDone(e))).then((ok) => {
        if (ok.every(Boolean)) say(`layer cache: all ${list.length} layers on disk (${((performance.now() - t0) / 1000).toFixed(0)}s)`);
      });
    }
  }

  async function waitDone(e) {
    while (!e.done) {
      if (!e.running && e.failed) return false;
      await new Promise((r) => e.waiters.push(r));
    }
    return true;
  }

  // makeRoom evicts least-recently-used layers outside keep until need bytes
  // are free. It reports whether that worked.
  async function makeRoom(dir, need, keep) {
    if (!navigator.storage?.estimate) return true;
    const { quota, usage } = await navigator.storage.estimate();
    let free = quota - usage;
    if (free >= need) return true;
    const old = [];
    for await (const [name, h] of dir.entries()) {
      if (h.kind !== "directory" || keep.has(name)) continue;
      const live = entries.has(name) ? await entries.get(name) : null;
      if (live?.running) continue;
      const meta = await readMeta(h);
      old.push({ name, used: meta?.used || 0, size: meta?.size ?? (live?.bytes || 0) });
    }
    old.sort((a, b) => a.used - b.used);
    for (const o of old) {
      if (free >= need) break;
      await dir.removeEntry(o.name, { recursive: true }).catch(() => {});
      entries.delete(o.name);
      free += o.size;
      say(`layer cache: evicted ${o.name.slice(0, 12)} (${gb(o.size)})`);
    }
    return free >= need;
  }

  let prefetchEnabled = true;
  const activeLeases = new Set();

  function isMetadataOnlyRequest(init) {
    if (!prefetchEnabled) return true;
    if (init && init.tboxMetadataOnly) return true;
    try {
      if (init?.headers && new Headers(init.headers).get("x-tbox-metadata-only") === "1") {
        return true;
      }
    } catch {}
    return false;
  }

  function stripMetadataHeader(init) {
    if (!init) return init;
    const copy = { ...init };
    delete copy.tboxMetadataOnly;
    if (copy.headers) {
      const h = new Headers(copy.headers);
      if (h.has("x-tbox-metadata-only")) {
        h.delete("x-tbox-metadata-only");
        copy.headers = h;
      }
    }
    return copy;
  }

  // ── fetch hook ──────────────────────────────────────────────────────────
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || String(input);
    const method = (init && init.method) || (input && input.method) || "GET";
    const metadataOnly = isMetadataOnlyRequest(init);
    const netInit = stripMetadataHeader(init);
    if (method.toUpperCase() === "GET") {
      const b = BLOB_RE.exec(url);
      if (b) return blobFetch(url, b[1], netInit);
      if (MANIFEST_RE.test(url)) {
        return netFetch(input, netInit).then((r) => {
          if (r.ok && !metadataOnly) {
            r.clone().json().then((m) => plan(url, m, netInit)).catch(() => {});
          }
          return r;
        });
      }
    }
    return netFetch(input, netInit);
  };

  // ── UI hooks ────────────────────────────────────────────────────────────
  globalThis.tboxLayerCache = {
    setPrefetchEnabled(enabled) {
      prefetchEnabled = Boolean(enabled);
      return prefetchEnabled;
    },
    isPrefetchEnabled() {
      return prefetchEnabled;
    },
    pullManifestAndPrefetch(url, manifest, init) {
      return plan(url, manifest, init);
    },
    fetchMetadata(input, init = {}) {
      return window.fetch(input, { ...init, tboxMetadataOnly: true });
    },
    acquireBuildLease(id = "default") {
      const key = String(id || "default");
      activeLeases.add(key);
      return () => {
        activeLeases.delete(key);
      };
    },
    releaseBuildLease(id = "default") {
      activeLeases.delete(String(id || "default"));
      return activeLeases.size === 0;
    },
    hasActiveLease() {
      return activeLeases.size > 0 || active > 0;
    },
    // Total bytes of complete layers on disk.
    async size() {
      const dir = await cacheDir;
      let n = 0;
      let bytes = 0;
      if (!dir) return { layers: 0, bytes: 0 };
      for await (const [, h] of dir.entries()) {
        if (h.kind !== "directory") continue;
        const meta = await readMeta(h);
        if (meta) {
          n++;
          bytes += meta.size;
        }
      }
      return { layers: n, bytes };
    },
    // Drops every layer that is not downloading right now; refuses when a build lease is active.
    async clear() {
      if (activeLeases.size > 0 || active > 0) {
        say("layer cache: cannot clear while an operation is active");
        return { cleared: false, activeBuild: true };
      }
      const dir = await cacheDir;
      if (!dir) return { cleared: true, activeBuild: false };
      const names = [];
      for await (const [name, h] of dir.entries()) if (h.kind === "directory") names.push(name);
      let skippedRunning = false;
      for (const name of names) {
        const live = entries.has(name) ? await entries.get(name) : null;
        if (live?.running) {
          skippedRunning = true;
          continue;
        }
        await dir.removeEntry(name, { recursive: true }).catch(() => {});
        entries.delete(name);
      }
      bypass.clear();
      return { cleared: !skippedRunning, activeBuild: skippedRunning };
    },
  };
})();
