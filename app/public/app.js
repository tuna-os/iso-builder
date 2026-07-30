/* TunaOS ISO Builder GUI — drives the tacklebox WASM engine (tbox.wasm).
 *
 * URL params (shareable presets, tunaOS#667):
 *   ?image=<repo:tag | host/repo:tag>   pre-fill + auto-inspect
 *   ?flatpaks=<comma-separated ids>     override the per-DE default list
 *   ?label=<VOLID>                      volume label
 *   ?initrd=<url>                       tbox-enabled initramfs to embed
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
      b.innerHTML = `+ <b>${h.pkg}</b> ${h.summary ? "— " + h.summary.slice(0, 60) : ""}` +
        (h.available ? `<span class="avail">✓ ${fam}</span>` : `<span class="unavail">not in ${fam}</span>`);
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

function watchEngineMemory() {
  let warned = false;
  let done = false;
  lastProgressAt = Date.now();
  const timer = setInterval(() => {
    const mb = globalThis.tboxWasmMB();
    if (mb < 0 || done) return;
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
    await loadWasm();
    stopWatch = watchEngineMemory();
    const { registry, image } = parseImage(raw);
    log(`inspecting ${image} via ${registry}`);
    facts = JSON.parse(await tboxIntrospect(image, registry));
    const f = $("facts");
    f.classList.remove("hidden");
    f.innerHTML = "";
    const add = (html, cls = "badge") => { const b = document.createElement("span"); b.className = cls; b.innerHTML = html; f.appendChild(b); };
    add(`desktop <b>${facts.desktop}</b>`, "badge de");
    add(`kernel <b>${facts.kernelVer || "none"}</b>`);
    add(`systemd-boot <b>${facts.hasSdBoot ? "in image" : "not shipped"}</b>`);
    if (facts.pkgManager) add(`packaging <b>${facts.pkgManager}</b>`);
    add(`<b>${facts.fileCount.toLocaleString()}</b> files`);
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

async function build() {
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
    let sink, chunks = [];
    const autodl = new URLSearchParams(location.search).get("autodl");
    if (window.showSaveFilePicker && !autodl) {
      try {
        const h = await showSaveFilePicker({ suggestedName: name, types: [{ description: "ISO image", accept: { "application/x-iso9660-image": [".iso"] } }] });
        sink = await h.createWritable();
      } catch (e) {
        if (e.name === "AbortError") {
          log("Build cancelled by user.");
          $("stage").textContent = "Build cancelled.";
          return;
        }
        else throw e;
      }
    }
    const t0 = performance.now();
    const flatpaks = fpCollect();
    const packages = pkgCollect();
    const extraRun = repoCmds.slice();
    const bytes = await tboxBuildIso({ label, initrd, flatpaks, packages, extraRun }, (u8) => {
      if (sink) sink.write(u8); else chunks.push(u8.slice());
    });
    if (sink) await sink.close();
    else {
      const blob = new Blob(chunks, { type: "application/x-iso9660-image" });
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
      a.click();
    }
    const dt = ((performance.now() - t0) / 1000).toFixed(1);
    $("stage").textContent = `Done — ${(bytes / 1e9).toFixed(2)} GB in ${dt}s.`;
    notify("ISO ready 🐟", `${(bytes / 1e9).toFixed(2)} GB written in ${dt}s`);
    log(`iso written: ${bytes} bytes`);
    $("postcard").classList.remove("hidden");
  } catch (e) {
    log("error: " + e);
    $("stage").textContent = "Build failed.";
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
const VARIANTS = [
  { id: "yellowfin", name: "AlmaLinux Kitten 10 (flagship)", des: ["gnome", "kde", "cosmic", "niri"] },
  { id: "bonito",    name: "Fedora 44",                      des: ["gnome", "kde", "cosmic", "niri", "xfce"] },
  { id: "sailfin",   name: "openSUSE Tumbleweed",            des: ["gnome", "kde", "niri", "xfce"] },
  { id: "flounder",  name: "Debian 13 Trixie",               des: ["gnome", "kde", "cosmic", "niri", "xfce"] },
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
  const v = currentVariant();
  box.innerHTML = "";
  for (const de of v.des) {
    const meta = DESKTOPS[de] || { name: de, emoji: "🖥️" };
    const b = document.createElement("button");
    b.type = "button";
    b.className = "edition";
    b.dataset.de = de;
    b.innerHTML = `<span class="emoji">${meta.emoji}</span>${meta.name}<small>${v.id}</small>`;
    b.onclick = () => {
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
$("variant").addEventListener("change", renderEditions);
renderEditions();
$("image").addEventListener("input", syncEditionSelection);

// Apply URL params.
{
  const q = new URLSearchParams(location.search);
  if (q.get("image")) $("image").value = q.get("image");
  if (q.get("flatpaks")) for (const id of q.get("flatpaks").split(",").filter(Boolean)) fpAdd(id);
  if (q.get("packages")) for (const id of q.get("packages").split(",").filter(Boolean)) pkgAdd(id);
  if (q.get("label")) $("label").value = q.get("label");
  if (q.get("initrd")) $("initrdurl").value = q.get("initrd");
  if (q.get("shim")) $("shimurl").value = q.get("shim");
  updateShim();
  updateShare();
  // If a deep-linked image matches a known variant, reflect it in the picker.
  const vm = $("image").value.match(/^([a-z0-9-]+):/);
  if (vm && VARIANTS.some((v) => v.id === vm[1])) { $("variant").value = vm[1]; renderEditions(); }
  syncEditionSelection();
  // Deep links prefill only — a page load must never start a multi-GB
  // pull by itself. Opt into auto-run with &autorun=1.
  if (q.get("image") && q.get("autorun") === "1") inspect();
}

if (!window.showSaveFilePicker) {
  const note = $("browsernote");
  if (note) {
    note.textContent = "Warning: Your browser does not support streaming downloads (File System Access API). The ISO will be buffered in memory first, which might crash on large images. For best results, use a Chromium-based browser (e.g. Chrome, Edge, Brave) or enable direct file saving.";
    note.classList.remove("hidden");
  }
}

globalThis.switchTab = (e, id) => {
  const container = e.target.closest(".card");
  for (const btn of container.querySelectorAll(".tab-btn")) {
    btn.classList.toggle("active", btn === e.target);
  }
  for (const content of container.querySelectorAll(".tab-content")) {
    content.classList.toggle("hidden", content.id !== `tab-${id}`);
  }
};

