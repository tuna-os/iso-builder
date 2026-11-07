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

const DEFAULT_CATALOG_SNAPSHOT = {"coverageDigest":"sha256:0c08dc7b87b5cf36c5daa370b21bfa0a8db206321a4f6426b3b0248b86412cc1","generatedAt":"2026-11-07T02:41:16Z","kind":"catalog-snapshot","producerRevision":"tunaos.toml@74e33103cf9838eeb077aca46d6d5ed30d5472e7","schemaVersion":1,"snapshotDigest":"sha256:d7a64aa187e8d2745c40d15608287a290845000543d4cb1062cf509b8ed4a523","targets":[{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1625549436,"desktop":"","digest":"sha256:6c2767ca122bc5452471c4d05db2463d0a6384352ea20729d0b77ccf6189c051","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:base-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"base-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:2c271eefd8d353c7d7c2db8b45ad018ec36a53f9677f6287710faa54b6f934da","engineRevision":null,"indexDigest":"sha256:0c90bf360dbbb570af72b83592b8455a2f8ccec4e971ebac10bd98501fce9804","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:6c2767ca122bc5452471c4d05db2463d0a6384352ea20729d0b77ccf6189c051"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:base-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1694927422,"desktop":"","digest":"sha256:81b703368d9d07b76c216c3dcd437c0905664618aa6839d9f986578ef9a5e0b9","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:base-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"base-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:6395609558b2535bdedbcf1ce077bf8b372e94f08e09fbba26c87147e4863594","engineRevision":null,"indexDigest":"sha256:0c90bf360dbbb570af72b83592b8455a2f8ccec4e971ebac10bd98501fce9804","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:81b703368d9d07b76c216c3dcd437c0905664618aa6839d9f986578ef9a5e0b9"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"base-hwe","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"albacore"},"targetKey":"albacore:base-hwe:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1606739412,"desktop":"","digest":"sha256:bef8c0cf61e74c1852eb11d9b332832a6bf94b77dddd6a0d80e563a0cb5dfd1d","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:base-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"base-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:72a8ce1ec993545fac65cdd61f884d2f5bb277c5e12842ae9070cf762947053f","engineRevision":null,"indexDigest":"sha256:0c90bf360dbbb570af72b83592b8455a2f8ccec4e971ebac10bd98501fce9804","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:bef8c0cf61e74c1852eb11d9b332832a6bf94b77dddd6a0d80e563a0cb5dfd1d"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"albacore"},"targetKey":"albacore:base-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2301957390,"desktop":"","digest":"sha256:6d8114f8cad3d5050cbb63457fae3314ffbc65f08784962ced10b55845729cef","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:base-nvidia","repository":"ghcr.io/tuna-os/albacore","tag":"base-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:1247316b1c6bf8a17aad1d337cbdfb6801940b8f9588c9f7f71d4476a8d2a367","engineRevision":null,"indexDigest":"sha256:5f339e7ee0aaa8472b115ace2277da2da12bb63c65f4cd21bacc08f4e688d06e","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:6d8114f8cad3d5050cbb63457fae3314ffbc65f08784962ced10b55845729cef"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:base-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1625444597,"desktop":"","digest":"sha256:226d55f2434f1935ba393c12e22827209ca8f09d6f6d8c8da15d9a434a1aec7f","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:base","repository":"ghcr.io/tuna-os/albacore","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:2aa89d0b7bc6d82f3ef8ee4267118fc76f20413a68b007118163314aeed0a687","engineRevision":null,"indexDigest":"sha256:721fecf7e7a1dcc86a3ff23350c6553dfc459e03f086eae6dc40e16cb06c108d","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:226d55f2434f1935ba393c12e22827209ca8f09d6f6d8c8da15d9a434a1aec7f"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1624319578,"desktop":"","digest":"sha256:3edb0acb137183d871d44f796b4814f87c21b77e02446951beb5d7b131c72d97","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:base","repository":"ghcr.io/tuna-os/albacore","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:0986825cb2528a055cd1707e469535174add90f68c534ec19faabbfa295ec722","engineRevision":null,"indexDigest":"sha256:721fecf7e7a1dcc86a3ff23350c6553dfc459e03f086eae6dc40e16cb06c108d","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:3edb0acb137183d871d44f796b4814f87c21b77e02446951beb5d7b131c72d97"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"base","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"albacore"},"targetKey":"albacore:base:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1513148042,"desktop":"","digest":"sha256:49cb2df472561bcfb19dee4c592e44be7ae17c58f05b004362d0be87e65e4c16","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:base","repository":"ghcr.io/tuna-os/albacore","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:bc4adb8ec5c7ba728eddca13e177ecbc92eeb26326f71febe1162edcf695feb9","engineRevision":null,"indexDigest":"sha256:721fecf7e7a1dcc86a3ff23350c6553dfc459e03f086eae6dc40e16cb06c108d","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:49cb2df472561bcfb19dee4c592e44be7ae17c58f05b004362d0be87e65e4c16"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base","hardwareScope":"generic","platform":"linux/arm64","variant":"albacore"},"targetKey":"albacore:base:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2073540906,"desktop":"cosmic","digest":"sha256:f58a87756faaf712646425d2a11a6e62ffb554836823a5b9db6a214894062443","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:cosmic-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"cosmic-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:3f841a604294b16485d59fd9c711cf39440777e429995871fe87a31ac2437350","engineRevision":null,"indexDigest":"sha256:98bc2c8ed42441bca197b7bed77fc8271b6828b189d9d8c7ceb06dd118242abb","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:f58a87756faaf712646425d2a11a6e62ffb554836823a5b9db6a214894062443"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:cosmic-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2678894815,"desktop":"cosmic","digest":"sha256:bd00d1debbeb256af73879faf0b4c8e1af2c4a8167ff770fc6a88409e44f3097","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:cosmic-nvidia","repository":"ghcr.io/tuna-os/albacore","tag":"cosmic-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:e8ab9392409a390f7200e1dbd3e4fd4e98e0c33b322b901f5a7bad8b99ba0a50","engineRevision":null,"indexDigest":"sha256:3210cd6d0b15ac5f4b5cd698f3f0fb30579c9a20f195cc2fe70b4d46eac654fb","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:bd00d1debbeb256af73879faf0b4c8e1af2c4a8167ff770fc6a88409e44f3097"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:cosmic-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2073614940,"desktop":"cosmic","digest":"sha256:1c02b449ee04f0a73d6af4c1b0d62ac26969677e9399ec69d851bfda9ebd9f0c","hasSdBoot":false,"kernelVer":"6.12.0-211.74.1.el10_2.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:cosmic","repository":"ghcr.io/tuna-os/albacore","tag":"cosmic"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:f33c0e93ca33e29f6e2dd51c614a7b5e3ee961689c139120c31001ff4e7f3ce4","engineRevision":null,"indexDigest":"sha256:79a978857503ef196564813deb61ea49182b3b62cc731bfd211ab38e9e1797da","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:1c02b449ee04f0a73d6af4c1b0d62ac26969677e9399ec69d851bfda9ebd9f0c"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:cosmic:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2057271635,"desktop":"gnome","digest":"sha256:f7218c31469ea53f3590746db0c46a7fda9ba968206487e555ccb4b84fff3642","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:gnome-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"gnome-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:6ebacec8f0b4c1968787e5907c45971a540b7adea50e4065f65b4b56ddaf409d","engineRevision":null,"indexDigest":"sha256:d4b68014278031ce392a38d0e9956262c3b51bff5c2da7be891787d2fe107534","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:f7218c31469ea53f3590746db0c46a7fda9ba968206487e555ccb4b84fff3642"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:gnome-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":2054375333,"desktop":"gnome","digest":"sha256:af3e043a46c26c16b456e989883b7744a36f42a05ca5bdf12e184650ef49fc3b","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:gnome-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"gnome-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:95f9ce8f5da79c39709f604734704ab0528f773a56691bbbeb6a9b3e24df5f2f","engineRevision":null,"indexDigest":"sha256:d4b68014278031ce392a38d0e9956262c3b51bff5c2da7be891787d2fe107534","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:af3e043a46c26c16b456e989883b7744a36f42a05ca5bdf12e184650ef49fc3b"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"gnome-hwe","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"albacore"},"targetKey":"albacore:gnome-hwe:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2662189636,"desktop":"gnome","digest":"sha256:f66abdcac8e608035de2b5f9c4c8f73554d4f67c216f56e6e510958ef17bc405","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:gnome-nvidia","repository":"ghcr.io/tuna-os/albacore","tag":"gnome-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:bd946574b2940ef1b5efb971b93e961ac5652d8707e53eab94a7af446ebd724f","engineRevision":null,"indexDigest":"sha256:a611a487d4f3c5e89cd7a899428925e0e76789d37a9497066d2495a08f86c769","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:f66abdcac8e608035de2b5f9c4c8f73554d4f67c216f56e6e510958ef17bc405"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:gnome-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2057394460,"desktop":"gnome","digest":"sha256:2abae2bdf07fe66c90bd35d30881256778a3c633593666a18206075c25042406","hasSdBoot":false,"kernelVer":"6.12.0-211.73.1.el10_2.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:gnome","repository":"ghcr.io/tuna-os/albacore","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:328c61bb2945a61016f43de1f65305c6983a9a22a492ee5b96a2c4bd278a5a1f","engineRevision":null,"indexDigest":"sha256:d98b17e60897b2a5ac9e09d56d1c7d133f890099d86052fa7f09cbd6f2db8986","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:2abae2bdf07fe66c90bd35d30881256778a3c633593666a18206075c25042406"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":2054344146,"desktop":"gnome","digest":"sha256:aeb742e7db63febdd9734f844259dce99af7ba6317439f1bb34e39741a2b0503","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:gnome","repository":"ghcr.io/tuna-os/albacore","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:fd5840ec50e464f371bdb59ea4453e0e9b4721b558742283f8d50dd9e464c8ed","engineRevision":null,"indexDigest":"sha256:d98b17e60897b2a5ac9e09d56d1c7d133f890099d86052fa7f09cbd6f2db8986","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:aeb742e7db63febdd9734f844259dce99af7ba6317439f1bb34e39741a2b0503"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"albacore"},"targetKey":"albacore:gnome:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2136818084,"desktop":"kde","digest":"sha256:d464805d58f5516771837b0cf834018dc501e12f0097d740fe2cbb1a17bd913a","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:kde-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"kde-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:f25de4a47f3e4245a4663f596a088c289da5f36ac90b2b0fb2e697a49d6d44fc","engineRevision":null,"indexDigest":"sha256:961e8af8c5bbcd70f429a13beadc08c5754f5addef1c5b4504c4f672d8a2c1b0","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:d464805d58f5516771837b0cf834018dc501e12f0097d740fe2cbb1a17bd913a"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:kde-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":2132731974,"desktop":"kde","digest":"sha256:67b806db83738a106cc01dfbe7c4b5a341b6536303526109cb056116a942797b","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:kde-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"kde-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:6538974c1eecf924be2d3c6d291776712e564cb1b50413837f776ad42ca48724","engineRevision":null,"indexDigest":"sha256:961e8af8c5bbcd70f429a13beadc08c5754f5addef1c5b4504c4f672d8a2c1b0","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:67b806db83738a106cc01dfbe7c4b5a341b6536303526109cb056116a942797b"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"kde-hwe","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"albacore"},"targetKey":"albacore:kde-hwe:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2036537351,"desktop":"kde","digest":"sha256:5ffec7fa5363e9eb9bdd9952210d460661095ac14ac6deb9ba5004b9e9d48951","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:kde-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"kde-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:0620314e6b167923d39c1c7c53f053efeacead918d0ae571bed01eca46eca0cf","engineRevision":null,"indexDigest":"sha256:961e8af8c5bbcd70f429a13beadc08c5754f5addef1c5b4504c4f672d8a2c1b0","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:5ffec7fa5363e9eb9bdd9952210d460661095ac14ac6deb9ba5004b9e9d48951"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"kde-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"albacore"},"targetKey":"albacore:kde-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2741924679,"desktop":"kde","digest":"sha256:31540d9cf22d1488bb9b8a9a0dd58bffc7dde2d89a29fd640626790f717dbad4","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:kde-nvidia","repository":"ghcr.io/tuna-os/albacore","tag":"kde-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:92168a3f8aaf9bda4638feb6fc55a9ca82393b4705ee2f87024a371c7570ef02","engineRevision":null,"indexDigest":"sha256:36179dc566f84d66696de401dbb83b3e218468afefdfe3a85eb73ebc370575c0","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:31540d9cf22d1488bb9b8a9a0dd58bffc7dde2d89a29fd640626790f717dbad4"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:kde-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2136816503,"desktop":"kde","digest":"sha256:14a4352cb02f157659b4469667163df113ecec12df8427b2ff1c0bf8b556fc02","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:kde","repository":"ghcr.io/tuna-os/albacore","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:ee2a89f0290a68b733024d1bb10e3736bb2f6b039c3671f2903e7885d6d0da9d","engineRevision":null,"indexDigest":"sha256:bc1058540e32b4b0bc3a2414e1b149806181d29a25f0d2b7b1a01a8e5f2de540","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:14a4352cb02f157659b4469667163df113ecec12df8427b2ff1c0bf8b556fc02"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":2132731597,"desktop":"kde","digest":"sha256:bd580954f85f1ca0be303a70442feec669cbd61a459551b7d82870d85cb790d4","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:kde","repository":"ghcr.io/tuna-os/albacore","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:bc00a15068509654e3a8a547fd267eca86dc2d382d2ec143f61930837b3e035a","engineRevision":null,"indexDigest":"sha256:bc1058540e32b4b0bc3a2414e1b149806181d29a25f0d2b7b1a01a8e5f2de540","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:bd580954f85f1ca0be303a70442feec669cbd61a459551b7d82870d85cb790d4"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"albacore"},"targetKey":"albacore:kde:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2036550703,"desktop":"kde","digest":"sha256:05e99c6593e083c3437e416146552cf49f37d57e2d4b54851b4691a0dcdaa8d1","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:kde","repository":"ghcr.io/tuna-os/albacore","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:1f2f40912a78636d9dcffb321dc0dbb90c157b008e054005efabb6b7293930ae","engineRevision":null,"indexDigest":"sha256:bc1058540e32b4b0bc3a2414e1b149806181d29a25f0d2b7b1a01a8e5f2de540","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:05e99c6593e083c3437e416146552cf49f37d57e2d4b54851b4691a0dcdaa8d1"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"kde","hardwareScope":"generic","platform":"linux/arm64","variant":"albacore"},"targetKey":"albacore:kde:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1938823020,"desktop":"niri","digest":"sha256:f5d7258fb67e9d7573eba61c93e1ae7eb89e45eec08a361fcb447bdd29de7a22","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:niri-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"niri-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:45de88adb9f353b0ffcd11795eb42748e870a0262fd29ca9df2d2d1747c4169d","engineRevision":null,"indexDigest":"sha256:27086b8541876527701591655f372e9e0111cbea9b6cccf1d37230fe254e4f3e","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:f5d7258fb67e9d7573eba61c93e1ae7eb89e45eec08a361fcb447bdd29de7a22"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:niri-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1947764531,"desktop":"niri","digest":"sha256:165f0d9fe96d43933fe99e5b7e07634bf67b82699ad5ab0c5c370024bc7d338d","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:niri-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"niri-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:fc49fb9dce5a7776e484a4ccd4ffc3696969f90f25ea495b5f772f00357d5885","engineRevision":null,"indexDigest":"sha256:27086b8541876527701591655f372e9e0111cbea9b6cccf1d37230fe254e4f3e","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:165f0d9fe96d43933fe99e5b7e07634bf67b82699ad5ab0c5c370024bc7d338d"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"niri-hwe","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"albacore"},"targetKey":"albacore:niri-hwe:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1834454957,"desktop":"niri","digest":"sha256:e098f45ed984d52df61586e84f64e762bc6b67b02e946e4eb5a7db4949634bfd","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:niri-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"niri-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:f674ed8f35fdbf957a819d9b1f6701849c38a5bbbef37bb53f6c80d97fff9e65","engineRevision":null,"indexDigest":"sha256:27086b8541876527701591655f372e9e0111cbea9b6cccf1d37230fe254e4f3e","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:e098f45ed984d52df61586e84f64e762bc6b67b02e946e4eb5a7db4949634bfd"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"niri-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"albacore"},"targetKey":"albacore:niri-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2543523586,"desktop":"niri","digest":"sha256:492fcd3bf657adffbb308f642520452196011fe1184b3c40ee76b9f4dd45af06","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:niri-nvidia","repository":"ghcr.io/tuna-os/albacore","tag":"niri-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:e5d9cb30872871f02f13a6b75036f011e3245d5d036ebae094a6050c4d73f581","engineRevision":null,"indexDigest":"sha256:8c5ebf2bdb2782eb3879f39e1ca8cf8656f76af534eb9fb6f27b29a26fe970fc","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:492fcd3bf657adffbb308f642520452196011fe1184b3c40ee76b9f4dd45af06"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:niri-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1938845569,"desktop":"niri","digest":"sha256:57de008eb9df6871cb1970edaa2b507d9cf0b6890f7d80567d2224e387f96619","hasSdBoot":false,"kernelVer":"6.12.0-211.74.1.el10_2.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:niri","repository":"ghcr.io/tuna-os/albacore","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:e8b9f3df030e717d13961dd6fe3aa4d8acd396e02c2774fd396bc57a080eb62a","engineRevision":null,"indexDigest":"sha256:360548660936952c0f25bc4bb0dcf17f513a286121cb8cc085645d6ecc8205dc","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:57de008eb9df6871cb1970edaa2b507d9cf0b6890f7d80567d2224e387f96619"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:niri:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1947795276,"desktop":"niri","digest":"sha256:292c6deba4d3246524d294bc84c40eb40d13ee1d39bb92633a2a579afe8acb78","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:niri","repository":"ghcr.io/tuna-os/albacore","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:3908fa269fa326c5d6277f03e87ef07d40c32300c288df61e2b2c04564cc4721","engineRevision":null,"indexDigest":"sha256:360548660936952c0f25bc4bb0dcf17f513a286121cb8cc085645d6ecc8205dc","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:292c6deba4d3246524d294bc84c40eb40d13ee1d39bb92633a2a579afe8acb78"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"niri","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"albacore"},"targetKey":"albacore:niri:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1834436060,"desktop":"niri","digest":"sha256:749429f4ab15eecd2fe213311205a7e009f62ceebb6726a6d97c38acbea4291e","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:niri","repository":"ghcr.io/tuna-os/albacore","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:6899a21c30a8adca3b157c4d83f2cdb93b508064ce80d377c92dadb8baa060cd","engineRevision":null,"indexDigest":"sha256:360548660936952c0f25bc4bb0dcf17f513a286121cb8cc085645d6ecc8205dc","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:749429f4ab15eecd2fe213311205a7e009f62ceebb6726a6d97c38acbea4291e"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"niri","hardwareScope":"generic","platform":"linux/arm64","variant":"albacore"},"targetKey":"albacore:niri:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1862667112,"desktop":"tuna","digest":"sha256:4e3e0b191dfc55d1005d689d16b93fab495e65d7bd313140dc1dba59b5968b8c","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:tuna","repository":"ghcr.io/tuna-os/albacore","tag":"tuna"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:9f14a8c703ba005e67c8e745dc14f304544a3e1537c9686c2bd62602c298addd","engineRevision":null,"indexDigest":"sha256:b68a195dbc6e079bbab6b330086e6420d860f5364d1f2232e5f377bc6cdf2a13","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:4e3e0b191dfc55d1005d689d16b93fab495e65d7bd313140dc1dba59b5968b8c"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"tuna","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:tuna:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1737081862,"desktop":"xfce","digest":"sha256:24f3ab101e44e9a2cc244eb89f5e269581397e9b9c0309c6dbfd155ce188ae63","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:xfce-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"xfce-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:4a29cfc3804ac72eacbf5dc163b77893407ba4d1442482638fd2b2efbbff7bbf","engineRevision":null,"indexDigest":"sha256:b10d249b12c1f2a03d0896f09ed6c4ebad1c53cdfc59de9e0197276066b1a0c2","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:24f3ab101e44e9a2cc244eb89f5e269581397e9b9c0309c6dbfd155ce188ae63"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:xfce-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1737787756,"desktop":"xfce","digest":"sha256:ed4cb1fd6e4ed860053b896a86551dec6a203240a8fd5cd0d3f298045161ea3a","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:xfce-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"xfce-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:13effa2536a83b44b3b5edc8439ddf7fbfcd03b7f67c17432c87e37527b74684","engineRevision":null,"indexDigest":"sha256:b10d249b12c1f2a03d0896f09ed6c4ebad1c53cdfc59de9e0197276066b1a0c2","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:ed4cb1fd6e4ed860053b896a86551dec6a203240a8fd5cd0d3f298045161ea3a"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"xfce-hwe","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"albacore"},"targetKey":"albacore:xfce-hwe:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2341618411,"desktop":"xfce","digest":"sha256:d94326ecdffa99d7de29489175d4101d2fde282ba90bcd007bf7bfb890499fd1","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:xfce-nvidia","repository":"ghcr.io/tuna-os/albacore","tag":"xfce-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:d7c8139f31317eaac32f44d3ff41572550da6889c21ab645efd4e3964c05507b","engineRevision":null,"indexDigest":"sha256:6bcfc84779aa64a343010ba30376dbe6544fcea03eab027e4891e95a19626004","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:d94326ecdffa99d7de29489175d4101d2fde282ba90bcd007bf7bfb890499fd1"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:xfce-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1737067588,"desktop":"xfce","digest":"sha256:8e0e9f88d915a8e83cd85f75cf139614246b20574fdc79fb880f4bb6531ab5e0","hasSdBoot":false,"kernelVer":"6.12.0-211.74.1.el10_2.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:xfce","repository":"ghcr.io/tuna-os/albacore","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:46edce877bbe8b8c0f18ed8ff5b702a221fdf9a4550a084569f2282c4f85f343","engineRevision":null,"indexDigest":"sha256:ea204b0261b4bc988838ad9989159208d0c2cc373742878254f7c35f63a5204c","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:8e0e9f88d915a8e83cd85f75cf139614246b20574fdc79fb880f4bb6531ab5e0"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:xfce:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1737776451,"desktop":"xfce","digest":"sha256:c43b838ffd8f8401c149c6dedb59fbc13a4ae49b4093de5719c0c6fbda84731d","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:xfce","repository":"ghcr.io/tuna-os/albacore","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:1c0f658d0c6d19eb5de87bfe44004b5a7780d185fe406be66dab9c08420872ad","engineRevision":null,"indexDigest":"sha256:ea204b0261b4bc988838ad9989159208d0c2cc373742878254f7c35f63a5204c","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:c43b838ffd8f8401c149c6dedb59fbc13a4ae49b4093de5719c0c6fbda84731d"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"albacore"},"targetKey":"albacore:xfce:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1960637217,"desktop":"","digest":"sha256:c6d3376d0fbffe66f3da89290e45c5baa63be735130a87ad1c7e7d754ac6ce7d","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:base-hwe-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"base-hwe-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:7bb7bbce4177845ddc553c5eb6702cf283fa4527a0662f4ca53e31a375cefada","engineRevision":null,"indexDigest":"sha256:2a3c6daf788fa3bfe375c318ccdad0ad684c0f388c8631e595e717df451c0594","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:c6d3376d0fbffe66f3da89290e45c5baa63be735130a87ad1c7e7d754ac6ce7d"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:base-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1836796292,"desktop":"","digest":"sha256:f7ad987d50f07fcc4fa96d29af4132db333887f9f9d2e5f2e0b19384cf5370bc","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:base-hwe-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"base-hwe-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:b412c6db53ba8da74c0e579a4add8bbe40d45272f825204601852270c05a0779","engineRevision":null,"indexDigest":"sha256:2a3c6daf788fa3bfe375c318ccdad0ad684c0f388c8631e595e717df451c0594","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:f7ad987d50f07fcc4fa96d29af4132db333887f9f9d2e5f2e0b19384cf5370bc"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:base-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2822389036,"desktop":"","digest":"sha256:5cbe11c2c028c6c0a36bfb2cfa4fd4e6e12a6c32402cf22d987a7a0d59990221","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:base-nvidia-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"base-nvidia-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:f5e613bc75dada474fda3d23207bc17b525fe55656e87139b306fcc0a823e90b","engineRevision":null,"indexDigest":"sha256:59bbe1c7e4859e3187d725adea9bb03ea01dd53dd6a3698432fbb289beefdd64","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:5cbe11c2c028c6c0a36bfb2cfa4fd4e6e12a6c32402cf22d987a7a0d59990221"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:base-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1920856668,"desktop":"","digest":"sha256:66655ba5e3b8df40664a58292bb5a7fdfee59bfe531f25472dc1fcf91e908c07","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:base-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"base-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:5767349b4616b6a643909aee8568be355dbd80e368cb00d25072daaf48acba3a","engineRevision":null,"indexDigest":"sha256:6f97726811ba2a00e151f4a8f8714d46a75125de7f77ee98278c7996b16b9da9","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:66655ba5e3b8df40664a58292bb5a7fdfee59bfe531f25472dc1fcf91e908c07"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1799623976,"desktop":"","digest":"sha256:27127e0062284dfea518441f014271759cf3841ddddb9c60d5528cd2c2c930c8","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:base-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"base-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:16f78bb8c6b6aa223cd06d5f3ef9625b8bb420d9c828480e12ecaa934e978540","engineRevision":null,"indexDigest":"sha256:6f97726811ba2a00e151f4a8f8714d46a75125de7f77ee98278c7996b16b9da9","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:27127e0062284dfea518441f014271759cf3841ddddb9c60d5528cd2c2c930c8"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:base:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3513982353,"desktop":"cosmic","digest":"sha256:aefc3afbe6c0e9ad208922f303a840f31f0a8285695800a1c7158b8406c92b7d","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:cosmic-nvidia-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"cosmic-nvidia-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:ffb6b07ec0c62ab14d74cdb3400e8b75d003dfacaa34a0704d11ddb9c259d8ad","engineRevision":null,"indexDigest":"sha256:4deca868aff8c40582646575e50c48a6633b9b9d9a13b72087571e17cdb6bc7e","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:aefc3afbe6c0e9ad208922f303a840f31f0a8285695800a1c7158b8406c92b7d"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:cosmic-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2653366551,"desktop":"cosmic","digest":"sha256:690fb30c181a1aac00288f782bcff713d4c22316f1d6c446a247cb998191e714","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:cosmic-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"cosmic-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:fc3657c3bd14ec5c56823d3eb6652d4947f01de86f775d8bfae274055bf6d119","engineRevision":null,"indexDigest":"sha256:9ffbdda059fb72cd246f0432e271a38c2cdc06c4241adcadad91f0c6a2443611","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:690fb30c181a1aac00288f782bcff713d4c22316f1d6c446a247cb998191e714"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:cosmic:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2511190742,"desktop":"cosmic","digest":"sha256:63bcb31429e1e9f3b35c8b1d0d537027440458488b2ed7516a244dd628b6478b","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:cosmic-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"cosmic-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:832f73a7641f71c561828839121398f25bb268b11a15620cdc4274010c7092ab","engineRevision":null,"indexDigest":"sha256:9ffbdda059fb72cd246f0432e271a38c2cdc06c4241adcadad91f0c6a2443611","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:63bcb31429e1e9f3b35c8b1d0d537027440458488b2ed7516a244dd628b6478b"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"cosmic","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:cosmic:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2590060676,"desktop":"gnome","digest":"sha256:f178e38bcbda56475e75408df708dac9f6dfa886b5340b0402233a181d47bc8e","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome-hwe-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"gnome-hwe-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:0a685687bd8125cb062a64723f6246928d58a35854512c659a103abe18958004","engineRevision":null,"indexDigest":"sha256:1586897822e8e10c76f861ef7ce9ccc9af759fba56afa48e1eb18924f9866f00","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:f178e38bcbda56475e75408df708dac9f6dfa886b5340b0402233a181d47bc8e"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:gnome-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2453746344,"desktop":"gnome","digest":"sha256:1f12100ab04cf99250e2d12d2b7401c5ef3cb132636223f3921e3f392ecf9b9a","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome-hwe-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"gnome-hwe-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:0e2ed16e03d5f3cea29a14c4a8892d6a8e6dde2641807775995c0ff2cb0815b9","engineRevision":null,"indexDigest":"sha256:1586897822e8e10c76f861ef7ce9ccc9af759fba56afa48e1eb18924f9866f00","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:1f12100ab04cf99250e2d12d2b7401c5ef3cb132636223f3921e3f392ecf9b9a"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:gnome-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3181307628,"desktop":"gnome","digest":"sha256:410244ca81591f4b95be4a016ddf1920e4addd7bf930e95e519a9cdbd7142742","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome-nvidia-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"gnome-nvidia-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:d6bf869bd4b598a21952f59266b4cbcd89398652fb758a85ffabb4d61dc8a9ff","engineRevision":null,"indexDigest":"sha256:639c7fe0fc817103e61f8e2a2bd7915882179f41d7f94880383d51ab53947d2c","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:410244ca81591f4b95be4a016ddf1920e4addd7bf930e95e519a9cdbd7142742"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:gnome-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2573218666,"desktop":"gnome","digest":"sha256:fc34e18458387776cc575d73582e8cceeaa8e76c3b427301b099253cd8579425","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"gnome-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:14491c73aa4c5be5ba5c470a782d9cf2812430702868a7496b1742dd9b2dc6a5","engineRevision":null,"indexDigest":"sha256:28d02dc05fe923524e6698323b6f676424b63702d791f166753e8a9982f24247","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:fc34e18458387776cc575d73582e8cceeaa8e76c3b427301b099253cd8579425"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2436994269,"desktop":"gnome","digest":"sha256:225394bc6d1a06656b81e292f2ac83a58521578704d30ac1718a04554716b288","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"gnome-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:1137aae1c1914cb6c99b17ec8e5d37978ea827feafd05b1b55af163bef142122","engineRevision":null,"indexDigest":"sha256:28d02dc05fe923524e6698323b6f676424b63702d791f166753e8a9982f24247","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:225394bc6d1a06656b81e292f2ac83a58521578704d30ac1718a04554716b288"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:gnome:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3925044493,"desktop":"kde","digest":"sha256:24ae6271fe50057fd9bf145ffd7e360f7cb12615ba6038ded70724cab5937944","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:kde-nvidia-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"kde-nvidia-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:212b8392150fcd24bfba25f8abc466b1ef13481613acf81bbc670b107cb14ae9","engineRevision":null,"indexDigest":"sha256:72702eac12a13a81d20a58b85abbe540a90ac7742a73899abccadecd7857bf6a","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:24ae6271fe50057fd9bf145ffd7e360f7cb12615ba6038ded70724cab5937944"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:kde-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3337818912,"desktop":"kde","digest":"sha256:8816d24d79892a9c80cc9d97a87d7c32fd5968bff16095ce780614a29eae0fc7","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:kde-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"kde-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:4c87a85d3ebd0be7fa53a505404e303f697d7509e07810471926f437d56e817f","engineRevision":null,"indexDigest":"sha256:2053914bec94a3904a473d7f6cdc7f5acd8dcc8274d69e20f04d60c934d22390","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:8816d24d79892a9c80cc9d97a87d7c32fd5968bff16095ce780614a29eae0fc7"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3175723858,"desktop":"kde","digest":"sha256:6d4ce9d7b6f5eadfaf0de5ebdf68a3cd7808fd56be5e3db055d5d080a496649e","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:kde-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"kde-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:113b04d3b4bac54f82da633616250844cdcc1b46c9ce74fbf1e484de8e5bff0b","engineRevision":null,"indexDigest":"sha256:2053914bec94a3904a473d7f6cdc7f5acd8dcc8274d69e20f04d60c934d22390","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:6d4ce9d7b6f5eadfaf0de5ebdf68a3cd7808fd56be5e3db055d5d080a496649e"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"kde","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:kde:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3057882325,"desktop":"niri","digest":"sha256:14d0e1b43511c6ab38041096bba867a0784a6a307810a1c12bd7d89e92bc8b3f","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:niri-nvidia-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"niri-nvidia-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:ebb8aaf27c5237db7041c13b1f0019f1ecb78ab646029df2e2736af5452ffa23","engineRevision":null,"indexDigest":"sha256:7b766fa9f2b68c6ba3693e908d307a0ad8eaf5e8040c9b535dc6958c52ddbeef","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:14d0e1b43511c6ab38041096bba867a0784a6a307810a1c12bd7d89e92bc8b3f"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:niri-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2196301768,"desktop":"niri","digest":"sha256:98641407ade7c12f834b17dfca1ce86c633ea54af7935f1af450d2cb9d8c5a0c","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:niri-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"niri-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:1966b5804f4b46c4960f4dcee6ccc02afd0b81673415ff2c415d4638828ddb3b","engineRevision":null,"indexDigest":"sha256:4d400c6fcdbcd8c0016247bf407699dd3f719b7eaf090d278db8543eb794361a","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:98641407ade7c12f834b17dfca1ce86c633ea54af7935f1af450d2cb9d8c5a0c"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:niri:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2064099948,"desktop":"niri","digest":"sha256:4a1a4c71843d89ce7c73d0aed5f798d4e7ef891f7f69a5d3eedcf193b9935f1f","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:niri-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"niri-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:91bed934525fd6ef1eda8321e64e8a2372e99c4a41ef7a3b487e71a1eaabaa9b","engineRevision":null,"indexDigest":"sha256:4d400c6fcdbcd8c0016247bf407699dd3f719b7eaf090d278db8543eb794361a","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:4a1a4c71843d89ce7c73d0aed5f798d4e7ef891f7f69a5d3eedcf193b9935f1f"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"niri","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:niri:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2267443511,"desktop":"tuna","digest":"sha256:895013d5741bba45ce23418dcab2724582c0345fd5c7f9d691eace6074fffb22","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:tuna-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"tuna-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:eeee21b06c7c7bd509db6ac54c88673be768188119ba51f0b37cc33ee5967776","engineRevision":null,"indexDigest":"sha256:c9c852c8e3fc913bda4c7871559a4fee2fdac1be16a1a67be17cde7bacd705c2","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:895013d5741bba45ce23418dcab2724582c0345fd5c7f9d691eace6074fffb22"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"tuna","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:tuna:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3305282863,"desktop":"xfce","digest":"sha256:6cf706e5d2e7f79377be8adf49500eb01b35aa1688e6ac3e41331dc5c093f3cc","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:xfce-nvidia-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"xfce-nvidia-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:3288afa0d31052417ea3c7c31634036c61f173c9a928903630e161ebca41f904","engineRevision":null,"indexDigest":"sha256:7a95b59f2c336732b8d0d9bb19646deae6488e1b9d0c00ec06ffb90b7c518d77","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:6cf706e5d2e7f79377be8adf49500eb01b35aa1688e6ac3e41331dc5c093f3cc"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:xfce-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2716227729,"desktop":"xfce","digest":"sha256:27bc058e9a81019a93256aba423979858647bfc37a352dec67a405cd63c33f31","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:xfce-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"xfce-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:f39295541c48783c21cb442542a945b3ca6ca6bbe52ef3db5f50d02dd8e0e6e9","engineRevision":null,"indexDigest":"sha256:34a40df4f2bac89aae0fee8159cbff3b8b82b5f6521c4c29af2a27d277fa064f","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:27bc058e9a81019a93256aba423979858647bfc37a352dec67a405cd63c33f31"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:xfce:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2563488108,"desktop":"xfce","digest":"sha256:fb7e312a2199479f763793039a1c7d43b77b1ed9ff583ec36fb29e8109d125e7","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:xfce-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"xfce-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:e8ab79f05a0d357b1a5c9b1889b30d1c7d21e812dce899ef3c585a8a9da01187","engineRevision":null,"indexDigest":"sha256:34a40df4f2bac89aae0fee8159cbff3b8b82b5f6521c4c29af2a27d277fa064f","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:fb7e312a2199479f763793039a1c7d43b77b1ed9ff583ec36fb29e8109d125e7"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"xfce","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:xfce:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1974965377,"desktop":"","digest":"sha256:50b908732267e3e313d1cc5eace759459e043801f60bf587f5634b065cd7a3ae","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:base-hwe","repository":"ghcr.io/tuna-os/bonito","tag":"base-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:e7d8b365700425e6c1bbd57e374991f73d7f540c510d4f1bb07e8d29a6afea1c","engineRevision":null,"indexDigest":"sha256:fec5817551f3fc2b4baa89e75c950e4a7cc6d0802102029c547463f8c0d823e3","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:50b908732267e3e313d1cc5eace759459e043801f60bf587f5634b065cd7a3ae"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:base-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1857867793,"desktop":"","digest":"sha256:b758fdb49e845bc3f25aeb0c568d2df0400f85a27853afea8bd284df84e036f8","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:base-hwe","repository":"ghcr.io/tuna-os/bonito","tag":"base-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:0215769791e48b714b224b2909579b0c791f6baa65e02e04af4eac20d579e5d9","engineRevision":null,"indexDigest":"sha256:fec5817551f3fc2b4baa89e75c950e4a7cc6d0802102029c547463f8c0d823e3","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:b758fdb49e845bc3f25aeb0c568d2df0400f85a27853afea8bd284df84e036f8"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito"},"targetKey":"bonito:base-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2592672567,"desktop":"","digest":"sha256:c134df1fdd42b507e323b875b1f204ff3f7ced26327db0d44bebcd162139e25c","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:base-nvidia","repository":"ghcr.io/tuna-os/bonito","tag":"base-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:62fb00bc9b59372095d8e51c15bd208eb130a2557f1ae1e9769becd0145eeb83","engineRevision":null,"indexDigest":"sha256:7f652ce728f4f041f77e8e34e5aafc5e9cecdd5badc940c416224eb6b526c372","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:c134df1fdd42b507e323b875b1f204ff3f7ced26327db0d44bebcd162139e25c"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:base-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1848653353,"desktop":"","digest":"sha256:788076f1077f83757c0176486000942acd1265aefe7fc4fb8db36be3729ffb95","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:base","repository":"ghcr.io/tuna-os/bonito","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:d15f6d21cd9215eb981b27a72898d2373461bf89291803bb4d8d1e62b5f2b2d1","engineRevision":null,"indexDigest":"sha256:9bfab499d7c1f929efd4a217c7d8b535c8c31bf20cddd89a1107638b86dab5f4","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:788076f1077f83757c0176486000942acd1265aefe7fc4fb8db36be3729ffb95"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1725907309,"desktop":"","digest":"sha256:88b93381a041cd2c07e0c3e19a6e5e9889e09b356cc496446d1ecf2c59a66603","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:base","repository":"ghcr.io/tuna-os/bonito","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:6791f660e17f1617a31004e17f88e201148cfca48845bbb7f90ba8c90dbb4ab9","engineRevision":null,"indexDigest":"sha256:9bfab499d7c1f929efd4a217c7d8b535c8c31bf20cddd89a1107638b86dab5f4","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:88b93381a041cd2c07e0c3e19a6e5e9889e09b356cc496446d1ecf2c59a66603"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito"},"targetKey":"bonito:base:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3254730697,"desktop":"cosmic","digest":"sha256:35102920c4ae8cae0ee62ce2450aae6446dbd029c12a03ff0b222874d1200ef3","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:cosmic-nvidia","repository":"ghcr.io/tuna-os/bonito","tag":"cosmic-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:bffe95a5707f143ae915e70ae877716a18ee8a0ef8b2ab1216d321d094f98e5c","engineRevision":null,"indexDigest":"sha256:0dc13574ed2a16955c7e1d1364c3ea8e29e1190cc12930e933fac2d0e604cc98","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:35102920c4ae8cae0ee62ce2450aae6446dbd029c12a03ff0b222874d1200ef3"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:cosmic-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2636801300,"desktop":"cosmic","digest":"sha256:e7380297d332f5977f6bc7da1a8aef635bc630958039a6e6bcd4886ccd95dd3c","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:cosmic","repository":"ghcr.io/tuna-os/bonito","tag":"cosmic"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:03a5fd35e762ca11e64ff321eff14982cc13eb505306c108e8168d425c68c88e","engineRevision":null,"indexDigest":"sha256:d3980f9d1cdb1da19a3f882cf4b57551dfb3b5859e0fd01c247e96a889adc27b","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:e7380297d332f5977f6bc7da1a8aef635bc630958039a6e6bcd4886ccd95dd3c"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:cosmic:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2502270363,"desktop":"cosmic","digest":"sha256:04069f7a6d47d83e8a00f6e2fc0759dc709db4b795178516a62e5f7cbc8c9f7a","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:cosmic","repository":"ghcr.io/tuna-os/bonito","tag":"cosmic"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:0e3ee5cb15ff155e46730abe01ddf77f637b4049415473906b4263087468ab37","engineRevision":null,"indexDigest":"sha256:d3980f9d1cdb1da19a3f882cf4b57551dfb3b5859e0fd01c247e96a889adc27b","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:04069f7a6d47d83e8a00f6e2fc0759dc709db4b795178516a62e5f7cbc8c9f7a"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"cosmic","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito"},"targetKey":"bonito:cosmic:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2552231261,"desktop":"gnome","digest":"sha256:7dcc2efd30696d8ca38184e3b8f417408bf1d7253e9e5cad897966877562fd95","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome-asahi","repository":"ghcr.io/tuna-os/bonito","tag":"gnome-asahi"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:6f64858dfe829a32a8fd87311d66a4f8df858240496eb6347346860e167c4538","engineRevision":null,"indexDigest":"sha256:a48e23e78a25da9feca58818a9918dd2acf73a5f372036936ce28d71b7e272c3","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:7dcc2efd30696d8ca38184e3b8f417408bf1d7253e9e5cad897966877562fd95"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome-asahi","hardwareScope":"apple-silicon","platform":"linux/arm64","variant":"bonito"},"targetKey":"bonito:gnome-asahi:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2610984410,"desktop":"gnome","digest":"sha256:7e36bfbe2662177c4212704c728bd76ec2c1913285dbf7b6947f1b7e3901b610","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome-hwe","repository":"ghcr.io/tuna-os/bonito","tag":"gnome-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:5ceacc4e8efffe17effbbd558d93682a6aec568bc7c30e946a6e4ec938134ef4","engineRevision":null,"indexDigest":"sha256:131f959f03403d04bd8531824922e4af95c9e8320935d27b869f3c66de2820ac","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:7e36bfbe2662177c4212704c728bd76ec2c1913285dbf7b6947f1b7e3901b610"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:gnome-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2481401190,"desktop":"gnome","digest":"sha256:36c7e7351ed0e76bd7f18e459948d1be651c673ffef7cf68dea9c72f28fff573","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome-hwe","repository":"ghcr.io/tuna-os/bonito","tag":"gnome-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:380000cab7b29ddd49262e9240cf868f4ade513f1dd628917e416ee29a902f62","engineRevision":null,"indexDigest":"sha256:131f959f03403d04bd8531824922e4af95c9e8320935d27b869f3c66de2820ac","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:36c7e7351ed0e76bd7f18e459948d1be651c673ffef7cf68dea9c72f28fff573"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito"},"targetKey":"bonito:gnome-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3229431253,"desktop":"gnome","digest":"sha256:0ef1aff396a8b5cccb736fdc23331328720765130d3924793cee3ed9842223fe","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome-nvidia","repository":"ghcr.io/tuna-os/bonito","tag":"gnome-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:835b7af18ed26c1b1760bf399b51fdef27425c6fb91b2add4c0001f93fc608bd","engineRevision":null,"indexDigest":"sha256:d06696656ff16fe294bb2c072ab4652834c43b6e9e4af19e37a29a8eec0fded4","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:0ef1aff396a8b5cccb736fdc23331328720765130d3924793cee3ed9842223fe"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:gnome-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2618661562,"desktop":"gnome","digest":"sha256:3e88f63ae73cc726292b98f4b9ab36042c4fb79cdaa5821411816ae808e220a0","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome-t2","repository":"ghcr.io/tuna-os/bonito","tag":"gnome-t2"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:82b16742a2da46c0bf21e23a75612afdae922599835eb7066439b288fba1345a","engineRevision":null,"indexDigest":"sha256:3943ce06a5fa9ffadb362d2179e5d1a86f06fcd23930921bbcc10d0e9d0154c3","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:3e88f63ae73cc726292b98f4b9ab36042c4fb79cdaa5821411816ae808e220a0"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-t2","hardwareScope":"apple-t2","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:gnome-t2:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2666099073,"desktop":"gnome","digest":"sha256:19feedabaf699cec86c82c0b324691ae4e9892afb7fd561b3518f5c111723dc3","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome-x13s","repository":"ghcr.io/tuna-os/bonito","tag":"gnome-x13s"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:06e51abc1fb2e649ad3630553f9544666eb1193ba4afca5508e75612d8227b0e","engineRevision":null,"indexDigest":"sha256:02659b0f185acdd8e29a1473d672a534e577f0fba75dc70cc1b292702dcb060b","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:19feedabaf699cec86c82c0b324691ae4e9892afb7fd561b3518f5c111723dc3"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome-x13s","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito"},"targetKey":"bonito:gnome-x13s:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2610875093,"desktop":"gnome","digest":"sha256:a889648c27a2fb795dec3bb8ffca78e10f40d17653a4b03f7ba8a7fc8622a2a3","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome","repository":"ghcr.io/tuna-os/bonito","tag":"gnome"},"qualification":{"browser":null,"browserBuildReceiptDigest":null,"buildOrigin":"browser","isoDigest":"sha256:43cfbb779ef84c05671f3fe855cc0492c5d4c3bccb72cb3835503f0a20b03160","producer":{"ref":"refs/heads/main","repository":"tuna-os/iso-builder","runAttempt":1,"runId":42255145643,"sha":"5d689907e09034c0fa492f673dc3a718b3a9a3cc","workflow":".github/workflows/ci.yml"},"qualifiedAt":"2026-11-06T18:54:48Z","reason":null,"receiptDigest":"sha256:5cd515187c02a10271a95c1b34a299c7fb60c475fa6162139e6d347c51cb2738","receiptImageDigest":"sha256:037c8821c2afc4bb21dc701ae9c4729b014abfe732573c033be624b46fb2ee05","receiptPlatform":"linux/amd64","receiptSchema":"BrowserIsoQualificationReceipt/v1","resources":null,"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:f6683333033ea45404d1e0f299550bb9ae91a422673eabefbb37403b54c25a8d","engineRevision":"sha256:ca5a07efa6b4dbb145d15c32a777de34c3d9a984f83f6fe8e236ffe5a9038aad","indexDigest":"sha256:6298fcb3fd7f1ccbfdf3492e32a6cef73dc1dc5f3826d48bf7c99028b1a87e2b","installerRevision":"sha256:ff28c254d0f0c3fc303cdcd2d7cae1632a55e6f92f1f887c4c6f00559d82417b","liveOverlayBaseDigest":"sha256:037c8821c2afc4bb21dc701ae9c4729b014abfe732573c033be624b46fb2ee05","liveOverlayDigest":"sha256:7df8a3b3082add514a9fc8991182e2958a0805bcfae51f7b1944ab0c82a71fac","platformManifestDigest":"sha256:037c8821c2afc4bb21dc701ae9c4729b014abfe732573c033be624b46fb2ee05"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2481376617,"desktop":"gnome","digest":"sha256:0d1136396029248407e1f99d81e265ff418c996fbca52f139455d7bb0a0cf598","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome","repository":"ghcr.io/tuna-os/bonito","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:2ceab38e2a6fdcaea27c1415fda9e905b5e7dd682859a5ec99ffccdc2aa09fa2","engineRevision":null,"indexDigest":"sha256:05c68010540a09eb66f561073038c0683ceaa70d0f7301b86ceaaf387651a890","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:0d1136396029248407e1f99d81e265ff418c996fbca52f139455d7bb0a0cf598"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito"},"targetKey":"bonito:gnome:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3972081843,"desktop":"kde","digest":"sha256:8d353159ac01200f3e54130544954df2dda250316cd7bfa422823fe53a318041","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:kde-nvidia","repository":"ghcr.io/tuna-os/bonito","tag":"kde-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:dd1a91cbdd82bad56d4cac4b6dbfb7a42c52bc32de338933e7228fe4a83408f4","engineRevision":null,"indexDigest":"sha256:a28b59cf7f7f61ed91e83124731f8466ed4e57822af225b9d954d678e33a2d08","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:8d353159ac01200f3e54130544954df2dda250316cd7bfa422823fe53a318041"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:kde-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3352578109,"desktop":"kde","digest":"sha256:1b8e0f01dc95627fd0526abf0a6150959dc9e368f733b9ac54cfea034ee59901","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:kde","repository":"ghcr.io/tuna-os/bonito","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:8be1b3a099a1549c0dee44d4593398ae6bdbe12f760105a1e3c406d2bf0e2dcc","engineRevision":null,"indexDigest":"sha256:6bc09d7906c8cb2db8ecf395d4b91d59415a11809400230d3fa323fb7f62d0ad","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:1b8e0f01dc95627fd0526abf0a6150959dc9e368f733b9ac54cfea034ee59901"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3195625435,"desktop":"kde","digest":"sha256:cf0b06316ed17e0083e22c41f1167853c77fc48b65c91244ebbb447b29ed809c","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:kde","repository":"ghcr.io/tuna-os/bonito","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:51d4b0320ace496553bb61732b9db39213b15bd3683fba792f788c052579fcc2","engineRevision":null,"indexDigest":"sha256:6bc09d7906c8cb2db8ecf395d4b91d59415a11809400230d3fa323fb7f62d0ad","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:cf0b06316ed17e0083e22c41f1167853c77fc48b65c91244ebbb447b29ed809c"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"kde","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito"},"targetKey":"bonito:kde:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2821424220,"desktop":"niri","digest":"sha256:5ffb5f983231962171ebebf5e2f926bb4ef15b2955833ad43865294b401fbb2d","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:niri-nvidia","repository":"ghcr.io/tuna-os/bonito","tag":"niri-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:bf077b17af53fc457bdc12fa619b13b677dfd7a0a501846783cf1a8aceaa9303","engineRevision":null,"indexDigest":"sha256:6718f0a2ed6835ef9568bd3bb13f7863ea3bdb65e3b5dce3f5e907617574212e","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:5ffb5f983231962171ebebf5e2f926bb4ef15b2955833ad43865294b401fbb2d"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:niri-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2203748884,"desktop":"niri","digest":"sha256:2324fe4419bd0c7745a2c86a14fffb32226087d916606b64b6879387f28d253d","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:niri","repository":"ghcr.io/tuna-os/bonito","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:a80de45142b549560131030e4fae4a1e1db5a79f8cdedfcee1185d41e3dde88f","engineRevision":null,"indexDigest":"sha256:2dc7befa2b2fba4926b605c7c5f3d1c45fcc10381923b0d97ea9db3e642f3aa5","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:2324fe4419bd0c7745a2c86a14fffb32226087d916606b64b6879387f28d253d"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:niri:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2077163807,"desktop":"niri","digest":"sha256:021923091d45d94e690492807834d72f46182245d1c1bcaabb38967240e26e8e","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:niri","repository":"ghcr.io/tuna-os/bonito","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:5368613c6d811cce33b0ba0e9f03eef407d3136dc8a0300738cfdbd008f52c32","engineRevision":null,"indexDigest":"sha256:2dc7befa2b2fba4926b605c7c5f3d1c45fcc10381923b0d97ea9db3e642f3aa5","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:021923091d45d94e690492807834d72f46182245d1c1bcaabb38967240e26e8e"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"niri","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito"},"targetKey":"bonito:niri:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2290669015,"desktop":"tuna","digest":"sha256:55cbbe31333456c8c7d7c77c0d78350b6a32847dfd55320f3cdfd7c3be85c5b9","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:tuna","repository":"ghcr.io/tuna-os/bonito","tag":"tuna"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:c6231bf2c8317c61c7f61b93f3726ec3bf20271c14a959c6839f8418526e2645","engineRevision":null,"indexDigest":"sha256:61dc9271507de1f34376fa48abc0a3c46a4372c4151b5c4c94c7238d353a9199","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:55cbbe31333456c8c7d7c77c0d78350b6a32847dfd55320f3cdfd7c3be85c5b9"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"tuna","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:tuna:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3356641041,"desktop":"xfce","digest":"sha256:233efeb1f1dcfe18dc62a712430038c40b3d968e4a109354e78cf3ea8662c783","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:xfce-nvidia","repository":"ghcr.io/tuna-os/bonito","tag":"xfce-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:49867be8a134052b2b8d00255c0a8237e26296dc066ab7cd8fcf4d4daab07717","engineRevision":null,"indexDigest":"sha256:e030723dacd81c485069979bd402d3bf96766fa34fb6bda8081863a773e803aa","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:233efeb1f1dcfe18dc62a712430038c40b3d968e4a109354e78cf3ea8662c783"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:xfce-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2736335264,"desktop":"xfce","digest":"sha256:9154a0f97b6ab2ea5a2ffd01672936de1c6aaedb7f7f374ce19ba648ecb7c171","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:xfce","repository":"ghcr.io/tuna-os/bonito","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:70ca651dee7663e7e10aa29585421d5ca214f13dfe5b2d81211c93cfcee3cbe8","engineRevision":null,"indexDigest":"sha256:a04b4cebb15b6cf964c6a3b60c9c779f2014b4ccd0c1ca6193c6d912e0806ed4","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:9154a0f97b6ab2ea5a2ffd01672936de1c6aaedb7f7f374ce19ba648ecb7c171"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:xfce:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2589478830,"desktop":"xfce","digest":"sha256:7c7947232a51e2ea0341543ea5e157d03e9959966e091bc3e372bd96c7288574","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:xfce","repository":"ghcr.io/tuna-os/bonito","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:2c8b3f408ec25244412023b917cbe48482e7315be2cbf9b28891c081da380055","engineRevision":null,"indexDigest":"sha256:a04b4cebb15b6cf964c6a3b60c9c779f2014b4ccd0c1ca6193c6d912e0806ed4","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:7c7947232a51e2ea0341543ea5e157d03e9959966e091bc3e372bd96c7288574"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"xfce","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito"},"targetKey":"bonito:xfce:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1091961046,"desktop":"","digest":"sha256:589cf253f9828b903804fb87e0991130b5ecd1bea74bf23c3644640e9ecd8d21","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:base-sid","repository":"ghcr.io/tuna-os/flounder","tag":"base-sid"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:896eb8e9ba3cf55aaddf4a269dac24d45e611f57f08819efe4e7aaf43d04d5d9","engineRevision":null,"indexDigest":"sha256:d3e1d5f8cdf8a30d2064fdc5bc93964536fe24ba6b8752ec993420db730ab326","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:589cf253f9828b903804fb87e0991130b5ecd1bea74bf23c3644640e9ecd8d21"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder-sid"},"targetKey":"flounder-sid:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2217485851,"desktop":"gnome","digest":"sha256:10b3f776c4d459c5312e9f31ff315bfa607c17e264fb1cccff2e5ded920e4611","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:gnome-nvidia-sid","repository":"ghcr.io/tuna-os/flounder","tag":"gnome-nvidia-sid"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:b16c2fb79fc8d04a5b8c083ad9ff59d97102c22c448e68314f8d339f959c8b41","engineRevision":null,"indexDigest":"sha256:bf0f5386ccc7ed9d2f3572d2d7881dc6ced2310bc15b5b6754f7cc93a6485151","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:10b3f776c4d459c5312e9f31ff315bfa607c17e264fb1cccff2e5ded920e4611"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder-sid"},"targetKey":"flounder-sid:gnome-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1728783058,"desktop":"gnome","digest":"sha256:1cc18e78a25501781591ddb190682743a10787d46912d62b40c499ce44ac7e3a","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:gnome-sid","repository":"ghcr.io/tuna-os/flounder","tag":"gnome-sid"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:526b554705bcc56b8a4ab7f9757a0d5b09494700392790b9e633c98986fe3da2","engineRevision":null,"indexDigest":"sha256:a190085a74dacf0e309bcbafb011a4b8de4f37051350c924f48d1f2a66ce7ccf","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:1cc18e78a25501781591ddb190682743a10787d46912d62b40c499ce44ac7e3a"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder-sid"},"targetKey":"flounder-sid:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1927695981,"desktop":"kde","digest":"sha256:503bc5b548f0fa0d69479510a57079d6b50d1165c649e2a014aa01d41994b46d","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:kde-nvidia-sid","repository":"ghcr.io/tuna-os/flounder","tag":"kde-nvidia-sid"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:9b92672fb9e7770aad425c636e5e16cad28a103e8876f1eb1bb2af67b2bf8948","engineRevision":null,"indexDigest":"sha256:d8746995d0ddd808ffdb74a62b57596b06f7f45787c32008735a33919bc99fda","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:503bc5b548f0fa0d69479510a57079d6b50d1165c649e2a014aa01d41994b46d"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder-sid"},"targetKey":"flounder-sid:kde-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1394143786,"desktop":"kde","digest":"sha256:64ffc5aff1bc4e73aeb80dd666a7edd162d4a027577c9ff5647032f8a0f31fba","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:kde-sid","repository":"ghcr.io/tuna-os/flounder","tag":"kde-sid"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:4f2c5120027f2262c6ac5c58261d1bc30d5cce99b14b45b3e73394c4d9605f2b","engineRevision":null,"indexDigest":"sha256:f01a717a4d881e7bb176a5d4b92238b7b739f68da4c3e0ed3fbbd4a4f76110ec","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:64ffc5aff1bc4e73aeb80dd666a7edd162d4a027577c9ff5647032f8a0f31fba"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder-sid"},"targetKey":"flounder-sid:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1411313527,"desktop":"tuna","digest":"sha256:803bad2f3548f7696bd558ac276664a4d4492d95daaa167766018131110775a1","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:tuna-sid","repository":"ghcr.io/tuna-os/flounder","tag":"tuna-sid"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:db68fdec3c18ca798c6e832312c24c747a8172f720c30ef9d9e18be9b544b682","engineRevision":null,"indexDigest":"sha256:c7703a82c18b085ec75df496082bd40a2ecfcf96bcaf59a01aa5ba6dad03ac07","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:803bad2f3548f7696bd558ac276664a4d4492d95daaa167766018131110775a1"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"tuna","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder-sid"},"targetKey":"flounder-sid:tuna:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1691997030,"desktop":"xfce","digest":"sha256:a5591352bea0825a9e57dda841e4711c999335783f0f2d93032450d775c9d7b3","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:xfce-nvidia-sid","repository":"ghcr.io/tuna-os/flounder","tag":"xfce-nvidia-sid"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:f3fa68382c6535017f91054f0453bed0d83ada540742c4b90ae9c8eb20b9b351","engineRevision":null,"indexDigest":"sha256:074f8a0754ff789e38b9086b149bf550ad265f18e73a192e529544587290e21e","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:a5591352bea0825a9e57dda841e4711c999335783f0f2d93032450d775c9d7b3"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder-sid"},"targetKey":"flounder-sid:xfce-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1157489147,"desktop":"xfce","digest":"sha256:9c9d551ea88dd12d06d63449698f6f2b709060b0046a7baedb88f8bb457afbb1","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:xfce-sid","repository":"ghcr.io/tuna-os/flounder","tag":"xfce-sid"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:f67a046930fa72aa1868e13885f49c7b559d487f295bcd94eb2e4d05ea1b1221","engineRevision":null,"indexDigest":"sha256:ec21bb895babee6814966aad0b487c4f78e62cc2e184c8d600f130323eda8084","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:9c9d551ea88dd12d06d63449698f6f2b709060b0046a7baedb88f8bb457afbb1"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder-sid"},"targetKey":"flounder-sid:xfce:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1054886652,"desktop":"","digest":"sha256:9e323b70e8a8f53f2f82e17bc29b9c806957e1ec87099d35f495046b1945dcbb","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:base","repository":"ghcr.io/tuna-os/flounder","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:2e5c7a95f724040a726585c15055728357bd175f810e3d726e05dab0fc46e04a","engineRevision":null,"indexDigest":"sha256:f14b80f6a2a31c99f3c81574556385d21bc6198944d93a1079d517bca2804895","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:9e323b70e8a8f53f2f82e17bc29b9c806957e1ec87099d35f495046b1945dcbb"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder"},"targetKey":"flounder:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":995413119,"desktop":"","digest":"sha256:abcc7d4ebda730ee947750ab36de681bba110fa2d589c12916b6d15ed73bcde5","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:base","repository":"ghcr.io/tuna-os/flounder","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:8e92871b1e63a815b5dbfcd26410bbd79341766fc0e0baacf11fb20be79549d3","engineRevision":null,"indexDigest":"sha256:f14b80f6a2a31c99f3c81574556385d21bc6198944d93a1079d517bca2804895","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:abcc7d4ebda730ee947750ab36de681bba110fa2d589c12916b6d15ed73bcde5"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base","hardwareScope":"generic","platform":"linux/arm64","variant":"flounder"},"targetKey":"flounder:base:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1833747809,"desktop":"kde","digest":"sha256:77a56a78b264520026007e772ee163c65544c39d8f6259d0bb8b8b895c4769e5","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:kde-nvidia","repository":"ghcr.io/tuna-os/flounder","tag":"kde-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:8819ac065f9d3c39e447d65b3cc52f61d4862f36e192c52369df7c0504b6eff3","engineRevision":null,"indexDigest":"sha256:e423281a309101691f35ef17ed2011d547fa23c415697e221a0a7c89d73770cb","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:77a56a78b264520026007e772ee163c65544c39d8f6259d0bb8b8b895c4769e5"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder"},"targetKey":"flounder:kde-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1351263343,"desktop":"kde","digest":"sha256:c56c16535e9e4d4c1114c1a60b0d572e62860db954f5fed283875beee9a10ebc","hasSdBoot":true,"kernelVer":"6.12.115+deb13.1-amd64","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:kde","repository":"ghcr.io/tuna-os/flounder","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:1a734111826392e03e382816f8f46748e625eb120f1a480bdc03de5c5c144694","engineRevision":null,"indexDigest":"sha256:76c8589544cbb30ce8885a9536a6a3edb5b59cb5fbc5bad4dc25b8a28b5cbdbc","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:c56c16535e9e4d4c1114c1a60b0d572e62860db954f5fed283875beee9a10ebc"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder"},"targetKey":"flounder:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1353743221,"desktop":"tuna","digest":"sha256:03e7fa676f8cac494e7e8c9257279518d5c4e9f7667e5aaaa7bc6a18d160867c","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:tuna","repository":"ghcr.io/tuna-os/flounder","tag":"tuna"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:1afdf2510c29cafa1fb682c3332abb13cbfa82a27e6b4caaaa0548800a65dc6d","engineRevision":null,"indexDigest":"sha256:2cbda061deb49b794817ebf8b4abb15da39f7f19bfe2710f76dace6fbee8e2fc","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:03e7fa676f8cac494e7e8c9257279518d5c4e9f7667e5aaaa7bc6a18d160867c"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"tuna","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder"},"targetKey":"flounder:tuna:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1603202484,"desktop":"xfce","digest":"sha256:a2ce0f5374b55a3927ad840fd4ca2215e712a84c3065c28022222d8aa3e3d143","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:xfce-nvidia","repository":"ghcr.io/tuna-os/flounder","tag":"xfce-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:c0458723a4d80579e479fe43d41ef48f3ae10b78fe7354369d8ae957c0c737d3","engineRevision":null,"indexDigest":"sha256:527fa10919145c23f1d5398f94ffa8c5db479c3882676e7908185159870634b6","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:a2ce0f5374b55a3927ad840fd4ca2215e712a84c3065c28022222d8aa3e3d143"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder"},"targetKey":"flounder:xfce-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1120741271,"desktop":"xfce","digest":"sha256:5beb5d9d37c8a84656135499108fc5954440acbfb4b6f0f3f95f25e4090ebbac","hasSdBoot":true,"kernelVer":"6.12.115+deb13.1-amd64","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:xfce","repository":"ghcr.io/tuna-os/flounder","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:e6d77d7018f618bc112227abb250ae1a0920cf0c0f66d51fbcc36f39dba2c3c4","engineRevision":null,"indexDigest":"sha256:ccc8597774616b55f527a3c571458a98c9abdbe13acd1c0a3a8e8506c152e45e","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:5beb5d9d37c8a84656135499108fc5954440acbfb4b6f0f3f95f25e4090ebbac"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder"},"targetKey":"flounder:xfce:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1783971589,"desktop":"","digest":"sha256:c4d16d7d2af4bcbcf4fdbc0303ee0c7bdad7fb4fe552c77c9c716cb5243e0047","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:base","repository":"ghcr.io/tuna-os/grouper","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:c7456a35d552f54c6207d62412ba131b07a8959c06896e1e92e4830f3670c3b5","engineRevision":null,"indexDigest":"sha256:5619ec2663a7ebb23f4269fdf9797f337d865430cea8549524cff1686b6939ac","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:c4d16d7d2af4bcbcf4fdbc0303ee0c7bdad7fb4fe552c77c9c716cb5243e0047"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"grouper"},"targetKey":"grouper:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1779420035,"desktop":"","digest":"sha256:f89a385f972890ce207b0b0f7b92ab92fe15e72e7bb009b015ec92e8f6bdc667","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:base","repository":"ghcr.io/tuna-os/grouper","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:71eb9484902d60b66828167e3847c75cd1f68da917a4b25b3e84be42433c1a4e","engineRevision":null,"indexDigest":"sha256:5619ec2663a7ebb23f4269fdf9797f337d865430cea8549524cff1686b6939ac","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:f89a385f972890ce207b0b0f7b92ab92fe15e72e7bb009b015ec92e8f6bdc667"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base","hardwareScope":"generic","platform":"linux/arm64","variant":"grouper"},"targetKey":"grouper:base:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2102268711,"desktop":"cosmic","digest":"sha256:79b960f3bbdc901cf7305266195a14c559a16af3ec6ceaf28330e8992681208a","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:cosmic","repository":"ghcr.io/tuna-os/grouper","tag":"cosmic"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:5d6ffd50dc99a77e2530662709867b3dfd1eba4bfa53e6ec5ad24139b28c85d8","engineRevision":null,"indexDigest":"sha256:044f908a45c55ef5774a6d4a24290bb36e981241d9a68652ff43c77e2b17c16c","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:79b960f3bbdc901cf7305266195a14c559a16af3ec6ceaf28330e8992681208a"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic","hardwareScope":"generic","platform":"linux/amd64","variant":"grouper"},"targetKey":"grouper:cosmic:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2103887014,"desktop":"gnome","digest":"sha256:1810e9c37cae7a4e7ef3c3bd271425beb5382ff477538f2a0460a8ace73e6a71","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:gnome-asahi","repository":"ghcr.io/tuna-os/grouper","tag":"gnome-asahi"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:9b3defa4c37ecca826f1ac8fc6f1efad80db8326f147d33993e1cf652d3dba0e","engineRevision":null,"indexDigest":"sha256:bbba7a84b60c0a2bd4627d91cb878fe32cdc1f234bc82a368226b3a136cb6a8a","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:1810e9c37cae7a4e7ef3c3bd271425beb5382ff477538f2a0460a8ace73e6a71"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome-asahi","hardwareScope":"apple-silicon","platform":"linux/arm64","variant":"grouper"},"targetKey":"grouper:gnome-asahi:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2142531382,"desktop":"gnome","digest":"sha256:eac03f12c4192beff1b828e7a23629025d93a3a2cbdef17b119af58501ebee4f","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:gnome-zfs","repository":"ghcr.io/tuna-os/grouper","tag":"gnome-zfs"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:79b66caf7315bec277c848e5e8fdd8d79aefcc1bd0cef2fa3adc5f452ca2745c","engineRevision":null,"indexDigest":"sha256:09c84ad04a5240feecb4084fd780f1aa98c97b1e6eb2806c58b82f0022f68135","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:eac03f12c4192beff1b828e7a23629025d93a3a2cbdef17b119af58501ebee4f"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-zfs","hardwareScope":"generic","platform":"linux/amd64","variant":"grouper"},"targetKey":"grouper:gnome-zfs:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2132982634,"desktop":"gnome","digest":"sha256:0cdf474e0154f6d3b0e591eba55e76d7d026a5e96c618a8b32117c389da69ea7","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:gnome-zfs","repository":"ghcr.io/tuna-os/grouper","tag":"gnome-zfs"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:8e68aa20b773899f122de55a2a2f77d04440486cba2e3937b3dcc4ff1ea05e84","engineRevision":null,"indexDigest":"sha256:09c84ad04a5240feecb4084fd780f1aa98c97b1e6eb2806c58b82f0022f68135","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:0cdf474e0154f6d3b0e591eba55e76d7d026a5e96c618a8b32117c389da69ea7"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome-zfs","hardwareScope":"generic","platform":"linux/arm64","variant":"grouper"},"targetKey":"grouper:gnome-zfs:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2244812209,"desktop":"gnome","digest":"sha256:49821f956ff2e3f00624f45e82bc1ed0b360d94a21ed34603b930db5c0431823","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:gnome","repository":"ghcr.io/tuna-os/grouper","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:7bf0511f98455df7be214c9dd3431bed94c2a91c538a74c4982a0531cc124392","engineRevision":null,"indexDigest":"sha256:296d02f76c9155206749c16c15cc9abd5172ac9a3f79842d625d56e2fa751a4f","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:49821f956ff2e3f00624f45e82bc1ed0b360d94a21ed34603b930db5c0431823"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"grouper"},"targetKey":"grouper:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2234672006,"desktop":"gnome","digest":"sha256:2b9b74eac5491f96e3d022305c8e36e44d08eee3bca96833b1c34345775e3f11","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:gnome","repository":"ghcr.io/tuna-os/grouper","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:091da3bd0a2ff2ee855f020607ffa69f354bd20f5e91aa01e5bae30d965ef030","engineRevision":null,"indexDigest":"sha256:296d02f76c9155206749c16c15cc9abd5172ac9a3f79842d625d56e2fa751a4f","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:2b9b74eac5491f96e3d022305c8e36e44d08eee3bca96833b1c34345775e3f11"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome","hardwareScope":"generic","platform":"linux/arm64","variant":"grouper"},"targetKey":"grouper:gnome:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1989358186,"desktop":"kde","digest":"sha256:fdc2166d5518e032c16e743e86b1d45c50ab49ae8c59f787e952920d8a7169ff","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:kde","repository":"ghcr.io/tuna-os/grouper","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:ab2317964cbfc42c2afda60e40f8f6a0b71049e451d5b3c1412dd54febfcadb4","engineRevision":null,"indexDigest":"sha256:3142ba399625fb65890b19fb4f4c445d893c567791c5c98a49250349a8e200f7","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:fdc2166d5518e032c16e743e86b1d45c50ab49ae8c59f787e952920d8a7169ff"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"grouper"},"targetKey":"grouper:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1982211059,"desktop":"kde","digest":"sha256:5ed0be0e81d3caab5e57178c469cd62a7bc190389a3fe6a43b064ad3adc12549","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:kde","repository":"ghcr.io/tuna-os/grouper","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:1eb0c328b6c747c3c8ee41099d2b98cabeafbe8e3d384005e0fdda9ac16688fa","engineRevision":null,"indexDigest":"sha256:3142ba399625fb65890b19fb4f4c445d893c567791c5c98a49250349a8e200f7","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:5ed0be0e81d3caab5e57178c469cd62a7bc190389a3fe6a43b064ad3adc12549"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"kde","hardwareScope":"generic","platform":"linux/arm64","variant":"grouper"},"targetKey":"grouper:kde:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2072682461,"desktop":"tuna","digest":"sha256:6a88be8a0790840886aa4313c17db4cdd452fc7bc1f5f79ccccce88964f36b04","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:tuna","repository":"ghcr.io/tuna-os/grouper","tag":"tuna"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:1577766448eb6f4378b466a395f655c89bf3a6cd86a2f13ccac78a6e06f2b2db","engineRevision":null,"indexDigest":"sha256:5617261647de483740d61654154608edb01d3c565fefb7a521acfccf01020309","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:6a88be8a0790840886aa4313c17db4cdd452fc7bc1f5f79ccccce88964f36b04"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"tuna","hardwareScope":"generic","platform":"linux/amd64","variant":"grouper"},"targetKey":"grouper:tuna:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1815673215,"desktop":"xfce","digest":"sha256:56315369b822c2124e7139ef97c3c864b6a72fe9c60f78adba59db9c1593c435","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:xfce","repository":"ghcr.io/tuna-os/grouper","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:1db9dffe5caa300845d7367bf9a887ef9ad8086fd099c292f5db7bb55dbd521e","engineRevision":null,"indexDigest":"sha256:711bed4c49b93d3cd87513321a8239da603d5d039e89e66f186c3af372654fe2","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:56315369b822c2124e7139ef97c3c864b6a72fe9c60f78adba59db9c1593c435"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"grouper"},"targetKey":"grouper:xfce:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1810702037,"desktop":"xfce","digest":"sha256:7ac06561150c4cdd20d5ddcbf006827ac5a3900a3367b80fa1f6fc7b949f8ce1","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:xfce","repository":"ghcr.io/tuna-os/grouper","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:2fa4316c285c1132f94f6a7dcd3a64eb86bebc32896255311723c69cb68d1d7c","engineRevision":null,"indexDigest":"sha256:711bed4c49b93d3cd87513321a8239da603d5d039e89e66f186c3af372654fe2","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:7ac06561150c4cdd20d5ddcbf006827ac5a3900a3367b80fa1f6fc7b949f8ce1"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"xfce","hardwareScope":"generic","platform":"linux/arm64","variant":"grouper"},"targetKey":"grouper:xfce:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2829804972,"desktop":"","digest":"sha256:d571ef6acdae4366c70c876eb2dab6e4a30a7fb3e10070ca050bb6e9aca06cc6","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"emerge","repoFamily":"gentoo"},"publication":{"ref":"ghcr.io/tuna-os/guppy:base","repository":"ghcr.io/tuna-os/guppy","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:1c206cbaa316d9681013ed92fa6d704c0ef41251eb397f743fa0898a17396941","engineRevision":null,"indexDigest":"sha256:4f67904923875409fec2b859b5a88568af272ecf4ae7526d62514a323ea9903d","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:d571ef6acdae4366c70c876eb2dab6e4a30a7fb3e10070ca050bb6e9aca06cc6"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"guppy"},"targetKey":"guppy:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3030706306,"desktop":"gnome","digest":"sha256:7782d5f103c952f95f967f215b91a82a2f0dc4515ffc1a8e9c4a94c9bf0d1a33","hasSdBoot":true,"kernelVer":"6.18.38-gentoo-dist-bin","layerCount":65,"pkgManager":"emerge","repoFamily":"gentoo"},"publication":{"ref":"ghcr.io/tuna-os/guppy:gnome","repository":"ghcr.io/tuna-os/guppy","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:fbf2ff73d734660184ea2a8513e79075d3304daa8fc04abd845f88d10d9a33c6","engineRevision":null,"indexDigest":"sha256:4b081ef3a24a07be0307066e69d8e4e119c62b3e4416a052e6d152e0517aac61","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:7782d5f103c952f95f967f215b91a82a2f0dc4515ffc1a8e9c4a94c9bf0d1a33"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"guppy"},"targetKey":"guppy:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3695549843,"desktop":"kde","digest":"sha256:869dc28910fa9915903370b463e3c2bc0693372f729200dd223c6d71b7cb9133","hasSdBoot":true,"kernelVer":"6.18.54-gentoo-dist-bin","layerCount":65,"pkgManager":"emerge","repoFamily":"gentoo"},"publication":{"ref":"ghcr.io/tuna-os/guppy:kde","repository":"ghcr.io/tuna-os/guppy","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:60c0612a74970be47c7575c202dcc72cb9dec383fb0818a4043f27ac1b578b1c","engineRevision":null,"indexDigest":"sha256:b1f710c1c3492fb89075acbed717be179fc1d904b973cd4f34247e56b93d7d51","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:869dc28910fa9915903370b463e3c2bc0693372f729200dd223c6d71b7cb9133"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"guppy"},"targetKey":"guppy:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2841523017,"desktop":"xfce","digest":"sha256:989078eed2adb4c5a079a85295b830f68b2e0c48b82867c058f18ccfcf63059e","hasSdBoot":true,"kernelVer":"6.18.57-gentoo-dist-bin","layerCount":65,"pkgManager":"emerge","repoFamily":"gentoo"},"publication":{"ref":"ghcr.io/tuna-os/guppy:xfce","repository":"ghcr.io/tuna-os/guppy","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:bc6d3e1c25eadc6b6bff26dccc3dfbdfc2315cdcffcb13730c65abc40cf442b5","engineRevision":null,"indexDigest":"sha256:a16a3b45ff605d73e06a6e83a073d68a548203a0c6148f853e1413e10b6e08a6","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:989078eed2adb4c5a079a85295b830f68b2e0c48b82867c058f18ccfcf63059e"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"guppy"},"targetKey":"guppy:xfce:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1580545425,"desktop":"","digest":"sha256:a5b71d890185c52b23774dd3559d998aa6510feb248df24483a4ea00ee1386cb","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/gurnard:base","repository":"ghcr.io/tuna-os/gurnard","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:50c540931201088da9d9d35610694a0ea074a21e556321c2976d2d980f7311f6","engineRevision":null,"indexDigest":"sha256:f4f7d80ac52e9a1be3d6dd80f5df2b6d8f47bf8c07af01bfdc625444a5327150","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:a5b71d890185c52b23774dd3559d998aa6510feb248df24483a4ea00ee1386cb"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"gurnard"},"targetKey":"gurnard:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1542877414,"desktop":"","digest":"sha256:36428c47d8aecc2062a50d924eefe322053ed35664c7c2d3f92e7ff8d420bf23","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/gurnard:base","repository":"ghcr.io/tuna-os/gurnard","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:00e33bf074f21447b7a122bdf4124f82599955983abea6e10206d89f06c6f19d","engineRevision":null,"indexDigest":"sha256:f4f7d80ac52e9a1be3d6dd80f5df2b6d8f47bf8c07af01bfdc625444a5327150","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:36428c47d8aecc2062a50d924eefe322053ed35664c7c2d3f92e7ff8d420bf23"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base","hardwareScope":"generic","platform":"linux/arm64","variant":"gurnard"},"targetKey":"gurnard:base:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1651031872,"desktop":"pantheon","digest":"sha256:ea40deed62428dc8a9b1cd096cc8af794e9e96fb270e605b2b655d559f718adc","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/gurnard:pantheon","repository":"ghcr.io/tuna-os/gurnard","tag":"pantheon"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:0f09b09d3a8dd37e055e0c0f6b35db5948915922dee26a5ca97660379241f13a","engineRevision":null,"indexDigest":"sha256:2ea1551dcf3452688b670760d7c0132a97b42197b1e15e5ada5a1e728caf157c","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:ea40deed62428dc8a9b1cd096cc8af794e9e96fb270e605b2b655d559f718adc"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"pantheon","hardwareScope":"generic","platform":"linux/amd64","variant":"gurnard"},"targetKey":"gurnard:pantheon:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1612386067,"desktop":"pantheon","digest":"sha256:7caf1eb14e77d9c8ed33101aec1648c384056ae558e5d49e88cffef2d6906828","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/gurnard:pantheon","repository":"ghcr.io/tuna-os/gurnard","tag":"pantheon"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:58f26ab239ed5bf3ceb28d58cf16f6d5a05226e732f620451d4bd4360e79c907","engineRevision":null,"indexDigest":"sha256:2ea1551dcf3452688b670760d7c0132a97b42197b1e15e5ada5a1e728caf157c","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:7caf1eb14e77d9c8ed33101aec1648c384056ae558e5d49e88cffef2d6906828"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"pantheon","hardwareScope":"generic","platform":"linux/arm64","variant":"gurnard"},"targetKey":"gurnard:pantheon:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":841052241,"desktop":"","digest":"sha256:4ae00c3b2a21db49630015332dd9080a0b4b59d0dce91bd91080c2e661fb3565","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/hummingbird:base","repository":"ghcr.io/tuna-os/hummingbird","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:a24bb8429ce27d573bdb576af66f22affc70890bcfbfafe93f8fa3bc01a61814","engineRevision":null,"indexDigest":"sha256:91af0af348f90052f8831029d59da49683bb57eb1573e82ed933ae64cc1b1cc5","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:4ae00c3b2a21db49630015332dd9080a0b4b59d0dce91bd91080c2e661fb3565"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"hummingbird"},"targetKey":"hummingbird:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1193415389,"desktop":"gnome","digest":"sha256:04360b52392abab53704043393fd758b9f343a242a2fdab4d349da93f9f533f0","hasSdBoot":false,"kernelVer":"7.1.8-100.fc43.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/hummingbird:cosmic","repository":"ghcr.io/tuna-os/hummingbird","tag":"cosmic"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:84f342bb8f3576762e66b095fb780742e16a5238ee1c8ce8a3e5dd607a629545","engineRevision":null,"indexDigest":"sha256:ede5242ee8e235933dd4866c3619e055cbd820300fe3d9807feecfe4f7fcc4ba","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:04360b52392abab53704043393fd758b9f343a242a2fdab4d349da93f9f533f0"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic","hardwareScope":"generic","platform":"linux/amd64","variant":"hummingbird"},"targetKey":"hummingbird:cosmic:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1718947608,"desktop":"gnome","digest":"sha256:83060f29b37743b0086e88546ac1b223e2373ae7f23fe0a8dc68a37c92cee6d2","hasSdBoot":false,"kernelVer":"7.2.8-200.fc44.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/hummingbird:gnome","repository":"ghcr.io/tuna-os/hummingbird","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:7b4273fe1a503cc7c4cbdf2e2ec35ab1c7de246a184436f157e4e58f9e7a9ebb","engineRevision":null,"indexDigest":"sha256:7fb82c04e8dfa63d76299dd07f2d82ea3c832485f913840fd88d56ea472411dd","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:83060f29b37743b0086e88546ac1b223e2373ae7f23fe0a8dc68a37c92cee6d2"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"hummingbird"},"targetKey":"hummingbird:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1632753429,"desktop":"","digest":"sha256:48521c8106b4fda3bf0c26602cbf6f8502b1611a0236a32eb9fed80c98b30a95","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:base","repository":"ghcr.io/tuna-os/marlin","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:420ab4ed2f19c4db92f56895fe2d82bfa934483ad9e87d4ed3d213b238d98932","engineRevision":null,"indexDigest":"sha256:dd75753c7ccfe44c0083b345a96fc4941b07a6289657ec4d568e56b915f60fce","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:48521c8106b4fda3bf0c26602cbf6f8502b1611a0236a32eb9fed80c98b30a95"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1502024298,"desktop":"","digest":"sha256:fc955ade144342680bc36b16a97efc32acf33f79aef38dcb7dba6948fb9a813f","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:base","repository":"ghcr.io/tuna-os/marlin","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:88995e32c0e46f9d70b90be9008123a5ff9fcb6bc519fe178d94eac97b7eb22a","engineRevision":null,"indexDigest":"sha256:dd75753c7ccfe44c0083b345a96fc4941b07a6289657ec4d568e56b915f60fce","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:fc955ade144342680bc36b16a97efc32acf33f79aef38dcb7dba6948fb9a813f"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base","hardwareScope":"generic","platform":"linux/arm64","variant":"marlin"},"targetKey":"marlin:base:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2984420658,"desktop":"cosmic","digest":"sha256:bf51efa4751bf594cdb60f67d53214441bf1c09d8e13291475b53fb9a749bc1e","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:cosmic-cachyos","repository":"ghcr.io/tuna-os/marlin","tag":"cosmic-cachyos"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:de1e5b790caec196aae450db1f5762a3d635b151a14aff05773cf3b025a831f9","engineRevision":null,"indexDigest":"sha256:c9e44337c3a61c3b0600532dba86f4a79c9ec8367abbc7ee85da31b5e7aeb0aa","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:bf51efa4751bf594cdb60f67d53214441bf1c09d8e13291475b53fb9a749bc1e"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic-cachyos","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:cosmic-cachyos:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3560164337,"desktop":"cosmic","digest":"sha256:c7113a38d637078da68ed4569c7f920f85d845b25b32e058c61e6a482c4e9a94","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:cosmic-nvidia","repository":"ghcr.io/tuna-os/marlin","tag":"cosmic-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:7bfdaa3201fe58f8e8fb430b2198b6941e68999d326b809cd64fb8a4e98a3187","engineRevision":null,"indexDigest":"sha256:36e74f668b42552200ddf0056ec7c460b616a3d54835e3b7a33af66f5bb09b3c","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:c7113a38d637078da68ed4569c7f920f85d845b25b32e058c61e6a482c4e9a94"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:cosmic-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2359067238,"desktop":"cosmic","digest":"sha256:b2e48ccb4992e7086239190c689c54616724b5325488a2c8bb2b42d2ea987ce8","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:cosmic","repository":"ghcr.io/tuna-os/marlin","tag":"cosmic"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:426a5a06aa9a0cf97c7e4c3d36b5f11f7f57fd7ffef4cb773f97c9299f2a499e","engineRevision":null,"indexDigest":"sha256:05b2ccb587b56b30ff4c4be56554d333e4a005029987beb44a5d1fee5da773fe","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:b2e48ccb4992e7086239190c689c54616724b5325488a2c8bb2b42d2ea987ce8"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:cosmic:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3053038522,"desktop":"gnome","digest":"sha256:6482608006c243f5a2474f5a079e07adda5607e0c3755312b46b94e6250d6796","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:gnome-cachyos","repository":"ghcr.io/tuna-os/marlin","tag":"gnome-cachyos"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:0cca5ec2438abcc4677fa3a418c791740fbac6843b5692c1151e18835a6d7119","engineRevision":null,"indexDigest":"sha256:522bfe332aac090b67920218f3f1f7e2ea94b1a89a4de7f2cbd8a3aa19bef896","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:6482608006c243f5a2474f5a079e07adda5607e0c3755312b46b94e6250d6796"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-cachyos","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:gnome-cachyos:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3628739767,"desktop":"gnome","digest":"sha256:43fdad92d6bc7eb38bbcd4f0bbe5b535da9b15df441eeede45e4a2a5a35edc78","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:gnome-nvidia","repository":"ghcr.io/tuna-os/marlin","tag":"gnome-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:6097197896d6578ed37cdc7884c2f73835fbda340bd40a9120a79fd5f5d42d99","engineRevision":null,"indexDigest":"sha256:ae5f80b77696c496a0623603d7bff4f013b7803023550bdb97340209b60e73bd","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:43fdad92d6bc7eb38bbcd4f0bbe5b535da9b15df441eeede45e4a2a5a35edc78"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:gnome-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2907593907,"desktop":"gnome","digest":"sha256:102d1c3b9a9f04bc48a3cd5ae97e266631c0e7c7d55a60a187254258d954abf0","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:gnome-x13s","repository":"ghcr.io/tuna-os/marlin","tag":"gnome-x13s"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:49d67afc9ed32c17afc6bce2bfaa3fb3f1ab03b6c3188f8adcbeec2541bef2f0","engineRevision":null,"indexDigest":"sha256:bf2b234bd33e575be6344b5fa06baac19bb03e7352b412e70380f5de566f95b3","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:102d1c3b9a9f04bc48a3cd5ae97e266631c0e7c7d55a60a187254258d954abf0"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome-x13s","hardwareScope":"generic","platform":"linux/arm64","variant":"marlin"},"targetKey":"marlin:gnome-x13s:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2408366596,"desktop":"gnome","digest":"sha256:9b6492c2ad05b4223e451d4cc59a6281a6b401482e1effd5def8c14d719e4544","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:gnome","repository":"ghcr.io/tuna-os/marlin","tag":"gnome"},"qualification":{"browser":null,"browserBuildReceiptDigest":null,"buildOrigin":"browser","isoDigest":"sha256:d25cd3b19f1a07a325e531a9aa6a76c8154f848028f305e6234aa5ad3ccd85a9","producer":{"ref":"refs/heads/main","repository":"tuna-os/iso-builder","runAttempt":1,"runId":42193686727,"sha":"e4ea9748a0f9bea4d800465f51fec9e72c96b42c","workflow":".github/workflows/ci.yml"},"qualifiedAt":"2026-11-06T10:52:25Z","reason":null,"receiptDigest":"sha256:b498c186bd64b6de251b70dddb329ad90021f53d85d795009cb68f6667085dd8","receiptImageDigest":"sha256:b71d6ab6e652624676803bfc2f04b985a88c48aa138be84eef42fe5a222d83eb","receiptPlatform":"linux/amd64","receiptSchema":"BrowserIsoQualificationReceipt/v1","resources":null,"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:9e1990c1a2fc2615bce8eba94ebe29bbf949278310626b7e77364b553faa7080","engineRevision":"sha256:ca5a07efa6b4dbb145d15c32a777de34c3d9a984f83f6fe8e236ffe5a9038aad","indexDigest":"sha256:244496340ec984f13ce038ca195ad724f5505cfb7cc415af80776ea8def5d0d1","installerRevision":"sha256:ff28c254d0f0c3fc303cdcd2d7cae1632a55e6f92f1f887c4c6f00559d82417b","liveOverlayBaseDigest":"sha256:b71d6ab6e652624676803bfc2f04b985a88c48aa138be84eef42fe5a222d83eb","liveOverlayDigest":"sha256:8317c1621a3a569553317f157a742cb19973e17cd4eb861168eba4e1a401ae61","platformManifestDigest":"sha256:b71d6ab6e652624676803bfc2f04b985a88c48aa138be84eef42fe5a222d83eb"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2368599514,"desktop":"gnome","digest":"sha256:a95ec2211d90eb2fe87109ed11fe8f65f5137821974fcbf2f14e00a86e87eac6","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:gnome","repository":"ghcr.io/tuna-os/marlin","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:fc162b5b58c413056997d439e8362860209787aa7ffcfa5ee6cd8f9cdc59b99f","engineRevision":null,"indexDigest":"sha256:32b8e8a2941575eb7c98994844a1546cb7cd9d008f94f5f48e16971283d48e33","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:a95ec2211d90eb2fe87109ed11fe8f65f5137821974fcbf2f14e00a86e87eac6"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome","hardwareScope":"generic","platform":"linux/arm64","variant":"marlin"},"targetKey":"marlin:gnome:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3013750193,"desktop":"kde","digest":"sha256:6aa74f1576d3e071b849d6e70d281fc91247515aa9a15a630e02a9d301a704e8","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:kde-cachyos","repository":"ghcr.io/tuna-os/marlin","tag":"kde-cachyos"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:7c66dc35fec1fd2ae2aa845a6734806a57c7f7592ca4d420d2901c0ce79211e8","engineRevision":null,"indexDigest":"sha256:a8bcdd19ea6e6aef4045863dc48af8cfd6bc8d5c33b7223b05707993875e2445","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:6aa74f1576d3e071b849d6e70d281fc91247515aa9a15a630e02a9d301a704e8"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde-cachyos","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:kde-cachyos:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3589883455,"desktop":"kde","digest":"sha256:2cce378e96e5943ca15ce93f582cb09c346a86d8ceb23f79d3f0a0389edaa84e","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:kde-nvidia","repository":"ghcr.io/tuna-os/marlin","tag":"kde-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:176364bad99cfa26e6004b1c41e8a3482533e0a4376cc2c78ae9af44de36ca57","engineRevision":null,"indexDigest":"sha256:47aa3a61426f69e4555040bd04597f9f0bcbbb8b4996c287dc9202e1284243b6","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:2cce378e96e5943ca15ce93f582cb09c346a86d8ceb23f79d3f0a0389edaa84e"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:kde-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2370117273,"desktop":"kde","digest":"sha256:d6359e1fa3184c633ef4d6410beb7f2f41fc4cbc9225ef056f6de434c84dc7d5","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:kde","repository":"ghcr.io/tuna-os/marlin","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:1661beb7b6fb26a1c69664d80d832f7e351138c6379593dcb37fb72ae22e7344","engineRevision":null,"indexDigest":"sha256:567a780fc2ba57a18ae402d691c4063fb9badcd4a7705381ce90b6e614f52d0a","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:d6359e1fa3184c633ef4d6410beb7f2f41fc4cbc9225ef056f6de434c84dc7d5"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2536838458,"desktop":"niri","digest":"sha256:8bf222c62ab67658ed1c2128abcfe80a749f48bf74189cb0a1287aabfe11d68c","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:niri-cachyos","repository":"ghcr.io/tuna-os/marlin","tag":"niri-cachyos"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:7398b165cf0647ef241afb398162be923ad084cf63bb43ebaa0e22469cb642d5","engineRevision":null,"indexDigest":"sha256:b6abf3d53323929c008862ae588190cedd7020f80b50fd3fea966f719da9562d","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:8bf222c62ab67658ed1c2128abcfe80a749f48bf74189cb0a1287aabfe11d68c"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri-cachyos","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:niri-cachyos:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3113443472,"desktop":"niri","digest":"sha256:0dc53bd5e19882431faf342b941de5950b705043a2ef324f11a17bb528362f91","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:niri-nvidia","repository":"ghcr.io/tuna-os/marlin","tag":"niri-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:1fcbc4155ba20c1a029aea802b314ee1b5de9dcccdec99fa5c625b25f4046bab","engineRevision":null,"indexDigest":"sha256:160121aeab3211d38825708588668cf53feab45e1c5b4375dbdc04f33bb3b260","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:0dc53bd5e19882431faf342b941de5950b705043a2ef324f11a17bb528362f91"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:niri-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1912476391,"desktop":"niri","digest":"sha256:e85306813efb1c85de51ee3deabd544a846467c59292ff341ed533473dca8d1c","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:niri","repository":"ghcr.io/tuna-os/marlin","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:0979414a60dbe9836839f20f94a9f69b0521eaa94c7d94121d532432d346011b","engineRevision":null,"indexDigest":"sha256:4f7902de9a09f54aaa954da76d91104a9749b3c8a2902019c9f86f4f8a619f25","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:e85306813efb1c85de51ee3deabd544a846467c59292ff341ed533473dca8d1c"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:niri:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2324817734,"desktop":"tuna","digest":"sha256:99444a047d38049a43a1ad13e482ae80ba8df142ca712782f9ff053a05365501","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:tuna","repository":"ghcr.io/tuna-os/marlin","tag":"tuna"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:1c982a7719eda6facc3809928032e873b45fb94cd159352a27a594afebddf14c","engineRevision":null,"indexDigest":"sha256:d77db56090d2a173808ce032e159f9cfb807af60535a555c05b955d541503589","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:99444a047d38049a43a1ad13e482ae80ba8df142ca712782f9ff053a05365501"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"tuna","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:tuna:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2662512068,"desktop":"xfce","digest":"sha256:d6bddff2f6a5ca2996f7b4f93a654793958eed09df3eaffffc109915690ac62b","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:xfce-cachyos","repository":"ghcr.io/tuna-os/marlin","tag":"xfce-cachyos"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:909df4daad730d1fef7334864b59f12c01ad565ed318bbedfb49c45151f7cf11","engineRevision":null,"indexDigest":"sha256:a779e76b0cae3343bc93b82eed5f8c9aef633d45f74826986bf2c6c4c674d58a","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:d6bddff2f6a5ca2996f7b4f93a654793958eed09df3eaffffc109915690ac62b"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce-cachyos","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:xfce-cachyos:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3238004153,"desktop":"xfce","digest":"sha256:4c6479f26dde073f50906d6c0101889471756596bb77a1d221c57aa825157e43","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:xfce-nvidia","repository":"ghcr.io/tuna-os/marlin","tag":"xfce-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:53ec183292c3ef397c0022b23be531ef0707efbf7e78680044bb878c3ec63e6d","engineRevision":null,"indexDigest":"sha256:1fc6e56f7aac3b93b4ff0763d84e924f4b6a512d6429ec0ae86244fc52d3a999","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:4c6479f26dde073f50906d6c0101889471756596bb77a1d221c57aa825157e43"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:xfce-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2037208498,"desktop":"xfce","digest":"sha256:c3040d109c46aeae75a2252327b429f5b93b7ca76efaa04ecd9ffc24baedf772","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:xfce","repository":"ghcr.io/tuna-os/marlin","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:613b46c32e7268014a60ce9e24333430728905a1f8237225580911a3d1db3c2c","engineRevision":null,"indexDigest":"sha256:6edbae861cef70b0bacfdd76eb9129641b76dda06b40bd9b0e831d7bae7f8a44","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:c3040d109c46aeae75a2252327b429f5b93b7ca76efaa04ecd9ffc24baedf772"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:xfce:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1490112716,"desktop":"","digest":"sha256:05fb7334c3c4fdf10e228be12eda4e87b201bee4369cf8c5afb97e1ab0e671a6","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"zypper","repoFamily":"opensuse"},"publication":{"ref":"ghcr.io/tuna-os/sailfin:base","repository":"ghcr.io/tuna-os/sailfin","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:04d4009c85f1cb50bdb5d8bd1a1d486b168ecaf399622a2d6fdedc7c2efca23c","engineRevision":null,"indexDigest":"sha256:164b75a63e431cb3fcd72584be9d4d94b369d3c80ce1ed17f462cb5fa4e6c040","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:05fb7334c3c4fdf10e228be12eda4e87b201bee4369cf8c5afb97e1ab0e671a6"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"sailfin"},"targetKey":"sailfin:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1517450750,"desktop":"","digest":"sha256:93ec1517d81526c870d163a2b0b92085f1206e3b3113cd7fe85375816eacb1cd","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"zypper","repoFamily":"opensuse"},"publication":{"ref":"ghcr.io/tuna-os/sailfin:base","repository":"ghcr.io/tuna-os/sailfin","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:5cefc6a5b203520ed6dabb4382de5dfa3ef98537757352ab47e75cbc183e8efa","engineRevision":null,"indexDigest":"sha256:164b75a63e431cb3fcd72584be9d4d94b369d3c80ce1ed17f462cb5fa4e6c040","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:93ec1517d81526c870d163a2b0b92085f1206e3b3113cd7fe85375816eacb1cd"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base","hardwareScope":"generic","platform":"linux/arm64","variant":"sailfin"},"targetKey":"sailfin:base:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1755569978,"desktop":"cosmic","digest":"sha256:63bc027218662f76d00cca4589094567a2ce7d6d048317dfcfa9f3bf1abbbe6c","hasSdBoot":true,"kernelVer":"7.3.0-1-default","layerCount":65,"pkgManager":"zypper","repoFamily":"opensuse"},"publication":{"ref":"ghcr.io/tuna-os/sailfin:cosmic","repository":"ghcr.io/tuna-os/sailfin","tag":"cosmic"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:567f161a6b8bc03d52b029e115b978a33016731a569a53c3112ff62d9e035df2","engineRevision":null,"indexDigest":"sha256:0d71630181de1c257be7f73014bf6c3c163f3da5ccb72931f20830bc68485145","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:63bc027218662f76d00cca4589094567a2ce7d6d048317dfcfa9f3bf1abbbe6c"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic","hardwareScope":"generic","platform":"linux/amd64","variant":"sailfin"},"targetKey":"sailfin:cosmic:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1880566871,"desktop":"gnome","digest":"sha256:4f9c8426674a92a495eed88c0ad2330ddf8097d0407cbe03cec4f7d9b27f02a0","hasSdBoot":true,"kernelVer":"7.3.0-1-default","layerCount":65,"pkgManager":"zypper","repoFamily":"opensuse"},"publication":{"ref":"ghcr.io/tuna-os/sailfin:gnome","repository":"ghcr.io/tuna-os/sailfin","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:840b0d322d544c26895a6a24c4ab358196c8b7c874c07440a226651577c15620","engineRevision":null,"indexDigest":"sha256:a81977c06da70d82ea1be16d64270716783a97e4140d619a370dfcdee4155f55","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:4f9c8426674a92a495eed88c0ad2330ddf8097d0407cbe03cec4f7d9b27f02a0"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"sailfin"},"targetKey":"sailfin:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1890107846,"desktop":"gnome","digest":"sha256:a433dc6349e45669372f02198bba757f8c0fbfab43af7102a53dda545bcafc74","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"zypper","repoFamily":"opensuse"},"publication":{"ref":"ghcr.io/tuna-os/sailfin:gnome","repository":"ghcr.io/tuna-os/sailfin","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:57a5662dba4f32183c7938e50e5a2660d86e01eec6720c7f35a050616b6a736f","engineRevision":null,"indexDigest":"sha256:a81977c06da70d82ea1be16d64270716783a97e4140d619a370dfcdee4155f55","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:a433dc6349e45669372f02198bba757f8c0fbfab43af7102a53dda545bcafc74"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome","hardwareScope":"generic","platform":"linux/arm64","variant":"sailfin"},"targetKey":"sailfin:gnome:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2273754357,"desktop":"kde","digest":"sha256:728201ccdabcb2bf9f8b0f22c893d20bcd96dca78421fc1220e931ed259cac3b","hasSdBoot":true,"kernelVer":"7.3.0-1-default","layerCount":65,"pkgManager":"zypper","repoFamily":"opensuse"},"publication":{"ref":"ghcr.io/tuna-os/sailfin:kde","repository":"ghcr.io/tuna-os/sailfin","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:7e610aa15d6852322807d24e69209b5b1e256a5a58a37322c3c0d1f2dd90e208","engineRevision":null,"indexDigest":"sha256:0ae52e1bc946869cac29967859703f08548edcfb9ffad04ce737196c0cd2950b","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:728201ccdabcb2bf9f8b0f22c893d20bcd96dca78421fc1220e931ed259cac3b"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"sailfin"},"targetKey":"sailfin:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1638440369,"desktop":"niri","digest":"sha256:7a2b159ab59919165583692e7452a1f40c06831c9288c8483076c71e3a6cc71e","hasSdBoot":true,"kernelVer":"7.3.0-1-default","layerCount":65,"pkgManager":"zypper","repoFamily":"opensuse"},"publication":{"ref":"ghcr.io/tuna-os/sailfin:niri","repository":"ghcr.io/tuna-os/sailfin","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:8df0839c002ea101114a36dbdbd1d04ba470bc1da1f60ffe4e4ae99013b1f5b4","engineRevision":null,"indexDigest":"sha256:93e887d2cb04435f4cb4669b5fc790dca917162ccfe0594a5ebdc6b60cc7fe8f","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:7a2b159ab59919165583692e7452a1f40c06831c9288c8483076c71e3a6cc71e"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri","hardwareScope":"generic","platform":"linux/amd64","variant":"sailfin"},"targetKey":"sailfin:niri:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1784629254,"desktop":"tuna","digest":"sha256:1d35c234e210c5174b7ed7f8f9e65eec631f4acd6329deea148176894d95ba97","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"zypper","repoFamily":"opensuse"},"publication":{"ref":"ghcr.io/tuna-os/sailfin:tuna","repository":"ghcr.io/tuna-os/sailfin","tag":"tuna"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:d306062ae645b35d6745c93cf44b7ffa25510596a4af69f4f609581c11ba3046","engineRevision":null,"indexDigest":"sha256:34017524f8e2ecf018386a8ca415e333e9ccb88360c0de1bb39a2ca7a4217dca","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:1d35c234e210c5174b7ed7f8f9e65eec631f4acd6329deea148176894d95ba97"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"tuna","hardwareScope":"generic","platform":"linux/amd64","variant":"sailfin"},"targetKey":"sailfin:tuna:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1693336538,"desktop":"xfce","digest":"sha256:8c3835c7deb50d915470b231fd51291933548343d123f5c733c75b0f644c25ef","hasSdBoot":true,"kernelVer":"7.3.0-1-default","layerCount":65,"pkgManager":"zypper","repoFamily":"opensuse"},"publication":{"ref":"ghcr.io/tuna-os/sailfin:xfce","repository":"ghcr.io/tuna-os/sailfin","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:1e9b57de6c8d1e531435c32e0ce26aedd23cc1e9a46b91ff64dcff10b1d644b3","engineRevision":null,"indexDigest":"sha256:8a91cc093dfd297391e2082983db91c103d7de8728f3ab99c20d57d92f71cebe","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:8c3835c7deb50d915470b231fd51291933548343d123f5c733c75b0f644c25ef"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"sailfin"},"targetKey":"sailfin:xfce:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1531112710,"desktop":"","digest":"sha256:4ab7ef72134517925643f02ea21bf4038a8a5cc12b343012aff4caddd83ce40b","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:base-hwe","repository":"ghcr.io/tuna-os/skipjack","tag":"base-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:2122b6f81bd4d794b0dae42e7cccc0811825ffab65375960395f3c3d8780498e","engineRevision":null,"indexDigest":"sha256:c7e7056273cde9ce3e5776a2875cc3d0059180e2385910da535ce64723979db5","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:4ab7ef72134517925643f02ea21bf4038a8a5cc12b343012aff4caddd83ce40b"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"base-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:base-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1430150030,"desktop":"","digest":"sha256:aa234b57d603aec3a10da64e4df4f130234e2b0e8414709dd52c8992efecf532","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:base-hwe","repository":"ghcr.io/tuna-os/skipjack","tag":"base-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:87f8aa152ff544d1bfb50dced539cca985f051d9ec5e453241b6ab8eeefde8f7","engineRevision":null,"indexDigest":"sha256:c7e7056273cde9ce3e5776a2875cc3d0059180e2385910da535ce64723979db5","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:aa234b57d603aec3a10da64e4df4f130234e2b0e8414709dd52c8992efecf532"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"skipjack"},"targetKey":"skipjack:base-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2167918565,"desktop":"","digest":"sha256:23b4ee1df16ddf36b42634936f0f54b851fc7a3eeb8321284e7b029f24a7ef51","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:base-nvidia","repository":"ghcr.io/tuna-os/skipjack","tag":"base-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:a2639f17f263a0dddbcabfa5229f928eb364edb6659103fefacf8be666b58c06","engineRevision":null,"indexDigest":"sha256:64649f04f08793d209e88dc0e6363a9cb802b15592aed8a63c62136ea2292b3f","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:23b4ee1df16ddf36b42634936f0f54b851fc7a3eeb8321284e7b029f24a7ef51"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"base-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:base-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1497353308,"desktop":"","digest":"sha256:f678b0eb80ab1e3b264574b8af902750235dd7d147c12a1382f841de01e082a1","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:base","repository":"ghcr.io/tuna-os/skipjack","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:fdc0fc8ddcd30c506959d8abcce2db908d076b5f2a3b83abcaf080169f508f48","engineRevision":null,"indexDigest":"sha256:bcdffa2eb22fe6d6f87f7cd81066c1cf674ecf9ba3c36363f923259787e78d1c","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:f678b0eb80ab1e3b264574b8af902750235dd7d147c12a1382f841de01e082a1"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1394752193,"desktop":"","digest":"sha256:b4a7ed7c3402fe5b63cdb2dbc3bb954fe4023758a2cab4b4542c035000c14b8f","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:base","repository":"ghcr.io/tuna-os/skipjack","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:f0cf4541d0dffb54cdca1b61234b8767b4f6aebbc6213d03d04affa907f61d29","engineRevision":null,"indexDigest":"sha256:bcdffa2eb22fe6d6f87f7cd81066c1cf674ecf9ba3c36363f923259787e78d1c","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:b4a7ed7c3402fe5b63cdb2dbc3bb954fe4023758a2cab4b4542c035000c14b8f"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base","hardwareScope":"generic","platform":"linux/arm64","variant":"skipjack"},"targetKey":"skipjack:base:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1906611780,"desktop":"cosmic","digest":"sha256:189812e1f7960999db17163bade490eb4d1c91df872a6da07ec3dc9d1856ad3d","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:cosmic-hwe","repository":"ghcr.io/tuna-os/skipjack","tag":"cosmic-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:ea4af473c10d22bb0bac17a266633a3ca2f01257b860651523dbbd07d585873f","engineRevision":null,"indexDigest":"sha256:0cf4176568f0560a500f8ab24d046bc900af0c940a2a6edb4e6c0f6490cd0b88","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:189812e1f7960999db17163bade490eb4d1c91df872a6da07ec3dc9d1856ad3d"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"cosmic-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:cosmic-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2544030142,"desktop":"cosmic","digest":"sha256:5aa5126582877a642c701e39de10819d046cf965e7aad929c174dd74f0074ad7","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:cosmic-nvidia","repository":"ghcr.io/tuna-os/skipjack","tag":"cosmic-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:cb180fec2079ff35dd2f60630c0b992fbd7ea745ac156b6dd8562b93751d58d8","engineRevision":null,"indexDigest":"sha256:6d4e28461acd78122dad7d3f8f9d6d987abd2dc7b44457b321d048aa34cfffa3","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:5aa5126582877a642c701e39de10819d046cf965e7aad929c174dd74f0074ad7"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"cosmic-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:cosmic-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1906590732,"desktop":"cosmic","digest":"sha256:ad74d3d6ae8ca831c34c35bd1e3438b81e6945af82e3a6660d44007864e64886","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:cosmic","repository":"ghcr.io/tuna-os/skipjack","tag":"cosmic"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:8e0fb3ab63027c9a784820a36aaf46c6efd90a056bbbb1538637b5034aaf6624","engineRevision":null,"indexDigest":"sha256:cb24d9ce4c8f040ac2a27840a1e53ed3fc9a4620b43d33094262ab7501736d6d","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:ad74d3d6ae8ca831c34c35bd1e3438b81e6945af82e3a6660d44007864e64886"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"cosmic","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:cosmic:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1890908979,"desktop":"gnome","digest":"sha256:df6bbd10d3fa742c07747584ebc4134f3bf29441ca68afa2ad201a4123f7d04d","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:gnome-hwe","repository":"ghcr.io/tuna-os/skipjack","tag":"gnome-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:8265de03fb669b3d0960350ad80e9714c0d87008f7944c30451c7418492741c3","engineRevision":null,"indexDigest":"sha256:24001787f61a01e9a7d2b892b8e169293052483c6f9fc087881b13afbbcc5e45","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:df6bbd10d3fa742c07747584ebc4134f3bf29441ca68afa2ad201a4123f7d04d"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"gnome-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:gnome-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1890907179,"desktop":"gnome","digest":"sha256:f165ed8a06a5fad902176e65ef7c6733f2c5000d836c93bd41098e4d7409d60b","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:gnome-hwe","repository":"ghcr.io/tuna-os/skipjack","tag":"gnome-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:6329b4efc4f3962740ce4f300d273586588f9dfb3971706fc35a89345995af02","engineRevision":null,"indexDigest":"sha256:24001787f61a01e9a7d2b892b8e169293052483c6f9fc087881b13afbbcc5e45","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:f165ed8a06a5fad902176e65ef7c6733f2c5000d836c93bd41098e4d7409d60b"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"gnome-hwe","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"skipjack"},"targetKey":"skipjack:gnome-hwe:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2527740224,"desktop":"gnome","digest":"sha256:0945da2194dbb66bdbce8d945b247a74f703b3d6eaf1751e4c44c86b13ad4d57","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:gnome-nvidia","repository":"ghcr.io/tuna-os/skipjack","tag":"gnome-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:e62b8493eeaf5b8d710459cad2c86cd608685d1d6cc744a95f3e03d78a030f50","engineRevision":null,"indexDigest":"sha256:da21cb96cb5333b5687f36e763e426f5c703907308efe79241d15fe994674bee","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:0945da2194dbb66bdbce8d945b247a74f703b3d6eaf1751e4c44c86b13ad4d57"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"gnome-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:gnome-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1890696817,"desktop":"gnome","digest":"sha256:46bfc7ee3d68ac86564956062c1cb6bd5166edcd3fe2d23c95b7dc9af6cab6d1","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:gnome","repository":"ghcr.io/tuna-os/skipjack","tag":"gnome"},"qualification":{"browser":null,"browserBuildReceiptDigest":null,"buildOrigin":"browser","isoDigest":"sha256:b32774b059288a61aeaf92638daa865b96c6fa7dd1197722e53ff91443846cda","producer":{"ref":"refs/heads/main","repository":"tuna-os/iso-builder","runAttempt":2,"runId":42092360728,"sha":"b8efa6fcc9ef73fb4d040bffba51c40fd64e2a7f","workflow":".github/workflows/ci.yml"},"qualifiedAt":"2026-11-05T22:26:20Z","reason":null,"receiptDigest":"sha256:8a44c167de51a69474e1adff528d061756ac72b28cb7bee76299f00a82a95c6e","receiptImageDigest":"sha256:80f53cbc695c3f34b94554ffa5cc0dab33c474518dc8ce4b1107f0fcc25df6cf","receiptPlatform":"linux/amd64","receiptSchema":"BrowserIsoQualificationReceipt/v1","resources":null,"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:911c572dc1d2293cb924836b4da8bf5ebfde443dc0d00f2758f6a7c4660dd3ec","engineRevision":"sha256:296efe8e3f95d05ca17363d166da9e396a47958dfd07549958d460c0a1c31694","indexDigest":"sha256:8f5e1d947307417f1d292ae215b1ad4d9572d2f735109117b10aaf8180877849","installerRevision":"sha256:ff28c254d0f0c3fc303cdcd2d7cae1632a55e6f92f1f887c4c6f00559d82417b","liveOverlayBaseDigest":"sha256:80f53cbc695c3f34b94554ffa5cc0dab33c474518dc8ce4b1107f0fcc25df6cf","liveOverlayDigest":"sha256:4943a7ca67ff3791164f3c63ab0d3d447bde7fe02e3ef9f2393506482520593d","platformManifestDigest":"sha256:80f53cbc695c3f34b94554ffa5cc0dab33c474518dc8ce4b1107f0fcc25df6cf"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1890694100,"desktop":"gnome","digest":"sha256:077b1a4b0df71ebe600fd79a45bd42e450a5ecc9b240cb276f553d3623421140","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:gnome","repository":"ghcr.io/tuna-os/skipjack","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:cbf2f40d648be87cfe94161657c377e4c3e88ff6db5e1477877fa808922b62cc","engineRevision":null,"indexDigest":"sha256:3b20bfeecd2df7326cc3f515222872ff23e14d77f3b70b2da3c6d2400afbbd59","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:077b1a4b0df71ebe600fd79a45bd42e450a5ecc9b240cb276f553d3623421140"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"skipjack"},"targetKey":"skipjack:gnome:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1984663501,"desktop":"kde","digest":"sha256:53055a4ad074d665f75e67762b62a5bdb30a6518121b38dcbccd1f99470392c5","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:kde-hwe","repository":"ghcr.io/tuna-os/skipjack","tag":"kde-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:eeea050e9210a2532e7e95e641ce40989419b8af8680ebc00be4471c3e9e6062","engineRevision":null,"indexDigest":"sha256:99713eed20acad6084d110390b32af052636336889b4ebc00e49b9d4f3079bab","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:53055a4ad074d665f75e67762b62a5bdb30a6518121b38dcbccd1f99470392c5"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"kde-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:kde-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1876595548,"desktop":"kde","digest":"sha256:8a8d69f8f1f41931676f3ee6bc0ddb2949e6854def056a59d1e6d1254a281c20","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:kde-hwe","repository":"ghcr.io/tuna-os/skipjack","tag":"kde-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:2bfa9912c74e10c67c5e8b8e80ba73139129d9b9cd0b8af982fa5cddc9044c7f","engineRevision":null,"indexDigest":"sha256:99713eed20acad6084d110390b32af052636336889b4ebc00e49b9d4f3079bab","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:8a8d69f8f1f41931676f3ee6bc0ddb2949e6854def056a59d1e6d1254a281c20"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"kde-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"skipjack"},"targetKey":"skipjack:kde-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2621959858,"desktop":"kde","digest":"sha256:75ad16ed666cd6186667ddf895479919fff586ae96b36c8df0a9636ac642cdf0","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:kde-nvidia","repository":"ghcr.io/tuna-os/skipjack","tag":"kde-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:fdd960f3003117b1674a773341cec118a7e5fae7e79bb9db4df994bdb681e611","engineRevision":null,"indexDigest":"sha256:ad88a2b6ad4f0ac29dabfb731860f12d1a46420fa18bd9f8ae3ae3a3d8d4e650","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:75ad16ed666cd6186667ddf895479919fff586ae96b36c8df0a9636ac642cdf0"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"kde-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:kde-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1984606572,"desktop":"kde","digest":"sha256:65341b408ba1f9444c9a5c0b6444bd6b05ea247eab0f81c793eb40397f01e064","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:kde","repository":"ghcr.io/tuna-os/skipjack","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:40fac03ed3fdbca184378780a98dd55826cfe1e16d53642984e021cfea545777","engineRevision":null,"indexDigest":"sha256:bebd393550e6d2c2e7b6fb8106c26f3520bc803a879412ae48314a92e42b4d14","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:65341b408ba1f9444c9a5c0b6444bd6b05ea247eab0f81c793eb40397f01e064"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1876615962,"desktop":"kde","digest":"sha256:c70be423e53e2f0fe2fb520396b62ad6cc0c5e8d9433a920b2e6b21135ca7db6","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:kde","repository":"ghcr.io/tuna-os/skipjack","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:d404be2498383567f9b4a3650366701fa732acb1c40aa9dde8087078f998ee7f","engineRevision":null,"indexDigest":"sha256:bebd393550e6d2c2e7b6fb8106c26f3520bc803a879412ae48314a92e42b4d14","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:c70be423e53e2f0fe2fb520396b62ad6cc0c5e8d9433a920b2e6b21135ca7db6"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"kde","hardwareScope":"generic","platform":"linux/arm64","variant":"skipjack"},"targetKey":"skipjack:kde:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1773500019,"desktop":"niri","digest":"sha256:9412f02bb089b054f258950d7db79f5b23645cbf15e705b9e77f89dec45c493f","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:niri-hwe","repository":"ghcr.io/tuna-os/skipjack","tag":"niri-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:8dae273056ac98f4e59f243ae93ad053452966f13ad15daf029d29d551597d14","engineRevision":null,"indexDigest":"sha256:b0c73b3a50b2234095c9f15a455af630d044d45c4427056022f8a00e90df272a","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:9412f02bb089b054f258950d7db79f5b23645cbf15e705b9e77f89dec45c493f"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"niri-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:niri-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1659619192,"desktop":"niri","digest":"sha256:3226c2bab692592f8dec599c0075368be101500e35cd3c0efbe3821b7f34eff6","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:niri-hwe","repository":"ghcr.io/tuna-os/skipjack","tag":"niri-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:4d61edea92e849fc87578dfd2b986095bcdfa10eb173791632875545e14d6c17","engineRevision":null,"indexDigest":"sha256:b0c73b3a50b2234095c9f15a455af630d044d45c4427056022f8a00e90df272a","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:3226c2bab692592f8dec599c0075368be101500e35cd3c0efbe3821b7f34eff6"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"niri-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"skipjack"},"targetKey":"skipjack:niri-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2409877820,"desktop":"niri","digest":"sha256:0538b5c7323abcffa4edda22146d432357dd002b521f6d93d05f3bb7b313d02f","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:niri-nvidia","repository":"ghcr.io/tuna-os/skipjack","tag":"niri-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:19db74f6933d0fec051c90f04d1ee3ee521b77a1f4fe9be71414f6a1a2147f5d","engineRevision":null,"indexDigest":"sha256:a2931c8c306bd87af98a2132e09c1777d3e124bf8584710e8193d82ab809715a","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:0538b5c7323abcffa4edda22146d432357dd002b521f6d93d05f3bb7b313d02f"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"niri-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:niri-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1773510682,"desktop":"niri","digest":"sha256:24cb44856243a926905b74b6f87b128b5f9103fd87952396082f0a31164221a1","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:niri","repository":"ghcr.io/tuna-os/skipjack","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:4087531849c4210c72e763586d47eaae8529b1ad99dc0d3e62be2fe40816b029","engineRevision":null,"indexDigest":"sha256:96176de6907dab7f46e65cd6bc427d98e80ee89b77b9a1807cb213d0de10d22a","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:24cb44856243a926905b74b6f87b128b5f9103fd87952396082f0a31164221a1"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"niri","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:niri:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1659678641,"desktop":"niri","digest":"sha256:67938ceafc8b28fcbcb2a705ef10e534260bcbba1db1a6c4c5f43b47ff122886","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:niri","repository":"ghcr.io/tuna-os/skipjack","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:2117fcb39e48921e209ba05b0d72b020049d39446c8936b2e863c0b99720354b","engineRevision":null,"indexDigest":"sha256:96176de6907dab7f46e65cd6bc427d98e80ee89b77b9a1807cb213d0de10d22a","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:67938ceafc8b28fcbcb2a705ef10e534260bcbba1db1a6c4c5f43b47ff122886"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"niri","hardwareScope":"generic","platform":"linux/arm64","variant":"skipjack"},"targetKey":"skipjack:niri:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1706344987,"desktop":"tuna","digest":"sha256:b71d0682f4f9a7ae79f4660031df3f67bd30b0f5959c6c46077c0f8751ae4708","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:tuna","repository":"ghcr.io/tuna-os/skipjack","tag":"tuna"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:0033a941416fffca1b453023bc69ebf0fb63ba4df64b1238443b2e9ed1a769e2","engineRevision":null,"indexDigest":"sha256:81ac5170211e0dd2aaae01d2549b7aea0c18c23b5801fabdf1aef34a0317984b","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:b71d0682f4f9a7ae79f4660031df3f67bd30b0f5959c6c46077c0f8751ae4708"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"tuna","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:tuna:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1569890698,"desktop":"xfce","digest":"sha256:225175dc69a3de3441d169e9d800aa3e858fa38fe9e0b1972a77300a338cd0f8","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:xfce","repository":"ghcr.io/tuna-os/skipjack","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:7ab9f18158bc86b83cef81ce57eab69f1f3d8076b7f98c11ee700a1931a4ef4e","engineRevision":null,"indexDigest":"sha256:645eaa93707a2b24cad21fea459d8e645bef2489f4c5c04cb5cfe8c45b8eb797","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:225175dc69a3de3441d169e9d800aa3e858fa38fe9e0b1972a77300a338cd0f8"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:xfce:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1672457116,"desktop":"","digest":"sha256:a17071371a3d986708606d08a3d74e41d0573bcdf949c4429c7d083eab678cb2","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/wahoo:base","repository":"ghcr.io/tuna-os/wahoo","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:345eefbda94dfd6ae8ff4b497b767384e7d6bd9e95f3cc1b7850ca2f0f7238e5","engineRevision":null,"indexDigest":"sha256:0e7b2afd52f4cf85b2358b283c6ef28ca26994d4e9697d65b16c699e3b87a1b5","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:a17071371a3d986708606d08a3d74e41d0573bcdf949c4429c7d083eab678cb2"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"wahoo"},"targetKey":"wahoo:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1491655859,"desktop":"","digest":"sha256:6fdd66eda5069fce567208fb568ee55eb247851cf6c63e3d481cc123d27e0bc9","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/wahoo:base","repository":"ghcr.io/tuna-os/wahoo","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:1e584b74147e2ecb1427d7a9bafe1e4d0b6923ff3e9ee252484c4ea8e570a05d","engineRevision":null,"indexDigest":"sha256:0e7b2afd52f4cf85b2358b283c6ef28ca26994d4e9697d65b16c699e3b87a1b5","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:6fdd66eda5069fce567208fb568ee55eb247851cf6c63e3d481cc123d27e0bc9"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base","hardwareScope":"generic","platform":"linux/arm64","variant":"wahoo"},"targetKey":"wahoo:base:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2102155786,"desktop":"cosmic","digest":"sha256:819931bfff17db7e3d0c60c20706b98b8732c96f0f95d3fd26a19b9174a9ec47","hasSdBoot":false,"kernelVer":"7.3.0-0.rc0.260818g0f23d56f17fd.3.eln159.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/wahoo:cosmic","repository":"ghcr.io/tuna-os/wahoo","tag":"cosmic"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:ae9ff3049459d0ce95ad474933aa37c66e349764a63894d3cb216bf427d5585c","engineRevision":null,"indexDigest":"sha256:cc20ba1d9f00c5d35a1e2162badb3269efce45bc495a0e0b4fbb569ed354f1e0","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:819931bfff17db7e3d0c60c20706b98b8732c96f0f95d3fd26a19b9174a9ec47"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"cosmic","hardwareScope":"generic","platform":"linux/amd64","variant":"wahoo"},"targetKey":"wahoo:cosmic:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1906913472,"desktop":"cosmic","digest":"sha256:b21c469bdbff9e662b6e9ded92ba561f0322d629827af8cca4c4feb88fda0386","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/wahoo:cosmic","repository":"ghcr.io/tuna-os/wahoo","tag":"cosmic"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:a2fcf50a8de8fab01d4259cb3b198d4e9e03d06f72292ccbc5544dfc09cca998","engineRevision":null,"indexDigest":"sha256:cc20ba1d9f00c5d35a1e2162badb3269efce45bc495a0e0b4fbb569ed354f1e0","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:b21c469bdbff9e662b6e9ded92ba561f0322d629827af8cca4c4feb88fda0386"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"cosmic","hardwareScope":"generic","platform":"linux/arm64","variant":"wahoo"},"targetKey":"wahoo:cosmic:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2045915937,"desktop":"gnome","digest":"sha256:c3f999e5044ab4a9302435500b1d1dbe0c4e9911b7703ca320057a2e37dd6d7b","hasSdBoot":false,"kernelVer":"7.3.0-0.rc0.260818g0f23d56f17fd.3.eln159.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/wahoo:gnome","repository":"ghcr.io/tuna-os/wahoo","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:f6b08d05265889f933c5479cbebe915940150edd4caa8a613c549d68bf0f885d","engineRevision":null,"indexDigest":"sha256:e4d20fcba364559ad173368c7d6f40574ead0fbea740dd9c09bb1409efe86344","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:c3f999e5044ab4a9302435500b1d1dbe0c4e9911b7703ca320057a2e37dd6d7b"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"wahoo"},"targetKey":"wahoo:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1858709118,"desktop":"gnome","digest":"sha256:7c70f5d17221eec275fdc027704a056543cf6911f6b1c07383c4258f67172d1c","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/wahoo:gnome","repository":"ghcr.io/tuna-os/wahoo","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:f6a55ed21c69da66ab82cfb2642dedb6d1e80f85471e4fb21d64350604140cd1","engineRevision":null,"indexDigest":"sha256:e4d20fcba364559ad173368c7d6f40574ead0fbea740dd9c09bb1409efe86344","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:7c70f5d17221eec275fdc027704a056543cf6911f6b1c07383c4258f67172d1c"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome","hardwareScope":"generic","platform":"linux/arm64","variant":"wahoo"},"targetKey":"wahoo:gnome:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2994797655,"desktop":"kde","digest":"sha256:04cc186adb99a0a495045d0548e709ff2503a2168517988fc824d05a8f3831bc","hasSdBoot":false,"kernelVer":"7.3.0-0.rc0.260818g0f23d56f17fd.3.eln159.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/wahoo:kde","repository":"ghcr.io/tuna-os/wahoo","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:be72194956f90eba686272341daf4d77b65fee093d54ad0cfb79a7920a39ea61","engineRevision":null,"indexDigest":"sha256:565a6efef2b39c735b9eefdd7d06baab152e3b706ed09704473faf50ce48e801","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:04cc186adb99a0a495045d0548e709ff2503a2168517988fc824d05a8f3831bc"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"wahoo"},"targetKey":"wahoo:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2771868592,"desktop":"kde","digest":"sha256:a57c8c68d114e493d45ea776e261931f2089a7c7f2057f46b0a6948dce6a0ccd","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/wahoo:kde","repository":"ghcr.io/tuna-os/wahoo","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:f9e8e5c81391bc52f7c2f6e3dd76898ce1eb6dc17b0dff7667e3974c1b84e273","engineRevision":null,"indexDigest":"sha256:565a6efef2b39c735b9eefdd7d06baab152e3b706ed09704473faf50ce48e801","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:a57c8c68d114e493d45ea776e261931f2089a7c7f2057f46b0a6948dce6a0ccd"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"kde","hardwareScope":"generic","platform":"linux/arm64","variant":"wahoo"},"targetKey":"wahoo:kde:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1865745274,"desktop":"tuna","digest":"sha256:3d05e36068199cdf8f2e8bba00f79fc220b51aa2eec0ab448d036f026fa90ad8","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/wahoo:tuna","repository":"ghcr.io/tuna-os/wahoo","tag":"tuna"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:8155db6b63bdc7fc7be697c2ff8f158f6300eacf70001d361de6b12b00c73791","engineRevision":null,"indexDigest":"sha256:865ec5320f25ae368316f07b4d3b49b5e0600308e5bc50b973ace90a5b53a46d","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:3d05e36068199cdf8f2e8bba00f79fc220b51aa2eec0ab448d036f026fa90ad8"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"tuna","hardwareScope":"generic","platform":"linux/amd64","variant":"wahoo"},"targetKey":"wahoo:tuna:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1506837259,"desktop":"","digest":"sha256:428dc62983339a8ed1d004fd007ba16cbb5e061150494ba0ed050e3821dcb70d","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:base-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"base-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:101c10d3f9c91a01b7f0cb6d4ccb3a2bb85592e46a26bf9beed5223887702edf","engineRevision":null,"indexDigest":"sha256:83fc053ad35fcd412cb741e0bc213d842d35c48160c09cbfcb1dc66e5c567d5e","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:428dc62983339a8ed1d004fd007ba16cbb5e061150494ba0ed050e3821dcb70d"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:base-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1504638665,"desktop":"","digest":"sha256:e70c79875d13c2d6711eb3d671be6a14546f6edef7787b61c462dff9915ae271","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:base-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"base-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:894cedf5a3eb12de07197aded9971db78c9add6e0051fa49123915637a232f08","engineRevision":null,"indexDigest":"sha256:83fc053ad35fcd412cb741e0bc213d842d35c48160c09cbfcb1dc66e5c567d5e","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:e70c79875d13c2d6711eb3d671be6a14546f6edef7787b61c462dff9915ae271"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"base-hwe","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"yellowfin"},"targetKey":"yellowfin:base-hwe:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1411908559,"desktop":"","digest":"sha256:6107e2dab93c2123ff5bbe3f76c6d3810cbafafd33e49c34880821ed814f6110","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:base-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"base-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:2012d1aa29b43ec48403d628c760888f3cdf333f222b8940068175bd2d0e7cec","engineRevision":null,"indexDigest":"sha256:83fc053ad35fcd412cb741e0bc213d842d35c48160c09cbfcb1dc66e5c567d5e","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:6107e2dab93c2123ff5bbe3f76c6d3810cbafafd33e49c34880821ed814f6110"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"yellowfin"},"targetKey":"yellowfin:base-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2212187336,"desktop":"","digest":"sha256:430e27e609b3571662f636fe5781dcaf434b0b05b34e0934e167119858ab5119","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:base-nvidia","repository":"ghcr.io/tuna-os/yellowfin","tag":"base-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:c91feb5cf55e84449a61db659641e34ae7cb835f09d24f7a58e3309f5d2c9466","engineRevision":null,"indexDigest":"sha256:91ff0df383c28d15e0047a71f3d5bb3b9b06e00ae7721cbde4da4944e49cb7b0","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:430e27e609b3571662f636fe5781dcaf434b0b05b34e0934e167119858ab5119"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:base-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1473370009,"desktop":"","digest":"sha256:cc088e462c699fae0dbc49de1e6ecfb6eeb515f23c1009af9b63669171282146","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:base","repository":"ghcr.io/tuna-os/yellowfin","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:375db592432bd5d2e3e025ddd2c7a5d98d06ad45b9ad87063b5275c62d6284b4","engineRevision":null,"indexDigest":"sha256:cfad305181dfd2ad8abbeec53b1baa8780a9bde88adef5554871dab6e3214ffc","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:cc088e462c699fae0dbc49de1e6ecfb6eeb515f23c1009af9b63669171282146"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1472415689,"desktop":"","digest":"sha256:f4cf342edd1f493c43c721385ee57ebcf6d53126dbc82554a389df6956e70b3f","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:base","repository":"ghcr.io/tuna-os/yellowfin","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:b6c09b40d0176edffc72d78942257527064d7ee89e450f5f23b231353d0a9524","engineRevision":null,"indexDigest":"sha256:cfad305181dfd2ad8abbeec53b1baa8780a9bde88adef5554871dab6e3214ffc","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:f4cf342edd1f493c43c721385ee57ebcf6d53126dbc82554a389df6956e70b3f"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"base","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"yellowfin"},"targetKey":"yellowfin:base:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1374000075,"desktop":"","digest":"sha256:ee59ac8c33d68e23003bfe83d46f6cfd59cdd919fc8a198bf22800f75b959a02","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:base","repository":"ghcr.io/tuna-os/yellowfin","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:b0c4ad6e12c8692cfa7e1a10061c4a95bbec71078da286cb4f23b5c5c530e366","engineRevision":null,"indexDigest":"sha256:cfad305181dfd2ad8abbeec53b1baa8780a9bde88adef5554871dab6e3214ffc","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:ee59ac8c33d68e23003bfe83d46f6cfd59cdd919fc8a198bf22800f75b959a02"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base","hardwareScope":"generic","platform":"linux/arm64","variant":"yellowfin"},"targetKey":"yellowfin:base:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1883335432,"desktop":"cosmic","digest":"sha256:cd6b551f77934fcb42409f22f3c0967b13a7b16c5df6a174113ef26be33aeab6","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:cosmic-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"cosmic-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:352c284f8b1fdbb89c3e411dd275a0a815cc45bbfe9709628c3de4f214475d8c","engineRevision":null,"indexDigest":"sha256:d4e9f8d2da5cebe4eef5acebef126ea845d46630b85c6594cf36ca9b626130ea","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:cd6b551f77934fcb42409f22f3c0967b13a7b16c5df6a174113ef26be33aeab6"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:cosmic-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2589764791,"desktop":"cosmic","digest":"sha256:eef06d4055b51cb2eb7eb5d11bf94d415cfa410964fa30057e3ce3b60704c53b","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:cosmic-nvidia","repository":"ghcr.io/tuna-os/yellowfin","tag":"cosmic-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:42729dbed980a0a6645729f8546145768ac97063e1642b05f2250862e98c6385","engineRevision":null,"indexDigest":"sha256:1bd58f3fc1bb34d7a1e6cfac5b7c82069fbf5ad573a27d101bdcedf42a66fe19","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:eef06d4055b51cb2eb7eb5d11bf94d415cfa410964fa30057e3ce3b60704c53b"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:cosmic-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1883298154,"desktop":"cosmic","digest":"sha256:f8363376656f1bdd3c42897052728ae2beaa91d5f5a92621e7571de80586ddf3","hasSdBoot":false,"kernelVer":"6.12.0-279.el10.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:cosmic","repository":"ghcr.io/tuna-os/yellowfin","tag":"cosmic"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:dc65df65e76e226268f47337c2bb2e7e9dd0cfd5e248d348e977e895b950e661","engineRevision":null,"indexDigest":"sha256:82248d958ffe928d155079e361eb42e6582a749be1bb146aab4ed85aff686220","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:f8363376656f1bdd3c42897052728ae2beaa91d5f5a92621e7571de80586ddf3"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:cosmic:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1866267630,"desktop":"gnome","digest":"sha256:77ef8fd11a6f4f3f67e038e94963fd9cd62052a04c9d730b1465d4ec4f7bbb6b","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:gnome-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"gnome-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:ca5336016ed8feddd08dba9aec1ab6b6ca622df016ec22a19a5b0d6206a360f7","engineRevision":null,"indexDigest":"sha256:296c157669fc873e72b4849b13468d57973973d7ee201b0e13e87c8ae0ff577c","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:77ef8fd11a6f4f3f67e038e94963fd9cd62052a04c9d730b1465d4ec4f7bbb6b"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:gnome-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1863502120,"desktop":"gnome","digest":"sha256:4a2feab9e619fde98fa45a29aac359269269cf2ea4d2572a2fc3ce43d6e6b881","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:gnome-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"gnome-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:75c6b1e43c2c1c20283d9a11df04df2b1503e66732cbd3b04d5c12675c18f1b6","engineRevision":null,"indexDigest":"sha256:296c157669fc873e72b4849b13468d57973973d7ee201b0e13e87c8ae0ff577c","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:4a2feab9e619fde98fa45a29aac359269269cf2ea4d2572a2fc3ce43d6e6b881"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"gnome-hwe","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"yellowfin"},"targetKey":"yellowfin:gnome-hwe:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2565233640,"desktop":"gnome","digest":"sha256:3c62a636c41d71ebe80afb356e139ceaec43e98c15f894aa9a4c90b3f71bbb15","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:gnome-nvidia","repository":"ghcr.io/tuna-os/yellowfin","tag":"gnome-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:9fa458013ee41ea86307c2281805afd7b89b6360cb416209180c8e51e1c9b444","engineRevision":null,"indexDigest":"sha256:d05479e14e9d6d15f2ae51894cadff2384a437d631ab7f553510df1f2e8f02cd","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:3c62a636c41d71ebe80afb356e139ceaec43e98c15f894aa9a4c90b3f71bbb15"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:gnome-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1866266386,"desktop":"gnome","digest":"sha256:ebd81c8293f9e6be72277533c0d5d62d767c9d162a25dc231a947388e4a26a49","hasSdBoot":false,"kernelVer":"6.12.0-279.el10.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:gnome","repository":"ghcr.io/tuna-os/yellowfin","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:78ef4ed94cd28c10bcab62f9357b10c174dee076fddb37b5842ec0dcd8eaf91e","engineRevision":null,"indexDigest":"sha256:3f15169960df4cf2805883bbf1729f1907a07a4ad3a0dfe2bb3a947c37a9c4a7","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:ebd81c8293f9e6be72277533c0d5d62d767c9d162a25dc231a947388e4a26a49"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1863546483,"desktop":"gnome","digest":"sha256:2f640ce376672484fdc5092e73431b4c4224a6c691eb43fe5de4bfd2d0d3cf65","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:gnome","repository":"ghcr.io/tuna-os/yellowfin","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:db1c1d78ffa1912edd6bd6fafa1e91d430948db8224d9bc7137aaae0d44b432f","engineRevision":null,"indexDigest":"sha256:3f15169960df4cf2805883bbf1729f1907a07a4ad3a0dfe2bb3a947c37a9c4a7","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:2f640ce376672484fdc5092e73431b4c4224a6c691eb43fe5de4bfd2d0d3cf65"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"yellowfin"},"targetKey":"yellowfin:gnome:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1960610866,"desktop":"kde","digest":"sha256:18df2ba54d371ce20f8b7035ca5339d70095d88c262766988db2eab62279ae2b","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:kde-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"kde-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:8cac37d690a884d70caf852585ad684215d38c7df69bd6f817b7af151c5c224c","engineRevision":null,"indexDigest":"sha256:8a6dcbf3695700050a099ff07acd457aab331e053eaee45e688127763ccce8f8","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:18df2ba54d371ce20f8b7035ca5339d70095d88c262766988db2eab62279ae2b"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:kde-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1956299386,"desktop":"kde","digest":"sha256:7bc7fdbd674928a2967dc69ffd87272b8800fdfc37e3833d03919789566cfbc0","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:kde-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"kde-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:42a6c6ad2f342ab0877a067fd4ceb32a9db33cdb828095e9b0d691e684056045","engineRevision":null,"indexDigest":"sha256:8a6dcbf3695700050a099ff07acd457aab331e053eaee45e688127763ccce8f8","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:7bc7fdbd674928a2967dc69ffd87272b8800fdfc37e3833d03919789566cfbc0"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"kde-hwe","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"yellowfin"},"targetKey":"yellowfin:kde-hwe:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1857788447,"desktop":"kde","digest":"sha256:a7b37a5316bfe21e067f057e7fd0229127870045ddbb219370887d078a79abb0","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:kde-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"kde-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:045c98cd64fd61462ea0237fb989ae07a0edf89c73681b15cfea9bde230d0d2d","engineRevision":null,"indexDigest":"sha256:8a6dcbf3695700050a099ff07acd457aab331e053eaee45e688127763ccce8f8","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:a7b37a5316bfe21e067f057e7fd0229127870045ddbb219370887d078a79abb0"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"kde-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"yellowfin"},"targetKey":"yellowfin:kde-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2659323502,"desktop":"kde","digest":"sha256:cd46d1031a9747b6e2155e6ce9e074b7c6e09c04d32ecf2630056defffb1022b","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:kde-nvidia","repository":"ghcr.io/tuna-os/yellowfin","tag":"kde-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:de326a135751e34290adc033f36d7d7defd6d9a9395d03d5740c86debd6f5521","engineRevision":null,"indexDigest":"sha256:260e931d269f5cadcb563a8441bbc92fbd0c91d40c03639534a4a9c2e4197494","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:cd46d1031a9747b6e2155e6ce9e074b7c6e09c04d32ecf2630056defffb1022b"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:kde-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1960621902,"desktop":"kde","digest":"sha256:cd0cfbde9483dd7b602111ed7071203af6c7f3ca7e1888afb568f99428d4ea07","hasSdBoot":false,"kernelVer":"6.12.0-279.el10.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:kde","repository":"ghcr.io/tuna-os/yellowfin","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:0fbe4ed2d4b7c99e7f1307879f9b5351feabe48ca3c2ed1a1344e051bb3db754","engineRevision":null,"indexDigest":"sha256:dc0b3b6d9028202e89591d5d2079974ccd9a7d15e71987846a4260670881bf00","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:cd0cfbde9483dd7b602111ed7071203af6c7f3ca7e1888afb568f99428d4ea07"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1956346114,"desktop":"kde","digest":"sha256:698e3854ec084023731a4b949640e59cfb74b0603bdf63598013745d605f05bf","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:kde","repository":"ghcr.io/tuna-os/yellowfin","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:d406756386f3d7055abc18c099116ef4dccd2a27f0db4ce45fb28bdc9baf94a0","engineRevision":null,"indexDigest":"sha256:dc0b3b6d9028202e89591d5d2079974ccd9a7d15e71987846a4260670881bf00","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:698e3854ec084023731a4b949640e59cfb74b0603bdf63598013745d605f05bf"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"yellowfin"},"targetKey":"yellowfin:kde:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1857794513,"desktop":"kde","digest":"sha256:8906312aed9abb90ec2323231fb8071671d5252eef31eed5e73584c5eca41ae2","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:kde","repository":"ghcr.io/tuna-os/yellowfin","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:39713ad576091834493e5d1dc00c1ae930131f092a657f74100e2c182c08c0b2","engineRevision":null,"indexDigest":"sha256:dc0b3b6d9028202e89591d5d2079974ccd9a7d15e71987846a4260670881bf00","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:8906312aed9abb90ec2323231fb8071671d5252eef31eed5e73584c5eca41ae2"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"kde","hardwareScope":"generic","platform":"linux/arm64","variant":"yellowfin"},"targetKey":"yellowfin:kde:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1749754340,"desktop":"niri","digest":"sha256:4362b7c2d9eb5c518c374532bcfbb2921ecaac6e4eabcbfb1ec125e06ed2e693","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:niri-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"niri-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:61ecc85e3264938baf16040262683982715e03bd5c1f666a934a650a31b24d9d","engineRevision":null,"indexDigest":"sha256:839c0194327a6401c7f772e87ff26a0e1d6d5eb4f5b14d07d5d84250f1378125","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:4362b7c2d9eb5c518c374532bcfbb2921ecaac6e4eabcbfb1ec125e06ed2e693"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:niri-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1758712818,"desktop":"niri","digest":"sha256:c82f9e39f078ab5d2f82f101d5e615e803c33be3fe54dc13ea9ac828e440d5a2","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:niri-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"niri-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:2c588bfbe793fbe9858f8c1ff1870adb6b40498e3052b74b2f9d2e653eeca767","engineRevision":null,"indexDigest":"sha256:839c0194327a6401c7f772e87ff26a0e1d6d5eb4f5b14d07d5d84250f1378125","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:c82f9e39f078ab5d2f82f101d5e615e803c33be3fe54dc13ea9ac828e440d5a2"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"niri-hwe","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"yellowfin"},"targetKey":"yellowfin:niri-hwe:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1640832152,"desktop":"niri","digest":"sha256:ed5278157805731ac8a12fdeff71d6594c99a4d7d57677d1528338160e85b9e5","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:niri-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"niri-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:d3b0740545fe64d73cd515957c52c02c80bb414c3775709b565476cdc0aff0a0","engineRevision":null,"indexDigest":"sha256:839c0194327a6401c7f772e87ff26a0e1d6d5eb4f5b14d07d5d84250f1378125","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:ed5278157805731ac8a12fdeff71d6594c99a4d7d57677d1528338160e85b9e5"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"niri-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"yellowfin"},"targetKey":"yellowfin:niri-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2454934463,"desktop":"niri","digest":"sha256:054ccbea4434e20d80e2822c821d6a46d5ad9816c7ab23278791198832e89f59","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:niri-nvidia","repository":"ghcr.io/tuna-os/yellowfin","tag":"niri-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:5d26447cc969cb7ff1ddc6840a50fb3e04336dda192defa6505c4233eecf9cbf","engineRevision":null,"indexDigest":"sha256:1245b503efe3fbd1bae685e98c78500bda2f7e6262f0d5eed412eca391f37d28","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:054ccbea4434e20d80e2822c821d6a46d5ad9816c7ab23278791198832e89f59"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:niri-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1749775718,"desktop":"niri","digest":"sha256:92700229f11582446be6c51dea51b59ff46958c1108e41f7b6199b4da57bcdd6","hasSdBoot":false,"kernelVer":"6.12.0-279.el10.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:niri","repository":"ghcr.io/tuna-os/yellowfin","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:70ebf7d48369ec269a064b9916b2685331019d60d419e90251b218895cd004fe","engineRevision":null,"indexDigest":"sha256:d3ed4108bac6d1f7626a10239a88b09bb233a5c347bfe8b2fc3c34c4e8c33aa6","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:92700229f11582446be6c51dea51b59ff46958c1108e41f7b6199b4da57bcdd6"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:niri:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1758746702,"desktop":"niri","digest":"sha256:b463f42fd30f69a19e1340b1c4b2f50f02f2ea08359ecf732190e9012f5219c9","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:niri","repository":"ghcr.io/tuna-os/yellowfin","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:3d58094ce477c2a3db2304039960e30e55228c711e0f1d87d004290fa2466d0b","engineRevision":null,"indexDigest":"sha256:d3ed4108bac6d1f7626a10239a88b09bb233a5c347bfe8b2fc3c34c4e8c33aa6","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:b463f42fd30f69a19e1340b1c4b2f50f02f2ea08359ecf732190e9012f5219c9"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"niri","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"yellowfin"},"targetKey":"yellowfin:niri:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1640729954,"desktop":"niri","digest":"sha256:99c1eae7bcee3016d5db35b4acd34eb7bf05a9f36c1cb8b0d60f0e403147b928","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:niri","repository":"ghcr.io/tuna-os/yellowfin","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:28e6c36db5169111545fce836cfb885adc05b2cc26503ea7eb8d4a443bb96039","engineRevision":null,"indexDigest":"sha256:d3ed4108bac6d1f7626a10239a88b09bb233a5c347bfe8b2fc3c34c4e8c33aa6","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:99c1eae7bcee3016d5db35b4acd34eb7bf05a9f36c1cb8b0d60f0e403147b928"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"niri","hardwareScope":"generic","platform":"linux/arm64","variant":"yellowfin"},"targetKey":"yellowfin:niri:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1682878928,"desktop":"tuna","digest":"sha256:61123b4a7c24a841ee221d3bfea0f658e00ab545bdec0a63c93294cc5acbb619","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:tuna","repository":"ghcr.io/tuna-os/yellowfin","tag":"tuna"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:a9d82c6cc58caac32f113dad6ef96297c500deb111c2b210d2fb1edac34d14ca","engineRevision":null,"indexDigest":"sha256:11350b8da2cd2e2c7f7eaffde474ec63a243afdc3482c228c7323e7c191f5687","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:61123b4a7c24a841ee221d3bfea0f658e00ab545bdec0a63c93294cc5acbb619"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"tuna","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:tuna:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1546489198,"desktop":"xfce","digest":"sha256:ef82fed2ff47e40a8029624e8493b5b3a19ad71f26de9ebea2e90825cccda6c8","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:xfce-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"xfce-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:a37036839350db9062cade3e26fdd7ca911283f59889680f6a8d392e5759e366","engineRevision":null,"indexDigest":"sha256:60469a3338aeea38a2c57ed20fd0ce46384c51d55690f8dc863e98e19f3706fd","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:ef82fed2ff47e40a8029624e8493b5b3a19ad71f26de9ebea2e90825cccda6c8"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:xfce-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1547642982,"desktop":"xfce","digest":"sha256:3a9e94d900ee0d6fd8ca8018854304e770888b8fbe530f4d1484b6a6ef6ba61f","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:xfce-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"xfce-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:2f988870f8572b9520e077a2604fe609ec462f2991d0f67b1fa3d746241f25fd","engineRevision":null,"indexDigest":"sha256:60469a3338aeea38a2c57ed20fd0ce46384c51d55690f8dc863e98e19f3706fd","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:3a9e94d900ee0d6fd8ca8018854304e770888b8fbe530f4d1484b6a6ef6ba61f"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"xfce-hwe","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"yellowfin"},"targetKey":"yellowfin:xfce-hwe:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2251309785,"desktop":"xfce","digest":"sha256:63cd524d3319e4b8f59b1b5d7d1e0977df947e1803d16de67c48823d9926c422","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:xfce-nvidia","repository":"ghcr.io/tuna-os/yellowfin","tag":"xfce-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:4d982055d0b8d84fd26ebc7ef7aa22fb5732c3afd50d79215a46a1c50533fcaa","engineRevision":null,"indexDigest":"sha256:900a17b137e1f9cbcc31f0343a29b6a59192670136e8f2449c15cd0eab6deb59","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:63cd524d3319e4b8f59b1b5d7d1e0977df947e1803d16de67c48823d9926c422"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:xfce-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1546491242,"desktop":"xfce","digest":"sha256:f0c42de8ee306f837953aa375898add33e295a58fe19729f59bbd6cb87541e62","hasSdBoot":false,"kernelVer":"6.12.0-279.el10.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:xfce","repository":"ghcr.io/tuna-os/yellowfin","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:56b29543daad41b202adf90a92a955199a247caef037263955403b915cef8012","engineRevision":null,"indexDigest":"sha256:e8d5414c04137b9797d393b04e64941c8848643bfd9997d44103c9caf9ac6766","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:f0c42de8ee306f837953aa375898add33e295a58fe19729f59bbd6cb87541e62"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:xfce:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1547621940,"desktop":"xfce","digest":"sha256:e18616e2a745794861e32b73fae565eb9634dc5ec18cf59f0b298e0e0b92c39e","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:xfce","repository":"ghcr.io/tuna-os/yellowfin","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:80e8c94fd3b07afc9723178f89d9ad033c3113639e655819a630dcf10882e3a4","engineRevision":null,"indexDigest":"sha256:e8d5414c04137b9797d393b04e64941c8848643bfd9997d44103c9caf9ac6766","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:e18616e2a745794861e32b73fae565eb9634dc5ec18cf59f0b298e0e0b92c39e"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"yellowfin"},"targetKey":"yellowfin:xfce:linux/amd64/v2"}]};

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

// `purebuild` is its own Go program in the tacklebox module, not a `tacklebox`
// subcommand: `tacklebox purebuild` does not exist. `go run` fetches and runs it.
const PUREBUILD_COMMAND = "go run github.com/tuna-os/tacklebox/cmd/purebuild@latest --request build-request.json";
const PUREBUILD_STEPS = "Save build-request.json, then run the command in the same folder (needs Go 1.26 or newer and access to the image registry). The ISO is written to ./tunaos-pure.iso.";
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
        renderFallbackCard(op, `${msg} Build this exact target on your own machine instead.`);
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

const NATIVE_V3_VARIANTS = new Set(["skipjack", "wahoo"]);
const VALID_PLATFORMS = new Set(["linux/amd64", "linux/amd64/v2", "linux/amd64/v3", "linux/arm64"]);

// linux/amd64 is the platform a qualification receipt covers. The Alma
// x86-64-v2 builds stay selectable by explicit choice.
function defaultPlatformForVariant() {
  return "linux/amd64";
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
  const cmd = PUREBUILD_COMMAND;
  if ($("fallbackcmd")) $("fallbackcmd").textContent = cmd;
  if ($("fallbackjson")) $("fallbackjson").textContent = reqJson;
  if ($("fallbackreason")) {
    $("fallbackreason").textContent = reasonText
      ? `${reasonText} ${PUREBUILD_STEPS}`
      : `Build this exact target locally, without browser memory or storage limits. ${PUREBUILD_STEPS}`;
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
      renderFallbackCard(op, `Insufficient browser storage (${quotaStatus.freeGB.toFixed(1)} GB free). Build this exact target on your own machine instead.`);
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
    const nativeBuild = buildIso === wasmNativeBuildIso || buildIso === wasmNativeBuildIsoWithResult;
    if (nativeBuild && !wasmEngineDigest) {
      throw new Error("loaded WASM digest unavailable; refusing receipt-less browser build");
    }
    let writtenBytes = 0;
    const result = await buildIso(
      // engineDigest only ever names the module this page instantiated; a
      // replaced build function is not that module.
      { label, initrd, flatpaks, packages, extraRun, request: req,
        ...(nativeBuild ? { engineDigest: wasmEngineDigest } : {}) },
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
    renderFallbackCard(op, `Browser build failed (${String(e)}). Build this exact target on your own machine instead.`);
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
    const payload = `cat <<'EOF' > build-request.json\n${globalThis.tboxExportBuildRequestJSON()}\nEOF\n${PUREBUILD_COMMAND}`;
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
