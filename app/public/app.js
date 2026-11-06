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

const DEFAULT_CATALOG_SNAPSHOT = {"coverageDigest":"sha256:0c08dc7b87b5cf36c5daa370b21bfa0a8db206321a4f6426b3b0248b86412cc1","generatedAt":"2026-11-06T12:35:13Z","kind":"catalog-snapshot","producerRevision":"tunaos.toml@0db9d14131605f5dc890215f89e7303e838029bf","schemaVersion":1,"snapshotDigest":"sha256:64102188865761f1a883d7e42d6485897ff4389790b2507f46eddbec77562cf6","targets":[{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1625549436,"desktop":"","digest":"sha256:6c2767ca122bc5452471c4d05db2463d0a6384352ea20729d0b77ccf6189c051","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:base-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"base-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:2c271eefd8d353c7d7c2db8b45ad018ec36a53f9677f6287710faa54b6f934da","engineRevision":null,"indexDigest":"sha256:0c90bf360dbbb570af72b83592b8455a2f8ccec4e971ebac10bd98501fce9804","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:6c2767ca122bc5452471c4d05db2463d0a6384352ea20729d0b77ccf6189c051"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:base-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1694927422,"desktop":"","digest":"sha256:81b703368d9d07b76c216c3dcd437c0905664618aa6839d9f986578ef9a5e0b9","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:base-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"base-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:6395609558b2535bdedbcf1ce077bf8b372e94f08e09fbba26c87147e4863594","engineRevision":null,"indexDigest":"sha256:0c90bf360dbbb570af72b83592b8455a2f8ccec4e971ebac10bd98501fce9804","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:81b703368d9d07b76c216c3dcd437c0905664618aa6839d9f986578ef9a5e0b9"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"base-hwe","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"albacore"},"targetKey":"albacore:base-hwe:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1606739412,"desktop":"","digest":"sha256:bef8c0cf61e74c1852eb11d9b332832a6bf94b77dddd6a0d80e563a0cb5dfd1d","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:base-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"base-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:72a8ce1ec993545fac65cdd61f884d2f5bb277c5e12842ae9070cf762947053f","engineRevision":null,"indexDigest":"sha256:0c90bf360dbbb570af72b83592b8455a2f8ccec4e971ebac10bd98501fce9804","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:bef8c0cf61e74c1852eb11d9b332832a6bf94b77dddd6a0d80e563a0cb5dfd1d"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"albacore"},"targetKey":"albacore:base-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2301957390,"desktop":"","digest":"sha256:6d8114f8cad3d5050cbb63457fae3314ffbc65f08784962ced10b55845729cef","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:base-nvidia","repository":"ghcr.io/tuna-os/albacore","tag":"base-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:1247316b1c6bf8a17aad1d337cbdfb6801940b8f9588c9f7f71d4476a8d2a367","engineRevision":null,"indexDigest":"sha256:5f339e7ee0aaa8472b115ace2277da2da12bb63c65f4cd21bacc08f4e688d06e","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:6d8114f8cad3d5050cbb63457fae3314ffbc65f08784962ced10b55845729cef"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:base-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1625444597,"desktop":"","digest":"sha256:226d55f2434f1935ba393c12e22827209ca8f09d6f6d8c8da15d9a434a1aec7f","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:base","repository":"ghcr.io/tuna-os/albacore","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:2aa89d0b7bc6d82f3ef8ee4267118fc76f20413a68b007118163314aeed0a687","engineRevision":null,"indexDigest":"sha256:721fecf7e7a1dcc86a3ff23350c6553dfc459e03f086eae6dc40e16cb06c108d","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:226d55f2434f1935ba393c12e22827209ca8f09d6f6d8c8da15d9a434a1aec7f"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1624319578,"desktop":"","digest":"sha256:3edb0acb137183d871d44f796b4814f87c21b77e02446951beb5d7b131c72d97","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:base","repository":"ghcr.io/tuna-os/albacore","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:0986825cb2528a055cd1707e469535174add90f68c534ec19faabbfa295ec722","engineRevision":null,"indexDigest":"sha256:721fecf7e7a1dcc86a3ff23350c6553dfc459e03f086eae6dc40e16cb06c108d","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:3edb0acb137183d871d44f796b4814f87c21b77e02446951beb5d7b131c72d97"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"base","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"albacore"},"targetKey":"albacore:base:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1513148042,"desktop":"","digest":"sha256:49cb2df472561bcfb19dee4c592e44be7ae17c58f05b004362d0be87e65e4c16","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:base","repository":"ghcr.io/tuna-os/albacore","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:bc4adb8ec5c7ba728eddca13e177ecbc92eeb26326f71febe1162edcf695feb9","engineRevision":null,"indexDigest":"sha256:721fecf7e7a1dcc86a3ff23350c6553dfc459e03f086eae6dc40e16cb06c108d","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:49cb2df472561bcfb19dee4c592e44be7ae17c58f05b004362d0be87e65e4c16"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base","hardwareScope":"generic","platform":"linux/arm64","variant":"albacore"},"targetKey":"albacore:base:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2073625109,"desktop":"cosmic","digest":"sha256:ca9218d5184ea59ca301de800e9ee101ebd0cef014d48930299c53efdd69a533","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:cosmic-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"cosmic-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:b1387f64a5358c2788972568c457dc1625b0d24115dbb2590d092da6f81684a0","engineRevision":null,"indexDigest":"sha256:eb2c5ba909a866d291b2b43c13a17390f490fc1c2a8308771f00ba436d87c479","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:ca9218d5184ea59ca301de800e9ee101ebd0cef014d48930299c53efdd69a533"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:cosmic-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2678653433,"desktop":"cosmic","digest":"sha256:ce122fb60b18ca2f3226a8b85e7c4a515fda672788ab840e189bfc40ee21b4cf","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:cosmic-nvidia","repository":"ghcr.io/tuna-os/albacore","tag":"cosmic-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:9f075aece6ea96b0544a53d22ae1aab68a6672b12a62139d30226d06ae49a719","engineRevision":null,"indexDigest":"sha256:be4c614f7446cb9e1db833ff7b35cbc8b52f7059f21d3613844ac1a7daee59e4","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:ce122fb60b18ca2f3226a8b85e7c4a515fda672788ab840e189bfc40ee21b4cf"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:cosmic-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2073614940,"desktop":"cosmic","digest":"sha256:1c02b449ee04f0a73d6af4c1b0d62ac26969677e9399ec69d851bfda9ebd9f0c","hasSdBoot":false,"kernelVer":"6.12.0-211.74.1.el10_2.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:cosmic","repository":"ghcr.io/tuna-os/albacore","tag":"cosmic"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:f33c0e93ca33e29f6e2dd51c614a7b5e3ee961689c139120c31001ff4e7f3ce4","engineRevision":null,"indexDigest":"sha256:79a978857503ef196564813deb61ea49182b3b62cc731bfd211ab38e9e1797da","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:1c02b449ee04f0a73d6af4c1b0d62ac26969677e9399ec69d851bfda9ebd9f0c"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:cosmic:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2057378612,"desktop":"gnome","digest":"sha256:25f8b64d0732a0860fb6f636dde6e8c421e3880e509e9a87ad00f71671c1f121","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:gnome-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"gnome-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:9e4beae2d600bfca23537dfca4b6cfbf86d8e94c2e383eb20dba68fb5691177f","engineRevision":null,"indexDigest":"sha256:778402f2c274ca9941814a7b13690d54e758cae012697b7c10492194c2eef5e2","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:25f8b64d0732a0860fb6f636dde6e8c421e3880e509e9a87ad00f71671c1f121"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:gnome-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":2054331176,"desktop":"gnome","digest":"sha256:6944946f4b0cce86970ba14e09d5c9a14b69967ba79097263e8d13192e25cc62","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:gnome-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"gnome-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:a94b8eab6bfa70d97d895891f968830f8a715176763863135df799e4c379196d","engineRevision":null,"indexDigest":"sha256:778402f2c274ca9941814a7b13690d54e758cae012697b7c10492194c2eef5e2","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:6944946f4b0cce86970ba14e09d5c9a14b69967ba79097263e8d13192e25cc62"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"gnome-hwe","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"albacore"},"targetKey":"albacore:gnome-hwe:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2662280593,"desktop":"gnome","digest":"sha256:18d2f9dbf50ed48d25fa4689b29d272862ef90382208058df5dff50b971465d3","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:gnome-nvidia","repository":"ghcr.io/tuna-os/albacore","tag":"gnome-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:09cc59fae39868f274b1478c15fab15a2b37fc90124ab07445d9a7f3759325d3","engineRevision":null,"indexDigest":"sha256:0609757a8f1615c0431a19f97bf0615543342b7af12a926519afafec82413ca6","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:18d2f9dbf50ed48d25fa4689b29d272862ef90382208058df5dff50b971465d3"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:gnome-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2057394460,"desktop":"gnome","digest":"sha256:2abae2bdf07fe66c90bd35d30881256778a3c633593666a18206075c25042406","hasSdBoot":false,"kernelVer":"6.12.0-211.73.1.el10_2.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:gnome","repository":"ghcr.io/tuna-os/albacore","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:328c61bb2945a61016f43de1f65305c6983a9a22a492ee5b96a2c4bd278a5a1f","engineRevision":null,"indexDigest":"sha256:d98b17e60897b2a5ac9e09d56d1c7d133f890099d86052fa7f09cbd6f2db8986","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:2abae2bdf07fe66c90bd35d30881256778a3c633593666a18206075c25042406"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":2054344146,"desktop":"gnome","digest":"sha256:aeb742e7db63febdd9734f844259dce99af7ba6317439f1bb34e39741a2b0503","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:gnome","repository":"ghcr.io/tuna-os/albacore","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:fd5840ec50e464f371bdb59ea4453e0e9b4721b558742283f8d50dd9e464c8ed","engineRevision":null,"indexDigest":"sha256:d98b17e60897b2a5ac9e09d56d1c7d133f890099d86052fa7f09cbd6f2db8986","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:aeb742e7db63febdd9734f844259dce99af7ba6317439f1bb34e39741a2b0503"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"albacore"},"targetKey":"albacore:gnome:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2136970929,"desktop":"kde","digest":"sha256:ec61bc7f8fe2ea6d5deb033c4e3a82c1cedfd438ce09eaf952f7033c030d42ed","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:kde-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"kde-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:950666de79bb83b5f1567712041b0189283027fcad17de1c7f3ab87ceb97841e","engineRevision":null,"indexDigest":"sha256:382793d54b981b8750f995535a4e92f65c94764ef415f33b9ffe9d3d9238f92a","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:ec61bc7f8fe2ea6d5deb033c4e3a82c1cedfd438ce09eaf952f7033c030d42ed"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:kde-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":2132666776,"desktop":"kde","digest":"sha256:04c8fb0e097734cc5f8d160dc65fb6b535a64e397ae1789ad6bbc3612d199d47","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:kde-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"kde-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:38e1692e9a89ff7fce7209897761319e873bd277fda669d6cf58fdab1f759284","engineRevision":null,"indexDigest":"sha256:382793d54b981b8750f995535a4e92f65c94764ef415f33b9ffe9d3d9238f92a","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:04c8fb0e097734cc5f8d160dc65fb6b535a64e397ae1789ad6bbc3612d199d47"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"kde-hwe","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"albacore"},"targetKey":"albacore:kde-hwe:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2036637069,"desktop":"kde","digest":"sha256:788777a473d7c766f80876282fc5ac15ddf25cf436eedac3b16fcdfa28026106","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:kde-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"kde-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:ac23fe58a01dd19cf1709a8416b8737133c9e4ec2b2ee2261f93fb7f9a4a0287","engineRevision":null,"indexDigest":"sha256:382793d54b981b8750f995535a4e92f65c94764ef415f33b9ffe9d3d9238f92a","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:788777a473d7c766f80876282fc5ac15ddf25cf436eedac3b16fcdfa28026106"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"kde-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"albacore"},"targetKey":"albacore:kde-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2741842486,"desktop":"kde","digest":"sha256:e811ea65435d1489c705aa512336fd1e81b61f277cdc38df8a8cdb77e0cc5aba","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:kde-nvidia","repository":"ghcr.io/tuna-os/albacore","tag":"kde-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:98c2c4f0ab795d82783989606686ae1b65783a1273bc5ed5bf247c53b81cfa4b","engineRevision":null,"indexDigest":"sha256:8263ed27a4055b7aaad911be9c13a1314e55d6e6735dbbe4c8c4547557c8196e","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:e811ea65435d1489c705aa512336fd1e81b61f277cdc38df8a8cdb77e0cc5aba"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:kde-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2136816503,"desktop":"kde","digest":"sha256:14a4352cb02f157659b4469667163df113ecec12df8427b2ff1c0bf8b556fc02","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:kde","repository":"ghcr.io/tuna-os/albacore","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:ee2a89f0290a68b733024d1bb10e3736bb2f6b039c3671f2903e7885d6d0da9d","engineRevision":null,"indexDigest":"sha256:bc1058540e32b4b0bc3a2414e1b149806181d29a25f0d2b7b1a01a8e5f2de540","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:14a4352cb02f157659b4469667163df113ecec12df8427b2ff1c0bf8b556fc02"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":2132731597,"desktop":"kde","digest":"sha256:bd580954f85f1ca0be303a70442feec669cbd61a459551b7d82870d85cb790d4","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:kde","repository":"ghcr.io/tuna-os/albacore","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:bc00a15068509654e3a8a547fd267eca86dc2d382d2ec143f61930837b3e035a","engineRevision":null,"indexDigest":"sha256:bc1058540e32b4b0bc3a2414e1b149806181d29a25f0d2b7b1a01a8e5f2de540","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:bd580954f85f1ca0be303a70442feec669cbd61a459551b7d82870d85cb790d4"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"albacore"},"targetKey":"albacore:kde:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2036550703,"desktop":"kde","digest":"sha256:05e99c6593e083c3437e416146552cf49f37d57e2d4b54851b4691a0dcdaa8d1","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:kde","repository":"ghcr.io/tuna-os/albacore","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:1f2f40912a78636d9dcffb321dc0dbb90c157b008e054005efabb6b7293930ae","engineRevision":null,"indexDigest":"sha256:bc1058540e32b4b0bc3a2414e1b149806181d29a25f0d2b7b1a01a8e5f2de540","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:05e99c6593e083c3437e416146552cf49f37d57e2d4b54851b4691a0dcdaa8d1"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"kde","hardwareScope":"generic","platform":"linux/arm64","variant":"albacore"},"targetKey":"albacore:kde:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1938904544,"desktop":"niri","digest":"sha256:7cf6b7e0c338165b716a3f0d42977cdc3c3dc0881e9cec699d5f9ad75a3b37fb","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:niri-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"niri-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:4b570651ff92212e4842ae3baf0339265505e3a451a49805494de60231cd9eaf","engineRevision":null,"indexDigest":"sha256:62970fedc921476fbe2b15b3645c2e828a14be354a056bebde3104e17a3dbeb8","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:7cf6b7e0c338165b716a3f0d42977cdc3c3dc0881e9cec699d5f9ad75a3b37fb"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:niri-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1947716687,"desktop":"niri","digest":"sha256:5b4dca51484ddcfd885dacbe1b39f5b855b0df580ccfc11ad42b7dac4d264b1e","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:niri-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"niri-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:c4fd391ce93dda15861e3f5205c24a23af763106cf578ea9f6da8240e8fa41e1","engineRevision":null,"indexDigest":"sha256:62970fedc921476fbe2b15b3645c2e828a14be354a056bebde3104e17a3dbeb8","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:5b4dca51484ddcfd885dacbe1b39f5b855b0df580ccfc11ad42b7dac4d264b1e"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"niri-hwe","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"albacore"},"targetKey":"albacore:niri-hwe:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1834479438,"desktop":"niri","digest":"sha256:e14abb5175c9b048ac67d49c975154bcdac9522da86a854b5e4e664a5e6037d8","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:niri-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"niri-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:e33fda860574f94a76b013db4a6ec51848201ad89776ad3a9e188fd7d130b737","engineRevision":null,"indexDigest":"sha256:62970fedc921476fbe2b15b3645c2e828a14be354a056bebde3104e17a3dbeb8","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:e14abb5175c9b048ac67d49c975154bcdac9522da86a854b5e4e664a5e6037d8"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"niri-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"albacore"},"targetKey":"albacore:niri-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2543758342,"desktop":"niri","digest":"sha256:90d42c565fa6a559d04ca324ca280593834bb6c34ee1bf5dc22ac5332a8d0dfd","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:niri-nvidia","repository":"ghcr.io/tuna-os/albacore","tag":"niri-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:25d793c51a791b7a6c96a7c90951af0fa42ebcec4d79e8595320951322de7d44","engineRevision":null,"indexDigest":"sha256:54406fb53abee16d54a7c4c5e7fe6364e81b4be5ae26a02c994b3d9ebc740f4f","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:90d42c565fa6a559d04ca324ca280593834bb6c34ee1bf5dc22ac5332a8d0dfd"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:niri-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1938845569,"desktop":"niri","digest":"sha256:57de008eb9df6871cb1970edaa2b507d9cf0b6890f7d80567d2224e387f96619","hasSdBoot":false,"kernelVer":"6.12.0-211.74.1.el10_2.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:niri","repository":"ghcr.io/tuna-os/albacore","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:e8b9f3df030e717d13961dd6fe3aa4d8acd396e02c2774fd396bc57a080eb62a","engineRevision":null,"indexDigest":"sha256:360548660936952c0f25bc4bb0dcf17f513a286121cb8cc085645d6ecc8205dc","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:57de008eb9df6871cb1970edaa2b507d9cf0b6890f7d80567d2224e387f96619"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:niri:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1947795276,"desktop":"niri","digest":"sha256:292c6deba4d3246524d294bc84c40eb40d13ee1d39bb92633a2a579afe8acb78","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:niri","repository":"ghcr.io/tuna-os/albacore","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:3908fa269fa326c5d6277f03e87ef07d40c32300c288df61e2b2c04564cc4721","engineRevision":null,"indexDigest":"sha256:360548660936952c0f25bc4bb0dcf17f513a286121cb8cc085645d6ecc8205dc","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:292c6deba4d3246524d294bc84c40eb40d13ee1d39bb92633a2a579afe8acb78"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"niri","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"albacore"},"targetKey":"albacore:niri:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1834436060,"desktop":"niri","digest":"sha256:749429f4ab15eecd2fe213311205a7e009f62ceebb6726a6d97c38acbea4291e","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:niri","repository":"ghcr.io/tuna-os/albacore","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:6899a21c30a8adca3b157c4d83f2cdb93b508064ce80d377c92dadb8baa060cd","engineRevision":null,"indexDigest":"sha256:360548660936952c0f25bc4bb0dcf17f513a286121cb8cc085645d6ecc8205dc","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:749429f4ab15eecd2fe213311205a7e009f62ceebb6726a6d97c38acbea4291e"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"niri","hardwareScope":"generic","platform":"linux/arm64","variant":"albacore"},"targetKey":"albacore:niri:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1862667112,"desktop":"tuna","digest":"sha256:4e3e0b191dfc55d1005d689d16b93fab495e65d7bd313140dc1dba59b5968b8c","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:tuna","repository":"ghcr.io/tuna-os/albacore","tag":"tuna"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:9f14a8c703ba005e67c8e745dc14f304544a3e1537c9686c2bd62602c298addd","engineRevision":null,"indexDigest":"sha256:b68a195dbc6e079bbab6b330086e6420d860f5364d1f2232e5f377bc6cdf2a13","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:4e3e0b191dfc55d1005d689d16b93fab495e65d7bd313140dc1dba59b5968b8c"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"tuna","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:tuna:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1737178631,"desktop":"xfce","digest":"sha256:0e5ea67ad98b706c329b198122331e6ee5af2132f04719b21ae40c4dc2445687","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:xfce-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"xfce-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:dae543d1944c6701a4009b98ca92f9bb96272c85f04b9a1118e1e4b38602e497","engineRevision":null,"indexDigest":"sha256:2c5b5a1da1dbe2c89f615ab2e340d14e6f60af4094e4c635d721bf7cd1cb6a11","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:0e5ea67ad98b706c329b198122331e6ee5af2132f04719b21ae40c4dc2445687"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:xfce-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1737656168,"desktop":"xfce","digest":"sha256:1cb14d10156dda63d60f6f197602882dab22ed3ccb467ce34b99ffb4b1bbcdec","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:xfce-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"xfce-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:b2a37c0d7e4ed94729c20cff17f8b66f668041db5ec68be1ad83b45252897e40","engineRevision":null,"indexDigest":"sha256:2c5b5a1da1dbe2c89f615ab2e340d14e6f60af4094e4c635d721bf7cd1cb6a11","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:1cb14d10156dda63d60f6f197602882dab22ed3ccb467ce34b99ffb4b1bbcdec"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"xfce-hwe","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"albacore"},"targetKey":"albacore:xfce-hwe:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2341659098,"desktop":"xfce","digest":"sha256:05e0ae0f0f60daefab53e8eda5e50a0ab06c3e3b945809a32cc5de00d38c22de","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:xfce-nvidia","repository":"ghcr.io/tuna-os/albacore","tag":"xfce-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:505164bd501cb41ffabf52d9982cac7032750fe4ef83bb63dd2b9690e950efbf","engineRevision":null,"indexDigest":"sha256:aadba393760699b48093f67b63a97e8d2716b4464dd904aad5a691a6d0dddfc9","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:05e0ae0f0f60daefab53e8eda5e50a0ab06c3e3b945809a32cc5de00d38c22de"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:xfce-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1737067588,"desktop":"xfce","digest":"sha256:8e0e9f88d915a8e83cd85f75cf139614246b20574fdc79fb880f4bb6531ab5e0","hasSdBoot":false,"kernelVer":"6.12.0-211.74.1.el10_2.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:xfce","repository":"ghcr.io/tuna-os/albacore","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:46edce877bbe8b8c0f18ed8ff5b702a221fdf9a4550a084569f2282c4f85f343","engineRevision":null,"indexDigest":"sha256:ea204b0261b4bc988838ad9989159208d0c2cc373742878254f7c35f63a5204c","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:8e0e9f88d915a8e83cd85f75cf139614246b20574fdc79fb880f4bb6531ab5e0"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:xfce:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1737776451,"desktop":"xfce","digest":"sha256:c43b838ffd8f8401c149c6dedb59fbc13a4ae49b4093de5719c0c6fbda84731d","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:xfce","repository":"ghcr.io/tuna-os/albacore","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:1c0f658d0c6d19eb5de87bfe44004b5a7780d185fe406be66dab9c08420872ad","engineRevision":null,"indexDigest":"sha256:ea204b0261b4bc988838ad9989159208d0c2cc373742878254f7c35f63a5204c","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:c43b838ffd8f8401c149c6dedb59fbc13a4ae49b4093de5719c0c6fbda84731d"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"albacore"},"targetKey":"albacore:xfce:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1960069215,"desktop":"","digest":"sha256:b0fac6427bfe18521b45e0699c780822cf2fdf5378e69267d4ef69e744bfaedc","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:base-hwe-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"base-hwe-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:3c87b62228c0dc38b4a109a07faaa0c1e5eba54754adbfb48f12a1aec43f7493","engineRevision":null,"indexDigest":"sha256:ce1cb2204dca433cc1d7d78d45681305b0c14e83f36db0543bbf67f42e8e84ab","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:b0fac6427bfe18521b45e0699c780822cf2fdf5378e69267d4ef69e744bfaedc"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:base-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1835762872,"desktop":"","digest":"sha256:335e35ec120848f366d2a66b873330a0382a243f25a9ef953ade6db18e613cc8","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:base-hwe-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"base-hwe-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:9390bdb5defdca960278af156324b055584acceaaa9ecde7d82e8a09b5167a47","engineRevision":null,"indexDigest":"sha256:ce1cb2204dca433cc1d7d78d45681305b0c14e83f36db0543bbf67f42e8e84ab","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:335e35ec120848f366d2a66b873330a0382a243f25a9ef953ade6db18e613cc8"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:base-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2546493835,"desktop":"","digest":"sha256:eca3cc0e4c075a33a0d78905321acf4bf79831d6d4477cd7b580eb7044e63df3","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:base-nvidia-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"base-nvidia-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:2eef8284daecf7837ca4d67b66135567e7561259f750b00f9a08c2e3dff17d61","engineRevision":null,"indexDigest":"sha256:77c77426f1e7bee9dc8c29b4b1504182648700df84fbadc6c9f0aef1376fb64e","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:eca3cc0e4c075a33a0d78905321acf4bf79831d6d4477cd7b580eb7044e63df3"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:base-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1920209215,"desktop":"","digest":"sha256:1d1f20c42f9f00a8aaf79d8ad9d8096abcbe6ac5f08970f023749fd888a0593d","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:base-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"base-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:cfbe1d9e04dd2e7540171364be1c70e15ce5b42ae589d94a2324841067d96104","engineRevision":null,"indexDigest":"sha256:8dbc464de992273c4a2ba58c279a42b05e889a6b03b73e1a9382552c664fc6f8","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:1d1f20c42f9f00a8aaf79d8ad9d8096abcbe6ac5f08970f023749fd888a0593d"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1798737591,"desktop":"","digest":"sha256:1eb2ffc1f353f6af92a5b7acbb3be7bacfeea88dddb86fd507a54db849d5c466","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:base-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"base-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:2f47d926f7817996e00031b609550dae9ed7e542792c0db0c8d0cf91eead6021","engineRevision":null,"indexDigest":"sha256:8dbc464de992273c4a2ba58c279a42b05e889a6b03b73e1a9382552c664fc6f8","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:1eb2ffc1f353f6af92a5b7acbb3be7bacfeea88dddb86fd507a54db849d5c466"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:base:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3238788430,"desktop":"cosmic","digest":"sha256:2c1a3e525feffdbd92d9208ebb63a7a71bdfd2a4007afd29d2d48da1406d29de","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:cosmic-nvidia-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"cosmic-nvidia-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:26aa5661e8cb6b2fd0ba44413f1e19c0771d03eb3b3c868573285d55d25881c1","engineRevision":null,"indexDigest":"sha256:6faa911b4ca3be9d590d0fb368517a786d1ed0eccb9df6af66ed7156371a4923","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:2c1a3e525feffdbd92d9208ebb63a7a71bdfd2a4007afd29d2d48da1406d29de"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:cosmic-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2652665361,"desktop":"cosmic","digest":"sha256:fe06f2452367756e0c21feafa705eda2a2d9290803f48e88dd466c1c8a7e34f2","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:cosmic-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"cosmic-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:fa1654548cb2d743b78f1153aff371bbabcbd8f53b350978f1dc4be106474973","engineRevision":null,"indexDigest":"sha256:a8c043b9db6d79e444f46535a065f4968d75388c8a862476daf8953444d6d52e","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:fe06f2452367756e0c21feafa705eda2a2d9290803f48e88dd466c1c8a7e34f2"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:cosmic:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2510100283,"desktop":"cosmic","digest":"sha256:e351d8a8d0d74a98193fa335b99fed85c4f25e1d8059b19b3f811f1a53c3b885","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:cosmic-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"cosmic-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:c6d99663cb34fdc3cfd9ef1d89dd2fad2d8f2f5a34fcbe7bdccde76e9d5d2bfa","engineRevision":null,"indexDigest":"sha256:a8c043b9db6d79e444f46535a065f4968d75388c8a862476daf8953444d6d52e","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:e351d8a8d0d74a98193fa335b99fed85c4f25e1d8059b19b3f811f1a53c3b885"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"cosmic","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:cosmic:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2590060676,"desktop":"gnome","digest":"sha256:f178e38bcbda56475e75408df708dac9f6dfa886b5340b0402233a181d47bc8e","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome-hwe-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"gnome-hwe-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:0a685687bd8125cb062a64723f6246928d58a35854512c659a103abe18958004","engineRevision":null,"indexDigest":"sha256:1586897822e8e10c76f861ef7ce9ccc9af759fba56afa48e1eb18924f9866f00","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:f178e38bcbda56475e75408df708dac9f6dfa886b5340b0402233a181d47bc8e"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:gnome-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2453746344,"desktop":"gnome","digest":"sha256:1f12100ab04cf99250e2d12d2b7401c5ef3cb132636223f3921e3f392ecf9b9a","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome-hwe-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"gnome-hwe-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:0e2ed16e03d5f3cea29a14c4a8892d6a8e6dde2641807775995c0ff2cb0815b9","engineRevision":null,"indexDigest":"sha256:1586897822e8e10c76f861ef7ce9ccc9af759fba56afa48e1eb18924f9866f00","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:1f12100ab04cf99250e2d12d2b7401c5ef3cb132636223f3921e3f392ecf9b9a"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:gnome-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3181307628,"desktop":"gnome","digest":"sha256:410244ca81591f4b95be4a016ddf1920e4addd7bf930e95e519a9cdbd7142742","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome-nvidia-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"gnome-nvidia-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:d6bf869bd4b598a21952f59266b4cbcd89398652fb758a85ffabb4d61dc8a9ff","engineRevision":null,"indexDigest":"sha256:639c7fe0fc817103e61f8e2a2bd7915882179f41d7f94880383d51ab53947d2c","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:410244ca81591f4b95be4a016ddf1920e4addd7bf930e95e519a9cdbd7142742"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:gnome-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2573218666,"desktop":"gnome","digest":"sha256:fc34e18458387776cc575d73582e8cceeaa8e76c3b427301b099253cd8579425","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"gnome-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:14491c73aa4c5be5ba5c470a782d9cf2812430702868a7496b1742dd9b2dc6a5","engineRevision":null,"indexDigest":"sha256:28d02dc05fe923524e6698323b6f676424b63702d791f166753e8a9982f24247","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:fc34e18458387776cc575d73582e8cceeaa8e76c3b427301b099253cd8579425"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2436994269,"desktop":"gnome","digest":"sha256:225394bc6d1a06656b81e292f2ac83a58521578704d30ac1718a04554716b288","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"gnome-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:1137aae1c1914cb6c99b17ec8e5d37978ea827feafd05b1b55af163bef142122","engineRevision":null,"indexDigest":"sha256:28d02dc05fe923524e6698323b6f676424b63702d791f166753e8a9982f24247","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:225394bc6d1a06656b81e292f2ac83a58521578704d30ac1718a04554716b288"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:gnome:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3925044493,"desktop":"kde","digest":"sha256:24ae6271fe50057fd9bf145ffd7e360f7cb12615ba6038ded70724cab5937944","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:kde-nvidia-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"kde-nvidia-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:212b8392150fcd24bfba25f8abc466b1ef13481613acf81bbc670b107cb14ae9","engineRevision":null,"indexDigest":"sha256:72702eac12a13a81d20a58b85abbe540a90ac7742a73899abccadecd7857bf6a","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:24ae6271fe50057fd9bf145ffd7e360f7cb12615ba6038ded70724cab5937944"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:kde-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3337330408,"desktop":"kde","digest":"sha256:fd8048cae688ba634989ca3d382f596f4dd9035e44d08ff3abf3d69309ff7b74","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:kde-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"kde-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:20137fba22c3dc15d7f1c243b209ed20e47807827febe02caa5e1cad35b08db0","engineRevision":null,"indexDigest":"sha256:373a962b66ba1924e1a5e642b0014ea7131cede1715957d253f58b33472fa012","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:fd8048cae688ba634989ca3d382f596f4dd9035e44d08ff3abf3d69309ff7b74"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3174413554,"desktop":"kde","digest":"sha256:b28ab3b37b18642382c7c2ec832bbe0c5065c7036a8bfabde5eaa7fe2b105260","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:kde-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"kde-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:6c6711dc4a70bff6c37f4a68ee22e6a5f2a99e03a32b87bd137093ba9e40be76","engineRevision":null,"indexDigest":"sha256:373a962b66ba1924e1a5e642b0014ea7131cede1715957d253f58b33472fa012","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:b28ab3b37b18642382c7c2ec832bbe0c5065c7036a8bfabde5eaa7fe2b105260"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"kde","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:kde:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2782469667,"desktop":"niri","digest":"sha256:adee9a4231b0fa5beb95cf0225c1cd604a385d908eedd27ef9eaaa5c48f62398","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:niri-nvidia-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"niri-nvidia-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:9ed17ce9bbbfa4eceebd1df95696a8579b5611a9e983c434f360b855538431ca","engineRevision":null,"indexDigest":"sha256:ebc44e3404befadbf463e3a084d4e50e63e133fe83bf75eb734de897969d26fe","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:adee9a4231b0fa5beb95cf0225c1cd604a385d908eedd27ef9eaaa5c48f62398"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:niri-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2196415930,"desktop":"niri","digest":"sha256:6e97786c5fde503943a4a2b563e9a5c838ae8e662579dc84cf20f587b6d192f2","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:niri-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"niri-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:e61ef622ebe5a33910d360ace52e07d7de73e7d707829ca6c4c766425ed4f32a","engineRevision":null,"indexDigest":"sha256:386d1f67fb79425a630dad0cec1b49599579815b577bacab8e37526ef5690c6f","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:6e97786c5fde503943a4a2b563e9a5c838ae8e662579dc84cf20f587b6d192f2"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:niri:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2063689843,"desktop":"niri","digest":"sha256:702d4934f51f22fbece90c87f3cb8710ed5a4c52c3dfe7cd248201f73745d6c5","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:niri-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"niri-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:c0cc19042d538e622f2fa7f4a73da224f91f21f9f7c137eeec38550fb4a606fb","engineRevision":null,"indexDigest":"sha256:386d1f67fb79425a630dad0cec1b49599579815b577bacab8e37526ef5690c6f","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:702d4934f51f22fbece90c87f3cb8710ed5a4c52c3dfe7cd248201f73745d6c5"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"niri","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:niri:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2266837989,"desktop":"tuna","digest":"sha256:91490c67ae76727c2be69376108b8b449c5d7a7c0d0a73de4809c2cf6c373906","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:tuna-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"tuna-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:2087dec9ae9afd1580e4c4b37066168234c61bfa50379e4f414d7a6be2a9974b","engineRevision":null,"indexDigest":"sha256:467c67243498807944cc884ef3708e6dab724c62b8630c3fc09014bd293c6c54","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:91490c67ae76727c2be69376108b8b449c5d7a7c0d0a73de4809c2cf6c373906"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"tuna","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:tuna:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3305282863,"desktop":"xfce","digest":"sha256:6cf706e5d2e7f79377be8adf49500eb01b35aa1688e6ac3e41331dc5c093f3cc","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:xfce-nvidia-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"xfce-nvidia-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:3288afa0d31052417ea3c7c31634036c61f173c9a928903630e161ebca41f904","engineRevision":null,"indexDigest":"sha256:7a95b59f2c336732b8d0d9bb19646deae6488e1b9d0c00ec06ffb90b7c518d77","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:6cf706e5d2e7f79377be8adf49500eb01b35aa1688e6ac3e41331dc5c093f3cc"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:xfce-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2714991644,"desktop":"xfce","digest":"sha256:d971794bbc4d3b93ee8aa1339f84c5b294d78cf48801b6c4d35d16ed96157ed8","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:xfce-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"xfce-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:cfe594e92647a1f96bb129693840d5c72d13ee7815acd237267d0415ff4c630f","engineRevision":null,"indexDigest":"sha256:3515bf497ba41747e6d8d0e5a6b66de804d5eccee82ff5491dd14ba1580fcc73","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:d971794bbc4d3b93ee8aa1339f84c5b294d78cf48801b6c4d35d16ed96157ed8"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:xfce:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2561448918,"desktop":"xfce","digest":"sha256:7f508bd6a8dc980ad429cecde0ee5ec63331405f8d40b8b6254a034e0abf9beb","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:xfce-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"xfce-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:1752991abee27d549a8fad6d90ed09ea58cdf66051d6f19ee8fcfa5eda34bd88","engineRevision":null,"indexDigest":"sha256:3515bf497ba41747e6d8d0e5a6b66de804d5eccee82ff5491dd14ba1580fcc73","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:7f508bd6a8dc980ad429cecde0ee5ec63331405f8d40b8b6254a034e0abf9beb"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"xfce","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:xfce:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1974788824,"desktop":"","digest":"sha256:bdcd0373c2c0137eae7a42719cddd15dbe1c0ab14b56b465312d77004333c686","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:base-hwe","repository":"ghcr.io/tuna-os/bonito","tag":"base-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:e60d371a705285990fe7934e35f4d728f531f35d0937521197d9b4c99e132ec5","engineRevision":null,"indexDigest":"sha256:6ab14e3016478bdd7ba75f5cbd5e3d7cd7e908553d8ce719d0898cb2f8fcf1e9","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:bdcd0373c2c0137eae7a42719cddd15dbe1c0ab14b56b465312d77004333c686"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:base-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1857890675,"desktop":"","digest":"sha256:a56c776e2e33185851208723437671b822b5fe53a5707d1609fcf3310ec79e1a","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:base-hwe","repository":"ghcr.io/tuna-os/bonito","tag":"base-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:ff03faed7cd5aa8b2d5990806126e9d175586207e67afb544231623919623338","engineRevision":null,"indexDigest":"sha256:6ab14e3016478bdd7ba75f5cbd5e3d7cd7e908553d8ce719d0898cb2f8fcf1e9","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:a56c776e2e33185851208723437671b822b5fe53a5707d1609fcf3310ec79e1a"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito"},"targetKey":"bonito:base-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2592452209,"desktop":"","digest":"sha256:16e86182a239b73588b0b1de63afc4edb695796745e8f73400b97d91b7152165","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:base-nvidia","repository":"ghcr.io/tuna-os/bonito","tag":"base-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:8d87e36881657a411fdd5fffe1d87ad75b1ddd75a1b70bf5a891963dc4fe74f2","engineRevision":null,"indexDigest":"sha256:70d77def88c30109d2dc9fcd038ef362597da6e13fd6d78ead883e41c76f3392","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:16e86182a239b73588b0b1de63afc4edb695796745e8f73400b97d91b7152165"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:base-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1848540185,"desktop":"","digest":"sha256:3fadcfe0dec993f61c5852a24cc7c06df0690b2053cc70d7aaea850bf5307eaa","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:base","repository":"ghcr.io/tuna-os/bonito","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:5f680a944083e765eb89d40669f83d61745e01de1a7a2297841ad20ecac76a62","engineRevision":null,"indexDigest":"sha256:c515b8e0941204498dcf6878a64e9e02ad097a6d9c37440a8dcd0da6ed813837","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:3fadcfe0dec993f61c5852a24cc7c06df0690b2053cc70d7aaea850bf5307eaa"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1725840874,"desktop":"","digest":"sha256:b1b1b2e7221ca6534890da51877a162aada25848ddca0afc88ffe7017921ad14","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:base","repository":"ghcr.io/tuna-os/bonito","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:b5acad843f6d96c689604b495bc377e10c30583fd1798487ae36cc1632d4ca87","engineRevision":null,"indexDigest":"sha256:c515b8e0941204498dcf6878a64e9e02ad097a6d9c37440a8dcd0da6ed813837","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:b1b1b2e7221ca6534890da51877a162aada25848ddca0afc88ffe7017921ad14"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito"},"targetKey":"bonito:base:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3254393459,"desktop":"cosmic","digest":"sha256:341019c20650d1cd7c1a5a543ee2620b03ed725069ea6147f3502d44a1153b83","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:cosmic-nvidia","repository":"ghcr.io/tuna-os/bonito","tag":"cosmic-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:221b118552777ea79a196e0a7d726830fc43685940276c9ddc4d82a173658514","engineRevision":null,"indexDigest":"sha256:a724e0cb0ba7e20323c30d23f63d8fea8c02aaa910b0f9203bbdfaf1a07da5d2","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:341019c20650d1cd7c1a5a543ee2620b03ed725069ea6147f3502d44a1153b83"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:cosmic-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2636536784,"desktop":"cosmic","digest":"sha256:2c6513f6519e064249a0c2c4f4db4f791207bae25502ccab1a009a1839f608de","hasSdBoot":false,"kernelVer":"7.2.15-200.fc44.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:cosmic","repository":"ghcr.io/tuna-os/bonito","tag":"cosmic"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:88261e8c4cce7795beb8e0458fe898ca7fc7142d2df0d1765a4ee7d782360a2a","engineRevision":null,"indexDigest":"sha256:cffa4d25dba97125f8985acbfaff1454acd2f0b0cf5d15c0c6ad2185dd35c7f7","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:2c6513f6519e064249a0c2c4f4db4f791207bae25502ccab1a009a1839f608de"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:cosmic:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2502085339,"desktop":"cosmic","digest":"sha256:65bbf13ab58d41fb1d02e02430d6d44f1dbaf28e6bbb9038b4c8df305ab4b223","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:cosmic","repository":"ghcr.io/tuna-os/bonito","tag":"cosmic"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:976cbd5e25f0bad1ef2dc0ca6a6cd1d36d8556e0e6e9a5436844ba8f79ccbda8","engineRevision":null,"indexDigest":"sha256:cffa4d25dba97125f8985acbfaff1454acd2f0b0cf5d15c0c6ad2185dd35c7f7","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:65bbf13ab58d41fb1d02e02430d6d44f1dbaf28e6bbb9038b4c8df305ab4b223"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"cosmic","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito"},"targetKey":"bonito:cosmic:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2551965355,"desktop":"gnome","digest":"sha256:af4942cf60fdb9adbc2185002ae0064e7b37f7d09cde431d47ce96231710a881","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome-asahi","repository":"ghcr.io/tuna-os/bonito","tag":"gnome-asahi"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:d67a629939257676cf71232f3c7eac80ab7e2322b11cdcbea67913df7c96c7a5","engineRevision":null,"indexDigest":"sha256:4771123c3d9fab9268fa18831da57f83941d0b60657a79b0483998f0f74c50f5","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:af4942cf60fdb9adbc2185002ae0064e7b37f7d09cde431d47ce96231710a881"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome-asahi","hardwareScope":"apple-silicon","platform":"linux/arm64","variant":"bonito"},"targetKey":"bonito:gnome-asahi:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2609562582,"desktop":"gnome","digest":"sha256:649ece87b784b430d035ae8ff12e4b55e5309d55d170bcd1bc9b9b8419258546","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome-hwe","repository":"ghcr.io/tuna-os/bonito","tag":"gnome-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:12912fc9cd10201eb8ed8328b9796367b7f237f261a1286313d086544a701a30","engineRevision":null,"indexDigest":"sha256:00cc640e00a190fead47173426b47435781b654911e56bbf411adf87348b5405","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:649ece87b784b430d035ae8ff12e4b55e5309d55d170bcd1bc9b9b8419258546"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:gnome-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2480553785,"desktop":"gnome","digest":"sha256:31d4bee2fdd632a7947251deffe59d319ed65e100d0bb25bd3899b44cc9ee930","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome-hwe","repository":"ghcr.io/tuna-os/bonito","tag":"gnome-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:18168dc30a4cb573719c0ede32cfdfc668c90a7cbe3d98cca6a32a0f9fb5dd32","engineRevision":null,"indexDigest":"sha256:00cc640e00a190fead47173426b47435781b654911e56bbf411adf87348b5405","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:31d4bee2fdd632a7947251deffe59d319ed65e100d0bb25bd3899b44cc9ee930"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito"},"targetKey":"bonito:gnome-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3229365791,"desktop":"gnome","digest":"sha256:85b8f5049a4915909ea5936f539fe28a0096526042f7f6e5f976d295cbcd9e31","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome-nvidia","repository":"ghcr.io/tuna-os/bonito","tag":"gnome-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:9a110e77901510ab57c053692cd4dbc5c48073179d554a0f07f39e553cc055e6","engineRevision":null,"indexDigest":"sha256:df54c3f81fa6635a0a52de6f18e795e4f133310e14f7bc146f8b5d412e66bc92","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:85b8f5049a4915909ea5936f539fe28a0096526042f7f6e5f976d295cbcd9e31"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:gnome-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2618661562,"desktop":"gnome","digest":"sha256:3e88f63ae73cc726292b98f4b9ab36042c4fb79cdaa5821411816ae808e220a0","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome-t2","repository":"ghcr.io/tuna-os/bonito","tag":"gnome-t2"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:82b16742a2da46c0bf21e23a75612afdae922599835eb7066439b288fba1345a","engineRevision":null,"indexDigest":"sha256:3943ce06a5fa9ffadb362d2179e5d1a86f06fcd23930921bbcc10d0e9d0154c3","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:3e88f63ae73cc726292b98f4b9ab36042c4fb79cdaa5821411816ae808e220a0"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-t2","hardwareScope":"apple-t2","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:gnome-t2:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2666099073,"desktop":"gnome","digest":"sha256:19feedabaf699cec86c82c0b324691ae4e9892afb7fd561b3518f5c111723dc3","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome-x13s","repository":"ghcr.io/tuna-os/bonito","tag":"gnome-x13s"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:06e51abc1fb2e649ad3630553f9544666eb1193ba4afca5508e75612d8227b0e","engineRevision":null,"indexDigest":"sha256:02659b0f185acdd8e29a1473d672a534e577f0fba75dc70cc1b292702dcb060b","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:19feedabaf699cec86c82c0b324691ae4e9892afb7fd561b3518f5c111723dc3"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome-x13s","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito"},"targetKey":"bonito:gnome-x13s:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2610593407,"desktop":"gnome","digest":"sha256:037c8821c2afc4bb21dc701ae9c4729b014abfe732573c033be624b46fb2ee05","hasSdBoot":false,"kernelVer":"7.2.15-200.fc44.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome","repository":"ghcr.io/tuna-os/bonito","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:f6683333033ea45404d1e0f299550bb9ae91a422673eabefbb37403b54c25a8d","engineRevision":null,"indexDigest":"sha256:6298fcb3fd7f1ccbfdf3492e32a6cef73dc1dc5f3826d48bf7c99028b1a87e2b","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:037c8821c2afc4bb21dc701ae9c4729b014abfe732573c033be624b46fb2ee05"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2481275068,"desktop":"gnome","digest":"sha256:f315a32321e23ef7489c070db13f18bd6fe05224b7592c9af19b8626487b6cc2","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome","repository":"ghcr.io/tuna-os/bonito","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:d721c08cae9dcf9f0a5b59f7603cb274a5eb2d98218b7767b611d1c0aaa63ea2","engineRevision":null,"indexDigest":"sha256:6298fcb3fd7f1ccbfdf3492e32a6cef73dc1dc5f3826d48bf7c99028b1a87e2b","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:f315a32321e23ef7489c070db13f18bd6fe05224b7592c9af19b8626487b6cc2"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito"},"targetKey":"bonito:gnome:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3972215307,"desktop":"kde","digest":"sha256:6d614ea581586e770fe07fbe84a85bfdcf91618eeed7c141ccb8e247f2f00e56","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:kde-nvidia","repository":"ghcr.io/tuna-os/bonito","tag":"kde-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:b53c21f48b9027947e76a8f6d5590614890ac7a0c11a68e619bad0ef033fea7d","engineRevision":null,"indexDigest":"sha256:93bfc936f222a62a009879a7097d83d1af2dcdb916c2867b4f6819e4ed79e547","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:6d614ea581586e770fe07fbe84a85bfdcf91618eeed7c141ccb8e247f2f00e56"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:kde-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3352397178,"desktop":"kde","digest":"sha256:2122f3879a5e458aea46d470a2f46643f98013c3a8e8ec72a9c83cfab9a69f96","hasSdBoot":false,"kernelVer":"7.2.15-200.fc44.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:kde","repository":"ghcr.io/tuna-os/bonito","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:405ec456ddfb85ebdf1c0d28e41cc600aa50f6b7572009a32093f4d1a0680e51","engineRevision":null,"indexDigest":"sha256:e18dedd55c20d50a3fecfb93eecaddcb46a703a1f9d3c64f592f3b1f18e28613","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:2122f3879a5e458aea46d470a2f46643f98013c3a8e8ec72a9c83cfab9a69f96"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3195299906,"desktop":"kde","digest":"sha256:d2e9b3024e6d71639054810a2d14fa268fd854ae63ef044d3e28627128b6e400","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:kde","repository":"ghcr.io/tuna-os/bonito","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:de31deca5f58ded3ee5efdb2f458b2ed7d14d2752dc3db3d9c0c623bf2438fc5","engineRevision":null,"indexDigest":"sha256:e18dedd55c20d50a3fecfb93eecaddcb46a703a1f9d3c64f592f3b1f18e28613","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:d2e9b3024e6d71639054810a2d14fa268fd854ae63ef044d3e28627128b6e400"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"kde","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito"},"targetKey":"bonito:kde:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2821222025,"desktop":"niri","digest":"sha256:b23937769957c91c798e6d0d70e8e544cad216e766dc37aed5b5864dc9165c13","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:niri-nvidia","repository":"ghcr.io/tuna-os/bonito","tag":"niri-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:e6706b8de7e4881fa5af8685c7cfb0154f478a4ddf2ee3cd1296936bc1ebe694","engineRevision":null,"indexDigest":"sha256:096ff78a0a803fd58fde07bef37a46008426ce6c6cd7a07bdb852192180bddb1","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:b23937769957c91c798e6d0d70e8e544cad216e766dc37aed5b5864dc9165c13"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:niri-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2203668018,"desktop":"niri","digest":"sha256:23b49412f07ee76a605d7c4923e241e8d6ff9267cc14940b6830a7513ec3a268","hasSdBoot":false,"kernelVer":"7.2.15-200.fc44.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:niri","repository":"ghcr.io/tuna-os/bonito","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:fe1e63f9644c94ca9cc5da2003d45cb1afdeaf50e27fb002e039b87ca3b0b8e3","engineRevision":null,"indexDigest":"sha256:67675825a8f5fdc8157cc34358eab680ec00a72c155355a919965034f048c198","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:23b49412f07ee76a605d7c4923e241e8d6ff9267cc14940b6830a7513ec3a268"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:niri:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2077062210,"desktop":"niri","digest":"sha256:82934cf18fa26a01199432b897aec13510c420deca7d02defab0ee10e03b5011","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:niri","repository":"ghcr.io/tuna-os/bonito","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:098100d0ed76f28a29c7510b5af793c5b062c6833cfe5749250316efc327cc2e","engineRevision":null,"indexDigest":"sha256:67675825a8f5fdc8157cc34358eab680ec00a72c155355a919965034f048c198","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:82934cf18fa26a01199432b897aec13510c420deca7d02defab0ee10e03b5011"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"niri","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito"},"targetKey":"bonito:niri:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2290322096,"desktop":"tuna","digest":"sha256:69f6acc87c3172eb412c12bb1718492b23fbc64a4978975544d5026fbec6f7ee","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:tuna","repository":"ghcr.io/tuna-os/bonito","tag":"tuna"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:b912b23813f8f3c441b4883de112bd02e0a97aab36c14560a86da61d67f0d639","engineRevision":null,"indexDigest":"sha256:5b05cec074673a3984007a5664b4ec5d6dbf20a080ce7adeb7a2542cbfa88e25","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:69f6acc87c3172eb412c12bb1718492b23fbc64a4978975544d5026fbec6f7ee"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"tuna","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:tuna:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3346653350,"desktop":"xfce","digest":"sha256:0f8ff53f3a08441aa47c028d2469a66f03266fd765bd7c066a3b43baa8428304","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:xfce-nvidia","repository":"ghcr.io/tuna-os/bonito","tag":"xfce-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:f185a54dabf1cfd87682454c19d65660e7056cbadc691d9a8aad4d573cea9daa","engineRevision":null,"indexDigest":"sha256:ae9cb37dc3af3991a41803564598a6d0e3c6362c5a6695ff10aceece484bf931","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:0f8ff53f3a08441aa47c028d2469a66f03266fd765bd7c066a3b43baa8428304"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:xfce-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2735944399,"desktop":"xfce","digest":"sha256:094686017f3a8f9bab40d11ccd25431bf4a465ded6290669ccf199d6b4530fd3","hasSdBoot":false,"kernelVer":"7.2.15-200.fc44.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:xfce","repository":"ghcr.io/tuna-os/bonito","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:535be3bb1b7550677acb7da5b7c12c874df1417cdaae105e67e8c34301e8d8bf","engineRevision":null,"indexDigest":"sha256:95144450d7c63d9db54684f12ac41d8d576a6b5a08327d0c7c8974d61b7025ac","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:094686017f3a8f9bab40d11ccd25431bf4a465ded6290669ccf199d6b4530fd3"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:xfce:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2589713045,"desktop":"xfce","digest":"sha256:7081ffa1c9de14e42ab987b2d78bb24b8262965d2e9e4972d50aca351de96c18","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:xfce","repository":"ghcr.io/tuna-os/bonito","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:00ff62a7a5091c37bc0fd000e5cd5e25533554e19d8d38e5f1da5749c34f5585","engineRevision":null,"indexDigest":"sha256:95144450d7c63d9db54684f12ac41d8d576a6b5a08327d0c7c8974d61b7025ac","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:7081ffa1c9de14e42ab987b2d78bb24b8262965d2e9e4972d50aca351de96c18"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"xfce","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito"},"targetKey":"bonito:xfce:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1091961046,"desktop":"","digest":"sha256:589cf253f9828b903804fb87e0991130b5ecd1bea74bf23c3644640e9ecd8d21","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:base-sid","repository":"ghcr.io/tuna-os/flounder","tag":"base-sid"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:896eb8e9ba3cf55aaddf4a269dac24d45e611f57f08819efe4e7aaf43d04d5d9","engineRevision":null,"indexDigest":"sha256:d3e1d5f8cdf8a30d2064fdc5bc93964536fe24ba6b8752ec993420db730ab326","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:589cf253f9828b903804fb87e0991130b5ecd1bea74bf23c3644640e9ecd8d21"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder-sid"},"targetKey":"flounder-sid:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2217485851,"desktop":"gnome","digest":"sha256:10b3f776c4d459c5312e9f31ff315bfa607c17e264fb1cccff2e5ded920e4611","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:gnome-nvidia-sid","repository":"ghcr.io/tuna-os/flounder","tag":"gnome-nvidia-sid"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:b16c2fb79fc8d04a5b8c083ad9ff59d97102c22c448e68314f8d339f959c8b41","engineRevision":null,"indexDigest":"sha256:bf0f5386ccc7ed9d2f3572d2d7881dc6ced2310bc15b5b6754f7cc93a6485151","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:10b3f776c4d459c5312e9f31ff315bfa607c17e264fb1cccff2e5ded920e4611"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder-sid"},"targetKey":"flounder-sid:gnome-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1728783058,"desktop":"gnome","digest":"sha256:1cc18e78a25501781591ddb190682743a10787d46912d62b40c499ce44ac7e3a","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:gnome-sid","repository":"ghcr.io/tuna-os/flounder","tag":"gnome-sid"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:526b554705bcc56b8a4ab7f9757a0d5b09494700392790b9e633c98986fe3da2","engineRevision":null,"indexDigest":"sha256:a190085a74dacf0e309bcbafb011a4b8de4f37051350c924f48d1f2a66ce7ccf","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:1cc18e78a25501781591ddb190682743a10787d46912d62b40c499ce44ac7e3a"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder-sid"},"targetKey":"flounder-sid:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1927695981,"desktop":"kde","digest":"sha256:503bc5b548f0fa0d69479510a57079d6b50d1165c649e2a014aa01d41994b46d","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:kde-nvidia-sid","repository":"ghcr.io/tuna-os/flounder","tag":"kde-nvidia-sid"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:9b92672fb9e7770aad425c636e5e16cad28a103e8876f1eb1bb2af67b2bf8948","engineRevision":null,"indexDigest":"sha256:d8746995d0ddd808ffdb74a62b57596b06f7f45787c32008735a33919bc99fda","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:503bc5b548f0fa0d69479510a57079d6b50d1165c649e2a014aa01d41994b46d"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder-sid"},"targetKey":"flounder-sid:kde-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1394143786,"desktop":"kde","digest":"sha256:64ffc5aff1bc4e73aeb80dd666a7edd162d4a027577c9ff5647032f8a0f31fba","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:kde-sid","repository":"ghcr.io/tuna-os/flounder","tag":"kde-sid"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:4f2c5120027f2262c6ac5c58261d1bc30d5cce99b14b45b3e73394c4d9605f2b","engineRevision":null,"indexDigest":"sha256:f01a717a4d881e7bb176a5d4b92238b7b739f68da4c3e0ed3fbbd4a4f76110ec","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:64ffc5aff1bc4e73aeb80dd666a7edd162d4a027577c9ff5647032f8a0f31fba"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder-sid"},"targetKey":"flounder-sid:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1411313527,"desktop":"tuna","digest":"sha256:803bad2f3548f7696bd558ac276664a4d4492d95daaa167766018131110775a1","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:tuna-sid","repository":"ghcr.io/tuna-os/flounder","tag":"tuna-sid"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:db68fdec3c18ca798c6e832312c24c747a8172f720c30ef9d9e18be9b544b682","engineRevision":null,"indexDigest":"sha256:c7703a82c18b085ec75df496082bd40a2ecfcf96bcaf59a01aa5ba6dad03ac07","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:803bad2f3548f7696bd558ac276664a4d4492d95daaa167766018131110775a1"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"tuna","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder-sid"},"targetKey":"flounder-sid:tuna:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1691997030,"desktop":"xfce","digest":"sha256:a5591352bea0825a9e57dda841e4711c999335783f0f2d93032450d775c9d7b3","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:xfce-nvidia-sid","repository":"ghcr.io/tuna-os/flounder","tag":"xfce-nvidia-sid"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:f3fa68382c6535017f91054f0453bed0d83ada540742c4b90ae9c8eb20b9b351","engineRevision":null,"indexDigest":"sha256:074f8a0754ff789e38b9086b149bf550ad265f18e73a192e529544587290e21e","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:a5591352bea0825a9e57dda841e4711c999335783f0f2d93032450d775c9d7b3"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder-sid"},"targetKey":"flounder-sid:xfce-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1157489147,"desktop":"xfce","digest":"sha256:9c9d551ea88dd12d06d63449698f6f2b709060b0046a7baedb88f8bb457afbb1","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:xfce-sid","repository":"ghcr.io/tuna-os/flounder","tag":"xfce-sid"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:f67a046930fa72aa1868e13885f49c7b559d487f295bcd94eb2e4d05ea1b1221","engineRevision":null,"indexDigest":"sha256:ec21bb895babee6814966aad0b487c4f78e62cc2e184c8d600f130323eda8084","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:9c9d551ea88dd12d06d63449698f6f2b709060b0046a7baedb88f8bb457afbb1"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder-sid"},"targetKey":"flounder-sid:xfce:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1054600486,"desktop":"","digest":"sha256:64960854f9d4bf6f0ff8422edbb9a76f3ea0da7d3f8ba65651bfb0f08123a878","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:base","repository":"ghcr.io/tuna-os/flounder","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:681aadd0d8dd0ababf2bb6fad6f8bd2b742c303d36a94ebe0836998cca25e4be","engineRevision":null,"indexDigest":"sha256:e5a88356d80f8e35a84fc2e68b43a9c93030117a5ae2a5ffbe68770b7c47e68e","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:64960854f9d4bf6f0ff8422edbb9a76f3ea0da7d3f8ba65651bfb0f08123a878"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder"},"targetKey":"flounder:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":995287757,"desktop":"","digest":"sha256:5f7f5a53dc0d1452b326216ef528e0690ca7229c457e47d11354aac6aabff664","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:base","repository":"ghcr.io/tuna-os/flounder","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:a5c241f297ecc1a2e4915f1ce96d92551faa34c9912bfcaf2fececd1c00d37ff","engineRevision":null,"indexDigest":"sha256:e5a88356d80f8e35a84fc2e68b43a9c93030117a5ae2a5ffbe68770b7c47e68e","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:5f7f5a53dc0d1452b326216ef528e0690ca7229c457e47d11354aac6aabff664"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base","hardwareScope":"generic","platform":"linux/arm64","variant":"flounder"},"targetKey":"flounder:base:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1833747809,"desktop":"kde","digest":"sha256:77a56a78b264520026007e772ee163c65544c39d8f6259d0bb8b8b895c4769e5","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:kde-nvidia","repository":"ghcr.io/tuna-os/flounder","tag":"kde-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:8819ac065f9d3c39e447d65b3cc52f61d4862f36e192c52369df7c0504b6eff3","engineRevision":null,"indexDigest":"sha256:e423281a309101691f35ef17ed2011d547fa23c415697e221a0a7c89d73770cb","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:77a56a78b264520026007e772ee163c65544c39d8f6259d0bb8b8b895c4769e5"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder"},"targetKey":"flounder:kde-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1351263343,"desktop":"kde","digest":"sha256:c56c16535e9e4d4c1114c1a60b0d572e62860db954f5fed283875beee9a10ebc","hasSdBoot":true,"kernelVer":"6.12.115+deb13.1-amd64","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:kde","repository":"ghcr.io/tuna-os/flounder","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:1a734111826392e03e382816f8f46748e625eb120f1a480bdc03de5c5c144694","engineRevision":null,"indexDigest":"sha256:76c8589544cbb30ce8885a9536a6a3edb5b59cb5fbc5bad4dc25b8a28b5cbdbc","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:c56c16535e9e4d4c1114c1a60b0d572e62860db954f5fed283875beee9a10ebc"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder"},"targetKey":"flounder:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1353743221,"desktop":"tuna","digest":"sha256:03e7fa676f8cac494e7e8c9257279518d5c4e9f7667e5aaaa7bc6a18d160867c","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:tuna","repository":"ghcr.io/tuna-os/flounder","tag":"tuna"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:1afdf2510c29cafa1fb682c3332abb13cbfa82a27e6b4caaaa0548800a65dc6d","engineRevision":null,"indexDigest":"sha256:2cbda061deb49b794817ebf8b4abb15da39f7f19bfe2710f76dace6fbee8e2fc","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:03e7fa676f8cac494e7e8c9257279518d5c4e9f7667e5aaaa7bc6a18d160867c"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"tuna","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder"},"targetKey":"flounder:tuna:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1603202484,"desktop":"xfce","digest":"sha256:a2ce0f5374b55a3927ad840fd4ca2215e712a84c3065c28022222d8aa3e3d143","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:xfce-nvidia","repository":"ghcr.io/tuna-os/flounder","tag":"xfce-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:c0458723a4d80579e479fe43d41ef48f3ae10b78fe7354369d8ae957c0c737d3","engineRevision":null,"indexDigest":"sha256:527fa10919145c23f1d5398f94ffa8c5db479c3882676e7908185159870634b6","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:a2ce0f5374b55a3927ad840fd4ca2215e712a84c3065c28022222d8aa3e3d143"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder"},"targetKey":"flounder:xfce-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1120741271,"desktop":"xfce","digest":"sha256:5beb5d9d37c8a84656135499108fc5954440acbfb4b6f0f3f95f25e4090ebbac","hasSdBoot":true,"kernelVer":"6.12.115+deb13.1-amd64","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:xfce","repository":"ghcr.io/tuna-os/flounder","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:e6d77d7018f618bc112227abb250ae1a0920cf0c0f66d51fbcc36f39dba2c3c4","engineRevision":null,"indexDigest":"sha256:ccc8597774616b55f527a3c571458a98c9abdbe13acd1c0a3a8e8506c152e45e","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:5beb5d9d37c8a84656135499108fc5954440acbfb4b6f0f3f95f25e4090ebbac"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder"},"targetKey":"flounder:xfce:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1783926216,"desktop":"","digest":"sha256:f71cb9c549980472f7af76fab9c7649022960ad57433564375839d5da71e4d91","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:base","repository":"ghcr.io/tuna-os/grouper","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:4b90e33cf33d9608eac5b447476ea0e26446eed5606969b48b406e0590b254db","engineRevision":null,"indexDigest":"sha256:4db9fff3eaed154c0713c0822306c26a477d4a05b2660d62eed0ad10f2a7c76a","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:f71cb9c549980472f7af76fab9c7649022960ad57433564375839d5da71e4d91"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"grouper"},"targetKey":"grouper:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1779155798,"desktop":"","digest":"sha256:3ba70cbb2d9ba3dc9fb0e38802aab9ff94b09365d25e0acabd689a722660cb7a","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:base","repository":"ghcr.io/tuna-os/grouper","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:71c93dc516d6f21e3ec46ca650f95973c970a5169f63f32c0f7cdc74e4cc0474","engineRevision":null,"indexDigest":"sha256:4db9fff3eaed154c0713c0822306c26a477d4a05b2660d62eed0ad10f2a7c76a","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:3ba70cbb2d9ba3dc9fb0e38802aab9ff94b09365d25e0acabd689a722660cb7a"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base","hardwareScope":"generic","platform":"linux/arm64","variant":"grouper"},"targetKey":"grouper:base:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2102084503,"desktop":"cosmic","digest":"sha256:bd8ea8d41e3ef1a6802d414f0116e6be76e13a56eeae7a2b8b607215e5125094","hasSdBoot":true,"kernelVer":"7.0.0-42-generic","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:cosmic","repository":"ghcr.io/tuna-os/grouper","tag":"cosmic"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:b7a956262396c4047e95fc5ef3048cdedee83e00a6c6c8dc76ea49c74ba43aa4","engineRevision":null,"indexDigest":"sha256:e88a122b2f76be0ecc53e528d7a6f8a329064ae05c7d7084fd06447374a13dc6","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:bd8ea8d41e3ef1a6802d414f0116e6be76e13a56eeae7a2b8b607215e5125094"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic","hardwareScope":"generic","platform":"linux/amd64","variant":"grouper"},"targetKey":"grouper:cosmic:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2103887014,"desktop":"gnome","digest":"sha256:1810e9c37cae7a4e7ef3c3bd271425beb5382ff477538f2a0460a8ace73e6a71","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:gnome-asahi","repository":"ghcr.io/tuna-os/grouper","tag":"gnome-asahi"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:9b3defa4c37ecca826f1ac8fc6f1efad80db8326f147d33993e1cf652d3dba0e","engineRevision":null,"indexDigest":"sha256:bbba7a84b60c0a2bd4627d91cb878fe32cdc1f234bc82a368226b3a136cb6a8a","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:1810e9c37cae7a4e7ef3c3bd271425beb5382ff477538f2a0460a8ace73e6a71"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome-asahi","hardwareScope":"apple-silicon","platform":"linux/arm64","variant":"grouper"},"targetKey":"grouper:gnome-asahi:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2094825444,"desktop":"gnome","digest":"sha256:8b26e22feda92ae36dfe6d402d7cf736d13f532613ea7ce39b7ea7ea24bec98d","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:gnome-zfs","repository":"ghcr.io/tuna-os/grouper","tag":"gnome-zfs"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:ca5cf7ce18996ffc57308bac0f5deb7580e534d88d844fecaab6b0440e7828b2","engineRevision":null,"indexDigest":"sha256:f63d330690acce8853a07860c9e0da4c0942fc39354e4b0519b1e4300e837c32","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:8b26e22feda92ae36dfe6d402d7cf736d13f532613ea7ce39b7ea7ea24bec98d"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-zfs","hardwareScope":"generic","platform":"linux/amd64","variant":"grouper"},"targetKey":"grouper:gnome-zfs:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2085071103,"desktop":"gnome","digest":"sha256:bc9bc9008b3668a97ca63ed0908a7505edb51b324623d5a2525a4a25666b8135","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:gnome-zfs","repository":"ghcr.io/tuna-os/grouper","tag":"gnome-zfs"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:29a75dfb8c2867a362eac9e8b4ab575ea17bfd6c97057e08fb4d6930e12df873","engineRevision":null,"indexDigest":"sha256:f63d330690acce8853a07860c9e0da4c0942fc39354e4b0519b1e4300e837c32","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:bc9bc9008b3668a97ca63ed0908a7505edb51b324623d5a2525a4a25666b8135"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome-zfs","hardwareScope":"generic","platform":"linux/arm64","variant":"grouper"},"targetKey":"grouper:gnome-zfs:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2244748340,"desktop":"gnome","digest":"sha256:205b001be53d207a7a1c6a44b304782f73591fd9185ffdcb4bb3891119f2ba43","hasSdBoot":true,"kernelVer":"7.0.0-43-generic","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:gnome","repository":"ghcr.io/tuna-os/grouper","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:0fdb982080040a320ea8f4a2c58409bc86ff06e1d715bb3a1bbec1607f7b8c3e","engineRevision":null,"indexDigest":"sha256:61ba7b8201d2af80404145adf36faddb67540d4df2e899f16abd35d1831a8a17","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:205b001be53d207a7a1c6a44b304782f73591fd9185ffdcb4bb3891119f2ba43"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"grouper"},"targetKey":"grouper:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2234673596,"desktop":"gnome","digest":"sha256:47767067f42627eac4390c6965a6b7087d3f069ba3eb0c8584e68c44bdbc35de","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:gnome","repository":"ghcr.io/tuna-os/grouper","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:69bdbfd8b230ab8f92ad1fcf6e5010f0aa4e086f0032e20586438e59f2bc982f","engineRevision":null,"indexDigest":"sha256:61ba7b8201d2af80404145adf36faddb67540d4df2e899f16abd35d1831a8a17","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:47767067f42627eac4390c6965a6b7087d3f069ba3eb0c8584e68c44bdbc35de"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome","hardwareScope":"generic","platform":"linux/arm64","variant":"grouper"},"targetKey":"grouper:gnome:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1989337683,"desktop":"kde","digest":"sha256:0244e9940ac13b704fa9c4daf8631b825a82c0c26faafa636080bd79cc3a72cf","hasSdBoot":true,"kernelVer":"7.0.0-42-generic","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:kde","repository":"ghcr.io/tuna-os/grouper","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:add7340f7cf1951470a61fa82f0e61de0749d24d1b35d210731268e2c0e7e18a","engineRevision":null,"indexDigest":"sha256:7cc69fcd639217a9f9ad6c6c6e9cc287dda5c534f07c86c3917d28b24e9c6224","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:0244e9940ac13b704fa9c4daf8631b825a82c0c26faafa636080bd79cc3a72cf"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"grouper"},"targetKey":"grouper:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1982169094,"desktop":"kde","digest":"sha256:f62cc944023dc9aabbabafc48d4f1e367695da14063dc6de4c40100906e9261e","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:kde","repository":"ghcr.io/tuna-os/grouper","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:6d6b3c8019ff1c106f2ed855d54ac2e168189ecaad26c4c66bbc20be861f93e4","engineRevision":null,"indexDigest":"sha256:7cc69fcd639217a9f9ad6c6c6e9cc287dda5c534f07c86c3917d28b24e9c6224","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:f62cc944023dc9aabbabafc48d4f1e367695da14063dc6de4c40100906e9261e"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"kde","hardwareScope":"generic","platform":"linux/arm64","variant":"grouper"},"targetKey":"grouper:kde:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2072815697,"desktop":"tuna","digest":"sha256:10500a10e24d0f4828edb86ea6429e262745c6856d9e607ead64162a74fd8f8c","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:tuna","repository":"ghcr.io/tuna-os/grouper","tag":"tuna"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:6f2e8317df094f80c2693d3cfff7bf38e876f892098af0382afc8995d30f49f6","engineRevision":null,"indexDigest":"sha256:fe8fe55b2005f6705665bc5926232187b01b83a8d2f172a6085e4141c34e5854","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:10500a10e24d0f4828edb86ea6429e262745c6856d9e607ead64162a74fd8f8c"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"tuna","hardwareScope":"generic","platform":"linux/amd64","variant":"grouper"},"targetKey":"grouper:tuna:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1815677010,"desktop":"xfce","digest":"sha256:4cea5db10225536cd4b7dd53a01ceff96ad63d9e77d73059f03f7770c75763fd","hasSdBoot":true,"kernelVer":"7.0.0-42-generic","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:xfce","repository":"ghcr.io/tuna-os/grouper","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:855d7583ee4ee44380eb2f1cd0d1f6d7072e8c3cc9b093c799c876f6c16af475","engineRevision":null,"indexDigest":"sha256:176cfdc40183716cc5ce21524b0dcbeed526d1edf1a911949ea7db0933a2114f","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:4cea5db10225536cd4b7dd53a01ceff96ad63d9e77d73059f03f7770c75763fd"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"grouper"},"targetKey":"grouper:xfce:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1810685099,"desktop":"xfce","digest":"sha256:6ab59fc2b82c1660cb4a2cdf4630010dd3d35f41671af5d02848910051af040a","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:xfce","repository":"ghcr.io/tuna-os/grouper","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:877700875de37bc5107052f61f7fb3fdc491f15ed104b362fbb59f3839fa9f8b","engineRevision":null,"indexDigest":"sha256:176cfdc40183716cc5ce21524b0dcbeed526d1edf1a911949ea7db0933a2114f","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:6ab59fc2b82c1660cb4a2cdf4630010dd3d35f41671af5d02848910051af040a"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"xfce","hardwareScope":"generic","platform":"linux/arm64","variant":"grouper"},"targetKey":"grouper:xfce:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2741166434,"desktop":"","digest":"sha256:974c8713818681bf49fce65bcf2ae784c85e80920a7981ff4209d1196e45bd75","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"emerge","repoFamily":"gentoo"},"publication":{"ref":"ghcr.io/tuna-os/guppy:base","repository":"ghcr.io/tuna-os/guppy","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:f4afa4d2538f0af75d0849b467ad38ffca5539ae8867802fb13a7e0dc9cfb861","engineRevision":null,"indexDigest":"sha256:c4140b2075e7b79bd41be2a495db84904383ad9740f7bcf79ddb2abc0724a5e2","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:974c8713818681bf49fce65bcf2ae784c85e80920a7981ff4209d1196e45bd75"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"guppy"},"targetKey":"guppy:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3030706306,"desktop":"gnome","digest":"sha256:7782d5f103c952f95f967f215b91a82a2f0dc4515ffc1a8e9c4a94c9bf0d1a33","hasSdBoot":true,"kernelVer":"6.18.38-gentoo-dist-bin","layerCount":65,"pkgManager":"emerge","repoFamily":"gentoo"},"publication":{"ref":"ghcr.io/tuna-os/guppy:gnome","repository":"ghcr.io/tuna-os/guppy","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:fbf2ff73d734660184ea2a8513e79075d3304daa8fc04abd845f88d10d9a33c6","engineRevision":null,"indexDigest":"sha256:4b081ef3a24a07be0307066e69d8e4e119c62b3e4416a052e6d152e0517aac61","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:7782d5f103c952f95f967f215b91a82a2f0dc4515ffc1a8e9c4a94c9bf0d1a33"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"guppy"},"targetKey":"guppy:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3695549843,"desktop":"kde","digest":"sha256:869dc28910fa9915903370b463e3c2bc0693372f729200dd223c6d71b7cb9133","hasSdBoot":true,"kernelVer":"6.18.54-gentoo-dist-bin","layerCount":65,"pkgManager":"emerge","repoFamily":"gentoo"},"publication":{"ref":"ghcr.io/tuna-os/guppy:kde","repository":"ghcr.io/tuna-os/guppy","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:60c0612a74970be47c7575c202dcc72cb9dec383fb0818a4043f27ac1b578b1c","engineRevision":null,"indexDigest":"sha256:b1f710c1c3492fb89075acbed717be179fc1d904b973cd4f34247e56b93d7d51","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:869dc28910fa9915903370b463e3c2bc0693372f729200dd223c6d71b7cb9133"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"guppy"},"targetKey":"guppy:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2841523017,"desktop":"xfce","digest":"sha256:989078eed2adb4c5a079a85295b830f68b2e0c48b82867c058f18ccfcf63059e","hasSdBoot":true,"kernelVer":"6.18.57-gentoo-dist-bin","layerCount":65,"pkgManager":"emerge","repoFamily":"gentoo"},"publication":{"ref":"ghcr.io/tuna-os/guppy:xfce","repository":"ghcr.io/tuna-os/guppy","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:bc6d3e1c25eadc6b6bff26dccc3dfbdfc2315cdcffcb13730c65abc40cf442b5","engineRevision":null,"indexDigest":"sha256:a16a3b45ff605d73e06a6e83a073d68a548203a0c6148f853e1413e10b6e08a6","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:989078eed2adb4c5a079a85295b830f68b2e0c48b82867c058f18ccfcf63059e"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"guppy"},"targetKey":"guppy:xfce:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1579802937,"desktop":"","digest":"sha256:ae3f05f339c0da0193fd709ac46ee7b44978ad3caa3f40b5b360256144941676","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/gurnard:base","repository":"ghcr.io/tuna-os/gurnard","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:e6f06f8eccb33b8aa266476d42be62de13630b809ce07675f4abfec0c795fe56","engineRevision":null,"indexDigest":"sha256:7bbbb33c9b6af72bf63f2c941b79accc887970bb953a0af5d482682f48ea1365","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:ae3f05f339c0da0193fd709ac46ee7b44978ad3caa3f40b5b360256144941676"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"gurnard"},"targetKey":"gurnard:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1541676008,"desktop":"","digest":"sha256:3ac08820852122a4754fba0289e873974ee298bd129601a1950255602dfb08f4","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/gurnard:base","repository":"ghcr.io/tuna-os/gurnard","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:a25c19f31bfcbf8084e9e70dc13b3c2f7c125ed159fd5cc539f23b2ca194a51c","engineRevision":null,"indexDigest":"sha256:7bbbb33c9b6af72bf63f2c941b79accc887970bb953a0af5d482682f48ea1365","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:3ac08820852122a4754fba0289e873974ee298bd129601a1950255602dfb08f4"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base","hardwareScope":"generic","platform":"linux/arm64","variant":"gurnard"},"targetKey":"gurnard:base:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1650372435,"desktop":"pantheon","digest":"sha256:bfb7865d0a1fb48bdf1253d738d4b168ac72ec6859406d9c966c47e7060a33c2","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/gurnard:pantheon","repository":"ghcr.io/tuna-os/gurnard","tag":"pantheon"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:3e47745628603f7b200d300f89a80f3037883e5b3e4af71c7c15c220efb1e4cf","engineRevision":null,"indexDigest":"sha256:576fbabbb6217934768389e570383f683cd250751deef1dd199b141b45c7c1bc","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:bfb7865d0a1fb48bdf1253d738d4b168ac72ec6859406d9c966c47e7060a33c2"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"pantheon","hardwareScope":"generic","platform":"linux/amd64","variant":"gurnard"},"targetKey":"gurnard:pantheon:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1611077116,"desktop":"pantheon","digest":"sha256:73bd2e1fabc208ce6c39749efbfbdd838fb0927143cafe2921810d1f7459129e","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/gurnard:pantheon","repository":"ghcr.io/tuna-os/gurnard","tag":"pantheon"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:0c26173a3eb553105731caf6c00b2e73c28abd83f9a85f2931604f72591fe46b","engineRevision":null,"indexDigest":"sha256:576fbabbb6217934768389e570383f683cd250751deef1dd199b141b45c7c1bc","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:73bd2e1fabc208ce6c39749efbfbdd838fb0927143cafe2921810d1f7459129e"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"pantheon","hardwareScope":"generic","platform":"linux/arm64","variant":"gurnard"},"targetKey":"gurnard:pantheon:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":841052241,"desktop":"","digest":"sha256:4ae00c3b2a21db49630015332dd9080a0b4b59d0dce91bd91080c2e661fb3565","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/hummingbird:base","repository":"ghcr.io/tuna-os/hummingbird","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:a24bb8429ce27d573bdb576af66f22affc70890bcfbfafe93f8fa3bc01a61814","engineRevision":null,"indexDigest":"sha256:91af0af348f90052f8831029d59da49683bb57eb1573e82ed933ae64cc1b1cc5","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:4ae00c3b2a21db49630015332dd9080a0b4b59d0dce91bd91080c2e661fb3565"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"hummingbird"},"targetKey":"hummingbird:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1193415389,"desktop":"gnome","digest":"sha256:04360b52392abab53704043393fd758b9f343a242a2fdab4d349da93f9f533f0","hasSdBoot":false,"kernelVer":"7.1.8-100.fc43.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/hummingbird:cosmic","repository":"ghcr.io/tuna-os/hummingbird","tag":"cosmic"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:84f342bb8f3576762e66b095fb780742e16a5238ee1c8ce8a3e5dd607a629545","engineRevision":null,"indexDigest":"sha256:ede5242ee8e235933dd4866c3619e055cbd820300fe3d9807feecfe4f7fcc4ba","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:04360b52392abab53704043393fd758b9f343a242a2fdab4d349da93f9f533f0"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic","hardwareScope":"generic","platform":"linux/amd64","variant":"hummingbird"},"targetKey":"hummingbird:cosmic:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1718947608,"desktop":"gnome","digest":"sha256:83060f29b37743b0086e88546ac1b223e2373ae7f23fe0a8dc68a37c92cee6d2","hasSdBoot":false,"kernelVer":"7.2.8-200.fc44.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/hummingbird:gnome","repository":"ghcr.io/tuna-os/hummingbird","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:7b4273fe1a503cc7c4cbdf2e2ec35ab1c7de246a184436f157e4e58f9e7a9ebb","engineRevision":null,"indexDigest":"sha256:7fb82c04e8dfa63d76299dd07f2d82ea3c832485f913840fd88d56ea472411dd","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:83060f29b37743b0086e88546ac1b223e2373ae7f23fe0a8dc68a37c92cee6d2"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"hummingbird"},"targetKey":"hummingbird:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1632747716,"desktop":"","digest":"sha256:c7617c15b3e759794e46b3adbc1b3d6bf77c21e280aa117f920c3ed2f2aa1d3e","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:base","repository":"ghcr.io/tuna-os/marlin","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:ca86eeb7a3798edb271c92baaee1b44be9c7a68e2221ec1869969c4d90f1df0f","engineRevision":null,"indexDigest":"sha256:1ecf85cdcabc23cda69223baba005bd5482f098fb8cda047ea8c7e067e3ad5b1","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:c7617c15b3e759794e46b3adbc1b3d6bf77c21e280aa117f920c3ed2f2aa1d3e"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1502011395,"desktop":"","digest":"sha256:9d9c9e13576c155bb61715e87f656c2fc71920311371e81c1064057b65c19577","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:base","repository":"ghcr.io/tuna-os/marlin","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:1065ca036f2899cb057e4d60f9edde5fd74346cd405ba120d3c2460e3dab1f47","engineRevision":null,"indexDigest":"sha256:1ecf85cdcabc23cda69223baba005bd5482f098fb8cda047ea8c7e067e3ad5b1","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:9d9c9e13576c155bb61715e87f656c2fc71920311371e81c1064057b65c19577"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base","hardwareScope":"generic","platform":"linux/arm64","variant":"marlin"},"targetKey":"marlin:base:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2984358428,"desktop":"cosmic","digest":"sha256:de5f37a9ecbe3a48762169c72ed4c07ac1ecdef0aca2e922737636b8764f622a","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:cosmic-cachyos","repository":"ghcr.io/tuna-os/marlin","tag":"cosmic-cachyos"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:d1f03a5fb58ab220e359cdff4122fba1acf23e66b3877625b14c1912d5bb5a5b","engineRevision":null,"indexDigest":"sha256:d5691d13da640dbd32255dcb19f3d58f8728bdc08acc0ac8ec03342a212e64dd","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:de5f37a9ecbe3a48762169c72ed4c07ac1ecdef0aca2e922737636b8764f622a"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic-cachyos","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:cosmic-cachyos:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3560147719,"desktop":"cosmic","digest":"sha256:f344270692ee02f899e7ad90189e79546baaee65c5573e22136030098510fb9c","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:cosmic-nvidia","repository":"ghcr.io/tuna-os/marlin","tag":"cosmic-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:1493f02f0b852ace7f03aefe7f42c2fbf7eca81ed07aef686edf33704133f15f","engineRevision":null,"indexDigest":"sha256:0dc80366255e85dd97cc014319757ab42895c7cac43ea30fbd1ae6921c1c0c78","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:f344270692ee02f899e7ad90189e79546baaee65c5573e22136030098510fb9c"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:cosmic-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2359025192,"desktop":"cosmic","digest":"sha256:aff2158af89874b365e1030f74ff2a56178e7a411ed8fc831b0d9fe0faecfa18","hasSdBoot":true,"kernelVer":"7.2.14-arch1-1","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:cosmic","repository":"ghcr.io/tuna-os/marlin","tag":"cosmic"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:00881f54eacd7ac50c6a1bc1640bf0365204e23002333a8cb7ee6543e6137e31","engineRevision":null,"indexDigest":"sha256:bb97e50f458e862639147613b29bf7788ef192de4ea53a32cf2013b4764084cc","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:aff2158af89874b365e1030f74ff2a56178e7a411ed8fc831b0d9fe0faecfa18"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:cosmic:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3053440711,"desktop":"gnome","digest":"sha256:77147c0aa418ba3ea2090f7edae157333f7776d3fdebe85442ee7dfdf9112a2d","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:gnome-cachyos","repository":"ghcr.io/tuna-os/marlin","tag":"gnome-cachyos"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:d3b8e6a04a3adcf1bc21fa07b86a7720f39a1f137fc48369ae27090a59a346f3","engineRevision":null,"indexDigest":"sha256:24abf98f441a263fe938f2a5512589d1269b22f7b82830ec56c2a3da87c9d939","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:77147c0aa418ba3ea2090f7edae157333f7776d3fdebe85442ee7dfdf9112a2d"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-cachyos","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:gnome-cachyos:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3627479487,"desktop":"gnome","digest":"sha256:16827a87c133799463a5c2717e99a7441e4ea086c3a3b4911841865bb9b007be","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:gnome-nvidia","repository":"ghcr.io/tuna-os/marlin","tag":"gnome-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:800fdda202ab00123d8088942cf9800fcc17ea06a60636750d9465ebd683a13c","engineRevision":null,"indexDigest":"sha256:3a6633a8adcc334f30f1cddf9346d27681e0033a89d29cdc16f7b54e343db0b4","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:16827a87c133799463a5c2717e99a7441e4ea086c3a3b4911841865bb9b007be"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:gnome-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2907593907,"desktop":"gnome","digest":"sha256:102d1c3b9a9f04bc48a3cd5ae97e266631c0e7c7d55a60a187254258d954abf0","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:gnome-x13s","repository":"ghcr.io/tuna-os/marlin","tag":"gnome-x13s"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:49d67afc9ed32c17afc6bce2bfaa3fb3f1ab03b6c3188f8adcbeec2541bef2f0","engineRevision":null,"indexDigest":"sha256:bf2b234bd33e575be6344b5fa06baac19bb03e7352b412e70380f5de566f95b3","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:102d1c3b9a9f04bc48a3cd5ae97e266631c0e7c7d55a60a187254258d954abf0"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome-x13s","hardwareScope":"generic","platform":"linux/arm64","variant":"marlin"},"targetKey":"marlin:gnome-x13s:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2408117507,"desktop":"gnome","digest":"sha256:b71d6ab6e652624676803bfc2f04b985a88c48aa138be84eef42fe5a222d83eb","hasSdBoot":true,"kernelVer":"7.2.14-arch1-1","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:gnome","repository":"ghcr.io/tuna-os/marlin","tag":"gnome"},"qualification":{"browser":null,"browserBuildReceiptDigest":null,"buildOrigin":"browser","isoDigest":"sha256:d25cd3b19f1a07a325e531a9aa6a76c8154f848028f305e6234aa5ad3ccd85a9","producer":{"ref":"refs/heads/main","repository":"tuna-os/iso-builder","runAttempt":1,"runId":42193686727,"sha":"e4ea9748a0f9bea4d800465f51fec9e72c96b42c","workflow":".github/workflows/ci.yml"},"qualifiedAt":"2026-11-06T10:52:25Z","reason":null,"receiptDigest":"sha256:b498c186bd64b6de251b70dddb329ad90021f53d85d795009cb68f6667085dd8","receiptImageDigest":"sha256:b71d6ab6e652624676803bfc2f04b985a88c48aa138be84eef42fe5a222d83eb","receiptPlatform":"linux/amd64","receiptSchema":"BrowserIsoQualificationReceipt/v1","resources":null,"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:9e1990c1a2fc2615bce8eba94ebe29bbf949278310626b7e77364b553faa7080","engineRevision":"sha256:ca5a07efa6b4dbb145d15c32a777de34c3d9a984f83f6fe8e236ffe5a9038aad","indexDigest":"sha256:244496340ec984f13ce038ca195ad724f5505cfb7cc415af80776ea8def5d0d1","installerRevision":"sha256:ff28c254d0f0c3fc303cdcd2d7cae1632a55e6f92f1f887c4c6f00559d82417b","liveOverlayBaseDigest":"sha256:b71d6ab6e652624676803bfc2f04b985a88c48aa138be84eef42fe5a222d83eb","liveOverlayDigest":"sha256:8317c1621a3a569553317f157a742cb19973e17cd4eb861168eba4e1a401ae61","platformManifestDigest":"sha256:b71d6ab6e652624676803bfc2f04b985a88c48aa138be84eef42fe5a222d83eb"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2368545094,"desktop":"gnome","digest":"sha256:1ad37f7a35d35cd47e3307e3cf65609d5771988dc80f50c95e757b53e8dda703","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:gnome","repository":"ghcr.io/tuna-os/marlin","tag":"gnome"},"qualification":{"browser":null,"browserBuildReceiptDigest":null,"buildOrigin":"browser","isoDigest":"sha256:d25cd3b19f1a07a325e531a9aa6a76c8154f848028f305e6234aa5ad3ccd85a9","producer":{"ref":"refs/heads/main","repository":"tuna-os/iso-builder","runAttempt":1,"runId":42193686727,"sha":"e4ea9748a0f9bea4d800465f51fec9e72c96b42c","workflow":".github/workflows/ci.yml"},"qualifiedAt":"2026-11-06T10:52:25Z","reason":null,"receiptDigest":"sha256:b498c186bd64b6de251b70dddb329ad90021f53d85d795009cb68f6667085dd8","receiptImageDigest":"sha256:b71d6ab6e652624676803bfc2f04b985a88c48aa138be84eef42fe5a222d83eb","receiptPlatform":"linux/amd64","receiptSchema":"BrowserIsoQualificationReceipt/v1","resources":null,"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:b4ea7d47af0dd6b4b3647737c80b5de09dd3d2f05e851380050c702c24405594","engineRevision":null,"indexDigest":"sha256:244496340ec984f13ce038ca195ad724f5505cfb7cc415af80776ea8def5d0d1","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:1ad37f7a35d35cd47e3307e3cf65609d5771988dc80f50c95e757b53e8dda703"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome","hardwareScope":"generic","platform":"linux/arm64","variant":"marlin"},"targetKey":"marlin:gnome:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3013775436,"desktop":"kde","digest":"sha256:1c3739940f43230280a7edcce1a67b833fcb9df21b62a2992578f12aea721cf9","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:kde-cachyos","repository":"ghcr.io/tuna-os/marlin","tag":"kde-cachyos"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:f771a65e741b2a90963c2849a9b358fb37dc25d9636713b3ab31ea818c4a6ec9","engineRevision":null,"indexDigest":"sha256:7a02c2d421abece090cfae013ab2d033cd5ae914742484eaaa51f85648b978dd","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:1c3739940f43230280a7edcce1a67b833fcb9df21b62a2992578f12aea721cf9"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde-cachyos","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:kde-cachyos:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3589759070,"desktop":"kde","digest":"sha256:0a919ae62be303e2c5c8a3c1eb95fbf8aa09de3a6186a2bca64442f116a007cf","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:kde-nvidia","repository":"ghcr.io/tuna-os/marlin","tag":"kde-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:79737a4e91f7cc890c962e631a9d02d2958598950f1374fe78f2053dd179e8a4","engineRevision":null,"indexDigest":"sha256:fbc6a9e79635313649a45af8a86c0b3bc8b5e5f1c685e6f40b84ea93a4ecfd92","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:0a919ae62be303e2c5c8a3c1eb95fbf8aa09de3a6186a2bca64442f116a007cf"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:kde-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2369249538,"desktop":"kde","digest":"sha256:3bd41d6235573f804ef6af11a6dbb66446b044f98e750fa94f4b61005c5485fd","hasSdBoot":true,"kernelVer":"7.2.14-arch1-1","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:kde","repository":"ghcr.io/tuna-os/marlin","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:7e60911740e3cb1ceefd63999c1d2d5995e307a84c6932114efaa99e3ccc4649","engineRevision":null,"indexDigest":"sha256:81e5f8400fe630643593a85800b252a832451804587eefba864ccc80428a82fa","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:3bd41d6235573f804ef6af11a6dbb66446b044f98e750fa94f4b61005c5485fd"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2536849745,"desktop":"niri","digest":"sha256:153332dc9d5bd46ddcfa2be9e2ca88f12f1a7577b5de7aeedda5ef4ebf62a826","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:niri-cachyos","repository":"ghcr.io/tuna-os/marlin","tag":"niri-cachyos"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:00685c741db2d87f01588b3990523d9a4b6702ed864001be2637a32456da50ba","engineRevision":null,"indexDigest":"sha256:d1ac4c459af1f7196fdb11e6c524168c097f19dc5851c0b5ee98df86610001db","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:153332dc9d5bd46ddcfa2be9e2ca88f12f1a7577b5de7aeedda5ef4ebf62a826"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri-cachyos","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:niri-cachyos:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3113511142,"desktop":"niri","digest":"sha256:288c868dce5f64791b17f54769adfa9874dc94be225e597e82c2d27890bb5a89","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:niri-nvidia","repository":"ghcr.io/tuna-os/marlin","tag":"niri-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:4f0a6c20f60775a29dce4f62e5b55707a8fe1f5e4fecdaa1d86adac047d3f2e4","engineRevision":null,"indexDigest":"sha256:cf056fab68258a1ec211397224276504bc05681434be9758e4abd6786d2f7fd6","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:288c868dce5f64791b17f54769adfa9874dc94be225e597e82c2d27890bb5a89"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:niri-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1912506894,"desktop":"niri","digest":"sha256:3f48487b0cbf455f4fa19992bf28433686484c2b355ebb5caaf0ecd19af9866c","hasSdBoot":true,"kernelVer":"7.2.14-arch1-1","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:niri","repository":"ghcr.io/tuna-os/marlin","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:e2335b4f7a3987d51a5239dd69757875de9273e92fa2569cca7282d730eba77d","engineRevision":null,"indexDigest":"sha256:bf92dfd143be1ac6531b428adf3bfb2fd3d00037a0e7d58e882f67e6fc35155e","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:3f48487b0cbf455f4fa19992bf28433686484c2b355ebb5caaf0ecd19af9866c"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:niri:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2324807392,"desktop":"tuna","digest":"sha256:bf9abbc7518022e9c332dfa15724999bcc2f1a7c81546c6a2c0585ab28dc1186","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:tuna","repository":"ghcr.io/tuna-os/marlin","tag":"tuna"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:a007b3fbf82d15a3a44ac8dcb8808c27225797e81ac8e7defec1dcdda9fc82d8","engineRevision":null,"indexDigest":"sha256:925275483d66a441e8a1b8c2296022244a0d5664051c46e6655ae357eb45ba71","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:bf9abbc7518022e9c332dfa15724999bcc2f1a7c81546c6a2c0585ab28dc1186"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"tuna","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:tuna:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2662546951,"desktop":"xfce","digest":"sha256:84cca0d48a3d9f88980feb7dc5c9ca7f934a606cad937a798cbec38917d53cca","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:xfce-cachyos","repository":"ghcr.io/tuna-os/marlin","tag":"xfce-cachyos"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:8ac5e32b5985e182266443fd382055401cc01d0512f66e0fc291de8bba2199b8","engineRevision":null,"indexDigest":"sha256:975b73f2013d8aada1524efb2dd98bb341a3cc29bcb024de4cbdd702159aa09c","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:84cca0d48a3d9f88980feb7dc5c9ca7f934a606cad937a798cbec38917d53cca"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce-cachyos","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:xfce-cachyos:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3238397469,"desktop":"xfce","digest":"sha256:825ed0d819744881d3634e7542746f8f6953398321ecf6bc8365de5472ed3f5a","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:xfce-nvidia","repository":"ghcr.io/tuna-os/marlin","tag":"xfce-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:c1f7150a1c51bb54c97ff5a6e2942476e47ca5311a7f5a93a66d83f1b83781b1","engineRevision":null,"indexDigest":"sha256:0196b296c6a0a4c3ba7a789327fc09e75aaa23adad4a40134f5e2b1d84224fc6","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:825ed0d819744881d3634e7542746f8f6953398321ecf6bc8365de5472ed3f5a"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:xfce-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2037196632,"desktop":"xfce","digest":"sha256:3f9833cc2c1c2bc8cc528e5e6808105ece1a866989739209fe086c2f8e1e1246","hasSdBoot":true,"kernelVer":"7.2.14-arch1-1","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:xfce","repository":"ghcr.io/tuna-os/marlin","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:39f8dad471e8e2c3c5e69caba9eaa3dcf616650e273931de92c94f4464857fb6","engineRevision":null,"indexDigest":"sha256:bf326d0f965b1f0d4a83f0e1a4a18244194b1297d7233f22b59651387804f465","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:3f9833cc2c1c2bc8cc528e5e6808105ece1a866989739209fe086c2f8e1e1246"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:xfce:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1490112716,"desktop":"","digest":"sha256:05fb7334c3c4fdf10e228be12eda4e87b201bee4369cf8c5afb97e1ab0e671a6","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"zypper","repoFamily":"opensuse"},"publication":{"ref":"ghcr.io/tuna-os/sailfin:base","repository":"ghcr.io/tuna-os/sailfin","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:04d4009c85f1cb50bdb5d8bd1a1d486b168ecaf399622a2d6fdedc7c2efca23c","engineRevision":null,"indexDigest":"sha256:164b75a63e431cb3fcd72584be9d4d94b369d3c80ce1ed17f462cb5fa4e6c040","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:05fb7334c3c4fdf10e228be12eda4e87b201bee4369cf8c5afb97e1ab0e671a6"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"sailfin"},"targetKey":"sailfin:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1517450750,"desktop":"","digest":"sha256:93ec1517d81526c870d163a2b0b92085f1206e3b3113cd7fe85375816eacb1cd","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"zypper","repoFamily":"opensuse"},"publication":{"ref":"ghcr.io/tuna-os/sailfin:base","repository":"ghcr.io/tuna-os/sailfin","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:5cefc6a5b203520ed6dabb4382de5dfa3ef98537757352ab47e75cbc183e8efa","engineRevision":null,"indexDigest":"sha256:164b75a63e431cb3fcd72584be9d4d94b369d3c80ce1ed17f462cb5fa4e6c040","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:93ec1517d81526c870d163a2b0b92085f1206e3b3113cd7fe85375816eacb1cd"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base","hardwareScope":"generic","platform":"linux/arm64","variant":"sailfin"},"targetKey":"sailfin:base:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1755569978,"desktop":"cosmic","digest":"sha256:63bc027218662f76d00cca4589094567a2ce7d6d048317dfcfa9f3bf1abbbe6c","hasSdBoot":true,"kernelVer":"7.3.0-1-default","layerCount":65,"pkgManager":"zypper","repoFamily":"opensuse"},"publication":{"ref":"ghcr.io/tuna-os/sailfin:cosmic","repository":"ghcr.io/tuna-os/sailfin","tag":"cosmic"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:567f161a6b8bc03d52b029e115b978a33016731a569a53c3112ff62d9e035df2","engineRevision":null,"indexDigest":"sha256:0d71630181de1c257be7f73014bf6c3c163f3da5ccb72931f20830bc68485145","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:63bc027218662f76d00cca4589094567a2ce7d6d048317dfcfa9f3bf1abbbe6c"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic","hardwareScope":"generic","platform":"linux/amd64","variant":"sailfin"},"targetKey":"sailfin:cosmic:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1880566871,"desktop":"gnome","digest":"sha256:4f9c8426674a92a495eed88c0ad2330ddf8097d0407cbe03cec4f7d9b27f02a0","hasSdBoot":true,"kernelVer":"7.3.0-1-default","layerCount":65,"pkgManager":"zypper","repoFamily":"opensuse"},"publication":{"ref":"ghcr.io/tuna-os/sailfin:gnome","repository":"ghcr.io/tuna-os/sailfin","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:840b0d322d544c26895a6a24c4ab358196c8b7c874c07440a226651577c15620","engineRevision":null,"indexDigest":"sha256:a81977c06da70d82ea1be16d64270716783a97e4140d619a370dfcdee4155f55","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:4f9c8426674a92a495eed88c0ad2330ddf8097d0407cbe03cec4f7d9b27f02a0"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"sailfin"},"targetKey":"sailfin:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1890107846,"desktop":"gnome","digest":"sha256:a433dc6349e45669372f02198bba757f8c0fbfab43af7102a53dda545bcafc74","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"zypper","repoFamily":"opensuse"},"publication":{"ref":"ghcr.io/tuna-os/sailfin:gnome","repository":"ghcr.io/tuna-os/sailfin","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:57a5662dba4f32183c7938e50e5a2660d86e01eec6720c7f35a050616b6a736f","engineRevision":null,"indexDigest":"sha256:a81977c06da70d82ea1be16d64270716783a97e4140d619a370dfcdee4155f55","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:a433dc6349e45669372f02198bba757f8c0fbfab43af7102a53dda545bcafc74"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome","hardwareScope":"generic","platform":"linux/arm64","variant":"sailfin"},"targetKey":"sailfin:gnome:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2273754357,"desktop":"kde","digest":"sha256:728201ccdabcb2bf9f8b0f22c893d20bcd96dca78421fc1220e931ed259cac3b","hasSdBoot":true,"kernelVer":"7.3.0-1-default","layerCount":65,"pkgManager":"zypper","repoFamily":"opensuse"},"publication":{"ref":"ghcr.io/tuna-os/sailfin:kde","repository":"ghcr.io/tuna-os/sailfin","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:7e610aa15d6852322807d24e69209b5b1e256a5a58a37322c3c0d1f2dd90e208","engineRevision":null,"indexDigest":"sha256:0ae52e1bc946869cac29967859703f08548edcfb9ffad04ce737196c0cd2950b","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:728201ccdabcb2bf9f8b0f22c893d20bcd96dca78421fc1220e931ed259cac3b"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"sailfin"},"targetKey":"sailfin:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1638440369,"desktop":"niri","digest":"sha256:7a2b159ab59919165583692e7452a1f40c06831c9288c8483076c71e3a6cc71e","hasSdBoot":true,"kernelVer":"7.3.0-1-default","layerCount":65,"pkgManager":"zypper","repoFamily":"opensuse"},"publication":{"ref":"ghcr.io/tuna-os/sailfin:niri","repository":"ghcr.io/tuna-os/sailfin","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:8df0839c002ea101114a36dbdbd1d04ba470bc1da1f60ffe4e4ae99013b1f5b4","engineRevision":null,"indexDigest":"sha256:93e887d2cb04435f4cb4669b5fc790dca917162ccfe0594a5ebdc6b60cc7fe8f","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:7a2b159ab59919165583692e7452a1f40c06831c9288c8483076c71e3a6cc71e"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri","hardwareScope":"generic","platform":"linux/amd64","variant":"sailfin"},"targetKey":"sailfin:niri:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1784629254,"desktop":"tuna","digest":"sha256:1d35c234e210c5174b7ed7f8f9e65eec631f4acd6329deea148176894d95ba97","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"zypper","repoFamily":"opensuse"},"publication":{"ref":"ghcr.io/tuna-os/sailfin:tuna","repository":"ghcr.io/tuna-os/sailfin","tag":"tuna"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:d306062ae645b35d6745c93cf44b7ffa25510596a4af69f4f609581c11ba3046","engineRevision":null,"indexDigest":"sha256:34017524f8e2ecf018386a8ca415e333e9ccb88360c0de1bb39a2ca7a4217dca","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:1d35c234e210c5174b7ed7f8f9e65eec631f4acd6329deea148176894d95ba97"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"tuna","hardwareScope":"generic","platform":"linux/amd64","variant":"sailfin"},"targetKey":"sailfin:tuna:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1693336538,"desktop":"xfce","digest":"sha256:8c3835c7deb50d915470b231fd51291933548343d123f5c733c75b0f644c25ef","hasSdBoot":true,"kernelVer":"7.3.0-1-default","layerCount":65,"pkgManager":"zypper","repoFamily":"opensuse"},"publication":{"ref":"ghcr.io/tuna-os/sailfin:xfce","repository":"ghcr.io/tuna-os/sailfin","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:1e9b57de6c8d1e531435c32e0ce26aedd23cc1e9a46b91ff64dcff10b1d644b3","engineRevision":null,"indexDigest":"sha256:8a91cc093dfd297391e2082983db91c103d7de8728f3ab99c20d57d92f71cebe","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:8c3835c7deb50d915470b231fd51291933548343d123f5c733c75b0f644c25ef"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"sailfin"},"targetKey":"sailfin:xfce:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1530989429,"desktop":"","digest":"sha256:9a7425d3d90c0ef786dd207365b5ec64c66c36e3e2be9fdc52601a0b9300679e","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:base-hwe","repository":"ghcr.io/tuna-os/skipjack","tag":"base-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:cab6f6037ba641574becfe9778f30e3151ad07813fefbfea37f573547c8d2d94","engineRevision":null,"indexDigest":"sha256:367603cc98e8c04de6652e7bc9df52924457a77671e67ff4ff60f46499decc6f","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:9a7425d3d90c0ef786dd207365b5ec64c66c36e3e2be9fdc52601a0b9300679e"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"base-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:base-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1429900368,"desktop":"","digest":"sha256:59d59426a23f5814fcbda794385b9e74468f4379ccff92a69f7b0ec81db3bbc0","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:base-hwe","repository":"ghcr.io/tuna-os/skipjack","tag":"base-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:bc3fbcbc7de1269c7b5bb3b1eb6f21f3f692687832c681c270b8b10584cd42e5","engineRevision":null,"indexDigest":"sha256:367603cc98e8c04de6652e7bc9df52924457a77671e67ff4ff60f46499decc6f","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:59d59426a23f5814fcbda794385b9e74468f4379ccff92a69f7b0ec81db3bbc0"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"skipjack"},"targetKey":"skipjack:base-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2167964072,"desktop":"","digest":"sha256:54835ccf0180c1e04d03ce0e208bf91d0e3dc2444393c181e4f466ea2dc6e958","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:base-nvidia","repository":"ghcr.io/tuna-os/skipjack","tag":"base-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:e0581aad1e4933979385661ca89721b3515dc2addb5cf927122c06bdea7d2962","engineRevision":null,"indexDigest":"sha256:3e18b99f92ef0d9749d3abc0166f4bb2aed6d71c4d7e55a88e5638226d77f65b","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:54835ccf0180c1e04d03ce0e208bf91d0e3dc2444393c181e4f466ea2dc6e958"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"base-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:base-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1497237526,"desktop":"","digest":"sha256:03d81c6219a7c4596c093b004d168b6169e5aee478410c9501c389dc87e62c4e","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:base","repository":"ghcr.io/tuna-os/skipjack","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:6f57c04912a38f465be2770a3a56cb46a2a4b8cc2ed9101f802f21e72432b06a","engineRevision":null,"indexDigest":"sha256:8b04f1d9667db42df0b5c61eea373548b5f3c4b1b3c986ed88f02ca3ddaa76ca","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:03d81c6219a7c4596c093b004d168b6169e5aee478410c9501c389dc87e62c4e"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1394497328,"desktop":"","digest":"sha256:e04cafbd6607020e79c9efed86397f62e525f95601b61539c2dadd47bbf62b64","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:base","repository":"ghcr.io/tuna-os/skipjack","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:ddf2bd35e761c6235e3ad07924aa105799785bbcda798eb1297e328237bf7a65","engineRevision":null,"indexDigest":"sha256:8b04f1d9667db42df0b5c61eea373548b5f3c4b1b3c986ed88f02ca3ddaa76ca","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:e04cafbd6607020e79c9efed86397f62e525f95601b61539c2dadd47bbf62b64"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base","hardwareScope":"generic","platform":"linux/arm64","variant":"skipjack"},"targetKey":"skipjack:base:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1906520574,"desktop":"cosmic","digest":"sha256:acc5cb1d57022a1811af33c63c7f60d4741935ac7b7fee848b50eae677887e77","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:cosmic-hwe","repository":"ghcr.io/tuna-os/skipjack","tag":"cosmic-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:45623f4c415d855b4d99a4c08743d867d57a02dcb0cd2f04de9a19c5a2cfc476","engineRevision":null,"indexDigest":"sha256:2e5efc15325bbc079e419f7fda86c6820e3a692354775438fb246697afbca444","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:acc5cb1d57022a1811af33c63c7f60d4741935ac7b7fee848b50eae677887e77"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"cosmic-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:cosmic-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2543915088,"desktop":"cosmic","digest":"sha256:09b9ee919d0906928023bf9ec6bde4b2f3cf2937dc997e0c529924919bcbec76","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:cosmic-nvidia","repository":"ghcr.io/tuna-os/skipjack","tag":"cosmic-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:de2f663be35cf0c3054a2ca29e38cb20979b2607544907f7f28ec75a35b43c4b","engineRevision":null,"indexDigest":"sha256:6f47d2286eaaa37c901d41c3062e269de42d187d63f77614ad92e24b97f8fcfe","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:09b9ee919d0906928023bf9ec6bde4b2f3cf2937dc997e0c529924919bcbec76"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"cosmic-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:cosmic-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1906501781,"desktop":"cosmic","digest":"sha256:fbd97c08f3108ec9368e2b8b8908be2fda49a1786a7e4f19875b46c1ec34fb6f","hasSdBoot":false,"kernelVer":"6.12.0-280.el10.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:cosmic","repository":"ghcr.io/tuna-os/skipjack","tag":"cosmic"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:651911b196665f5c9d98a1f152e26da7ef60effaf7f5cb322a366007347d340d","engineRevision":null,"indexDigest":"sha256:2e762b6749815d05c075ba77405e391a6a4ec181962da893a70ded208df84f68","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:fbd97c08f3108ec9368e2b8b8908be2fda49a1786a7e4f19875b46c1ec34fb6f"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"cosmic","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:cosmic:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1890586954,"desktop":"gnome","digest":"sha256:b4c44d7ab48667c16fcf43585e401460e9800a5520d7fba6ee8b557aafb78aac","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:gnome-hwe","repository":"ghcr.io/tuna-os/skipjack","tag":"gnome-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:4aab5b939a7bf431eb471aaaf4c6e33ece226a8c7b685bea1a66f794d1e68282","engineRevision":null,"indexDigest":"sha256:b2bc2aa4625ca5d58b5ac11241337b2562343f28bcade2cc72b83bdc93b71103","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:b4c44d7ab48667c16fcf43585e401460e9800a5520d7fba6ee8b557aafb78aac"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"gnome-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:gnome-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1890587594,"desktop":"gnome","digest":"sha256:75169cece4ccd8f1a6ca5d05c8af1af64e6ed8ce52603079d7835970931b3e39","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:gnome-hwe","repository":"ghcr.io/tuna-os/skipjack","tag":"gnome-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:780e2e76d48e637e4b7f1f8e6ff9a06ab18982e793dc7f6d6e40ef7e0abc9b7e","engineRevision":null,"indexDigest":"sha256:b2bc2aa4625ca5d58b5ac11241337b2562343f28bcade2cc72b83bdc93b71103","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:75169cece4ccd8f1a6ca5d05c8af1af64e6ed8ce52603079d7835970931b3e39"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"gnome-hwe","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"skipjack"},"targetKey":"skipjack:gnome-hwe:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2527798996,"desktop":"gnome","digest":"sha256:83dedc45e27a2f11ec533e8bdd1d5e7e6b3c5cc6cab12dd078a9de729f2ac8da","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:gnome-nvidia","repository":"ghcr.io/tuna-os/skipjack","tag":"gnome-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:4c0a982b3909378a535c0ac8ab8598dc3a1f41447c2345373e89e1e5dd970005","engineRevision":null,"indexDigest":"sha256:400918e7e283b48ab00d5ddad0a4fbb9ba0c53b378173608df1d3a261b5290ac","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:83dedc45e27a2f11ec533e8bdd1d5e7e6b3c5cc6cab12dd078a9de729f2ac8da"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"gnome-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:gnome-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1890586271,"desktop":"gnome","digest":"sha256:80f53cbc695c3f34b94554ffa5cc0dab33c474518dc8ce4b1107f0fcc25df6cf","hasSdBoot":false,"kernelVer":"6.12.0-280.el10.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:gnome","repository":"ghcr.io/tuna-os/skipjack","tag":"gnome"},"qualification":{"browser":null,"browserBuildReceiptDigest":null,"buildOrigin":"browser","isoDigest":"sha256:b32774b059288a61aeaf92638daa865b96c6fa7dd1197722e53ff91443846cda","producer":{"ref":"refs/heads/main","repository":"tuna-os/iso-builder","runAttempt":2,"runId":42092360728,"sha":"b8efa6fcc9ef73fb4d040bffba51c40fd64e2a7f","workflow":".github/workflows/ci.yml"},"qualifiedAt":"2026-11-05T22:26:20Z","reason":null,"receiptDigest":"sha256:8a44c167de51a69474e1adff528d061756ac72b28cb7bee76299f00a82a95c6e","receiptImageDigest":"sha256:80f53cbc695c3f34b94554ffa5cc0dab33c474518dc8ce4b1107f0fcc25df6cf","receiptPlatform":"linux/amd64","receiptSchema":"BrowserIsoQualificationReceipt/v1","resources":null,"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:911c572dc1d2293cb924836b4da8bf5ebfde443dc0d00f2758f6a7c4660dd3ec","engineRevision":"sha256:296efe8e3f95d05ca17363d166da9e396a47958dfd07549958d460c0a1c31694","indexDigest":"sha256:8f5e1d947307417f1d292ae215b1ad4d9572d2f735109117b10aaf8180877849","installerRevision":"sha256:ff28c254d0f0c3fc303cdcd2d7cae1632a55e6f92f1f887c4c6f00559d82417b","liveOverlayBaseDigest":"sha256:80f53cbc695c3f34b94554ffa5cc0dab33c474518dc8ce4b1107f0fcc25df6cf","liveOverlayDigest":"sha256:4943a7ca67ff3791164f3c63ab0d3d447bde7fe02e3ef9f2393506482520593d","platformManifestDigest":"sha256:80f53cbc695c3f34b94554ffa5cc0dab33c474518dc8ce4b1107f0fcc25df6cf"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1890584493,"desktop":"gnome","digest":"sha256:cf1561ecbc02651171569ec1f2ca6304376cde91b2954d8a58662d0ce17afa30","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:gnome","repository":"ghcr.io/tuna-os/skipjack","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:4dc2d6761141df658fc3764915c9d8f4fbeae44ffee2db28b56ad11a96e7a107","engineRevision":null,"indexDigest":"sha256:8f5e1d947307417f1d292ae215b1ad4d9572d2f735109117b10aaf8180877849","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:cf1561ecbc02651171569ec1f2ca6304376cde91b2954d8a58662d0ce17afa30"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"skipjack"},"targetKey":"skipjack:gnome:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1984596351,"desktop":"kde","digest":"sha256:4594b3e6547c542e303295a1b808d9fedb70576edc8b2f73f0cce060b825b5e1","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:kde-hwe","repository":"ghcr.io/tuna-os/skipjack","tag":"kde-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:7cd14cbc2d29bc371294f15caa28603ce0a4765138eadf51f01526e8e547d1e9","engineRevision":null,"indexDigest":"sha256:bf5f6e8b7e94d696890d49112f2fec6e2eff124c5176e87de926c9be022a2f7a","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:4594b3e6547c542e303295a1b808d9fedb70576edc8b2f73f0cce060b825b5e1"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"kde-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:kde-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1876555013,"desktop":"kde","digest":"sha256:8d2374bc4efcb6e5d36d9be8569dbd21356c6a42b1cae509d4c08a3f433f432e","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:kde-hwe","repository":"ghcr.io/tuna-os/skipjack","tag":"kde-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:0de4178aa6ac37804477512dedb764ba38cefe45050a7ed737ce803821ac6668","engineRevision":null,"indexDigest":"sha256:bf5f6e8b7e94d696890d49112f2fec6e2eff124c5176e87de926c9be022a2f7a","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:8d2374bc4efcb6e5d36d9be8569dbd21356c6a42b1cae509d4c08a3f433f432e"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"kde-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"skipjack"},"targetKey":"skipjack:kde-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2622107986,"desktop":"kde","digest":"sha256:e0b33f8b603013b93dbbb6d2f20a08d24e6a837699fd55e9000b31adac195e66","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:kde-nvidia","repository":"ghcr.io/tuna-os/skipjack","tag":"kde-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:19796ebbc8f6d078e13c499f60b1998b72dec6189b4a986ddd5a859113132c0b","engineRevision":null,"indexDigest":"sha256:f461dd3b676b89fbc3df434af836292dd65ab98fb27176c362564a2ddfd8d324","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:e0b33f8b603013b93dbbb6d2f20a08d24e6a837699fd55e9000b31adac195e66"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"kde-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:kde-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1984547728,"desktop":"kde","digest":"sha256:9e1c8020e489665d4185e50105fa7210a6d351e39da080d52d7643ae809b1b0a","hasSdBoot":false,"kernelVer":"6.12.0-280.el10.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:kde","repository":"ghcr.io/tuna-os/skipjack","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:cc7c7b768f50654aa9ddd364886cfdec3525f0623163335f288cf485d1b17f8f","engineRevision":null,"indexDigest":"sha256:d9adf2fa9fcb660e0ac207e559c605ed83a1a6464923c9ff2e9303a037576495","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:9e1c8020e489665d4185e50105fa7210a6d351e39da080d52d7643ae809b1b0a"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1876574308,"desktop":"kde","digest":"sha256:ccd9c3b185a5c80528015be175fa4de9a51904ccfa3fa80a18df2c0d8f6fead7","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:kde","repository":"ghcr.io/tuna-os/skipjack","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:b327be1dd065ff8c984fab957d6067b15c10918e3bb8e7e62dac10b13affb75a","engineRevision":null,"indexDigest":"sha256:d9adf2fa9fcb660e0ac207e559c605ed83a1a6464923c9ff2e9303a037576495","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:ccd9c3b185a5c80528015be175fa4de9a51904ccfa3fa80a18df2c0d8f6fead7"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"kde","hardwareScope":"generic","platform":"linux/arm64","variant":"skipjack"},"targetKey":"skipjack:kde:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1773415148,"desktop":"niri","digest":"sha256:67323062e559eeb6de634d5b124f61bd2ae1cf7e8746580e06438f0ecc55b279","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:niri-hwe","repository":"ghcr.io/tuna-os/skipjack","tag":"niri-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:b845a6650722d4526986d4ebb49823c4c1b513c140f07356b0bb7b31491923ea","engineRevision":null,"indexDigest":"sha256:c7364007fdc159aa26a3b582133f1431b86079a32b1890b080b0625e8fc79ced","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:67323062e559eeb6de634d5b124f61bd2ae1cf7e8746580e06438f0ecc55b279"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"niri-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:niri-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1659181128,"desktop":"niri","digest":"sha256:57e315dfe69499d50c6c5b958fbd07fb7feda3ea3e440296fce4665c98f228d0","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:niri-hwe","repository":"ghcr.io/tuna-os/skipjack","tag":"niri-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:95210d23fbd2aef30cf275ae55f84012e68d46b173b431c1373d3b2c3e9f7425","engineRevision":null,"indexDigest":"sha256:c7364007fdc159aa26a3b582133f1431b86079a32b1890b080b0625e8fc79ced","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:57e315dfe69499d50c6c5b958fbd07fb7feda3ea3e440296fce4665c98f228d0"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"niri-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"skipjack"},"targetKey":"skipjack:niri-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2409863293,"desktop":"niri","digest":"sha256:5d0c0e0e396f614c1f94962c559533a01d4f36b77c761c6426cedc7c34ad5e24","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:niri-nvidia","repository":"ghcr.io/tuna-os/skipjack","tag":"niri-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:93a0122df189117fa695702b26723e27d9c1779b220856bdab3285d785cc6d7b","engineRevision":null,"indexDigest":"sha256:1e976e0b42c7b63a9c204981344891bb109df5304d6bb59e2f42a578b08d88b1","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:5d0c0e0e396f614c1f94962c559533a01d4f36b77c761c6426cedc7c34ad5e24"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"niri-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:niri-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1773443610,"desktop":"niri","digest":"sha256:7e0dac1b07063cd1acd3d01ec31e92d4cb22f86014c09db28d2e675680a29c9a","hasSdBoot":false,"kernelVer":"6.12.0-280.el10.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:niri","repository":"ghcr.io/tuna-os/skipjack","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:97f6ae4edfba0d7a6a6e6a2ab6c12df75042354c2f8dcd2db0f74e41f5a54f7e","engineRevision":null,"indexDigest":"sha256:199a426151c51ffbe729370f7362f6c473f454fa0f96363da07641f804714fac","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:7e0dac1b07063cd1acd3d01ec31e92d4cb22f86014c09db28d2e675680a29c9a"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"niri","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:niri:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1659242036,"desktop":"niri","digest":"sha256:04fd83ebb37058d39e4d99441ac65bd8cfb1cfecea671c86cd8ca755cd381af1","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:niri","repository":"ghcr.io/tuna-os/skipjack","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:e03d81a4128ad5cfc50694367e971e3c84fc4ba7ebcb6b6c6eff1daf8ea0a1b6","engineRevision":null,"indexDigest":"sha256:199a426151c51ffbe729370f7362f6c473f454fa0f96363da07641f804714fac","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:04fd83ebb37058d39e4d99441ac65bd8cfb1cfecea671c86cd8ca755cd381af1"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"niri","hardwareScope":"generic","platform":"linux/arm64","variant":"skipjack"},"targetKey":"skipjack:niri:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1706344987,"desktop":"tuna","digest":"sha256:b71d0682f4f9a7ae79f4660031df3f67bd30b0f5959c6c46077c0f8751ae4708","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:tuna","repository":"ghcr.io/tuna-os/skipjack","tag":"tuna"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:0033a941416fffca1b453023bc69ebf0fb63ba4df64b1238443b2e9ed1a769e2","engineRevision":null,"indexDigest":"sha256:81ac5170211e0dd2aaae01d2549b7aea0c18c23b5801fabdf1aef34a0317984b","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:b71d0682f4f9a7ae79f4660031df3f67bd30b0f5959c6c46077c0f8751ae4708"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"tuna","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:tuna:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1569816812,"desktop":"xfce","digest":"sha256:952adaca5ec7164247954db924d55aa0bc24be088bc329e925a18b47729983a1","hasSdBoot":false,"kernelVer":"6.12.0-280.el10.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:xfce","repository":"ghcr.io/tuna-os/skipjack","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:f7d335510b135758c58a96419df0568c539a62b4fb97ffd470048dcbba8c7bdf","engineRevision":null,"indexDigest":"sha256:61fef8ca8d006aaa7145cdaeb7f8fded1e89f1e241b2b0e9a34aedacd998278f","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:952adaca5ec7164247954db924d55aa0bc24be088bc329e925a18b47729983a1"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:xfce:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1672457116,"desktop":"","digest":"sha256:a17071371a3d986708606d08a3d74e41d0573bcdf949c4429c7d083eab678cb2","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/wahoo:base","repository":"ghcr.io/tuna-os/wahoo","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:345eefbda94dfd6ae8ff4b497b767384e7d6bd9e95f3cc1b7850ca2f0f7238e5","engineRevision":null,"indexDigest":"sha256:0e7b2afd52f4cf85b2358b283c6ef28ca26994d4e9697d65b16c699e3b87a1b5","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:a17071371a3d986708606d08a3d74e41d0573bcdf949c4429c7d083eab678cb2"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"wahoo"},"targetKey":"wahoo:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1491655859,"desktop":"","digest":"sha256:6fdd66eda5069fce567208fb568ee55eb247851cf6c63e3d481cc123d27e0bc9","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/wahoo:base","repository":"ghcr.io/tuna-os/wahoo","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:1e584b74147e2ecb1427d7a9bafe1e4d0b6923ff3e9ee252484c4ea8e570a05d","engineRevision":null,"indexDigest":"sha256:0e7b2afd52f4cf85b2358b283c6ef28ca26994d4e9697d65b16c699e3b87a1b5","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:6fdd66eda5069fce567208fb568ee55eb247851cf6c63e3d481cc123d27e0bc9"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base","hardwareScope":"generic","platform":"linux/arm64","variant":"wahoo"},"targetKey":"wahoo:base:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2102155786,"desktop":"cosmic","digest":"sha256:819931bfff17db7e3d0c60c20706b98b8732c96f0f95d3fd26a19b9174a9ec47","hasSdBoot":false,"kernelVer":"7.3.0-0.rc0.260818g0f23d56f17fd.3.eln159.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/wahoo:cosmic","repository":"ghcr.io/tuna-os/wahoo","tag":"cosmic"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:ae9ff3049459d0ce95ad474933aa37c66e349764a63894d3cb216bf427d5585c","engineRevision":null,"indexDigest":"sha256:cc20ba1d9f00c5d35a1e2162badb3269efce45bc495a0e0b4fbb569ed354f1e0","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:819931bfff17db7e3d0c60c20706b98b8732c96f0f95d3fd26a19b9174a9ec47"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"cosmic","hardwareScope":"generic","platform":"linux/amd64","variant":"wahoo"},"targetKey":"wahoo:cosmic:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1906913472,"desktop":"cosmic","digest":"sha256:b21c469bdbff9e662b6e9ded92ba561f0322d629827af8cca4c4feb88fda0386","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/wahoo:cosmic","repository":"ghcr.io/tuna-os/wahoo","tag":"cosmic"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:a2fcf50a8de8fab01d4259cb3b198d4e9e03d06f72292ccbc5544dfc09cca998","engineRevision":null,"indexDigest":"sha256:cc20ba1d9f00c5d35a1e2162badb3269efce45bc495a0e0b4fbb569ed354f1e0","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:b21c469bdbff9e662b6e9ded92ba561f0322d629827af8cca4c4feb88fda0386"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"cosmic","hardwareScope":"generic","platform":"linux/arm64","variant":"wahoo"},"targetKey":"wahoo:cosmic:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2045915937,"desktop":"gnome","digest":"sha256:c3f999e5044ab4a9302435500b1d1dbe0c4e9911b7703ca320057a2e37dd6d7b","hasSdBoot":false,"kernelVer":"7.3.0-0.rc0.260818g0f23d56f17fd.3.eln159.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/wahoo:gnome","repository":"ghcr.io/tuna-os/wahoo","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:f6b08d05265889f933c5479cbebe915940150edd4caa8a613c549d68bf0f885d","engineRevision":null,"indexDigest":"sha256:e4d20fcba364559ad173368c7d6f40574ead0fbea740dd9c09bb1409efe86344","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:c3f999e5044ab4a9302435500b1d1dbe0c4e9911b7703ca320057a2e37dd6d7b"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"wahoo"},"targetKey":"wahoo:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1858709118,"desktop":"gnome","digest":"sha256:7c70f5d17221eec275fdc027704a056543cf6911f6b1c07383c4258f67172d1c","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/wahoo:gnome","repository":"ghcr.io/tuna-os/wahoo","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:f6a55ed21c69da66ab82cfb2642dedb6d1e80f85471e4fb21d64350604140cd1","engineRevision":null,"indexDigest":"sha256:e4d20fcba364559ad173368c7d6f40574ead0fbea740dd9c09bb1409efe86344","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:7c70f5d17221eec275fdc027704a056543cf6911f6b1c07383c4258f67172d1c"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome","hardwareScope":"generic","platform":"linux/arm64","variant":"wahoo"},"targetKey":"wahoo:gnome:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2994797655,"desktop":"kde","digest":"sha256:04cc186adb99a0a495045d0548e709ff2503a2168517988fc824d05a8f3831bc","hasSdBoot":false,"kernelVer":"7.3.0-0.rc0.260818g0f23d56f17fd.3.eln159.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/wahoo:kde","repository":"ghcr.io/tuna-os/wahoo","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:be72194956f90eba686272341daf4d77b65fee093d54ad0cfb79a7920a39ea61","engineRevision":null,"indexDigest":"sha256:565a6efef2b39c735b9eefdd7d06baab152e3b706ed09704473faf50ce48e801","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:04cc186adb99a0a495045d0548e709ff2503a2168517988fc824d05a8f3831bc"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"wahoo"},"targetKey":"wahoo:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2771868592,"desktop":"kde","digest":"sha256:a57c8c68d114e493d45ea776e261931f2089a7c7f2057f46b0a6948dce6a0ccd","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/wahoo:kde","repository":"ghcr.io/tuna-os/wahoo","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:f9e8e5c81391bc52f7c2f6e3dd76898ce1eb6dc17b0dff7667e3974c1b84e273","engineRevision":null,"indexDigest":"sha256:565a6efef2b39c735b9eefdd7d06baab152e3b706ed09704473faf50ce48e801","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:a57c8c68d114e493d45ea776e261931f2089a7c7f2057f46b0a6948dce6a0ccd"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"kde","hardwareScope":"generic","platform":"linux/arm64","variant":"wahoo"},"targetKey":"wahoo:kde:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1865745274,"desktop":"tuna","digest":"sha256:3d05e36068199cdf8f2e8bba00f79fc220b51aa2eec0ab448d036f026fa90ad8","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/wahoo:tuna","repository":"ghcr.io/tuna-os/wahoo","tag":"tuna"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:8155db6b63bdc7fc7be697c2ff8f158f6300eacf70001d361de6b12b00c73791","engineRevision":null,"indexDigest":"sha256:865ec5320f25ae368316f07b4d3b49b5e0600308e5bc50b973ace90a5b53a46d","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:3d05e36068199cdf8f2e8bba00f79fc220b51aa2eec0ab448d036f026fa90ad8"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"tuna","hardwareScope":"generic","platform":"linux/amd64","variant":"wahoo"},"targetKey":"wahoo:tuna:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1506837259,"desktop":"","digest":"sha256:428dc62983339a8ed1d004fd007ba16cbb5e061150494ba0ed050e3821dcb70d","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:base-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"base-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:101c10d3f9c91a01b7f0cb6d4ccb3a2bb85592e46a26bf9beed5223887702edf","engineRevision":null,"indexDigest":"sha256:83fc053ad35fcd412cb741e0bc213d842d35c48160c09cbfcb1dc66e5c567d5e","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:428dc62983339a8ed1d004fd007ba16cbb5e061150494ba0ed050e3821dcb70d"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:base-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1504638665,"desktop":"","digest":"sha256:e70c79875d13c2d6711eb3d671be6a14546f6edef7787b61c462dff9915ae271","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:base-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"base-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:894cedf5a3eb12de07197aded9971db78c9add6e0051fa49123915637a232f08","engineRevision":null,"indexDigest":"sha256:83fc053ad35fcd412cb741e0bc213d842d35c48160c09cbfcb1dc66e5c567d5e","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:e70c79875d13c2d6711eb3d671be6a14546f6edef7787b61c462dff9915ae271"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"base-hwe","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"yellowfin"},"targetKey":"yellowfin:base-hwe:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1411908559,"desktop":"","digest":"sha256:6107e2dab93c2123ff5bbe3f76c6d3810cbafafd33e49c34880821ed814f6110","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:base-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"base-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:2012d1aa29b43ec48403d628c760888f3cdf333f222b8940068175bd2d0e7cec","engineRevision":null,"indexDigest":"sha256:83fc053ad35fcd412cb741e0bc213d842d35c48160c09cbfcb1dc66e5c567d5e","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:6107e2dab93c2123ff5bbe3f76c6d3810cbafafd33e49c34880821ed814f6110"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"yellowfin"},"targetKey":"yellowfin:base-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2212187336,"desktop":"","digest":"sha256:430e27e609b3571662f636fe5781dcaf434b0b05b34e0934e167119858ab5119","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:base-nvidia","repository":"ghcr.io/tuna-os/yellowfin","tag":"base-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:c91feb5cf55e84449a61db659641e34ae7cb835f09d24f7a58e3309f5d2c9466","engineRevision":null,"indexDigest":"sha256:91ff0df383c28d15e0047a71f3d5bb3b9b06e00ae7721cbde4da4944e49cb7b0","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:430e27e609b3571662f636fe5781dcaf434b0b05b34e0934e167119858ab5119"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:base-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1473370009,"desktop":"","digest":"sha256:cc088e462c699fae0dbc49de1e6ecfb6eeb515f23c1009af9b63669171282146","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:base","repository":"ghcr.io/tuna-os/yellowfin","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:375db592432bd5d2e3e025ddd2c7a5d98d06ad45b9ad87063b5275c62d6284b4","engineRevision":null,"indexDigest":"sha256:cfad305181dfd2ad8abbeec53b1baa8780a9bde88adef5554871dab6e3214ffc","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:cc088e462c699fae0dbc49de1e6ecfb6eeb515f23c1009af9b63669171282146"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1472415689,"desktop":"","digest":"sha256:f4cf342edd1f493c43c721385ee57ebcf6d53126dbc82554a389df6956e70b3f","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:base","repository":"ghcr.io/tuna-os/yellowfin","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:b6c09b40d0176edffc72d78942257527064d7ee89e450f5f23b231353d0a9524","engineRevision":null,"indexDigest":"sha256:cfad305181dfd2ad8abbeec53b1baa8780a9bde88adef5554871dab6e3214ffc","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:f4cf342edd1f493c43c721385ee57ebcf6d53126dbc82554a389df6956e70b3f"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"base","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"yellowfin"},"targetKey":"yellowfin:base:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1374000075,"desktop":"","digest":"sha256:ee59ac8c33d68e23003bfe83d46f6cfd59cdd919fc8a198bf22800f75b959a02","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:base","repository":"ghcr.io/tuna-os/yellowfin","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:b0c4ad6e12c8692cfa7e1a10061c4a95bbec71078da286cb4f23b5c5c530e366","engineRevision":null,"indexDigest":"sha256:cfad305181dfd2ad8abbeec53b1baa8780a9bde88adef5554871dab6e3214ffc","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:ee59ac8c33d68e23003bfe83d46f6cfd59cdd919fc8a198bf22800f75b959a02"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base","hardwareScope":"generic","platform":"linux/arm64","variant":"yellowfin"},"targetKey":"yellowfin:base:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1883335432,"desktop":"cosmic","digest":"sha256:cd6b551f77934fcb42409f22f3c0967b13a7b16c5df6a174113ef26be33aeab6","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:cosmic-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"cosmic-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:352c284f8b1fdbb89c3e411dd275a0a815cc45bbfe9709628c3de4f214475d8c","engineRevision":null,"indexDigest":"sha256:d4e9f8d2da5cebe4eef5acebef126ea845d46630b85c6594cf36ca9b626130ea","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:cd6b551f77934fcb42409f22f3c0967b13a7b16c5df6a174113ef26be33aeab6"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:cosmic-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2589764791,"desktop":"cosmic","digest":"sha256:eef06d4055b51cb2eb7eb5d11bf94d415cfa410964fa30057e3ce3b60704c53b","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:cosmic-nvidia","repository":"ghcr.io/tuna-os/yellowfin","tag":"cosmic-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:42729dbed980a0a6645729f8546145768ac97063e1642b05f2250862e98c6385","engineRevision":null,"indexDigest":"sha256:1bd58f3fc1bb34d7a1e6cfac5b7c82069fbf5ad573a27d101bdcedf42a66fe19","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:eef06d4055b51cb2eb7eb5d11bf94d415cfa410964fa30057e3ce3b60704c53b"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:cosmic-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1883298154,"desktop":"cosmic","digest":"sha256:f8363376656f1bdd3c42897052728ae2beaa91d5f5a92621e7571de80586ddf3","hasSdBoot":false,"kernelVer":"6.12.0-279.el10.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:cosmic","repository":"ghcr.io/tuna-os/yellowfin","tag":"cosmic"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:dc65df65e76e226268f47337c2bb2e7e9dd0cfd5e248d348e977e895b950e661","engineRevision":null,"indexDigest":"sha256:82248d958ffe928d155079e361eb42e6582a749be1bb146aab4ed85aff686220","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:f8363376656f1bdd3c42897052728ae2beaa91d5f5a92621e7571de80586ddf3"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:cosmic:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1866267630,"desktop":"gnome","digest":"sha256:77ef8fd11a6f4f3f67e038e94963fd9cd62052a04c9d730b1465d4ec4f7bbb6b","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:gnome-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"gnome-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:ca5336016ed8feddd08dba9aec1ab6b6ca622df016ec22a19a5b0d6206a360f7","engineRevision":null,"indexDigest":"sha256:296c157669fc873e72b4849b13468d57973973d7ee201b0e13e87c8ae0ff577c","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:77ef8fd11a6f4f3f67e038e94963fd9cd62052a04c9d730b1465d4ec4f7bbb6b"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:gnome-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1863502120,"desktop":"gnome","digest":"sha256:4a2feab9e619fde98fa45a29aac359269269cf2ea4d2572a2fc3ce43d6e6b881","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:gnome-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"gnome-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:75c6b1e43c2c1c20283d9a11df04df2b1503e66732cbd3b04d5c12675c18f1b6","engineRevision":null,"indexDigest":"sha256:296c157669fc873e72b4849b13468d57973973d7ee201b0e13e87c8ae0ff577c","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:4a2feab9e619fde98fa45a29aac359269269cf2ea4d2572a2fc3ce43d6e6b881"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"gnome-hwe","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"yellowfin"},"targetKey":"yellowfin:gnome-hwe:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2565233640,"desktop":"gnome","digest":"sha256:3c62a636c41d71ebe80afb356e139ceaec43e98c15f894aa9a4c90b3f71bbb15","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:gnome-nvidia","repository":"ghcr.io/tuna-os/yellowfin","tag":"gnome-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:9fa458013ee41ea86307c2281805afd7b89b6360cb416209180c8e51e1c9b444","engineRevision":null,"indexDigest":"sha256:d05479e14e9d6d15f2ae51894cadff2384a437d631ab7f553510df1f2e8f02cd","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:3c62a636c41d71ebe80afb356e139ceaec43e98c15f894aa9a4c90b3f71bbb15"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:gnome-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1866266386,"desktop":"gnome","digest":"sha256:ebd81c8293f9e6be72277533c0d5d62d767c9d162a25dc231a947388e4a26a49","hasSdBoot":false,"kernelVer":"6.12.0-279.el10.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:gnome","repository":"ghcr.io/tuna-os/yellowfin","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:78ef4ed94cd28c10bcab62f9357b10c174dee076fddb37b5842ec0dcd8eaf91e","engineRevision":null,"indexDigest":"sha256:3f15169960df4cf2805883bbf1729f1907a07a4ad3a0dfe2bb3a947c37a9c4a7","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:ebd81c8293f9e6be72277533c0d5d62d767c9d162a25dc231a947388e4a26a49"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1863546483,"desktop":"gnome","digest":"sha256:2f640ce376672484fdc5092e73431b4c4224a6c691eb43fe5de4bfd2d0d3cf65","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:gnome","repository":"ghcr.io/tuna-os/yellowfin","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:db1c1d78ffa1912edd6bd6fafa1e91d430948db8224d9bc7137aaae0d44b432f","engineRevision":null,"indexDigest":"sha256:3f15169960df4cf2805883bbf1729f1907a07a4ad3a0dfe2bb3a947c37a9c4a7","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:2f640ce376672484fdc5092e73431b4c4224a6c691eb43fe5de4bfd2d0d3cf65"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"yellowfin"},"targetKey":"yellowfin:gnome:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1960610866,"desktop":"kde","digest":"sha256:18df2ba54d371ce20f8b7035ca5339d70095d88c262766988db2eab62279ae2b","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:kde-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"kde-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:8cac37d690a884d70caf852585ad684215d38c7df69bd6f817b7af151c5c224c","engineRevision":null,"indexDigest":"sha256:8a6dcbf3695700050a099ff07acd457aab331e053eaee45e688127763ccce8f8","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:18df2ba54d371ce20f8b7035ca5339d70095d88c262766988db2eab62279ae2b"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:kde-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1956299386,"desktop":"kde","digest":"sha256:7bc7fdbd674928a2967dc69ffd87272b8800fdfc37e3833d03919789566cfbc0","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:kde-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"kde-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:42a6c6ad2f342ab0877a067fd4ceb32a9db33cdb828095e9b0d691e684056045","engineRevision":null,"indexDigest":"sha256:8a6dcbf3695700050a099ff07acd457aab331e053eaee45e688127763ccce8f8","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:7bc7fdbd674928a2967dc69ffd87272b8800fdfc37e3833d03919789566cfbc0"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"kde-hwe","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"yellowfin"},"targetKey":"yellowfin:kde-hwe:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1857788447,"desktop":"kde","digest":"sha256:a7b37a5316bfe21e067f057e7fd0229127870045ddbb219370887d078a79abb0","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:kde-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"kde-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:045c98cd64fd61462ea0237fb989ae07a0edf89c73681b15cfea9bde230d0d2d","engineRevision":null,"indexDigest":"sha256:8a6dcbf3695700050a099ff07acd457aab331e053eaee45e688127763ccce8f8","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:a7b37a5316bfe21e067f057e7fd0229127870045ddbb219370887d078a79abb0"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"kde-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"yellowfin"},"targetKey":"yellowfin:kde-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2659323502,"desktop":"kde","digest":"sha256:cd46d1031a9747b6e2155e6ce9e074b7c6e09c04d32ecf2630056defffb1022b","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:kde-nvidia","repository":"ghcr.io/tuna-os/yellowfin","tag":"kde-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:de326a135751e34290adc033f36d7d7defd6d9a9395d03d5740c86debd6f5521","engineRevision":null,"indexDigest":"sha256:260e931d269f5cadcb563a8441bbc92fbd0c91d40c03639534a4a9c2e4197494","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:cd46d1031a9747b6e2155e6ce9e074b7c6e09c04d32ecf2630056defffb1022b"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:kde-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1960621902,"desktop":"kde","digest":"sha256:cd0cfbde9483dd7b602111ed7071203af6c7f3ca7e1888afb568f99428d4ea07","hasSdBoot":false,"kernelVer":"6.12.0-279.el10.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:kde","repository":"ghcr.io/tuna-os/yellowfin","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:0fbe4ed2d4b7c99e7f1307879f9b5351feabe48ca3c2ed1a1344e051bb3db754","engineRevision":null,"indexDigest":"sha256:dc0b3b6d9028202e89591d5d2079974ccd9a7d15e71987846a4260670881bf00","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:cd0cfbde9483dd7b602111ed7071203af6c7f3ca7e1888afb568f99428d4ea07"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1956346114,"desktop":"kde","digest":"sha256:698e3854ec084023731a4b949640e59cfb74b0603bdf63598013745d605f05bf","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:kde","repository":"ghcr.io/tuna-os/yellowfin","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:d406756386f3d7055abc18c099116ef4dccd2a27f0db4ce45fb28bdc9baf94a0","engineRevision":null,"indexDigest":"sha256:dc0b3b6d9028202e89591d5d2079974ccd9a7d15e71987846a4260670881bf00","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:698e3854ec084023731a4b949640e59cfb74b0603bdf63598013745d605f05bf"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"yellowfin"},"targetKey":"yellowfin:kde:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1857794513,"desktop":"kde","digest":"sha256:8906312aed9abb90ec2323231fb8071671d5252eef31eed5e73584c5eca41ae2","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:kde","repository":"ghcr.io/tuna-os/yellowfin","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:39713ad576091834493e5d1dc00c1ae930131f092a657f74100e2c182c08c0b2","engineRevision":null,"indexDigest":"sha256:dc0b3b6d9028202e89591d5d2079974ccd9a7d15e71987846a4260670881bf00","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:8906312aed9abb90ec2323231fb8071671d5252eef31eed5e73584c5eca41ae2"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"kde","hardwareScope":"generic","platform":"linux/arm64","variant":"yellowfin"},"targetKey":"yellowfin:kde:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1749754340,"desktop":"niri","digest":"sha256:4362b7c2d9eb5c518c374532bcfbb2921ecaac6e4eabcbfb1ec125e06ed2e693","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:niri-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"niri-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:61ecc85e3264938baf16040262683982715e03bd5c1f666a934a650a31b24d9d","engineRevision":null,"indexDigest":"sha256:839c0194327a6401c7f772e87ff26a0e1d6d5eb4f5b14d07d5d84250f1378125","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:4362b7c2d9eb5c518c374532bcfbb2921ecaac6e4eabcbfb1ec125e06ed2e693"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:niri-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1758712818,"desktop":"niri","digest":"sha256:c82f9e39f078ab5d2f82f101d5e615e803c33be3fe54dc13ea9ac828e440d5a2","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:niri-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"niri-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:2c588bfbe793fbe9858f8c1ff1870adb6b40498e3052b74b2f9d2e653eeca767","engineRevision":null,"indexDigest":"sha256:839c0194327a6401c7f772e87ff26a0e1d6d5eb4f5b14d07d5d84250f1378125","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:c82f9e39f078ab5d2f82f101d5e615e803c33be3fe54dc13ea9ac828e440d5a2"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"niri-hwe","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"yellowfin"},"targetKey":"yellowfin:niri-hwe:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1640832152,"desktop":"niri","digest":"sha256:ed5278157805731ac8a12fdeff71d6594c99a4d7d57677d1528338160e85b9e5","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:niri-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"niri-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:d3b0740545fe64d73cd515957c52c02c80bb414c3775709b565476cdc0aff0a0","engineRevision":null,"indexDigest":"sha256:839c0194327a6401c7f772e87ff26a0e1d6d5eb4f5b14d07d5d84250f1378125","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:ed5278157805731ac8a12fdeff71d6594c99a4d7d57677d1528338160e85b9e5"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"niri-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"yellowfin"},"targetKey":"yellowfin:niri-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2454934463,"desktop":"niri","digest":"sha256:054ccbea4434e20d80e2822c821d6a46d5ad9816c7ab23278791198832e89f59","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:niri-nvidia","repository":"ghcr.io/tuna-os/yellowfin","tag":"niri-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:5d26447cc969cb7ff1ddc6840a50fb3e04336dda192defa6505c4233eecf9cbf","engineRevision":null,"indexDigest":"sha256:1245b503efe3fbd1bae685e98c78500bda2f7e6262f0d5eed412eca391f37d28","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:054ccbea4434e20d80e2822c821d6a46d5ad9816c7ab23278791198832e89f59"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:niri-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1749775718,"desktop":"niri","digest":"sha256:92700229f11582446be6c51dea51b59ff46958c1108e41f7b6199b4da57bcdd6","hasSdBoot":false,"kernelVer":"6.12.0-279.el10.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:niri","repository":"ghcr.io/tuna-os/yellowfin","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:70ebf7d48369ec269a064b9916b2685331019d60d419e90251b218895cd004fe","engineRevision":null,"indexDigest":"sha256:d3ed4108bac6d1f7626a10239a88b09bb233a5c347bfe8b2fc3c34c4e8c33aa6","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:92700229f11582446be6c51dea51b59ff46958c1108e41f7b6199b4da57bcdd6"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:niri:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1758746702,"desktop":"niri","digest":"sha256:b463f42fd30f69a19e1340b1c4b2f50f02f2ea08359ecf732190e9012f5219c9","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:niri","repository":"ghcr.io/tuna-os/yellowfin","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:3d58094ce477c2a3db2304039960e30e55228c711e0f1d87d004290fa2466d0b","engineRevision":null,"indexDigest":"sha256:d3ed4108bac6d1f7626a10239a88b09bb233a5c347bfe8b2fc3c34c4e8c33aa6","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:b463f42fd30f69a19e1340b1c4b2f50f02f2ea08359ecf732190e9012f5219c9"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"niri","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"yellowfin"},"targetKey":"yellowfin:niri:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1640729954,"desktop":"niri","digest":"sha256:99c1eae7bcee3016d5db35b4acd34eb7bf05a9f36c1cb8b0d60f0e403147b928","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:niri","repository":"ghcr.io/tuna-os/yellowfin","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:28e6c36db5169111545fce836cfb885adc05b2cc26503ea7eb8d4a443bb96039","engineRevision":null,"indexDigest":"sha256:d3ed4108bac6d1f7626a10239a88b09bb233a5c347bfe8b2fc3c34c4e8c33aa6","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:99c1eae7bcee3016d5db35b4acd34eb7bf05a9f36c1cb8b0d60f0e403147b928"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"niri","hardwareScope":"generic","platform":"linux/arm64","variant":"yellowfin"},"targetKey":"yellowfin:niri:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1682878928,"desktop":"tuna","digest":"sha256:61123b4a7c24a841ee221d3bfea0f658e00ab545bdec0a63c93294cc5acbb619","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:tuna","repository":"ghcr.io/tuna-os/yellowfin","tag":"tuna"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:a9d82c6cc58caac32f113dad6ef96297c500deb111c2b210d2fb1edac34d14ca","engineRevision":null,"indexDigest":"sha256:11350b8da2cd2e2c7f7eaffde474ec63a243afdc3482c228c7323e7c191f5687","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:61123b4a7c24a841ee221d3bfea0f658e00ab545bdec0a63c93294cc5acbb619"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"tuna","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:tuna:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1546489198,"desktop":"xfce","digest":"sha256:ef82fed2ff47e40a8029624e8493b5b3a19ad71f26de9ebea2e90825cccda6c8","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:xfce-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"xfce-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:a37036839350db9062cade3e26fdd7ca911283f59889680f6a8d392e5759e366","engineRevision":null,"indexDigest":"sha256:60469a3338aeea38a2c57ed20fd0ce46384c51d55690f8dc863e98e19f3706fd","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:ef82fed2ff47e40a8029624e8493b5b3a19ad71f26de9ebea2e90825cccda6c8"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:xfce-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1547642982,"desktop":"xfce","digest":"sha256:3a9e94d900ee0d6fd8ca8018854304e770888b8fbe530f4d1484b6a6ef6ba61f","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:xfce-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"xfce-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:2f988870f8572b9520e077a2604fe609ec462f2991d0f67b1fa3d746241f25fd","engineRevision":null,"indexDigest":"sha256:60469a3338aeea38a2c57ed20fd0ce46384c51d55690f8dc863e98e19f3706fd","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:3a9e94d900ee0d6fd8ca8018854304e770888b8fbe530f4d1484b6a6ef6ba61f"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"xfce-hwe","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"yellowfin"},"targetKey":"yellowfin:xfce-hwe:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2251309785,"desktop":"xfce","digest":"sha256:63cd524d3319e4b8f59b1b5d7d1e0977df947e1803d16de67c48823d9926c422","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:xfce-nvidia","repository":"ghcr.io/tuna-os/yellowfin","tag":"xfce-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:4d982055d0b8d84fd26ebc7ef7aa22fb5732c3afd50d79215a46a1c50533fcaa","engineRevision":null,"indexDigest":"sha256:900a17b137e1f9cbcc31f0343a29b6a59192670136e8f2449c15cd0eab6deb59","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:63cd524d3319e4b8f59b1b5d7d1e0977df947e1803d16de67c48823d9926c422"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:xfce-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1546491242,"desktop":"xfce","digest":"sha256:f0c42de8ee306f837953aa375898add33e295a58fe19729f59bbd6cb87541e62","hasSdBoot":false,"kernelVer":"6.12.0-279.el10.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:xfce","repository":"ghcr.io/tuna-os/yellowfin","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:56b29543daad41b202adf90a92a955199a247caef037263955403b915cef8012","engineRevision":null,"indexDigest":"sha256:e8d5414c04137b9797d393b04e64941c8848643bfd9997d44103c9caf9ac6766","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:f0c42de8ee306f837953aa375898add33e295a58fe19729f59bbd6cb87541e62"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:xfce:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1547621940,"desktop":"xfce","digest":"sha256:e18616e2a745794861e32b73fae565eb9634dc5ec18cf59f0b298e0e0b92c39e","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:xfce","repository":"ghcr.io/tuna-os/yellowfin","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:80e8c94fd3b07afc9723178f89d9ad033c3113639e655819a630dcf10882e3a4","engineRevision":null,"indexDigest":"sha256:e8d5414c04137b9797d393b04e64941c8848643bfd9997d44103c9caf9ac6766","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:e18616e2a745794861e32b73fae565eb9634dc5ec18cf59f0b298e0e0b92c39e"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"yellowfin"},"targetKey":"yellowfin:xfce:linux/amd64/v2"}]};

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
