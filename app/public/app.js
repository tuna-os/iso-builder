/* TunaOS ISO Builder GUI — drives the tacklebox WASM engine (tbox.wasm).
 *
 * URL params (shareable presets, tunaOS#667):
 *   ?image=<repo:tag | host/repo:tag>   pre-fill + auto-inspect
 *   ?variant=<id>&flavor=<de>&platform=<linux/amd64|linux/amd64/v2|linux/arm64>
 *   ?flatpaks=<comma-separated ids>     override the per-DE default list
 *   ?packages=<comma-separated pkgs>    system packages via remora
 *   ?label=<VOLID>                      volume label
 *
 * ?shim= and ?initrd= are NOT accepted from URLs (iso-builder#114): they
 * would let a shared link swap the registry every layer is pulled from and
 * the embedded initramfs, so a link could build a weaponized "official"
 * ISO. Non-default shim/initrd must be typed by hand.
 *
 * ?image= is held to the same rule for the same reason (iso-builder#167). A
 * host-qualified reference is dialled directly by parseImage, bypassing the
 * relay and its org allowlist, so the host inside the image value is a
 * registry swap wearing a different parameter name. Only refs that resolve
 * to the default relay are applied from a URL; ?packages= and ?flatpaks=
 * are character-checked before they reach the engine.
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
// are one pick away (see CURATED_SETS).
const FLATPAK_DEFAULTS = {
  gnome: ["io.github.kolunmi.Bazaar", "org.mozilla.firefox", "org.gnome.TextEditor"],
  kde: ["io.github.kolunmi.Bazaar", "org.mozilla.firefox", "org.kde.kate"],
  xfce: ["io.github.kolunmi.Bazaar", "org.mozilla.firefox", "org.gnome.TextEditor"],
  cosmic: ["io.github.kolunmi.Bazaar", "org.mozilla.firefox"],
  niri: ["io.github.kolunmi.Bazaar", "org.mozilla.firefox"],
  none: [],
};

// Upstream curated sets, fetched live so they track upstream without
// redeploys. `desktops` names the desktops each set is curated for: once
// the image's desktop is known, the picker lists the matching sets first
// and selects the first of them (iso-builder#192). Bluefin curates GNOME
// apps, and the other GTK desktops (xfce, cosmic) sit closer to that set
// than to Aurora's Qt one. Zirconium is the niri set.
const BLUEFIN_BREW = "https://raw.githubusercontent.com/projectbluefin/common/main/system_files/bluefin/usr/share/ublue-os/homebrew/";
const AURORA_BREW = "https://raw.githubusercontent.com/get-aurora-dev/common/main/system_files/shared/usr/share/ublue-os/homebrew/";
const ZIRCONIUM_PREINSTALL = "https://raw.githubusercontent.com/zirconium-dev/zirconium/main/mkosi.extra/usr/share/flatpak/preinstall.d/zirconium.preinstall";
const CURATED_SETS = [
  { id: "bluefin-system", label: "Bluefin core apps", desktops: ["gnome", "xfce", "cosmic"], url: BLUEFIN_BREW + "system-flatpaks.Brewfile" },
  { id: "bluefin-full", label: "Bluefin full desktop", desktops: ["gnome", "xfce", "cosmic"], url: BLUEFIN_BREW + "full-desktop.Brewfile" },
  { id: "bluefin-dx", label: "Bluefin developer apps", desktops: ["gnome", "xfce", "cosmic"], url: BLUEFIN_BREW + "system-dx-flatpaks.Brewfile" },
  { id: "aurora-system", label: "Aurora core apps", desktops: ["kde"], url: AURORA_BREW + "system-flatpaks.Brewfile" },
  { id: "aurora-full", label: "Aurora full desktop", desktops: ["kde"], url: AURORA_BREW + "full-desktop.Brewfile" },
  { id: "aurora-dx", label: "Aurora developer apps", desktops: ["kde"], url: AURORA_BREW + "system-dx-flatpaks.Brewfile" },
  { id: "zirconium", label: "Zirconium apps", desktops: ["niri"], url: ZIRCONIUM_PREINSTALL },
];

function parseCuratedSet(text) {
  const ids = [...text.matchAll(/^flatpak "([^"]+)"/gm)].map((m) => m[1]);
  for (const m of text.matchAll(/^\[Flatpak Preinstall ([^\]\s]+)\]([^[]*)/gm)) {
    if (!/^IsRuntime\s*=\s*true/im.test(m[2])) ids.push(m[1]);
  }
  return ids.filter((id) => URL_FLATPAK_ID.test(id));
}

function curatedSetsFor(desktop) {
  return {
    matched: CURATED_SETS.filter((s) => s.desktops.includes(desktop)),
    other: CURATED_SETS.filter((s) => !s.desktops.includes(desktop)),
  };
}

function renderCuratedSets(desktop) {
  const sel = $("curatedset");
  if (!sel) return;
  const { matched, other } = curatedSetsFor(desktop);
  sel.innerHTML = "";
  const group = (label, sets) => {
    if (!sets.length) return;
    const g = document.createElement("optgroup");
    g.label = label;
    for (const s of sets) g.appendChild(new Option(s.label, s.id));
    sel.appendChild(g);
  };
  if (matched.length) {
    group(`For ${DESKTOPS[desktop]?.name || desktop}`, matched);
    group("Other desktops", other);
  } else {
    group("All sets", other);
  }
  sel.value = (matched[0] || other[0]).id;
}

async function loadCuratedSet() {
  const set = CURATED_SETS.find((s) => s.id === $("curatedset").value) || CURATED_SETS[0];
  $("curated").disabled = true;
  try {
    const r = await fetch(set.url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const ids = parseCuratedSet(await r.text());
    for (const id of ids) fpAdd(id);
    log(`added ${ids.length} apps from the ${set.label} set`);
    syncOperationOptions();
    updateShare();
  } catch (e) {
    log("curated set fetch failed: " + e);
  } finally {
    $("curated").disabled = false;
  }
}

const $ = (id) => document.getElementById(id);

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
  if (!box) return;
  box.innerHTML = "";
  for (const [id, v] of fpItems) {
    const label = document.createElement("label");
    const cb = Object.assign(document.createElement("input"), { type: "checkbox", checked: v.checked });
    cb.onchange = () => { v.checked = cb.checked; syncOperationOptions(); updateShare(); };
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
  syncOperationOptions();
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
const log = (m) => {
  const el = $("log");
  if (!el) return;
  el.textContent += m + "\n";
  el.scrollTop = 1e9;
};

let facts = null;
let wasmReady = null;
let wasmNativeIntrospect = null;
let wasmNativeBuildIso = null;
let wasmNativeBuildIsoWithResult = null;

// System packages (remora) + custom repo/setup commands (extra_run).
const pkgItems = new Map();  // pkg -> {checked, summary}
const repoCmds = [];         // extra_run lines

function pkgAdd(id, summary = "") {
  if (!pkgItems.has(id)) pkgItems.set(id, { checked: true, summary });
  pkgRender();
}
function pkgRender() {
  const box = $("pkglist");
  if (!box) return;
  box.innerHTML = "";
  for (const [id, v] of pkgItems) {
    const label = document.createElement("label");
    const cb = Object.assign(document.createElement("input"), { type: "checkbox", checked: v.checked });
    cb.onchange = () => { v.checked = cb.checked; syncOperationOptions(); updateShare(); };
    label.appendChild(cb);
    const span = document.createElement("span");
    span.textContent = id;
    label.appendChild(span);
    box.appendChild(label);
  }
  syncOperationOptions();
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
  } catch {
    $("pkgresults").innerHTML = "<span style='font-size:.8rem;color:var(--dim)'>package search unavailable</span>";
  }
}

function repoRender() {
  const box = $("repolist");
  if (!box) return;
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
  syncOperationOptions();
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

let wasmMemory = null;
globalThis.tboxWasmMB = () => (wasmMemory ? wasmMemory.buffer.byteLength / 1048576 : -1);

globalThis.tboxJsHeapMB = () => {
  if (typeof performance !== "undefined" && performance.memory && performance.memory.usedJSHeapSize) {
    return performance.memory.usedJSHeapSize / 1048576;
  }
  return -1;
};

function defaultLoadWasm() {
  if (wasmReady) return wasmReady;
  const go = new Go();
  wasmReady = WebAssembly.instantiateStreaming(fetch("tbox.wasm"), go.importObject)
    .then((r) => {
      wasmMemory = r.instance.exports.mem || go.mem || null;
      go.run(r.instance);
      wasmNativeIntrospect = globalThis.tboxIntrospect || null;
      wasmNativeBuildIso = globalThis.tboxBuildIso || null;
      wasmNativeBuildIsoWithResult = globalThis.tboxBuildIsoWithResult || null;
      observeEngineResets();
      log("engine loaded (tacklebox wasm)");
    });
  return wasmReady;
}
function loadWasm() {
  return defaultLoadWasm();
}
window.loadWasm = loadWasm;

let lastProgressAt = 0;
globalThis.tboxOnProgress = (stage, i, n) => {
  $("stage").textContent = {
    resolve: "Resolving manifest…",
    unpack: `Unpacking layer ${i}/${n}`,
    overlay: "Applying live overlay…",
    initrd: "Appending tbox initramfs overlay…",
    erofs: "Authoring EROFS live root…",
    esp: "Authoring EFI system partition…",
    iso: "Streaming ISO…",
  }[stage] || stage;
  $("bar").max = n; $("bar").value = i;
  lastProgressAt = Date.now();
};

const WASM32_LIMIT_MB = 4096;
const WASM_WARN_MB = 3400;
const WASM_WEDGED_MB = 3900;
const WEDGE_AFTER_MS = 120_000;
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
        const op = currentOp || rebuildCurrentOperation("failed");
        clearBuildResult();
        op.state = "failed";
        op.ready = false;
        op.error = msg;
        if ($("build")) $("build").disabled = true;
        if ($("postcard")) $("postcard").classList.add("hidden");
        renderFallbackCard(op, `${msg} Build this exact target locally using tacklebox purebuild:`);
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

// ── Image picker & unified BuildRequest v1 operation state ───────────────
const DESKTOPS = {
  gnome:  { name: "GNOME" },
  kde:    { name: "KDE Plasma" },
  cosmic: { name: "COSMIC" },
  niri:   { name: "Niri" },
  xfce:   { name: "XFCE" },
};

const DDI_CHANNELS = [
  { id: "snowfield", stem: "snowfield-ab", name: "Frostyard Snowfield — GNOME (DDI)", desktop: "gnome" },
  { id: "snow",      stem: "snow-ab",      name: "Frostyard Snow — GNOME (DDI)",      desktop: "gnome" },
  { id: "cayo",      stem: "cayo-ab",      name: "Frostyard Cayo — headless (DDI)",   desktop: "none" },
];
let selectedDdi = null;

const VARIANTS = [
  { id: "yellowfin", name: "AlmaLinux Kitten 10 (flagship)", des: ["gnome", "kde", "cosmic", "niri", "xfce"] },
  { id: "bonito",    name: "Fedora 44",                      des: ["gnome", "kde", "cosmic", "niri", "xfce"] },
  { id: "sailfin",   name: "openSUSE Tumbleweed",            des: ["gnome", "kde", "cosmic", "niri", "xfce"] },
  { id: "flounder",  name: "Debian 13 Trixie",               des: ["kde", "xfce"] },
  { id: "grouper",   name: "Ubuntu 26.04",                   des: ["gnome", "kde", "cosmic", "xfce"] },
  { id: "marlin",    name: "Arch Linux",                     des: ["gnome", "kde", "cosmic", "niri", "xfce"] },
  { id: "skipjack",  name: "CentOS Stream 10",               des: ["gnome", "kde", "cosmic", "niri", "xfce"] },
  { id: "albacore",  name: "AlmaLinux 10",                   des: ["gnome", "kde", "cosmic", "niri", "xfce"] },
  { id: "guppy",     name: "Gentoo (source-based)",          des: ["kde", "xfce"] },
];

const ALMA_VARIANTS = new Set(["yellowfin", "albacore"]);
const NATIVE_V3_VARIANTS = new Set(["skipjack", "wahoo"]);
const VALID_PLATFORMS = new Set(["linux/amd64", "linux/amd64/v2", "linux/arm64"]);

function defaultPlatformForVariant(variantId) {
  return ALMA_VARIANTS.has(variantId) ? "linux/amd64/v2" : "linux/amd64";
}

function normalizePlatformForVariant(variantId, platform) {
  const p = VALID_PLATFORMS.has(platform) ? platform : defaultPlatformForVariant(variantId);
  if (!variantId) return p;
  if (ALMA_VARIANTS.has(variantId) && p === "linux/amd64") return "linux/amd64/v2";
  if (!ALMA_VARIANTS.has(variantId) && p === "linux/amd64/v2") return "linux/amd64";
  return p;
}

function cpuBaselineForTarget(variantId, platform) {
  if (platform === "linux/arm64") return "armv8-a";
  if (platform === "linux/amd64/v2") return "x86-64-v2";
  if (NATIVE_V3_VARIANTS.has(variantId)) return "x86-64-v3";
  return "x86-64";
}

function hardwareScopeForFlavor(flavor) {
  const parts = String(flavor || "").split("-");
  if (parts.includes("asahi")) return "apple-silicon";
  if (parts.includes("t2")) return "apple-t2";
  return "generic";
}

function platformSlug(platform) {
  return String(platform || "linux/amd64").replace(/^linux\//, "").replace(/\//g, "-");
}

function currentPlatform() {
  const el = $("platform");
  const vid = $("variant")?.value || "yellowfin";
  if (!el || !VALID_PLATFORMS.has(el.value)) {
    return defaultPlatformForVariant(vid.replace(/^ddi:/, ""));
  }
  return el.value;
}

function findCatalogEntry(variantId, flavorId, platform) {
  if (!catalogSnapshot || !Array.isArray(catalogSnapshot.targets)) return null;
  const normPlat = normalizePlatformForVariant(variantId, platform);
  const exactKey = `${variantId}:${flavorId}:${normPlat}`;
  for (const entry of catalogSnapshot.targets) {
    if (entry.targetKey === exactKey) return entry;
    if (
      entry.target &&
      entry.target.variant === variantId &&
      entry.target.flavor === flavorId &&
      entry.target.platform === normPlat
    ) {
      return entry;
    }
  }
  const ref = `ghcr.io/tuna-os/${variantId}:${flavorId}`;
  for (const entry of catalogSnapshot.targets) {
    if (entry.publication?.ref === ref && entry.target?.platform === normPlat) {
      return entry;
    }
  }
  return null;
}

function parseCuratedTunaRef(raw) {
  const s = String(raw || "").trim();
  if (!s || !s.includes(":")) return null;
  let stripped = s;
  if (stripped.startsWith("ghcr.io/")) stripped = stripped.slice("ghcr.io/".length);
  if (stripped.startsWith("tuna-os/")) stripped = stripped.slice("tuna-os/".length);
  else if (stripped.includes("/")) return null;
  const idx = stripped.lastIndexOf(":");
  if (idx <= 0 || idx === stripped.length - 1) return null;
  const variant = stripped.slice(0, idx);
  const flavor = stripped.slice(idx + 1);
  if (!/^[a-z0-9-]+$/.test(variant) || !/^[a-z0-9-]+$/.test(flavor)) return null;
  return { variant, flavor };
}

function deepFreeze(obj) {
  if (!obj || typeof obj !== "object" || Object.isFrozen(obj)) return obj;
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    deepFreeze(obj[key]);
  }
  return obj;
}

let operationSeq = 0;
let currentOp = null;
let activeBusyPhase = null;
let buildResultRevision = 0;
const observedResetFunctions = new WeakSet();
const pendingEngineResets = new Set();

function clearBuildResult() {
  buildResultRevision++;
  if (currentOp) {
    currentOp.buildResult = null;
    currentOp.outputDelivery = null;
    currentOp.buildAttempt = null;
  }
  if ($("postcard")) $("postcard").classList.add("hidden");
}

function observeEngineResets() {
  for (const name of ["tboxReset", "tboxResetAsync"]) {
    const reset = globalThis[name];
    if (typeof reset !== "function" || observedResetFunctions.has(reset)) continue;
    const wrapped = function (...args) {
      const busyRejection = error => String(error) === "tacklebox operation already in progress" ||
        String(error) === "Error: tacklebox operation already in progress";
      let result;
      try { result = Reflect.apply(reset, this, args); }
      catch (error) {
        if (!busyRejection(error)) clearBuildResult();
        throw error;
      }
      if (!result || typeof result.then !== "function") {
        clearBuildResult();
        return result; // preserve the legacy synchronous null return
      }
      // Do not leave a completed receipt usable while an async reset is
      // unresolved. An active build has no public result; it waits below.
      if (currentOp?.state === "completed") clearBuildResult();
      const pending = Promise.resolve(result).then(value => {
        clearBuildResult();
        return value;
      }, error => {
        // Busy rejection changes no engine state. Cleanup failure means a
        // reset was accepted and cleared state, so it invalidates the result.
        if (!busyRejection(error)) clearBuildResult();
        throw error;
      });
      pendingEngineResets.add(pending);
      pending.then(() => pendingEngineResets.delete(pending), () => pendingEngineResets.delete(pending));
      return pending;
    };
    observedResetFunctions.add(wrapped);
    globalThis[name] = wrapped;
  }
}

function isOperationBusy() {
  return Boolean(activeBusyPhase);
}

function setOperationBusy(busy, phase = null) {
  activeBusyPhase = busy ? (phase || "busy") : null;
  for (const id of ["variant", "platform", "image", "introspect", "clearcache"]) {
    const el = $(id);
    if (el) el.disabled = Boolean(busy);
  }
  const box = $("editions");
  if (box) {
    for (const btn of box.querySelectorAll("button.edition")) {
      btn.disabled = Boolean(busy);
    }
  }
}

function buildRequestFromForm(existingOp = null) {
  updateShim();
  const rawInput = ($("image")?.value || "").trim();
  const vSel = ($("variant")?.value || "yellowfin").replace(/^ddi:/, "");
  const defaultRef = rawInput || `${vSel}:${(currentVariant()?.des?.[0] || "gnome")}`;
  const { registry, image } = parseImage(defaultRef);
  const label = (($("label")?.value || "TUNAOS").toUpperCase().replace(/[^A-Z0-9_]/g, "_")) || "TUNAOS";
  const flatpaks = fpCollect();
  const packages = pkgCollect();
  const extraRun = repoCmds.slice();

  const parsedTuna = parseCuratedTunaRef(defaultRef);
  const isBaseFlavor = Boolean(parsedTuna && (parsedTuna.flavor === "base" || parsedTuna.flavor.startsWith("base-")));
  const plat = parsedTuna
    ? normalizePlatformForVariant(parsedTuna.variant, currentPlatform())
    : currentPlatform();
  const catalogEntry = (parsedTuna && !isBaseFlavor)
    ? findCatalogEntry(parsedTuna.variant, parsedTuna.flavor, plat)
    : null;

  let customImage = true;
  let target = undefined;
  let resolvedInputs = undefined;
  let qualification = { status: "unqualified", reason: "custom-image-unqualified" };
  let qualificationId = "";
  let outputFilename = `tunaos-${(defaultRef.split("/").pop() || "image").replace(/[:/]/g, "-")}.iso`;

  if (catalogEntry) {
    customImage = false;
    target = {
      variant: catalogEntry.target.variant,
      flavor: catalogEntry.target.flavor,
      platform: catalogEntry.target.platform,
      cpuBaseline: catalogEntry.target.cpuBaseline || cpuBaselineForTarget(catalogEntry.target.variant, catalogEntry.target.platform),
      hardwareScope: catalogEntry.target.hardwareScope || hardwareScopeForFlavor(catalogEntry.target.flavor),
    };
    const ri = catalogEntry.resolvedInputs || {};
    resolvedInputs = {
      platformManifestDigest: ri.platformManifestDigest || "",
      indexDigest: ri.indexDigest || "",
      configDigest: ri.configDigest || "",
      liveOverlayDigest: ri.liveOverlayDigest || "",
      liveOverlayBaseDigest: ri.liveOverlayBaseDigest || "",
      installerRevision: ri.installerRevision || "",
      engineRevision: ri.engineRevision || "",
    };
    qualification = catalogQualification(catalogEntry);
    if (qualification.status === "qualified" && qualification.receiptDigest) {
      qualificationId = qualification.receiptDigest;
    }
    outputFilename = `tunaos-${target.variant}-${target.flavor}-${platformSlug(target.platform)}.iso`;
  } else if (existingOp?.resolvedDigest) {
    resolvedInputs = {
      platformManifestDigest: existingOp.resolvedDigest,
    };
  }

  const request = {
    schemaVersion: 1,
    kind: "build-request",
    customImage,
    image,
    registry,
    ...(target ? { target } : {}),
    ...(resolvedInputs ? { resolvedInputs } : {}),
    options: {
      label,
      packages,
      flatpaks,
      extraRun,
      outputFilename,
    },
    catalogVersion: catalogSnapshot?.snapshotDigest || "",
    ...(qualificationId ? { qualificationId } : {}),
  };

  return {
    request: deepFreeze(request),
    catalogEntry,
    qualification,
    platform: target ? target.platform : plat,
    rawImage: rawInput,
  };
}

function rebuildCurrentOperation(state = "idle") {
  clearBuildResult();
  const built = buildRequestFromForm();
  currentOp = {
    id: ++operationSeq,
    state,
    ready: false,
    inspectedVia: null,
    storageBlocked: false,
    error: null,
    buildResult: null,
    outputDelivery: null,
    buildAttempt: null,
    ...built,
  };
  globalThis.tboxCurrentOperation = currentOp;
  return currentOp;
}

function syncOperationOptions() {
  if (!currentOp) {
    rebuildCurrentOperation("idle");
    return currentOp;
  }
  const built = buildRequestFromForm(currentOp);
  if (JSON.stringify(currentOp.request) !== JSON.stringify(built.request)) clearBuildResult();
  currentOp.request = built.request;
  globalThis.tboxCurrentOperation = currentOp;
  if (!$("fallbackcard")?.classList.contains("hidden")) {
    renderFallbackCard(currentOp);
  }
  updatePostcardFilename(currentOp.request.options.outputFilename);
  return currentOp;
}

function operationMatchesForm(op) {
  if (!op || !op.request) return false;
  const rawInput = ($("image")?.value || "").trim();
  if (!rawInput) return false;
  const { registry, image } = parseImage(rawInput);
  if (op.request.image !== image || op.request.registry !== registry) return false;
  const parsedTuna = parseCuratedTunaRef(rawInput);
  const wantPlat = parsedTuna
    ? normalizePlatformForVariant(parsedTuna.variant, currentPlatform())
    : currentPlatform();
  if (op.request.target?.platform && op.request.target.platform !== wantPlat) return false;
  if (op.platform && op.platform !== wantPlat) return false;
  return true;
}

function invalidateOperation(reason = "selection-changed") {
  facts = null;
  const wasReadyOrInspected = Boolean(currentOp && (currentOp.ready || currentOp.state !== "idle"));
  rebuildCurrentOperation("idle");
  if ($("build")) $("build").disabled = true;
  if ($("postcard")) $("postcard").classList.add("hidden");
  if ($("facts")) {
    $("facts").classList.add("hidden");
    $("facts").innerHTML = "";
  }
  if (wasReadyOrInspected && $("buildcard") && !$("buildcard").classList.contains("hidden")) {
    $("stage").textContent = "Selection changed — inspect image to continue.";
  }
  if (!$("fallbackcard")?.classList.contains("hidden")) {
    renderFallbackCard(currentOp);
  }
  return reason;
}

function renderFallbackCard(op = currentOp, reasonText = "") {
  const card = $("fallbackcard");
  if (!card) return;
  const activeOp = op || rebuildCurrentOperation("idle");
  const reqJson = JSON.stringify(activeOp.request, null, 2);
  const cmd = "tacklebox purebuild --request build-request.json";
  if ($("fallbackcmd")) $("fallbackcmd").textContent = cmd;
  if ($("fallbackjson")) $("fallbackjson").textContent = reqJson;
  if ($("fallbackreason") && reasonText) {
    $("fallbackreason").textContent = reasonText;
  } else if ($("fallbackreason")) {
    $("fallbackreason").textContent = "Export the pinned BuildRequest v1 contract to build this exact target locally without browser memory or storage limits.";
  }
  card.classList.remove("hidden");
}

function updatePostcardFilename(filename) {
  const ddTab = $("tab-dd");
  if (!ddTab || !filename) return;
  const code = ddTab.querySelector("pre code");
  if (code) {
    code.textContent = `sudo dd if=path/to/${filename} of=/dev/sdX bs=4M status=progress oflag=sync`;
  }
}

globalThis.tboxGetBuildRequest = () => {
  if (!currentOp || !operationMatchesForm(currentOp)) {
    return buildRequestFromForm(currentOp).request;
  }
  syncOperationOptions();
  return currentOp.request;
};

globalThis.tboxExportBuildRequestJSON = () => JSON.stringify(globalThis.tboxGetBuildRequest(), null, 2);

function renderFactsBadges(fObj, op) {
  const f = $("facts");
  if (!f) return;
  f.classList.remove("hidden");
  f.innerHTML = "";
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
  add("desktop ", fObj.desktop || "none", "", "badge de");
  add("kernel ", fObj.kernelVer || "none");
  add("systemd-boot ", fObj.hasSdBoot ? "in image" : "not shipped");
  if (fObj.pkgManager) add("packaging ", fObj.pkgManager);
  if (typeof fObj.fileCount === "number" && fObj.fileCount > 0) {
    add("", fObj.fileCount.toLocaleString(), " files");
  }
  if (typeof fObj.layerCount === "number" && fObj.layerCount > 0) {
    add("layers ", fObj.layerCount);
  }
  if (typeof fObj.compressedSize === "number" && fObj.compressedSize > 0) {
    add("size ", (fObj.compressedSize / 1e9).toFixed(2), " GB");
  }
  if (op?.request?.target?.platform) {
    add("platform ", op.request.target.platform, "", "badge platform");
  }
  if (op?.qualification?.status) {
    const st = op.qualification.status;
    const rsn = op.qualification.reason ? ` (${op.qualification.reason})` : "";
    add("status ", st, rsn, "badge status");
  }
  if (op?.request?.resolvedInputs?.platformManifestDigest) {
    add("digest ", op.request.resolvedInputs.platformManifestDigest.slice(0, 19) + "…", "", "badge digest");
  }
}

function applyDetectedDesktopAndPackaging(fObj) {
  if (fpItems.size === 0) {
    for (const id of FLATPAK_DEFAULTS[fObj.desktop] || []) fpAdd(id);
  }
  renderCuratedSets(fObj.desktop);
  if (fObj.pkgManager) {
    $("pkgsearch").placeholder = `Search packages (${fObj.pkgManager} · ${fObj.repoFamily})…`;
    const kinds = { fedora: "copr", debian: "ppa", opensuse: "obs" };
    if (kinds[fObj.repoFamily]) $("repokind").value = kinds[fObj.repoFamily];
  }
}

async function inspect() {
  if (isOperationBusy()) return;
  selectedDdi = null; // inspecting an image ref is the OCI path
  updateShim();
  const raw = $("image").value.trim();
  if (!raw.includes(":")) { log("image must be <repo>:<tag>"); return; }
  askNotify();

  const parsedTuna = parseCuratedTunaRef(raw);
  if (parsedTuna && $("platform")) {
    const normPlat = normalizePlatformForVariant(parsedTuna.variant, $("platform").value);
    if ($("platform").value !== normPlat) $("platform").value = normPlat;
  }

  const op = rebuildCurrentOperation("inspecting");
  const releaseLease = globalThis.tboxLayerCache?.acquireBuildLease?.(`inspect-${op.id}`) || (() => {});
  setOperationBusy(true, "inspect");
  $("buildcard").classList.remove("hidden");
  $("postcard").classList.add("hidden");
  $("build").disabled = true;
  let stopWatch = () => {};
  try {
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
    if (navigator.storage?.estimate) {
      const { quota, usage } = await navigator.storage.estimate();
      log(`storage quota ≈ ${((quota - usage) / 1e9).toFixed(1)} GB free`);
    }
    const quotaStatus = await checkStorageQuota(op);

    const hasTestStub =
      (typeof window.tboxIntrospect === "function" && window.tboxIntrospect !== wasmNativeIntrospect) ||
      (typeof window.loadWasm === "function" && window.loadWasm !== loadWasm);

    if (!hasTestStub) {
      await loadCatalogSnapshot();
      const refreshed = buildRequestFromForm(op);
      Object.assign(op, refreshed);
    }

    if (!hasTestStub && op.catalogEntry) {
      globalThis.tboxLayerCache?.setPrefetchEnabled?.(false);
      const entry = op.catalogEntry;
      const qual = op.qualification || { status: "unqualified", reason: "untested-snapshot" };
      log(`inspecting ${op.request.image} (${op.request.target.platform}) from catalog snapshot ${String(op.request.catalogVersion).slice(0, 19)}…`);

      if (entry.availability?.available && entry.facts) {
        facts = { ...entry.facts };
        renderFactsBadges(facts, op);
        applyDetectedDesktopAndPackaging(facts);
        syncOperationOptions();
      } else {
        facts = {
          desktop: entry.facts?.desktop || entry.target?.flavor || "none",
          kernelVer: entry.facts?.kernelVer || "none",
          hasSdBoot: Boolean(entry.facts?.hasSdBoot),
          pkgManager: entry.facts?.pkgManager || "",
          repoFamily: entry.facts?.repoFamily || "",
          layerCount: entry.facts?.layerCount || 0,
          compressedSize: entry.facts?.compressedSize || 0,
        };
        renderFactsBadges(facts, op);
        applyDetectedDesktopAndPackaging(facts);
        syncOperationOptions();
      }

      if (qual.status === "qualified" && !quotaStatus.blocked) {
        op.state = "ready";
        op.ready = true;
        op.inspectedVia = "catalog";
        $("stage").textContent = "Image inspected — ready to build.";
        notify("Image inspected", `${raw}: ${facts.desktop} desktop, ready to build`);
        $("build").disabled = false;
        renderFallbackCard(op);
      } else {
        op.state = "blocked";
        op.ready = false;
        op.storageBlocked = quotaStatus.blocked;
        $("build").disabled = true;
        const reason = quotaStatus.blocked
          ? `insufficient browser storage (${quotaStatus.freeGB.toFixed(1)} GB free)`
          : `${qual.status}${qual.reason ? ` (${qual.reason})` : ""}`;
        $("stage").textContent = `Browser build unavailable: ${reason} — use local fallback below.`;
        log(`browser build gated for ${op.request.image} (${op.request.target.platform}): ${reason}`);
        renderFallbackCard(op, `Browser build is gated for this target (${reason}). Run the exact pinned target locally:`);
      }
      updateShare();
      return;
    }

    await window.loadWasm();
    stopWatch = watchEngineMemory();
    const { registry, image } = parseImage(raw);
    log(`inspecting ${image} via ${registry}`);
    if (!hasTestStub) {
      globalThis.tboxLayerCache?.setPrefetchEnabled?.(true);
    }
    facts = JSON.parse(await window.tboxIntrospect(image, registry, op.platform, op.request));
    renderFactsBadges(facts, op);
    applyDetectedDesktopAndPackaging(facts);
    syncOperationOptions();
    if (quotaStatus.blocked) {
      op.state = "blocked";
      op.ready = false;
      op.storageBlocked = true;
      $("stage").textContent = `Browser build unavailable: insufficient storage (${quotaStatus.freeGB.toFixed(1)} GB free) — use local fallback below.`;
      $("build").disabled = true;
      renderFallbackCard(op, `Insufficient browser storage (${quotaStatus.freeGB.toFixed(1)} GB free). Build locally with tacklebox purebuild:`);
    } else {
      op.state = "ready";
      op.ready = true;
      op.inspectedVia = "wasm";
      $("stage").textContent = "Image inspected — ready to build.";
      notify("Image inspected", `${raw}: ${facts.desktop} desktop, ready to build`);
      $("build").disabled = false;
      renderFallbackCard(op);
    }
    updateShare();
  } catch (e) {
    op.state = "failed";
    op.ready = false;
    op.error = String(e);
    log("error: " + e);
    if (/digest mismatch/.test(String(e))) log("a downloaded layer does not match its digest — clear it under Advanced → Clear downloaded layers, then try again");
    $("stage").textContent = "Inspect failed.";
    renderFallbackCard(op, `Inspect failed in browser (${String(e)}). You can still run the local fallback:`);
    notify("Inspect failed", String(e).slice(0, 120));
  } finally {
    stopWatch();
    releaseLease();
    setOperationBusy(false, "inspect");
    $("build").disabled = !op.ready;
    showCacheSize();
  }
}

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

const MIN_FREE_GB = 9.5;
async function checkStorageQuota(op = currentOp) {
  if (!navigator.storage?.estimate) return { freeGB: Infinity, blocked: false };
  try {
    const { quota, usage } = await navigator.storage.estimate();
    const freeGB = (quota - usage) / 1e9;
    if (freeGB < MIN_FREE_GB) {
      log(`warning: only ${freeGB.toFixed(1)} GB free of ${(quota / 1e9).toFixed(1)} GB quota — some editions may not fit`);
      if (freeGB < 4.0) {
        log(`error: insufficient storage (${freeGB.toFixed(1)} GB free). Free space or use a Chromium-based browser that reports more quota.`);
        renderFallbackCard(op, `Insufficient browser storage (${freeGB.toFixed(1)} GB free). Use the local CLI fallback:`);
        return { freeGB, blocked: true };
      }
    }
    return { freeGB, blocked: false };
  } catch {
    return { freeGB: Infinity, blocked: false };
  }
}

async function finishIsoSink(s, name) {
  await s.w.close();
  if (s.kind !== "opfs") return { kind: "picker", status: "stream-closed" };

  const f = await s.fh.getFile();

  if (window.showSaveFilePicker) {
    let h;
    try {
      h = await showSaveFilePicker({ suggestedName: name, types: [{ description: "ISO image", accept: { "application/x-iso9660-image": [".iso"] } }] });
    } catch (e) {
      // A cancelled save is not success. An unavailable picker (for example,
      // lost transient activation after a long build) can still download.
      if (e.name === "AbortError") throw e;
      log("save picker unavailable; starting browser download: " + e);
    }
    if (h) {
      const w = await h.createWritable();
      await f.stream().pipeTo(w);
      return { kind: "picker", status: "stream-closed" };
    }
  }

  const url = URL.createObjectURL(f);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 120_000);
  // The page cannot observe persistence of an <a download>. The diagnostic
  // collector independently saves and hashes its download before joining it.
  return { kind: "download", status: "initiated" };
}

function prepareDdi(ch) {
  if (isOperationBusy()) return;
  clearBuildResult();
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
  if (isOperationBusy()) return;
  clearBuildResult();
  askNotify();
  const releaseLease = globalThis.tboxLayerCache?.acquireBuildLease?.(`ddi-${ch.id}`) || (() => {});
  setOperationBusy(true, "build");
  $("build").disabled = true;
  $("postcard").classList.add("hidden");
  const label = ($("label").value || ch.id.toUpperCase()).toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  let stopWatch = () => {};
  let s = null;
  try {
    if (typeof tboxBuildDdiIso !== "function") {
      throw new Error("this engine build has no DDI support (tboxBuildDdiIso missing) — hard-refresh to load the current tbox.wasm");
    }
    await window.loadWasm();
    stopWatch = watchEngineMemory();
    log("fetching systemd-boot (static asset)…");
    const sb = await fetch("systemd-bootx64.efi");
    if (!sb.ok) throw new Error(`systemd-boot asset: ${sb.status}`);
    const sdboot = new Uint8Array(await sb.arrayBuffer());
    const base = `${SHIM}/ddi/${ch.id}`;
    log(`building from DDI channel ${ch.id} via ${base}`);
    const name = `${ch.id}-live.iso`;
    s = await isoSink(name);
    if (!s) {
      log("Build cancelled by user.");
      $("stage").textContent = "Build cancelled.";
      return;
    }
    const t0 = performance.now();
    const bytes = await tboxBuildDdiIso({ base, stem: ch.stem, label, sdboot }, (u8) => s.w.write(u8));
    await finishIsoSink(s, name);
    updatePostcardFilename(name);
    const dt = ((performance.now() - t0) / 1000).toFixed(1);
    $("stage").textContent = `Done — ${(bytes / 1e9).toFixed(2)} GB in ${dt}s.`;
    notify("ISO ready 🐟", `${(bytes / 1e9).toFixed(2)} GB written in ${dt}s`);
    log(`iso written: ${bytes} bytes`);
    $("postcard").classList.remove("hidden");
  } catch (e) {
    if (s?.w?.abort) {
      await s.w.abort().catch(() => {});
    }
    $("postcard").classList.add("hidden");
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
    releaseLease();
    setOperationBusy(false, "build");
    $("build").disabled = false;
  }
}

async function build() {
  if (selectedDdi) return buildDdi(selectedDdi);
  if (isOperationBusy()) return;
  clearBuildResult();
  updateShim();
  askNotify();

  if (!currentOp || !currentOp.ready || !operationMatchesForm(currentOp)) {
    log("error: target selection changed or was not inspected — inspect the selected image before building");
    $("stage").textContent = "Inspect required before building.";
    $("build").disabled = true;
    return;
  }

  syncOperationOptions();
  const op = currentOp;
  const req = op.request;
  const releaseLease = globalThis.tboxLayerCache?.acquireBuildLease?.(`build-${op.id}`) || (() => {});
  setOperationBusy(true, "build");
  $("build").disabled = true;
  $("postcard").classList.add("hidden");
  op.state = "building";
  op.error = null;
  const resultRevision = buildResultRevision;
  op.buildAttempt = resultRevision;

  const label = req.options.label;
  let initrd = null;
  const iurl = $("initrdurl").value.trim();
  let stopWatch = () => {};
  let s = null;
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
    const name = req.options.outputFilename || `tunaos-${($("image").value.split("/").pop() || "image").replace(/[:]/g, "-")}.iso`;
    s = await isoSink(name);
    if (!s) {
      op.state = "ready";
      log("Build cancelled by user.");
      $("stage").textContent = "Build cancelled.";
      return;
    }

    const hasBuildStub =
      (typeof window.tboxBuildIso === "function" && window.tboxBuildIso !== wasmNativeBuildIso) ||
      (typeof window.tboxBuildIsoWithResult === "function" && window.tboxBuildIsoWithResult !== wasmNativeBuildIsoWithResult);
    if (!hasBuildStub) {
      await window.loadWasm();
    }
    observeEngineResets();
    if (op.inspectedVia === "catalog") {
      globalThis.tboxLayerCache?.setPrefetchEnabled?.(true);
      if (typeof window.tboxIntrospect === "function") {
        log(`resolving and unpacking pinned target ${req.image} (${req.target?.platform || op.platform})…`);
        await window.tboxIntrospect(req);
        op.inspectedVia = "wasm";
      }
    }

    const t0 = performance.now();
    const flatpaks = req.options.flatpaks.slice();
    const packages = req.options.packages.slice();
    const extraRun = req.options.extraRun.slice();
    const withResult = typeof window.tboxBuildIsoWithResult === "function";
    const buildIso = withResult ? window.tboxBuildIsoWithResult : window.tboxBuildIso;
    let writtenBytes = 0;
    const result = await buildIso(
      { label, initrd, flatpaks, packages, extraRun, request: req },
      async (u8) => {
        if (!(u8 instanceof Uint8Array) || !Number.isSafeInteger(writtenBytes + u8.byteLength)) {
          throw new Error("invalid ISO sink byte count");
        }
        const size = u8.byteLength;
        await s.w.write(u8);
        writtenBytes += size;
      },
    );
    // Engine observations remain private until both engine output and the
    // browser save/close complete. Never backfill them from the BuildRequest.
    const pendingResult = withResult ? deepFreeze(tboxValidateBuildResult(result, writtenBytes)) : null;
    const bytes = withResult ? pendingResult.bytesWritten : result;
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes !== writtenBytes) {
      throw new Error("invalid ISO build byte count");
    }
    const outputDelivery = await finishIsoSink(s, name);
    while (pendingEngineResets.size) await Promise.allSettled([...pendingEngineResets]);
    if (currentOp !== op || resultRevision !== buildResultRevision || !operationMatchesForm(op)) {
      throw new Error("build selection changed before save completed");
    }
    updatePostcardFilename(name);
    op.state = "completed";
    op.buildResult = pendingResult;
    op.outputDelivery = deepFreeze(outputDelivery);
    const dt = ((performance.now() - t0) / 1000).toFixed(1);
    $("stage").textContent = `Done — ${(bytes / 1e9).toFixed(2)} GB in ${dt}s.`;
    notify("ISO ready 🐟", `${(bytes / 1e9).toFixed(2)} GB written in ${dt}s`);
    log(`iso written: ${bytes} bytes`);
    $("postcard").classList.remove("hidden");
  } catch (e) {
    if (s?.w?.abort) {
      await s.w.abort().catch(() => {});
    }
    clearBuildResult();
    op.buildResult = null;
    op.state = "failed";
    op.error = String(e);
    $("postcard").classList.add("hidden");
    log("error: " + e);
    if (/digest mismatch/.test(String(e))) log("a downloaded layer does not match its digest — clear it under Advanced → Clear downloaded layers, then try again");
    if (/QuotaExceededError|quota exceeded/i.test(String(e))) {
      $("stage").textContent = "Build failed — storage quota exceeded.";
    } else if (/download stalled/i.test(String(e))) {
      $("stage").textContent = "Build failed — layer download stalled (try again; the browser may recover on a fresh page load).";
    } else if (/sink write/i.test(String(e))) {
      $("stage").textContent = "Build failed — sink write error.";
    } else {
      $("stage").textContent = "Build failed.";
    }
    renderFallbackCard(op, `Browser build failed (${String(e)}). Build this exact target locally with tacklebox purebuild:`);
    notify("ISO build failed", String(e).slice(0, 120));
  } finally {
    stopWatch();
    releaseLease();
    setOperationBusy(false, "build");
    $("build").disabled = !op.ready;
    showCacheSize();
  }
}

function updateShare() {
  updateShim();
  const p = new URLSearchParams();
  if ($("image").value) p.set("image", $("image").value);
  const vid = ($("variant")?.value || "yellowfin").replace(/^ddi:/, "");
  const plat = currentPlatform();
  if ($("image").value && plat !== defaultPlatformForVariant(vid)) {
    p.set("platform", plat);
  }
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
renderCuratedSets(null);
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
if ($("downloadrequest")) {
  $("downloadrequest").onclick = () => {
    const json = globalThis.tboxExportBuildRequestJSON();
    const blob = new Blob([json + "\n"], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href: url, download: "build-request.json" });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };
}
if ($("copyfallback")) {
  $("copyfallback").onclick = async () => {
    const payload = `cat <<'EOF' > build-request.json\n${globalThis.tboxExportBuildRequestJSON()}\nEOF\ntacklebox purebuild --request build-request.json`;
    await navigator.clipboard.writeText(payload);
    $("copyfallback").textContent = "Copied!";
    setTimeout(() => ($("copyfallback").textContent = "Copy command & request"), 1500);
  };
}
for (const id of ["label", "initrdurl"]) {
  $(id)?.addEventListener("input", () => {
    clearBuildResult();
    syncOperationOptions();
    updateShare();
  });
}
$("shimurl")?.addEventListener("input", () => {
  invalidateOperation("shim-changed");
  updateShare();
});
$("fpsearch").addEventListener("input", (e) => {
  clearTimeout(fpTimer);
  fpTimer = setTimeout(() => fpSearch(e.target.value.trim()), 300);
});

function currentVariant() {
  return VARIANTS.find((v) => v.id === $("variant").value) || VARIANTS[0];
}
function syncEditionSelection() {
  const box = $("editions");
  if (!box) return;
  const val = $("image").value.trim();
  const parsed = parseCuratedTunaRef(val);
  for (const el of box.children) {
    const matches = parsed
      ? parsed.variant === $("variant").value && parsed.flavor === el.dataset.de
      : val === `${$("variant").value}:${el.dataset.de}`;
    el.classList.toggle("selected", matches);
  }
}
function renderEditions() {
  const box = $("editions");
  if (!box) return;
  box.innerHTML = "";
  const ddi = DDI_CHANNELS.find((c) => `ddi:${c.id}` === $("variant").value);
  if (ddi) {
    const meta = DESKTOPS[ddi.desktop] || { name: "Headless" };
    const b = document.createElement("button");
    b.type = "button";
    b.className = "edition";
    b.dataset.de = ddi.desktop;
    b.innerHTML = `${meta.name}<small>${ddi.id} · DDI</small>`;
    b.onclick = () => {
      if (isOperationBusy()) return;
      prepareDdi(ddi);
      b.classList.add("selected");
    };
    box.appendChild(b);
    return;
  }
  const v = currentVariant();
  const plat = normalizePlatformForVariant(v.id, currentPlatform());
  for (const de of v.des) {
    const meta = DESKTOPS[de] || { name: de };
    const entry = findCatalogEntry(v.id, de, plat);
    const qualStatus = catalogQualification(entry).status;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "edition";
    b.dataset.de = de;
    b.dataset.platform = plat;
    b.dataset.status = qualStatus;
    const subLabel = qualStatus === "qualified" ? v.id : `${v.id} · ${qualStatus}`;
    b.innerHTML = `${meta.name}<small>${subLabel}</small>`;
    b.onclick = () => {
      if (isOperationBusy()) return;
      selectedDdi = null;
      $("image").value = `${v.id}:${de}`;
      syncEditionSelection();
      invalidateOperation("edition-selected");
      updateShare();
      inspect();
    };
    box.appendChild(b);
  }
  syncEditionSelection();
}

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
if ($("platform")) {
  $("platform").value = defaultPlatformForVariant($("variant").value);
  $("platform").addEventListener("change", () => {
    if (isOperationBusy()) return;
    renderEditions();
    invalidateOperation("platform-changed");
    updateShare();
  });
}
$("variant").addEventListener("change", () => {
  if (isOperationBusy()) return;
  const vId = $("variant").value.replace(/^ddi:/, "");
  if ($("platform") && $("platform").value !== "linux/arm64") {
    $("platform").value = defaultPlatformForVariant(vId);
  }
  renderEditions();
  invalidateOperation("variant-changed");
  updateShare();
});
renderEditions();
$("image").addEventListener("input", () => {
  if (isOperationBusy()) return;
  if ($("image").value.trim()) selectedDdi = null;
  const parsed = parseCuratedTunaRef($("image").value);
  if (parsed && VARIANTS.some((v) => v.id === parsed.variant)) {
    if ($("variant").value !== parsed.variant) {
      $("variant").value = parsed.variant;
      if ($("platform") && $("platform").value !== "linux/arm64") {
        $("platform").value = defaultPlatformForVariant(parsed.variant);
      }
      renderEditions();
    }
  }
  syncEditionSelection();
  invalidateOperation("image-changed");
  updateShare();
});

function urlImageUsesDefaultRegistry(raw) {
  const s = raw.trim();
  if (!s.includes("/")) return true;
  const firstSeg = s.split("/")[0];
  if (!firstSeg.includes(".") && !firstSeg.includes(":")) return true;
  return firstSeg === "ghcr.io";
}

const SUPPLY_CHAIN_PARAMS = ["shim", "initrd"];
const URL_FLATPAK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const URL_PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

// Apply URL params.
{
  const q = new URLSearchParams(location.search);
  let imageRejected = false;
  const urlVariant = q.get("variant");
  const urlFlavor = q.get("flavor") || q.get("de");
  const urlPlatform = q.get("platform");

  if (urlVariant && VARIANTS.some((v) => v.id === urlVariant)) {
    $("variant").value = urlVariant;
    if ($("platform")) {
      $("platform").value = defaultPlatformForVariant(urlVariant);
    }
  }
  if (urlPlatform && VALID_PLATFORMS.has(urlPlatform) && $("platform")) {
    $("platform").value = urlPlatform;
  }
  if (q.get("image")) {
    if (urlImageUsesDefaultRegistry(q.get("image"))) {
      $("image").value = q.get("image");
    } else {
      imageRejected = true;
      log("Ignored ?image= from this link — it names a non-default registry, and supply-chain params are not applied from URLs (iso-builder#114, #167). Type it into the image field if that is intended.");
    }
  } else if (urlFlavor && /^[a-z0-9-]+$/.test(urlFlavor)) {
    const vId = $("variant").value.replace(/^ddi:/, "");
    $("image").value = `${vId}:${urlFlavor}`;
  }
  if (q.get("flatpaks")) for (const id of q.get("flatpaks").split(",").filter(Boolean)) {
    if (URL_FLATPAK_ID.test(id)) fpAdd(id);
    else log("Ignored ?flatpaks= entry from this link — not a Flatpak application id.");
  }
  if (q.get("packages")) for (const id of q.get("packages").split(",").filter(Boolean)) {
    if (URL_PACKAGE_NAME.test(id)) pkgAdd(id);
    else log("Ignored ?packages= entry from this link — not a package name.");
  }
  if (q.get("label")) $("label").value = q.get("label");
  if (SUPPLY_CHAIN_PARAMS.some((k) => q.get(k))) {
    log("Ignored ?shim=/?initrd= from this link — supply-chain params are not applied from URLs (iso-builder#114). Set them manually if intended.");
  }
  const parsedImg = parseCuratedTunaRef($("image").value);
  if (parsedImg && VARIANTS.some((v) => v.id === parsedImg.variant)) {
    $("variant").value = parsedImg.variant;
    if ($("platform") && !urlPlatform) {
      $("platform").value = normalizePlatformForVariant(parsedImg.variant, $("platform").value);
    }
  }
  renderEditions();
  syncEditionSelection();
  rebuildCurrentOperation("idle");
  updateShim();
  updateShare();

  const autorunAllowed =
    q.get("autorun") === "1" && !SUPPLY_CHAIN_PARAMS.some((k) => q.get(k)) && !imageRejected;
  if ($("image").value && autorunAllowed) inspect();
  const dch = DDI_CHANNELS.find((c) => c.id === q.get("ddi"));
  if (dch) {
    $("variant").value = `ddi:${dch.id}`;
    renderEditions();
    prepareDdi(dch);
    if (autorunAllowed) buildDdi(dch);
  }
}

loadCatalogSnapshot();

if (!window.showSaveFilePicker) {
  const note = $("browsernote");
  if (note) {
    note.textContent = "Note: Your browser does not support direct file saving (File System Access API). The ISO will be spooled inside browser storage first and then downloaded, which needs free disk space for two copies. For best results, use a Chromium-based browser (e.g. Chrome, Edge, Brave).";
    note.classList.remove("hidden");
  }
}

// ── Layer cache controls (iso-builder#191) ────────────────────────────────
async function showCacheSize() {
  if (!globalThis.tboxLayerCache) return;
  const { layers, bytes } = await tboxLayerCache.size().catch(() => ({ layers: 0, bytes: 0 }));
  $("cachestat").textContent = layers ? `${layers} layers, ${(bytes / 1e9).toFixed(2)} GB` : "empty";
}
$("clearcache").onclick = async () => {
  if (isOperationBusy() || globalThis.tboxLayerCache?.hasActiveLease?.()) {
    log("cannot clear downloaded layers while an operation is active");
    return;
  }
  $("clearcache").disabled = true;
  try {
    const res = await tboxLayerCache.clear();
    if (res && res.cleared === false) {
      log("cannot clear downloaded layers while an operation is active");
    } else {
      log("layer cache cleared");
    }
    await showCacheSize();
  } finally {
    $("clearcache").disabled = isOperationBusy();
  }
};
showCacheSize();

globalThis.switchTab = (e, id) => {
  const container = e.target.closest(".card");
  for (const btn of container.querySelectorAll(".tab-btn")) {
    btn.classList.toggle("active", btn === e.target);
  }
  for (const content of container.querySelectorAll(".tab-content")) {
    content.classList.toggle("hidden", content.id !== `tab-${id}`);
  }
};
