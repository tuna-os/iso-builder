/* TunaOS ISO Builder GUI — drives the tacklebox WASM engine (tbox.wasm).
 *
 * URL params (shareable presets, tunaOS#667):
 *   ?image=<repo:tag | host/repo:tag>   pre-fill + auto-inspect
 *   ?flatpaks=<comma-separated ids>     override the per-DE default list
 *   ?label=<VOLID>                      volume label
 *
 * ?shim= and ?initrd= are NOT accepted from URLs (iso-builder#114): they
 * would let a shared link swap the registry every layer is pulled from and
 * the embedded initramfs, so a link could build a weaponized "official"
 * ISO. Non-default shim/initrd must be typed by hand.
 */

let SHIM = "https://relay.tunaos.org";

function updateShim() {
  const input = $("shimurl");
  if (input && input.value.trim()) {
    SHIM = input.value.trim().replace(/\/+$/, "");
  } else {
    SHIM = "https://relay.tunaos.org";
  }
}

// Per-DE defaults distilled from the upstream curation (bluefin/common,
// aurora/common, zirconium): every desktop ships the Bazaar store + a
// browser; editors follow the desktop's family. The full upstream sets
// are one click away (loadCuratedSet fetches the live Brewfiles).
const FLATPAK_DEFAULTS = {
  gnome: ["io.github.kolunmi.Bazaar", "org.mozilla.firefox", "org.gnome.TextEditor"],
  kde: ["io.github.kolunmi.Bazaar", "org.mozilla.firefox", "org.kde.kate"],
  xfce: ["io.github.kolunmi.Bazaar", "org.mozilla.firefox", "org.gnome.TextEditor"],
  cosmic: ["io.github.kolunmi.Bazaar", "org.mozilla.firefox"],
  niri: ["io.github.kolunmi.Bazaar", "org.mozilla.firefox"],
  none: [],
};

// Upstream curated sets, parsed live from the Brewfiles (flatpak "id"
// lines) so they track upstream without redeploys.
const CURATED_SETS = {
  kde: {
    label: "Aurora full-desktop set",
    url: "https://raw.githubusercontent.com/get-aurora-dev/common/main/system_files/shared/usr/share/ublue-os/homebrew/full-desktop.Brewfile",
  },
  default: {
    label: "Bluefin full-desktop set",
    url: "https://raw.githubusercontent.com/projectbluefin/common/main/system_files/bluefin/usr/share/ublue-os/homebrew/full-desktop.Brewfile",
  },
};

async function loadCuratedSet() {
  const set = CURATED_SETS[facts?.desktop] || CURATED_SETS.default;
  $("curated").disabled = true;
  try {
    const r = await fetch(set.url);
    const ids = [...(await r.text()).matchAll(/^flatpak "([^"]+)"/gm)].map((m) => m[1]);
    for (const id of ids) fpAdd(id);
    log(`added ${ids.length} apps from the ${set.label}`);
  } catch (e) {
    log("curated set fetch failed: " + e);
  } finally {
    $("curated").disabled = false;
  }
}

const $ = (id) => document.getElementById(id);

// Browser notifications for the long phases — users tab away during
// multi-minute pulls/builds. Permission is requested on the action
// click (a user gesture); notifications only fire when the tab is
// hidden (a focused user can see the progress bar).
function askNotify() {
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
}
function notify(title, body) {
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted" || !document.hidden) return;
  try { new Notification(title, { body, icon: "logo.png" }); } catch {}
}

// ── Flatpak checklist + Flathub search ──────────────────────────────────
const fpItems = new Map(); // appId -> { checked, name }

function fpAdd(id, name = "", checked = true) {
  if (!fpItems.has(id)) fpItems.set(id, { checked, name });
  else fpItems.get(id).checked = checked;
  fpRender();
}

function fpCollect() {
  return [...fpItems.entries()].filter(([, v]) => v.checked).map(([k]) => k);
}

function fpRender() {
  const box = $("fplist");
  box.innerHTML = "";
  for (const [id, v] of fpItems) {
    const label = document.createElement("label");
    const cb = Object.assign(document.createElement("input"), { type: "checkbox", checked: v.checked });
    cb.onchange = () => { v.checked = cb.checked; updateShare(); };
    label.appendChild(cb);
    const span = document.createElement("span");
    span.textContent = v.name || id;
    label.appendChild(span);
    if (v.name) {
      const code = document.createElement("code");
      code.textContent = id;
      label.appendChild(code);
    }
    box.appendChild(label);
  }
  updateShare();
}

let fpTimer = null;
async function fpSearch(q) {
  updateShim();
  if (!q || q.length < 3) { $("fpresults").innerHTML = ""; return; }
  try {
    const r = await fetch(SHIM + "/flathub/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: q, filters: [] }),
    });
    const d = await r.json();
    const box = $("fpresults");
    box.innerHTML = "";
    for (const hit of (d.hits || []).slice(0, 6)) {
      if (fpItems.has(hit.app_id) && fpItems.get(hit.app_id).checked) continue;
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = `+ ${hit.name} — ${hit.app_id}`;
      b.onclick = () => { fpAdd(hit.app_id, hit.name); $("fpresults").innerHTML = ""; $("fpsearch").value = ""; };
      box.appendChild(b);
    }
  } catch {
    $("fpresults").innerHTML = "<span style='font-size:.8rem;color:var(--dim)'>Flathub search unavailable</span>";
  }
}
const log = (m) => { $("log").textContent += m + "\n"; $("log").scrollTop = 1e9; };

let facts = null;
let wasmReady = null;

// System packages (remora) + custom repo/setup commands (extra_run).
const pkgItems = new Map();  // pkg -> {checked, summary}
const repoCmds = [];         // extra_run lines

function pkgAdd(id, summary = "") {
  if (!pkgItems.has(id)) pkgItems.set(id, { checked: true, summary });
  pkgRender();
}
function pkgRender() {
  const box = $("pkglist");
  box.innerHTML = "";
  for (const [id, v] of pkgItems) {
    const label = document.createElement("label");
    const cb = Object.assign(document.createElement("input"), { type: "checkbox", checked: v.checked });
    cb.onchange = () => { v.checked = cb.checked; updateShare(); };
    label.appendChild(cb);
    const span = document.createElement("span");
    span.textContent = id;
    label.appendChild(span);
    box.appendChild(label);
  }
  updateShare();
}
function pkgCollect() { return [...pkgItems].filter(([, v]) => v.checked).map(([k]) => k); }

let pkgTimer = null;
async function pkgSearch(q) {
  updateShim();
  const fam = facts?.repoFamily || "fedora";
  if (!q || q.length < 2) { $("pkgresults").innerHTML = ""; return; }
  try {
    const r = await fetch(`${SHIM}/pkgsearch?q=${encodeURIComponent(q)}&family=${fam}`);
    const hits = await r.json();
    const box = $("pkgresults");
    box.innerHTML = "";
    for (const h of hits) {
      if (pkgItems.has(h.pkg)) continue;
      const b = document.createElement("button");
      b.type = "button";
      // h.pkg and h.summary are repology.org package metadata relayed by
      // the shim — third-party text nobody in this path sanitises. Build
      // the row from nodes so a package summary containing markup is
      // rendered as the text it is, never parsed as HTML (same shape as
      // fpSearch above).
      b.append("+ ");
      const name = document.createElement("b");
      name.textContent = h.pkg;
      b.append(name);
      if (h.summary) b.append(" — " + h.summary.slice(0, 60));
      const avail = document.createElement("span");
      avail.className = h.available ? "avail" : "unavail";
      avail.textContent = h.available ? `✓ ${fam}` : `not in ${fam}`;
      b.append(avail);
      b.onclick = () => { pkgAdd(h.pkg, h.summary); $("pkgresults").innerHTML = ""; $("pkgsearch").value = ""; };
      box.appendChild(b);
    }
  } catch (e) {
    $("pkgresults").innerHTML = "<span style='font-size:.8rem;color:var(--dim)'>package search unavailable</span>";
  }
}

function repoRender() {
  const box = $("repolist");
  box.innerHTML = "";
  repoCmds.forEach((cmd, i) => {
    const label = document.createElement("label");
    const rm = Object.assign(document.createElement("button"), { type: "button", textContent: "✕" });
    rm.className = "secondary";
    rm.style.cssText = "padding:0 .4rem;font-size:.75rem";
    rm.onclick = () => { repoCmds.splice(i, 1); repoRender(); };
    label.appendChild(rm);
    const code = document.createElement("code");
    code.textContent = cmd;
    label.appendChild(code);
    box.appendChild(label);
  });
  updateShare();
}
function addRepo() {
  const kind = $("repokind").value;
  const ref = $("reporef").value.trim();
  if (!ref) return;
  let cmd;
  switch (kind) {
    case "copr": cmd = `dnf -y copr enable ${ref}`; break;
    case "ppa": cmd = `add-apt-repository -y ppa:${ref}`; break;
    case "obs": cmd = `zypper -n ar -f obs://${ref} ${ref.replace(/[:/]/g, "_")}`; break;
    default: cmd = ref;
  }
  repoCmds.push(cmd);
  $("reporef").value = "";
  repoRender();
}

// Go builds to wasm32, so the engine's linear memory is capped well below
// what the host has free. Large editions wedge mid-unpack with no error and
// no console output — see tboxWasmMB, which is the only way to watch the
// engine approach that ceiling from outside.
let wasmMemory = null;
globalThis.tboxWasmMB = () => (wasmMemory ? wasmMemory.buffer.byteLength / 1048576 : -1);

// JS heap is a separate ceiling from wasm linear memory. The wasm memory
// guard (watchEngineMemory) only sees the engine side; data can accumulate
// on the JS side (blob URLs, OPFS write buffers, download intermediates)
// with no warning at all — see tuna-os/iso-builder#47. This makes it
// visible in the @full heartbeat alongside tboxWasmMB().
globalThis.tboxJsHeapMB = () => {
  if (typeof performance !== 'undefined' && performance.memory && performance.memory.usedJSHeapSize) {
    return performance.memory.usedJSHeapSize / 1048576;
  }
  return -1;
};

function loadWasm() {
  if (wasmReady) return wasmReady;
  const go = new Go();
  wasmReady = WebAssembly.instantiateStreaming(fetch("tbox.wasm"), go.importObject)
    .then((r) => {
      wasmMemory = r.instance.exports.mem || go.mem || null;
      go.run(r.instance);
      log("engine loaded (tacklebox wasm)");
    });
  return wasmReady;
}

let lastProgressAt = 0;
globalThis.tboxOnProgress = (stage, i, n) => {
  $("stage").textContent = { resolve: "Resolving manifest…", unpack: `Unpacking layer ${i}/${n}`, initrd: "Appending tbox initramfs overlay…", erofs: "Authoring EROFS live root…", esp: "Authoring EFI system partition…", iso: "Streaming ISO…" }[stage] || stage;
  $("bar").max = n; $("bar").value = i;
  lastProgressAt = Date.now();
};

// The engine runs out of address space long before the machine runs out of
// RAM, and when it does it usually says nothing at all: the heap parks just
// under 4 GiB, the GC thrashes, and the progress bar simply stops. Users saw
// an indefinite freeze with no message (tuna-os/tacklebox#156).
//
// This only *reports*. By the time linear memory is at the ceiling the Go
// side is already dead or thrashing, and nothing here can cancel it or free
// it — the tab has to be reloaded. Saying so beats a frozen bar.
const WASM32_LIMIT_MB = 4096;
const WASM_WARN_MB = 3400; // still climbing, but the outcome is rarely in doubt
const WASM_WEDGED_MB = 3900; // parked here + no progress == out of address space
const WEDGE_AFTER_MS = 120_000; // must outlast a genuinely slow ISO-streaming stage

// JS heap ceiling is separate from wasm; a 5.68 GB ISO download can blow
// past JS heap limits with no console output (tuna-os/iso-builder#47).
// The threshold is conservative: a healthy build rarely exceeds ~200 MB in
// JS heap, so anything climbing past 1 GB indicates a buffering problem.
const JSHEAP_WARN_MB = 1024;

function watchEngineMemory() {
  let warned = false;
  let jsWarned = false;
  let done = false;
  lastProgressAt = Date.now();
  const timer = setInterval(() => {
    if (done) return;
    const mb = globalThis.tboxWasmMB();
    const jsMb = globalThis.tboxJsHeapMB();

    // Heartbeat: log both heaps so a JS-side death (which leaves no
    // wasm trace) is distinguishable from a wasm-side one.
    if (jsMb > 0) {
      log(`heartbeat: wasm=${Math.round(mb)}MB js=${Math.round(jsMb)}MB`);
    }

    if (mb > 0) {
      if (!warned && mb >= WASM_WARN_MB) {
        warned = true;
        log(`warning: engine memory ${Math.round(mb)} MB of a ~${WASM32_LIMIT_MB} MB hard limit — large images can exhaust it`);
      }
      if (mb >= WASM_WEDGED_MB && Date.now() - lastProgressAt > WEDGE_AFTER_MS) {
        done = true;
        clearInterval(timer);
        const msg = `Out of memory — this image is too large for the browser engine (used ${Math.round(mb)} MB of its ~${WASM32_LIMIT_MB} MB limit).`;
        $("stage").textContent = msg;
        log(`error: ${msg}`);
        log("the engine cannot recover from this — reload the page to start over.");
        log("tracking: https://github.com/tuna-os/tacklebox/issues/156");
        notify("ISO build failed", "Image too large for the browser engine");
        return;
      }
    }

    if (jsMb > 0 && !jsWarned && jsMb >= JSHEAP_WARN_MB) {
      jsWarned = true;
      log(`warning: JS heap ${Math.round(jsMb)} MB — the download path may be buffering in renderer memory (tuna-os/iso-builder#47)`);
    }
  }, 5_000);
  return () => { done = true; clearInterval(timer); };
}

// "tuna-os/x:y" → ghcr via shim; "quay.io/a/b:c" → that registry direct.
function parseImage(raw) {
  let s = raw.trim();
  if (!s.includes("/")) {
    s = "tuna-os/" + s;
  }
  const firstSeg = s.split("/")[0];
  if (firstSeg.includes(".") || firstSeg.includes(":")) {
    const host = firstSeg;
    const rest = s.slice(host.length + 1);
    if (host === "ghcr.io") return { registry: SHIM, image: rest };
    return { registry: "https://" + host, image: rest };
  }
  return { registry: SHIM, image: s };
}

async function inspect() {
  selectedDdi = null; // inspecting an image ref is the OCI path
  updateShim();
  const raw = $("image").value;
  if (!raw.includes(":")) { log("image must be <repo>:<tag>"); return; }
  askNotify();
  $("introspect").disabled = true;
  $("buildcard").classList.remove("hidden");
  $("postcard").classList.add("hidden");
  let stopWatch = () => {};
  try {
    // Persistent origin storage: multi-GB images live in OPFS during the
    // build; persist() exempts them from eviction (best-effort), and the
    // quota estimate warns before an impossible pull.
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
    if (navigator.storage?.estimate) {
      const { quota, usage } = await navigator.storage.estimate();
      log(`storage quota ≈ ${((quota - usage) / 1e9).toFixed(1)} GB free`);
    }
    checkStorageQuota();
    await loadWasm();
    stopWatch = watchEngineMemory();
    const { registry, image } = parseImage(raw);
    log(`inspecting ${image} via ${registry}`);
    facts = JSON.parse(await tboxIntrospect(image, registry));
    const f = $("facts");
    f.classList.remove("hidden");
    f.innerHTML = "";
    // Every value here is read out of the inspected image (kernelVer is a
    // directory name inside it, desktop/pkgManager are detected from its
    // contents) and the image ref can name any registry — so the value goes
    // in as text, and only the surrounding label is markup this file wrote.
    const add = (label, value, tail = "", cls = "badge") => {
      const b = document.createElement("span");
      b.className = cls;
      if (label) b.append(label);
      const strong = document.createElement("b");
      strong.textContent = String(value);
      b.append(strong);
      if (tail) b.append(tail);
      f.appendChild(b);
    };
    add("desktop ", facts.desktop, "", "badge de");
    add("kernel ", facts.kernelVer || "none");
    add("systemd-boot ", facts.hasSdBoot ? "in image" : "not shipped");
    if (facts.pkgManager) add("packaging ", facts.pkgManager);
    add("", facts.fileCount.toLocaleString(), " files");
    if (fpItems.size === 0) {
      for (const id of FLATPAK_DEFAULTS[facts.desktop] || []) fpAdd(id);
    }
    if (facts.pkgManager) {
      $("pkgsearch").placeholder = `Search packages (${facts.pkgManager} · ${facts.repoFamily})…`;
      const kinds = { fedora: "copr", debian: "ppa", opensuse: "obs" };
      if (kinds[facts.repoFamily]) $("repokind").value = kinds[facts.repoFamily];
    }
    $("stage").textContent = "Image inspected — ready to build.";
    notify("Image inspected", `${raw}: ${facts.desktop} desktop, ready to build`);
    $("build").disabled = false;
    updateShare();
  } catch (e) {
    log("error: " + e);
    $("stage").textContent = "Inspect failed.";
    notify("Inspect failed", String(e).slice(0, 120));
  } finally {
    stopWatch();
    $("introspect").disabled = false;
  }
}

// isoSink picks where ISO chunks go: a user-picked file stream, or an
// OPFS spool file whose disk-backed File feeds the download. NEVER
// renderer memory: buffering a ~9 GB aurora ISO as JS chunks exhausted
// entire CI runner VMs ~15 s into ISO streaming — twice, identically
// (runs 31077005259 and 31087786433) — surfacing as "runner has
// received a shutdown signal" with no evidence left behind. The engine
// already requires OPFS, so the spool is always available; the file is
// left in place after download (the Blob URL references it) and simply
// overwritten by the next build.
// Returns null when the user cancels the picker.
async function isoSink(name) {
  const autodl = new URLSearchParams(location.search).get("autodl");
  if (window.showSaveFilePicker && !autodl) {
    try {
      const h = await showSaveFilePicker({ suggestedName: name, types: [{ description: "ISO image", accept: { "application/x-iso9660-image": [".iso"] } }] });
      return { kind: "picker", w: await h.createWritable() };
    } catch (e) {
      if (e.name === "AbortError") return null;
      throw e;
    }
  }
  try {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle("tbox-download.iso", { create: true });
    const w = await fh.createWritable();
    return { kind: "opfs", w, fh };
  } catch (e) {
    if (e.name === "QuotaExceededError") {
      throw new Error("OPFS storage quota exceeded — the build needs more space than the browser allows. " +
        "Free up origin storage or use a Chromium-based browser.");
    }
    throw e;
  }
}

// checkStorageQuota estimates available OPFS space and fails fast when
// the build is unlikely to fit. The engine needs three arenas at once:
// layer bodies, post-unpack writes, and the authored EROFS — together
// roughly 3–4× the compressed image size. On flounder:xfce that is ~8 GB
// against ~10.7 GB free, and every other edition is larger (#48).
//
// This gate rejects impossible builds before they consume time and
// quota half-way through (#156). It uses a conservative multiplier
// because the arenas scale with the uncompressed tree.
const MIN_FREE_GB = 9.5; // below this the smallest edition is at risk
function checkStorageQuota() {
  if (!navigator.storage?.estimate) return;
  navigator.storage.estimate().then(({ quota, usage }) => {
    const freeGB = (quota - usage) / 1e9;
    if (freeGB < MIN_FREE_GB) {
      log(`warning: only ${freeGB.toFixed(1)} GB free of ${(quota / 1e9).toFixed(1)} GB quota — some editions may not fit`);
      if (freeGB < 4.0) {
        log(`error: insufficient storage (${freeGB.toFixed(1)} GB free). Free space or use a Chromium-based browser that reports more quota.`);
      }
    }
  }).catch(() => {});
}

// finishIsoSink closes the sink and, for the OPFS spool, triggers the
// browser download from the disk-backed File. It tries to pipe through
// showSaveFilePicker first (zero JS-heap overhead), and falls back to a
// blob URL that is promptly revoked (tuna-os/iso-builder#47).
async function finishIsoSink(s, name) {
  await s.w.close();
  if (s.kind !== "opfs") return;

  const f = await s.fh.getFile();

  // Best path: pipe the OPFS file straight to a user-chosen file.
  // Zero renderer-memory overhead — the browser streams disk→disk.
  if (window.showSaveFilePicker) {
    try {
      const h = await showSaveFilePicker({ suggestedName: name, types: [{ description: "ISO image", accept: { "application/x-iso9660-image": [".iso"] } }] });
      const w = await h.createWritable();
      await f.stream().pipeTo(w);
      return;
    } catch (e) {
      if (e.name === "AbortError") return;
      // Fall through to blob-URL download on any other error (including
      // transient-activation expiry after a long build).
    }
  }

  // Fallback: blob URL from the OPFS File. Chromium serves these from
  // the OPFS backing store without buffering the whole file in JS heap;
  // the URL is revoked after the download has had time to start.
  const url = URL.createObjectURL(f);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 120_000);
}

// prepareDdi is the catalog fast-path: no pull, no unpack, no facts to
// detect — the Build button lights up immediately.
function prepareDdi(ch) {
  selectedDdi = ch;
  $("image").value = "";
  $("buildcard").classList.remove("hidden");
  $("postcard").classList.add("hidden");
  $("facts").classList.add("hidden");
  $("stage").textContent = `${ch.name} — DDI channel, no inspection needed. Ready to build.`;
  $("build").disabled = false;
  updateShare();
}

async function buildDdi(ch) {
  askNotify();
  $("build").disabled = true;
  $("postcard").classList.add("hidden");
  const label = ($("label").value || ch.id.toUpperCase()).toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  let stopWatch = () => {};
  try {
    if (typeof tboxBuildDdiIso !== "function") {
      throw new Error("this engine build has no DDI support (tboxBuildDdiIso missing) — hard-refresh to load the current tbox.wasm");
    }
    await loadWasm();
    stopWatch = watchEngineMemory();
    // The loader is a same-origin static asset (see sdboot-NOTICE.txt):
    // DDI artifact sets ship only a UKI, which cannot boot an ISO9660
    // verbatim — the engine extracts its kernel/initrd and drives them
    // through systemd-boot + a BLS entry with live kargs.
    log("fetching systemd-boot (static asset)…");
    const sb = await fetch("systemd-bootx64.efi");
    if (!sb.ok) throw new Error(`systemd-boot asset: ${sb.status}`);
    const sdboot = new Uint8Array(await sb.arrayBuffer());
    const base = `${SHIM}/ddi/${ch.id}`;
    log(`building from DDI channel ${ch.id} via ${base}`);
    const name = `${ch.id}-live.iso`;
    const s = await isoSink(name);
    if (!s) {
      log("Build cancelled by user.");
      $("stage").textContent = "Build cancelled.";
      return;
    }
    const t0 = performance.now();
    const bytes = await tboxBuildDdiIso({ base, stem: ch.stem, label, sdboot }, (u8) => {
      s.w.write(u8);
    });
    await finishIsoSink(s, name);
    const dt = ((performance.now() - t0) / 1000).toFixed(1);
    $("stage").textContent = `Done — ${(bytes / 1e9).toFixed(2)} GB in ${dt}s.`;
    notify("ISO ready 🐟", `${(bytes / 1e9).toFixed(2)} GB written in ${dt}s`);
    log(`iso written: ${bytes} bytes`);
    $("postcard").classList.remove("hidden");
  } catch (e) {
    log("error: " + e);
    if (/QuotaExceededError|quota exceeded/i.test(String(e))) {
      $("stage").textContent = "Build failed — storage quota exceeded.";
    } else if (/download stalled/i.test(String(e))) {
      $("stage").textContent = "Build failed — layer download stalled (try again; the browser may recover on a fresh page load).";
    } else {
      $("stage").textContent = "Build failed.";
    }
    notify("ISO build failed", String(e).slice(0, 120));
  } finally {
    stopWatch();
    $("build").disabled = false;
  }
}

async function build() {
  if (selectedDdi) return buildDdi(selectedDdi);
  updateShim();
  askNotify();
  $("build").disabled = true;
  $("postcard").classList.add("hidden");
  const label = ($("label").value || "TUNAOS").toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  let initrd = null;
  const iurl = $("initrdurl").value.trim();
  // flounder:xfce died here, not in inspect: EROFS/ESP/ISO authoring
  // allocates on top of the already-unpacked tree, so the build phase can
  // exhaust the address space even when the unpack fitted comfortably.
  let stopWatch = () => {};
  try {
    stopWatch = watchEngineMemory();
    if (iurl) {
      log("fetching tbox initramfs…");
      const r = await fetch(iurl);
      if (!r.ok) throw new Error(`initrd fetch: ${r.status}`);
      initrd = new Uint8Array(await r.arrayBuffer());
      log(`initramfs: ${(initrd.length / 1e6).toFixed(1)} MB`);
    } else {
      log("initramfs: auto (tbox overlay appended to the image's own initramfs)");
    }
    const name = `tunaos-${($("image").value.split("/").pop() || "image").replace(/[:]/g, "-")}.iso`;
    const s = await isoSink(name);
    if (!s) {
      log("Build cancelled by user.");
      $("stage").textContent = "Build cancelled.";
      return;
    }
    const t0 = performance.now();
    const flatpaks = fpCollect();
    const packages = pkgCollect();
    const extraRun = repoCmds.slice();
    const bytes = await tboxBuildIso({ label, initrd, flatpaks, packages, extraRun }, (u8) => {
      s.w.write(u8);
    });
    await finishIsoSink(s, name);
    const dt = ((performance.now() - t0) / 1000).toFixed(1);
    $("stage").textContent = `Done — ${(bytes / 1e9).toFixed(2)} GB in ${dt}s.`;
    notify("ISO ready 🐟", `${(bytes / 1e9).toFixed(2)} GB written in ${dt}s`);
    log(`iso written: ${bytes} bytes`);
    $("postcard").classList.remove("hidden");
  } catch (e) {
    log("error: " + e);
    if (/QuotaExceededError|quota exceeded/i.test(String(e))) {
      $("stage").textContent = "Build failed — storage quota exceeded.";
    } else if (/download stalled/i.test(String(e))) {
      $("stage").textContent = "Build failed — layer download stalled (try again; the browser may recover on a fresh page load).";
    } else {
      $("stage").textContent = "Build failed.";
    }
    notify("ISO build failed", String(e).slice(0, 120));
  } finally {
    stopWatch();
    $("build").disabled = false;
  }
}

function updateShare() {
  updateShim();
  const p = new URLSearchParams();
  if ($("image").value) p.set("image", $("image").value);
  const fl = fpCollect();
  if (fl.length) p.set("flatpaks", fl.join(","));
  const pk = pkgCollect();
  if (pk.length) p.set("packages", pk.join(","));
  if ($("label").value && $("label").value !== "TUNAOS") p.set("label", $("label").value);
  if ($("initrdurl").value) p.set("initrd", $("initrdurl").value);
  if ($("shimurl").value && $("shimurl").value !== "https://relay.tunaos.org") p.set("shim", $("shimurl").value);
  const qs = "?" + p.toString();
  $("share").textContent = qs;
  $("sharelink").href = location.origin + location.pathname + qs;
}

$("introspect").onclick = inspect;
$("build").onclick = build;
$("curated").onclick = loadCuratedSet;
$("addrepo").onclick = addRepo;
$("pkgsearch").addEventListener("input", (e) => {
  clearTimeout(pkgTimer);
  pkgTimer = setTimeout(() => pkgSearch(e.target.value.trim()), 350);
});
$("copyshare").onclick = async () => {
  await navigator.clipboard.writeText($("sharelink").href);
  $("copyshare").textContent = "Copied!";
  setTimeout(() => ($("copyshare").textContent = "Copy"), 1500);
};
for (const id of ["image", "label", "initrdurl", "shimurl"]) $(id).addEventListener("input", updateShare);
$("fpsearch").addEventListener("input", (e) => {
  clearTimeout(fpTimer);
  fpTimer = setTimeout(() => fpSearch(e.target.value.trim()), 300);
});

// ── Image picker (base variant × desktop) ─────────────────────────────────
// The intended TunaOS experience: pick a base + desktop, build a standard
// ISO — no image ref to type, no settings. Everything under "Advanced" is
// opt-in. Community desktops (kde/cosmic/niri/xfce) aren't published as ISOs,
// so the builder is the way to get them. Keep this list in sync with the
// image matrix published to ghcr.io/tuna-os (build-config.yml).
const DESKTOPS = {
  gnome:  { name: "GNOME",      emoji: "🦴" },
  kde:    { name: "KDE Plasma", emoji: "🌊" },
  cosmic: { name: "COSMIC",     emoji: "☄️" },
  niri:   { name: "Niri",       emoji: "🪟" },
  xfce:   { name: "XFCE",       emoji: "🐭" },
};
// DDI channels (tacklebox#172): mkosi/sysupdate split artifacts — a UKI
// plus an already-EROFS root partition. The catalog declares everything
// the build needs (base path on the relay, artifact stem, desktop), so
// there is NO inspection step: nothing exists to unpack until build
// time, and the declared facts are authoritative. This also sidesteps
// the wasm32 unpack/author ceiling entirely — the root streams through
// as-is. snowfield is the designated desktop channel; cayo is the small
// headless smoke channel.
const DDI_CHANNELS = [
  { id: "snowfield", stem: "snowfield-ab", name: "Frostyard Snowfield — GNOME (DDI)", desktop: "gnome" },
  { id: "snow",      stem: "snow-ab",      name: "Frostyard Snow — GNOME (DDI)",      desktop: "gnome" },
  { id: "cayo",      stem: "cayo-ab",      name: "Frostyard Cayo — headless (DDI)",   desktop: "none" },
];
let selectedDdi = null;

const VARIANTS = [
  { id: "yellowfin", name: "AlmaLinux Kitten 10 (flagship)", des: ["gnome", "kde", "cosmic", "niri"] },
  { id: "bonito",    name: "Fedora 44",                      des: ["gnome", "kde", "cosmic", "niri", "xfce"] },
  { id: "sailfin",   name: "openSUSE Tumbleweed",            des: ["gnome", "kde", "niri", "xfce"] },
  // No niri: ghcr.io/tuna-os/flounder:niri has never been published (404), and
  // flounder carries no niri flavor in tunaOS's build-config.yml. The chip was
  // offered anyway, so picking it started an inspect against a tag that does
  // not exist. scripts/verify-catalog.py now fails on refs like this.
  { id: "flounder",  name: "Debian 13 Trixie",               des: ["gnome", "kde", "cosmic", "xfce"] },
  { id: "grouper",   name: "Ubuntu 26.04",                   des: ["gnome", "kde", "niri", "xfce"] },
  { id: "marlin",    name: "Arch Linux",                     des: ["gnome", "kde", "cosmic", "niri", "xfce"] },
  { id: "skipjack",  name: "CentOS Stream 10",               des: ["gnome", "kde", "cosmic", "niri"] },
  { id: "albacore",  name: "AlmaLinux 10",                   des: ["gnome", "kde", "cosmic", "niri"] },
  { id: "guppy",     name: "Gentoo (source-based)",          des: ["gnome", "kde"] },
];
function currentVariant() {
  return VARIANTS.find((v) => v.id === $("variant").value) || VARIANTS[0];
}
function syncEditionSelection() {
  const box = $("editions");
  if (!box) return;
  const val = $("image").value.trim();
  for (const el of box.children)
    el.classList.toggle("selected", val === `${$("variant").value}:${el.dataset.de}`);
}
function renderEditions() {
  const box = $("editions");
  if (!box) return;
  box.innerHTML = "";
  // DDI variants: one chip, no inspect — the catalog already knows
  // everything (see DDI_CHANNELS).
  const ddi = DDI_CHANNELS.find((c) => `ddi:${c.id}` === $("variant").value);
  if (ddi) {
    const meta = DESKTOPS[ddi.desktop] || { name: "Headless", emoji: "🖥️" };
    const b = document.createElement("button");
    b.type = "button";
    b.className = "edition";
    b.dataset.de = ddi.desktop;
    b.innerHTML = `<span class="emoji">${meta.emoji}</span>${meta.name}<small>${ddi.id} · DDI</small>`;
    b.onclick = () => {
      prepareDdi(ddi); // one click → Build enabled, no inspection
      b.classList.add("selected");
    };
    box.appendChild(b);
    return;
  }
  const v = currentVariant();
  for (const de of v.des) {
    const meta = DESKTOPS[de] || { name: de, emoji: "🖥️" };
    const b = document.createElement("button");
    b.type = "button";
    b.className = "edition";
    b.dataset.de = de;
    b.innerHTML = `<span class="emoji">${meta.emoji}</span>${meta.name}<small>${v.id}</small>`;
    b.onclick = () => {
      selectedDdi = null;
      $("image").value = `${v.id}:${de}`;
      syncEditionSelection();
      updateShare();
      inspect(); // one click → inspect + reveal Build; no typing, no settings
    };
    box.appendChild(b);
  }
  syncEditionSelection();
}
// Populate the variant dropdown and wire re-render on change.
for (const v of VARIANTS) {
  const o = document.createElement("option");
  o.value = v.id;
  o.textContent = v.name;
  $("variant").appendChild(o);
}
for (const c of DDI_CHANNELS) {
  const o = document.createElement("option");
  o.value = `ddi:${c.id}`;
  o.textContent = c.name;
  $("variant").appendChild(o);
}
$("variant").addEventListener("change", renderEditions);
renderEditions();
$("image").addEventListener("input", () => {
  // Typing an image ref is the OCI path — a lingering DDI selection
  // would hijack the Build button.
  if ($("image").value.trim()) selectedDdi = null;
  syncEditionSelection();
});

// Apply URL params.
{
  const q = new URLSearchParams(location.search);
  if (q.get("image")) $("image").value = q.get("image");
  if (q.get("flatpaks")) for (const id of q.get("flatpaks").split(",").filter(Boolean)) fpAdd(id);
  if (q.get("packages")) for (const id of q.get("packages").split(",").filter(Boolean)) pkgAdd(id);
  if (q.get("label")) $("label").value = q.get("label");
  // ?shim= and ?initrd= change WHERE the ISO's contents come from (the
  // registry every layer is pulled from, and the embedded initramfs). A
  // shared link carrying them can silently point the build at an attacker
  // server while the UI still says "yellowfin:gnome" — a full host
  // compromise delivered by a link that looks like an ordinary share link
  // (iso-builder#114). They are therefore never applied from the URL; the
  // fields keep their defaults and the visitor must type a non-default
  // value themselves. The rest of the preset (image/flatpaks/packages/
  // label) still prefills as before.
  if (q.get("shim") || q.get("initrd")) {
    log("Ignored ?shim=/?initrd= from this link — supply-chain params are not applied from URLs (iso-builder#114). Set them manually if intended.");
  }
  updateShim();
  updateShare();
  // If a deep-linked image matches a known variant, reflect it in the picker.
  const vm = $("image").value.match(/^([a-z0-9-]+):/);
  if (vm && VARIANTS.some((v) => v.id === vm[1])) { $("variant").value = vm[1]; renderEditions(); }
  syncEditionSelection();
  // Deep links prefill only — a page load must never start a multi-GB
  // pull by itself. Opt into auto-run with &autorun=1, and only when the
  // link carries no supply-chain params (they are ignored anyway, but
  // autorun after that warning would be surprising).
  if (q.get("image") && q.get("autorun") === "1" && !q.get("shim") && !q.get("initrd")) inspect();
  // DDI deep link: ?ddi=snowfield selects the channel (no inspection to
  // run); &autorun=1 goes straight to the build — the future e2e hook.
  const dch = DDI_CHANNELS.find((c) => c.id === q.get("ddi"));
  if (dch) {
    $("variant").value = `ddi:${dch.id}`;
    renderEditions();
    prepareDdi(dch);
    if (q.get("autorun") === "1" && !q.get("shim") && !q.get("initrd")) buildDdi(dch);
  }
}

if (!window.showSaveFilePicker) {
  const note = $("browsernote");
  if (note) {
    note.textContent = "Note: Your browser does not support direct file saving (File System Access API). The ISO will be spooled inside browser storage first and then downloaded, which needs free disk space for two copies. For best results, use a Chromium-based browser (e.g. Chrome, Edge, Brave).";
    note.classList.remove("hidden");
  }
}

// ── Blob-download fetch wrapper (iso-builder#49) ─────────────────────────
// The Go wasm engine streams OCI blob bodies through fetch(), reading
// in 32 KB chunks and awaiting an OPFS write between each. When the
// OPFS write takes long enough Chrome's HTTP/2 receive window fills,
// the server stops sending, the engine declares a stall and abandons
// the stream, then reopens with a Range header to resume. That reopen
// fetch often hangs — no response headers within 60 s.
//
// The working theory (confirmed in curl, refuted for the relay): the
// abandoned stream leaves the HTTP/2 connection in a state where new
// streams never receive response headers. Adding a cache-busting query
// parameter to the reopen URL forces Chrome to use a fresh connection,
// sidestepping the poisoned one.
//
// This runs after wasm_exec.js has replaced window.fetch; it wraps
// whatever fetch is current (Go's streaming adapter or the native one)
// and only touches blob URLs, the one path that streams multi-MB bodies.
(function() {
  const _fetch = window.fetch;
  window.fetch = function(url, opts) {
    if (opts === undefined) opts = {};
    const urlStr = (typeof url === "string") ? url : ((url && url.url) ? url.url : String(url));
    if (!urlStr || !urlStr.includes("/blobs/")) return _fetch(url, opts);

    // Reopen requests carry a Range header — the engine is trying to
    // resume a stalled download. Adding a cache-busting query parameter
    // prevents Chrome from reusing the HTTP/2 connection that may have
    // been left in a bad state by the abandoned stream.
    const headers = opts.headers;
    if (headers) {
      const hasRange = Object.keys(headers).some(function(k) {
        return k.toLowerCase() === "range";
      });
      if (hasRange) {
        const sep = urlStr.includes("?") ? "&" : "?";
        url = urlStr + sep + "_tbox_retry=" + Date.now();
      }
    }
    return _fetch(url, opts);
  };
})();

globalThis.switchTab = (e, id) => {
  const container = e.target.closest(".card");
  for (const btn of container.querySelectorAll(".tab-btn")) {
    btn.classList.toggle("active", btn === e.target);
  }
  for (const content of container.querySelectorAll(".tab-content")) {
    content.classList.toggle("hidden", content.id !== `tab-${id}`);
  }
};

