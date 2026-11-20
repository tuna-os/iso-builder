/* One-click download: pick a desktop (and optionally a base), press one
 * button, get an ISO. Everything else lives in the full builder, one click
 * away under "Customize".
 *
 * The button's route for the selected catalog target, in order:
 *   1. browser:  the catalog carries a complete qualification receipt
 *                (catalogQualification) AND this browser can build it
 *                (capability() below). Built in this tab with the default
 *                apps, exactly as the full builder would.
 *   2. prebuilt: download.tunaos.org publishes an ISO for it. Unqualified
 *                targets keep their prebuilt path (spec
 *                on-demand-live-iso-parity, "Safe per-target cutover").
 *   3. app:      TunaOS Media Writer, the native app that builds the ISO on
 *                this computer and writes the USB stick, has a release for
 *                this operating system.
 *   4. local:    none of the above; the full builder's build-on-your-computer
 *                instructions.
 * On a phone there is no route: it says a PC and a USB stick are needed and
 * offers to send the link to that computer.
 * Whenever Media Writer has a release for this OS it is also offered under
 * the button as the second action, with this image's build-request.json for
 * the app's "Open build request…" and, from Media Writer 0.2.0 on, a deep
 * link that opens the app on this image (tunaos-media-writer://build?target=
 * <catalog target id>, desktop/PROTOCOL.md).
 * Prebuilt ISOs and app releases come from downloads.json, generated from the
 * published index and the GitHub release at deploy time
 * (scripts/generate-downloads.py); a missing file only removes routes 2-3.
 *
 * Runs after app.js and reads its script-scope state (guidedModel,
 * guidedPicker, inspect, build, ...). Quick mode is only offered by a guided,
 * buildable deployment, on the bare URL or on a link naming only a TunaOS
 * image (index.html's TBOX_QUICK_IMAGE, as tunaos.org links), which opens on
 * that desktop and base. Any other query parameter (a share link,
 * ?customize=1, a test preset), or an image this view does not offer, opens
 * the full builder unchanged. */
(function () {
  'use strict';
  if (!document.querySelector) return;
  const root = document.documentElement;
  const $q = (id) => document.getElementById(id);
  if (!$q('quick')) return;

  const QUICK_PLATFORM = 'linux/amd64';
  const offered = GUIDED && !BUILDER_CONFIG.preview_only;
  const OS = detectOs();
  const OS_NAMES = { macos: 'macOS', windows: 'Windows', linux: 'Linux' };
  const APP_NAME = 'TunaOS Media Writer';
  let downloads = { prebuilt: {}, mediaWriter: null };
  const loaded = fetch('downloads.json', { tboxMetadataOnly: true })
    .then((r) => (r.ok ? r.json() : null))
    .then((doc) => {
      if (doc?.schemaVersion !== 1) return;
      downloads = { prebuilt: doc.prebuilt && typeof doc.prebuilt === 'object' ? doc.prebuilt : {}, mediaWriter: doc.mediaWriter || null };
    })
    .catch(() => {});
  // The full builder's "build on your own machine" card leads with the app.
  loaded.then(() => {
    const asset = appAsset();
    if (!asset || !$q('fallback-app')) return;
    Object.assign($q('fallback-app-link'), { href: asset.url, textContent: `${APP_NAME} for ${OS_NAMES[OS.id]}` });
    $q('fallback-app').hidden = false;
  });
  $q('quick-back').hidden = !offered;
  if (!offered || (location.search !== '' && !globalThis.TBOX_QUICK_IMAGE)) { root.classList.remove('quick'); return; }
  // The image a tunaos.org link names, until the first render resolves it.
  let preselect = globalThis.TBOX_QUICK_IMAGE || null;

  let capable = initialCapability();
  let desktop = null, base = null, busy = false;
  // Every download here is for a PC; a Mac with an Apple chip cannot start
  // it. Only Chromium tells the processor ('arm' or 'x86'); in any other Mac
  // browser it stays null and the note covers both.
  let macArch = null;
  if (OS.id === 'macos' && navigator.userAgentData?.getHighEntropyValues) {
    navigator.userAgentData.getHighEntropyValues(['architecture'])
      .then((values) => { macArch = values.architecture || null; render(); })
      .catch(() => {});
  }

  function detectOs() {
    const ua = navigator.userAgent || '';
    const platform = (navigator.userAgentData?.platform || navigator.platform || '').toLowerCase();
    if (navigator.userAgentData?.mobile || /Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return { id: 'mobile' };
    if (/mac/.test(platform) || /Macintosh/.test(ua)) return { id: 'macos', asset: 'macos' };
    if (/win/.test(platform) || /Windows/.test(ua)) return { id: 'windows', asset: 'windows-x64' };
    if (/linux|cros|x11/.test(platform) || /Linux|CrOS/.test(ua)) {
      return { id: 'linux', asset: /aarch64|arm64|armv8/i.test(`${platform} ${ua}`) ? 'linux-aarch64' : 'linux-x86_64' };
    }
    return { id: 'other' };
  }

  // What can be known without asking the browser for anything.
  function initialCapability() {
    if (OS.id === 'mobile') return { ok: false, reason: 'Open this page on the computer you want to install on.' };
    if (typeof WebAssembly !== 'object' || !navigator.storage?.getDirectory) {
      return { ok: false, reason: 'This browser can’t build ISO files.' };
    }
    // The engine is 32-bit WebAssembly and can use up to 4 GiB.
    if (typeof navigator.deviceMemory === 'number' && navigator.deviceMemory < 4) {
      return { ok: false, reason: 'This browser doesn’t have enough memory to build it.' };
    }
    return { ok: true };
  }

  // Storage the build needs: MIN_FREE_GB (app.js) for the layer cache, and
  // the same again when the ISO has to be spooled before it can be saved.
  async function measureCapability() {
    if (!capable.ok || !navigator.storage?.estimate) return;
    try {
      const { quota, usage } = await navigator.storage.estimate();
      if (!Number.isFinite(quota) || !Number.isFinite(usage)) return;
      const free = (quota - usage) / 1e9;
      const need = window.showSaveFilePicker ? MIN_FREE_GB : MIN_FREE_GB * 2;
      if (free < need) capable = { ok: false, reason: `This browser can use only ${free.toFixed(1)} GB of storage; building needs about ${Math.ceil(need)} GB.` };
    } catch { /* unknown is not a refusal; inspect() checks again */ }
  }

  const facetLabel = (facet, id) => guidedModel?.facetPresentation[facet]?.values.find((v) => v.id === id)?.label || id;
  const gb = (bytes) => `${(bytes / 1e9).toFixed(1)} GB`;

  // Plain, generic, amd64 images only: hardware-specific and driver editions
  // need a choice the full builder explains.
  function quickLeaves() {
    if (!guidedModel) return [];
    return guidedModel.leaves.filter((leaf) => leaf.selectable && leaf.source.kind === 'target' &&
      leaf.facets.platform?.includes(QUICK_PLATFORM) && leaf.facets.edition?.includes('standard') &&
      leaf.facets.hardware?.includes('generic') && leaf.facets.desktop?.length === 1 &&
      leaf.facets.base?.length === 1 && leaf.facets.desktop[0] !== 'none');
  }

  const prebuiltFor = (leaf) => leaf && downloads.prebuilt[`${leaf.entry.target.variant}-${leaf.entry.target.flavor}`];
  function appAsset() { return (OS.asset && downloads.mediaWriter?.assets?.[OS.asset]) || null; }
  // tunaos-media-writer:// links open the app from 0.2.0 on; an older app
  // registers no handler, and the browser drops the link without a word.
  const DEEP_LINK_SINCE = [0, 2, 0];
  function appOpensLinks() {
    const parts = String(downloads.mediaWriter?.version || '').split(/[.-]/).slice(0, 3).map(Number);
    if (parts.length < 3 || parts.some((n) => !Number.isInteger(n))) return false;
    const at = parts.findIndex((n, i) => n !== DEEP_LINK_SINCE[i]);
    return at < 0 || parts[at] > DEEP_LINK_SINCE[at];
  }
  const qualified = (leaf) => Boolean(leaf) && catalogQualification(leaf.entry).status === 'qualified';

  // A phone cannot install TunaOS, and a multi-GB ISO on it helps no one.
  function route(leaf) {
    if (OS.id === 'mobile') return { kind: 'mobile' };
    if (!leaf) return { kind: 'local' };
    if (qualified(leaf) && capable.ok) return { kind: 'browser' };
    const iso = prebuiltFor(leaf);
    if (iso) return { kind: 'prebuilt', iso };
    const asset = appAsset();
    if (asset) return { kind: 'app', asset };
    return { kind: 'local' };
  }

  function basesFor(leaves, de) {
    const order = guidedModel.facetPresentation.base?.values.map((v) => v.id) || [];
    return leaves.filter((l) => l.facets.desktop[0] === de)
      .sort((a, b) => order.indexOf(a.facets.base[0]) - order.indexOf(b.facets.base[0]));
  }

  const defaultLeaf = () => (guidedModel.defaultSelection.kind === 'leaf'
    ? guidedModel.leaves.find((l) => l.id === guidedModel.defaultSelection.leaf_id) : null);

  // A desktop's default base: the deployment default when it offers this
  // desktop, else the first base the browser can build, else the first with
  // a ready-made ISO, else the first listed.
  function defaultBase(candidates) {
    const preferred = defaultLeaf()?.facets.base?.[0];
    return (candidates.find((l) => l.facets.base[0] === preferred) ||
      candidates.find((l) => route(l).kind === 'browser') ||
      candidates.find((l) => route(l).kind === 'prebuilt') || candidates[0])?.facets.base[0] || null;
  }

  function selectedLeaf() {
    return quickLeaves().find((l) => l.facets.desktop[0] === desktop && l.facets.base[0] === base) || null;
  }

  // What an unsigned app costs the user on first launch, in their OS's words.
  // Linux gets #quick-app-linux instead: a Flatpak bundle is never
  // store-signed, and stock Ubuntu has no Flatpak to open it with.
  const FIRST_LAUNCH_HINTS = {
    macos: 'First launch: if macOS blocks the app, choose Open Anyway in System Settings → Privacy & Security.',
    windows: 'If Windows SmartScreen warns you, choose More info, then Run anyway.',
  };

  function appLinks(asset) {
    const other = $q('quick-app-other');
    other.replaceChildren();
    const rest = Object.entries(downloads.mediaWriter?.assets || {}).filter(([key]) => key !== OS.asset);
    if (!rest.length) return;
    other.append('Also for ');
    rest.forEach(([key, value], index) => {
      if (index) other.append(' · ');
      const link = Object.assign(document.createElement('a'), { href: value.url, textContent: assetLabel(key) });
      other.append(link);
    });
    if (asset) other.append('.');
  }

  function assetLabel(key) {
    return { macos: 'macOS', 'windows-x64': 'Windows', 'linux-x86_64': 'Linux', 'linux-aarch64': 'Linux (ARM)' }[key] || key;
  }

  // The catalog target a link names: its target id, or the image it is
  // published as (flounder-sid:gnome publishes as flounder:gnome-sid).
  const names = (leaf, image) => (leaf.entry.target.variant === image.variant && leaf.entry.target.flavor === image.flavor) ||
    leaf.entry.publication?.ref === `ghcr.io/tuna-os/${image.variant}:${image.flavor}`;

  function render() {
    // Once the full builder is showing, its own selection is the user's.
    if (!root.classList.contains('quick')) return;
    const leaves = quickLeaves();
    const desktops = (guidedModel?.facetPresentation.desktop?.values || []).filter((v) => leaves.some((l) => l.facets.desktop[0] === v.id));
    if (!desktops.length) { leaveQuick(); return; }
    if (preselect) {
      const named = leaves.find((l) => names(l, preselect));
      if (!named) { leaveQuick(); return; }
      preselect = null;
      desktop = named.facets.desktop[0];
      base = named.facets.base[0];
    }
    if (!desktops.some((d) => d.id === desktop)) {
      const preferred = defaultLeaf()?.facets.desktop?.[0];
      desktop = desktops.some((d) => d.id === preferred) ? preferred : desktops[0].id;
      base = null;
    }
    const candidates = basesFor(leaves, desktop);
    if (!candidates.some((l) => l.facets.base[0] === base)) base = defaultBase(candidates);

    const grid = $q('quick-desktops');
    grid.replaceChildren();
    for (const d of desktops) {
      const card = document.createElement('label');
      card.className = 'quick-desktop';
      const input = Object.assign(document.createElement('input'), { type: 'radio', name: 'quick-desktop', value: d.id, checked: d.id === desktop, disabled: busy });
      input.addEventListener('change', () => { desktop = d.id; base = null; clearResult(); render(); });
      card.append(input, Object.assign(document.createElement('strong'), { textContent: d.label }),
        Object.assign(document.createElement('span'), { textContent: d.description || '' }));
      grid.append(card);
    }

    const select = $q('quick-base');
    select.replaceChildren(...candidates.map((leaf) => {
      const id = leaf.facets.base[0];
      return Object.assign(document.createElement('option'), { value: id, textContent: facetLabel('base', id), selected: id === base });
    }));
    select.disabled = busy;

    const leaf = selectedLeaf();
    const r = route(leaf);
    // While a build runs the progress takes the primary action's place; the
    // app stays offered below it.
    $q('quick-arm').hidden = busy || !(OS.id === 'macos' && macArch === 'arm');
    $q('quick-mac').hidden = !(OS.id === 'macos' && macArch === null);
    $q('quick-download').hidden = busy || (r.kind !== 'browser' && r.kind !== 'local');
    $q('quick-download').textContent = r.kind === 'local' ? 'Build on your computer' : 'Download ISO';
    $q('quick-download').disabled = busy;
    $q('quick-prebuilt').hidden = busy || r.kind !== 'prebuilt';
    $q('quick-under').hidden = busy;
    $q('quick-phone').hidden = r.kind !== 'mobile';
    // The phone's own message already names the USB stick.
    $q('quick-usb').hidden = r.kind === 'mobile';
    renderApp(leaf, r);
    const meta = $q('quick-meta');
    meta.hidden = r.kind === 'mobile';
    if (r.kind === 'browser') {
      const size = leaf.entry.facts?.compressedSize;
      const save = window.showSaveFilePicker ? 'First you choose where to save the file. Then this tab' : 'This tab';
      meta.textContent = `Built in this browser tab, for 64-bit Intel and AMD PCs. ${save} downloads ${size
        ? `about ${gb(size)} and builds the ISO, roughly ${buildMinutes(size)} on a home connection`
        : `${BUILDER_CONFIG.brand.name} and builds the ISO`}. Keep the tab open until it finishes.`;
    } else if (r.kind === 'prebuilt') {
      $q('quick-prebuilt').href = r.iso.url;
      meta.textContent = `${gb(r.iso.size)} file. For 64-bit Intel and AMD PCs.`;
    } else if (r.kind === 'app') {
      meta.textContent = `The app builds ${facetLabel('desktop', desktop)} on ${facetLabel('base', base)} and puts it on your USB stick. Free.`;
    } else if (r.kind === 'mobile') {
      meta.textContent = '';
    } else {
      meta.textContent = qualified(leaf) && !capable.ok
        ? `${capable.reason} You can build it on your computer instead.`
        : 'Not available as a one-click download yet. You can build it on your computer.';
    }
    // Keep the full builder on the same image, so Customize starts from it.
    if (leaf && !busy && guidedPicker && guidedPicker.getSelection()?.id !== leaf.id) guidedPicker.select(leaf.id);
  }

  // TunaOS Media Writer: the action itself on the app route, else the second
  // action under the primary one.
  function renderApp(leaf, r) {
    const app = $q('quick-app');
    const asset = OS.id === 'mobile' ? null : appAsset();
    app.hidden = !asset;
    if (!asset) return;
    const primary = r.kind === 'app';
    app.classList.toggle('is-secondary', !primary);
    // What is said under the primary action belongs to it: under its button,
    // or under the app on the app route.
    if (primary) app.after($q('quick-under')); else app.before($q('quick-under'));
    $q('quick-app-reason').hidden = !primary;
    $q('quick-app-title').hidden = primary;
    if (primary) $q('quick-app-reason').textContent = qualified(leaf) && !capable.ok ? capable.reason : 'This one can’t be built in a browser yet.';
    $q('quick-app-download').textContent = `Get ${APP_NAME} for ${OS_NAMES[OS.id]}`;
    $q('quick-app-download').href = asset.url;
    const links = appOpensLinks();
    $q('quick-app-links').hidden = !leaf;
    $q('quick-app-open').hidden = !links;
    $q('quick-app-sep').hidden = !links;
    if (leaf) $q('quick-app-open').href = `tunaos-media-writer://build?target=${encodeURIComponent(leaf.entry.targetKey)}`;
    $q('quick-app-how').textContent = links
      ? 'Already installed? Open in Media Writer. Otherwise install it, then choose Open in Media Writer again.'
      : 'Install it, then pick this desktop in the app, or choose Open build request… with the file above.';
    appLinks(asset);
    // Only the release's signing.json can say the OS trusts the app.
    const hint = asset.signed === true ? '' : FIRST_LAUNCH_HINTS[OS.id] || '';
    $q('quick-app-hint').textContent = hint;
    $q('quick-app-hint').hidden = !hint;
    $q('quick-app-linux').hidden = OS.id !== 'linux';
    // balenaEtcher writes an ISO file, so it is the fallback only where this
    // page hands out one.
    $q('quick-app-etcher').hidden = primary;
  }

  // build-request.json for the app's "Open build request…": this image with
  // its desktop's default apps, as the one-click build and the app's own
  // choice of this image use.
  function saveBuildRequest() {
    const leaf = selectedLeaf();
    if (!leaf || busy || isOperationBusy()) return;
    if (guidedPicker.getSelection()?.id !== leaf.id) guidedPicker.select(leaf.id);
    const error = $q('quick-app-error');
    try {
      const request = structuredClone(globalThis.tboxGetBuildRequest());
      request.options.flatpaks = [...(FLATPAK_DEFAULTS[leaf.facets.desktop[0]] || [])];
      globalThis.tboxSaveBuildRequest(request);
      error.hidden = true;
    } catch (e) {
      error.textContent = `Could not save the build request: ${e.message || e}`;
      error.hidden = false;
    }
  }

  // A rough range, not a measurement: the download at 100 and at 25 Mbit/s,
  // plus 10 to 20 minutes to build the ISO, in steps of five minutes.
  function buildMinutes(bytes) {
    const step = (seconds) => Math.max(5, Math.round(seconds / 300) * 5);
    return `${step(bytes / 12.5e6 + 600)} to ${step(bytes / 3.125e6 + 1200)} minutes`;
  }

  function setBusy(value) {
    busy = value;
    $q('quick').classList.toggle('is-busy', value);
    render();
  }

  // The engine cannot be stopped mid-build, so Cancel discards the unfinished
  // file and reloads the page. Downloaded parts stay in the browser's cache,
  // so starting again is faster.
  const CANCELLED_KEY = 'tbox-quick-cancelled';
  let activeSink = null;
  async function cancelBuild() {
    if (!busy) return;
    $q('quick-cancel').disabled = true;
    busy = false; // stop mirroring the engine's stage over this one
    $q('quick-stage').textContent = 'Cancelling…';
    try { sessionStorage.setItem(CANCELLED_KEY, '1'); } catch { /* the reload still stops it */ }
    await activeSink?.w.abort?.().catch(() => {});
    location.reload();
  }

  function clearResult() {
    $q('quick-result').hidden = true;
    $q('quick-progress').hidden = true;
  }

  function showResult(kind, text) {
    $q('quick-progress').hidden = true;
    const result = $q('quick-result');
    result.hidden = false;
    result.dataset.kind = kind;
    $q('quick-result-text').textContent = text;
    $q('quick-next').hidden = kind !== 'done';
    $q('quick-failed-actions').hidden = kind !== 'failed';
    const leaf = selectedLeaf();
    const iso = prebuiltFor(leaf);
    $q('quick-alt-prebuilt').hidden = !iso;
    if (iso) $q('quick-alt-prebuilt').href = iso.url;
    const asset = appAsset();
    $q('quick-alt-local').textContent = asset ? `Get ${APP_NAME} instead` : 'Build it on your computer instead';
  }

  // Mirror the full builder's live status, so both views tell the same story.
  const stage = $q('stage'), bar = $q('bar');
  new MutationObserver(() => { if (busy) $q('quick-stage').textContent = stage.textContent; })
    .observe(stage, { childList: true, characterData: true, subtree: true });
  new MutationObserver(() => {
    const quickBar = $q('quick-bar');
    if (bar.hasAttribute('value')) { quickBar.max = bar.max; quickBar.value = bar.value; } else quickBar.removeAttribute('value');
  }).observe(bar, { attributes: true });

  async function browserBuild(leaf) {
    if (guidedPicker.getSelection()?.id !== leaf.id) guidedPicker.select(leaf.id);
    // The default apps, fresh for this image: an earlier attempt on another
    // desktop must not carry its app list over.
    fpDefaults.reset();
    fpItems.clear();
    fpRender();
    const name = buildRequestFromForm().request.options.outputFilename;
    // Ask where to save while the click still counts as a user gesture; the
    // build itself takes many minutes.
    let sink;
    try {
      sink = await isoSink(name);
    } catch (error) {
      showResult('failed', `Could not start the download: ${error.message || error}`);
      return;
    }
    if (!sink) return; // save dialog cancelled
    activeSink = sink;
    setBusy(true);
    clearResult();
    $q('quick-progress').hidden = false;
    $q('quick-cancel').disabled = false;
    $q('quick-stage').textContent = 'Checking the image…';
    $q('quick-bar').removeAttribute('value');
    try {
      await inspect();
      if (!currentOp?.ready) {
        await sink.w.abort?.().catch(() => {});
        showResult('failed', `This browser can’t build it: ${stage.textContent}`);
        return;
      }
      await build(sink);
      if (currentOp?.state === 'completed') {
        showResult('done', currentOp.outputDelivery?.kind === 'picker'
          ? `Saved ${name}.` : `Your browser is saving ${name}. Check its downloads.`);
      } else {
        showResult('failed', stage.textContent || 'The build did not finish.');
      }
    } finally {
      activeSink = null;
      setBusy(false);
    }
  }

  function buildOnComputer() {
    const asset = appAsset();
    if (asset) { location.assign(asset.url); return; }
    leaveQuick();
    renderFallbackCard(currentOp, 'Build this image on your own computer.');
    $q('fallbackcard').scrollIntoView({ block: 'start' });
  }

  function leaveQuick() {
    root.classList.remove('quick');
    // A linked image this view does not offer: the full builder, as the link asks.
    if (preselect) { preselect = null; globalThis.tboxApplyUrlParams(); return; }
    // Reloading stays in the full builder; its share link carries the image.
    history.replaceState(null, '', '?customize=1');
  }

  // The link to send to the computer: this view on the chosen image.
  function pageLink() {
    const leaf = selectedLeaf();
    const url = new URL(location.pathname, location.origin);
    if (leaf) url.searchParams.set('image', `tuna-os/${leaf.entry.target.variant}:${leaf.entry.target.flavor}`);
    return url.href;
  }

  async function sharePageLink() {
    const status = $q('quick-phone-status');
    const url = pageLink();
    try {
      if (navigator.share) {
        await navigator.share({ title: `Download ${BUILDER_CONFIG.brand.name}`, url });
        status.textContent = '';
        return;
      }
      await navigator.clipboard.writeText(url);
      status.textContent = 'Link copied. Paste it into a message or email to yourself, then open it on your computer.';
    } catch (error) {
      if (error?.name === 'AbortError') return; // share sheet dismissed
      status.textContent = `Copy this link: ${url}`;
    }
  }

  $q('quick-base').addEventListener('change', (event) => { base = event.target.value; clearResult(); render(); });
  $q('quick-download').addEventListener('click', () => {
    if (busy || isOperationBusy()) return;
    const leaf = selectedLeaf();
    const r = route(leaf);
    if (r.kind === 'browser') browserBuild(leaf);
    else if (r.kind === 'local') buildOnComputer();
  });
  $q('quick-prebuilt').addEventListener('click', () => showResult('done', 'Your download has started.'));
  $q('quick-app-download').addEventListener('click', () => showResult('app', appOpensLinks()
    ? `Install ${APP_NAME} when it has downloaded, then choose Open in Media Writer here and insert your USB stick.`
    : `Install ${APP_NAME} when it has downloaded, then pick ${facetLabel('desktop', desktop)} on ${facetLabel('base', base)} in the app and insert your USB stick.`));
  // A browser with no handler for the link does nothing at all. If this page
  // is still in front two seconds later, the app most likely isn't installed.
  let nothingTimer = null;
  $q('quick-app-open').addEventListener('click', () => {
    clearTimeout(nothingTimer);
    $q('quick-app-nothing').hidden = true;
    const left = () => clearTimeout(nothingTimer);
    window.addEventListener('blur', left, { once: true });
    document.addEventListener('visibilitychange', left, { once: true });
    nothingTimer = setTimeout(() => {
      window.removeEventListener('blur', left);
      document.removeEventListener('visibilitychange', left);
      if (document.hidden) return;
      $q('quick-app-nothing').hidden = false;
      $q('quick-app-how').hidden = true;
    }, 2000);
  });
  $q('quick-phone-share').textContent = navigator.share ? 'Send this link to your computer' : 'Copy link';
  $q('quick-phone-share').addEventListener('click', sharePageLink);
  $q('quick-cancel').addEventListener('click', cancelBuild);
  $q('quick-app-request').addEventListener('click', saveBuildRequest);
  $q('quick-alt-local').addEventListener('click', buildOnComputer);
  $q('quick-retry').addEventListener('click', () => { clearResult(); render(); });
  $q('quick-customize').addEventListener('click', () => { leaveQuick(); window.scrollTo(0, 0); });
  $q('quick-title').textContent = `Download ${BUILDER_CONFIG.brand.name}`;

  globalThis.tboxQuickRefresh = render;
  globalThis.tboxQuickRoute = () => ({ ...route(selectedLeaf()), desktop, base, capable, os: OS.id });
  render();
  let cancelled = false;
  try { cancelled = sessionStorage.getItem(CANCELLED_KEY) === '1'; sessionStorage.removeItem(CANCELLED_KEY); } catch { /* no storage, no message */ }
  if (cancelled) showResult('cancelled', 'Download cancelled. If an unfinished .iso file was left where you chose to save it, you can delete it.');
  Promise.all([loaded, measureCapability()]).finally(render);
})();
