/* Layer downloader for layercache.js (tuna-os/iso-builder#191).
 *
 * This runs in a Worker for two reasons. The Go engine unpacks on the page's
 * main thread, so network reads handled there take time from it. And only a
 * Worker can write OPFS through a sync access handle, which writes in place;
 * the main thread's writable streams write a swap file and rename it.
 *
 * Protocol, one download per message:
 *   in:  {hex, url, headers: [[k, v]…], bytes, want}
 *   out: {hex, chunk: true, bytes}   a chunk file is closed and readable
 *        {hex, log: "…"}             a retry worth telling the user about
 *        {hex, done: true, bytes}    meta.json written; the layer is cached
 *        {hex, error: "…"}           gave up; whole chunks so far are kept
 *
 * The chunk layout is layercache.js's: <DIR>/<hex>/c0, c1, …, meta.json.
 */
"use strict";

const CHUNK = 4 << 20;
// Under the engine's 45 s body stall timeout, so a dead stream is recovered
// here before the engine gives up on the response it was served.
const STALL_MS = 30_000;
const HEADER_MS = 60_000;
const MAX_ATTEMPTS = 6;
const DIR = "tbox-layer-cache";

const gb = (n) => (n / 1e9).toFixed(2) + " GB";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A query parameter that differs on every retry makes the browser open a
// fresh connection instead of reusing an HTTP/2 connection left wedged by
// the stream that was abandoned (iso-builder#49).
const bust = (url) => url + (url.includes("?") ? "&" : "?") + "_tbox_retry=" + Date.now();

const cacheDir = navigator.storage.getDirectory().then((root) => root.getDirectoryHandle(DIR, { create: true }));

self.onmessage = async ({ data: job }) => {
  try {
    const dir = await (await cacheDir).getDirectoryHandle(job.hex, { create: true });
    await download(dir, job);
    self.postMessage({ hex: job.hex, done: true, bytes: job.bytes });
  } catch (err) {
    self.postMessage({ hex: job.hex, error: String(err) });
  }
};

async function download(dir, job) {
  // job.bytes is a whole number of chunks: the caller only counts closed ones.
  let chunks = job.bytes / CHUNK;
  if (job.bytes > 0) {
    // Resume scrub: a previous attempt may have left a short or zero-byte
    // tail chunk on disk (recorded: c3 zero bytes after three complete 4MiB
    // chunks). The caller only counts whole chunks, so that tail is stale:
    // drop it and resume from the last whole-chunk boundary instead of
    // appending after it or treating the layer as complete. A short file is
    // kept only when it is the known-final tail, i.e. the manifest size says
    // the layer ends inside it.
    for (;;) {
      let last = -1;
      let size = -1;
      for (let i = 0; i < 1048576; i++) {
        let f;
        try {
          f = await (await dir.getFileHandle("c" + i)).getFile();
        } catch {
          break;
        }
        last = i;
        size = f.size;
      }
      if (last < 0 || size === CHUNK) break;
      if (size > 0 && size < CHUNK && job.want >= 0 && last * CHUNK + size === job.want) break;
      await dir.removeEntry("c" + last);
      job.bytes = last * CHUNK;
      chunks = last;
    }
  }
  let attempts = 0;
  for (;;) {
    const off = job.bytes;
    const ctrl = new AbortController();
    let timer = setTimeout(() => ctrl.abort(), HEADER_MS);
    try {
      const h = new Headers(job.headers);
      let url = job.url;
      if (off > 0) h.set("Range", `bytes=${off}-`);
      if (off > 0 || attempts > 0) url = bust(url);
      const resp = await fetch(url, { headers: h, signal: ctrl.signal });
      if (resp.status !== (off > 0 ? 206 : 200)) {
        throw new Error(`HTTP ${resp.status}${off > 0 ? ` resuming at ${off}` : ""}`);
      }
      const len = Number(resp.headers.get("content-length") || -1);
      const reader = resp.body.getReader();
      let buf = new Uint8Array(CHUNK);
      let fill = 0;
      let got = 0;
      const flush = async (u8) => {
        await writeFile(dir, "c" + chunks, u8);
        chunks++;
        job.bytes += u8.length;
        self.postMessage({ hex: job.hex, chunk: true, bytes: job.bytes });
      };
      for (;;) {
        clearTimeout(timer);
        timer = setTimeout(() => ctrl.abort(), STALL_MS);
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        for (let p = 0; p < value.length;) {
          const n = Math.min(CHUNK - fill, value.length - p);
          buf.set(value.subarray(p, p + n), fill);
          fill += n;
          p += n;
          if (fill === CHUNK) {
            clearTimeout(timer);
            await flush(buf);
            attempts = 0;
            buf = new Uint8Array(CHUNK);
            fill = 0;
          }
        }
      }
      clearTimeout(timer);
      if (len >= 0 && got !== len) throw new Error(`short body: ${got} of ${len} bytes`);
      if (fill > 0) await flush(buf.subarray(0, fill));
      if (job.want >= 0 && job.bytes !== job.want) {
        // Wrong length for this digest: not a layer worth keeping. Drop every
        // chunk file so a truncated/corrupt layer is evicted, never committed.
        for (let i = 0; ; i++) {
          try {
            await dir.removeEntry("c" + i);
          } catch {
            break;
          }
        }
        job.bytes = 0;
        throw Object.assign(new Error(`size ${got}, manifest says ${job.want}`), { fatal: true });
      }
      try {
        await writeFile(dir, "meta.json", new TextEncoder().encode(JSON.stringify({ size: job.bytes, used: Date.now() })));
      } catch (err) {
        // Never leave a meta.json marking the layer complete after an I/O
        // failure: the error propagates and the layer stays uncached.
        await dir.removeEntry("meta.json").catch(() => {});
        throw err;
      }
      return;
    } catch (err) {
      clearTimeout(timer);
      if (err.fatal || ++attempts >= MAX_ATTEMPTS) throw err;
      self.postMessage({
        hex: job.hex,
        log: `retry ${attempts} at ${gb(job.bytes)}: ${err.name === "AbortError" ? "stalled" : err}`,
      });
      // A short tail chunk is rewritten on the next attempt.
      if (job.bytes % CHUNK) {
        job.bytes -= job.bytes % CHUNK;
        chunks--;
      }
      await sleep(1000 * attempts);
    }
  }
}

// writeFile replaces name with u8, through a sync access handle where the
// browser has one (see the top of this file).
async function writeFile(dir, name, u8) {
  const fh = await dir.getFileHandle(name, { create: true });
  if (typeof fh.createSyncAccessHandle !== "function") {
    const w = await fh.createWritable();
    await w.write(u8);
    return w.close();
  }
  const ah = await fh.createSyncAccessHandle();
  try {
    ah.truncate(0);
    let off = 0;
    while (off < u8.length) off += ah.write(u8.subarray(off), { at: off });
    ah.flush();
  } finally {
    ah.close();
  }
}
