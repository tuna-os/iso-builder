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

// Deployment-owned, validated presentation policy. Never fall back to another brand.
let BUILDER_CONFIG;
try {
  if (!globalThis.TboxFlatpakDefaults) throw new Error("App defaults support is missing");
  if (document.querySelector && !globalThis.TboxExperiences) throw new Error("Deployment experiences are missing or invalid");
  BUILDER_CONFIG = globalThis.TboxBuilderConfig.validate(globalThis.TBOX_BUILDER_CONFIG);
} catch (error) {
  const main = document.querySelector?.("main");
  if (main) { main.textContent = "This builder’s configuration is missing or invalid. Contact its maintainer."; main.setAttribute("role", "alert"); }
  throw error;
}
const validFlatpakId = globalThis.TboxBuilderConfig.validFlatpakId;

function applyBuilderBranding() {
  if (!document.querySelector) return; // the catalog parity VM has no visual DOM
  const config = BUILDER_CONFIG, brand = config.brand;
  document.title = `${brand.name} ISO Builder`;
  const link = document.querySelector(".site-header .brand");
  link.textContent = ""; link.href = brand.homepage_url;
  // logo_url is the brand wordmark: it carries the name, so it replaces the text.
  if (brand.logo_url) {
    const img = document.createElement("img"); img.src = brand.logo_url; img.alt = brand.name;
    link.appendChild(img);
  } else link.appendChild(document.createTextNode(brand.name));
  const favicon = document.querySelector('link[rel="icon"]');
  if (brand.favicon_url) favicon.href = brand.favicon_url; else favicon.remove();
  const nav = document.querySelector(".site-header nav"); nav.textContent = "";
  for (const [name, url] of [["Home",brand.homepage_url],["Docs",brand.documentation_url],["Support",brand.support_url]]) {
    if (!url) continue;
    const a=document.createElement("a"); a.textContent=name; a.href=url; nav.appendChild(a);
  }
  document.querySelector("h1").textContent = config.presentation.headline;
  document.querySelector("#builder-intro").textContent = config.presentation.intro;
  const guide=document.querySelector("#installation-guide");
  guide.href=brand.documentation_url || brand.homepage_url;
  guide.textContent=`${brand.name} installation documentation`;
  if (globalThis.TboxExperiences?.id === "bluefin") {
    guide.href="https://docs.projectbluefin.io/installation/";
    document.querySelector("#writer-policy").textContent="Bluefin recommends Fedora Media Writer; Ventoy is unsupported. This experience is a preview and does not create Bluefin installation media.";
  }
  const disclaimer=document.querySelector("#builder-disclaimer");
  disclaimer.textContent=brand.disclaimer || ""; disclaimer.hidden=!brand.disclaimer;
  document.querySelector("#label").value=config.output.volume_label;
  if (config.schema_version === 1 && !config.variants.length && !config.ddi_channels?.length) {
    document.querySelector("#choose-heading").textContent="Review your image";
    document.querySelector("#desktop-help").textContent="This deployment starts from a configured container image. Check its reference and computer type before continuing.";
    document.querySelector("#variant").parentElement.hidden=true;
  }
  document.documentElement.style.setProperty("--accent",config.presentation.accent_color);
  document.documentElement.style.setProperty("--accent-soft","var(--fg)");
  const rgb=config.presentation.accent_color.slice(1).match(/../g).map(v=>parseInt(v,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);
  const luminance=rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;
  document.documentElement.style.setProperty("--accent-ink",luminance>.179?"#000":"#fff");
  document.documentElement.dataset.choiceStyle=config.presentation.choice_style || "illustrated";
  document.documentElement.dataset.fontFamily=config.presentation.font_family || "system";
  if(config.presentation.colors) {
    const names={background:"--bg",surface:"--panel",text:"--fg",muted:"--dim",accent:"--accent",accent_text:"--accent-ink",border:"--border",hover_surface:"--choice-hover",focus:"--choice-focus",selected_surface:"--choice-selected"};
    for(const [key,value] of Object.entries(config.presentation.colors)) document.documentElement.style.setProperty(names[key],value);
  }
  if(config.preview_only) {
    document.querySelector("#introspect").disabled=true;
    document.querySelector("#introspect").textContent="Preview only";
    document.querySelector("#preview-note").textContent="This example does not inspect, download or build images.";
  }
}
applyBuilderBranding();
if(document.querySelector && globalThis.TboxExperiences) {
  const picker=document.querySelector("#experience");
  for(const item of globalThis.TboxExperiences.entries) {const option=document.createElement("option");option.value=item.id;option.textContent=item.name + (item.previewOnly ? " — preview only" : "");picker.appendChild(option);}
  picker.value=globalThis.TboxExperiences.id;
  picker.addEventListener("change",()=>{
    if(isOperationBusy()){picker.value=globalThis.TboxExperiences.id;return;}
    const target=globalThis.TboxExperiences.target(picker.value);
    if(target) location.assign(target);
  });
  window.addEventListener("pageshow",event=>{if(event.persisted) location.reload();});
}


let SHIM = "https://relay.tunaos.org";

function updateShim() {
  const input = $("shimurl");
  if (input && input.value.trim()) {
    SHIM = input.value.trim().replace(/\/+$/, "");
  } else {
    SHIM = "https://relay.tunaos.org";
  }
}

const DEFAULT_CATALOG_SNAPSHOT = {"coverageDigest":"sha256:0c08dc7b87b5cf36c5daa370b21bfa0a8db206321a4f6426b3b0248b86412cc1","generatedAt":"2026-11-05T19:51:32Z","kind":"catalog-snapshot","producerRevision":"tunaos.toml@48bcc5b4ab5e6f3d4891d5a7245acd1694c836ec","schemaVersion":1,"snapshotDigest":"sha256:5b9b349228d2082025a30a3a4d39e3cc52d5dec85301bf38bb7e5dc8642c11d1","targets":[{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1694964923,"desktop":"","digest":"sha256:47c1c4bd90f9ad8e056cb235ab2c1f684cf9a2c5ade3ad3ad889a7f1930ebe8f","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:base-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"base-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:043826ee1ef3eba988b5d47d53ad2a348a3159fe2b1f755c9b00db8186461e99","engineRevision":null,"indexDigest":"sha256:6cd38cb8954b1094fbe355847c4b54ab4aafe6a148df0963cb4444157e24776e","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:47c1c4bd90f9ad8e056cb235ab2c1f684cf9a2c5ade3ad3ad889a7f1930ebe8f"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:base-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1692828585,"desktop":"","digest":"sha256:9beec929444f86de95e082a040f05f291bfaa1e0091e56d1194d414005c07a45","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:base-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"base-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:13979ad3fb173d169ad70bb9f1ec5ef0abb31ea3e399c40517269f3734ecdcc2","engineRevision":null,"indexDigest":"sha256:6cd38cb8954b1094fbe355847c4b54ab4aafe6a148df0963cb4444157e24776e","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:9beec929444f86de95e082a040f05f291bfaa1e0091e56d1194d414005c07a45"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"base-hwe","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"albacore"},"targetKey":"albacore:base-hwe:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1604823926,"desktop":"","digest":"sha256:3da0d3e044639277a8238756952efe6370ec12847458c41b80744728a1eca176","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:base-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"base-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:2a09f3ae360f55861df4024b0ce97beb4b1889ac2665ba4e837d5c72682b3b8c","engineRevision":null,"indexDigest":"sha256:6cd38cb8954b1094fbe355847c4b54ab4aafe6a148df0963cb4444157e24776e","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:3da0d3e044639277a8238756952efe6370ec12847458c41b80744728a1eca176"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"albacore"},"targetKey":"albacore:base-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2299695479,"desktop":"","digest":"sha256:25707722b651d607559a80a158ada5e160e43c35e550bb35988454b275c7b8c7","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:base-nvidia","repository":"ghcr.io/tuna-os/albacore","tag":"base-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:2abb0786fe738d29675c8e9f28ece5b119a77b7b220028f945f7a4d97209fc04","engineRevision":null,"indexDigest":"sha256:782909823362765643a93a621becb51f077bef4c6847c443008e785524ed03f3","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:25707722b651d607559a80a158ada5e160e43c35e550bb35988454b275c7b8c7"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:base-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1624643760,"desktop":"","digest":"sha256:277beac9078c76f42a3bef6ad70c1fd0a11375c2abd31617e92139083921c123","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:base","repository":"ghcr.io/tuna-os/albacore","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:d1831629f12656bb50912aa340104964468644042bf08b8cd6e520acc6fc17b6","engineRevision":null,"indexDigest":"sha256:52ee9a75d69f5f63cbd1ff5f47dbea7c903f8fe24836157e6ca94308d4d5bbe7","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:277beac9078c76f42a3bef6ad70c1fd0a11375c2abd31617e92139083921c123"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1623250554,"desktop":"","digest":"sha256:b952e7dda22a11daae23dc738ca20fa8fbc8a8300736be230043719a7cf9e8d9","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:base","repository":"ghcr.io/tuna-os/albacore","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:edcffe8620ab79528339b6940cf5a84c4ff950197e64f3af500a4623adbfa935","engineRevision":null,"indexDigest":"sha256:52ee9a75d69f5f63cbd1ff5f47dbea7c903f8fe24836157e6ca94308d4d5bbe7","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:b952e7dda22a11daae23dc738ca20fa8fbc8a8300736be230043719a7cf9e8d9"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"base","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"albacore"},"targetKey":"albacore:base:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1512527074,"desktop":"","digest":"sha256:441648d55708c5a0160cb7a16f6f790fb1ea458efb67c93ba167d0e49bcb5cad","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:base","repository":"ghcr.io/tuna-os/albacore","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:3ae3b623a006bdd9346d36df04f7009633e9b9f70aa86651dab204aef1ab8e58","engineRevision":null,"indexDigest":"sha256:52ee9a75d69f5f63cbd1ff5f47dbea7c903f8fe24836157e6ca94308d4d5bbe7","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:441648d55708c5a0160cb7a16f6f790fb1ea458efb67c93ba167d0e49bcb5cad"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base","hardwareScope":"generic","platform":"linux/arm64","variant":"albacore"},"targetKey":"albacore:base:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2071267918,"desktop":"cosmic","digest":"sha256:a14eb045877dca1a0d7d299aa82537134141d970157485811f6d619ef90da791","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:cosmic-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"cosmic-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:0c03fe42f91a38fba0d7fea0001843168fe21eb94a85271bca9aac075e9601cf","engineRevision":null,"indexDigest":"sha256:e74475d811ece2b613cea600caafe4f01c7b9fa243d73c74b786cdc3dee68de6","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:a14eb045877dca1a0d7d299aa82537134141d970157485811f6d619ef90da791"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:cosmic-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2676346857,"desktop":"cosmic","digest":"sha256:f3357a8c7e62b7e23050560cac475cf8ca48450c908411ed97af1997c736b9cb","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:cosmic-nvidia","repository":"ghcr.io/tuna-os/albacore","tag":"cosmic-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:4d7e4ae98a1d01608ac3afc7c954bdbeeff704334c716677350cb5640d917b98","engineRevision":null,"indexDigest":"sha256:7bc1c8fb5fa49c1ba9e1875769cf741e5518e602674b04fe265db44452e8d923","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:f3357a8c7e62b7e23050560cac475cf8ca48450c908411ed97af1997c736b9cb"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:cosmic-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2071268984,"desktop":"cosmic","digest":"sha256:1bca61e24de3dae853b09d00e103556e9f4569dcf293fca129280b08779a23e9","hasSdBoot":false,"kernelVer":"6.12.0-211.73.1.el10_2.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:cosmic","repository":"ghcr.io/tuna-os/albacore","tag":"cosmic"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:9a99a133bd3208814c90ead3be56625f1ad6583cff529d9b803c5db0ad9494e2","engineRevision":null,"indexDigest":"sha256:20978a8dab0b05ab419c5931843aea76d40867bcb6ed37f378533b1c6aaa38aa","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:1bca61e24de3dae853b09d00e103556e9f4569dcf293fca129280b08779a23e9"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:cosmic:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2055069352,"desktop":"gnome","digest":"sha256:21e730911a29435a27fd858b62bcf6b119e79a15f489dfef54903dcc3c81b6b0","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:gnome-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"gnome-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:493b8e412348aa709c3498acfbd0fedde6287dcc89dc894360bcb448ec2b29d5","engineRevision":null,"indexDigest":"sha256:605a2a9ef1541f057f24caa3b31af7758d923593595d1f5b5918f9b334e22b73","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:21e730911a29435a27fd858b62bcf6b119e79a15f489dfef54903dcc3c81b6b0"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:gnome-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":2052396490,"desktop":"gnome","digest":"sha256:2a423ea4eb853683c1c709958c8181cf3c68c4fdef7de81722bf059d4b309d88","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:gnome-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"gnome-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:d4fb4e4ce5703c7c7365068bb21e1e3494ce3915e7269e35a7f6629e5b8345a4","engineRevision":null,"indexDigest":"sha256:605a2a9ef1541f057f24caa3b31af7758d923593595d1f5b5918f9b334e22b73","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:2a423ea4eb853683c1c709958c8181cf3c68c4fdef7de81722bf059d4b309d88"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"gnome-hwe","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"albacore"},"targetKey":"albacore:gnome-hwe:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2659999205,"desktop":"gnome","digest":"sha256:ea8bc764446ee4cb18b1f5f1b1166d8bcaf525829c10f3d023b412a51443564c","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:gnome-nvidia","repository":"ghcr.io/tuna-os/albacore","tag":"gnome-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:1562d88ad850f7977521d7e3b7ef4dc77865ffabbc4767ddaf4575f3a5eb933c","engineRevision":null,"indexDigest":"sha256:4c4c32e86f4875e56470d6b3523cabd0b8151619cb376c417ed3eb0d80b14dfa","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:ea8bc764446ee4cb18b1f5f1b1166d8bcaf525829c10f3d023b412a51443564c"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:gnome-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2055062658,"desktop":"gnome","digest":"sha256:03a2989b1c470d89cdb1d5a7033e6693ef887e568055d4c4a3b7ed3e9394da19","hasSdBoot":false,"kernelVer":"6.12.0-211.73.1.el10_2.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:gnome","repository":"ghcr.io/tuna-os/albacore","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:2324810351ff5d6e13014af27fb7b15b1c303006f6b9123ef8dd82f3ffb8fb64","engineRevision":null,"indexDigest":"sha256:df77cdb922707b66b7022ad44b5425020ecf94e9458a508a7aa429088017b37e","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:03a2989b1c470d89cdb1d5a7033e6693ef887e568055d4c4a3b7ed3e9394da19"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":2052385646,"desktop":"gnome","digest":"sha256:5c284e7ed71c461730c974dfb9ff89f57445f7b87dd8a136059e5b5e5ff3b8e0","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:gnome","repository":"ghcr.io/tuna-os/albacore","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:14bf41985e945846d944ba7e310ac7d1466415a782fa681732d818764ce2dac1","engineRevision":null,"indexDigest":"sha256:df77cdb922707b66b7022ad44b5425020ecf94e9458a508a7aa429088017b37e","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:5c284e7ed71c461730c974dfb9ff89f57445f7b87dd8a136059e5b5e5ff3b8e0"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"albacore"},"targetKey":"albacore:gnome:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2134611778,"desktop":"kde","digest":"sha256:baaa33b5af1b0f4171bedaeee74968fed6d4d867b7e44595e42a5e77a15315e3","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:kde-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"kde-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:91f704a72b9d5693a0e3fd989cdc55ad87c51f67b4b8d69ebf4116e9edd7a797","engineRevision":null,"indexDigest":"sha256:35a3a43b8c31a25e9e657fbfa68da3d9087ada11da4d6b79176c99ad3dcfe325","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:baaa33b5af1b0f4171bedaeee74968fed6d4d867b7e44595e42a5e77a15315e3"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:kde-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":2130690241,"desktop":"kde","digest":"sha256:4d35b7b7ee5e27e73fcdcc2c8e2b6a40ce8fb53c7345aeca4b7877045a17a8b0","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:kde-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"kde-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:04c5184c1ecd0658855a68b4684506472617908032912b0100cb4a606ec284a0","engineRevision":null,"indexDigest":"sha256:35a3a43b8c31a25e9e657fbfa68da3d9087ada11da4d6b79176c99ad3dcfe325","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:4d35b7b7ee5e27e73fcdcc2c8e2b6a40ce8fb53c7345aeca4b7877045a17a8b0"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"kde-hwe","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"albacore"},"targetKey":"albacore:kde-hwe:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2034726686,"desktop":"kde","digest":"sha256:4ce9925e6a232acea268da3e0e2307be2bd9745e710b32ad86121f9166dd8a06","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:kde-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"kde-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:9ee444ed86b13476cf105ad827669fbd81d821fdefae4e1507e073e75fed0a4c","engineRevision":null,"indexDigest":"sha256:35a3a43b8c31a25e9e657fbfa68da3d9087ada11da4d6b79176c99ad3dcfe325","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:4ce9925e6a232acea268da3e0e2307be2bd9745e710b32ad86121f9166dd8a06"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"kde-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"albacore"},"targetKey":"albacore:kde-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2739693762,"desktop":"kde","digest":"sha256:40a5bf97d227b455fcb70342724591f55a0499163ac444ad2531be929d8e86ad","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:kde-nvidia","repository":"ghcr.io/tuna-os/albacore","tag":"kde-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:4a081b16d11c0bc186fff128938ef03b695b33d59a8f1912d149d38b3b38a288","engineRevision":null,"indexDigest":"sha256:45b17fd5b88e52ef5e7db77b1b063f91b88959bc4d4df46e802ce48346f0a052","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:40a5bf97d227b455fcb70342724591f55a0499163ac444ad2531be929d8e86ad"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:kde-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2134614368,"desktop":"kde","digest":"sha256:7a3b7da8ce005a2b2ddcdc4e6edd98e6822b3e7b2d710b9d3788e67c4f7ac0c7","hasSdBoot":false,"kernelVer":"6.12.0-211.73.1.el10_2.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:kde","repository":"ghcr.io/tuna-os/albacore","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:b5fd79c032e81c39fe8d8f1fe7eb0cd8f42fca445cf8d1ad90553872754eec3e","engineRevision":null,"indexDigest":"sha256:b8ee255f802178a1beee06f17c682b5daac38265f72e0f82a2ea6e1c964ff2a4","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:7a3b7da8ce005a2b2ddcdc4e6edd98e6822b3e7b2d710b9d3788e67c4f7ac0c7"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":2130690475,"desktop":"kde","digest":"sha256:c3196055d9598e7bd5ed4ea4e8addf7fdd5a8397a0c222ffae0e15db8e9dd991","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:kde","repository":"ghcr.io/tuna-os/albacore","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:4e155ffe576cfe4e62f04d881f19a8beb1357a8d1739bd09c04a20b52e3462da","engineRevision":null,"indexDigest":"sha256:b8ee255f802178a1beee06f17c682b5daac38265f72e0f82a2ea6e1c964ff2a4","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:c3196055d9598e7bd5ed4ea4e8addf7fdd5a8397a0c222ffae0e15db8e9dd991"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"albacore"},"targetKey":"albacore:kde:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2034707583,"desktop":"kde","digest":"sha256:d96517eceee27f369d76e60a52c741cdc77359471934f937f39f7df6fc86e75a","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:kde","repository":"ghcr.io/tuna-os/albacore","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:d78e3bea2590d2b08a479e27de749574d8c5c7a1ef30cf5f2d1f8673a9923f95","engineRevision":null,"indexDigest":"sha256:b8ee255f802178a1beee06f17c682b5daac38265f72e0f82a2ea6e1c964ff2a4","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:d96517eceee27f369d76e60a52c741cdc77359471934f937f39f7df6fc86e75a"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"kde","hardwareScope":"generic","platform":"linux/arm64","variant":"albacore"},"targetKey":"albacore:kde:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1936465594,"desktop":"niri","digest":"sha256:c72c2863f866ae85c0a4a14a1d104ef3b5b0b679c218b9ecee4a5bec710f2709","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:niri-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"niri-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:09dc7d1c3c2c53694f8e6c374903e0e85ea8381aa43e04dc01cf4dde0aac0c4f","engineRevision":null,"indexDigest":"sha256:b12f615547a9e3fc4bcc8398cab44f0233a51e9d567ff5facff0544b9b2e640f","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:c72c2863f866ae85c0a4a14a1d104ef3b5b0b679c218b9ecee4a5bec710f2709"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:niri-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1945684769,"desktop":"niri","digest":"sha256:c9cc21f8c54041dc727b5a640cef2a56a5eba8d56871c906236276b24b7505b4","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:niri-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"niri-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:166e49a348813adc68a9230e2eb970a7cc8a1664bf50e63031dc224a14e08611","engineRevision":null,"indexDigest":"sha256:b12f615547a9e3fc4bcc8398cab44f0233a51e9d567ff5facff0544b9b2e640f","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:c9cc21f8c54041dc727b5a640cef2a56a5eba8d56871c906236276b24b7505b4"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"niri-hwe","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"albacore"},"targetKey":"albacore:niri-hwe:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1832533259,"desktop":"niri","digest":"sha256:ec80849ca24ca16782253ed85436d4b25aa78481b7d03413815efc60674de0d4","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:niri-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"niri-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:17e134d8dfb1fdb7e4577ac80ad3c158777cfd88a40dcf682e5d7ff53916a4c5","engineRevision":null,"indexDigest":"sha256:b12f615547a9e3fc4bcc8398cab44f0233a51e9d567ff5facff0544b9b2e640f","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:ec80849ca24ca16782253ed85436d4b25aa78481b7d03413815efc60674de0d4"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"niri-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"albacore"},"targetKey":"albacore:niri-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2541300234,"desktop":"niri","digest":"sha256:f2635f4f6bf361bfa7bbf12e90b344b40950a5503d48872cc2b5747a6a15fab5","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:niri-nvidia","repository":"ghcr.io/tuna-os/albacore","tag":"niri-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:28ad3184f5ce2bf275b5882370ed652b4dd9a6d2107e37a072f95deaec70df1b","engineRevision":null,"indexDigest":"sha256:3cd3babffd57ec85c66385f4d4eae4acaf1899274f90edead35539a88b5ca538","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:f2635f4f6bf361bfa7bbf12e90b344b40950a5503d48872cc2b5747a6a15fab5"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:niri-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1936481963,"desktop":"niri","digest":"sha256:76b9c19e7198505941a01ba3bf54117059631615e2b7ca2057f833dd0a8ccee2","hasSdBoot":false,"kernelVer":"6.12.0-211.73.1.el10_2.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:niri","repository":"ghcr.io/tuna-os/albacore","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:aa755507e44f670905b15ece85d96473817931d8d08ddd3b75dacd5c9e585759","engineRevision":null,"indexDigest":"sha256:cc8772d1efc0b3574f43e1c1d9167641209fb1576b4472f38ab6c04c447f7c5b","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:76b9c19e7198505941a01ba3bf54117059631615e2b7ca2057f833dd0a8ccee2"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:niri:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1945700728,"desktop":"niri","digest":"sha256:cb037582c0bc994996813442094862d08c9e7180341f38ee3ca2eda3b4b274cc","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:niri","repository":"ghcr.io/tuna-os/albacore","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:f9a48f2b2b4accfca98f4948a38e0bedf9e465fe2c0e3bef4292e694e6eb7558","engineRevision":null,"indexDigest":"sha256:cc8772d1efc0b3574f43e1c1d9167641209fb1576b4472f38ab6c04c447f7c5b","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:cb037582c0bc994996813442094862d08c9e7180341f38ee3ca2eda3b4b274cc"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"niri","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"albacore"},"targetKey":"albacore:niri:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1832538417,"desktop":"niri","digest":"sha256:dd75716c00edea727bd7150f500ae49f9fbf52a1adfe13f95125844b50dd87f0","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:niri","repository":"ghcr.io/tuna-os/albacore","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:08cbd9fe9e7a0fd224fae66c7f008e3f57a82fa2fd85344b65edcb4a99c5302e","engineRevision":null,"indexDigest":"sha256:cc8772d1efc0b3574f43e1c1d9167641209fb1576b4472f38ab6c04c447f7c5b","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:dd75716c00edea727bd7150f500ae49f9fbf52a1adfe13f95125844b50dd87f0"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"niri","hardwareScope":"generic","platform":"linux/arm64","variant":"albacore"},"targetKey":"albacore:niri:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1862667112,"desktop":"tuna","digest":"sha256:4e3e0b191dfc55d1005d689d16b93fab495e65d7bd313140dc1dba59b5968b8c","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:tuna","repository":"ghcr.io/tuna-os/albacore","tag":"tuna"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:9f14a8c703ba005e67c8e745dc14f304544a3e1537c9686c2bd62602c298addd","engineRevision":null,"indexDigest":"sha256:b68a195dbc6e079bbab6b330086e6420d860f5364d1f2232e5f377bc6cdf2a13","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:4e3e0b191dfc55d1005d689d16b93fab495e65d7bd313140dc1dba59b5968b8c"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"tuna","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:tuna:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1734831313,"desktop":"xfce","digest":"sha256:ab4922807ac3f36b3b4b3212a2e62b0e0502e8d82af482a05b1b191c409e9ed1","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:xfce-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"xfce-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:cbc9c6ac7843b631515fd9d2bd3bc6937b1b43d1302265355bf2008d01d4e74f","engineRevision":null,"indexDigest":"sha256:c9c378d1f8a1453fd6d41f2d53e834cf602daf74587508964b66ed200b9ea88f","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:ab4922807ac3f36b3b4b3212a2e62b0e0502e8d82af482a05b1b191c409e9ed1"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:xfce-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1735723979,"desktop":"xfce","digest":"sha256:330047b34d224cadd05fcca5a33b354b407dcdd81e9d5234456af4ea30e0a341","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:xfce-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"xfce-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:f9fd75bb75c8418aeddcf3a6282ab17cc4d56939ff9d761691baecd840f01ed6","engineRevision":null,"indexDigest":"sha256:c9c378d1f8a1453fd6d41f2d53e834cf602daf74587508964b66ed200b9ea88f","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:330047b34d224cadd05fcca5a33b354b407dcdd81e9d5234456af4ea30e0a341"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"xfce-hwe","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"albacore"},"targetKey":"albacore:xfce-hwe:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2339320458,"desktop":"xfce","digest":"sha256:638d072943a3d8818b5740bda1c0979091a041a6e600b198346b6fb2ed027d2a","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:xfce-nvidia","repository":"ghcr.io/tuna-os/albacore","tag":"xfce-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:ce3d61439be53060ce37ee93e2b195f8743081b446684caa57dbe7d1a08011dc","engineRevision":null,"indexDigest":"sha256:b9f334b3e39cb6bcc93610b5ec45de81c57467e273ef903a64886a8aa509cf40","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:638d072943a3d8818b5740bda1c0979091a041a6e600b198346b6fb2ed027d2a"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:xfce-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1734829726,"desktop":"xfce","digest":"sha256:17db1bb0e552293136b0fe6f20ebe2d0a51957b6e17e12f34dd7f219d45ade39","hasSdBoot":false,"kernelVer":"6.12.0-211.73.1.el10_2.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:xfce","repository":"ghcr.io/tuna-os/albacore","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:c608ba5a2ee0243f6459c918b050e467d9c1fd38dcb7d85036db2c6ab9ef1b87","engineRevision":null,"indexDigest":"sha256:92d220e348257bec92c7ce6782cf4dbdb96960ce00e0e498de320afd6efc1d43","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:17db1bb0e552293136b0fe6f20ebe2d0a51957b6e17e12f34dd7f219d45ade39"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:xfce:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1735725871,"desktop":"xfce","digest":"sha256:91f5ace7da8333bffd64bf1868b80c453e4af31a57c8caed090c6de28acb3326","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:xfce","repository":"ghcr.io/tuna-os/albacore","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:38ea0787490816ed95405a0895e8a5df9b55c38c6c8afb479fb0cad342bf721d","engineRevision":null,"indexDigest":"sha256:92d220e348257bec92c7ce6782cf4dbdb96960ce00e0e498de320afd6efc1d43","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:91f5ace7da8333bffd64bf1868b80c453e4af31a57c8caed090c6de28acb3326"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"albacore"},"targetKey":"albacore:xfce:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1958746363,"desktop":"","digest":"sha256:6289f73fa238ca67e6b88fc9459f13e67bc4be1975d710d482336c73624d3f3b","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:base-hwe-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"base-hwe-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:a6b2dccf3ed42642390fd36c5282155133052d888317b2d8bc2937961c05dd8b","engineRevision":null,"indexDigest":"sha256:593af8119caaa8cf96571b830992aab5852d3961baabb901af50c3c130193130","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:6289f73fa238ca67e6b88fc9459f13e67bc4be1975d710d482336c73624d3f3b"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:base-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1834278230,"desktop":"","digest":"sha256:6fc46c421c289ffbb73b8431a5d67068e62b22b8af213bc3dd9705acfc7cce99","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:base-hwe-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"base-hwe-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:d866325bbae604e1eb688e7dfc82d1d017c2b24dde351c50e6b6604cea36e215","engineRevision":null,"indexDigest":"sha256:593af8119caaa8cf96571b830992aab5852d3961baabb901af50c3c130193130","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:6fc46c421c289ffbb73b8431a5d67068e62b22b8af213bc3dd9705acfc7cce99"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:base-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2546493835,"desktop":"","digest":"sha256:eca3cc0e4c075a33a0d78905321acf4bf79831d6d4477cd7b580eb7044e63df3","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:base-nvidia-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"base-nvidia-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:2eef8284daecf7837ca4d67b66135567e7561259f750b00f9a08c2e3dff17d61","engineRevision":null,"indexDigest":"sha256:77c77426f1e7bee9dc8c29b4b1504182648700df84fbadc6c9f0aef1376fb64e","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:eca3cc0e4c075a33a0d78905321acf4bf79831d6d4477cd7b580eb7044e63df3"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:base-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1918898360,"desktop":"","digest":"sha256:8e2d8fc46c39ed4378cbb3084d19e9e41e9856d272b736830dc9ce85697758b7","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:base-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"base-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:1691892eae3b7e1b2c2a5e073af731d66acdd9b80d002a61286eaf6fc322bb3d","engineRevision":null,"indexDigest":"sha256:f7152ce976926e4d4f0df4f42cf378c6f21a37715f04e39222c02d007acc4964","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:8e2d8fc46c39ed4378cbb3084d19e9e41e9856d272b736830dc9ce85697758b7"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1797253964,"desktop":"","digest":"sha256:55d062d33d65281a4cfe29457f094e13eb6f70d867dc97ee2d26ec882bd499f3","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:base-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"base-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:8284b94055f8e0408560de442a659cf36a63d5a31128d00e1b5a02b2c27d315b","engineRevision":null,"indexDigest":"sha256:f7152ce976926e4d4f0df4f42cf378c6f21a37715f04e39222c02d007acc4964","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:55d062d33d65281a4cfe29457f094e13eb6f70d867dc97ee2d26ec882bd499f3"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:base:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3238788430,"desktop":"cosmic","digest":"sha256:2c1a3e525feffdbd92d9208ebb63a7a71bdfd2a4007afd29d2d48da1406d29de","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:cosmic-nvidia-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"cosmic-nvidia-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:26aa5661e8cb6b2fd0ba44413f1e19c0771d03eb3b3c868573285d55d25881c1","engineRevision":null,"indexDigest":"sha256:6faa911b4ca3be9d590d0fb368517a786d1ed0eccb9df6af66ed7156371a4923","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:2c1a3e525feffdbd92d9208ebb63a7a71bdfd2a4007afd29d2d48da1406d29de"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:cosmic-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2651310746,"desktop":"cosmic","digest":"sha256:0acbdfb20c9ef9ca9beb0cd2d9391bad109034161317f758cb612b1cdd3c5719","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:cosmic-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"cosmic-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:d296fb48110bb349d389a262e668c6263ee484a79efcd4d1e15ac804103f33fc","engineRevision":null,"indexDigest":"sha256:513c411d48768d8ef6d866cc1e9de198e9ce20a9a9e603d7f4c639a0165aeddf","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:0acbdfb20c9ef9ca9beb0cd2d9391bad109034161317f758cb612b1cdd3c5719"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:cosmic:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2508717053,"desktop":"cosmic","digest":"sha256:887c5b8d112985aed5b4307f1566e32f3cd8b07669b2b5fbcd92adbbf14ae4de","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:cosmic-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"cosmic-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:d61b15a368f11931f7228c81f8e3e1404cca5d096eb538bed89513b6eaa10232","engineRevision":null,"indexDigest":"sha256:513c411d48768d8ef6d866cc1e9de198e9ce20a9a9e603d7f4c639a0165aeddf","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:887c5b8d112985aed5b4307f1566e32f3cd8b07669b2b5fbcd92adbbf14ae4de"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"cosmic","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:cosmic:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2590060676,"desktop":"gnome","digest":"sha256:f178e38bcbda56475e75408df708dac9f6dfa886b5340b0402233a181d47bc8e","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome-hwe-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"gnome-hwe-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:0a685687bd8125cb062a64723f6246928d58a35854512c659a103abe18958004","engineRevision":null,"indexDigest":"sha256:1586897822e8e10c76f861ef7ce9ccc9af759fba56afa48e1eb18924f9866f00","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:f178e38bcbda56475e75408df708dac9f6dfa886b5340b0402233a181d47bc8e"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:gnome-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2453746344,"desktop":"gnome","digest":"sha256:1f12100ab04cf99250e2d12d2b7401c5ef3cb132636223f3921e3f392ecf9b9a","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome-hwe-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"gnome-hwe-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:0e2ed16e03d5f3cea29a14c4a8892d6a8e6dde2641807775995c0ff2cb0815b9","engineRevision":null,"indexDigest":"sha256:1586897822e8e10c76f861ef7ce9ccc9af759fba56afa48e1eb18924f9866f00","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:1f12100ab04cf99250e2d12d2b7401c5ef3cb132636223f3921e3f392ecf9b9a"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:gnome-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3181307628,"desktop":"gnome","digest":"sha256:410244ca81591f4b95be4a016ddf1920e4addd7bf930e95e519a9cdbd7142742","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome-nvidia-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"gnome-nvidia-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:d6bf869bd4b598a21952f59266b4cbcd89398652fb758a85ffabb4d61dc8a9ff","engineRevision":null,"indexDigest":"sha256:639c7fe0fc817103e61f8e2a2bd7915882179f41d7f94880383d51ab53947d2c","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:410244ca81591f4b95be4a016ddf1920e4addd7bf930e95e519a9cdbd7142742"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:gnome-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2573218666,"desktop":"gnome","digest":"sha256:fc34e18458387776cc575d73582e8cceeaa8e76c3b427301b099253cd8579425","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"gnome-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:14491c73aa4c5be5ba5c470a782d9cf2812430702868a7496b1742dd9b2dc6a5","engineRevision":null,"indexDigest":"sha256:28d02dc05fe923524e6698323b6f676424b63702d791f166753e8a9982f24247","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:fc34e18458387776cc575d73582e8cceeaa8e76c3b427301b099253cd8579425"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2436994269,"desktop":"gnome","digest":"sha256:225394bc6d1a06656b81e292f2ac83a58521578704d30ac1718a04554716b288","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"gnome-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:1137aae1c1914cb6c99b17ec8e5d37978ea827feafd05b1b55af163bef142122","engineRevision":null,"indexDigest":"sha256:28d02dc05fe923524e6698323b6f676424b63702d791f166753e8a9982f24247","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:225394bc6d1a06656b81e292f2ac83a58521578704d30ac1718a04554716b288"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:gnome:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3925044493,"desktop":"kde","digest":"sha256:24ae6271fe50057fd9bf145ffd7e360f7cb12615ba6038ded70724cab5937944","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:kde-nvidia-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"kde-nvidia-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:212b8392150fcd24bfba25f8abc466b1ef13481613acf81bbc670b107cb14ae9","engineRevision":null,"indexDigest":"sha256:72702eac12a13a81d20a58b85abbe540a90ac7742a73899abccadecd7857bf6a","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:24ae6271fe50057fd9bf145ffd7e360f7cb12615ba6038ded70724cab5937944"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:kde-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3336738914,"desktop":"kde","digest":"sha256:1f1c1928d50d909794cbf5fa3f042b369595eb6d9f0fb2617b171a159447f69a","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:kde-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"kde-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:3f5f25943aafd512649e08d697cf7ec04321c8f49689e4e9bb40074c44d4c781","engineRevision":null,"indexDigest":"sha256:dedad4c2e280f18ceb51de129ec9061e93b4252f3f9b3df03834e9d121433581","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:1f1c1928d50d909794cbf5fa3f042b369595eb6d9f0fb2617b171a159447f69a"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3173859188,"desktop":"kde","digest":"sha256:da983a2ec7908b6cd3ecce81149c83806dcab96ae227d74fa7107444c43428eb","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:kde-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"kde-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:e10a0d404d49c3ec5ab554238f2eb2ac16c870a5c5f0ad42fa56b826da9d2b59","engineRevision":null,"indexDigest":"sha256:dedad4c2e280f18ceb51de129ec9061e93b4252f3f9b3df03834e9d121433581","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:da983a2ec7908b6cd3ecce81149c83806dcab96ae227d74fa7107444c43428eb"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"kde","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:kde:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2782469667,"desktop":"niri","digest":"sha256:adee9a4231b0fa5beb95cf0225c1cd604a385d908eedd27ef9eaaa5c48f62398","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:niri-nvidia-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"niri-nvidia-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:9ed17ce9bbbfa4eceebd1df95696a8579b5611a9e983c434f360b855538431ca","engineRevision":null,"indexDigest":"sha256:ebc44e3404befadbf463e3a084d4e50e63e133fe83bf75eb734de897969d26fe","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:adee9a4231b0fa5beb95cf0225c1cd604a385d908eedd27ef9eaaa5c48f62398"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:niri-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2194848013,"desktop":"niri","digest":"sha256:4e1441222487c61c8f656077ce6bd47ec5ca6d179b83aa2304dd951ca4e98ea4","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:niri-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"niri-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:401e8cfdc5d4f1e44ae7f29bd8dc938f37b68634904f392b009c74b597fc5e40","engineRevision":null,"indexDigest":"sha256:44130e4a81b7813ffc51e6ca55d1c5f5da910deb66f1a8c9f0dc49c3a2f3eead","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:4e1441222487c61c8f656077ce6bd47ec5ca6d179b83aa2304dd951ca4e98ea4"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:niri:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2062329722,"desktop":"niri","digest":"sha256:352eb54942e5790cd522c0408ad288edc5977f6eb1f9a9c3e22db882be0bd138","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:niri-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"niri-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:3785964ad9f6e2cb08f6e260a800aab7c73769ff70aba142cd2c8643beefc4a8","engineRevision":null,"indexDigest":"sha256:44130e4a81b7813ffc51e6ca55d1c5f5da910deb66f1a8c9f0dc49c3a2f3eead","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:352eb54942e5790cd522c0408ad288edc5977f6eb1f9a9c3e22db882be0bd138"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"niri","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:niri:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2265939910,"desktop":"tuna","digest":"sha256:be07c6986e312bba881c963653e28b6851d9e9fcd9af23b34425cc454e5e0b97","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:tuna-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"tuna-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:acca94694b4dd307a6ba036c0fc11c97f289e19f740247784cb81d04e1eb3d30","engineRevision":null,"indexDigest":"sha256:b89e33a83515d1cc67ec0ea85a83da49bf9cf53d5103ab5db39a153117e47321","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:be07c6986e312bba881c963653e28b6851d9e9fcd9af23b34425cc454e5e0b97"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"tuna","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:tuna:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3305282863,"desktop":"xfce","digest":"sha256:6cf706e5d2e7f79377be8adf49500eb01b35aa1688e6ac3e41331dc5c093f3cc","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:xfce-nvidia-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"xfce-nvidia-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:3288afa0d31052417ea3c7c31634036c61f173c9a928903630e161ebca41f904","engineRevision":null,"indexDigest":"sha256:7a95b59f2c336732b8d0d9bb19646deae6488e1b9d0c00ec06ffb90b7c518d77","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:6cf706e5d2e7f79377be8adf49500eb01b35aa1688e6ac3e41331dc5c093f3cc"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:xfce-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2714991644,"desktop":"xfce","digest":"sha256:d971794bbc4d3b93ee8aa1339f84c5b294d78cf48801b6c4d35d16ed96157ed8","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:xfce-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"xfce-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:cfe594e92647a1f96bb129693840d5c72d13ee7815acd237267d0415ff4c630f","engineRevision":null,"indexDigest":"sha256:3515bf497ba41747e6d8d0e5a6b66de804d5eccee82ff5491dd14ba1580fcc73","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:d971794bbc4d3b93ee8aa1339f84c5b294d78cf48801b6c4d35d16ed96157ed8"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:xfce:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2561448918,"desktop":"xfce","digest":"sha256:7f508bd6a8dc980ad429cecde0ee5ec63331405f8d40b8b6254a034e0abf9beb","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:xfce-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"xfce-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:1752991abee27d549a8fad6d90ed09ea58cdf66051d6f19ee8fcfa5eda34bd88","engineRevision":null,"indexDigest":"sha256:3515bf497ba41747e6d8d0e5a6b66de804d5eccee82ff5491dd14ba1580fcc73","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:7f508bd6a8dc980ad429cecde0ee5ec63331405f8d40b8b6254a034e0abf9beb"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"xfce","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:xfce:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1974751085,"desktop":"","digest":"sha256:1d07060745acb72449dd2f61a32d326e0263b89867b7f5326b15ac21d902ae5a","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:base-hwe","repository":"ghcr.io/tuna-os/bonito","tag":"base-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:2bce0d2e6b2f85eb819f0cff66bac0efbe84559e1b0a59fc51c98e0fa0a04c5a","engineRevision":null,"indexDigest":"sha256:cedceb36b44fd07fd4f6333f702f47e332b04cc314552edc1228f4fb3e6430e2","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:1d07060745acb72449dd2f61a32d326e0263b89867b7f5326b15ac21d902ae5a"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:base-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1857898546,"desktop":"","digest":"sha256:02f43d624d4990303c4bebc36aae5b61fa6fefbef3658f920579eb96dfef4ffd","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:base-hwe","repository":"ghcr.io/tuna-os/bonito","tag":"base-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:aa42786aa5710c9623ce0fa5745379f6310b78311705b91c9508974542dabfa5","engineRevision":null,"indexDigest":"sha256:cedceb36b44fd07fd4f6333f702f47e332b04cc314552edc1228f4fb3e6430e2","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:02f43d624d4990303c4bebc36aae5b61fa6fefbef3658f920579eb96dfef4ffd"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito"},"targetKey":"bonito:base-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2583362220,"desktop":"","digest":"sha256:049e704d6c468db5a12ed6de418babf11dbe2657334af29e8c0bbc6a9603d3e6","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:base-nvidia","repository":"ghcr.io/tuna-os/bonito","tag":"base-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:1811a70180f4de27f6dd45def7fba63cac63027708f3512bee33dad02ebdc507","engineRevision":null,"indexDigest":"sha256:8028bdecaca3cd8ef22da343f377a6a6ffd5b2b3b67121fa826e6877974c2713","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:049e704d6c468db5a12ed6de418babf11dbe2657334af29e8c0bbc6a9603d3e6"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:base-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1848540081,"desktop":"","digest":"sha256:ed2d582579a09401fab88da58e3520a1935d66f557dc423d73338847fa68a4d9","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:base","repository":"ghcr.io/tuna-os/bonito","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:57091b46bf339e0e06e2461588ecc1c29be56f0d6b152c4563bfa8543610ea09","engineRevision":null,"indexDigest":"sha256:6520309a7cab223ad22865ef33f3d4ee22d0dde7afca415195029c5c65ea1243","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:ed2d582579a09401fab88da58e3520a1935d66f557dc423d73338847fa68a4d9"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1725841042,"desktop":"","digest":"sha256:6551d835f1bf26d32a66f4c91414856d7e5f72ea454bd0ba05a5b52814df2d7c","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:base","repository":"ghcr.io/tuna-os/bonito","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:d2b22c9758ef84add882b6352dee1c947713dfe27002cbd799ebf137308763f5","engineRevision":null,"indexDigest":"sha256:6520309a7cab223ad22865ef33f3d4ee22d0dde7afca415195029c5c65ea1243","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:6551d835f1bf26d32a66f4c91414856d7e5f72ea454bd0ba05a5b52814df2d7c"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito"},"targetKey":"bonito:base:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3243903124,"desktop":"cosmic","digest":"sha256:853a50a79dd2f75f154ebd2443bcf4deedd44562ff0f62a8a36fe059d1aa354f","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:cosmic-nvidia","repository":"ghcr.io/tuna-os/bonito","tag":"cosmic-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:d2e034716bfec343e4ef28211749f0b89d7c754292361445f8cd2b441ea9c0d5","engineRevision":null,"indexDigest":"sha256:41c47553bad06aa84a8f3a35331cf3951a33a36b32afd11153a65a55407c14be","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:853a50a79dd2f75f154ebd2443bcf4deedd44562ff0f62a8a36fe059d1aa354f"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:cosmic-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2636704694,"desktop":"cosmic","digest":"sha256:868a51b9f6a79ed574ead4d637ff9f2527107c6571c5fd8d334ac34de70b02f8","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:cosmic","repository":"ghcr.io/tuna-os/bonito","tag":"cosmic"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:8860eb7a94ddce0d3336b94de48be1749b529c9e194dc4b6bc8539658ca2a827","engineRevision":null,"indexDigest":"sha256:ce67d19042d1e6b770538e88f397a4ca15e741b42565cd8417ecdbc2e514bb69","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:868a51b9f6a79ed574ead4d637ff9f2527107c6571c5fd8d334ac34de70b02f8"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:cosmic:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2502158253,"desktop":"cosmic","digest":"sha256:573966554b3f0f71026fc34146cc8e7c525da043e4f950f741122d5c5b90a45d","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:cosmic","repository":"ghcr.io/tuna-os/bonito","tag":"cosmic"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:bcc7b6236f077d18190ec341436cc96b6f3000393405c826d8eef89a6f3f3cc9","engineRevision":null,"indexDigest":"sha256:ce67d19042d1e6b770538e88f397a4ca15e741b42565cd8417ecdbc2e514bb69","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:573966554b3f0f71026fc34146cc8e7c525da043e4f950f741122d5c5b90a45d"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"cosmic","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito"},"targetKey":"bonito:cosmic:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2550602004,"desktop":"gnome","digest":"sha256:727d661ae70f12c95105e08b903a992d7f3db0a3e009981e0d679245f49ee352","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome-asahi","repository":"ghcr.io/tuna-os/bonito","tag":"gnome-asahi"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:7a1e12b9d47781bfb1ef8d95c7c6736f9aade06f30b7181e78a0459cac285a0d","engineRevision":null,"indexDigest":"sha256:bfa6340f3f010a74722316506f01c3dddfcf5cffee5412f1571189eac1fbf4ff","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:727d661ae70f12c95105e08b903a992d7f3db0a3e009981e0d679245f49ee352"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome-asahi","hardwareScope":"apple-silicon","platform":"linux/arm64","variant":"bonito"},"targetKey":"bonito:gnome-asahi:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2608435863,"desktop":"gnome","digest":"sha256:be497a495289fa7e3a0fb057a21c5508bab6583aba8969faa44206dfbbd42fb9","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome-hwe","repository":"ghcr.io/tuna-os/bonito","tag":"gnome-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:620480992290d9a407ef123171c97d83d5a6edeccb71798487f2100ea10323a8","engineRevision":null,"indexDigest":"sha256:e8fa8cdbb7d8dd3cfb00bc990d0224684fd0aa08da6fef75473c042f3113f53a","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:be497a495289fa7e3a0fb057a21c5508bab6583aba8969faa44206dfbbd42fb9"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:gnome-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2479683156,"desktop":"gnome","digest":"sha256:4864ec634e19f56c7f61072a9034f22adb74ea0f1924205ed0fda0aa33713fcf","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome-hwe","repository":"ghcr.io/tuna-os/bonito","tag":"gnome-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:029669a9ec41a16964328080d10c6523995453c3ad1fef5dced26ab62ab8d2e6","engineRevision":null,"indexDigest":"sha256:e8fa8cdbb7d8dd3cfb00bc990d0224684fd0aa08da6fef75473c042f3113f53a","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:4864ec634e19f56c7f61072a9034f22adb74ea0f1924205ed0fda0aa33713fcf"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito"},"targetKey":"bonito:gnome-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3218163262,"desktop":"gnome","digest":"sha256:50efc0019f5904c6a5959054b6873c132d747fe8aee2fb73f13dd946d089e57d","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome-nvidia","repository":"ghcr.io/tuna-os/bonito","tag":"gnome-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:f7efc2bbe48a8b30b820f5cf585cfd5cb39a78175475f2d69a56403e1618e922","engineRevision":null,"indexDigest":"sha256:9fcf53c9c0932c4843d3b3894a5e0c8dba0ec597da82354eae26990fc9e8a294","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:50efc0019f5904c6a5959054b6873c132d747fe8aee2fb73f13dd946d089e57d"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:gnome-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2618661562,"desktop":"gnome","digest":"sha256:3e88f63ae73cc726292b98f4b9ab36042c4fb79cdaa5821411816ae808e220a0","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome-t2","repository":"ghcr.io/tuna-os/bonito","tag":"gnome-t2"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:82b16742a2da46c0bf21e23a75612afdae922599835eb7066439b288fba1345a","engineRevision":null,"indexDigest":"sha256:3943ce06a5fa9ffadb362d2179e5d1a86f06fcd23930921bbcc10d0e9d0154c3","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:3e88f63ae73cc726292b98f4b9ab36042c4fb79cdaa5821411816ae808e220a0"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-t2","hardwareScope":"apple-t2","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:gnome-t2:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2666099073,"desktop":"gnome","digest":"sha256:19feedabaf699cec86c82c0b324691ae4e9892afb7fd561b3518f5c111723dc3","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome-x13s","repository":"ghcr.io/tuna-os/bonito","tag":"gnome-x13s"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:06e51abc1fb2e649ad3630553f9544666eb1193ba4afca5508e75612d8227b0e","engineRevision":null,"indexDigest":"sha256:02659b0f185acdd8e29a1473d672a534e577f0fba75dc70cc1b292702dcb060b","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:19feedabaf699cec86c82c0b324691ae4e9892afb7fd561b3518f5c111723dc3"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome-x13s","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito"},"targetKey":"bonito:gnome-x13s:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2609488539,"desktop":"gnome","digest":"sha256:1f2c58262185c65729f77a7beb37e69c5b5a9061afccd26e232179a54ef3b712","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome","repository":"ghcr.io/tuna-os/bonito","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:96b0f99238263aa5c99c90d69107c78c9800ddb32f260374553ce7732d9b1a11","engineRevision":null,"indexDigest":"sha256:77183e59e0f0c102072ea4df00f63b72cd53b873d68b38306e2ec4824db68a2a","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:1f2c58262185c65729f77a7beb37e69c5b5a9061afccd26e232179a54ef3b712"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2480547366,"desktop":"gnome","digest":"sha256:1a48ce2743781400c432ba5f1bfd0cf39e936b799c382f15ac8fe4a5dae7ec75","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome","repository":"ghcr.io/tuna-os/bonito","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:00dad797f02ede8123d73c1ead958869aa37b9356acdf5ba4b053ed7f3dc06f9","engineRevision":null,"indexDigest":"sha256:77183e59e0f0c102072ea4df00f63b72cd53b873d68b38306e2ec4824db68a2a","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:1a48ce2743781400c432ba5f1bfd0cf39e936b799c382f15ac8fe4a5dae7ec75"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito"},"targetKey":"bonito:gnome:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3960832625,"desktop":"kde","digest":"sha256:5a01b8acb57772bb3e3cc6f77b12260bf1c4ad7b41f3d57b41018608148d2857","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:kde-nvidia","repository":"ghcr.io/tuna-os/bonito","tag":"kde-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:662cd756ad47cbf3a3dfa838f9afec0615f6ba799a726fba84e69913c394f2a7","engineRevision":null,"indexDigest":"sha256:2556988ffc86236fa85ad77ea14a180ea8fe47476e0e10ca475bf61dbb35e117","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:5a01b8acb57772bb3e3cc6f77b12260bf1c4ad7b41f3d57b41018608148d2857"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:kde-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3351558546,"desktop":"kde","digest":"sha256:a6600a90a928f9fb5a96e13247d1aaf2bd633bfb66826f44f759f2b176c69f54","hasSdBoot":false,"kernelVer":"7.2.15-200.fc44.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:kde","repository":"ghcr.io/tuna-os/bonito","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:a7cb0554f4b06133d68891d8356cb89c2cae902e54230319f051cf7503e1a5b7","engineRevision":null,"indexDigest":"sha256:9356f31c8251db32268db6d668a2e80c8b55a288e46ecae354022ba3824bd118","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:a6600a90a928f9fb5a96e13247d1aaf2bd633bfb66826f44f759f2b176c69f54"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3194769293,"desktop":"kde","digest":"sha256:b162325f49fda8b634a5afaac5cb1317bad7157c9704a8d796d6339b41398531","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:kde","repository":"ghcr.io/tuna-os/bonito","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:df8cf0eecf62cda28edc12a488115c4387e6a96b6d64b76dc1133c153c789a20","engineRevision":null,"indexDigest":"sha256:9356f31c8251db32268db6d668a2e80c8b55a288e46ecae354022ba3824bd118","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:b162325f49fda8b634a5afaac5cb1317bad7157c9704a8d796d6339b41398531"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"kde","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito"},"targetKey":"bonito:kde:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2810170893,"desktop":"niri","digest":"sha256:d17004c6401bc93cb05b36e67b6256c9e761a665a2e079d7cdc4daabb2b1b226","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:niri-nvidia","repository":"ghcr.io/tuna-os/bonito","tag":"niri-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:0d995f140da1487034360cff159736b1829cecbf64db383a13e231f7c25c8776","engineRevision":null,"indexDigest":"sha256:29022d15b19400b76ebcf80e2a082d66737c230435af39732054071366943d49","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:d17004c6401bc93cb05b36e67b6256c9e761a665a2e079d7cdc4daabb2b1b226"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:niri-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2203655618,"desktop":"niri","digest":"sha256:d981a1fd77dee3611d2cc7f26ff44d25728cd8f395ff82d55ce11067a516dcf6","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:niri","repository":"ghcr.io/tuna-os/bonito","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:804d6eac2cb27458c84cc070336e8dc89b83f42f8784fcf263e5002da50d8e2f","engineRevision":null,"indexDigest":"sha256:4eb8a4efdbfa24d55135ab2e0f5083748b5fa140991b243b3612748b823ca66c","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:d981a1fd77dee3611d2cc7f26ff44d25728cd8f395ff82d55ce11067a516dcf6"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:niri:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2077006215,"desktop":"niri","digest":"sha256:ca0b8c4d868e2b9269c1e06120ea9bc07bd14137ce13bb92d92be7c964aa246b","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:niri","repository":"ghcr.io/tuna-os/bonito","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:1de1fd36f528373258eb78c7a1bb99f3167af7ee276b952a9de9a86fc37c27fb","engineRevision":null,"indexDigest":"sha256:4eb8a4efdbfa24d55135ab2e0f5083748b5fa140991b243b3612748b823ca66c","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:ca0b8c4d868e2b9269c1e06120ea9bc07bd14137ce13bb92d92be7c964aa246b"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"niri","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito"},"targetKey":"bonito:niri:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2290511073,"desktop":"tuna","digest":"sha256:cdb297d0a0250ad2e59f8cf093d1e8e25becd346089c19372a13f7b23d1b8f7e","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:tuna","repository":"ghcr.io/tuna-os/bonito","tag":"tuna"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:01f86f45e2bd497cbe5f9c152f590983b533efb47f34c00b7ae931ae09f59e48","engineRevision":null,"indexDigest":"sha256:9a9dfc7d619d439ce6182cf6182528774881f9a8d4e0e01e2b749bfdeecfb2f6","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:cdb297d0a0250ad2e59f8cf093d1e8e25becd346089c19372a13f7b23d1b8f7e"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"tuna","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:tuna:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3344694194,"desktop":"xfce","digest":"sha256:abacdb4c8c0266e8724457e4f82eed6138066343b0fb1dbe8265cda889ced25c","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:xfce-nvidia","repository":"ghcr.io/tuna-os/bonito","tag":"xfce-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:f7e85d9b6af3dd24db6533cfbce0fa04df52eb0b58e09ceecb4cc52c9539f4e9","engineRevision":null,"indexDigest":"sha256:aa1facc89bfb023fe49f6047490b9c3d2fe6ff26144c5d4ad2dee7cde2135437","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:abacdb4c8c0266e8724457e4f82eed6138066343b0fb1dbe8265cda889ced25c"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:xfce-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2735942685,"desktop":"xfce","digest":"sha256:9e0bb2d41e3cebb1cde70b2ac01af44cff654d074c50ad3b7d4d366fcda54caa","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:xfce","repository":"ghcr.io/tuna-os/bonito","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:85ca98a73bc3943f121e700ab07ae2190dc2cf2711b23c21986584e5e8074cdf","engineRevision":null,"indexDigest":"sha256:ba3c339a7dec5be731a39265c662c25e7c29bf8706b1f81460125fda3585ea4a","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:9e0bb2d41e3cebb1cde70b2ac01af44cff654d074c50ad3b7d4d366fcda54caa"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:xfce:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2589490462,"desktop":"xfce","digest":"sha256:97a13a5d9b135de8ee9679acece062c16267138594dafb80fe7e4849da65d700","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:xfce","repository":"ghcr.io/tuna-os/bonito","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:c5b23fdc6133b7ee7055718c5f9b5b5b2a095eb8dceac1c5805054fcd2335176","engineRevision":null,"indexDigest":"sha256:ba3c339a7dec5be731a39265c662c25e7c29bf8706b1f81460125fda3585ea4a","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:97a13a5d9b135de8ee9679acece062c16267138594dafb80fe7e4849da65d700"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"xfce","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito"},"targetKey":"bonito:xfce:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1090787153,"desktop":"","digest":"sha256:59f70f848a26cb60d46078a06dfbd4e253d386fec9bfb0ecd95fea17cc902f07","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:base-sid","repository":"ghcr.io/tuna-os/flounder","tag":"base-sid"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:467ad007fd0207095506f279943d03c08f283c6c045821c46e9710a747cfc27a","engineRevision":null,"indexDigest":"sha256:d808141230117e04f84592121df9307cbb5c0e7d2fb3e66b805712236b1203a2","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:59f70f848a26cb60d46078a06dfbd4e253d386fec9bfb0ecd95fea17cc902f07"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder-sid"},"targetKey":"flounder-sid:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2217485851,"desktop":"gnome","digest":"sha256:10b3f776c4d459c5312e9f31ff315bfa607c17e264fb1cccff2e5ded920e4611","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:gnome-nvidia-sid","repository":"ghcr.io/tuna-os/flounder","tag":"gnome-nvidia-sid"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:b16c2fb79fc8d04a5b8c083ad9ff59d97102c22c448e68314f8d339f959c8b41","engineRevision":null,"indexDigest":"sha256:bf0f5386ccc7ed9d2f3572d2d7881dc6ced2310bc15b5b6754f7cc93a6485151","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:10b3f776c4d459c5312e9f31ff315bfa607c17e264fb1cccff2e5ded920e4611"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder-sid"},"targetKey":"flounder-sid:gnome-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1677480092,"desktop":"gnome","digest":"sha256:672b7b27b5a9e480d8f587ea5ba4a5c8f44bdfe3f38cf67b42eab969859e800b","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:gnome-sid","repository":"ghcr.io/tuna-os/flounder","tag":"gnome-sid"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:c1c145b0c61c2debd0c3033fa5ba108ae4f6fe62441ba3a1ee2906e19a606eb7","engineRevision":null,"indexDigest":"sha256:f071b74caa96dc30f5d369ce05010f530bed3f8f69c3cc85dec67bc2189daba2","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:672b7b27b5a9e480d8f587ea5ba4a5c8f44bdfe3f38cf67b42eab969859e800b"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder-sid"},"targetKey":"flounder-sid:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1927695981,"desktop":"kde","digest":"sha256:503bc5b548f0fa0d69479510a57079d6b50d1165c649e2a014aa01d41994b46d","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:kde-nvidia-sid","repository":"ghcr.io/tuna-os/flounder","tag":"kde-nvidia-sid"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:9b92672fb9e7770aad425c636e5e16cad28a103e8876f1eb1bb2af67b2bf8948","engineRevision":null,"indexDigest":"sha256:d8746995d0ddd808ffdb74a62b57596b06f7f45787c32008735a33919bc99fda","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:503bc5b548f0fa0d69479510a57079d6b50d1165c649e2a014aa01d41994b46d"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder-sid"},"targetKey":"flounder-sid:kde-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1392829457,"desktop":"kde","digest":"sha256:eec64b3575f2109bdfc7d25f18e37bb5d2d3cf6cb6943a5ecb11a49ed2083b41","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:kde-sid","repository":"ghcr.io/tuna-os/flounder","tag":"kde-sid"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:e09eaead051f7e38c996690c1c8dfd883854ce0e88da4ad7078d2987dc60075f","engineRevision":null,"indexDigest":"sha256:d75adf8925133d008bad7a6728919300e8bd501182d692c779d94755a5fa40d4","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:eec64b3575f2109bdfc7d25f18e37bb5d2d3cf6cb6943a5ecb11a49ed2083b41"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder-sid"},"targetKey":"flounder-sid:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1410093053,"desktop":"tuna","digest":"sha256:cfbdf4fe81eabd7f77f30c0c2483295edc7033dea078c51ca34fbda125df514d","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:tuna-sid","repository":"ghcr.io/tuna-os/flounder","tag":"tuna-sid"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:8d2e582ca52281de4fa5c92f36fb03d37500a4e0ae416dc74cf43acf7ef19ae2","engineRevision":null,"indexDigest":"sha256:76a0c62ddcb50cca45c6e8a89e3661aa1eb515c029f303bb986234e5ea220ec5","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:cfbdf4fe81eabd7f77f30c0c2483295edc7033dea078c51ca34fbda125df514d"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"tuna","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder-sid"},"targetKey":"flounder-sid:tuna:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1691997030,"desktop":"xfce","digest":"sha256:a5591352bea0825a9e57dda841e4711c999335783f0f2d93032450d775c9d7b3","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:xfce-nvidia-sid","repository":"ghcr.io/tuna-os/flounder","tag":"xfce-nvidia-sid"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:f3fa68382c6535017f91054f0453bed0d83ada540742c4b90ae9c8eb20b9b351","engineRevision":null,"indexDigest":"sha256:074f8a0754ff789e38b9086b149bf550ad265f18e73a192e529544587290e21e","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:a5591352bea0825a9e57dda841e4711c999335783f0f2d93032450d775c9d7b3"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder-sid"},"targetKey":"flounder-sid:xfce-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1156314828,"desktop":"xfce","digest":"sha256:7a49372ba0c33b6647c3d658a7bc0ec4c691b7015f7532219baf70714107075e","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:xfce-sid","repository":"ghcr.io/tuna-os/flounder","tag":"xfce-sid"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:5ad037b3ce31abbecc425a74023e43f9979fd5b605ec146abe5d5d0fc536c486","engineRevision":null,"indexDigest":"sha256:0c14b4bb14ae2f45a5e70bbd1c7529b80e6210512869b5ce7f769689999d72f5","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:7a49372ba0c33b6647c3d658a7bc0ec4c691b7015f7532219baf70714107075e"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder-sid"},"targetKey":"flounder-sid:xfce:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1054552849,"desktop":"","digest":"sha256:1504c789ad2f9d1d3bc791dfeed2331c6d879c1ac46723e706d9d23fa9362002","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:base","repository":"ghcr.io/tuna-os/flounder","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:f13e42325b16b6813af984e60abb8eab2778024b20fa231d32541d5a1a4f4c24","engineRevision":null,"indexDigest":"sha256:98f4f05377f62518de7834efd2d671fc353df973b7988b3be2ba7adece7469eb","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:1504c789ad2f9d1d3bc791dfeed2331c6d879c1ac46723e706d9d23fa9362002"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder"},"targetKey":"flounder:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":994999822,"desktop":"","digest":"sha256:bbd622a58e60f8d49c503694cd4d60577342471cbe747afcdd9760c8d61f008b","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:base","repository":"ghcr.io/tuna-os/flounder","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:a80ea01d71d2d411367e8aa7d79e834326d6c3f24b5ee33792bed3dcb4116c35","engineRevision":null,"indexDigest":"sha256:98f4f05377f62518de7834efd2d671fc353df973b7988b3be2ba7adece7469eb","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:bbd622a58e60f8d49c503694cd4d60577342471cbe747afcdd9760c8d61f008b"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base","hardwareScope":"generic","platform":"linux/arm64","variant":"flounder"},"targetKey":"flounder:base:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1833750460,"desktop":"kde","digest":"sha256:1491b0c8babee425123805ac268080b9ba2fcaaf3a7c3d9a16079d9dcb2126e0","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:kde-nvidia","repository":"ghcr.io/tuna-os/flounder","tag":"kde-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:96d20f74017861fedb89c7f9d935999afd1cb8365bbf8071e34bd85d9aad3e90","engineRevision":null,"indexDigest":"sha256:03dc1d662754c19958ce534e06ed69c760345df3e1d7b3209b5d7f27c9e9287a","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:1491b0c8babee425123805ac268080b9ba2fcaaf3a7c3d9a16079d9dcb2126e0"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder"},"targetKey":"flounder:kde-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1351272697,"desktop":"kde","digest":"sha256:a7e35ebf0535d32a3920c221c2aa10a7de4959e500e9921f4f338ab64a29ef87","hasSdBoot":true,"kernelVer":"6.12.115+deb13.1-amd64","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:kde","repository":"ghcr.io/tuna-os/flounder","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:bef254f09cdb6e44d23d175ed535b7ec4b61319475a2248f38670f301bb6d24a","engineRevision":null,"indexDigest":"sha256:5c1319c9df5d198b3f70a7a5cc4fad031de946beca783240772d0277b250be2a","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:a7e35ebf0535d32a3920c221c2aa10a7de4959e500e9921f4f338ab64a29ef87"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder"},"targetKey":"flounder:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1353554671,"desktop":"tuna","digest":"sha256:20f27737cb966e60e89ba08166fd3b8cfe18e2e82ee0855e19ede7bb1ecd2ce6","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:tuna","repository":"ghcr.io/tuna-os/flounder","tag":"tuna"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:8f993b704d78d5ac09c7d5d1ebae48371aa0d1d82583b909fe4734e5e3055951","engineRevision":null,"indexDigest":"sha256:4628a374d32d3a95ef4fb06351a9013bb465ccec83a31a0e091885c64273343d","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:20f27737cb966e60e89ba08166fd3b8cfe18e2e82ee0855e19ede7bb1ecd2ce6"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"tuna","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder"},"targetKey":"flounder:tuna:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1602973149,"desktop":"xfce","digest":"sha256:bab683415e87b6766e36cf64e78ed894c907a09deb8842a73328966fff1233c4","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:xfce-nvidia","repository":"ghcr.io/tuna-os/flounder","tag":"xfce-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:88728658e676fd65b03eb2dbc180115432bfd554282a2317de2c29f8945ae0f3","engineRevision":null,"indexDigest":"sha256:a49de041423b541eeb1abeb3746990ceb526a2c47c59bc901697f2829eb55a6c","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:bab683415e87b6766e36cf64e78ed894c907a09deb8842a73328966fff1233c4"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder"},"targetKey":"flounder:xfce-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1120374571,"desktop":"xfce","digest":"sha256:c82e81f99fff008416a32c0d9d7e219773d5f69e92b8f5c5ff22b05b7a7944a5","hasSdBoot":true,"kernelVer":"6.12.115+deb13.1-amd64","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:xfce","repository":"ghcr.io/tuna-os/flounder","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:13baa0017e094131fd5741ed49600eba124463ee0bfeb74d66de65ea2e9f39cd","engineRevision":null,"indexDigest":"sha256:0dc7432cc2e27627929e4d8064ef146f3fe538cb7e6441ca3b52bbe4995a7bd4","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:c82e81f99fff008416a32c0d9d7e219773d5f69e92b8f5c5ff22b05b7a7944a5"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder"},"targetKey":"flounder:xfce:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1783982486,"desktop":"","digest":"sha256:f7695910c7867e659c7146b8e35cc0e1572dbdf0d7f774780533d2a1fcbbad0c","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:base","repository":"ghcr.io/tuna-os/grouper","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:0368cb3f95b11fa42b388d8ed035b3d496999f2c6245c81d5620b6806c9f7f04","engineRevision":null,"indexDigest":"sha256:3350e11a8643a664cd3dc2489476de5df554d1a8396d324dc198a5a756e03008","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:f7695910c7867e659c7146b8e35cc0e1572dbdf0d7f774780533d2a1fcbbad0c"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"grouper"},"targetKey":"grouper:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1779029966,"desktop":"","digest":"sha256:224736f65f93ad407d7192c46af89004475849cd761dda43f7ec849a7c2cf518","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:base","repository":"ghcr.io/tuna-os/grouper","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:b96c1e332033e21d91190a51aa298eb95b22e17256d2a0010ac38bf56f52400d","engineRevision":null,"indexDigest":"sha256:3350e11a8643a664cd3dc2489476de5df554d1a8396d324dc198a5a756e03008","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:224736f65f93ad407d7192c46af89004475849cd761dda43f7ec849a7c2cf518"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base","hardwareScope":"generic","platform":"linux/arm64","variant":"grouper"},"targetKey":"grouper:base:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2102157465,"desktop":"cosmic","digest":"sha256:2be6c275313b7e3420e319d5c1bdd1c4b92f2386ea8f1d0a0d9ca7ff9fb1bad7","hasSdBoot":true,"kernelVer":"7.0.0-42-generic","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:cosmic","repository":"ghcr.io/tuna-os/grouper","tag":"cosmic"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:b0cbae5318f548f9f51758087148f97a7913162ed2bf56a73b626a30bfb771df","engineRevision":null,"indexDigest":"sha256:16c85060a52c51051a0cbde724567b14500f184cdfcecf14d8fc6f86c7c0b20a","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:2be6c275313b7e3420e319d5c1bdd1c4b92f2386ea8f1d0a0d9ca7ff9fb1bad7"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic","hardwareScope":"generic","platform":"linux/amd64","variant":"grouper"},"targetKey":"grouper:cosmic:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2103860986,"desktop":"gnome","digest":"sha256:5a624e9854c88239f6aa6f5afe5b111023afdc1e42ec65ce97d1d2ba20c40e89","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:gnome-asahi","repository":"ghcr.io/tuna-os/grouper","tag":"gnome-asahi"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:55e6df494e13a5148200e923ea6d6e00fb76f3578a5ab67466305234cdc8bb81","engineRevision":null,"indexDigest":"sha256:3a8c4c77943c7f18e93d6575c01c3f320733aba0b21edd65c87f7f780784299c","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:5a624e9854c88239f6aa6f5afe5b111023afdc1e42ec65ce97d1d2ba20c40e89"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome-asahi","hardwareScope":"apple-silicon","platform":"linux/arm64","variant":"grouper"},"targetKey":"grouper:gnome-asahi:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2095031168,"desktop":"gnome","digest":"sha256:8fc98052627aa6faae610f9d0eb5b57a0617b4176f4ad6c32efebea1f5ebc9d0","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:gnome-zfs","repository":"ghcr.io/tuna-os/grouper","tag":"gnome-zfs"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:ed86ffffd45f9ef830e98c09593d5b74c45114884fa5f4e209063f18c24d24b4","engineRevision":null,"indexDigest":"sha256:a62715a977629c16670a4df233f4ba68fcada4165f53de393f4c97ff87bbbc4a","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:8fc98052627aa6faae610f9d0eb5b57a0617b4176f4ad6c32efebea1f5ebc9d0"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-zfs","hardwareScope":"generic","platform":"linux/amd64","variant":"grouper"},"targetKey":"grouper:gnome-zfs:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2085098710,"desktop":"gnome","digest":"sha256:5be47ba11ab354ab23e60c232a4e6a6028ea96096f518604fa69462b002391c4","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:gnome-zfs","repository":"ghcr.io/tuna-os/grouper","tag":"gnome-zfs"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:b53726d78c06a421221dde3b40a5c6ead4a1b80525e82be528517a3e4d95c72f","engineRevision":null,"indexDigest":"sha256:a62715a977629c16670a4df233f4ba68fcada4165f53de393f4c97ff87bbbc4a","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:5be47ba11ab354ab23e60c232a4e6a6028ea96096f518604fa69462b002391c4"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome-zfs","hardwareScope":"generic","platform":"linux/arm64","variant":"grouper"},"targetKey":"grouper:gnome-zfs:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2196898834,"desktop":"gnome","digest":"sha256:2c3ff88b97dae7224651411867becfa3cd74cde6abaa05ba9c48009ae730703b","hasSdBoot":true,"kernelVer":"7.0.0-42-generic","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:gnome","repository":"ghcr.io/tuna-os/grouper","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:eff18d96e7926c2cec7d3a5fc85e1d647cecd6a5cb619e8d898bfc52792123a7","engineRevision":null,"indexDigest":"sha256:b0ff307839e32a3da679e2929541277b4c17e0395ec0fd4430a38b3cd63340eb","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:2c3ff88b97dae7224651411867becfa3cd74cde6abaa05ba9c48009ae730703b"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"grouper"},"targetKey":"grouper:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2186634898,"desktop":"gnome","digest":"sha256:da76b6728bbf6ac49f9a87aa027b3cb0f7b9bbdfdff2b1824bbed75fe5280280","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:gnome","repository":"ghcr.io/tuna-os/grouper","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:46748656c969717b53c0267e9b00de27fdbdca3dffa5c292794e4621c8c1cf03","engineRevision":null,"indexDigest":"sha256:b0ff307839e32a3da679e2929541277b4c17e0395ec0fd4430a38b3cd63340eb","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:da76b6728bbf6ac49f9a87aa027b3cb0f7b9bbdfdff2b1824bbed75fe5280280"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome","hardwareScope":"generic","platform":"linux/arm64","variant":"grouper"},"targetKey":"grouper:gnome:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1989337683,"desktop":"kde","digest":"sha256:0244e9940ac13b704fa9c4daf8631b825a82c0c26faafa636080bd79cc3a72cf","hasSdBoot":true,"kernelVer":"7.0.0-42-generic","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:kde","repository":"ghcr.io/tuna-os/grouper","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:add7340f7cf1951470a61fa82f0e61de0749d24d1b35d210731268e2c0e7e18a","engineRevision":null,"indexDigest":"sha256:7cc69fcd639217a9f9ad6c6c6e9cc287dda5c534f07c86c3917d28b24e9c6224","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:0244e9940ac13b704fa9c4daf8631b825a82c0c26faafa636080bd79cc3a72cf"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"grouper"},"targetKey":"grouper:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1982169094,"desktop":"kde","digest":"sha256:f62cc944023dc9aabbabafc48d4f1e367695da14063dc6de4c40100906e9261e","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:kde","repository":"ghcr.io/tuna-os/grouper","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:6d6b3c8019ff1c106f2ed855d54ac2e168189ecaad26c4c66bbc20be861f93e4","engineRevision":null,"indexDigest":"sha256:7cc69fcd639217a9f9ad6c6c6e9cc287dda5c534f07c86c3917d28b24e9c6224","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:f62cc944023dc9aabbabafc48d4f1e367695da14063dc6de4c40100906e9261e"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"kde","hardwareScope":"generic","platform":"linux/arm64","variant":"grouper"},"targetKey":"grouper:kde:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2072812826,"desktop":"tuna","digest":"sha256:3c1cf1800e5cab84fdeeb53f0b582d9f1216089c6f25d652213633bd2940f966","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:tuna","repository":"ghcr.io/tuna-os/grouper","tag":"tuna"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:db2a4c158d2c582fd55aa230659a284de5a0720cfd49a24ab89f383656714668","engineRevision":null,"indexDigest":"sha256:b945387c7df6abcad34e84b08e5b1e7587143df5b80ec16342db4b57c5b475cc","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:3c1cf1800e5cab84fdeeb53f0b582d9f1216089c6f25d652213633bd2940f966"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"tuna","hardwareScope":"generic","platform":"linux/amd64","variant":"grouper"},"targetKey":"grouper:tuna:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1815677010,"desktop":"xfce","digest":"sha256:4cea5db10225536cd4b7dd53a01ceff96ad63d9e77d73059f03f7770c75763fd","hasSdBoot":true,"kernelVer":"7.0.0-42-generic","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:xfce","repository":"ghcr.io/tuna-os/grouper","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:855d7583ee4ee44380eb2f1cd0d1f6d7072e8c3cc9b093c799c876f6c16af475","engineRevision":null,"indexDigest":"sha256:176cfdc40183716cc5ce21524b0dcbeed526d1edf1a911949ea7db0933a2114f","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:4cea5db10225536cd4b7dd53a01ceff96ad63d9e77d73059f03f7770c75763fd"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"grouper"},"targetKey":"grouper:xfce:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1810685099,"desktop":"xfce","digest":"sha256:6ab59fc2b82c1660cb4a2cdf4630010dd3d35f41671af5d02848910051af040a","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:xfce","repository":"ghcr.io/tuna-os/grouper","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:877700875de37bc5107052f61f7fb3fdc491f15ed104b362fbb59f3839fa9f8b","engineRevision":null,"indexDigest":"sha256:176cfdc40183716cc5ce21524b0dcbeed526d1edf1a911949ea7db0933a2114f","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:6ab59fc2b82c1660cb4a2cdf4630010dd3d35f41671af5d02848910051af040a"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"xfce","hardwareScope":"generic","platform":"linux/arm64","variant":"grouper"},"targetKey":"grouper:xfce:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2741166434,"desktop":"","digest":"sha256:974c8713818681bf49fce65bcf2ae784c85e80920a7981ff4209d1196e45bd75","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"emerge","repoFamily":"gentoo"},"publication":{"ref":"ghcr.io/tuna-os/guppy:base","repository":"ghcr.io/tuna-os/guppy","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:f4afa4d2538f0af75d0849b467ad38ffca5539ae8867802fb13a7e0dc9cfb861","engineRevision":null,"indexDigest":"sha256:c4140b2075e7b79bd41be2a495db84904383ad9740f7bcf79ddb2abc0724a5e2","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:974c8713818681bf49fce65bcf2ae784c85e80920a7981ff4209d1196e45bd75"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"guppy"},"targetKey":"guppy:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3030706306,"desktop":"gnome","digest":"sha256:7782d5f103c952f95f967f215b91a82a2f0dc4515ffc1a8e9c4a94c9bf0d1a33","hasSdBoot":true,"kernelVer":"6.18.38-gentoo-dist-bin","layerCount":65,"pkgManager":"emerge","repoFamily":"gentoo"},"publication":{"ref":"ghcr.io/tuna-os/guppy:gnome","repository":"ghcr.io/tuna-os/guppy","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:fbf2ff73d734660184ea2a8513e79075d3304daa8fc04abd845f88d10d9a33c6","engineRevision":null,"indexDigest":"sha256:4b081ef3a24a07be0307066e69d8e4e119c62b3e4416a052e6d152e0517aac61","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:7782d5f103c952f95f967f215b91a82a2f0dc4515ffc1a8e9c4a94c9bf0d1a33"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"guppy"},"targetKey":"guppy:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3695549843,"desktop":"kde","digest":"sha256:869dc28910fa9915903370b463e3c2bc0693372f729200dd223c6d71b7cb9133","hasSdBoot":true,"kernelVer":"6.18.54-gentoo-dist-bin","layerCount":65,"pkgManager":"emerge","repoFamily":"gentoo"},"publication":{"ref":"ghcr.io/tuna-os/guppy:kde","repository":"ghcr.io/tuna-os/guppy","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:60c0612a74970be47c7575c202dcc72cb9dec383fb0818a4043f27ac1b578b1c","engineRevision":null,"indexDigest":"sha256:b1f710c1c3492fb89075acbed717be179fc1d904b973cd4f34247e56b93d7d51","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:869dc28910fa9915903370b463e3c2bc0693372f729200dd223c6d71b7cb9133"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"guppy"},"targetKey":"guppy:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2841523017,"desktop":"xfce","digest":"sha256:989078eed2adb4c5a079a85295b830f68b2e0c48b82867c058f18ccfcf63059e","hasSdBoot":true,"kernelVer":"6.18.57-gentoo-dist-bin","layerCount":65,"pkgManager":"emerge","repoFamily":"gentoo"},"publication":{"ref":"ghcr.io/tuna-os/guppy:xfce","repository":"ghcr.io/tuna-os/guppy","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:bc6d3e1c25eadc6b6bff26dccc3dfbdfc2315cdcffcb13730c65abc40cf442b5","engineRevision":null,"indexDigest":"sha256:a16a3b45ff605d73e06a6e83a073d68a548203a0c6148f853e1413e10b6e08a6","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:989078eed2adb4c5a079a85295b830f68b2e0c48b82867c058f18ccfcf63059e"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"guppy"},"targetKey":"guppy:xfce:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1579802937,"desktop":"","digest":"sha256:ae3f05f339c0da0193fd709ac46ee7b44978ad3caa3f40b5b360256144941676","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/gurnard:base","repository":"ghcr.io/tuna-os/gurnard","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:e6f06f8eccb33b8aa266476d42be62de13630b809ce07675f4abfec0c795fe56","engineRevision":null,"indexDigest":"sha256:7bbbb33c9b6af72bf63f2c941b79accc887970bb953a0af5d482682f48ea1365","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:ae3f05f339c0da0193fd709ac46ee7b44978ad3caa3f40b5b360256144941676"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"gurnard"},"targetKey":"gurnard:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1541676008,"desktop":"","digest":"sha256:3ac08820852122a4754fba0289e873974ee298bd129601a1950255602dfb08f4","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/gurnard:base","repository":"ghcr.io/tuna-os/gurnard","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:a25c19f31bfcbf8084e9e70dc13b3c2f7c125ed159fd5cc539f23b2ca194a51c","engineRevision":null,"indexDigest":"sha256:7bbbb33c9b6af72bf63f2c941b79accc887970bb953a0af5d482682f48ea1365","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:3ac08820852122a4754fba0289e873974ee298bd129601a1950255602dfb08f4"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base","hardwareScope":"generic","platform":"linux/arm64","variant":"gurnard"},"targetKey":"gurnard:base:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1650372435,"desktop":"pantheon","digest":"sha256:bfb7865d0a1fb48bdf1253d738d4b168ac72ec6859406d9c966c47e7060a33c2","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/gurnard:pantheon","repository":"ghcr.io/tuna-os/gurnard","tag":"pantheon"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:3e47745628603f7b200d300f89a80f3037883e5b3e4af71c7c15c220efb1e4cf","engineRevision":null,"indexDigest":"sha256:576fbabbb6217934768389e570383f683cd250751deef1dd199b141b45c7c1bc","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:bfb7865d0a1fb48bdf1253d738d4b168ac72ec6859406d9c966c47e7060a33c2"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"pantheon","hardwareScope":"generic","platform":"linux/amd64","variant":"gurnard"},"targetKey":"gurnard:pantheon:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1611077116,"desktop":"pantheon","digest":"sha256:73bd2e1fabc208ce6c39749efbfbdd838fb0927143cafe2921810d1f7459129e","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/gurnard:pantheon","repository":"ghcr.io/tuna-os/gurnard","tag":"pantheon"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:0c26173a3eb553105731caf6c00b2e73c28abd83f9a85f2931604f72591fe46b","engineRevision":null,"indexDigest":"sha256:576fbabbb6217934768389e570383f683cd250751deef1dd199b141b45c7c1bc","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:73bd2e1fabc208ce6c39749efbfbdd838fb0927143cafe2921810d1f7459129e"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"pantheon","hardwareScope":"generic","platform":"linux/arm64","variant":"gurnard"},"targetKey":"gurnard:pantheon:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":841052241,"desktop":"","digest":"sha256:4ae00c3b2a21db49630015332dd9080a0b4b59d0dce91bd91080c2e661fb3565","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/hummingbird:base","repository":"ghcr.io/tuna-os/hummingbird","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:a24bb8429ce27d573bdb576af66f22affc70890bcfbfafe93f8fa3bc01a61814","engineRevision":null,"indexDigest":"sha256:91af0af348f90052f8831029d59da49683bb57eb1573e82ed933ae64cc1b1cc5","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:4ae00c3b2a21db49630015332dd9080a0b4b59d0dce91bd91080c2e661fb3565"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"hummingbird"},"targetKey":"hummingbird:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1193415389,"desktop":"gnome","digest":"sha256:04360b52392abab53704043393fd758b9f343a242a2fdab4d349da93f9f533f0","hasSdBoot":false,"kernelVer":"7.1.8-100.fc43.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/hummingbird:cosmic","repository":"ghcr.io/tuna-os/hummingbird","tag":"cosmic"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:84f342bb8f3576762e66b095fb780742e16a5238ee1c8ce8a3e5dd607a629545","engineRevision":null,"indexDigest":"sha256:ede5242ee8e235933dd4866c3619e055cbd820300fe3d9807feecfe4f7fcc4ba","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:04360b52392abab53704043393fd758b9f343a242a2fdab4d349da93f9f533f0"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic","hardwareScope":"generic","platform":"linux/amd64","variant":"hummingbird"},"targetKey":"hummingbird:cosmic:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1718947608,"desktop":"gnome","digest":"sha256:83060f29b37743b0086e88546ac1b223e2373ae7f23fe0a8dc68a37c92cee6d2","hasSdBoot":false,"kernelVer":"7.2.8-200.fc44.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/hummingbird:gnome","repository":"ghcr.io/tuna-os/hummingbird","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:7b4273fe1a503cc7c4cbdf2e2ec35ab1c7de246a184436f157e4e58f9e7a9ebb","engineRevision":null,"indexDigest":"sha256:7fb82c04e8dfa63d76299dd07f2d82ea3c832485f913840fd88d56ea472411dd","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:83060f29b37743b0086e88546ac1b223e2373ae7f23fe0a8dc68a37c92cee6d2"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"hummingbird"},"targetKey":"hummingbird:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1632401120,"desktop":"","digest":"sha256:94cc92cbe063a482c73d34b27e7408d8184f758c53a2dead14299b2a287cf7f9","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:base","repository":"ghcr.io/tuna-os/marlin","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:0afe36619dd355b2500140c355e0e364744cc324c0962b5f67ed67381905f355","engineRevision":null,"indexDigest":"sha256:3a97f3e94441851c2c6c9d99c2fb2790038b4d3830632201be32c883fe255824","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:94cc92cbe063a482c73d34b27e7408d8184f758c53a2dead14299b2a287cf7f9"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1501763853,"desktop":"","digest":"sha256:ff13a39537748be0bcfb41d61d4bc5c6a5e4c127a2c09f13f06384c613f92351","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:base","repository":"ghcr.io/tuna-os/marlin","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:c1fe7fc7611283965e715aa6fd5f558cf91ae7024dd3e35c01f22891999f2928","engineRevision":null,"indexDigest":"sha256:3a97f3e94441851c2c6c9d99c2fb2790038b4d3830632201be32c883fe255824","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:ff13a39537748be0bcfb41d61d4bc5c6a5e4c127a2c09f13f06384c613f92351"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base","hardwareScope":"generic","platform":"linux/arm64","variant":"marlin"},"targetKey":"marlin:base:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2983966105,"desktop":"cosmic","digest":"sha256:a2d5dc52980e20cd6e62fceeeb7dd90710698d533259cc7a84716d7b7c7f8756","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:cosmic-cachyos","repository":"ghcr.io/tuna-os/marlin","tag":"cosmic-cachyos"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:947f6973c6560281e5f168f04d14384ae714d629e005e6699f90df28c5bcd188","engineRevision":null,"indexDigest":"sha256:5faca51c1f5b24476b248a9f9215d033817a3e17d8badb4bdc1c394e9e662eaf","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:a2d5dc52980e20cd6e62fceeeb7dd90710698d533259cc7a84716d7b7c7f8756"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic-cachyos","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:cosmic-cachyos:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3560142404,"desktop":"cosmic","digest":"sha256:8cf5829018df2d7158a63d9af3674b338214d803a272e2ec1e8752e1f80b5c65","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:cosmic-nvidia","repository":"ghcr.io/tuna-os/marlin","tag":"cosmic-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:6e71c51a462e2b9a2fb7b1be427ce4a042f84ec12fee265c00e3f8c1dd7ae78c","engineRevision":null,"indexDigest":"sha256:bea19631c68e3a34c85c03093f94c23f02b92489ac1f3c87f957bdc9d5b9daa0","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:8cf5829018df2d7158a63d9af3674b338214d803a272e2ec1e8752e1f80b5c65"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:cosmic-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2358582483,"desktop":"cosmic","digest":"sha256:11308b84729537a03aecaec6fd0b4b3736b0bf3e9f4cb818e84bfeef556ee82b","hasSdBoot":true,"kernelVer":"7.2.14-arch1-1","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:cosmic","repository":"ghcr.io/tuna-os/marlin","tag":"cosmic"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:cfbea16c140634770e1ce0c7860e2b921a162e49adba8623bd67de76788d4e8d","engineRevision":null,"indexDigest":"sha256:6e8d5f37d07353532df6734a3a48aa4ace31ce002e7b4d3c40ea62ed22adf357","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:11308b84729537a03aecaec6fd0b4b3736b0bf3e9f4cb818e84bfeef556ee82b"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:cosmic:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3053440711,"desktop":"gnome","digest":"sha256:77147c0aa418ba3ea2090f7edae157333f7776d3fdebe85442ee7dfdf9112a2d","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:gnome-cachyos","repository":"ghcr.io/tuna-os/marlin","tag":"gnome-cachyos"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:d3b8e6a04a3adcf1bc21fa07b86a7720f39a1f137fc48369ae27090a59a346f3","engineRevision":null,"indexDigest":"sha256:24abf98f441a263fe938f2a5512589d1269b22f7b82830ec56c2a3da87c9d939","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:77147c0aa418ba3ea2090f7edae157333f7776d3fdebe85442ee7dfdf9112a2d"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-cachyos","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:gnome-cachyos:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3626470850,"desktop":"gnome","digest":"sha256:a3d457ffe4ed059052c2cac120ef9b79558fd4655727bcb170c3682f59c878d7","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:gnome-nvidia","repository":"ghcr.io/tuna-os/marlin","tag":"gnome-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:6f6dd02264b1651afb5621c7413e0319981742b11d1086accfc90c46d9b3f6fc","engineRevision":null,"indexDigest":"sha256:afff7582821d18d3cd6d35b21fee4f0532d6b6679c2e85d0284200d27d5217bb","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:a3d457ffe4ed059052c2cac120ef9b79558fd4655727bcb170c3682f59c878d7"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:gnome-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2907593907,"desktop":"gnome","digest":"sha256:102d1c3b9a9f04bc48a3cd5ae97e266631c0e7c7d55a60a187254258d954abf0","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:gnome-x13s","repository":"ghcr.io/tuna-os/marlin","tag":"gnome-x13s"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:49d67afc9ed32c17afc6bce2bfaa3fb3f1ab03b6c3188f8adcbeec2541bef2f0","engineRevision":null,"indexDigest":"sha256:bf2b234bd33e575be6344b5fa06baac19bb03e7352b412e70380f5de566f95b3","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:102d1c3b9a9f04bc48a3cd5ae97e266631c0e7c7d55a60a187254258d954abf0"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome-x13s","hardwareScope":"generic","platform":"linux/arm64","variant":"marlin"},"targetKey":"marlin:gnome-x13s:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2406150520,"desktop":"gnome","digest":"sha256:4a5d8330886b926306ba684553dbb8b183179d2215a71c05b8577e7fe7eafd3a","hasSdBoot":true,"kernelVer":"7.2.14-arch1-1","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:gnome","repository":"ghcr.io/tuna-os/marlin","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:0e82f692f9ff12ae8d1b818ed2df4b87edaa620e2cc299814e93fb6e091651ae","engineRevision":null,"indexDigest":"sha256:90e746948b2ecbc2239b196a8fe7196bc4a5379de96c7d5e004c2f69ee8138c6","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:4a5d8330886b926306ba684553dbb8b183179d2215a71c05b8577e7fe7eafd3a"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2366248481,"desktop":"gnome","digest":"sha256:b5f25b0f01e4a71f90fa87ea1d2dd6fd07f613ab08ef632db93c1efc25be86c6","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:gnome","repository":"ghcr.io/tuna-os/marlin","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:b2fda4a7a7267a29f1bee894d9d55bd7b7c8c65de4ad2389f9aeaf90c8515dec","engineRevision":null,"indexDigest":"sha256:90e746948b2ecbc2239b196a8fe7196bc4a5379de96c7d5e004c2f69ee8138c6","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:b5f25b0f01e4a71f90fa87ea1d2dd6fd07f613ab08ef632db93c1efc25be86c6"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome","hardwareScope":"generic","platform":"linux/arm64","variant":"marlin"},"targetKey":"marlin:gnome:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3015376165,"desktop":"kde","digest":"sha256:9a1ad75f19ecbcaa1b1acc2e64bce9dd147c70884f211176305df57c47a8d0c2","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:kde-cachyos","repository":"ghcr.io/tuna-os/marlin","tag":"kde-cachyos"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:e6e36858cdba402a4a41fd4d917e323976e600002cfd0881ab6fbda2aaf2bd30","engineRevision":null,"indexDigest":"sha256:60b1307f2066d2a6cf0e714eb1083cac5ae188c1e67b10aef03594a643f42b03","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:9a1ad75f19ecbcaa1b1acc2e64bce9dd147c70884f211176305df57c47a8d0c2"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde-cachyos","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:kde-cachyos:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3590271414,"desktop":"kde","digest":"sha256:8eccfcccb32d1257900adb2ce46b6900477162167ba13d6522cc44de302a0922","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:kde-nvidia","repository":"ghcr.io/tuna-os/marlin","tag":"kde-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:8b8ef8bb1b39766e2ef62780fd18510b713b770df7990c9a46bc46e713168f08","engineRevision":null,"indexDigest":"sha256:933a4013901febeb2b8f629cc7637873ffb7af87cdef0699245978ddb3b557ff","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:8eccfcccb32d1257900adb2ce46b6900477162167ba13d6522cc44de302a0922"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:kde-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2369249538,"desktop":"kde","digest":"sha256:3bd41d6235573f804ef6af11a6dbb66446b044f98e750fa94f4b61005c5485fd","hasSdBoot":true,"kernelVer":"7.2.14-arch1-1","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:kde","repository":"ghcr.io/tuna-os/marlin","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:7e60911740e3cb1ceefd63999c1d2d5995e307a84c6932114efaa99e3ccc4649","engineRevision":null,"indexDigest":"sha256:81e5f8400fe630643593a85800b252a832451804587eefba864ccc80428a82fa","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:3bd41d6235573f804ef6af11a6dbb66446b044f98e750fa94f4b61005c5485fd"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2536800081,"desktop":"niri","digest":"sha256:90e3dbb9a26127c84fb2fe954a97be22dfe72651d19caef396ef45b7ee56244e","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:niri-cachyos","repository":"ghcr.io/tuna-os/marlin","tag":"niri-cachyos"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:07a8c2932c3003ba0ed4395e93b5341b518a8fd3f36e179302255a22f28aed9f","engineRevision":null,"indexDigest":"sha256:060bbf1c01b63efa0a56f27c97dc3709b4eff17ea645b235b08b10e4fbde862f","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:90e3dbb9a26127c84fb2fe954a97be22dfe72651d19caef396ef45b7ee56244e"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri-cachyos","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:niri-cachyos:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3113047119,"desktop":"niri","digest":"sha256:3da2cfd80a6fc3d6553699e8284e15051b5dacb6e545ea9c7ee24c4b96aeb244","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:niri-nvidia","repository":"ghcr.io/tuna-os/marlin","tag":"niri-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:86bd3f8f43134f9a8c3dbdcd0e4d939d02ed16c9252c01e262d880bf8c7cc0e5","engineRevision":null,"indexDigest":"sha256:7faddcf80a01eeec4a9d9c857ff6e9b0ab14c8fac0686ad555755d0c47eebdd4","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:3da2cfd80a6fc3d6553699e8284e15051b5dacb6e545ea9c7ee24c4b96aeb244"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:niri-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1912138391,"desktop":"niri","digest":"sha256:5e10559cc1693eefcedc5809bfceb6b083f0ff90a9b4990d9fdce9c87f2d6941","hasSdBoot":true,"kernelVer":"7.2.14-arch1-1","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:niri","repository":"ghcr.io/tuna-os/marlin","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:768a9d46df7cffdee9dfcc89aaf726b6b38f061b9196458725f7d8b49a98e79e","engineRevision":null,"indexDigest":"sha256:ca33a51c3da35cc727fc264a64d5f76fecaaa7592917744e7552eb9a4d06754a","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:5e10559cc1693eefcedc5809bfceb6b083f0ff90a9b4990d9fdce9c87f2d6941"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:niri:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2324074509,"desktop":"tuna","digest":"sha256:7f6169ae5997590ced01ee279144e3a56e9c3c005a25225a057ecf8a63be934c","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:tuna","repository":"ghcr.io/tuna-os/marlin","tag":"tuna"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:c41fb29220a956c33aadeaf59af740fc023a422691477a0243379d8b7cc8bbc7","engineRevision":null,"indexDigest":"sha256:e95589e7958ee53a593cb586a36c0ca5702b590b06fc51a25cd0f377d478010c","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:7f6169ae5997590ced01ee279144e3a56e9c3c005a25225a057ecf8a63be934c"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"tuna","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:tuna:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2662271999,"desktop":"xfce","digest":"sha256:e57073b097d1bcacce97f1ac6f6385eb4e6bcf1e7c0be93d36e30de6afebfcb7","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:xfce-cachyos","repository":"ghcr.io/tuna-os/marlin","tag":"xfce-cachyos"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:b953dd77f64c88b5a2e0c050a87d07dee217ff00f48895310c34e452993eac3d","engineRevision":null,"indexDigest":"sha256:4ed1f85dc20d29413f3d0635c379e0f407f2b801c54074181fd17272a21eb30a","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:e57073b097d1bcacce97f1ac6f6385eb4e6bcf1e7c0be93d36e30de6afebfcb7"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce-cachyos","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:xfce-cachyos:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3237903187,"desktop":"xfce","digest":"sha256:eea4540290cf38302deec9652644af677b5d8d9f561730dac1a9ba910c7e6a88","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:xfce-nvidia","repository":"ghcr.io/tuna-os/marlin","tag":"xfce-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:86e4ff816bb9d5f02b6793aa446fb37dcd535addf81b41e513779674ea860deb","engineRevision":null,"indexDigest":"sha256:507a0cf89159b48f70f330c90d2532670e225db1a62786e41e60991573c40b97","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:eea4540290cf38302deec9652644af677b5d8d9f561730dac1a9ba910c7e6a88"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:xfce-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2036899284,"desktop":"xfce","digest":"sha256:b18998c3865427d7128feb0c84da60b933e9dc434e251e3d1b1ed0743f9b09c2","hasSdBoot":true,"kernelVer":"7.2.14-arch1-1","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:xfce","repository":"ghcr.io/tuna-os/marlin","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:d3e5f895d0bcfc792442cb85680894b8903855d8898dee2c05adfe4af614ed28","engineRevision":null,"indexDigest":"sha256:c167962d333ab2c560f4138a16a3ec8c758d1ba63934b22d6056f1465a2231df","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:b18998c3865427d7128feb0c84da60b933e9dc434e251e3d1b1ed0743f9b09c2"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:xfce:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1490112716,"desktop":"","digest":"sha256:05fb7334c3c4fdf10e228be12eda4e87b201bee4369cf8c5afb97e1ab0e671a6","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"zypper","repoFamily":"opensuse"},"publication":{"ref":"ghcr.io/tuna-os/sailfin:base","repository":"ghcr.io/tuna-os/sailfin","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:04d4009c85f1cb50bdb5d8bd1a1d486b168ecaf399622a2d6fdedc7c2efca23c","engineRevision":null,"indexDigest":"sha256:164b75a63e431cb3fcd72584be9d4d94b369d3c80ce1ed17f462cb5fa4e6c040","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:05fb7334c3c4fdf10e228be12eda4e87b201bee4369cf8c5afb97e1ab0e671a6"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"sailfin"},"targetKey":"sailfin:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1517450750,"desktop":"","digest":"sha256:93ec1517d81526c870d163a2b0b92085f1206e3b3113cd7fe85375816eacb1cd","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"zypper","repoFamily":"opensuse"},"publication":{"ref":"ghcr.io/tuna-os/sailfin:base","repository":"ghcr.io/tuna-os/sailfin","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:5cefc6a5b203520ed6dabb4382de5dfa3ef98537757352ab47e75cbc183e8efa","engineRevision":null,"indexDigest":"sha256:164b75a63e431cb3fcd72584be9d4d94b369d3c80ce1ed17f462cb5fa4e6c040","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:93ec1517d81526c870d163a2b0b92085f1206e3b3113cd7fe85375816eacb1cd"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base","hardwareScope":"generic","platform":"linux/arm64","variant":"sailfin"},"targetKey":"sailfin:base:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1755569978,"desktop":"cosmic","digest":"sha256:63bc027218662f76d00cca4589094567a2ce7d6d048317dfcfa9f3bf1abbbe6c","hasSdBoot":true,"kernelVer":"7.3.0-1-default","layerCount":65,"pkgManager":"zypper","repoFamily":"opensuse"},"publication":{"ref":"ghcr.io/tuna-os/sailfin:cosmic","repository":"ghcr.io/tuna-os/sailfin","tag":"cosmic"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:567f161a6b8bc03d52b029e115b978a33016731a569a53c3112ff62d9e035df2","engineRevision":null,"indexDigest":"sha256:0d71630181de1c257be7f73014bf6c3c163f3da5ccb72931f20830bc68485145","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:63bc027218662f76d00cca4589094567a2ce7d6d048317dfcfa9f3bf1abbbe6c"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic","hardwareScope":"generic","platform":"linux/amd64","variant":"sailfin"},"targetKey":"sailfin:cosmic:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1880566871,"desktop":"gnome","digest":"sha256:4f9c8426674a92a495eed88c0ad2330ddf8097d0407cbe03cec4f7d9b27f02a0","hasSdBoot":true,"kernelVer":"7.3.0-1-default","layerCount":65,"pkgManager":"zypper","repoFamily":"opensuse"},"publication":{"ref":"ghcr.io/tuna-os/sailfin:gnome","repository":"ghcr.io/tuna-os/sailfin","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:840b0d322d544c26895a6a24c4ab358196c8b7c874c07440a226651577c15620","engineRevision":null,"indexDigest":"sha256:a81977c06da70d82ea1be16d64270716783a97e4140d619a370dfcdee4155f55","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:4f9c8426674a92a495eed88c0ad2330ddf8097d0407cbe03cec4f7d9b27f02a0"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"sailfin"},"targetKey":"sailfin:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1890107846,"desktop":"gnome","digest":"sha256:a433dc6349e45669372f02198bba757f8c0fbfab43af7102a53dda545bcafc74","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"zypper","repoFamily":"opensuse"},"publication":{"ref":"ghcr.io/tuna-os/sailfin:gnome","repository":"ghcr.io/tuna-os/sailfin","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:57a5662dba4f32183c7938e50e5a2660d86e01eec6720c7f35a050616b6a736f","engineRevision":null,"indexDigest":"sha256:a81977c06da70d82ea1be16d64270716783a97e4140d619a370dfcdee4155f55","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:a433dc6349e45669372f02198bba757f8c0fbfab43af7102a53dda545bcafc74"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome","hardwareScope":"generic","platform":"linux/arm64","variant":"sailfin"},"targetKey":"sailfin:gnome:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2273754357,"desktop":"kde","digest":"sha256:728201ccdabcb2bf9f8b0f22c893d20bcd96dca78421fc1220e931ed259cac3b","hasSdBoot":true,"kernelVer":"7.3.0-1-default","layerCount":65,"pkgManager":"zypper","repoFamily":"opensuse"},"publication":{"ref":"ghcr.io/tuna-os/sailfin:kde","repository":"ghcr.io/tuna-os/sailfin","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:7e610aa15d6852322807d24e69209b5b1e256a5a58a37322c3c0d1f2dd90e208","engineRevision":null,"indexDigest":"sha256:0ae52e1bc946869cac29967859703f08548edcfb9ffad04ce737196c0cd2950b","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:728201ccdabcb2bf9f8b0f22c893d20bcd96dca78421fc1220e931ed259cac3b"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"sailfin"},"targetKey":"sailfin:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1638440369,"desktop":"niri","digest":"sha256:7a2b159ab59919165583692e7452a1f40c06831c9288c8483076c71e3a6cc71e","hasSdBoot":true,"kernelVer":"7.3.0-1-default","layerCount":65,"pkgManager":"zypper","repoFamily":"opensuse"},"publication":{"ref":"ghcr.io/tuna-os/sailfin:niri","repository":"ghcr.io/tuna-os/sailfin","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:8df0839c002ea101114a36dbdbd1d04ba470bc1da1f60ffe4e4ae99013b1f5b4","engineRevision":null,"indexDigest":"sha256:93e887d2cb04435f4cb4669b5fc790dca917162ccfe0594a5ebdc6b60cc7fe8f","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:7a2b159ab59919165583692e7452a1f40c06831c9288c8483076c71e3a6cc71e"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri","hardwareScope":"generic","platform":"linux/amd64","variant":"sailfin"},"targetKey":"sailfin:niri:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1784629254,"desktop":"tuna","digest":"sha256:1d35c234e210c5174b7ed7f8f9e65eec631f4acd6329deea148176894d95ba97","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"zypper","repoFamily":"opensuse"},"publication":{"ref":"ghcr.io/tuna-os/sailfin:tuna","repository":"ghcr.io/tuna-os/sailfin","tag":"tuna"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:d306062ae645b35d6745c93cf44b7ffa25510596a4af69f4f609581c11ba3046","engineRevision":null,"indexDigest":"sha256:34017524f8e2ecf018386a8ca415e333e9ccb88360c0de1bb39a2ca7a4217dca","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:1d35c234e210c5174b7ed7f8f9e65eec631f4acd6329deea148176894d95ba97"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"tuna","hardwareScope":"generic","platform":"linux/amd64","variant":"sailfin"},"targetKey":"sailfin:tuna:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1693336538,"desktop":"xfce","digest":"sha256:8c3835c7deb50d915470b231fd51291933548343d123f5c733c75b0f644c25ef","hasSdBoot":true,"kernelVer":"7.3.0-1-default","layerCount":65,"pkgManager":"zypper","repoFamily":"opensuse"},"publication":{"ref":"ghcr.io/tuna-os/sailfin:xfce","repository":"ghcr.io/tuna-os/sailfin","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:1e9b57de6c8d1e531435c32e0ce26aedd23cc1e9a46b91ff64dcff10b1d644b3","engineRevision":null,"indexDigest":"sha256:8a91cc093dfd297391e2082983db91c103d7de8728f3ab99c20d57d92f71cebe","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:8c3835c7deb50d915470b231fd51291933548343d123f5c733c75b0f644c25ef"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"sailfin"},"targetKey":"sailfin:xfce:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1530989429,"desktop":"","digest":"sha256:9a7425d3d90c0ef786dd207365b5ec64c66c36e3e2be9fdc52601a0b9300679e","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:base-hwe","repository":"ghcr.io/tuna-os/skipjack","tag":"base-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:cab6f6037ba641574becfe9778f30e3151ad07813fefbfea37f573547c8d2d94","engineRevision":null,"indexDigest":"sha256:367603cc98e8c04de6652e7bc9df52924457a77671e67ff4ff60f46499decc6f","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:9a7425d3d90c0ef786dd207365b5ec64c66c36e3e2be9fdc52601a0b9300679e"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"base-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:base-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1429900368,"desktop":"","digest":"sha256:59d59426a23f5814fcbda794385b9e74468f4379ccff92a69f7b0ec81db3bbc0","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:base-hwe","repository":"ghcr.io/tuna-os/skipjack","tag":"base-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:bc3fbcbc7de1269c7b5bb3b1eb6f21f3f692687832c681c270b8b10584cd42e5","engineRevision":null,"indexDigest":"sha256:367603cc98e8c04de6652e7bc9df52924457a77671e67ff4ff60f46499decc6f","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:59d59426a23f5814fcbda794385b9e74468f4379ccff92a69f7b0ec81db3bbc0"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"skipjack"},"targetKey":"skipjack:base-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2165689793,"desktop":"","digest":"sha256:739f5b17fea38c838a917bcc76803504b35b9b3d7bdbb14889260b0c80f76905","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:base-nvidia","repository":"ghcr.io/tuna-os/skipjack","tag":"base-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:08a1ff34ebbf65f6f4feff8024d0adddac613b0728d927c3f089b42c5a1e5794","engineRevision":null,"indexDigest":"sha256:820a2b7a9800a5bf1a6aed3351291df12cfabc494cb1aae706350745c5eb2b24","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:739f5b17fea38c838a917bcc76803504b35b9b3d7bdbb14889260b0c80f76905"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"base-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:base-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1497237526,"desktop":"","digest":"sha256:03d81c6219a7c4596c093b004d168b6169e5aee478410c9501c389dc87e62c4e","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:base","repository":"ghcr.io/tuna-os/skipjack","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:6f57c04912a38f465be2770a3a56cb46a2a4b8cc2ed9101f802f21e72432b06a","engineRevision":null,"indexDigest":"sha256:8b04f1d9667db42df0b5c61eea373548b5f3c4b1b3c986ed88f02ca3ddaa76ca","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:03d81c6219a7c4596c093b004d168b6169e5aee478410c9501c389dc87e62c4e"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1394497328,"desktop":"","digest":"sha256:e04cafbd6607020e79c9efed86397f62e525f95601b61539c2dadd47bbf62b64","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:base","repository":"ghcr.io/tuna-os/skipjack","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:ddf2bd35e761c6235e3ad07924aa105799785bbcda798eb1297e328237bf7a65","engineRevision":null,"indexDigest":"sha256:8b04f1d9667db42df0b5c61eea373548b5f3c4b1b3c986ed88f02ca3ddaa76ca","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:e04cafbd6607020e79c9efed86397f62e525f95601b61539c2dadd47bbf62b64"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base","hardwareScope":"generic","platform":"linux/arm64","variant":"skipjack"},"targetKey":"skipjack:base:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1906520572,"desktop":"cosmic","digest":"sha256:313dc2ff6021a75e77b1e1d951aa1994d268da226b671376f67acbbcf02bfde3","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:cosmic-hwe","repository":"ghcr.io/tuna-os/skipjack","tag":"cosmic-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:372d270f87b3abcf17cd5c6a0bf53c747ba783af561ceb48c148f3042910002a","engineRevision":null,"indexDigest":"sha256:21f829675f9cc90e97ec301cb369f8410c1097ffae7d21804e476b16d19f5e84","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:313dc2ff6021a75e77b1e1d951aa1994d268da226b671376f67acbbcf02bfde3"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"cosmic-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:cosmic-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2543915085,"desktop":"cosmic","digest":"sha256:a1d4fd8103e4be680d144d92518b058fd35f0e553c60598954322b8254a00599","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:cosmic-nvidia","repository":"ghcr.io/tuna-os/skipjack","tag":"cosmic-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:e6c9e00dda6dd7a16fdf9bf676038f85f992b419df55d43ed0530ce127790f34","engineRevision":null,"indexDigest":"sha256:0847fc573bda2ee472945a08316dc3f5e7bc2e38be286d4d7b992a9305855f87","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:a1d4fd8103e4be680d144d92518b058fd35f0e553c60598954322b8254a00599"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"cosmic-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:cosmic-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1906501781,"desktop":"cosmic","digest":"sha256:fbd97c08f3108ec9368e2b8b8908be2fda49a1786a7e4f19875b46c1ec34fb6f","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:cosmic","repository":"ghcr.io/tuna-os/skipjack","tag":"cosmic"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:651911b196665f5c9d98a1f152e26da7ef60effaf7f5cb322a366007347d340d","engineRevision":null,"indexDigest":"sha256:2e762b6749815d05c075ba77405e391a6a4ec181962da893a70ded208df84f68","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:fbd97c08f3108ec9368e2b8b8908be2fda49a1786a7e4f19875b46c1ec34fb6f"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"cosmic","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:cosmic:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1890584662,"desktop":"gnome","digest":"sha256:65239f4a2bda28e9a8ddc328a69516e4ff492c4cdb33be66e12e174943d13f37","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:gnome-hwe","repository":"ghcr.io/tuna-os/skipjack","tag":"gnome-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:7b65a9cbd3fee15e40f1f26dd395ec76b647c54486ba8848fbd412726a08eba8","engineRevision":null,"indexDigest":"sha256:e808b6097016669f8aa5eacd80ec2c28842ce2169713b8eb5fa79c9fa90d1fc3","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:65239f4a2bda28e9a8ddc328a69516e4ff492c4cdb33be66e12e174943d13f37"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"gnome-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:gnome-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1890587589,"desktop":"gnome","digest":"sha256:cae9e2ee66eb5d623e48411d59c1bb42b99d735002a968e1771a43844ad65eb2","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:gnome-hwe","repository":"ghcr.io/tuna-os/skipjack","tag":"gnome-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:82d1d39aff064b3131cb70f5c2a50cb220acd80ef40dd5d76e91d3b86997f2f6","engineRevision":null,"indexDigest":"sha256:e808b6097016669f8aa5eacd80ec2c28842ce2169713b8eb5fa79c9fa90d1fc3","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:cae9e2ee66eb5d623e48411d59c1bb42b99d735002a968e1771a43844ad65eb2"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"gnome-hwe","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"skipjack"},"targetKey":"skipjack:gnome-hwe:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2481216845,"desktop":"gnome","digest":"sha256:f7038a142d128282b9454df9745c0e5f2eea8b84b93a85e40dc8dc10b3949469","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:gnome-nvidia","repository":"ghcr.io/tuna-os/skipjack","tag":"gnome-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:f731f39b3df6a2f36bd30ed3c4e076ef92f1e9abffbdab0e17558c15c8fb41a4","engineRevision":null,"indexDigest":"sha256:1b03213a543a826b0eecd0e2e58351338cb0c8574dab20c689c8d1e6bc8d60a6","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:f7038a142d128282b9454df9745c0e5f2eea8b84b93a85e40dc8dc10b3949469"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"gnome-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:gnome-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1890586271,"desktop":"gnome","digest":"sha256:80f53cbc695c3f34b94554ffa5cc0dab33c474518dc8ce4b1107f0fcc25df6cf","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:gnome","repository":"ghcr.io/tuna-os/skipjack","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:911c572dc1d2293cb924836b4da8bf5ebfde443dc0d00f2758f6a7c4660dd3ec","engineRevision":null,"indexDigest":"sha256:8f5e1d947307417f1d292ae215b1ad4d9572d2f735109117b10aaf8180877849","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:80f53cbc695c3f34b94554ffa5cc0dab33c474518dc8ce4b1107f0fcc25df6cf"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1890584493,"desktop":"gnome","digest":"sha256:cf1561ecbc02651171569ec1f2ca6304376cde91b2954d8a58662d0ce17afa30","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:gnome","repository":"ghcr.io/tuna-os/skipjack","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:4dc2d6761141df658fc3764915c9d8f4fbeae44ffee2db28b56ad11a96e7a107","engineRevision":null,"indexDigest":"sha256:8f5e1d947307417f1d292ae215b1ad4d9572d2f735109117b10aaf8180877849","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:cf1561ecbc02651171569ec1f2ca6304376cde91b2954d8a58662d0ce17afa30"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"skipjack"},"targetKey":"skipjack:gnome:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1983637641,"desktop":"kde","digest":"sha256:3dc66bdce8fc1228d451fb8e9e16877c37666c56403d43c312c062ccfede8f04","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:kde-hwe","repository":"ghcr.io/tuna-os/skipjack","tag":"kde-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:147e45bed2ccb973fc725eb49329495daf797637e14ed6071f1c8f6c7e902701","engineRevision":null,"indexDigest":"sha256:91f54810973674f7d76e9f1b837ab8d95cb80adc14463094c03a4b14165b38e4","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:3dc66bdce8fc1228d451fb8e9e16877c37666c56403d43c312c062ccfede8f04"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"kde-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:kde-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1875621992,"desktop":"kde","digest":"sha256:10ad6b7c06f7425276c6437f2f010bf561406e56c0042fab9d99c5ac0d87075c","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:kde-hwe","repository":"ghcr.io/tuna-os/skipjack","tag":"kde-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:7a26841a2f09838ed959a07ed1fd0262500eefd19a4abb0b58ef141f07dc788c","engineRevision":null,"indexDigest":"sha256:91f54810973674f7d76e9f1b837ab8d95cb80adc14463094c03a4b14165b38e4","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:10ad6b7c06f7425276c6437f2f010bf561406e56c0042fab9d99c5ac0d87075c"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"kde-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"skipjack"},"targetKey":"skipjack:kde-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2622107445,"desktop":"kde","digest":"sha256:87caa11053c03de4ffef084ec09c0e925351cb4f267190a4de8825bdb4aedce2","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:kde-nvidia","repository":"ghcr.io/tuna-os/skipjack","tag":"kde-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:2c295475a24f6631b1a4dfb2f843822fcfc611babfa07d9f1af24a6fa84619f1","engineRevision":null,"indexDigest":"sha256:aa2276ed1fdba568fa589e8c3af30d01aa578da61d799808ca1d621fc62364a2","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:87caa11053c03de4ffef084ec09c0e925351cb4f267190a4de8825bdb4aedce2"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"kde-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:kde-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1984547728,"desktop":"kde","digest":"sha256:9e1c8020e489665d4185e50105fa7210a6d351e39da080d52d7643ae809b1b0a","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:kde","repository":"ghcr.io/tuna-os/skipjack","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:cc7c7b768f50654aa9ddd364886cfdec3525f0623163335f288cf485d1b17f8f","engineRevision":null,"indexDigest":"sha256:d9adf2fa9fcb660e0ac207e559c605ed83a1a6464923c9ff2e9303a037576495","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:9e1c8020e489665d4185e50105fa7210a6d351e39da080d52d7643ae809b1b0a"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1876574308,"desktop":"kde","digest":"sha256:ccd9c3b185a5c80528015be175fa4de9a51904ccfa3fa80a18df2c0d8f6fead7","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:kde","repository":"ghcr.io/tuna-os/skipjack","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:b327be1dd065ff8c984fab957d6067b15c10918e3bb8e7e62dac10b13affb75a","engineRevision":null,"indexDigest":"sha256:d9adf2fa9fcb660e0ac207e559c605ed83a1a6464923c9ff2e9303a037576495","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:ccd9c3b185a5c80528015be175fa4de9a51904ccfa3fa80a18df2c0d8f6fead7"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"kde","hardwareScope":"generic","platform":"linux/arm64","variant":"skipjack"},"targetKey":"skipjack:kde:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1773415138,"desktop":"niri","digest":"sha256:2c9fce5f451c3cd90f10bf0eb3d07ba8c923bf84e36734e8d195a4a6cbd5f4ff","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:niri-hwe","repository":"ghcr.io/tuna-os/skipjack","tag":"niri-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:4f0af45380363a2bc83e3d40a36f14721812f396879920337c82a98f864147b6","engineRevision":null,"indexDigest":"sha256:36f471d16627bc609c8f96a1ef9e3f31672e79323d9eb347063b989115a2c4be","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:2c9fce5f451c3cd90f10bf0eb3d07ba8c923bf84e36734e8d195a4a6cbd5f4ff"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"niri-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:niri-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1659181126,"desktop":"niri","digest":"sha256:fc3eecf280f2fa250698e18bd975b513f5441d46ebea729557ef351f1a28b63a","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:niri-hwe","repository":"ghcr.io/tuna-os/skipjack","tag":"niri-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:54122c88d8e215c6fbfe8553f67e5ce10969f6bae22e3459031df51c1cff7992","engineRevision":null,"indexDigest":"sha256:36f471d16627bc609c8f96a1ef9e3f31672e79323d9eb347063b989115a2c4be","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:fc3eecf280f2fa250698e18bd975b513f5441d46ebea729557ef351f1a28b63a"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"niri-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"skipjack"},"targetKey":"skipjack:niri-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2409863283,"desktop":"niri","digest":"sha256:65c934bf16bf3940af479698283b8057311ecd2baca40247601dd295878d4b34","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:niri-nvidia","repository":"ghcr.io/tuna-os/skipjack","tag":"niri-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:40516f89b73c226f4043d6572e26879ae233da6cc793d58ffe4568be946f6045","engineRevision":null,"indexDigest":"sha256:f96eeadb253bb2bc54f838b8f0493ff1ca5517dbc67cee01b76a3e100a951c11","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:65c934bf16bf3940af479698283b8057311ecd2baca40247601dd295878d4b34"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"niri-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:niri-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1773443610,"desktop":"niri","digest":"sha256:7e0dac1b07063cd1acd3d01ec31e92d4cb22f86014c09db28d2e675680a29c9a","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:niri","repository":"ghcr.io/tuna-os/skipjack","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:97f6ae4edfba0d7a6a6e6a2ab6c12df75042354c2f8dcd2db0f74e41f5a54f7e","engineRevision":null,"indexDigest":"sha256:199a426151c51ffbe729370f7362f6c473f454fa0f96363da07641f804714fac","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:7e0dac1b07063cd1acd3d01ec31e92d4cb22f86014c09db28d2e675680a29c9a"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"niri","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:niri:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1659242036,"desktop":"niri","digest":"sha256:04fd83ebb37058d39e4d99441ac65bd8cfb1cfecea671c86cd8ca755cd381af1","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:niri","repository":"ghcr.io/tuna-os/skipjack","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:e03d81a4128ad5cfc50694367e971e3c84fc4ba7ebcb6b6c6eff1daf8ea0a1b6","engineRevision":null,"indexDigest":"sha256:199a426151c51ffbe729370f7362f6c473f454fa0f96363da07641f804714fac","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:04fd83ebb37058d39e4d99441ac65bd8cfb1cfecea671c86cd8ca755cd381af1"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"niri","hardwareScope":"generic","platform":"linux/arm64","variant":"skipjack"},"targetKey":"skipjack:niri:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1706344987,"desktop":"tuna","digest":"sha256:b71d0682f4f9a7ae79f4660031df3f67bd30b0f5959c6c46077c0f8751ae4708","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:tuna","repository":"ghcr.io/tuna-os/skipjack","tag":"tuna"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:0033a941416fffca1b453023bc69ebf0fb63ba4df64b1238443b2e9ed1a769e2","engineRevision":null,"indexDigest":"sha256:81ac5170211e0dd2aaae01d2549b7aea0c18c23b5801fabdf1aef34a0317984b","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:b71d0682f4f9a7ae79f4660031df3f67bd30b0f5959c6c46077c0f8751ae4708"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"tuna","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:tuna:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1569816812,"desktop":"xfce","digest":"sha256:952adaca5ec7164247954db924d55aa0bc24be088bc329e925a18b47729983a1","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:xfce","repository":"ghcr.io/tuna-os/skipjack","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:f7d335510b135758c58a96419df0568c539a62b4fb97ffd470048dcbba8c7bdf","engineRevision":null,"indexDigest":"sha256:61fef8ca8d006aaa7145cdaeb7f8fded1e89f1e241b2b0e9a34aedacd998278f","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:952adaca5ec7164247954db924d55aa0bc24be088bc329e925a18b47729983a1"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:xfce:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1672457116,"desktop":"","digest":"sha256:a17071371a3d986708606d08a3d74e41d0573bcdf949c4429c7d083eab678cb2","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/wahoo:base","repository":"ghcr.io/tuna-os/wahoo","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:345eefbda94dfd6ae8ff4b497b767384e7d6bd9e95f3cc1b7850ca2f0f7238e5","engineRevision":null,"indexDigest":"sha256:0e7b2afd52f4cf85b2358b283c6ef28ca26994d4e9697d65b16c699e3b87a1b5","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:a17071371a3d986708606d08a3d74e41d0573bcdf949c4429c7d083eab678cb2"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"wahoo"},"targetKey":"wahoo:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1491655859,"desktop":"","digest":"sha256:6fdd66eda5069fce567208fb568ee55eb247851cf6c63e3d481cc123d27e0bc9","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/wahoo:base","repository":"ghcr.io/tuna-os/wahoo","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:1e584b74147e2ecb1427d7a9bafe1e4d0b6923ff3e9ee252484c4ea8e570a05d","engineRevision":null,"indexDigest":"sha256:0e7b2afd52f4cf85b2358b283c6ef28ca26994d4e9697d65b16c699e3b87a1b5","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:6fdd66eda5069fce567208fb568ee55eb247851cf6c63e3d481cc123d27e0bc9"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base","hardwareScope":"generic","platform":"linux/arm64","variant":"wahoo"},"targetKey":"wahoo:base:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2102155786,"desktop":"cosmic","digest":"sha256:819931bfff17db7e3d0c60c20706b98b8732c96f0f95d3fd26a19b9174a9ec47","hasSdBoot":false,"kernelVer":"7.3.0-0.rc0.260818g0f23d56f17fd.3.eln159.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/wahoo:cosmic","repository":"ghcr.io/tuna-os/wahoo","tag":"cosmic"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:ae9ff3049459d0ce95ad474933aa37c66e349764a63894d3cb216bf427d5585c","engineRevision":null,"indexDigest":"sha256:cc20ba1d9f00c5d35a1e2162badb3269efce45bc495a0e0b4fbb569ed354f1e0","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:819931bfff17db7e3d0c60c20706b98b8732c96f0f95d3fd26a19b9174a9ec47"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"cosmic","hardwareScope":"generic","platform":"linux/amd64","variant":"wahoo"},"targetKey":"wahoo:cosmic:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1906913472,"desktop":"cosmic","digest":"sha256:b21c469bdbff9e662b6e9ded92ba561f0322d629827af8cca4c4feb88fda0386","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/wahoo:cosmic","repository":"ghcr.io/tuna-os/wahoo","tag":"cosmic"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:a2fcf50a8de8fab01d4259cb3b198d4e9e03d06f72292ccbc5544dfc09cca998","engineRevision":null,"indexDigest":"sha256:cc20ba1d9f00c5d35a1e2162badb3269efce45bc495a0e0b4fbb569ed354f1e0","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:b21c469bdbff9e662b6e9ded92ba561f0322d629827af8cca4c4feb88fda0386"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"cosmic","hardwareScope":"generic","platform":"linux/arm64","variant":"wahoo"},"targetKey":"wahoo:cosmic:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2045915937,"desktop":"gnome","digest":"sha256:c3f999e5044ab4a9302435500b1d1dbe0c4e9911b7703ca320057a2e37dd6d7b","hasSdBoot":false,"kernelVer":"7.3.0-0.rc0.260818g0f23d56f17fd.3.eln159.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/wahoo:gnome","repository":"ghcr.io/tuna-os/wahoo","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:f6b08d05265889f933c5479cbebe915940150edd4caa8a613c549d68bf0f885d","engineRevision":null,"indexDigest":"sha256:e4d20fcba364559ad173368c7d6f40574ead0fbea740dd9c09bb1409efe86344","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:c3f999e5044ab4a9302435500b1d1dbe0c4e9911b7703ca320057a2e37dd6d7b"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"wahoo"},"targetKey":"wahoo:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1858709118,"desktop":"gnome","digest":"sha256:7c70f5d17221eec275fdc027704a056543cf6911f6b1c07383c4258f67172d1c","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/wahoo:gnome","repository":"ghcr.io/tuna-os/wahoo","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:f6a55ed21c69da66ab82cfb2642dedb6d1e80f85471e4fb21d64350604140cd1","engineRevision":null,"indexDigest":"sha256:e4d20fcba364559ad173368c7d6f40574ead0fbea740dd9c09bb1409efe86344","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:7c70f5d17221eec275fdc027704a056543cf6911f6b1c07383c4258f67172d1c"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome","hardwareScope":"generic","platform":"linux/arm64","variant":"wahoo"},"targetKey":"wahoo:gnome:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2994797655,"desktop":"kde","digest":"sha256:04cc186adb99a0a495045d0548e709ff2503a2168517988fc824d05a8f3831bc","hasSdBoot":false,"kernelVer":"7.3.0-0.rc0.260818g0f23d56f17fd.3.eln159.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/wahoo:kde","repository":"ghcr.io/tuna-os/wahoo","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:be72194956f90eba686272341daf4d77b65fee093d54ad0cfb79a7920a39ea61","engineRevision":null,"indexDigest":"sha256:565a6efef2b39c735b9eefdd7d06baab152e3b706ed09704473faf50ce48e801","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:04cc186adb99a0a495045d0548e709ff2503a2168517988fc824d05a8f3831bc"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"wahoo"},"targetKey":"wahoo:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2771868592,"desktop":"kde","digest":"sha256:a57c8c68d114e493d45ea776e261931f2089a7c7f2057f46b0a6948dce6a0ccd","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/wahoo:kde","repository":"ghcr.io/tuna-os/wahoo","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:f9e8e5c81391bc52f7c2f6e3dd76898ce1eb6dc17b0dff7667e3974c1b84e273","engineRevision":null,"indexDigest":"sha256:565a6efef2b39c735b9eefdd7d06baab152e3b706ed09704473faf50ce48e801","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:a57c8c68d114e493d45ea776e261931f2089a7c7f2057f46b0a6948dce6a0ccd"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"kde","hardwareScope":"generic","platform":"linux/arm64","variant":"wahoo"},"targetKey":"wahoo:kde:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1865745274,"desktop":"tuna","digest":"sha256:3d05e36068199cdf8f2e8bba00f79fc220b51aa2eec0ab448d036f026fa90ad8","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/wahoo:tuna","repository":"ghcr.io/tuna-os/wahoo","tag":"tuna"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:8155db6b63bdc7fc7be697c2ff8f158f6300eacf70001d361de6b12b00c73791","engineRevision":null,"indexDigest":"sha256:865ec5320f25ae368316f07b4d3b49b5e0600308e5bc50b973ace90a5b53a46d","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:3d05e36068199cdf8f2e8bba00f79fc220b51aa2eec0ab448d036f026fa90ad8"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"tuna","hardwareScope":"generic","platform":"linux/amd64","variant":"wahoo"},"targetKey":"wahoo:tuna:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1505924084,"desktop":"","digest":"sha256:22670aa505d110ce319442fc745b4150fd6da654ab0f66a5bdcdef5b5ca1b974","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:base-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"base-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:9132b4d6121e95c9a07e56dcc0149d195ef068ab295cbbcd39f1c3b1c5b6e74f","engineRevision":null,"indexDigest":"sha256:f280356c28bb8bd2db99f47396a2fce7b9133c49e3ab5e59778c0f8a0143bb53","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:22670aa505d110ce319442fc745b4150fd6da654ab0f66a5bdcdef5b5ca1b974"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:base-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1503709613,"desktop":"","digest":"sha256:456834d1b359bab14e20e0e221a103e51e2df032f8dc771b066901c1b4acd103","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:base-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"base-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:cd525310403037fdec90c881f1e661110aa44fd5b0751066c812efbc5d921688","engineRevision":null,"indexDigest":"sha256:f280356c28bb8bd2db99f47396a2fce7b9133c49e3ab5e59778c0f8a0143bb53","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:456834d1b359bab14e20e0e221a103e51e2df032f8dc771b066901c1b4acd103"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"base-hwe","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"yellowfin"},"targetKey":"yellowfin:base-hwe:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1411323532,"desktop":"","digest":"sha256:9a92b8b87195e46fb63b904de79205225c9fc4cc3ab5d2fe4149820e984da306","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:base-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"base-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:29c69f0562b8c46207728758d5f1db9f50024dab4aa2d10ec4a7b99baacf63ae","engineRevision":null,"indexDigest":"sha256:f280356c28bb8bd2db99f47396a2fce7b9133c49e3ab5e59778c0f8a0143bb53","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:9a92b8b87195e46fb63b904de79205225c9fc4cc3ab5d2fe4149820e984da306"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"yellowfin"},"targetKey":"yellowfin:base-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2140999964,"desktop":"","digest":"sha256:f43c57107bc097ffd1e7618573321d7a1b31ace4e649d36ba545ed9a81cf70c6","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:base-nvidia","repository":"ghcr.io/tuna-os/yellowfin","tag":"base-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:9c3a487cbd4b6f70ec6cd709d35977e3c59092f65bf743758528cfe41cf30c31","engineRevision":null,"indexDigest":"sha256:87346d06f3389baf88340eb07e3c2804394544b41f1bd36ebbd57d91d6cb0f27","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:f43c57107bc097ffd1e7618573321d7a1b31ace4e649d36ba545ed9a81cf70c6"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:base-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1472499284,"desktop":"","digest":"sha256:1ea45603500667641859e44ea813c58cb2ccfdcfcdd1915c32c6cc0d14844459","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:base","repository":"ghcr.io/tuna-os/yellowfin","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:0e87454c9be5de6deca7071d77b437cc59eb2437180d5792a183345a0911c53d","engineRevision":null,"indexDigest":"sha256:bbd292dd0d79257648c9e459c4ce6b38b6deed011830b5a7d1417f89017dfc48","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:1ea45603500667641859e44ea813c58cb2ccfdcfcdd1915c32c6cc0d14844459"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1471529965,"desktop":"","digest":"sha256:05a04872993c07040ca3138b85bc1ec99f8e4004b5f00f3c504beb4a88b6a346","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:base","repository":"ghcr.io/tuna-os/yellowfin","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:be7fcc963dec81bbc47a8debe9ba6c8deea1734067c62ed3c3ba4e12dc17ba91","engineRevision":null,"indexDigest":"sha256:bbd292dd0d79257648c9e459c4ce6b38b6deed011830b5a7d1417f89017dfc48","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:05a04872993c07040ca3138b85bc1ec99f8e4004b5f00f3c504beb4a88b6a346"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"base","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"yellowfin"},"targetKey":"yellowfin:base:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1373241274,"desktop":"","digest":"sha256:68be04c9464ca9908e4d8246fa434fbfb82b1d09f4876acaa69254ac13ae29c9","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:base","repository":"ghcr.io/tuna-os/yellowfin","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:a9753cd6acc146bc9a1cfd9ff4bf830193562bbb9eab4bc3ea62716ab1049c7b","engineRevision":null,"indexDigest":"sha256:bbd292dd0d79257648c9e459c4ce6b38b6deed011830b5a7d1417f89017dfc48","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:68be04c9464ca9908e4d8246fa434fbfb82b1d09f4876acaa69254ac13ae29c9"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base","hardwareScope":"generic","platform":"linux/arm64","variant":"yellowfin"},"targetKey":"yellowfin:base:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1882631278,"desktop":"cosmic","digest":"sha256:240f868d6770d48931fa57309f7e3091f52dfc84f90f6da97b3276d435894722","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:cosmic-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"cosmic-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:2986e808bcca268b79452752f6da1993b5a5318265696e287a3ac0bf3ebc2197","engineRevision":null,"indexDigest":"sha256:50cbc92f7dce8c47f3bcec22efca53d45131af59be054b21733c64767418a416","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:240f868d6770d48931fa57309f7e3091f52dfc84f90f6da97b3276d435894722"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:cosmic-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2518801205,"desktop":"cosmic","digest":"sha256:5c92afbe4cb1123e9149b0246ee1190993bfbb5d45d7c252956ae79052a191c3","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:cosmic-nvidia","repository":"ghcr.io/tuna-os/yellowfin","tag":"cosmic-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:b8c4a0d8dfebc950cd99e9cd18f63e94045baf39c3a8c0cb01396f1f02ec40f8","engineRevision":null,"indexDigest":"sha256:71b8412d8224edbddc0b3ea3263ceefcf69e2dcb64bbb2b70984e2ff8be2087e","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:5c92afbe4cb1123e9149b0246ee1190993bfbb5d45d7c252956ae79052a191c3"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:cosmic-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1882585499,"desktop":"cosmic","digest":"sha256:999b7c6bb22dc7b8898bae563dfc0a01d3b214a671049fa30b58f5271fc1f409","hasSdBoot":false,"kernelVer":"6.12.0-279.el10.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:cosmic","repository":"ghcr.io/tuna-os/yellowfin","tag":"cosmic"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:da5954ef084de477a67ef5cc66a87178646714988647c126a879e4a21711cc84","engineRevision":null,"indexDigest":"sha256:5327aa3d19c05cf0af17aae25206f928cead54214a958da00c68a6129108cb0f","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:999b7c6bb22dc7b8898bae563dfc0a01d3b214a671049fa30b58f5271fc1f409"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:cosmic:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1865597180,"desktop":"gnome","digest":"sha256:b2da94a53fc305815b729f6d29a540fbca03835ed19a45c37bb6b7e9561737df","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:gnome-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"gnome-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:21b99e707b31f2acec6ed056a4801a9e75512e663c03567b34f27953fac934fa","engineRevision":null,"indexDigest":"sha256:a13ad5ae2e795583aaf8662be377f3231dc302885eb50c7c585539a7669ba5d5","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:b2da94a53fc305815b729f6d29a540fbca03835ed19a45c37bb6b7e9561737df"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:gnome-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1862659382,"desktop":"gnome","digest":"sha256:040c5f0bba56cb5f6f62629d229aafa66f3691acdd643069a4fb7a0e6fe97a41","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:gnome-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"gnome-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:c108e6a4297aa7a86af1f8d6c89b67343d5881dd9f121025b5977384e09e6e36","engineRevision":null,"indexDigest":"sha256:a13ad5ae2e795583aaf8662be377f3231dc302885eb50c7c585539a7669ba5d5","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:040c5f0bba56cb5f6f62629d229aafa66f3691acdd643069a4fb7a0e6fe97a41"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"gnome-hwe","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"yellowfin"},"targetKey":"yellowfin:gnome-hwe:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2500768865,"desktop":"gnome","digest":"sha256:e9677c3a4d101cc600624871b26e9cec53cb3dcb914adacce7dc86e7e811e082","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:gnome-nvidia","repository":"ghcr.io/tuna-os/yellowfin","tag":"gnome-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:1391c56aef3bc092d2f2f90e84f7331f5bdc62b6c35da0dc4f572cd64f92392a","engineRevision":null,"indexDigest":"sha256:6ff0edc4ed40b3287a56b5b022fca41b0d8ffadff90e2306318e46b834c8ef0e","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:e9677c3a4d101cc600624871b26e9cec53cb3dcb914adacce7dc86e7e811e082"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:gnome-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1865574756,"desktop":"gnome","digest":"sha256:665a652644b822970d1104fbed9863170dac7112ab093057086d768218d90bc2","hasSdBoot":false,"kernelVer":"6.12.0-279.el10.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:gnome","repository":"ghcr.io/tuna-os/yellowfin","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:6d8b445ce6f7cd4e870f70ab92f547742a688f5e817b1797a696faa33bb4594b","engineRevision":null,"indexDigest":"sha256:bf56b457e689f56108694494cf21e1cb218daa1f8b66c081be8db609e7073bae","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:665a652644b822970d1104fbed9863170dac7112ab093057086d768218d90bc2"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1862677855,"desktop":"gnome","digest":"sha256:26abea624c3bf6ba66684944054e193b6ae71b5f1472b7568e829983faa0c7ae","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:gnome","repository":"ghcr.io/tuna-os/yellowfin","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:d7aa08ce3d97d1e3a0846a48e83181a79b63b28753021d2979c7a01b754dd0dc","engineRevision":null,"indexDigest":"sha256:bf56b457e689f56108694494cf21e1cb218daa1f8b66c081be8db609e7073bae","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:26abea624c3bf6ba66684944054e193b6ae71b5f1472b7568e829983faa0c7ae"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"yellowfin"},"targetKey":"yellowfin:gnome:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1959802216,"desktop":"kde","digest":"sha256:e6c7e2b4d5e3a65aa97010b6785dbf356ae3bdcd9b14c41938dc7d63c2ff64c3","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:kde-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"kde-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:dee348b4e75edc7bffb051c20dd1179c569fb19cb218a8e0d633512cfa4da1c6","engineRevision":null,"indexDigest":"sha256:11fd44e62bdd079a6deab955efbc7aa905ae06962843582ac9d55bfaf0086568","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:e6c7e2b4d5e3a65aa97010b6785dbf356ae3bdcd9b14c41938dc7d63c2ff64c3"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:kde-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1955456740,"desktop":"kde","digest":"sha256:8bee7ce0666ce178a47f72d2293d00c1690af7a32795b13b25f6c4f8caf0d189","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:kde-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"kde-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:c0a245e9c434202aa0119991bdef999ac1d13fd881a0950dfa6ec20efe7a527a","engineRevision":null,"indexDigest":"sha256:11fd44e62bdd079a6deab955efbc7aa905ae06962843582ac9d55bfaf0086568","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:8bee7ce0666ce178a47f72d2293d00c1690af7a32795b13b25f6c4f8caf0d189"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"kde-hwe","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"yellowfin"},"targetKey":"yellowfin:kde-hwe:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1857215906,"desktop":"kde","digest":"sha256:04788eca869fc2b6960142b1182da67fac64efb5ac7f2501b69a538cc125685b","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:kde-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"kde-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:68594d6485d71d7cf782cd4da22f723d1fb84aec28ecc75007fb3472fe482a7c","engineRevision":null,"indexDigest":"sha256:11fd44e62bdd079a6deab955efbc7aa905ae06962843582ac9d55bfaf0086568","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:04788eca869fc2b6960142b1182da67fac64efb5ac7f2501b69a538cc125685b"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"kde-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"yellowfin"},"targetKey":"yellowfin:kde-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2595220349,"desktop":"kde","digest":"sha256:ae01deeebeb5779462fd60a79662d5031fd790ed14d0ffc013e214483cd6bc5a","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:kde-nvidia","repository":"ghcr.io/tuna-os/yellowfin","tag":"kde-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:a81247c41eb19e9524971edfe2e238e0fbe1c6b125f57c7ccadb379e90f7affc","engineRevision":null,"indexDigest":"sha256:9f4dc99fe18c0801830d24b1a73ee6446bd56a2721da059c7f9c345b2d258477","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:ae01deeebeb5779462fd60a79662d5031fd790ed14d0ffc013e214483cd6bc5a"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:kde-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1959766579,"desktop":"kde","digest":"sha256:5d43e990e6f2df194afb791cd035a1615fa63ee9f10fee19ca768b1df492c288","hasSdBoot":false,"kernelVer":"6.12.0-279.el10.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:kde","repository":"ghcr.io/tuna-os/yellowfin","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:1be83adb9dd2957e2f64079373789b8701635142108cd5dbe21a1602023927db","engineRevision":null,"indexDigest":"sha256:54bc9d63699701b7f1ceb8b7aa34139e5257fc0f3c2ded98765264ce0673c583","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:5d43e990e6f2df194afb791cd035a1615fa63ee9f10fee19ca768b1df492c288"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1955455314,"desktop":"kde","digest":"sha256:0b04f5f474846d5a96a7c9839367d09812d52d6fdf5097b5609172535a30ee86","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:kde","repository":"ghcr.io/tuna-os/yellowfin","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:337aa169b63c0363bedff7cd81973e424767483521305cda78c410c4893bbb21","engineRevision":null,"indexDigest":"sha256:54bc9d63699701b7f1ceb8b7aa34139e5257fc0f3c2ded98765264ce0673c583","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:0b04f5f474846d5a96a7c9839367d09812d52d6fdf5097b5609172535a30ee86"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"yellowfin"},"targetKey":"yellowfin:kde:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1857164649,"desktop":"kde","digest":"sha256:96ed4e553a05e1f1fe283c60396a213a4fc774b9d419bd84ff1b1ec4433fc444","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:kde","repository":"ghcr.io/tuna-os/yellowfin","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:2cf1d3faefefd7c0e45061686af343c5bdba6b89e2a6e3d3c66e7b46fa2c2deb","engineRevision":null,"indexDigest":"sha256:54bc9d63699701b7f1ceb8b7aa34139e5257fc0f3c2ded98765264ce0673c583","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:96ed4e553a05e1f1fe283c60396a213a4fc774b9d419bd84ff1b1ec4433fc444"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"kde","hardwareScope":"generic","platform":"linux/arm64","variant":"yellowfin"},"targetKey":"yellowfin:kde:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1748744462,"desktop":"niri","digest":"sha256:59a7319b744fbcff5ad19f0cda7c5935d25e00f6bcf435f6450e25d760ec0de8","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:niri-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"niri-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:e2dc27e1c2052b8037af282933d2be27ec627d3c30fa2553bf802e51580eb532","engineRevision":null,"indexDigest":"sha256:16ad49ba08f4cb3d849d5f4fc9539113cc78026f8493b595e2ea4f8b063e019c","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:59a7319b744fbcff5ad19f0cda7c5935d25e00f6bcf435f6450e25d760ec0de8"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:niri-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1757702133,"desktop":"niri","digest":"sha256:ef40a66d1a54a97bc2e696ff1375e8c3e7799d992e44490dfc7493ad1825f36b","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:niri-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"niri-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:7a9a4a0e062e8efc056842b455e8692e64ac88de9b82843a168d14e4d871e77c","engineRevision":null,"indexDigest":"sha256:16ad49ba08f4cb3d849d5f4fc9539113cc78026f8493b595e2ea4f8b063e019c","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:ef40a66d1a54a97bc2e696ff1375e8c3e7799d992e44490dfc7493ad1825f36b"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"niri-hwe","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"yellowfin"},"targetKey":"yellowfin:niri-hwe:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1640103885,"desktop":"niri","digest":"sha256:39052e837def3914419c405f92c596efe9eae2b9ef1add60d58db73d1ea39158","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:niri-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"niri-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:3ae88a1b12877855fad23b02bbf5d8cc83afe5506093fe6411b3375cf40e83ba","engineRevision":null,"indexDigest":"sha256:16ad49ba08f4cb3d849d5f4fc9539113cc78026f8493b595e2ea4f8b063e019c","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:39052e837def3914419c405f92c596efe9eae2b9ef1add60d58db73d1ea39158"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"niri-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"yellowfin"},"targetKey":"yellowfin:niri-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2383485178,"desktop":"niri","digest":"sha256:b7a819bb09bb72046b286a03a1de8a6a761349a2d92d15061cccc50482c6b645","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:niri-nvidia","repository":"ghcr.io/tuna-os/yellowfin","tag":"niri-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:d52e8992fb355206b678487f6d484b522ebadf66fab11bb7ab4cace8129b051d","engineRevision":null,"indexDigest":"sha256:b3ef6085ffd88556817c2e66b801d490550c65d57674e5c42515d66fa6a9df3c","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:b7a819bb09bb72046b286a03a1de8a6a761349a2d92d15061cccc50482c6b645"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:niri-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1748640996,"desktop":"niri","digest":"sha256:5e70549bba2c5166a444355e6ef260fa87f4524b1d1c66c95c0583773dafeb7d","hasSdBoot":false,"kernelVer":"6.12.0-279.el10.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:niri","repository":"ghcr.io/tuna-os/yellowfin","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:d4ab01f9c384cdb664974af34a8cdefcf7dea9e7d1f9d676b3d50a807ef37a7b","engineRevision":null,"indexDigest":"sha256:5b10c458b54adde9092cdc801fa66e2a10cfaa22ff7111ac65d3f95ba978c2df","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:5e70549bba2c5166a444355e6ef260fa87f4524b1d1c66c95c0583773dafeb7d"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:niri:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1757607839,"desktop":"niri","digest":"sha256:04230c17099568eb2e7d70df5df15ed0d2ae43a833cb079733df0e1c6dec1b90","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:niri","repository":"ghcr.io/tuna-os/yellowfin","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:7b96750317360aebdeb1af901aca8f34b3f5eaf3ff9243db2678efa755229a3f","engineRevision":null,"indexDigest":"sha256:5b10c458b54adde9092cdc801fa66e2a10cfaa22ff7111ac65d3f95ba978c2df","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:04230c17099568eb2e7d70df5df15ed0d2ae43a833cb079733df0e1c6dec1b90"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"niri","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"yellowfin"},"targetKey":"yellowfin:niri:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1639954437,"desktop":"niri","digest":"sha256:35ce94287870d48a21c2c34f2348a95698bea44049ae46fe39214c67113069cc","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:niri","repository":"ghcr.io/tuna-os/yellowfin","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:32e9eb610c681a809d2b6dd516112b059433cda115b63cef665aca69eafb0013","engineRevision":null,"indexDigest":"sha256:5b10c458b54adde9092cdc801fa66e2a10cfaa22ff7111ac65d3f95ba978c2df","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:35ce94287870d48a21c2c34f2348a95698bea44049ae46fe39214c67113069cc"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"niri","hardwareScope":"generic","platform":"linux/arm64","variant":"yellowfin"},"targetKey":"yellowfin:niri:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1682008074,"desktop":"tuna","digest":"sha256:e67ebc3a889487ea8acba0f15230c4113335c4c04a985bc88779ecb33005452e","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:tuna","repository":"ghcr.io/tuna-os/yellowfin","tag":"tuna"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:1e96571dd08a61559783ec36c27651388bf6679020dcfa66ee90f2d6204d0176","engineRevision":null,"indexDigest":"sha256:13c1efca77353bac4245aa86eaab13f1485dbe2da4a2ce08129251e3525d1b05","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:e67ebc3a889487ea8acba0f15230c4113335c4c04a985bc88779ecb33005452e"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"tuna","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:tuna:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1545778228,"desktop":"xfce","digest":"sha256:c86c046c0e8424c4394203aeb7c82379de764b7af167be7cfac5a7fab59532e0","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:xfce-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"xfce-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:f0f9e3c97182bdf581c97ca44f23915b1cf179cb299bb611f19cc1f56b371670","engineRevision":null,"indexDigest":"sha256:7746e5f18ffb34ffa412f83ce732385ce89fbcb7a09f8065fe5523d7ea73f141","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:c86c046c0e8424c4394203aeb7c82379de764b7af167be7cfac5a7fab59532e0"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:xfce-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1546765169,"desktop":"xfce","digest":"sha256:aa2a371b4021ce3ee14b3c7f21485455fd6007db40f82ec3f243524cebf7ec10","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:xfce-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"xfce-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:60b72c60a418d1d14345ff10facd172eef8a405b21f51b306c1ed127564f40d8","engineRevision":null,"indexDigest":"sha256:7746e5f18ffb34ffa412f83ce732385ce89fbcb7a09f8065fe5523d7ea73f141","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:aa2a371b4021ce3ee14b3c7f21485455fd6007db40f82ec3f243524cebf7ec10"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"xfce-hwe","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"yellowfin"},"targetKey":"yellowfin:xfce-hwe:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2180549006,"desktop":"xfce","digest":"sha256:88d1b40c38c13dfc6058f4c03015180dda6eba90b65f1d95e17c4a9c08eb48d2","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:xfce-nvidia","repository":"ghcr.io/tuna-os/yellowfin","tag":"xfce-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:a84f24d144fd68816b4da206c5d2c2bb01517dac26de03f717bfd79ee4d5b085","engineRevision":null,"indexDigest":"sha256:323af663ef800072511c740fc282866249c4677d5338e81401e67a93d4b8a728","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:88d1b40c38c13dfc6058f4c03015180dda6eba90b65f1d95e17c4a9c08eb48d2"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:xfce-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1545747015,"desktop":"xfce","digest":"sha256:d176fe891943f2dc2134946f3233fad1f068551d65e50c436f0b306706a99b7c","hasSdBoot":false,"kernelVer":"6.12.0-279.el10.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:xfce","repository":"ghcr.io/tuna-os/yellowfin","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:f60c0cccea88880ccf484b65a0506d7818c793d624df970dd690345ccb720cc4","engineRevision":null,"indexDigest":"sha256:6b101a7a8db2e85ac4678ac747912a90c0ba2c1ca5c09d7859b2531ec5b93f94","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:d176fe891943f2dc2134946f3233fad1f068551d65e50c436f0b306706a99b7c"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:xfce:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1546712150,"desktop":"xfce","digest":"sha256:810a327f00829a4d841b877009ce0abe6473ca6b2f39b47e7119657a5192149e","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:xfce","repository":"ghcr.io/tuna-os/yellowfin","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:ce783ba51e7de4a5d5c9e814178eaf9de778a84e821ba1efd4ee67526c9ad1f2","engineRevision":null,"indexDigest":"sha256:6b101a7a8db2e85ac4678ac747912a90c0ba2c1ca5c09d7859b2531ec5b93f94","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:810a327f00829a4d841b877009ce0abe6473ca6b2f39b47e7119657a5192149e"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"yellowfin"},"targetKey":"yellowfin:xfce:linux/amd64/v2"}]};

let catalogSnapshot = DEFAULT_CATALOG_SNAPSHOT;
let catalogSnapshotPromise = null;

// A catalog status is not sufficient evidence. This is a consumer-side minimum
// provenance gate; the producer must still validate the underlying strict receipt.
// Two shapes pass: a browser-profile claim, or a projection of a committed
// BrowserIsoQualificationReceipt/v1 (tunaOS generate-catalog-snapshot.py). The
// receipt has no browser profile; its producer run binds it to the browser
// route. A linux/arm64 entry may cite the linux/amd64 receipt of its flavor.
function catalogQualification(entry) {
  const q = entry?.qualification || { status: "unqualified", reason: "untested-snapshot" };
  if (q.status !== "qualified") return q;
  const ri = entry?.resolvedInputs || {};
  const digest = (v) => typeof v === "string" && /^sha256:[0-9a-f]{64}$/.test(v);
  const browser = q.browser || {};
  const positive = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;
  const common = entry?.availability?.available === true &&
    [ri.platformManifestDigest, q.receiptDigest, q.isoDigest].every(digest) && q.buildOrigin === "browser" &&
    typeof q.qualifiedAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(q.qualifiedAt) &&
    Number.isFinite(Date.parse(q.qualifiedAt)) && new Date(q.qualifiedAt).toISOString() === q.qualifiedAt.replace("Z", ".000Z");
  const pinned = [ri.liveOverlayDigest, ri.liveOverlayBaseDigest, ri.installerRevision, ri.engineRevision].every(digest) &&
    ri.liveOverlayBaseDigest === ri.platformManifestDigest;
  let complete;
  if (q.receiptSchema === "BrowserIsoQualificationReceipt/v1") {
    const p = q.producer || {};
    const run = (v) => Number.isSafeInteger(v) && v > 0;
    const platform = entry?.target?.platform;
    complete = common && digest(q.receiptImageDigest) && q.receiptPlatform === "linux/amd64" &&
      p.repository === "tuna-os/iso-builder" && p.workflow === ".github/workflows/ci.yml" &&
      p.ref === "refs/heads/main" && typeof p.sha === "string" && /^[0-9a-f]{40}$/.test(p.sha) &&
      run(p.runId) && run(p.runAttempt) &&
      (platform === "linux/amd64" ? pinned && q.receiptImageDigest === ri.platformManifestDigest
        : platform === "linux/arm64");
  } else {
    complete = common && pinned && digest(q.browserBuildReceiptDigest) &&
      typeof browser.name === "string" && browser.name.trim() !== "" &&
      !browser.name.trim().toLowerCase().startsWith("native") &&
      !["unknown", "none", "null", "n/a", "placeholder", "unspecified"].includes(browser.name.trim().toLowerCase()) &&
      typeof browser.version === "string" && /^[1-9][0-9]*(?:\.[0-9]+)*$/.test(browser.version.trim()) &&
      positive(browser.memory_gib) && positive(browser.free_disk_gib);
  }
  return complete ? q : { ...q, status: "unqualified", reason: "incomplete-qualification-provenance" };
}

// TEST-ONLY seam for the @full CI spec. A target the catalog marks unqualified
// may be built for diagnostics when the page was loaded with a grant installed
// by Playwright `addInitScript` (a JS global; no URL parameter, storage key or
// UI control can set it). The grant must name the exact image and, when given,
// platform of the operation. The build is labelled "diagnostic-unqualified",
// never becomes "qualified", and never receives a qualificationId.
function diagnosticUnqualifiedGrant(op) {
  if (globalThis.__TBOX_STRICT_OBSERVED__) return null;
  const g = globalThis.__TBOX_DIAGNOSTIC_UNQUALIFIED__;
  if (!g || g.kind !== "diagnostic-unqualified" || typeof g.image !== "string" || g.image === "") return null;
  if (!sameImageRef(op?.request?.image, g.image)) return null;
  if (g.platform !== undefined && op.request.target?.platform !== g.platform) return null;
  if (op.catalogEntry?.availability?.available !== true) return null;
  return g;
}

// The retained plain observation stays bounded to Skipjack GNOME. A both-mode
// run (plain then LUKS on the same retained ISO, the qualification-receipt
// route) may name one TunaOS linux/amd64 target. Either way the page labels
// the build not-assessed and sends no qualificationId.
const STRICT_OBSERVED_BOTH_IMAGE = /^tuna-os\/[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

function strictObservedGrant(op) {
  const g = globalThis.__TBOX_STRICT_OBSERVED__;
  if (globalThis.__TBOX_DIAGNOSTIC_UNQUALIFIED__ || !g || g.kind !== "strict-observed" ||
      g.route !== "retained-iso-roundtrip" || typeof g.image !== "string" ||
      !(g.installMode === "plain" ? g.image === "tuna-os/skipjack:gnome"
        : g.installMode === "both" && STRICT_OBSERVED_BOTH_IMAGE.test(g.image)) ||
      g.platform !== "linux/amd64" ||
      !sameImageRef(op?.request?.image, g.image) || op.request.target?.platform !== g.platform ||
      op.catalogEntry?.availability?.available !== true) return null;
  return g;
}

function loadCatalogSnapshot() {
  if (catalogSnapshotPromise) return catalogSnapshotPromise;
  catalogSnapshotPromise = fetch("catalog-snapshot.json", { tboxMetadataOnly: true })
    .then((r) => (r.ok ? r.json() : DEFAULT_CATALOG_SNAPSHOT))
    .then((doc) => {
      if (doc && doc.schemaVersion === 1 && doc.kind === "catalog-snapshot" && Array.isArray(doc.targets)) {
        catalogSnapshot = doc;
        refreshConfiguredChoices();
        renderEditions();
      }
      return catalogSnapshot;
    })
    .catch(() => catalogSnapshot);
  return catalogSnapshotPromise;
}

globalThis.tboxGetCatalogSnapshot = () => catalogSnapshot;
globalThis.tboxSetCatalogSnapshot = (doc) => {
  if (doc && doc.schemaVersion === 1 && doc.kind === "catalog-snapshot" && Array.isArray(doc.targets)) {
    catalogSnapshot = doc;
    catalogSnapshotPromise = Promise.resolve(doc);
    refreshConfiguredChoices();
    renderEditions();
    invalidateOperation("catalog-updated");
  }
  return catalogSnapshot;
};

// Configuration defaults are declarations, not installed app inventory.
const FLATPAK_DEFAULTS = Object.fromEntries(BUILDER_CONFIG.desktops.map(d => [d.id, d.default_flatpaks]));
const CURATED_SETS = BUILDER_CONFIG.curated_app_sets;

function parseCuratedSet(text) {
  const ids = [...text.matchAll(/^flatpak "([^"]+)"/gm)].map((m) => m[1]);
  for (const m of text.matchAll(/^\[Flatpak Preinstall ([^\]\s]+)\]([^[]*)/gm)) {
    if (!/^IsRuntime\s*=\s*true/im.test(m[2])) ids.push(m[1]);
  }
  return ids.filter((id) => validFlatpakId(id));
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
  const first = matched[0] || other[0];
  sel.value = first?.id || "";
  if ($("curated")) $("curated").disabled = !first;
}

async function loadCuratedSet() {
  const set = CURATED_SETS.find((s) => s.id === $("curatedset").value) || CURATED_SETS[0];
  if (!set) return;
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
  try { new Notification(title, { body, icon: "mark-192.png" }); } catch {}
}

// ── Flatpak checklist + Flathub search ──────────────────────────────────
const fpDefaults = globalThis.TboxFlatpakDefaults.create();
const fpItems = new Map(); // appId -> { checked, name, summary, icon, arches }
let fpSearchVersion = 0;
let fpSearchController = null;
let fpHits = [];

function fpMetadata(hit = {}) {
  let icon = "";
  try {
    const url = new URL(hit.icon);
    if (url.protocol === "https:" && ["dl.flathub.org", "flathub.org"].includes(url.hostname)
        && !url.username && !url.password) icon = url.href;
  } catch {}
  return {
    name: typeof hit.name === "string" ? hit.name : "",
    summary: typeof hit.summary === "string" ? hit.summary : "",
    icon,
    arches: Array.isArray(hit.arches) ? hit.arches.filter(a => typeof a === "string") : null,
  };
}

function fpAdd(id, name = "", checked = true, metadata = {}) {
  if (!fpItems.has(id)) fpItems.set(id, { checked, ...fpMetadata({ ...metadata, name }) });
  else {
    const item = fpItems.get(id);
    item.checked = checked;
    if (name) Object.assign(item, fpMetadata({ ...metadata, name }));
  }
  fpDefaults.edit(fpCollect());
  fpRender();
}

function fpCollect() {
  return [...fpItems.entries()].filter(([, v]) => v.checked).map(([k]) => k);
}

function fpCardContent(parent, id, item, selected) {
  const fallback = document.createElement("span");
  fallback.className = "app-icon app-icon-fallback";
  fallback.textContent = "▦";
  fallback.setAttribute("aria-hidden", "true");
  if (item.icon) {
    const img = document.createElement("img");
    img.className = "app-icon";
    img.alt = "";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.src = item.icon;
    img.onerror = () => img.replaceWith(fallback);
    parent.appendChild(img);
  } else parent.appendChild(fallback);
  const copy = document.createElement("span");
  copy.className = "app-copy";
  for (const [tag, className, text] of [
    ["strong", "", item.name || id],
    ["span", "app-summary", item.summary || "App details have not been loaded."],
    ["small", "", `Flathub · ${id}`],
    ["span", "app-state", selected ? "Selected" : "Add app"],
  ]) {
    const el = document.createElement(tag);
    el.className = className;
    el.textContent = text;
    copy.appendChild(el);
  }
  const arch = currentPlatform() === "linux/arm64" ? "aarch64" : "x86_64";
  const availability = document.createElement("small");
  availability.textContent = item.arches
    ? (item.arches.includes(arch) ? `Listed for ${arch}` : `Not listed for ${arch}`)
    : "Computer compatibility not checked";
  copy.appendChild(availability);
  parent.appendChild(copy);
}

function fpRender() {
  const box = $("fplist");
  if (!box) return;
  box.innerHTML = "";
  for (const [id, v] of fpItems) {
    const label = document.createElement("label");
    label.className = "app-card";
    label.dataset.appId = id;
    const cb = Object.assign(document.createElement("input"), { type: "checkbox", checked: v.checked });
    cb.setAttribute("aria-label", `Include ${v.name || id}`);
    cb.onchange = () => {
      v.checked = cb.checked;
      fpDefaults.edit(fpCollect());
      label.querySelector(".app-state").textContent = v.checked ? "Selected" : "Not selected";
      fpUpdateCount(); fpRenderResults(); syncOperationOptions(); updateShare();
    };
    label.appendChild(cb);
    fpCardContent(label, id, v, v.checked);
    if (!v.checked) label.querySelector(".app-state").textContent = "Not selected";
    box.appendChild(label);
  }
  fpUpdateCount();
  fpRenderResults();
  syncOperationOptions();
  updateShare();
  if ($("apps-options")?.open) fpHydrateSelected();
}
const fpMetadataAttempted = new Set();
let fpHydrating = false;
async function fpHydrateSelected() {
  if (fpHydrating) return;
  fpHydrating = true;
  updateShim();
  const relay = SHIM;
  const worker = async () => {
    while ($("apps-options")?.open) {
      const id = [...fpItems.keys()].find(id => !fpItems.get(id).name && !fpMetadataAttempted.has(id));
      if (!id) break;
      fpMetadataAttempted.add(id);
      try {
        const r = await fetch(relay + "/flathub/search", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: id, filters: [] }),
        });
        if (!r.ok) continue;
        const data = await r.json();
        const hit = Array.isArray(data.hits) && data.hits.find(hit => hit && hit.app_id === id);
        if (!hit || !fpItems.has(id)) continue;
        Object.assign(fpItems.get(id), fpMetadata(hit));
        // Preserve focused checkbox nodes when metadata arrives.
        const label = [...$("fplist").children].find(el => el.dataset.appId === id);
        if (label) {
          for (const el of [...label.children].slice(1)) el.remove();
          const item = fpItems.get(id);
          label.querySelector("input").setAttribute("aria-label", `Include ${item.name || id}`);
          fpCardContent(label, id, item, item.checked);
          if (!item.checked) label.querySelector(".app-state").textContent = "Not selected";
        }
      } catch { /* Keep the ID and explicit unknown metadata state. */ }
    }
  };
  try { await Promise.all([worker(), worker(), worker()]); }
  finally { fpHydrating = false; }
}
function fpUpdateCount() {
  const count = fpCollect().length;
  if ($("fpcount")) $("fpcount").textContent = `${count} selected`;
  if ($("fpempty")) $("fpempty").hidden = fpItems.size > 0;
}
function fpRenderResults() {
  const box = $("fpresults");
  box.innerHTML = "";
  for (const hit of fpHits) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "app-card";
    const selected = Boolean(fpItems.get(hit.app_id)?.checked);
    b.setAttribute("aria-pressed", String(selected));
    b.setAttribute("aria-label", `${selected ? "Remove" : "Add"} ${hit.name || hit.app_id}`);
    fpCardContent(b, hit.app_id, fpMetadata(hit), selected);
    b.onclick = () => {
      fpAdd(hit.app_id, hit.name, !selected, hit);
      // Keep the search and keyboard position so several apps can be chosen.
      [...box.children].find(el => el.dataset.appId === hit.app_id)?.focus();
    };
    b.dataset.appId = hit.app_id;
    box.appendChild(b);
  }
}

let fpTimer = null;
async function fpSearch(q) {
  const version = ++fpSearchVersion;
  fpSearchController?.abort();
  fpSearchController = new AbortController();
  updateShim();
  fpHits = [];
  fpRenderResults();
  if (!q || q.length < 3) {
    $("fpstatus").textContent = "Type at least 3 characters to search.";
    return;
  }
  $("fpstatus").textContent = "Searching Flathub…";
  try {
    const r = await fetch(SHIM + "/flathub/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: q, filters: [] }),
      signal: fpSearchController.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    if (version !== fpSearchVersion || $("fpsearch").value.trim() !== q) return;
    fpHits = (Array.isArray(d.hits) ? d.hits : []).filter(hit =>
      hit && typeof hit.app_id === "string" && validFlatpakId(hit.app_id)).slice(0, 8);
    fpRenderResults();
    $("fpstatus").textContent = fpHits.length ? `${fpHits.length} app${fpHits.length === 1 ? "" : "s"} found. Choose apps to include.` : "No apps found. Try another name.";
  } catch (e) {
    if (version !== fpSearchVersion || e.name === "AbortError") return;
    $("fpstatus").textContent = "Flathub search is unavailable. Your selections are safe; try searching again later.";
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
    rm.setAttribute("aria-label", `Remove setup command ${i + 1}`);
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
  const error = $("repo-error");
  if (!$("repo-trust").checked) {
    error.textContent = "Confirm you trust this source and have reviewed the command before adding it.";
    $("repo-trust").focus(); return;
  }
  try { globalThis.TboxSetupSafety.assertPortable(ref); }
  catch (e) { error.textContent=e.message; $("reporef").focus(); return; }
  if (kind !== "raw" && !/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(ref)) {
    error.textContent="Use a repository identifier without spaces or shell syntax.";
    $("reporef").focus(); return;
  }
  error.textContent="";
  let cmd;
  switch (kind) {
    case "copr": cmd = `dnf -y copr enable ${ref}`; break;
    case "ppa": cmd = `add-apt-repository -y ppa:${ref}`; break;
    case "obs": cmd = `zypper -n ar -f obs://${ref} ${ref.replace(/[:/]/g, "_")}`; break;
    default: cmd = ref;
  }
  repoCmds.push(cmd);
  $("repo-trust").checked=false;
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

// sha256 over the exact tbox.wasm bytes instantiated (a tee of the same
// response body). The engine cannot hash its own code, so this host
// measurement is what it records as engine_digest in live-source.json.
let wasmEngineDigest = null;

async function sha256Response(response) {
  const digest = await crypto.subtle.digest("SHA-256", await response.arrayBuffer());
  return "sha256:" + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function defaultLoadWasm() {
  if (wasmReady) return wasmReady;
  const go = new Go();
  wasmReady = fetch("tbox.wasm")
    .then((response) => {
      if (!response.ok) throw new Error(`tbox.wasm: HTTP ${response.status}`);
      const measured = sha256Response(response.clone());
      return Promise.all([WebAssembly.instantiateStreaming(response, go.importObject), measured]);
    })
    .then(([r, digest]) => {
      wasmEngineDigest = digest;
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
  if (Number.isFinite(n) && n > 0 && Number.isFinite(i) && i >= 0) {
    $("bar").max = n; $("bar").value = i;
  } else $("bar").removeAttribute("value");
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

// The default relay fronts ghcr.io and nothing else (worker/cors-shim.js
// UPSTREAM, matching the SHIM initializer above). A user-overridden relay
// fronts an unknown registry, so refs fetched through it stay hostless:
// the request must never assert a host it cannot prove. The engine accepts
// both forms for fetch/compare (tacklebox NormalizeImageRef) but ships
// request.image verbatim into media-input.json/recipe.json, from which the
// installer derives the bootc origin — a hostless request produced a
// hostless origin that failed the strict FQ comparison (tuna-os/tunaOS#3797).
const DEFAULT_RELAY = "https://relay.tunaos.org";
function canonicalInstallRef(rawInput, registry, image) {
  const raw = String(rawInput || "").trim();
  const firstSeg = raw.split("/")[0] || "";
  if (raw.includes("/") && (firstSeg.includes(".") || firstSeg.includes(":"))) return raw;
  if (registry === DEFAULT_RELAY) return "ghcr.io/" + image;
  return image;
}

// Engine contract: "ghcr.io/tuna-os/x:y" and "tuna-os/x:y" are the same
// image (tacklebox NormalizeImageRef). Request/grant comparisons use this
// so the canonical request form still matches short grant pins.
function sameImageRef(a, b) {
  const strip = (s) => String(s || "").trim().replace(/^ghcr\.io\//, "");
  return strip(a) === strip(b);
}

// ── Image picker & unified BuildRequest v1 operation state ───────────────
const GUIDED = BUILDER_CONFIG.schema_version === 2;
let guidedPicker = null, guidedModel = null, guidedError = null, manualImageMode = false, guidedSelectionIdentity = null;
const DESKTOPS = Object.fromEntries(BUILDER_CONFIG.desktops.map(d => {
  const presentation=BUILDER_CONFIG.selection?.facets.find(f=>f.id==="desktop")?.values.find(v=>v.id===d.id);
  return [d.id,{...d,name:presentation?.label || d.name || d.id,description:presentation?.description || d.description}];
}));
const DDI_CHANNELS = BUILDER_CONFIG.ddi_channels || [];
let selectedDdi = null;
let selectionWasExplicit = false;
let VARIANTS = globalThis.TboxBuilderConfig.variants(BUILDER_CONFIG, catalogSnapshot);

const ALMA_VARIANTS = new Set(["yellowfin", "albacore"]);
const NATIVE_V3_VARIANTS = new Set(["skipjack", "wahoo"]);
const VALID_PLATFORMS = new Set(["linux/amd64", "linux/amd64/v2", "linux/amd64/v3", "linux/arm64"]);

function defaultPlatformForVariant(variantId) {
  return ALMA_VARIANTS.has(variantId) ? "linux/amd64/v2" : "linux/amd64";
}

// A platform the catalog publishes for the variant is kept as chosen. Otherwise
// an x86-64-v2 choice falls back to the plain amd64 build, which runs there too.
function normalizePlatformForVariant(variantId, platform) {
  const p = VALID_PLATFORMS.has(platform) ? platform : defaultPlatformForVariant(variantId);
  if (!variantId) return p;
  const published = Array.isArray(catalogSnapshot?.targets) &&
    catalogSnapshot.targets.some((e) => e?.target?.variant === variantId && e.target.platform === p);
  if (!published && p === "linux/amd64/v2") return "linux/amd64";
  return p;
}

function cpuBaselineForTarget(variantId, platform) {
  if (platform === "linux/arm64") return "armv8-a";
  if (platform === "linux/amd64/v2") return "x86-64-v2";
  if (platform === "linux/amd64/v3") return "x86-64-v3";
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
  const vid = $("variant")?.value || "";
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

function syncInspectAction() {
  $("introspect").disabled = BUILDER_CONFIG.preview_only || isOperationBusy() || (!$("image").value.trim() && !selectedDdi);
}
function setOperationBusy(busy, phase = null) {
  activeBusyPhase = busy ? (phase || "busy") : null;
  guidedPicker?.setBusy(busy);
  for (const id of ["variant", "platform", "image", "introspect", "clearcache", "experience"]) {
    const el = $(id);
    if (el) el.disabled = Boolean(busy) || (id === "introspect" && BUILDER_CONFIG.preview_only);
  }
  syncInspectAction();
  if ($("fpnone")) $("fpnone").disabled = Boolean(busy);
  if ($("fpdefaults-restore")) $("fpdefaults-restore").disabled = !fpCanRestore();
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
  const vSel = ($("variant")?.value || "").replace(/^ddi:/, "");
  const defaultRef = rawInput;
  const { registry, image } = parseImage(defaultRef);
  const installImage = canonicalInstallRef(defaultRef, registry, image);
  const label = (($("label")?.value || BUILDER_CONFIG.output.volume_label).toUpperCase().replace(/[^A-Z0-9_]/g, "_")) || BUILDER_CONFIG.output.volume_label;
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
  let outputFilename = `${BUILDER_CONFIG.output.filename_prefix}-${(defaultRef.split("/").pop() || "image").replace(/[:/]/g, "-")}.iso`;

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
    if (qualification.status === "qualified" && qualification.receiptDigest &&
        !strictObservedGrant({ request: { image, target }, catalogEntry })) {
      qualificationId = qualification.receiptDigest;
    }
    outputFilename = `${BUILDER_CONFIG.output.filename_prefix}-${target.variant}-${target.flavor}-${platformSlug(target.platform)}.iso`;
  } else if (existingOp?.resolvedDigest) {
    resolvedInputs = {
      platformManifestDigest: existingOp.resolvedDigest,
    };
  }

  const request = {
    schemaVersion: 1,
    kind: "build-request",
    customImage,
    image: installImage,
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
  if (!sameImageRef(op.request.image, image) || op.request.registry !== registry) return false;
  const parsedTuna = parseCuratedTunaRef(rawInput);
  const wantPlat = parsedTuna
    ? normalizePlatformForVariant(parsedTuna.variant, currentPlatform())
    : currentPlatform();
  if (op.request.target?.platform && op.request.target.platform !== wantPlat) return false;
  if (op.platform && op.platform !== wantPlat) return false;
  return true;
}

function invalidateOperation(reason = "selection-changed") {
  if ($("fpdefaults-restore")) $("fpdefaults-restore").disabled = true;
  if ($("fpdefaults-status")) $("fpdefaults-status").textContent = "Your app choices were kept. Check this image before accepting its defaults.";
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

globalThis.tboxExportBuildRequestJSON = () => {
  const request=globalThis.tboxGetBuildRequest();
  globalThis.TboxSetupSafety.assertPortable(request);
  return JSON.stringify(request, null, 2);
};

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

function fpCanRestore() {
  return !isOperationBusy() && Boolean(currentOp?.appsDefaultsChecked) && operationMatchesForm(currentOp)
    && fpDefaults.snapshot().target === `${$("image").value.trim()}|${currentPlatform()}`;
}

function fpApplyDefaultState(state) {
  if (!state.defaults) return;
  if (!state.pending) {
    fpItems.clear();
    for (const id of state.selected) fpItems.set(id, { checked: true, ...fpMetadata() });
    fpRender();
  }
  const status = $("fpdefaults-status");
  if (status) status.textContent = `Defaults from ${state.defaults.source}. ` +
    (state.pending ? "Your app choices were kept. Use the button to replace them with these defaults." : "You can customize this request list below.") +
    ` Suggested IDs: ${state.defaults.ids.join(", ") || "none"}.` +
    " Suggestions do not prove that apps are installed or resolve their remote and branch.";
  if ($("fpdefaults-restore")) {
    $("fpdefaults-restore").disabled = !fpCanRestore();
    $("fpdefaults-restore").textContent = state.defaults.source === "image inspection" ? "Use inspected suggestions" : "Use deployment suggestions";
  }
}

function applyDetectedDesktopAndPackaging(fObj) {
  const key = `${$("image").value.trim()}|${currentPlatform()}`;
  const defaults = globalThis.TboxFlatpakDefaults.suggestions(fObj, FLATPAK_DEFAULTS[fObj.desktop] || []);
  currentOp.appsDefaultsChecked = true;
  fpApplyDefaultState(fpDefaults.inspect(key, defaults));
  renderCuratedSets(fObj.desktop);
  if (fObj.pkgManager) {
    $("pkgsearch").placeholder = `Search packages (${fObj.pkgManager} · ${fObj.repoFamily})…`;
    const kinds = { fedora: "copr", debian: "ppa", opensuse: "obs" };
    if (kinds[fObj.repoFamily]) $("repokind").value = kinds[fObj.repoFamily];
  }
}

function inspectionStillCurrent(op) {
  if (currentOp !== op) return false;
  if (!operationMatchesForm(op)) {
    log("The selected image is no longer available or has changed. Choose an image again.");
    return false;
  }
  return true;
}

async function inspect() {
  if (BUILDER_CONFIG.preview_only) return;
  if (isOperationBusy()) return;
  if (GUIDED && !manualImageMode && !validGuidedSelection()) { log("Choose an available image from the catalog before checking it."); return; }
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
    if (!inspectionStillCurrent(op)) return;

    const hasTestStub =
      (typeof window.tboxIntrospect === "function" && window.tboxIntrospect !== wasmNativeIntrospect) ||
      (typeof window.loadWasm === "function" && window.loadWasm !== loadWasm);

    if (!hasTestStub) {
      await loadCatalogSnapshot();
      if ((GUIDED && !manualImageMode && !validGuidedSelection()) || $("image").value.trim() !== raw) throw new Error("The selected image is no longer available in this catalog. Choose an image again.");
      if (!inspectionStillCurrent(op)) return;
      const refreshed = buildRequestFromForm(op);
      Object.assign(op, refreshed);
    }

    if (!hasTestStub && op.catalogEntry) {
      globalThis.tboxLayerCache?.setPrefetchEnabled?.(false);
      const entry = op.catalogEntry;
      let qual = op.qualification || { status: "unqualified", reason: "untested-snapshot" };
      if (qual.status !== "qualified" && diagnosticUnqualifiedGrant(op)) {
        qual = { status: "diagnostic-unqualified", reason: qual.reason || qual.status, gate: qual.status };
        op.qualification = qual;
        log(`DIAGNOSTIC, UNQUALIFIED BUILD for ${op.request.image} (${op.request.target.platform}): catalog gate said ${qual.gate} (${qual.reason}); this result is not a qualification`);
      }
      if (strictObservedGrant(op)) {
        qual = { status: "not-assessed", reason: qual.reason || qual.status, gate: qual.status };
        op.qualification = qual;
        delete op.request.qualificationId;
        log(`STRICT OBSERVED BUILD for ${op.request.image} (${op.request.target.platform}): catalog gate said ${qual.gate} (${qual.reason}); qualification is not assessed`);
      }
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

      if ((qual.status === "qualified" || qual.status === "diagnostic-unqualified" || strictObservedGrant(op)) && !quotaStatus.blocked) {
        op.state = "ready";
        op.ready = true;
        op.inspectedVia = "catalog";
        $("stage").textContent = qual.status === "qualified"
          ? "Image inspected — ready to build."
          : qual.status === "not-assessed"
            ? "Image inspected — ready to build (observed, not assessed)."
            : "Image inspected — ready to build (diagnostic, unqualified build).";
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
    const inspectedFacts = JSON.parse(await window.tboxIntrospect(image, registry, op.platform, op.request));
    if (!inspectionStillCurrent(op)) return;
    facts = inspectedFacts;
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
    if (!inspectionStillCurrent(op)) return;
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
    $("build").disabled = currentOp !== op || !operationMatchesForm(op) || !op.ready;
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
  if (!navigator.storage?.estimate) return { freeGB: null, blocked: false };
  try {
    const { quota, usage } = await navigator.storage.estimate();
    if (!Number.isFinite(quota) || !Number.isFinite(usage)) return { freeGB: null, blocked: false };
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
    return { freeGB: null, blocked: false };
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

function showDeliveryStatus(delivery, bytes, seconds) {
  const saved = delivery.kind === "picker" && delivery.status === "stream-closed";
  const title = saved ? "ISO saved" : "ISO created — download started";
  const detail = saved
    ? "The file writer closed successfully."
    : "Check your browser downloads and wait for the file to finish saving. This page cannot confirm that it was saved.";
  $("stage").textContent = `${title} — ${(bytes / 1e9).toFixed(2)} GB created in ${seconds}s. ${detail}`;
  $("delivery-status").textContent = detail;
  notify(title, detail);
}

function prepareDdi(ch) {
  if (BUILDER_CONFIG.preview_only) return;
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
  if (BUILDER_CONFIG.preview_only) return;
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
    const outputDelivery = await finishIsoSink(s, name);
    updatePostcardFilename(name);
    const dt = ((performance.now() - t0) / 1000).toFixed(1);
    showDeliveryStatus(outputDelivery, bytes, dt);
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
    } else if (e.name === "AbortError") {
      $("stage").textContent = "Save cancelled — no completed save confirmed. Your setup is preserved; retry when ready.";
    } else if (/download stalled/i.test(String(e))) {
      $("stage").textContent = "Build failed — layer download stalled (try again; the browser may recover on a fresh page load).";
    } else {
      $("stage").textContent = "Build failed.";
    }
    notify(e.name === "AbortError" ? "Save cancelled" : "ISO build failed", String(e).slice(0, 120));
  } finally {
    stopWatch();
    releaseLease();
    setOperationBusy(false, "build");
    $("build").disabled = false;
  }
}

async function build() {
  if (BUILDER_CONFIG.preview_only) return;
  if (GUIDED && !manualImageMode && !validGuidedSelection()) { log("Choose and check an available catalog image before building."); return; }
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
    const name = req.options.outputFilename || `${BUILDER_CONFIG.output.filename_prefix}-${($("image").value.split("/").pop() || "image").replace(/[:]/g, "-")}.iso`;
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
      // engineDigest only ever names the module this page instantiated; a
      // replaced build function is not that module.
      { label, initrd, flatpaks, packages, extraRun, request: req,
        ...(wasmEngineDigest && (buildIso === wasmNativeBuildIso || buildIso === wasmNativeBuildIsoWithResult)
          ? { engineDigest: wasmEngineDigest } : {}) },
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
    showDeliveryStatus(outputDelivery, bytes, dt);
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
    } else if (e.name === "AbortError") {
      $("stage").textContent = "Save cancelled — no completed save confirmed. Your setup is preserved; retry when ready.";
    } else if (/download stalled/i.test(String(e))) {
      $("stage").textContent = "Build failed — layer download stalled (try again; the browser may recover on a fresh page load).";
    } else if (/sink write/i.test(String(e))) {
      $("stage").textContent = "Build failed — sink write error.";
    } else {
      $("stage").textContent = "Build failed.";
    }
    renderFallbackCard(op, `Browser build failed (${String(e)}). Build this exact target locally with tacklebox purebuild:`);
    notify(e.name === "AbortError" ? "Save cancelled" : "ISO build failed", String(e).slice(0, 120));
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
  if(globalThis.TboxExperiences && globalThis.TboxExperiences.id!==globalThis.TboxExperiences.defaultId) p.set("experience",globalThis.TboxExperiences.id);
  if ($("image").value) p.set("image", $("image").value);
  const vid = ($("variant")?.value || "").replace(/^ddi:/, "");
  const plat = currentPlatform();
  if ($("image").value && plat !== defaultPlatformForVariant(vid)) {
    p.set("platform", plat);
  }
  const fl = fpCollect();
  if (fl.length || fpDefaults.snapshot().edited) p.set("flatpaks", fl.join(","));
  const pk = pkgCollect();
  if (pk.length) p.set("packages", pk.join(","));
  if ($("label").value && $("label").value !== BUILDER_CONFIG.output.volume_label) p.set("label", $("label").value);
  // Trust-sensitive overrides are intentionally not portable URL inputs.
  const qs = "?" + p.toString();
  $("share").textContent = qs;
  try {
    globalThis.TboxSetupSafety.assertPortable(Object.fromEntries(p));
    $("sharelink").href = location.origin + location.pathname + qs;
    $("copyshare").disabled=false;
  } catch (error) {
    $("share").textContent=error.message;
    $("sharelink").removeAttribute("href");
    $("copyshare").disabled=true;
  }
}

$("introspect").onclick = async () => {
  if (isOperationBusy()) return;
  const ddi = DDI_CHANNELS.find(c => `ddi:${c.id}` === $("variant").value);
  if (ddi && selectedDdi) prepareDdi(ddi);
  else await inspect();
  if (!$("buildcard").classList.contains("hidden")) {
    $("stage").focus();
  }
};
$("apps-options")?.addEventListener("toggle", () => {
  if ($("apps-options").open) {
    // A new visit to Apps is a bounded retry for metadata that was unavailable.
    for (const [id, item] of fpItems) if (!item.name) fpMetadataAttempted.delete(id);
    fpHydrateSelected();
  }
});
$("build").onclick = () => {
  const review = $("build-review");
  $("review-target").textContent = `${$("image").value || selectedDdi?.name || "Selected image"} · ${currentPlatform()}`;
  $("review-apps").textContent = `${fpCollect().length} app requests. These are not applied to the ISO or installed system.`;
  review.showModal();
  $("review-back").focus();
};
$("review-back").onclick = () => $("build-review").close();
$("review-create").onclick = () => { $("build-review").close(); build(); };
$("curated").onclick = loadCuratedSet;
renderCuratedSets(null);
$("addrepo").onclick = addRepo;
for (const id of ["reporef", "repokind"]) $(id).addEventListener("input", () => {
  $("repo-trust").checked=false; $("repo-error").textContent="";
});
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
    let json;
    try { json=globalThis.tboxExportBuildRequestJSON(); }
    catch(error) { $("export-error").textContent=error.message; return; }
    $("export-error").textContent="";
    const blob = new Blob([json + "\n"], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href: url, download: "build-request.json" });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };
}
if ($("copyfallback")) {
  $("copyfallback").onclick = async () => {
    try { globalThis.tboxExportBuildRequestJSON(); }
    catch(error) { $("export-error").textContent=error.message; return; }
    $("export-error").textContent="";
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
$("fpdefaults-restore")?.addEventListener("click", () => {
  if (!fpCanRestore()) return;
  fpApplyDefaultState(fpDefaults.restore());
});
$("fpnone")?.addEventListener("click", () => {
  if (isOperationBusy()) return;
  for (const item of fpItems.values()) item.checked = false;
  fpDefaults.edit([]);
  fpRender();
});
$("fpsearch").addEventListener("input", (e) => {
  clearTimeout(fpTimer);
  // Invalidate an in-flight response immediately, including the debounce interval.
  ++fpSearchVersion;
  fpSearchController?.abort();
  fpHits = [];
  fpRenderResults();
  fpTimer = setTimeout(() => fpSearch(e.target.value.trim()), 300);
});

function currentVariant() {
  return VARIANTS.find((v) => v.id === $("variant").value) || { id: "", name: "Custom image", des: [] };
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
    el.setAttribute("aria-pressed", String(matches));
  }
  if ($("selection-summary")) $("selection-summary").textContent = val
    ? `${currentVariant().name} · ${$("platform").selectedOptions?.[0]?.textContent || currentPlatform()}`
    : "No image is selected. Choose a desktop or enter a custom image to continue.";
  syncInspectAction();
}
function validGuidedSelection() {
  if (guidedError || !guidedModel || !guidedPicker) return false;
  const leaf=guidedPicker.getSelection();
  return Boolean(leaf?.source.kind === "target" && leaf.selectable && leaf.entry?.publication.ref === $("image").value.trim() && leaf.entry.target.platform === currentPlatform());
}
function refreshGuidedPicker() {
  const container=$("guided-picker");
  if (!container || !document.querySelector) return;
  container.hidden=false;
  for(const id of ["editions","selection-summary","desktop-help"]) $(id).hidden=true;
  const custom=$("custom-image-options"),advanced=$("advanced-options");
  if(custom.parentElement!==advanced) advanced.appendChild(custom);
  if($("base-options").parentElement!==advanced) advanced.appendChild($("base-options"));
  $("choose-heading").textContent="Choose your image";
  try {
    const model=globalThis.TboxGuidedCatalog.createModel(globalThis.TBOX_GUIDED_CATALOG,catalogSnapshot,BUILDER_CONFIG,{
      flavorMetadata:globalThis.TBOX_FLAVOR_METADATA,
      isOffered:entry=>Boolean(entry.scheduled||entry.availability?.available),
    });
    guidedError=null; guidedModel=model;
    if(guidedPicker) guidedPicker.refresh(model);
    else guidedPicker=globalThis.TboxGuidedPicker.mount(container,{model,projectName:BUILDER_CONFIG.brand.name,simpleStart:!new URLSearchParams(location.search).has("image") && !new URLSearchParams(location.search).has("variant"),onSelection:(leaf,state)=>{
      if(isOperationBusy()) return;
      selectedDdi=null; manualImageMode=false; selectionWasExplicit=state.origin==="explicit";
      const previous=$("image").value;
      const identity=leaf?`${leaf.id}\n${leaf.evidenceKey}`:null;
      const changed=guidedSelectionIdentity!==identity;guidedSelectionIdentity=identity;
      if(leaf?.source.kind==="target" && leaf.selectable) {
        $("variant").value=leaf.entry.target.variant;
        $("platform").value=leaf.entry.target.platform;
        $("image").value=leaf.entry.publication.ref;
      } else $("image").value="";
      if(changed || previous!==$("image").value) invalidateOperation("guided-selection-changed");
      syncInspectAction(); updateShare();
    },qualification:entry=>({text:catalogQualification(entry).status==="qualified"?"Browser build verified":"Browser build not yet verified"})});
  } catch(error) {
    guidedError=error; guidedModel=null; guidedSelectionIdentity=null; $("image").value="";
    invalidateOperation("guided-catalog-unavailable");
    container.textContent="The image catalog is unavailable or does not match this deployment. Contact its maintainer.";
    container.setAttribute("role","alert"); syncInspectAction();
  }
}
function renderEditions() {
  if (GUIDED && manualImageMode) { $("editions").hidden=false; $("advanced-options").appendChild($("editions")); }
  if (GUIDED && !manualImageMode) { refreshGuidedPicker(); return; }
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
    b.textContent = meta.name;
    const caption = document.createElement("small"); caption.textContent = `${ddi.id} · DDI`; b.appendChild(caption);
    b.onclick = () => {
      if (isOperationBusy()) return;
      selectedDdi = ddi;
      $("image").value = "";
      invalidateOperation("ddi-selected");
      b.classList.add("selected");
      b.setAttribute("aria-pressed", "true");
      syncInspectAction();
      updateShare();
    };
    b.classList.toggle("selected", selectedDdi?.id === ddi.id);
    b.setAttribute("aria-pressed", String(selectedDdi?.id === ddi.id));
    if ($("selection-summary")) $("selection-summary").textContent = ddi.name;
    box.appendChild(b);
    syncInspectAction();
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
    const subLabel = qualStatus === "qualified" ? "Browser build verified" :
      qualStatus === "unsupported" ? "Browser build not supported" : "Browser build not yet verified";
    b.textContent = meta.name;
    const description=document.createElement("span"); description.className="desktop-description"; description.textContent=meta.description || "";
    const caption=document.createElement("small"); caption.textContent=subLabel;
    b.appendChild(description); b.appendChild(caption);
    b.onclick = () => {
      if (isOperationBusy()) return;
      selectedDdi = null;
      selectionWasExplicit = true;
      $("image").value = `${v.id}:${de}`;
      syncEditionSelection();
      invalidateOperation("edition-selected");
      updateShare();
    };
    box.appendChild(b);
  }
  syncEditionSelection();
}

function refreshConfiguredChoices() {
  const picker = $("variant");
  const previous = picker.value;
  VARIANTS = globalThis.TboxBuilderConfig.variants(BUILDER_CONFIG, catalogSnapshot);
  picker.innerHTML = "";
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
  if (previous && (VARIANTS.some(v => v.id === previous) || DDI_CHANNELS.some(c => `ddi:${c.id}` === previous))) picker.value = previous;
  else if (previous) { picker.value = ""; }
  const parsed = parseCuratedTunaRef($("image").value);
  if (GUIDED) return;
  if (parsed && previous) {
    const entry = findCatalogEntry(parsed.variant, parsed.flavor, currentPlatform());
    // Explicit platform choices may be unqualified/unscheduled but still have a
    // catalog record and exact local fallback. Automatic defaults still need admission.
    if (!entry || (!selectionWasExplicit && !(entry.scheduled || entry.availability?.available)) || !VARIANTS.some(v => v.id === parsed.variant && v.des.includes(parsed.flavor))) {
      $("image").value = "";
    }
  }
}
refreshConfiguredChoices();
if ($("platform")) {
  $("platform").value = defaultPlatformForVariant($("variant").value);
  $("platform").addEventListener("change", () => {
    if (isOperationBusy()) return;
    selectionWasExplicit = true;
    if(GUIDED) { manualImageMode=true; guidedPicker?.suspend(); }
    renderEditions();
    invalidateOperation("platform-changed");
    fpRender();
    updateShare();
  });
}
$("variant").addEventListener("change", () => {
  if (isOperationBusy()) return;
  selectionWasExplicit = true;
  if(GUIDED) { manualImageMode=true; guidedPicker?.suspend(); }
  const vId = $("variant").value.replace(/^ddi:/, "");
  if ($("platform") && $("platform").value !== "linux/arm64") {
    $("platform").value = defaultPlatformForVariant(vId);
  }
  const previous = parseCuratedTunaRef($("image").value);
  if (!$("variant").value.startsWith("ddi:")) {
    selectedDdi = null;
    const variant = currentVariant();
    const flavor = variant.des.includes(previous?.flavor) ? previous.flavor : variant.des[0];
    $("image").value = `${variant.id}:${flavor}`;
  } else {
    selectedDdi = DDI_CHANNELS.find(c => `ddi:${c.id}` === $("variant").value);
    $("image").value = "";
  }
  renderEditions();
  fpRender();
  invalidateOperation("variant-changed");
  updateShare();
});
renderEditions();
$("image").addEventListener("input", () => {
  if (isOperationBusy()) return;
  selectionWasExplicit = true;
  if (GUIDED) { manualImageMode=true; guidedPicker?.suspend(); }
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
const URL_PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

// Apply URL params.
{
  const q = new URLSearchParams(location.search);
  const configured = BUILDER_CONFIG.default_selection;
  if (GUIDED) {
    // The validated guided default was already resolved; URL intent below is explicit.
  } else if (configured.kind === "image") {
    $("image").value=configured.image;
    $("platform").value=configured.platform;
    const custom=document.querySelector?.("#custom-image-options"); if(custom) custom.open=true;
  } else {
    const entry=findCatalogEntry(configured.variant,configured.flavor,configured.platform);
    const admitted=entry && (entry.scheduled || entry.availability?.available) && VARIANTS.find(v=>v.id===configured.variant && v.des.includes(configured.flavor));
    if(admitted) { $("variant").value=admitted.id; $("image").value=`${admitted.id}:${configured.flavor}`; $("platform").value=configured.platform; }
    else if($("selection-summary")) $("selection-summary").textContent="The configured default is not available in this catalog. Choose an image to continue.";
  }
  let imageRejected = false;
  const urlVariant = q.get("variant");
  const urlFlavor = q.get("flavor") || q.get("de");
  const urlPlatform = q.get("platform");

  if (urlVariant && VARIANTS.some((v) => v.id === urlVariant)) {
    selectionWasExplicit = true;
    $("variant").value = urlVariant;
    if ($("platform")) {
      $("platform").value = defaultPlatformForVariant(urlVariant);
    }
  }
  if (urlPlatform && VALID_PLATFORMS.has(urlPlatform) && $("platform")) {
    selectionWasExplicit = true;
    $("platform").value = urlPlatform;
  }
  if (q.get("image")) {
    if (urlImageUsesDefaultRegistry(q.get("image"))) {
      selectionWasExplicit = true;
      $("image").value = q.get("image");
    } else {
      imageRejected = true;
      $("image").value = "";
      log("Ignored ?image= from this link — it names a non-default registry, and supply-chain params are not applied from URLs (iso-builder#114, #167). Type it into the image field if that is intended.");
    }
  } else if (urlFlavor && /^[a-z0-9-]+$/.test(urlFlavor)) {
    selectionWasExplicit = true;
    const vId = $("variant").value.replace(/^ddi:/, "");
    $("image").value = `${vId}:${urlFlavor}`;
  }
  if (q.has("flatpaks")) fpDefaults.edit([]);
  if (q.get("flatpaks")) for (const id of q.get("flatpaks").split(",").filter(Boolean)) {
    if (validFlatpakId(id)) fpAdd(id);
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
  if(GUIDED && selectionWasExplicit) {
    manualImageMode=true; guidedPicker?.suspend();
    const advanced=document.querySelector?.("#advanced-options");if(advanced)advanced.open=true;
    const custom=document.querySelector?.("#custom-image-options");if(custom&&q.get("image"))custom.open=true;
  }
  const parsedImg = parseCuratedTunaRef($("image").value);
  if (parsedImg && VARIANTS.some((v) => v.id === parsedImg.variant)) {
    $("variant").value = parsedImg.variant;
    // A link that names no platform gets the variant's default, not whatever
    // the configured default selection left in the control.
    if ($("platform") && !urlPlatform) {
      $("platform").value = defaultPlatformForVariant(parsedImg.variant);
    }
  }
  renderEditions();
  syncEditionSelection();
  rebuildCurrentOperation("idle");
  updateShim();
  updateShare();

  const autorunAllowed =
    !BUILDER_CONFIG.preview_only && q.get("autorun") === "1" && !SUPPLY_CHAIN_PARAMS.some((k) => q.get(k)) && !imageRejected;
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

// Deliberate, tab-local recovery; never save arbitrary form values on change.
if (document.querySelector) {
  const planKey = `tbox-planning-v1:${globalThis.TboxExperiences.id}`;
  const planContext = () => {
    if (!guidedModel || !guidedPicker) throw new Error("Planning recovery needs the current guided catalog. Your setup has not changed.");
    return {model:guidedModel,experience:globalThis.TboxExperiences.id,catalog:globalThis.TboxGuidedCatalog,validFlatpakId};
  };
  const noOverrides = () => {
    if (manualImageMode || selectedDdi || repoCmds.length || $("initrdurl").value.trim() || ($("shimurl").value.trim() && $("shimurl").value.trim() !== "https://relay.tunaos.org")) {
      throw new Error("This setup has advanced values that cannot be saved or replaced by a planning draft. Keep your original configuration; clear those overrides explicitly before using recovery.");
    }
  };
  const planningAction = action => {
    if (isOperationBusy()) { $("plan-status").textContent="Finish the current operation before changing saved plans."; return; }
    try { action(); } catch(error) { $("plan-status").textContent=error.message; }
  };
  $("save-plan").onclick=()=>planningAction(()=>{
    noOverrides();const context=planContext();const state=guidedPicker.getState();
    const value={version:1,experience:context.experience,catalogId:guidedModel.catalogId,snapshotDigest:guidedModel.snapshotDigest,pathId:state.pathId,filters:state.filters,leafId:state.selectedLeafId,flatpaks:fpCollect(),packages:pkgCollect(),label:$("label").value};
    globalThis.TboxSetupDraft.validate(value,context);globalThis.TboxSetupSafety.assertPortable(value);
    sessionStorage.setItem(planKey,JSON.stringify(value));
    $("plan-status").textContent="Planning choices saved in this tab. Restore them after a refresh; no build or save result is stored.";
  });
  $("restore-plan").onclick=()=>planningAction(()=>{
    noOverrides();const text=sessionStorage.getItem(planKey);if(text===null)throw new Error("No saved plan in this tab.");
    const {value,state}=globalThis.TboxSetupDraft.parse(text,planContext());
    globalThis.TboxSetupSafety.assertPortable(value);
    guidedPicker.restoreValidatedState(state);
    fpItems.clear();for(const id of value.flatpaks)fpItems.set(id,{checked:true,...fpMetadata()});fpDefaults.edit(value.flatpaks);fpRender();
    pkgItems.clear();for(const id of value.packages)pkgItems.set(id,{checked:true,summary:""});pkgRender();
    $("label").value=value.label;
    invalidateOperation("planning-draft-restored");updateShare();
    $("plan-status").textContent="Planning choices restored. Review your target and any notices, then check the image again. Nothing has been built.";
  });
  $("forget-plan").onclick=()=>planningAction(()=>{
    sessionStorage.removeItem(planKey);$("plan-status").textContent="Saved plan forgotten. Your current form is unchanged.";
  });
  try {
    if(sessionStorage.getItem(planKey)!==null){$("planning-recovery").open=true;$("plan-status").textContent="A saved plan is available in this tab. Restore it explicitly or forget it; the current setup is unchanged.";}
  } catch { $("plan-status").textContent="Session storage is unavailable. Use the setup link for supported choices instead."; }
  $("choose-architecture").onclick=()=>{
    if(isOperationBusy())return;
    if(!guidedPicker||!guidedModel?.facetPresentation.platform){$("hardware-help-status").textContent="This experience does not offer an architecture question. Check its installation documentation before selecting an image.";return;}
    guidedPicker.openQuestion("platform");$("guided-picker").scrollIntoView({block:"start"});
  };
}
