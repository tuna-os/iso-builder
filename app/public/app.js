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
  document.querySelector("#builder-headline").textContent = config.presentation.headline;
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

const DEFAULT_CATALOG_SNAPSHOT = {"coverageDigest":"sha256:1205636ea43f87b0dea840b409ef7d147b030a21d5deac9ba2b24844d5fdcb1e","generatedAt":"2026-11-14T05:38:23Z","kind":"catalog-snapshot","producerRevision":"tunaos.toml@2697c4bdc6977e383dc8f08738fdc7b5d24b95b6","schemaVersion":1,"snapshotDigest":"sha256:930d6d17e936bb03327fec55f5d4275d7245b9ffbffdbe6daedd802ed03efdc9","targets":[{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1702979973,"desktop":"","digest":"sha256:f99e745bdc829a687c5ed177389e5fd8931ae70d443d010adbd3db62fb1e6ded","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:base-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"base-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:fb83c9b4efeae7dfb91a57ca8329c0f8e7035f07c36de824bd46b39ee0f4e67d","engineRevision":null,"indexDigest":"sha256:0b19288373cf4976239d5484822b855c0360804fb25ee65ac2f371cdbe466c6a","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:f99e745bdc829a687c5ed177389e5fd8931ae70d443d010adbd3db62fb1e6ded"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:base-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1698477973,"desktop":"","digest":"sha256:fdfe0dc2710eecefab3fc8c99986da5446675d9ecf84f335bb26b541154b57aa","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:base-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"base-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:34c6fd101c5a2bdc396f33fe4cd0ab17283890ce4fba6ea50d72668e640ea361","engineRevision":null,"indexDigest":"sha256:0b19288373cf4976239d5484822b855c0360804fb25ee65ac2f371cdbe466c6a","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:fdfe0dc2710eecefab3fc8c99986da5446675d9ecf84f335bb26b541154b57aa"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"base-hwe","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"albacore"},"targetKey":"albacore:base-hwe:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1610919804,"desktop":"","digest":"sha256:686288dadcbaa4d4d3d0660b603250fd3ed6b88d6a608d98d9f84d235dc2dbed","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:base-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"base-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:231ee62d084162e3167c1c3dfb98724d2bde5b2ef208464fefe654afb880aa14","engineRevision":null,"indexDigest":"sha256:0b19288373cf4976239d5484822b855c0360804fb25ee65ac2f371cdbe466c6a","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:686288dadcbaa4d4d3d0660b603250fd3ed6b88d6a608d98d9f84d235dc2dbed"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"albacore"},"targetKey":"albacore:base-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2307687229,"desktop":"","digest":"sha256:c2a2a09f860db50cd550820ee902ecf3472eb38c2c30c57e06accc70c3772237","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:base-nvidia","repository":"ghcr.io/tuna-os/albacore","tag":"base-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:ecd6d1cdf95e24a0c8165d97cf44778625b6ad2c285262f99d7f30d7070a9a8d","engineRevision":null,"indexDigest":"sha256:a4ba3d2ee6dbeb7dc45af0b75666adda614445ca1033357be03308c903a4896b","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:c2a2a09f860db50cd550820ee902ecf3472eb38c2c30c57e06accc70c3772237"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:base-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1627375393,"desktop":"","digest":"sha256:e495dd4c752ce5f893ae0fa5d04340585d805c532cf405772574bb57f0ec3b70","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:base","repository":"ghcr.io/tuna-os/albacore","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:48935d68354575b1f6fa6fdc9f8754d6f2c74c799939e389ff191eaf0cf945e6","engineRevision":null,"indexDigest":"sha256:dfcb0002d4febab3756bc04bab6a2ee2e710159d9580a98d4a595e25d77794dd","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:e495dd4c752ce5f893ae0fa5d04340585d805c532cf405772574bb57f0ec3b70"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1626380705,"desktop":"","digest":"sha256:28ec809fe377898be7cd5a1ba4c58503f2f8c5cf557ec607df9a3d1e4ee0ffc9","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:base","repository":"ghcr.io/tuna-os/albacore","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:686d270ba856c38ecae69c2bb98ff6788b25176cfce93d2406d04e64d26d7aec","engineRevision":null,"indexDigest":"sha256:dfcb0002d4febab3756bc04bab6a2ee2e710159d9580a98d4a595e25d77794dd","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:28ec809fe377898be7cd5a1ba4c58503f2f8c5cf557ec607df9a3d1e4ee0ffc9"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"base","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"albacore"},"targetKey":"albacore:base:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1515147591,"desktop":"","digest":"sha256:6d5cc4aeb3394e9619a57ba1c25cc07faf8c1f45936fe041163b45278fea7478","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:base","repository":"ghcr.io/tuna-os/albacore","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:8e6a51313e5ae000d835f073d8ab53004dd5873627f8f2aee1f7ffaaae51b2c5","engineRevision":null,"indexDigest":"sha256:dfcb0002d4febab3756bc04bab6a2ee2e710159d9580a98d4a595e25d77794dd","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:6d5cc4aeb3394e9619a57ba1c25cc07faf8c1f45936fe041163b45278fea7478"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base","hardwareScope":"generic","platform":"linux/arm64","variant":"albacore"},"targetKey":"albacore:base:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2077386374,"desktop":"cosmic","digest":"sha256:be7ac9dad2a221c308fe730de95bcd776fcc83078a7234f9abc1f15193e189fd","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:cosmic-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"cosmic-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:16eccdce12c89a674d090caa873f2fcfe01901477936e0523479ac65a8b14212","engineRevision":null,"indexDigest":"sha256:ac644e8e42ce5b795250f0afa81534d4420a1d01f127d19bd8303ff43113f857","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:be7ac9dad2a221c308fe730de95bcd776fcc83078a7234f9abc1f15193e189fd"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:cosmic-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2682996223,"desktop":"cosmic","digest":"sha256:41bd84a2d9df3281be694375ae5b402dff7ed6bc14c71991c75f58b3996f624c","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:cosmic-nvidia","repository":"ghcr.io/tuna-os/albacore","tag":"cosmic-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:9dd5faebf215116343145db451e169ba90243980c5a767e24bafb79e93265579","engineRevision":null,"indexDigest":"sha256:8977f7982e4ddb150314fff1e7594f6bfe5bea1170faef3b038f13902c3a2744","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:41bd84a2d9df3281be694375ae5b402dff7ed6bc14c71991c75f58b3996f624c"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:cosmic-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2077367006,"desktop":"cosmic","digest":"sha256:c31b95b107a9c1eff49ec6ffd593096e8b27a8b28cb07b47b61a541c0a86a129","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:cosmic","repository":"ghcr.io/tuna-os/albacore","tag":"cosmic"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:c207584acf7e5f490ee35249d1eed08e332c6ed2e525e616fda64d61e828ab11","engineRevision":null,"indexDigest":"sha256:f998998ff370d416eb8dd80b1106b66113ef773e83bade2c19163d8b0e213cef","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:c31b95b107a9c1eff49ec6ffd593096e8b27a8b28cb07b47b61a541c0a86a129"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:cosmic:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2545666614,"desktop":"gnome","digest":"sha256:bc6cfdcb98b261b573dcdc61e0d3dc12d1a2cdd7b4332c7a4ecf75ce61ce7acb","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:gnome-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"gnome-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:7ce6cc894e04f312445f90363458ee3a0ecf68b5f542cfca2f70df9733a78846","engineRevision":null,"indexDigest":"sha256:56d8786e1b2a6dfd750302cd3936707eebed44b1b22b78d33e4ded9a2c3282c3","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:bc6cfdcb98b261b573dcdc61e0d3dc12d1a2cdd7b4332c7a4ecf75ce61ce7acb"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:gnome-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":2542024356,"desktop":"gnome","digest":"sha256:482bdd55b09c9e16bc5e3ac54e6cdf5d3f92269965e3126fb56af875ff393cac","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:gnome-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"gnome-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:42a56c9c1ebb35945664ed51ee0fe2008c5f623bbfdb68c1fe322ee6cdfd2252","engineRevision":null,"indexDigest":"sha256:56d8786e1b2a6dfd750302cd3936707eebed44b1b22b78d33e4ded9a2c3282c3","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:482bdd55b09c9e16bc5e3ac54e6cdf5d3f92269965e3126fb56af875ff393cac"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"gnome-hwe","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"albacore"},"targetKey":"albacore:gnome-hwe:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3150903332,"desktop":"gnome","digest":"sha256:9a91320b403b5e863797b4665cc5bf854b45bafa76d0e84e2ae34bb5d06b7345","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:gnome-nvidia","repository":"ghcr.io/tuna-os/albacore","tag":"gnome-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:0228c2ce0dc78bbfd4c6c54c23c7b06ef329cb3980dbb73a9ec9a334c6770337","engineRevision":null,"indexDigest":"sha256:10e294494dc90656c3bbe692daed36cc8abcd4b5913b8a14b68af1757eece160","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:9a91320b403b5e863797b4665cc5bf854b45bafa76d0e84e2ae34bb5d06b7345"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:gnome-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2545309157,"desktop":"gnome","digest":"sha256:b2f85ace6d0356c94bac0a32b5f936db10a4b99aefa256f6647240296901dab7","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:gnome","repository":"ghcr.io/tuna-os/albacore","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:7e0a89a1df385c0461ac79ca53ebe35a04d9fbb8cc2b884280698a61706b9c94","engineRevision":null,"indexDigest":"sha256:9078e83f40865408ef470f79301d078c6ff00d6576fafe7b9bb816c49afd3b51","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:b2f85ace6d0356c94bac0a32b5f936db10a4b99aefa256f6647240296901dab7"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":2541789619,"desktop":"gnome","digest":"sha256:a2e815151fbed32c11380ca174a704061e5d9b5e04390b87605200481ec450cf","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:gnome","repository":"ghcr.io/tuna-os/albacore","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:f82b77f056126adc77ca3c7ddfb1151dacd6a39325b534af74b86f69118f6a0b","engineRevision":null,"indexDigest":"sha256:9078e83f40865408ef470f79301d078c6ff00d6576fafe7b9bb816c49afd3b51","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:a2e815151fbed32c11380ca174a704061e5d9b5e04390b87605200481ec450cf"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"albacore"},"targetKey":"albacore:gnome:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3203552223,"desktop":"kde","digest":"sha256:a8bd908bff6cb8e2b47a8e9097de1b35091f300bb6e6f3f2252c005e1a205d69","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:kde-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"kde-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:d4e7c8eb473342dddd28c2c0ddd3c82ede864540136d7333d604f78d33b642fd","engineRevision":null,"indexDigest":"sha256:e8d513e1c2d820ca808de45651d99addca29c3d23b9a6885093db54f6de40477","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:a8bd908bff6cb8e2b47a8e9097de1b35091f300bb6e6f3f2252c005e1a205d69"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:kde-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":3121269716,"desktop":"kde","digest":"sha256:91657658761b4c3744c679ecde35e096b543186dfae4dc5678e31395eab8085a","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:kde-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"kde-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:5bba4827343be14d9e198daa903ba8fbf0ba33962a202dc9ed1b0e16bcdcc18b","engineRevision":null,"indexDigest":"sha256:e8d513e1c2d820ca808de45651d99addca29c3d23b9a6885093db54f6de40477","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:91657658761b4c3744c679ecde35e096b543186dfae4dc5678e31395eab8085a"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"kde-hwe","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"albacore"},"targetKey":"albacore:kde-hwe:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3082432858,"desktop":"kde","digest":"sha256:f5d6daf380ae4bda4d8a687920e6c7d12dbf460ab9f06d0eb7bf9d4b5e4d8c6c","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:kde-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"kde-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:b9f4736f02760cc6d060db0e5b83dbf325df163fe370da58ad4c8de74a97a588","engineRevision":null,"indexDigest":"sha256:e8d513e1c2d820ca808de45651d99addca29c3d23b9a6885093db54f6de40477","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:f5d6daf380ae4bda4d8a687920e6c7d12dbf460ab9f06d0eb7bf9d4b5e4d8c6c"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"kde-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"albacore"},"targetKey":"albacore:kde-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3808890387,"desktop":"kde","digest":"sha256:a717a4cae57740e8d460bf078554447517d01321170ae612d5f6c46db3a32ec8","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:kde-nvidia","repository":"ghcr.io/tuna-os/albacore","tag":"kde-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:b68e80b55f8cf95027045a6002f08a457e52b5d5fa07c7ecf080029fac5f9878","engineRevision":null,"indexDigest":"sha256:ccc1226a564c09972cc7d0ed4a4b461c9f4e88f9d310e8c1048bbe13c166c59b","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:a717a4cae57740e8d460bf078554447517d01321170ae612d5f6c46db3a32ec8"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:kde-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3203503128,"desktop":"kde","digest":"sha256:45970131e76de1670416be24b4fb9c0b4939c66c5a1815c0b44f1937e968676e","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:kde","repository":"ghcr.io/tuna-os/albacore","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:c50c0914983e3302a612d5c7c8a57e51577560c3f4bc629070ad32c2a64d3c41","engineRevision":null,"indexDigest":"sha256:286190a82f79affb62301073b6f88c155748b768795d47ac707b0c88cb0d561c","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:45970131e76de1670416be24b4fb9c0b4939c66c5a1815c0b44f1937e968676e"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":3121181987,"desktop":"kde","digest":"sha256:d6f088436bce9edef2b02cd57d567fbdbce20f93595aa78011604cc1bd5e1602","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:kde","repository":"ghcr.io/tuna-os/albacore","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:2035102c593b0d3d4b6c7cc75b8b00629ac1c662bc0fce9bfb5971ea9fb3ae58","engineRevision":null,"indexDigest":"sha256:286190a82f79affb62301073b6f88c155748b768795d47ac707b0c88cb0d561c","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:d6f088436bce9edef2b02cd57d567fbdbce20f93595aa78011604cc1bd5e1602"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"albacore"},"targetKey":"albacore:kde:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2058223875,"desktop":"kde","digest":"sha256:2421cdf6d90383463b5b031b1ccfd28618674cae052d8e0419208a3b0e0a7118","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:kde","repository":"ghcr.io/tuna-os/albacore","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:d8ebe78be77909df2271b5724247eb16b2292977d56b083d2ca8bc558c40df80","engineRevision":null,"indexDigest":"sha256:286190a82f79affb62301073b6f88c155748b768795d47ac707b0c88cb0d561c","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:2421cdf6d90383463b5b031b1ccfd28618674cae052d8e0419208a3b0e0a7118"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"kde","hardwareScope":"generic","platform":"linux/arm64","variant":"albacore"},"targetKey":"albacore:kde:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1942298790,"desktop":"niri","digest":"sha256:fe0eadfc39b404287040e6b614ef202204e64fadbc08fa8a182228931ccfa232","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:niri-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"niri-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:b82ff7e233186fdaf8ab0f646369d777ea808cc4a4511f1ea7108d8caaaa2430","engineRevision":null,"indexDigest":"sha256:56000d29ea2558305ecec786e2ae4f1c89fbe4445e9adce3f8d2f11e91cb48ee","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:fe0eadfc39b404287040e6b614ef202204e64fadbc08fa8a182228931ccfa232"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:niri-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1951031000,"desktop":"niri","digest":"sha256:185393d19762727aadc327fceb57bd46db5dc1281833e6294ce1d2fda3646d16","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:niri-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"niri-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:44f3f2d8081a9000c7763ad3275b093b3ecb4fec926a84a07059c55b6fbcb060","engineRevision":null,"indexDigest":"sha256:56000d29ea2558305ecec786e2ae4f1c89fbe4445e9adce3f8d2f11e91cb48ee","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:185393d19762727aadc327fceb57bd46db5dc1281833e6294ce1d2fda3646d16"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"niri-hwe","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"albacore"},"targetKey":"albacore:niri-hwe:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1838806514,"desktop":"niri","digest":"sha256:9abbdf9576578a3b7a0262cb528019e59a24131b2f344a051fb4bc9b61773891","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:niri-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"niri-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:48188afd2cdfaeab85ef4cb4f7dedea790de881f9c74e442e6cd65ab7d4b2c5a","engineRevision":null,"indexDigest":"sha256:56000d29ea2558305ecec786e2ae4f1c89fbe4445e9adce3f8d2f11e91cb48ee","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:9abbdf9576578a3b7a0262cb528019e59a24131b2f344a051fb4bc9b61773891"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"niri-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"albacore"},"targetKey":"albacore:niri-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2547491764,"desktop":"niri","digest":"sha256:da881fa4f485d7590ad60578e0ff5327826b521e6361deec951c812cc3ab22fd","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:niri-nvidia","repository":"ghcr.io/tuna-os/albacore","tag":"niri-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:7937b85545909286748b59a8fcc505f17712ca98ca55075e1fd28ca26cdf1df9","engineRevision":null,"indexDigest":"sha256:2f730546f3ed67b2cf5fee75e140654dfacce8256887134a88743cd5ad989c0c","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:da881fa4f485d7590ad60578e0ff5327826b521e6361deec951c812cc3ab22fd"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:niri-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1942383662,"desktop":"niri","digest":"sha256:0428c6edc8a7d52ad471c385e0ea6574ad03723a2a0fb787c613b4f529935cb4","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:niri","repository":"ghcr.io/tuna-os/albacore","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:3c508f0fd89ca721549598279ab8a5e903a70d1271b48bc831932a3a0d96b343","engineRevision":null,"indexDigest":"sha256:547bf7d44695f184e8da776b75dc090ed07fec5f93c2574b73e1088605194b3e","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:0428c6edc8a7d52ad471c385e0ea6574ad03723a2a0fb787c613b4f529935cb4"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:niri:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1950973010,"desktop":"niri","digest":"sha256:4d1d97590cdd993064a63746952b764b21e838b287b488f54e3347f79910b21d","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:niri","repository":"ghcr.io/tuna-os/albacore","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:a3a01b186cb96aa5998fd3e6ec4b5f394c325480a924fb79af84ac738c493028","engineRevision":null,"indexDigest":"sha256:547bf7d44695f184e8da776b75dc090ed07fec5f93c2574b73e1088605194b3e","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:4d1d97590cdd993064a63746952b764b21e838b287b488f54e3347f79910b21d"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"niri","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"albacore"},"targetKey":"albacore:niri:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1838903243,"desktop":"niri","digest":"sha256:97895b33fd9b60291b7ae0aa4319e8a66d8d0f65cbabcd5bec4100dae1717751","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:niri","repository":"ghcr.io/tuna-os/albacore","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:ecfbe24f28a08aafbb0316433471054db0bc56b40b750200b02ef31c8db0f1df","engineRevision":null,"indexDigest":"sha256:547bf7d44695f184e8da776b75dc090ed07fec5f93c2574b73e1088605194b3e","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:97895b33fd9b60291b7ae0aa4319e8a66d8d0f65cbabcd5bec4100dae1717751"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"niri","hardwareScope":"generic","platform":"linux/arm64","variant":"albacore"},"targetKey":"albacore:niri:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1862667112,"desktop":"tuna","digest":"sha256:4e3e0b191dfc55d1005d689d16b93fab495e65d7bd313140dc1dba59b5968b8c","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:tuna","repository":"ghcr.io/tuna-os/albacore","tag":"tuna"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:9f14a8c703ba005e67c8e745dc14f304544a3e1537c9686c2bd62602c298addd","engineRevision":null,"indexDigest":"sha256:b68a195dbc6e079bbab6b330086e6420d860f5364d1f2232e5f377bc6cdf2a13","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:4e3e0b191dfc55d1005d689d16b93fab495e65d7bd313140dc1dba59b5968b8c"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"tuna","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:tuna:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1740918056,"desktop":"xfce","digest":"sha256:b32a25ce77efc1682fd51f19c6e1b960d5e2d4d94784341ba1ce26fdb336d112","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:xfce-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"xfce-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:45bda99d48e64ec468f08a6175bcf1770bb25bfcc6ded27fb043bba3ec96cb26","engineRevision":null,"indexDigest":"sha256:c726d15b08808ff83b442f9f993c704c927858dd21265c8b60110089f4282e80","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:b32a25ce77efc1682fd51f19c6e1b960d5e2d4d94784341ba1ce26fdb336d112"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:xfce-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1741396962,"desktop":"xfce","digest":"sha256:372b418f63908ce5d5a292c451ec979b2631f1e5ccb58dbfda77039252dbd6c4","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:xfce-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"xfce-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:6aca7641792b5c45202eac1772e1fb52f1ea2504b7a9f415d83e2a9915322390","engineRevision":null,"indexDigest":"sha256:c726d15b08808ff83b442f9f993c704c927858dd21265c8b60110089f4282e80","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:372b418f63908ce5d5a292c451ec979b2631f1e5ccb58dbfda77039252dbd6c4"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"xfce-hwe","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"albacore"},"targetKey":"albacore:xfce-hwe:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2345511256,"desktop":"xfce","digest":"sha256:57d144550bcbf5e08d9271a02d6447d3df254771c6e8200115bcb765e95a8e33","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:xfce-nvidia","repository":"ghcr.io/tuna-os/albacore","tag":"xfce-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:a4bc9efde08662c562f42830128daa72307c52aff2e6998efcf28995562849fa","engineRevision":null,"indexDigest":"sha256:e40468de4e20acc59b51ca23570ca32bf153422962bb5fcaba717db1c5fcd11e","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:57d144550bcbf5e08d9271a02d6447d3df254771c6e8200115bcb765e95a8e33"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:xfce-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1740567743,"desktop":"xfce","digest":"sha256:7839b1d1bbcbf5c1378708e6ff549d30b69dd83af087985fd6a17050d275d715","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:xfce","repository":"ghcr.io/tuna-os/albacore","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:5d251c1f7e45b44e6fca9b00f4e80a8be416fe0f922facd32f9863d6be3f4ba3","engineRevision":null,"indexDigest":"sha256:ea9f45df967de03df28a0683ccaee5ea6f64c9b303ead019c865134bca3b1de3","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:7839b1d1bbcbf5c1378708e6ff549d30b69dd83af087985fd6a17050d275d715"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"albacore"},"targetKey":"albacore:xfce:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1741094652,"desktop":"xfce","digest":"sha256:c19314d6a6f5d51531ada8b51b1b2f3412c97b964097ee3a2f3ae32fd6598510","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:xfce","repository":"ghcr.io/tuna-os/albacore","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:5c4eefaa3e62b33272a906b6d812c2caffb64d320507612c6be843169045eff7","engineRevision":null,"indexDigest":"sha256:ea9f45df967de03df28a0683ccaee5ea6f64c9b303ead019c865134bca3b1de3","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:c19314d6a6f5d51531ada8b51b1b2f3412c97b964097ee3a2f3ae32fd6598510"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"albacore"},"targetKey":"albacore:xfce:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1960637217,"desktop":"","digest":"sha256:c6d3376d0fbffe66f3da89290e45c5baa63be735130a87ad1c7e7d754ac6ce7d","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:base-hwe-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"base-hwe-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:7bb7bbce4177845ddc553c5eb6702cf283fa4527a0662f4ca53e31a375cefada","engineRevision":null,"indexDigest":"sha256:2a3c6daf788fa3bfe375c318ccdad0ad684c0f388c8631e595e717df451c0594","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:c6d3376d0fbffe66f3da89290e45c5baa63be735130a87ad1c7e7d754ac6ce7d"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:base-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1836796292,"desktop":"","digest":"sha256:f7ad987d50f07fcc4fa96d29af4132db333887f9f9d2e5f2e0b19384cf5370bc","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:base-hwe-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"base-hwe-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:b412c6db53ba8da74c0e579a4add8bbe40d45272f825204601852270c05a0779","engineRevision":null,"indexDigest":"sha256:2a3c6daf788fa3bfe375c318ccdad0ad684c0f388c8631e595e717df451c0594","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:f7ad987d50f07fcc4fa96d29af4132db333887f9f9d2e5f2e0b19384cf5370bc"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:base-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2822389036,"desktop":"","digest":"sha256:5cbe11c2c028c6c0a36bfb2cfa4fd4e6e12a6c32402cf22d987a7a0d59990221","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:base-nvidia-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"base-nvidia-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:f5e613bc75dada474fda3d23207bc17b525fe55656e87139b306fcc0a823e90b","engineRevision":null,"indexDigest":"sha256:59bbe1c7e4859e3187d725adea9bb03ea01dd53dd6a3698432fbb289beefdd64","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:5cbe11c2c028c6c0a36bfb2cfa4fd4e6e12a6c32402cf22d987a7a0d59990221"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:base-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1926202032,"desktop":"","digest":"sha256:1022f291e192756bbae8b61413697ea0ff2c45e062bc15f5cebdc4988161b4f3","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:base-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"base-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:0c421829f2bac71399ab8c546e8a2da09f25ac95182a9ede17050c1da375fbfe","engineRevision":null,"indexDigest":"sha256:0bb205e4dd09396b3a88cddb3298414382359aae8d3286382c427e90ebc69822","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:1022f291e192756bbae8b61413697ea0ff2c45e062bc15f5cebdc4988161b4f3"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1804057607,"desktop":"","digest":"sha256:9089efdfcacf9b6ec7dcd2eec7e04e29b38af2e303f488709cb0ee98906ac2bd","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:base-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"base-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:35a213ffc66fa5e7e3ff24dafb402986d21b94b2117fc6afe455c8f834c88814","engineRevision":null,"indexDigest":"sha256:0bb205e4dd09396b3a88cddb3298414382359aae8d3286382c427e90ebc69822","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:9089efdfcacf9b6ec7dcd2eec7e04e29b38af2e303f488709cb0ee98906ac2bd"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:base:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3513982353,"desktop":"cosmic","digest":"sha256:aefc3afbe6c0e9ad208922f303a840f31f0a8285695800a1c7158b8406c92b7d","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:cosmic-nvidia-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"cosmic-nvidia-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:ffb6b07ec0c62ab14d74cdb3400e8b75d003dfacaa34a0704d11ddb9c259d8ad","engineRevision":null,"indexDigest":"sha256:4deca868aff8c40582646575e50c48a6633b9b9d9a13b72087571e17cdb6bc7e","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:aefc3afbe6c0e9ad208922f303a840f31f0a8285695800a1c7158b8406c92b7d"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:cosmic-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2653366551,"desktop":"cosmic","digest":"sha256:690fb30c181a1aac00288f782bcff713d4c22316f1d6c446a247cb998191e714","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:cosmic-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"cosmic-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:fc3657c3bd14ec5c56823d3eb6652d4947f01de86f775d8bfae274055bf6d119","engineRevision":null,"indexDigest":"sha256:9ffbdda059fb72cd246f0432e271a38c2cdc06c4241adcadad91f0c6a2443611","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:690fb30c181a1aac00288f782bcff713d4c22316f1d6c446a247cb998191e714"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:cosmic:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2511190742,"desktop":"cosmic","digest":"sha256:63bcb31429e1e9f3b35c8b1d0d537027440458488b2ed7516a244dd628b6478b","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:cosmic-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"cosmic-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:832f73a7641f71c561828839121398f25bb268b11a15620cdc4274010c7092ab","engineRevision":null,"indexDigest":"sha256:9ffbdda059fb72cd246f0432e271a38c2cdc06c4241adcadad91f0c6a2443611","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:63bcb31429e1e9f3b35c8b1d0d537027440458488b2ed7516a244dd628b6478b"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"cosmic","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:cosmic:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2590060676,"desktop":"gnome","digest":"sha256:f178e38bcbda56475e75408df708dac9f6dfa886b5340b0402233a181d47bc8e","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome-hwe-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"gnome-hwe-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:0a685687bd8125cb062a64723f6246928d58a35854512c659a103abe18958004","engineRevision":null,"indexDigest":"sha256:1586897822e8e10c76f861ef7ce9ccc9af759fba56afa48e1eb18924f9866f00","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:f178e38bcbda56475e75408df708dac9f6dfa886b5340b0402233a181d47bc8e"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:gnome-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2453746344,"desktop":"gnome","digest":"sha256:1f12100ab04cf99250e2d12d2b7401c5ef3cb132636223f3921e3f392ecf9b9a","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome-hwe-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"gnome-hwe-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:0e2ed16e03d5f3cea29a14c4a8892d6a8e6dde2641807775995c0ff2cb0815b9","engineRevision":null,"indexDigest":"sha256:1586897822e8e10c76f861ef7ce9ccc9af759fba56afa48e1eb18924f9866f00","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:1f12100ab04cf99250e2d12d2b7401c5ef3cb132636223f3921e3f392ecf9b9a"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:gnome-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3181307628,"desktop":"gnome","digest":"sha256:410244ca81591f4b95be4a016ddf1920e4addd7bf930e95e519a9cdbd7142742","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome-nvidia-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"gnome-nvidia-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:d6bf869bd4b598a21952f59266b4cbcd89398652fb758a85ffabb4d61dc8a9ff","engineRevision":null,"indexDigest":"sha256:639c7fe0fc817103e61f8e2a2bd7915882179f41d7f94880383d51ab53947d2c","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:410244ca81591f4b95be4a016ddf1920e4addd7bf930e95e519a9cdbd7142742"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:gnome-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2573218666,"desktop":"gnome","digest":"sha256:fc34e18458387776cc575d73582e8cceeaa8e76c3b427301b099253cd8579425","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"gnome-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:14491c73aa4c5be5ba5c470a782d9cf2812430702868a7496b1742dd9b2dc6a5","engineRevision":null,"indexDigest":"sha256:28d02dc05fe923524e6698323b6f676424b63702d791f166753e8a9982f24247","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:fc34e18458387776cc575d73582e8cceeaa8e76c3b427301b099253cd8579425"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2436994269,"desktop":"gnome","digest":"sha256:225394bc6d1a06656b81e292f2ac83a58521578704d30ac1718a04554716b288","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"gnome-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:1137aae1c1914cb6c99b17ec8e5d37978ea827feafd05b1b55af163bef142122","engineRevision":null,"indexDigest":"sha256:28d02dc05fe923524e6698323b6f676424b63702d791f166753e8a9982f24247","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:225394bc6d1a06656b81e292f2ac83a58521578704d30ac1718a04554716b288"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:gnome:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":4200225135,"desktop":"kde","digest":"sha256:8e999512151f0e84b5d9885ef2542f4f26c9c5ffe188c27f4a93c305880c93f3","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:kde-nvidia-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"kde-nvidia-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:91168aa538efc1b77ba3f0fd3075269ae7de8aea01a3486b0f1fa942571492dc","engineRevision":null,"indexDigest":"sha256:2de432c0fec739cdb0dcbbe614e09bc2d93f8249292dd847bcbb05821f04596a","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:8e999512151f0e84b5d9885ef2542f4f26c9c5ffe188c27f4a93c305880c93f3"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:kde-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3337818912,"desktop":"kde","digest":"sha256:8816d24d79892a9c80cc9d97a87d7c32fd5968bff16095ce780614a29eae0fc7","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:kde-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"kde-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:4c87a85d3ebd0be7fa53a505404e303f697d7509e07810471926f437d56e817f","engineRevision":null,"indexDigest":"sha256:2053914bec94a3904a473d7f6cdc7f5acd8dcc8274d69e20f04d60c934d22390","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:8816d24d79892a9c80cc9d97a87d7c32fd5968bff16095ce780614a29eae0fc7"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3175723858,"desktop":"kde","digest":"sha256:6d4ce9d7b6f5eadfaf0de5ebdf68a3cd7808fd56be5e3db055d5d080a496649e","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:kde-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"kde-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:113b04d3b4bac54f82da633616250844cdcc1b46c9ce74fbf1e484de8e5bff0b","engineRevision":null,"indexDigest":"sha256:2053914bec94a3904a473d7f6cdc7f5acd8dcc8274d69e20f04d60c934d22390","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:6d4ce9d7b6f5eadfaf0de5ebdf68a3cd7808fd56be5e3db055d5d080a496649e"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"kde","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:kde:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3057882325,"desktop":"niri","digest":"sha256:14d0e1b43511c6ab38041096bba867a0784a6a307810a1c12bd7d89e92bc8b3f","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:niri-nvidia-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"niri-nvidia-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:ebb8aaf27c5237db7041c13b1f0019f1ecb78ab646029df2e2736af5452ffa23","engineRevision":null,"indexDigest":"sha256:7b766fa9f2b68c6ba3693e908d307a0ad8eaf5e8040c9b535dc6958c52ddbeef","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:14d0e1b43511c6ab38041096bba867a0784a6a307810a1c12bd7d89e92bc8b3f"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:niri-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2196301768,"desktop":"niri","digest":"sha256:98641407ade7c12f834b17dfca1ce86c633ea54af7935f1af450d2cb9d8c5a0c","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:niri-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"niri-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:1966b5804f4b46c4960f4dcee6ccc02afd0b81673415ff2c415d4638828ddb3b","engineRevision":null,"indexDigest":"sha256:4d400c6fcdbcd8c0016247bf407699dd3f719b7eaf090d278db8543eb794361a","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:98641407ade7c12f834b17dfca1ce86c633ea54af7935f1af450d2cb9d8c5a0c"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:niri:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2064099948,"desktop":"niri","digest":"sha256:4a1a4c71843d89ce7c73d0aed5f798d4e7ef891f7f69a5d3eedcf193b9935f1f","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:niri-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"niri-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:91bed934525fd6ef1eda8321e64e8a2372e99c4a41ef7a3b487e71a1eaabaa9b","engineRevision":null,"indexDigest":"sha256:4d400c6fcdbcd8c0016247bf407699dd3f719b7eaf090d278db8543eb794361a","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:4a1a4c71843d89ce7c73d0aed5f798d4e7ef891f7f69a5d3eedcf193b9935f1f"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"niri","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:niri:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2267443511,"desktop":"tuna","digest":"sha256:895013d5741bba45ce23418dcab2724582c0345fd5c7f9d691eace6074fffb22","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:tuna-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"tuna-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:eeee21b06c7c7bd509db6ac54c88673be768188119ba51f0b37cc33ee5967776","engineRevision":null,"indexDigest":"sha256:c9c852c8e3fc913bda4c7871559a4fee2fdac1be16a1a67be17cde7bacd705c2","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:895013d5741bba45ce23418dcab2724582c0345fd5c7f9d691eace6074fffb22"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"tuna","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:tuna:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3581300801,"desktop":"xfce","digest":"sha256:4321a4343c5969707a9749a20f967677e4c6bc1f401b12e9cd7dee1515940c53","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:xfce-nvidia-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"xfce-nvidia-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:1d95f08169687e5b5e919e95871dfd62eed26edd79f8ced38ce0acb684de285f","engineRevision":null,"indexDigest":"sha256:d5392200651b153c0b90b3cb94a30eeabbfd9b2eb7b6e90ee7bff7a8c597f75b","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:4321a4343c5969707a9749a20f967677e4c6bc1f401b12e9cd7dee1515940c53"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:xfce-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2716227729,"desktop":"xfce","digest":"sha256:27bc058e9a81019a93256aba423979858647bfc37a352dec67a405cd63c33f31","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:xfce-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"xfce-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:f39295541c48783c21cb442542a945b3ca6ca6bbe52ef3db5f50d02dd8e0e6e9","engineRevision":null,"indexDigest":"sha256:34a40df4f2bac89aae0fee8159cbff3b8b82b5f6521c4c29af2a27d277fa064f","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:27bc058e9a81019a93256aba423979858647bfc37a352dec67a405cd63c33f31"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:xfce:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2563488108,"desktop":"xfce","digest":"sha256:fb7e312a2199479f763793039a1c7d43b77b1ed9ff583ec36fb29e8109d125e7","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:xfce-rawhide","repository":"ghcr.io/tuna-os/bonito","tag":"xfce-rawhide"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:e8ab79f05a0d357b1a5c9b1889b30d1c7d21e812dce899ef3c585a8a9da01187","engineRevision":null,"indexDigest":"sha256:34a40df4f2bac89aae0fee8159cbff3b8b82b5f6521c4c29af2a27d277fa064f","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:fb7e312a2199479f763793039a1c7d43b77b1ed9ff583ec36fb29e8109d125e7"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"xfce","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito-rawhide"},"targetKey":"bonito-rawhide:xfce:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1996162039,"desktop":"","digest":"sha256:1c1826a1056e9f53c19c8b3d5a5a365d857ce455ddcad047dddc04e23f2101bf","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:base-hwe","repository":"ghcr.io/tuna-os/bonito","tag":"base-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:b735029b2e25b4c7694ce80089550bbae0237be8a1263b7f344278de5b41e652","engineRevision":null,"indexDigest":"sha256:86103f8a3a019109854316671b3852deb03714165023c1a2b28ef5647f687a97","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:1c1826a1056e9f53c19c8b3d5a5a365d857ce455ddcad047dddc04e23f2101bf"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:base-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1885431343,"desktop":"","digest":"sha256:bc743dca0922c7cba79dbf554351bf8134b352a9576ac0a9084980c9f6f03710","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:base-hwe","repository":"ghcr.io/tuna-os/bonito","tag":"base-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:f493555106c97c03bb2a633e4e0d4064b74506b8c35bc4f2395f67fee062dfba","engineRevision":null,"indexDigest":"sha256:86103f8a3a019109854316671b3852deb03714165023c1a2b28ef5647f687a97","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:bc743dca0922c7cba79dbf554351bf8134b352a9576ac0a9084980c9f6f03710"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito"},"targetKey":"bonito:base-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2601491300,"desktop":"","digest":"sha256:7ff2887256c680c907466072846ebdf07cb195255853bb03e5161c9ed47a5e35","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:base-nvidia","repository":"ghcr.io/tuna-os/bonito","tag":"base-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:9bfd44c514f3f32bc3fc9ca00573e5736e43fe6e8729864212cd348d8be05482","engineRevision":null,"indexDigest":"sha256:eff8ccff1a966306227d9b0eda356ae3344d84f2c8cf53745dc7aeb202533cde","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:7ff2887256c680c907466072846ebdf07cb195255853bb03e5161c9ed47a5e35"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:base-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1870509079,"desktop":"","digest":"sha256:771def5dc022b12ce6785d76ba5a68af046d2a589fed4c69b4cf27b822fef708","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:base","repository":"ghcr.io/tuna-os/bonito","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:3217e184e0bc2aa511b0ab8afb3c5d4b01da7830da043bd3b6ee770de16d1bc5","engineRevision":null,"indexDigest":"sha256:555c29f19d270a14eeceb8a38cf31b293b1118befa9c1e2f3ff38d8bd43e1d06","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:771def5dc022b12ce6785d76ba5a68af046d2a589fed4c69b4cf27b822fef708"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1753790159,"desktop":"","digest":"sha256:99c6e10e229fbe887f1e7a9bd439e298afd489ec3eb3e99af0c99599b6153e8e","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:base","repository":"ghcr.io/tuna-os/bonito","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:0b9728662bb9f062d3a3ee150b87e20b75f041ebc10d0c33fe8d556572f9d336","engineRevision":null,"indexDigest":"sha256:555c29f19d270a14eeceb8a38cf31b293b1118befa9c1e2f3ff38d8bd43e1d06","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:99c6e10e229fbe887f1e7a9bd439e298afd489ec3eb3e99af0c99599b6153e8e"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito"},"targetKey":"bonito:base:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3263256178,"desktop":"cosmic","digest":"sha256:10d497aac3a017b33af165a510f1ec84e23607bbf207841f8d428f9a5e5b48ab","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:cosmic-nvidia","repository":"ghcr.io/tuna-os/bonito","tag":"cosmic-nvidia"},"qualification":{"browser":null,"browserBuildReceiptDigest":null,"buildOrigin":"browser","inheritedFrom":"bonito:cosmic:linux/amd64","isoDigest":"sha256:d2bca6783f6c0c835030b3e3a746a99191c98be1122cb3942bd50b528d395d81","producer":{"ref":"refs/heads/main","repository":"tuna-os/iso-builder","runAttempt":1,"runId":43381903797,"sha":"5bf4984607eff86542b65deb7403dd7bb394c6a3","workflow":".github/workflows/ci.yml"},"qualifiedAt":"2026-11-13T09:48:25Z","reason":null,"receiptDigest":"sha256:398562bc90211cddd62b8062566f9f25f93c0e5f1523bbdea8d6d3cf7cd94b44","receiptImageDigest":"sha256:91422157d10c8a8f34e0aaa42c0e0e30d8767bebf58547cee8428ae92b2983db","receiptPlatform":"linux/amd64","receiptSchema":"BrowserIsoQualificationReceipt/v1","resources":null,"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:eb84c94084f9a847c2f78124a6761c34e8ba5e390b489af609da6b9036cbb160","engineRevision":"sha256:399389ecea74de0b9fe8495766a6e33a3592675e2106600f90ea44ae023a1bdd","indexDigest":"sha256:e2a7369e7d536d8a83f7daad6d0131c2ed5f9a3cab4083787d4d443449cd200b","installerRevision":"sha256:735ea3881ba71bf42d24fdd495f6e31cc6e9c595e024e1f9565fa11fb9e4c22c","liveOverlayBaseDigest":"sha256:10d497aac3a017b33af165a510f1ec84e23607bbf207841f8d428f9a5e5b48ab","liveOverlayDigest":"sha256:01c3c6c3b59973ab2309feb8790b0749fc546ff453b497a48daecfd35a18615e","platformManifestDigest":"sha256:10d497aac3a017b33af165a510f1ec84e23607bbf207841f8d428f9a5e5b48ab"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:cosmic-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2659705506,"desktop":"cosmic","digest":"sha256:0ae3692643f163f3c53f826b1486c35c055e0ef2942555088855c7722b55ed76","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:cosmic","repository":"ghcr.io/tuna-os/bonito","tag":"cosmic"},"qualification":{"browser":null,"browserBuildReceiptDigest":null,"buildOrigin":"browser","isoDigest":"sha256:d2bca6783f6c0c835030b3e3a746a99191c98be1122cb3942bd50b528d395d81","producer":{"ref":"refs/heads/main","repository":"tuna-os/iso-builder","runAttempt":1,"runId":43381903797,"sha":"5bf4984607eff86542b65deb7403dd7bb394c6a3","workflow":".github/workflows/ci.yml"},"qualifiedAt":"2026-11-13T09:48:25Z","reason":null,"receiptDigest":"sha256:398562bc90211cddd62b8062566f9f25f93c0e5f1523bbdea8d6d3cf7cd94b44","receiptImageDigest":"sha256:91422157d10c8a8f34e0aaa42c0e0e30d8767bebf58547cee8428ae92b2983db","receiptPlatform":"linux/amd64","receiptSchema":"BrowserIsoQualificationReceipt/v1","resources":null,"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:b342485320f69e979bf08a3a01e7f5b03c792be0cd8b88da03cee9cbf79a1b96","engineRevision":"sha256:399389ecea74de0b9fe8495766a6e33a3592675e2106600f90ea44ae023a1bdd","indexDigest":"sha256:a1020566bbf6745f07f47e9d02d5778aa322f9509f57fc531a700ced3d2e9016","installerRevision":"sha256:735ea3881ba71bf42d24fdd495f6e31cc6e9c595e024e1f9565fa11fb9e4c22c","liveOverlayBaseDigest":"sha256:91422157d10c8a8f34e0aaa42c0e0e30d8767bebf58547cee8428ae92b2983db","liveOverlayDigest":"sha256:911d03540f7b68a0d60e6ae3bba4063ffa98ff6e79fea0e1e354f8c0f1c73a2d","platformManifestDigest":"sha256:91422157d10c8a8f34e0aaa42c0e0e30d8767bebf58547cee8428ae92b2983db"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:cosmic:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2531455353,"desktop":"cosmic","digest":"sha256:bb3467da634faea47ddf709a051e42d19e8728fe769d3fdf02e6d21412011c36","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:cosmic","repository":"ghcr.io/tuna-os/bonito","tag":"cosmic"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:daad5bf43832e56af56396fb39c07585463571779ac71423d33f7f08f6d5aab8","engineRevision":null,"indexDigest":"sha256:e119e5289800d38dcae9279663d9d620666fcb4e46c0a70dfe69a2628379fd55","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:bb3467da634faea47ddf709a051e42d19e8728fe769d3fdf02e6d21412011c36"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"cosmic","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito"},"targetKey":"bonito:cosmic:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2555695892,"desktop":"gnome","digest":"sha256:9efc30fd6f54e74cee490db8b296e6384bd1d19b9aeee5855f589b67f769c05c","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome-asahi","repository":"ghcr.io/tuna-os/bonito","tag":"gnome-asahi"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:7dbe07ad3388cc3741959163f0a40ea44b05fdd312355d5d1d58fd3fd3fd323c","engineRevision":null,"indexDigest":"sha256:6795f1b044b3745333d08b2de0e703b472a2e1b2b1400751cb7e2211d6570565","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:9efc30fd6f54e74cee490db8b296e6384bd1d19b9aeee5855f589b67f769c05c"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome-asahi","hardwareScope":"apple-silicon","platform":"linux/arm64","variant":"bonito"},"targetKey":"bonito:gnome-asahi:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2632280173,"desktop":"gnome","digest":"sha256:a2d5f1c8a8cc42021b79368eddd7e064629fdf33daed9196d4f88721153835f3","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome-hwe","repository":"ghcr.io/tuna-os/bonito","tag":"gnome-hwe"},"qualification":{"browser":null,"browserBuildReceiptDigest":null,"buildOrigin":"browser","isoDigest":"sha256:3c4d6c8c1cecb65c966e06b0b3de74f3604526e959c4369d0de3bc67aabafbc7","producer":{"ref":"refs/heads/main","repository":"tuna-os/iso-builder","runAttempt":1,"runId":43356248300,"sha":"6bd608d7067bf42f7c8f8d0f03b44a434d335ce3","workflow":".github/workflows/ci.yml"},"qualifiedAt":"2026-11-13T04:56:46Z","reason":null,"receiptDigest":"sha256:457a32f2779daab469c4257cfe466e521906991c88788c8210c91119d410d919","receiptImageDigest":"sha256:a2d5f1c8a8cc42021b79368eddd7e064629fdf33daed9196d4f88721153835f3","receiptPlatform":"linux/amd64","receiptSchema":"BrowserIsoQualificationReceipt/v1","resources":null,"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:4f6538360b484607f00a39925d2de24a0cf2c4a52a4a528ffb175a1ea62f9873","engineRevision":"sha256:399389ecea74de0b9fe8495766a6e33a3592675e2106600f90ea44ae023a1bdd","indexDigest":"sha256:b1403d9643374dbd844e3797240d16eab733c708fcef1c257ac419d579c8cf2b","installerRevision":"sha256:ff28c254d0f0c3fc303cdcd2d7cae1632a55e6f92f1f887c4c6f00559d82417b","liveOverlayBaseDigest":"sha256:a2d5f1c8a8cc42021b79368eddd7e064629fdf33daed9196d4f88721153835f3","liveOverlayDigest":"sha256:5093ff3e17ef842e817ce526230ffbefd3b558a05d5d2ce81ededa1478aee593","platformManifestDigest":"sha256:a2d5f1c8a8cc42021b79368eddd7e064629fdf33daed9196d4f88721153835f3"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:gnome-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2509351789,"desktop":"gnome","digest":"sha256:91f7c92a4d0889f4003a8aee4d747bd2cc4ebd2848ccc5d10ec4bb7f5f29e142","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome-hwe","repository":"ghcr.io/tuna-os/bonito","tag":"gnome-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:e945cafe32cba6b6a276a30aa59755fd64ab17746c7e848da165b12530ae8942","engineRevision":null,"indexDigest":"sha256:b1403d9643374dbd844e3797240d16eab733c708fcef1c257ac419d579c8cf2b","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:91f7c92a4d0889f4003a8aee4d747bd2cc4ebd2848ccc5d10ec4bb7f5f29e142"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito"},"targetKey":"bonito:gnome-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3238340895,"desktop":"gnome","digest":"sha256:486c90d5102b02351ba39beec46dd09295ac7eeead50416fa675c525ebaefb09","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome-nvidia","repository":"ghcr.io/tuna-os/bonito","tag":"gnome-nvidia"},"qualification":{"browser":null,"browserBuildReceiptDigest":null,"buildOrigin":"browser","inheritedFrom":"bonito:gnome:linux/amd64","isoDigest":"sha256:43cfbb779ef84c05671f3fe855cc0492c5d4c3bccb72cb3835503f0a20b03160","producer":{"ref":"refs/heads/main","repository":"tuna-os/iso-builder","runAttempt":1,"runId":42255145643,"sha":"5d689907e09034c0fa492f673dc3a718b3a9a3cc","workflow":".github/workflows/ci.yml"},"qualifiedAt":"2026-11-06T18:54:48Z","reason":null,"receiptDigest":"sha256:5cd515187c02a10271a95c1b34a299c7fb60c475fa6162139e6d347c51cb2738","receiptImageDigest":"sha256:037c8821c2afc4bb21dc701ae9c4729b014abfe732573c033be624b46fb2ee05","receiptPlatform":"linux/amd64","receiptSchema":"BrowserIsoQualificationReceipt/v1","resources":null,"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:3938a55be609966a7afc7ec07d1ab5ee9cc7c8c784429d0d4219c5939000b39c","engineRevision":"sha256:ca5a07efa6b4dbb145d15c32a777de34c3d9a984f83f6fe8e236ffe5a9038aad","indexDigest":"sha256:3ef90ef444a9bd6db171d8709debea332b3ecbfbc5b4451a700a51d3af37bdbf","installerRevision":"sha256:ff28c254d0f0c3fc303cdcd2d7cae1632a55e6f92f1f887c4c6f00559d82417b","liveOverlayBaseDigest":"sha256:486c90d5102b02351ba39beec46dd09295ac7eeead50416fa675c525ebaefb09","liveOverlayDigest":"sha256:ab61f23a49e9760e1294a785c9a524d259f2df34efb98e21e25a9d0bec8d5018","platformManifestDigest":"sha256:486c90d5102b02351ba39beec46dd09295ac7eeead50416fa675c525ebaefb09"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:gnome-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2642848024,"desktop":"gnome","digest":"sha256:4a8c942577f4558dc42d1bf682c6ad0cca0c03f80343615cc85944af010ebac1","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome-t2","repository":"ghcr.io/tuna-os/bonito","tag":"gnome-t2"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:ee859860fea7d55c9ffda4fdbbf42e09121099589f900dfa382efd9c1c60b174","engineRevision":null,"indexDigest":"sha256:d19ada7e8f88762302ac35ec8dc499174d39045388d626f52cdd5c36f96c7dc6","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:4a8c942577f4558dc42d1bf682c6ad0cca0c03f80343615cc85944af010ebac1"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-t2","hardwareScope":"apple-t2","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:gnome-t2:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2633875339,"desktop":"gnome","digest":"sha256:953b81b31ed18927d37b9201330179f42fbd9e18f8122029f4353186f941cfd8","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome","repository":"ghcr.io/tuna-os/bonito","tag":"gnome"},"qualification":{"browser":null,"browserBuildReceiptDigest":null,"buildOrigin":"browser","isoDigest":"sha256:43cfbb779ef84c05671f3fe855cc0492c5d4c3bccb72cb3835503f0a20b03160","producer":{"ref":"refs/heads/main","repository":"tuna-os/iso-builder","runAttempt":1,"runId":42255145643,"sha":"5d689907e09034c0fa492f673dc3a718b3a9a3cc","workflow":".github/workflows/ci.yml"},"qualifiedAt":"2026-11-06T18:54:48Z","reason":null,"receiptDigest":"sha256:5cd515187c02a10271a95c1b34a299c7fb60c475fa6162139e6d347c51cb2738","receiptImageDigest":"sha256:037c8821c2afc4bb21dc701ae9c4729b014abfe732573c033be624b46fb2ee05","receiptPlatform":"linux/amd64","receiptSchema":"BrowserIsoQualificationReceipt/v1","resources":null,"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:f6683333033ea45404d1e0f299550bb9ae91a422673eabefbb37403b54c25a8d","engineRevision":"sha256:ca5a07efa6b4dbb145d15c32a777de34c3d9a984f83f6fe8e236ffe5a9038aad","indexDigest":"sha256:6298fcb3fd7f1ccbfdf3492e32a6cef73dc1dc5f3826d48bf7c99028b1a87e2b","installerRevision":"sha256:ff28c254d0f0c3fc303cdcd2d7cae1632a55e6f92f1f887c4c6f00559d82417b","liveOverlayBaseDigest":"sha256:037c8821c2afc4bb21dc701ae9c4729b014abfe732573c033be624b46fb2ee05","liveOverlayDigest":"sha256:7df8a3b3082add514a9fc8991182e2958a0805bcfae51f7b1944ab0c82a71fac","platformManifestDigest":"sha256:037c8821c2afc4bb21dc701ae9c4729b014abfe732573c033be624b46fb2ee05"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2510861014,"desktop":"gnome","digest":"sha256:f05ee0b216cbca5a94a674fe13a09121922d98916a9fc08e65d416dd82cfea98","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome","repository":"ghcr.io/tuna-os/bonito","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:bd4a77993166b842b810fa8fd0b1269cc8bd22ab8fc89a26e7e7be01d814e6de","engineRevision":null,"indexDigest":"sha256:7d4823e7fee65abdde84231037738a9fd408ce5dab89a9c6389e8fb2efb9d719","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:f05ee0b216cbca5a94a674fe13a09121922d98916a9fc08e65d416dd82cfea98"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito"},"targetKey":"bonito:gnome:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3980576269,"desktop":"kde","digest":"sha256:35149ba0639a4e0d4b395c5966f49352af330d86e383571e3a981b33bd933995","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:kde-nvidia","repository":"ghcr.io/tuna-os/bonito","tag":"kde-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:fc5e772f262549e499a1450114da78be09b1f6c211614c70b149002ab5ec5194","engineRevision":null,"indexDigest":"sha256:c52184e1ddf451247a31913716c26088e1cfec7b1c15d14d25ccca4a82466c79","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:35149ba0639a4e0d4b395c5966f49352af330d86e383571e3a981b33bd933995"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:kde-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3375377945,"desktop":"kde","digest":"sha256:8e1c400662cf067b8a6c4c4875b0f2bbde1b37c76850fe0da457b81844f4e742","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:kde","repository":"ghcr.io/tuna-os/bonito","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:193baaa78de7a4546f0f7dd0d48948ae0ea392467116641787af961fb281a407","engineRevision":null,"indexDigest":"sha256:6dabd820a3a8c4ab58dafcc041cda72ab492104d48c53c041d408ae38f8040c8","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:8e1c400662cf067b8a6c4c4875b0f2bbde1b37c76850fe0da457b81844f4e742"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3224851453,"desktop":"kde","digest":"sha256:89d951f369a32a649d91931f21aff9db641dd8c977e3e26f0652a1653bdd7d99","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:kde","repository":"ghcr.io/tuna-os/bonito","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:6aff7cefd2e18276904bbb710352aa8ebf170e1a2d99ba0cbbebf9cb11a51daf","engineRevision":null,"indexDigest":"sha256:6dabd820a3a8c4ab58dafcc041cda72ab492104d48c53c041d408ae38f8040c8","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:89d951f369a32a649d91931f21aff9db641dd8c977e3e26f0652a1653bdd7d99"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"kde","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito"},"targetKey":"bonito:kde:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2829094577,"desktop":"niri","digest":"sha256:0055916c4fdb08c4cd79de952346ca85402ff54b73adb8d480638679fbb5ea8f","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:niri-nvidia","repository":"ghcr.io/tuna-os/bonito","tag":"niri-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:b9157aa99e08be14a010ab3f5bcc393be1cf10eed2e2c992520bd1b2237510fe","engineRevision":null,"indexDigest":"sha256:41b081ea350a6055e8985b2e1f87a1c89169a15613764d75b2477ce9e4e117e9","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:0055916c4fdb08c4cd79de952346ca85402ff54b73adb8d480638679fbb5ea8f"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:niri-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2225662973,"desktop":"niri","digest":"sha256:8e56c8054d2804206268aa46e6635d988dfd640e26074a7a59fec8208026af94","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:niri","repository":"ghcr.io/tuna-os/bonito","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:082e60a40f97c308313e3f15e8c633cc1eb6148b431ed2aab0293bace878cc8f","engineRevision":null,"indexDigest":"sha256:09575405ae1e7634c48baae672e0b8ad7c89a3d61258e50c60f94f1251ae70c2","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:8e56c8054d2804206268aa46e6635d988dfd640e26074a7a59fec8208026af94"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:niri:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2105682371,"desktop":"niri","digest":"sha256:622d1c6a8ec942f7b4b5da71ed4406ad23a4bc1349650a45a921cd3db96c9021","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:niri","repository":"ghcr.io/tuna-os/bonito","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:ffc11bfd5c1c77d800ed128ff53c669d8ccdca9bdc5fd66639354de7ab97f6ce","engineRevision":null,"indexDigest":"sha256:09575405ae1e7634c48baae672e0b8ad7c89a3d61258e50c60f94f1251ae70c2","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:622d1c6a8ec942f7b4b5da71ed4406ad23a4bc1349650a45a921cd3db96c9021"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"niri","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito"},"targetKey":"bonito:niri:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2313492685,"desktop":"tuna","digest":"sha256:f1715a354375e8520c28dc65ac32d88757cd8dc1938bd183907cbcae5cb58d5f","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:tuna","repository":"ghcr.io/tuna-os/bonito","tag":"tuna"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:ff308e1db6c37c67904996d5e8cba1e788a4ea2b779b79ef4724d1e48ab47f94","engineRevision":null,"indexDigest":"sha256:7224df6d76f78114f39d068a4600bace3fd1b7979458ac41064fc23215a705d0","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:f1715a354375e8520c28dc65ac32d88757cd8dc1938bd183907cbcae5cb58d5f"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"tuna","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:tuna:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3365031234,"desktop":"xfce","digest":"sha256:e1067b6114c47a28a33ecadc6d33517fb951060e88c26debfc3e7bf850f6981a","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:xfce-nvidia","repository":"ghcr.io/tuna-os/bonito","tag":"xfce-nvidia"},"qualification":{"browser":null,"browserBuildReceiptDigest":null,"buildOrigin":"browser","inheritedFrom":"bonito:xfce:linux/amd64","isoDigest":"sha256:7d24fef25e3bfd6a4a7c8e15e7b4276389eb49cf5a66e4117b78fb66d02d301c","producer":{"ref":"refs/heads/main","repository":"tuna-os/iso-builder","runAttempt":1,"runId":43357260660,"sha":"1f2ebb7a53f95b29a8aea716c48fcac0715dde9f","workflow":".github/workflows/ci.yml"},"qualifiedAt":"2026-11-13T05:30:03Z","reason":null,"receiptDigest":"sha256:9d57cfe0b8f63f41008f5a24b4d8bc8940f0480a528bb9df559263f026ed8bae","receiptImageDigest":"sha256:00e5d2c2fda3e0099c573279e60d5541ea3c7571864a5fb9e267ed72de10e07f","receiptPlatform":"linux/amd64","receiptSchema":"BrowserIsoQualificationReceipt/v1","resources":null,"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:ab67760e9016ca087ff9dca64e444f2730bdf2f3252de96685889229326742d8","engineRevision":"sha256:399389ecea74de0b9fe8495766a6e33a3592675e2106600f90ea44ae023a1bdd","indexDigest":"sha256:e2d3df6b09a3cd76a2f4e18062ef7a762f3f80f540c10187bc64f9bb345872db","installerRevision":"sha256:375556f32b64a1a474f97cc5e38c3efd8fc1588b29f94d8f00177ba1618ba673","liveOverlayBaseDigest":"sha256:e1067b6114c47a28a33ecadc6d33517fb951060e88c26debfc3e7bf850f6981a","liveOverlayDigest":"sha256:fdc27adfe57978ebb752153a8d7c10fc1d8f802189bc8100c12db9ebdd827c3b","platformManifestDigest":"sha256:e1067b6114c47a28a33ecadc6d33517fb951060e88c26debfc3e7bf850f6981a"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:xfce-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2759011270,"desktop":"xfce","digest":"sha256:42d23ed79301bf7965ae2b6d64bccf65e20a7ed3f6b15c6e3a3c8b087da7cbed","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:xfce","repository":"ghcr.io/tuna-os/bonito","tag":"xfce"},"qualification":{"browser":null,"browserBuildReceiptDigest":null,"buildOrigin":"browser","isoDigest":"sha256:7d24fef25e3bfd6a4a7c8e15e7b4276389eb49cf5a66e4117b78fb66d02d301c","producer":{"ref":"refs/heads/main","repository":"tuna-os/iso-builder","runAttempt":1,"runId":43357260660,"sha":"1f2ebb7a53f95b29a8aea716c48fcac0715dde9f","workflow":".github/workflows/ci.yml"},"qualifiedAt":"2026-11-13T05:30:03Z","reason":null,"receiptDigest":"sha256:9d57cfe0b8f63f41008f5a24b4d8bc8940f0480a528bb9df559263f026ed8bae","receiptImageDigest":"sha256:00e5d2c2fda3e0099c573279e60d5541ea3c7571864a5fb9e267ed72de10e07f","receiptPlatform":"linux/amd64","receiptSchema":"BrowserIsoQualificationReceipt/v1","resources":null,"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:c4260b4c1dab8e40c553c6518f49a86e2bd2ae63c3ee8720e07fcd2c6bea5e99","engineRevision":"sha256:399389ecea74de0b9fe8495766a6e33a3592675e2106600f90ea44ae023a1bdd","indexDigest":"sha256:0e685fbc10db7f97f8d4ae38e762656c0ee0b301f75fd784bcbd6b2fb525ba9a","installerRevision":"sha256:375556f32b64a1a474f97cc5e38c3efd8fc1588b29f94d8f00177ba1618ba673","liveOverlayBaseDigest":"sha256:00e5d2c2fda3e0099c573279e60d5541ea3c7571864a5fb9e267ed72de10e07f","liveOverlayDigest":"sha256:a7d472b2c2d2a4bd69c639780ddc55ef69835580e87bb928b61f35cf1351710a","platformManifestDigest":"sha256:00e5d2c2fda3e0099c573279e60d5541ea3c7571864a5fb9e267ed72de10e07f"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:xfce:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2618708993,"desktop":"xfce","digest":"sha256:425ee997ff68e85f1593a5054d159589bbcac7da33c0e4d12a7dd39436501b24","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:xfce","repository":"ghcr.io/tuna-os/bonito","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:565e1520dc7b9b2c72e422160a7f21f59337cbac1d5488b720c2233a953634fd","engineRevision":null,"indexDigest":"sha256:b81c8f7a2f995cdbe87c1917eb4dfe670a15c9e4fc42ac9f669de83d61b220d3","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:425ee997ff68e85f1593a5054d159589bbcac7da33c0e4d12a7dd39436501b24"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"xfce","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito"},"targetKey":"bonito:xfce:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1086500230,"desktop":"","digest":"sha256:398a4ab9fa3f1fbfdded765851ea21bab95c84eab0b0cd967d361b865be97832","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:base-sid","repository":"ghcr.io/tuna-os/flounder","tag":"base-sid"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:e90c423ce4b95074c42d30a4b626f851eda3a9eef0bbbd31c17de6af17cc6503","engineRevision":null,"indexDigest":"sha256:55f60c831e1ca311b341b8d2da049dde2246a032625137808a2662433e486821","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:398a4ab9fa3f1fbfdded765851ea21bab95c84eab0b0cd967d361b865be97832"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder-sid"},"targetKey":"flounder-sid:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2224738766,"desktop":"gnome","digest":"sha256:9ba47cde34d9f5fb4bc3ef625a1a3a316a80f471a4697ab3c92a6026fa03a33c","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:gnome-nvidia-sid","repository":"ghcr.io/tuna-os/flounder","tag":"gnome-nvidia-sid"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:b72c88f6f780a46787a5f7da639c37e7e01225172f522d96ecb055fdcec5902b","engineRevision":null,"indexDigest":"sha256:73212b4af4337010e0eff7ccbe375c59f16bbf870f4bcbc7ef3e919015f6f77b","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:9ba47cde34d9f5fb4bc3ef625a1a3a316a80f471a4697ab3c92a6026fa03a33c"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder-sid"},"targetKey":"flounder-sid:gnome-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1721412162,"desktop":"gnome","digest":"sha256:c5f41b2b548dacfc61c3c4cf88d79de581ff1fd49187fa4068084e1de512b1e4","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:gnome-sid","repository":"ghcr.io/tuna-os/flounder","tag":"gnome-sid"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:0cdf61101dd6cf21cc204c99b39f0d040eaa1b25d2ced3abcce5d8c2e034785f","engineRevision":null,"indexDigest":"sha256:01084281ba2e2f1a9b8dbbf35c3d8f4504a72a406bcf8071dd386f4573a2e310","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:c5f41b2b548dacfc61c3c4cf88d79de581ff1fd49187fa4068084e1de512b1e4"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder-sid"},"targetKey":"flounder-sid:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1876544765,"desktop":"kde","digest":"sha256:5c81cc509271574eaf060c35bd9703671f214a2ee705f6a2ae451a6aecc8e4d7","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:kde-nvidia-sid","repository":"ghcr.io/tuna-os/flounder","tag":"kde-nvidia-sid"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:8f78289469fa4a2bbff915c21054a4268345fa65cb09b04654d80d745066e3b2","engineRevision":null,"indexDigest":"sha256:2ec1883baab572c9d36c8109acc7cea66d044be60ce60bb493e191cb95f18a74","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:5c81cc509271574eaf060c35bd9703671f214a2ee705f6a2ae451a6aecc8e4d7"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder-sid"},"targetKey":"flounder-sid:kde-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1388304232,"desktop":"kde","digest":"sha256:cad8d242665e472c9bee26c3ff81a6df4dcb1e444ad0e6c5e464dc288b655e39","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:kde-sid","repository":"ghcr.io/tuna-os/flounder","tag":"kde-sid"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:e100f43cff13089a17e0b48e9881c25e0c64ae5858e9a5a23ac5bba95f8c9a48","engineRevision":null,"indexDigest":"sha256:e68261395b8c067036f79fc3b91fc35b33b2c5d2344e95648285f862d0cab86d","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:cad8d242665e472c9bee26c3ff81a6df4dcb1e444ad0e6c5e464dc288b655e39"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder-sid"},"targetKey":"flounder-sid:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1406610042,"desktop":"tuna","digest":"sha256:8d87f4b2e4fe4ef6414484e8807707e38790127381952752e941e1266b0acece","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:tuna-sid","repository":"ghcr.io/tuna-os/flounder","tag":"tuna-sid"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:3df157de53da974b32dff838df57b98db9884f04dd207d4d87f1f7dffa55bbdb","engineRevision":null,"indexDigest":"sha256:1f802efa9addb4d7e112ac5556f3dcc90113057f075b3e78b0bef894b463b5c6","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:8d87f4b2e4fe4ef6414484e8807707e38790127381952752e941e1266b0acece"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"tuna","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder-sid"},"targetKey":"flounder-sid:tuna:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1639708525,"desktop":"xfce","digest":"sha256:b45f1f1d61ffb558721460883d39e2dcdbbb55eb2b43df9e4ab2189367f8db6a","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:xfce-nvidia-sid","repository":"ghcr.io/tuna-os/flounder","tag":"xfce-nvidia-sid"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:ea5dec6db5072ef6c6c0fee14f63f75d3af2db3b4598249a83b3d7fb560e2613","engineRevision":null,"indexDigest":"sha256:20a389d0cf8a928dabd7fa87c09d096f024f4d17726140b9f9c14166ca6f2abc","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:b45f1f1d61ffb558721460883d39e2dcdbbb55eb2b43df9e4ab2189367f8db6a"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder-sid"},"targetKey":"flounder-sid:xfce-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1151815661,"desktop":"xfce","digest":"sha256:a3ca5cb045f9a0a939248638722f1ebabdce6c8149772e0bf35ff9a31daabfda","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:xfce-sid","repository":"ghcr.io/tuna-os/flounder","tag":"xfce-sid"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:9776245a8fb7344a09a6d3a27f077bc0c531ddc27c37df3e028f51183663a532","engineRevision":null,"indexDigest":"sha256:46c7ca3383b4204b42edde7f179bbe947d15e5fd4720f0fb82ba203ebf754fd0","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:a3ca5cb045f9a0a939248638722f1ebabdce6c8149772e0bf35ff9a31daabfda"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder-sid"},"targetKey":"flounder-sid:xfce:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1055032178,"desktop":"","digest":"sha256:f033b47000c2881122ddd6d1aeb4c4a49d8c2aa99f90b76b28e2c353845e862e","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:base","repository":"ghcr.io/tuna-os/flounder","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:8fc346823b7907066fb21a52e9603d472566f1d80bba62033ed5402045004504","engineRevision":null,"indexDigest":"sha256:09074e9b2dd33683409fdcd21aac47f1322cd8f5a7f804dfee67ba38735b932a","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:f033b47000c2881122ddd6d1aeb4c4a49d8c2aa99f90b76b28e2c353845e862e"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder"},"targetKey":"flounder:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":995789041,"desktop":"","digest":"sha256:9fbbcfabe5c0e9b4ef89f94d694a720971489c621cb35c84573c60974cd33972","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:base","repository":"ghcr.io/tuna-os/flounder","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:5e55fae4358555b7eaa54c4fde2d0ace7fa53447725d4e12f4d6a43fa386bd9d","engineRevision":null,"indexDigest":"sha256:09074e9b2dd33683409fdcd21aac47f1322cd8f5a7f804dfee67ba38735b932a","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:9fbbcfabe5c0e9b4ef89f94d694a720971489c621cb35c84573c60974cd33972"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base","hardwareScope":"generic","platform":"linux/arm64","variant":"flounder"},"targetKey":"flounder:base:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1833608726,"desktop":"kde","digest":"sha256:39845da10e4d4c200eeac4f9da3bb7b3814b6971ed14bd2480b016f5e11e9831","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:kde-nvidia","repository":"ghcr.io/tuna-os/flounder","tag":"kde-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:563704e42593c19c4e810e1e9d8e7935c0311a10530bd6fe40c065027b4fec4b","engineRevision":null,"indexDigest":"sha256:89f5fd5e5d3a204043e1ac7f5a381511a59f2e98bd40e9790b6c18dc6abfa488","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:39845da10e4d4c200eeac4f9da3bb7b3814b6971ed14bd2480b016f5e11e9831"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder"},"targetKey":"flounder:kde-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1351801310,"desktop":"kde","digest":"sha256:89158336253ea99952c1a57b279aa9bcbd22600a0a61f8fc3ddc3a7608293260","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:kde","repository":"ghcr.io/tuna-os/flounder","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:7d8e008ddee87f618974a6f68596561db8a1bea094868a83a44b7c407e86b025","engineRevision":null,"indexDigest":"sha256:7495629f7fb2d3f843ae5e7436d98c8aba3ad12efcd46240d22cd5b7d2b5d449","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:89158336253ea99952c1a57b279aa9bcbd22600a0a61f8fc3ddc3a7608293260"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder"},"targetKey":"flounder:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1356204478,"desktop":"tuna","digest":"sha256:5a32046de290f0e2d1ea299eb6a27453ede6ee0e346be6df02c5da9280e5bdf0","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:tuna","repository":"ghcr.io/tuna-os/flounder","tag":"tuna"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:df8cd89d79b99f696b1645fe274686b693edc3eafd48bdc8005b5b4e792f1b5b","engineRevision":null,"indexDigest":"sha256:857bdeff5683e06c245df039937650bc3faaea5f3bb9ff486e556d68190470b3","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:5a32046de290f0e2d1ea299eb6a27453ede6ee0e346be6df02c5da9280e5bdf0"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"tuna","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder"},"targetKey":"flounder:tuna:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1603379527,"desktop":"xfce","digest":"sha256:338280c61c3426fa46eb18417f75745fe763f0f6f2dec235f8064f9d27bf3775","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:xfce-nvidia","repository":"ghcr.io/tuna-os/flounder","tag":"xfce-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:97c66509b9bf89a79b37a83e86e551b997af6ba162bf25807340b394b11ff9fe","engineRevision":null,"indexDigest":"sha256:5924ecd5c855b23275deecf2bcbc8587b6a0ff15349d86f3fc20a50a3f6f0cee","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:338280c61c3426fa46eb18417f75745fe763f0f6f2dec235f8064f9d27bf3775"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder"},"targetKey":"flounder:xfce-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1120668192,"desktop":"xfce","digest":"sha256:65c6b2f1afae4cb5290954fee6dd545bbec1aa7e835de7e7988f259eb7ba3cbe","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:xfce","repository":"ghcr.io/tuna-os/flounder","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:4032c04b9700d0eac68e80cb276ec2f30975f00ed9deee0d50c3f1a6c3da4eab","engineRevision":null,"indexDigest":"sha256:0488153b45dc0d940da6508438ab13033b2ce15ba75083c087a40b72253ae704","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:65c6b2f1afae4cb5290954fee6dd545bbec1aa7e835de7e7988f259eb7ba3cbe"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder"},"targetKey":"flounder:xfce:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1787203139,"desktop":"","digest":"sha256:40c641cff2a0a02acaf169d9a6ee5e94a6229bf77d7ed9a6aaba56f2108290a6","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:base","repository":"ghcr.io/tuna-os/grouper","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:320852e992b36750a5016f0e0b727f7c28854472490539ee41ad38d0919f2ff8","engineRevision":null,"indexDigest":"sha256:a38fcb5035688ef68fb00f48c884146d9b7d33a963d78968304c1a846207d300","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:40c641cff2a0a02acaf169d9a6ee5e94a6229bf77d7ed9a6aaba56f2108290a6"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"grouper"},"targetKey":"grouper:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1782246698,"desktop":"","digest":"sha256:d35998e20dcc3ceb2f225b44cc8c5a91c40bc3b11aa4ee1e69d34718999e55ef","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:base","repository":"ghcr.io/tuna-os/grouper","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:30ee50ba778dc6da0457667b6061f2f5f2bf6495bfd89adff5bc5e8cb75e8393","engineRevision":null,"indexDigest":"sha256:a38fcb5035688ef68fb00f48c884146d9b7d33a963d78968304c1a846207d300","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:d35998e20dcc3ceb2f225b44cc8c5a91c40bc3b11aa4ee1e69d34718999e55ef"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base","hardwareScope":"generic","platform":"linux/arm64","variant":"grouper"},"targetKey":"grouper:base:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2103141358,"desktop":"cosmic","digest":"sha256:57257478453b6af5567852d8ed39d586df4f3a0a0fbdddfa53716a2d13b55346","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:cosmic","repository":"ghcr.io/tuna-os/grouper","tag":"cosmic"},"qualification":{"browser":null,"browserBuildReceiptDigest":null,"buildOrigin":"browser","isoDigest":"sha256:2b5d9705850b5074c8b4859edf5126f3e50c477167ffd79ff09490180bfecdd7","producer":{"ref":"refs/heads/main","repository":"tuna-os/iso-builder","runAttempt":1,"runId":43519057122,"sha":"72d171d2cd8b8be431201f787f453bb3e957aeb2","workflow":".github/workflows/ci.yml"},"qualifiedAt":"2026-11-14T00:24:57Z","reason":null,"receiptDigest":"sha256:238702a37a21397093f8b97ff9da9a517c5a614137b4d5d8ea866fa7746a4e09","receiptImageDigest":"sha256:57257478453b6af5567852d8ed39d586df4f3a0a0fbdddfa53716a2d13b55346","receiptPlatform":"linux/amd64","receiptSchema":"BrowserIsoQualificationReceipt/v1","resources":null,"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:baab1057092e02cc32d9a6815acd8389b05ea74417435e7588d177b711d55fc6","engineRevision":"sha256:399389ecea74de0b9fe8495766a6e33a3592675e2106600f90ea44ae023a1bdd","indexDigest":"sha256:348c5dd14d04fb81dd50165146ede6ff54bef7a376541ba1e9180cbb7323f559","installerRevision":"sha256:4170e55bcf2ae01ec21ffd2c17a52228e4ffc779f6a4802a498fb3c78a06aa99","liveOverlayBaseDigest":"sha256:57257478453b6af5567852d8ed39d586df4f3a0a0fbdddfa53716a2d13b55346","liveOverlayDigest":"sha256:659bc287677767fc86511860788edd66ae36c013e2a78744f9e166924c52f62d","platformManifestDigest":"sha256:57257478453b6af5567852d8ed39d586df4f3a0a0fbdddfa53716a2d13b55346"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic","hardwareScope":"generic","platform":"linux/amd64","variant":"grouper"},"targetKey":"grouper:cosmic:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2151875237,"desktop":"gnome","digest":"sha256:a7608aadb6db70539e4d8729730daaad0cafd170b553e6fe521001574c1edfd0","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:gnome-asahi","repository":"ghcr.io/tuna-os/grouper","tag":"gnome-asahi"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:a03f11a3b264af48839b8adb0a894d0da5ef4ec3a5972c6ea1e10bd897f470b6","engineRevision":null,"indexDigest":"sha256:63946bbdbcac8583726c974f22ddbbe2d6daa0c73740b68998d3fb3310aa1960","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:a7608aadb6db70539e4d8729730daaad0cafd170b553e6fe521001574c1edfd0"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome-asahi","hardwareScope":"apple-silicon","platform":"linux/arm64","variant":"grouper"},"targetKey":"grouper:gnome-asahi:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2143325692,"desktop":"gnome","digest":"sha256:bbc6884b291122170c66ef8823baf8730f885c21c5e743d0789ffa97c23dcf74","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:gnome-zfs","repository":"ghcr.io/tuna-os/grouper","tag":"gnome-zfs"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:ffaf274149488f7d98aca17d4c372be248a3f6067f8af6dee09f096d1b0feb07","engineRevision":null,"indexDigest":"sha256:aa5b8a1c61f74371dd6132ac70163830944c820e594a3bdd727de2fc28d4a3a7","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:bbc6884b291122170c66ef8823baf8730f885c21c5e743d0789ffa97c23dcf74"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-zfs","hardwareScope":"generic","platform":"linux/amd64","variant":"grouper"},"targetKey":"grouper:gnome-zfs:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2133635070,"desktop":"gnome","digest":"sha256:34ebaeab0a5c2f223701acaeb8421f6cd5e6268415f81884be9157ef291f0230","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:gnome-zfs","repository":"ghcr.io/tuna-os/grouper","tag":"gnome-zfs"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:ac44fc21a8353ac05cc2987ed43cd08fe891b2c981cc6d9b0d8a7a5c775842b9","engineRevision":null,"indexDigest":"sha256:aa5b8a1c61f74371dd6132ac70163830944c820e594a3bdd727de2fc28d4a3a7","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:34ebaeab0a5c2f223701acaeb8421f6cd5e6268415f81884be9157ef291f0230"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome-zfs","hardwareScope":"generic","platform":"linux/arm64","variant":"grouper"},"targetKey":"grouper:gnome-zfs:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2245368766,"desktop":"gnome","digest":"sha256:c3967822a96f109019f002375d08a34a48871dffa95ebe76264dc40f42cd665a","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:gnome","repository":"ghcr.io/tuna-os/grouper","tag":"gnome"},"qualification":{"browser":null,"browserBuildReceiptDigest":null,"buildOrigin":"browser","isoDigest":"sha256:aba6124e6cc99f9a945bc852a68800389d2677b5cbc0490950068d9f4e0e1fda","producer":{"ref":"refs/heads/main","repository":"tuna-os/iso-builder","runAttempt":1,"runId":43189769843,"sha":"8908022434d08fe8ba3c603eb24aebbad4332e31","workflow":".github/workflows/ci.yml"},"qualifiedAt":"2026-11-12T10:36:12Z","reason":null,"receiptDigest":"sha256:afbf6cc65fd841cad1cbbc8f508048bddd4ce7e5b288e4c03e962834dc7f6990","receiptImageDigest":"sha256:fae8a52a6ba28ca7a2bdb4a6b14f574947ddd275038ade3f21b32b763d4cf9c4","receiptPlatform":"linux/amd64","receiptSchema":"BrowserIsoQualificationReceipt/v1","resources":null,"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:5517e7996dbcfe3b16f6a4b106a8b604a7b79a93c4eb801d6d1a5d45b946d1c7","engineRevision":"sha256:0d7d21ccf19fb0b6f8578f34bcc085578ee698ea2db6f075e255ea992599d26a","indexDigest":"sha256:2689524279e30ef7969a6b1230459c6b86a3399211b209fa3bf4e9454f502a5f","installerRevision":"sha256:ff28c254d0f0c3fc303cdcd2d7cae1632a55e6f92f1f887c4c6f00559d82417b","liveOverlayBaseDigest":"sha256:fae8a52a6ba28ca7a2bdb4a6b14f574947ddd275038ade3f21b32b763d4cf9c4","liveOverlayDigest":"sha256:b7a11d52258d9038bb53ab367857c1ffe952a621b51376a8c8e7925cbc8ecb5b","platformManifestDigest":"sha256:fae8a52a6ba28ca7a2bdb4a6b14f574947ddd275038ade3f21b32b763d4cf9c4"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"grouper"},"targetKey":"grouper:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2235477645,"desktop":"gnome","digest":"sha256:40b2034638ec14f9da9bced43aa197e887030d2788c4531ce56db6a78d6828d2","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:gnome","repository":"ghcr.io/tuna-os/grouper","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:c04d39899f6e7cefcfa21dacb5f8bcadcd5dcf0fde01b51d1af2b4d3b2fbe17b","engineRevision":null,"indexDigest":"sha256:94a075d6c6b3c5177d81c39efb1ef97c6a33a501e78240150bcc83da1973c765","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:40b2034638ec14f9da9bced43aa197e887030d2788c4531ce56db6a78d6828d2"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome","hardwareScope":"generic","platform":"linux/arm64","variant":"grouper"},"targetKey":"grouper:gnome:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1989755994,"desktop":"kde","digest":"sha256:dcf6001e9863b5d0942aaeb1b7f66628c4c3bf3055c4ef77ee494e13b616fa01","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:kde","repository":"ghcr.io/tuna-os/grouper","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:203025c3240a8540a14d52c21294ec7580c9e328389f3a84940af7f13d298fda","engineRevision":null,"indexDigest":"sha256:57289248be14e2d599960f910cd8cae57b8d2f2d27c1690962530d2b81ae48ec","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:dcf6001e9863b5d0942aaeb1b7f66628c4c3bf3055c4ef77ee494e13b616fa01"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"grouper"},"targetKey":"grouper:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1982919997,"desktop":"kde","digest":"sha256:c1d608dba235939478cb07a5cb3c49706ef83eb322bdb836bd2e2ba498aa5926","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:kde","repository":"ghcr.io/tuna-os/grouper","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:dd909e7a36e3bf80019b461e7a0b5844e4499545ff68ace829077ccfe350fdd2","engineRevision":null,"indexDigest":"sha256:57289248be14e2d599960f910cd8cae57b8d2f2d27c1690962530d2b81ae48ec","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:c1d608dba235939478cb07a5cb3c49706ef83eb322bdb836bd2e2ba498aa5926"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"kde","hardwareScope":"generic","platform":"linux/arm64","variant":"grouper"},"targetKey":"grouper:kde:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2073529523,"desktop":"tuna","digest":"sha256:25c8c7b0e4a4116418c6fd7e7a4301b9b0304f7c99892cfdae545266b1db8d84","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:tuna","repository":"ghcr.io/tuna-os/grouper","tag":"tuna"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:ddd155dfb0046640f34440455c26236a182f20047fd37c474f58fbce74f75ee9","engineRevision":null,"indexDigest":"sha256:d56265fd26af31188eaf9f9788ebb4d79b517572a0a6fc5bac1ac2fe539771a3","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:25c8c7b0e4a4116418c6fd7e7a4301b9b0304f7c99892cfdae545266b1db8d84"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"tuna","hardwareScope":"generic","platform":"linux/amd64","variant":"grouper"},"targetKey":"grouper:tuna:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1816136620,"desktop":"xfce","digest":"sha256:e304a89b252c09e0eaace087ea43068d536d4a333ffb171378c508afbf9a5702","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:xfce","repository":"ghcr.io/tuna-os/grouper","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:74d3b997c375e0d226d8448aaa8fc2c881d14538b07f973d89fe5eb02731ac60","engineRevision":null,"indexDigest":"sha256:d2d3539c5d13ae46c0faf5b46db1426ecb3539e0467fe6e5c6b05b24c40ae780","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:e304a89b252c09e0eaace087ea43068d536d4a333ffb171378c508afbf9a5702"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"grouper"},"targetKey":"grouper:xfce:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1811084277,"desktop":"xfce","digest":"sha256:c9153f4305dd9f383ab9adc6c905640dd297a08ca3b491f86fb5629c9b85a982","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:xfce","repository":"ghcr.io/tuna-os/grouper","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:9037c726aca8ed80fc973b103de997fd447ae88f1841f7adff6380a64860fbe3","engineRevision":null,"indexDigest":"sha256:d2d3539c5d13ae46c0faf5b46db1426ecb3539e0467fe6e5c6b05b24c40ae780","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:c9153f4305dd9f383ab9adc6c905640dd297a08ca3b491f86fb5629c9b85a982"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"xfce","hardwareScope":"generic","platform":"linux/arm64","variant":"grouper"},"targetKey":"grouper:xfce:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2830690402,"desktop":"","digest":"sha256:129a66a86929a8cd0f6d001e927fd1d4027c19ae6432d6287aadf7238dcc9c87","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"emerge","repoFamily":"gentoo"},"publication":{"ref":"ghcr.io/tuna-os/guppy:base","repository":"ghcr.io/tuna-os/guppy","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:f3a158d2656c76c4f0fe7a57811026df13582aeedaba43d44dba891764a4bdc8","engineRevision":null,"indexDigest":"sha256:43037cdfbe923e74e91bf5bf62fcad51a6f20f9da3fdf3437f7b43172951554d","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:129a66a86929a8cd0f6d001e927fd1d4027c19ae6432d6287aadf7238dcc9c87"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"guppy"},"targetKey":"guppy:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3258930780,"desktop":"gnome","digest":"sha256:a65f81ebeba3f1715269daddddcd141a97535b98a3c30911f32b03fe0b8a55fe","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"emerge","repoFamily":"gentoo"},"publication":{"ref":"ghcr.io/tuna-os/guppy:gnome","repository":"ghcr.io/tuna-os/guppy","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:ca876c626b9da5c315308b3f04862824d41bc5fca9f44a0caa8719978aac354a","engineRevision":null,"indexDigest":"sha256:66269ece26d0e7095cd97d5eb38cf6de0443b02e5c6eca9e0746f085ca3ff1c6","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:a65f81ebeba3f1715269daddddcd141a97535b98a3c30911f32b03fe0b8a55fe"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"guppy"},"targetKey":"guppy:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3695549843,"desktop":"kde","digest":"sha256:869dc28910fa9915903370b463e3c2bc0693372f729200dd223c6d71b7cb9133","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"emerge","repoFamily":"gentoo"},"publication":{"ref":"ghcr.io/tuna-os/guppy:kde","repository":"ghcr.io/tuna-os/guppy","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:60c0612a74970be47c7575c202dcc72cb9dec383fb0818a4043f27ac1b578b1c","engineRevision":null,"indexDigest":"sha256:b1f710c1c3492fb89075acbed717be179fc1d904b973cd4f34247e56b93d7d51","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:869dc28910fa9915903370b463e3c2bc0693372f729200dd223c6d71b7cb9133"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"guppy"},"targetKey":"guppy:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2900403397,"desktop":"xfce","digest":"sha256:01e8eefead6cfa4e35df6eda8d407eae9c79369fb0cb07923b76d1e6e5098086","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"emerge","repoFamily":"gentoo"},"publication":{"ref":"ghcr.io/tuna-os/guppy:xfce","repository":"ghcr.io/tuna-os/guppy","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:abc8cae7d43c9ac9ee0fd11f23ed041863afcfc7793b11f9ddd3198b8ec34c74","engineRevision":null,"indexDigest":"sha256:9686201030a9d83a03312d66c99468e280f2308ec1e4aaf3890aa2da26ff5416","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:01e8eefead6cfa4e35df6eda8d407eae9c79369fb0cb07923b76d1e6e5098086"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"guppy"},"targetKey":"guppy:xfce:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1580553324,"desktop":"","digest":"sha256:a09843b64c9184ad6d8cd22b77847b8ad2f4a6f9ad25e8ce6c119423af7bad48","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/gurnard:base","repository":"ghcr.io/tuna-os/gurnard","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:20bd5172cf1fd700b0af0cc85926ce49b02c30a4cb8ceafd8f1690d23eeb8aa7","engineRevision":null,"indexDigest":"sha256:c2d3083f6f9a598b256f87348289ee30862aaf2cef214f901c2f724250fede14","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:a09843b64c9184ad6d8cd22b77847b8ad2f4a6f9ad25e8ce6c119423af7bad48"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"gurnard"},"targetKey":"gurnard:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1542821042,"desktop":"","digest":"sha256:8364e77203a1f4d901c66dc443a1452d42f130d9c61e45dbaa6a83faa5f73024","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/gurnard:base","repository":"ghcr.io/tuna-os/gurnard","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:e4f37f964842d170019a4857a0a830a66cb10ab78aa367fddec17d281daa956b","engineRevision":null,"indexDigest":"sha256:c2d3083f6f9a598b256f87348289ee30862aaf2cef214f901c2f724250fede14","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:8364e77203a1f4d901c66dc443a1452d42f130d9c61e45dbaa6a83faa5f73024"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base","hardwareScope":"generic","platform":"linux/arm64","variant":"gurnard"},"targetKey":"gurnard:base:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1659988978,"desktop":"pantheon","digest":"sha256:f99a6219f8126a02acc2f56f29219a6550d374e428e344c53ce71ca02e08cc1f","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/gurnard:pantheon","repository":"ghcr.io/tuna-os/gurnard","tag":"pantheon"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:7a18b516587ef63f99cf5fd455435eaa984878c92485c7134d3b806a41f756e6","engineRevision":null,"indexDigest":"sha256:7f6cc79b2157e915ae70058bf1ca398f14bcbb08d51e1e4ccfa3e9ad765307dc","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:f99a6219f8126a02acc2f56f29219a6550d374e428e344c53ce71ca02e08cc1f"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"pantheon","hardwareScope":"generic","platform":"linux/amd64","variant":"gurnard"},"targetKey":"gurnard:pantheon:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1620540984,"desktop":"pantheon","digest":"sha256:92547969e007a8c2857b9f1454045c75b63c005d276c7c4ee430ddbc8a59b37a","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/gurnard:pantheon","repository":"ghcr.io/tuna-os/gurnard","tag":"pantheon"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:c0374a816b2f3f9d1b44203a4b3a14a549db72dae4691724231cf20d4c41acf3","engineRevision":null,"indexDigest":"sha256:7f6cc79b2157e915ae70058bf1ca398f14bcbb08d51e1e4ccfa3e9ad765307dc","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:92547969e007a8c2857b9f1454045c75b63c005d276c7c4ee430ddbc8a59b37a"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"pantheon","hardwareScope":"generic","platform":"linux/arm64","variant":"gurnard"},"targetKey":"gurnard:pantheon:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":841052241,"desktop":"","digest":"sha256:4ae00c3b2a21db49630015332dd9080a0b4b59d0dce91bd91080c2e661fb3565","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/hummingbird:base","repository":"ghcr.io/tuna-os/hummingbird","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:a24bb8429ce27d573bdb576af66f22affc70890bcfbfafe93f8fa3bc01a61814","engineRevision":null,"indexDigest":"sha256:91af0af348f90052f8831029d59da49683bb57eb1573e82ed933ae64cc1b1cc5","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:4ae00c3b2a21db49630015332dd9080a0b4b59d0dce91bd91080c2e661fb3565"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"hummingbird"},"targetKey":"hummingbird:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1193415389,"desktop":"cosmic","digest":"sha256:04360b52392abab53704043393fd758b9f343a242a2fdab4d349da93f9f533f0","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/hummingbird:cosmic","repository":"ghcr.io/tuna-os/hummingbird","tag":"cosmic"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:84f342bb8f3576762e66b095fb780742e16a5238ee1c8ce8a3e5dd607a629545","engineRevision":null,"indexDigest":"sha256:ede5242ee8e235933dd4866c3619e055cbd820300fe3d9807feecfe4f7fcc4ba","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:04360b52392abab53704043393fd758b9f343a242a2fdab4d349da93f9f533f0"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic","hardwareScope":"generic","platform":"linux/amd64","variant":"hummingbird"},"targetKey":"hummingbird:cosmic:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1718947608,"desktop":"gnome","digest":"sha256:83060f29b37743b0086e88546ac1b223e2373ae7f23fe0a8dc68a37c92cee6d2","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/hummingbird:gnome","repository":"ghcr.io/tuna-os/hummingbird","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:7b4273fe1a503cc7c4cbdf2e2ec35ab1c7de246a184436f157e4e58f9e7a9ebb","engineRevision":null,"indexDigest":"sha256:7fb82c04e8dfa63d76299dd07f2d82ea3c832485f913840fd88d56ea472411dd","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:83060f29b37743b0086e88546ac1b223e2373ae7f23fe0a8dc68a37c92cee6d2"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"hummingbird"},"targetKey":"hummingbird:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1623684218,"desktop":"","digest":"sha256:6a02c918bcf6ef773e3db265d6bdf046bf5f4730e494cf1a085600e68e9099c6","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:base","repository":"ghcr.io/tuna-os/marlin","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:a6eafddcac6229e433e36ed6a0e457d625e02761c68d5214622502af6272a195","engineRevision":null,"indexDigest":"sha256:7f8b5fc7698ccaffb82038bc0bd43da036f0b8d3e4d44f405edd4aecd9993c23","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:6a02c918bcf6ef773e3db265d6bdf046bf5f4730e494cf1a085600e68e9099c6"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1507911296,"desktop":"","digest":"sha256:16298c4a6986a76478118ad948254c81a26d554020f9ed5463cd824d8c4a1047","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:base","repository":"ghcr.io/tuna-os/marlin","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:a92a67e5560043426b82cfda6c92dc373342a6d7a5f258b42ad73c3e207fa8cf","engineRevision":null,"indexDigest":"sha256:7f8b5fc7698ccaffb82038bc0bd43da036f0b8d3e4d44f405edd4aecd9993c23","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:16298c4a6986a76478118ad948254c81a26d554020f9ed5463cd824d8c4a1047"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base","hardwareScope":"generic","platform":"linux/arm64","variant":"marlin"},"targetKey":"marlin:base:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2984420658,"desktop":"cosmic","digest":"sha256:bf51efa4751bf594cdb60f67d53214441bf1c09d8e13291475b53fb9a749bc1e","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:cosmic-cachyos","repository":"ghcr.io/tuna-os/marlin","tag":"cosmic-cachyos"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:de1e5b790caec196aae450db1f5762a3d635b151a14aff05773cf3b025a831f9","engineRevision":null,"indexDigest":"sha256:c9e44337c3a61c3b0600532dba86f4a79c9ec8367abbc7ee85da31b5e7aeb0aa","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:bf51efa4751bf594cdb60f67d53214441bf1c09d8e13291475b53fb9a749bc1e"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic-cachyos","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:cosmic-cachyos:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3560164337,"desktop":"cosmic","digest":"sha256:c7113a38d637078da68ed4569c7f920f85d845b25b32e058c61e6a482c4e9a94","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:cosmic-nvidia","repository":"ghcr.io/tuna-os/marlin","tag":"cosmic-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:7bfdaa3201fe58f8e8fb430b2198b6941e68999d326b809cd64fb8a4e98a3187","engineRevision":null,"indexDigest":"sha256:36e74f668b42552200ddf0056ec7c460b616a3d54835e3b7a33af66f5bb09b3c","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:c7113a38d637078da68ed4569c7f920f85d845b25b32e058c61e6a482c4e9a94"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:cosmic-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2352924986,"desktop":"cosmic","digest":"sha256:cf0a5516885f0e4c121a37e925fff8289ff41200328e1cba664a75793e71de2e","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:cosmic","repository":"ghcr.io/tuna-os/marlin","tag":"cosmic"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:d4e0a659c09418631281172f83a5d47cc6c3a0de5d074b4f636865367307a7b5","engineRevision":null,"indexDigest":"sha256:0f11fd2fabf59f52ba59fb6ba018061f9de8b4587f4ad8c2c2b8a4eeaff50002","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:cf0a5516885f0e4c121a37e925fff8289ff41200328e1cba664a75793e71de2e"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:cosmic:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3053038522,"desktop":"gnome","digest":"sha256:6482608006c243f5a2474f5a079e07adda5607e0c3755312b46b94e6250d6796","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:gnome-cachyos","repository":"ghcr.io/tuna-os/marlin","tag":"gnome-cachyos"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:0cca5ec2438abcc4677fa3a418c791740fbac6843b5692c1151e18835a6d7119","engineRevision":null,"indexDigest":"sha256:522bfe332aac090b67920218f3f1f7e2ea94b1a89a4de7f2cbd8a3aa19bef896","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:6482608006c243f5a2474f5a079e07adda5607e0c3755312b46b94e6250d6796"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-cachyos","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:gnome-cachyos:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3628739767,"desktop":"gnome","digest":"sha256:43fdad92d6bc7eb38bbcd4f0bbe5b535da9b15df441eeede45e4a2a5a35edc78","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:gnome-nvidia","repository":"ghcr.io/tuna-os/marlin","tag":"gnome-nvidia"},"qualification":{"browser":null,"browserBuildReceiptDigest":null,"buildOrigin":"browser","inheritedFrom":"marlin:gnome:linux/amd64","isoDigest":"sha256:d25cd3b19f1a07a325e531a9aa6a76c8154f848028f305e6234aa5ad3ccd85a9","producer":{"ref":"refs/heads/main","repository":"tuna-os/iso-builder","runAttempt":1,"runId":42193686727,"sha":"e4ea9748a0f9bea4d800465f51fec9e72c96b42c","workflow":".github/workflows/ci.yml"},"qualifiedAt":"2026-11-06T10:52:25Z","reason":null,"receiptDigest":"sha256:b498c186bd64b6de251b70dddb329ad90021f53d85d795009cb68f6667085dd8","receiptImageDigest":"sha256:b71d6ab6e652624676803bfc2f04b985a88c48aa138be84eef42fe5a222d83eb","receiptPlatform":"linux/amd64","receiptSchema":"BrowserIsoQualificationReceipt/v1","resources":null,"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:6097197896d6578ed37cdc7884c2f73835fbda340bd40a9120a79fd5f5d42d99","engineRevision":"sha256:ca5a07efa6b4dbb145d15c32a777de34c3d9a984f83f6fe8e236ffe5a9038aad","indexDigest":"sha256:ae5f80b77696c496a0623603d7bff4f013b7803023550bdb97340209b60e73bd","installerRevision":"sha256:ff28c254d0f0c3fc303cdcd2d7cae1632a55e6f92f1f887c4c6f00559d82417b","liveOverlayBaseDigest":"sha256:43fdad92d6bc7eb38bbcd4f0bbe5b535da9b15df441eeede45e4a2a5a35edc78","liveOverlayDigest":"sha256:937b8204815eab0d02619b94aa705f9cc434d98cc2abdcf0c244715e4f5e2ca2","platformManifestDigest":"sha256:43fdad92d6bc7eb38bbcd4f0bbe5b535da9b15df441eeede45e4a2a5a35edc78"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:gnome-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2399659704,"desktop":"gnome","digest":"sha256:8953793052fb5f38101b57f7ce4b52f95983e9d315befde9a135ed8bd59345f9","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:gnome","repository":"ghcr.io/tuna-os/marlin","tag":"gnome"},"qualification":{"browser":null,"browserBuildReceiptDigest":null,"buildOrigin":"browser","isoDigest":"sha256:d25cd3b19f1a07a325e531a9aa6a76c8154f848028f305e6234aa5ad3ccd85a9","producer":{"ref":"refs/heads/main","repository":"tuna-os/iso-builder","runAttempt":1,"runId":42193686727,"sha":"e4ea9748a0f9bea4d800465f51fec9e72c96b42c","workflow":".github/workflows/ci.yml"},"qualifiedAt":"2026-11-06T10:52:25Z","reason":null,"receiptDigest":"sha256:b498c186bd64b6de251b70dddb329ad90021f53d85d795009cb68f6667085dd8","receiptImageDigest":"sha256:b71d6ab6e652624676803bfc2f04b985a88c48aa138be84eef42fe5a222d83eb","receiptPlatform":"linux/amd64","receiptSchema":"BrowserIsoQualificationReceipt/v1","resources":null,"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:9e1990c1a2fc2615bce8eba94ebe29bbf949278310626b7e77364b553faa7080","engineRevision":"sha256:ca5a07efa6b4dbb145d15c32a777de34c3d9a984f83f6fe8e236ffe5a9038aad","indexDigest":"sha256:244496340ec984f13ce038ca195ad724f5505cfb7cc415af80776ea8def5d0d1","installerRevision":"sha256:ff28c254d0f0c3fc303cdcd2d7cae1632a55e6f92f1f887c4c6f00559d82417b","liveOverlayBaseDigest":"sha256:b71d6ab6e652624676803bfc2f04b985a88c48aa138be84eef42fe5a222d83eb","liveOverlayDigest":"sha256:8317c1621a3a569553317f157a742cb19973e17cd4eb861168eba4e1a401ae61","platformManifestDigest":"sha256:b71d6ab6e652624676803bfc2f04b985a88c48aa138be84eef42fe5a222d83eb"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2376314656,"desktop":"gnome","digest":"sha256:09c4cc2cd07899aff33f77042d9bb95a4181208302094bed90fcc719732a47ba","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:gnome","repository":"ghcr.io/tuna-os/marlin","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:0c901afec9218b7ee48644e95c78324dd1f8dd961c0eda3c67ed671343ed0aa3","engineRevision":null,"indexDigest":"sha256:3e13c129612854de15822b3db6d7a0ac6cc5b1c5f9eebe67b95abd8fd7ba0fec","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:09c4cc2cd07899aff33f77042d9bb95a4181208302094bed90fcc719732a47ba"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome","hardwareScope":"generic","platform":"linux/arm64","variant":"marlin"},"targetKey":"marlin:gnome:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3013750193,"desktop":"kde","digest":"sha256:6aa74f1576d3e071b849d6e70d281fc91247515aa9a15a630e02a9d301a704e8","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:kde-cachyos","repository":"ghcr.io/tuna-os/marlin","tag":"kde-cachyos"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:7c66dc35fec1fd2ae2aa845a6734806a57c7f7592ca4d420d2901c0ce79211e8","engineRevision":null,"indexDigest":"sha256:a8bcdd19ea6e6aef4045863dc48af8cfd6bc8d5c33b7223b05707993875e2445","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:6aa74f1576d3e071b849d6e70d281fc91247515aa9a15a630e02a9d301a704e8"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde-cachyos","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:kde-cachyos:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3589883455,"desktop":"kde","digest":"sha256:2cce378e96e5943ca15ce93f582cb09c346a86d8ceb23f79d3f0a0389edaa84e","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:kde-nvidia","repository":"ghcr.io/tuna-os/marlin","tag":"kde-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:176364bad99cfa26e6004b1c41e8a3482533e0a4376cc2c78ae9af44de36ca57","engineRevision":null,"indexDigest":"sha256:47aa3a61426f69e4555040bd04597f9f0bcbbb8b4996c287dc9202e1284243b6","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:2cce378e96e5943ca15ce93f582cb09c346a86d8ceb23f79d3f0a0389edaa84e"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:kde-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2361472514,"desktop":"kde","digest":"sha256:19a03a570940d2978308657e91f97c0969d720abe4e8ae46cdc6dba253bb163c","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:kde","repository":"ghcr.io/tuna-os/marlin","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:633514a50a5acd558ac89329cc9cf09597da8005dd1cc52e567bda5b2ebb5f50","engineRevision":null,"indexDigest":"sha256:abbfb5632e2e5a55352a432a17f440f7d7fa1a887e8ed69549875ceea0e6687d","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:19a03a570940d2978308657e91f97c0969d720abe4e8ae46cdc6dba253bb163c"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2536838458,"desktop":"niri","digest":"sha256:8bf222c62ab67658ed1c2128abcfe80a749f48bf74189cb0a1287aabfe11d68c","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:niri-cachyos","repository":"ghcr.io/tuna-os/marlin","tag":"niri-cachyos"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:7398b165cf0647ef241afb398162be923ad084cf63bb43ebaa0e22469cb642d5","engineRevision":null,"indexDigest":"sha256:b6abf3d53323929c008862ae588190cedd7020f80b50fd3fea966f719da9562d","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:8bf222c62ab67658ed1c2128abcfe80a749f48bf74189cb0a1287aabfe11d68c"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri-cachyos","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:niri-cachyos:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3113443472,"desktop":"niri","digest":"sha256:0dc53bd5e19882431faf342b941de5950b705043a2ef324f11a17bb528362f91","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:niri-nvidia","repository":"ghcr.io/tuna-os/marlin","tag":"niri-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:1fcbc4155ba20c1a029aea802b314ee1b5de9dcccdec99fa5c625b25f4046bab","engineRevision":null,"indexDigest":"sha256:160121aeab3211d38825708588668cf53feab45e1c5b4375dbdc04f33bb3b260","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:0dc53bd5e19882431faf342b941de5950b705043a2ef324f11a17bb528362f91"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:niri-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1907808973,"desktop":"niri","digest":"sha256:ea937092a69f98e89724ed4774a534c13c24412efe627b955c49ab148737e70b","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:niri","repository":"ghcr.io/tuna-os/marlin","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:9e8a3aeef589ab320e5c9b41d55682ebcdf953dcef1c5e92a04032a19735abf7","engineRevision":null,"indexDigest":"sha256:b5e412509a4c06d78337caf860dad6fab4a941af37deef1ea210401467163beb","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:ea937092a69f98e89724ed4774a534c13c24412efe627b955c49ab148737e70b"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:niri:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2325740567,"desktop":"tuna","digest":"sha256:9ba0fbac682fc9b4bdeab560c1486254704a64ded3ddc9a06353d527e8db1dd1","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:tuna","repository":"ghcr.io/tuna-os/marlin","tag":"tuna"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:e2c864fd457966f922e72ce43fbeac0fe60dfe24d7b6883325b872b98afb868b","engineRevision":null,"indexDigest":"sha256:d140af00452eada8028209c3f340b6b43f8ad78b7c93c27a3de6ea84a243025d","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:9ba0fbac682fc9b4bdeab560c1486254704a64ded3ddc9a06353d527e8db1dd1"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"tuna","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:tuna:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2662512068,"desktop":"xfce","digest":"sha256:d6bddff2f6a5ca2996f7b4f93a654793958eed09df3eaffffc109915690ac62b","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:xfce-cachyos","repository":"ghcr.io/tuna-os/marlin","tag":"xfce-cachyos"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:909df4daad730d1fef7334864b59f12c01ad565ed318bbedfb49c45151f7cf11","engineRevision":null,"indexDigest":"sha256:a779e76b0cae3343bc93b82eed5f8c9aef633d45f74826986bf2c6c4c674d58a","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:d6bddff2f6a5ca2996f7b4f93a654793958eed09df3eaffffc109915690ac62b"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce-cachyos","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:xfce-cachyos:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3238004153,"desktop":"xfce","digest":"sha256:4c6479f26dde073f50906d6c0101889471756596bb77a1d221c57aa825157e43","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:xfce-nvidia","repository":"ghcr.io/tuna-os/marlin","tag":"xfce-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:53ec183292c3ef397c0022b23be531ef0707efbf7e78680044bb878c3ec63e6d","engineRevision":null,"indexDigest":"sha256:1fc6e56f7aac3b93b4ff0763d84e924f4b6a512d6429ec0ae86244fc52d3a999","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:4c6479f26dde073f50906d6c0101889471756596bb77a1d221c57aa825157e43"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:xfce-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1735128853,"desktop":"xfce","digest":"sha256:f06c3ad5b459436f65cfd2d1f2e9028111776ac54a268f25aa9bc69c6fbaeea4","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:xfce","repository":"ghcr.io/tuna-os/marlin","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:f9ee8771c21d9ed0107e958e316e21d212aa105eabbc0ae45a920eef66de0873","engineRevision":null,"indexDigest":"sha256:9425494f86ccbe5bb9eb6bd9174bc2fe442f314332fa8e236b08b01d512654dc","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:f06c3ad5b459436f65cfd2d1f2e9028111776ac54a268f25aa9bc69c6fbaeea4"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:xfce:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1684952050,"desktop":"","digest":"sha256:5e40d1d8ca38b83c9d2a4c80f1ebab3f1f3030230a9e195315fe9551fbb6dd0d","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"zypper","repoFamily":"opensuse"},"publication":{"ref":"ghcr.io/tuna-os/sailfin:base","repository":"ghcr.io/tuna-os/sailfin","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:ab5de9ea89003073aa40d0230a00c47afb1186c4990067c5b2e9ec62bf1c89e7","engineRevision":null,"indexDigest":"sha256:2cf2afa32e3fa4c2b4c519281f700931276edc2b8d498a12e9323ac9481a7c4c","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:5e40d1d8ca38b83c9d2a4c80f1ebab3f1f3030230a9e195315fe9551fbb6dd0d"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"sailfin"},"targetKey":"sailfin:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1710566502,"desktop":"","digest":"sha256:f1dec9af5c318299f7973c980f9112c866d98d629e92d31eb92b0a28ba927c88","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"zypper","repoFamily":"opensuse"},"publication":{"ref":"ghcr.io/tuna-os/sailfin:base","repository":"ghcr.io/tuna-os/sailfin","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:cb6e2456ca5d4d34984db083f4e8796577c177d94760e8ae76b001cc3bce855d","engineRevision":null,"indexDigest":"sha256:2cf2afa32e3fa4c2b4c519281f700931276edc2b8d498a12e9323ac9481a7c4c","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:f1dec9af5c318299f7973c980f9112c866d98d629e92d31eb92b0a28ba927c88"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base","hardwareScope":"generic","platform":"linux/arm64","variant":"sailfin"},"targetKey":"sailfin:base:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1961340089,"desktop":"cosmic","digest":"sha256:03b0a31a2cf27ca393fcc0c44538b89959a5c7e809d6a0aee2a32d801f37379e","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"zypper","repoFamily":"opensuse"},"publication":{"ref":"ghcr.io/tuna-os/sailfin:cosmic","repository":"ghcr.io/tuna-os/sailfin","tag":"cosmic"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:bfc81d85393660b16e12d2cece4a80747de5623385d8d822336ba7da12cf81c0","engineRevision":null,"indexDigest":"sha256:87ba63485e2a451e405d4460d52c4d354c86d6dd3620fc876a6b7df0826e78e7","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:03b0a31a2cf27ca393fcc0c44538b89959a5c7e809d6a0aee2a32d801f37379e"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic","hardwareScope":"generic","platform":"linux/amd64","variant":"sailfin"},"targetKey":"sailfin:cosmic:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2093911072,"desktop":"gnome","digest":"sha256:113a110df109f8f6a479f9ea15aa4945b0e47cfbabeb3e0f702dcc8639b2f4bd","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"zypper","repoFamily":"opensuse"},"publication":{"ref":"ghcr.io/tuna-os/sailfin:gnome","repository":"ghcr.io/tuna-os/sailfin","tag":"gnome"},"qualification":{"browser":null,"browserBuildReceiptDigest":null,"buildOrigin":"browser","isoDigest":"sha256:6a80a046ca5cceede2bf284c5b75f55b1725b9d4ec2847cbba4ffb8566b2ce1b","producer":{"ref":"refs/heads/main","repository":"tuna-os/iso-builder","runAttempt":1,"runId":43156118769,"sha":"d29b5e92b1b5340de08079bf223e3cd18a93ba11","workflow":".github/workflows/ci.yml"},"qualifiedAt":"2026-11-12T06:15:55Z","reason":null,"receiptDigest":"sha256:30b0bfaade815d07faee41f0c9d8737ff908e344e49280782f1ced05e63e88de","receiptImageDigest":"sha256:c847dcdc74d0521adec00c2fac7020fdcc4b6ea27e9c239df6cccf859be2c014","receiptPlatform":"linux/amd64","receiptSchema":"BrowserIsoQualificationReceipt/v1","resources":null,"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:15b2a2e874dcd12697a4bf803c73bb0517300be4491736b988051d0cf9730913","engineRevision":"sha256:0d7d21ccf19fb0b6f8578f34bcc085578ee698ea2db6f075e255ea992599d26a","indexDigest":"sha256:3c2556edc8e56a5de29e57868d3820107e4e7efc7f4fecb4c5600dddd023b0db","installerRevision":"sha256:ff28c254d0f0c3fc303cdcd2d7cae1632a55e6f92f1f887c4c6f00559d82417b","liveOverlayBaseDigest":"sha256:c847dcdc74d0521adec00c2fac7020fdcc4b6ea27e9c239df6cccf859be2c014","liveOverlayDigest":"sha256:b8120174d410b850c045f0cfa7c88a247204e2e3ecbdbc089568d24cd5ca49c6","platformManifestDigest":"sha256:c847dcdc74d0521adec00c2fac7020fdcc4b6ea27e9c239df6cccf859be2c014"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"sailfin"},"targetKey":"sailfin:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2076337809,"desktop":"gnome","digest":"sha256:fede320f5c839154f52c4ae477fc0c6920bfc392e09ae61df3e63950d3c50d2f","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"zypper","repoFamily":"opensuse"},"publication":{"ref":"ghcr.io/tuna-os/sailfin:gnome","repository":"ghcr.io/tuna-os/sailfin","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:b25e5ff2703f04269f4b3102c43ad6000d6c2d594472c53979e8e4eb1785fad6","engineRevision":null,"indexDigest":"sha256:931b933178166ea0c63517f01627dfff27e40c716f6aeab9c6766d657d736bdb","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:fede320f5c839154f52c4ae477fc0c6920bfc392e09ae61df3e63950d3c50d2f"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome","hardwareScope":"generic","platform":"linux/arm64","variant":"sailfin"},"targetKey":"sailfin:gnome:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2455818871,"desktop":"kde","digest":"sha256:8e110a52eea448221f003df6651818c0c2364fbe1f0616ba060c93e733b61b5f","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"zypper","repoFamily":"opensuse"},"publication":{"ref":"ghcr.io/tuna-os/sailfin:kde","repository":"ghcr.io/tuna-os/sailfin","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:56519f33baa48adcc3d5aa9f4f1b19750010b5bf5800298fb95223a04d576760","engineRevision":null,"indexDigest":"sha256:93dd623855ccc19ee70dd52440c666b0661b518c75c2c588bd16969741e6e834","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:8e110a52eea448221f003df6651818c0c2364fbe1f0616ba060c93e733b61b5f"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"sailfin"},"targetKey":"sailfin:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1821664390,"desktop":"niri","digest":"sha256:d2b4efc4d6766d7f777c5753c628917ded55165044ba4e2db4bd7aab4fae226e","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"zypper","repoFamily":"opensuse"},"publication":{"ref":"ghcr.io/tuna-os/sailfin:niri","repository":"ghcr.io/tuna-os/sailfin","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:52e0853ba6785664304cbc8fa5292dba9e0a1726ae460aa0f4c13fb87d3bec9f","engineRevision":null,"indexDigest":"sha256:07da408242b9534de4ba21cd6edd65278d808ae0243512ad2a6d1d7876508cd0","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:d2b4efc4d6766d7f777c5753c628917ded55165044ba4e2db4bd7aab4fae226e"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri","hardwareScope":"generic","platform":"linux/amd64","variant":"sailfin"},"targetKey":"sailfin:niri:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1966056647,"desktop":"tuna","digest":"sha256:4908741d834c4e4296560c0edb8ba39dbfa917e00827e1b6eee3987cb88cfb80","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"zypper","repoFamily":"opensuse"},"publication":{"ref":"ghcr.io/tuna-os/sailfin:tuna","repository":"ghcr.io/tuna-os/sailfin","tag":"tuna"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:554168d124b635c5fbfc25c7a519d530a916280bcf9dabe3f94d6494287f1378","engineRevision":null,"indexDigest":"sha256:2ddec0a75354e5d6ee31c66f90104b169a1a02c850b370024f4f6914d152e095","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:4908741d834c4e4296560c0edb8ba39dbfa917e00827e1b6eee3987cb88cfb80"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"tuna","hardwareScope":"generic","platform":"linux/amd64","variant":"sailfin"},"targetKey":"sailfin:tuna:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1899328212,"desktop":"xfce","digest":"sha256:4f280d961cae2a9df5c92b495bcca2b18da7dc9016b103a3db8f945ff154cc99","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"zypper","repoFamily":"opensuse"},"publication":{"ref":"ghcr.io/tuna-os/sailfin:xfce","repository":"ghcr.io/tuna-os/sailfin","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:a376091dba97c793129b5573f10f30cca4580e2f746e6a2d30cd7581ca77d88d","engineRevision":null,"indexDigest":"sha256:23671e2887767525fe796fdc2d28fec2caef19da4037d7d1bc2c9b5c1751b25d","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:4f280d961cae2a9df5c92b495bcca2b18da7dc9016b103a3db8f945ff154cc99"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"sailfin"},"targetKey":"sailfin:xfce:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1530907747,"desktop":"","digest":"sha256:2eb8c79f7314bf0c0b03e990435f691c6de876f9c7b2672094ff81c0cd7ba8db","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:base-hwe","repository":"ghcr.io/tuna-os/skipjack","tag":"base-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:ddab2e19965a651b7a116329d96d12849bbea15a18ce20a302634a428b83de81","engineRevision":null,"indexDigest":"sha256:c9f5f11cc2cb5d510b5fa5d7e4f4741405297fb8bb4f8c257bf4e5b0745519db","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:2eb8c79f7314bf0c0b03e990435f691c6de876f9c7b2672094ff81c0cd7ba8db"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"base-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:base-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1430676882,"desktop":"","digest":"sha256:f3027e246cebc61ab237c2128f7f1233b9491d97ba00a6fdbc92464c4b7f3687","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:base-hwe","repository":"ghcr.io/tuna-os/skipjack","tag":"base-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:9a145c036b88dcc6bebc898c50e7780cb14a7427274ff53d00d24030a57c7615","engineRevision":null,"indexDigest":"sha256:c9f5f11cc2cb5d510b5fa5d7e4f4741405297fb8bb4f8c257bf4e5b0745519db","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:f3027e246cebc61ab237c2128f7f1233b9491d97ba00a6fdbc92464c4b7f3687"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"skipjack"},"targetKey":"skipjack:base-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2167918565,"desktop":"","digest":"sha256:23b4ee1df16ddf36b42634936f0f54b851fc7a3eeb8321284e7b029f24a7ef51","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:base-nvidia","repository":"ghcr.io/tuna-os/skipjack","tag":"base-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:a2639f17f263a0dddbcabfa5229f928eb364edb6659103fefacf8be666b58c06","engineRevision":null,"indexDigest":"sha256:64649f04f08793d209e88dc0e6363a9cb802b15592aed8a63c62136ea2292b3f","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:23b4ee1df16ddf36b42634936f0f54b851fc7a3eeb8321284e7b029f24a7ef51"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"base-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:base-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1499519945,"desktop":"","digest":"sha256:7e7c8bc2e69b03788a43dd72cf5fdec976adddd2e766fdb3c4b570d0c0cf2db0","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:base","repository":"ghcr.io/tuna-os/skipjack","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:3c163638d7df19f99a51aa8eae8795773ce92fd324fb05760ff80185c6cf8497","engineRevision":null,"indexDigest":"sha256:3dc862b78bec73c023df619695e0e361cca64f7fb18d8bca87221a4211cef3e3","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:7e7c8bc2e69b03788a43dd72cf5fdec976adddd2e766fdb3c4b570d0c0cf2db0"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1396916357,"desktop":"","digest":"sha256:0df29ac29c86fd82692e28475bda7e08a33a9c5e5ab1f4b4803dc4ccf588f9c0","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:base","repository":"ghcr.io/tuna-os/skipjack","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:6f5b3895ec3f6264e2a3d8dca3f8f301ddd0e9eec7436137774f8671d017f6fb","engineRevision":null,"indexDigest":"sha256:3dc862b78bec73c023df619695e0e361cca64f7fb18d8bca87221a4211cef3e3","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:0df29ac29c86fd82692e28475bda7e08a33a9c5e5ab1f4b4803dc4ccf588f9c0"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base","hardwareScope":"generic","platform":"linux/arm64","variant":"skipjack"},"targetKey":"skipjack:base:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1906157209,"desktop":"cosmic","digest":"sha256:4447f77de3d77c9f01d86d001466601918c00b75277f85976bdad89fcb0cb6fa","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:cosmic-hwe","repository":"ghcr.io/tuna-os/skipjack","tag":"cosmic-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:2946034ca9123b42ccc677709f6446d54d4a006a133088c94778b274f99d2c0a","engineRevision":null,"indexDigest":"sha256:0a73a94af66d209b38bf757a1bfd9b64592adff53bc2e28f7070bb12302ccd24","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:4447f77de3d77c9f01d86d001466601918c00b75277f85976bdad89fcb0cb6fa"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"cosmic-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:cosmic-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2544030142,"desktop":"cosmic","digest":"sha256:5aa5126582877a642c701e39de10819d046cf965e7aad929c174dd74f0074ad7","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:cosmic-nvidia","repository":"ghcr.io/tuna-os/skipjack","tag":"cosmic-nvidia"},"qualification":{"browser":null,"browserBuildReceiptDigest":null,"buildOrigin":"browser","inheritedFrom":"skipjack:cosmic:linux/amd64","isoDigest":"sha256:c5a158dc2034256531b893cc13cc90fdd7148bb37db0a80d2e15e968cb488e8c","producer":{"ref":"refs/heads/main","repository":"tuna-os/iso-builder","runAttempt":1,"runId":43183962314,"sha":"ae253e6c4d77a80f61b71588b192be14645fe7ae","workflow":".github/workflows/ci.yml"},"qualifiedAt":"2026-11-12T10:16:05Z","reason":null,"receiptDigest":"sha256:094c21a5087a031cd1f9f96839d239a6aa4115964fa75c3cb4a0efdc58cacd99","receiptImageDigest":"sha256:410a93564c8eab089d00b3c109017c4ef2baa225ab1adc6c7da971a128497067","receiptPlatform":"linux/amd64","receiptSchema":"BrowserIsoQualificationReceipt/v1","resources":null,"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:cb180fec2079ff35dd2f60630c0b992fbd7ea745ac156b6dd8562b93751d58d8","engineRevision":"sha256:0d7d21ccf19fb0b6f8578f34bcc085578ee698ea2db6f075e255ea992599d26a","indexDigest":"sha256:6d4e28461acd78122dad7d3f8f9d6d987abd2dc7b44457b321d048aa34cfffa3","installerRevision":"sha256:735ea3881ba71bf42d24fdd495f6e31cc6e9c595e024e1f9565fa11fb9e4c22c","liveOverlayBaseDigest":"sha256:5aa5126582877a642c701e39de10819d046cf965e7aad929c174dd74f0074ad7","liveOverlayDigest":"sha256:14d395162de341a3d340bd079d3f5bef69a23ffaa710a0578277cac97093ae64","platformManifestDigest":"sha256:5aa5126582877a642c701e39de10819d046cf965e7aad929c174dd74f0074ad7"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"cosmic-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:cosmic-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1907871776,"desktop":"cosmic","digest":"sha256:7c9a1c3ec7d65b910e5a8e2b0fec9112cdae478b18c6fd9acb7352eca94d5665","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:cosmic","repository":"ghcr.io/tuna-os/skipjack","tag":"cosmic"},"qualification":{"browser":null,"browserBuildReceiptDigest":null,"buildOrigin":"browser","isoDigest":"sha256:c5a158dc2034256531b893cc13cc90fdd7148bb37db0a80d2e15e968cb488e8c","producer":{"ref":"refs/heads/main","repository":"tuna-os/iso-builder","runAttempt":1,"runId":43183962314,"sha":"ae253e6c4d77a80f61b71588b192be14645fe7ae","workflow":".github/workflows/ci.yml"},"qualifiedAt":"2026-11-12T10:16:05Z","reason":null,"receiptDigest":"sha256:094c21a5087a031cd1f9f96839d239a6aa4115964fa75c3cb4a0efdc58cacd99","receiptImageDigest":"sha256:410a93564c8eab089d00b3c109017c4ef2baa225ab1adc6c7da971a128497067","receiptPlatform":"linux/amd64","receiptSchema":"BrowserIsoQualificationReceipt/v1","resources":null,"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:772eb4f3a062bee018d7f6c3d96195deeac494aecf58672eee7f45906c014814","engineRevision":"sha256:0d7d21ccf19fb0b6f8578f34bcc085578ee698ea2db6f075e255ea992599d26a","indexDigest":"sha256:4f9592f673f3fb86133e37658b7eccca6688900bc6eef7cbf55a3b346d1b545d","installerRevision":"sha256:735ea3881ba71bf42d24fdd495f6e31cc6e9c595e024e1f9565fa11fb9e4c22c","liveOverlayBaseDigest":"sha256:410a93564c8eab089d00b3c109017c4ef2baa225ab1adc6c7da971a128497067","liveOverlayDigest":"sha256:0badbeb2aa3f2ec83d0369b51504dbf3e5a550d43abc1434725d40a0a8639da3","platformManifestDigest":"sha256:410a93564c8eab089d00b3c109017c4ef2baa225ab1adc6c7da971a128497067"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"cosmic","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:cosmic:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2369292960,"desktop":"gnome","digest":"sha256:0b6b3e023ea9b92b99b79024db89a890e8f75e91245a0d2708037b0f6dfaa148","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:gnome-hwe","repository":"ghcr.io/tuna-os/skipjack","tag":"gnome-hwe"},"qualification":{"browser":null,"browserBuildReceiptDigest":null,"buildOrigin":"browser","isoDigest":"sha256:12d82aeea8f16ef2ea4bba0c733b7726193c42507c09faf0014dee2ed528bac9","producer":{"ref":"refs/heads/main","repository":"tuna-os/iso-builder","runAttempt":1,"runId":43156104464,"sha":"d29b5e92b1b5340de08079bf223e3cd18a93ba11","workflow":".github/workflows/ci.yml"},"qualifiedAt":"2026-11-12T06:26:19Z","reason":null,"receiptDigest":"sha256:d47c04b794c9b4ea35aa56ddd10a8f2d8988a894f5948404428afe96d5e78a91","receiptImageDigest":"sha256:0b6b3e023ea9b92b99b79024db89a890e8f75e91245a0d2708037b0f6dfaa148","receiptPlatform":"linux/amd64","receiptSchema":"BrowserIsoQualificationReceipt/v1","resources":null,"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:0ecfaedb02ae31049c6c891f65600de52de4a6f4e69eceeb3f4c83bae7be67be","engineRevision":"sha256:0d7d21ccf19fb0b6f8578f34bcc085578ee698ea2db6f075e255ea992599d26a","indexDigest":"sha256:5c9579b9dd4d1524b2cc741c3bfc83a6c43815fe2fccb7b9c6ee11cc3c5d2ac6","installerRevision":"sha256:ff28c254d0f0c3fc303cdcd2d7cae1632a55e6f92f1f887c4c6f00559d82417b","liveOverlayBaseDigest":"sha256:0b6b3e023ea9b92b99b79024db89a890e8f75e91245a0d2708037b0f6dfaa148","liveOverlayDigest":"sha256:90e6df75917bd45e40ebcda96fcdb4dd1915fd9e1b4ea0c4dbabdc2b5a1ad1bb","platformManifestDigest":"sha256:0b6b3e023ea9b92b99b79024db89a890e8f75e91245a0d2708037b0f6dfaa148"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"gnome-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:gnome-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":2369284574,"desktop":"gnome","digest":"sha256:1ea657ecd95361dc86df37b2de9feabdca64304e2ac6393e0ef5ea47c143c43a","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:gnome-hwe","repository":"ghcr.io/tuna-os/skipjack","tag":"gnome-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:d3f2950a677f1dcdc23c93c5e7432688f2bd251b6e0fdae4046a654eca9a7b4c","engineRevision":null,"indexDigest":"sha256:5c9579b9dd4d1524b2cc741c3bfc83a6c43815fe2fccb7b9c6ee11cc3c5d2ac6","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:1ea657ecd95361dc86df37b2de9feabdca64304e2ac6393e0ef5ea47c143c43a"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"gnome-hwe","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"skipjack"},"targetKey":"skipjack:gnome-hwe:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2527740224,"desktop":"gnome","digest":"sha256:0945da2194dbb66bdbce8d945b247a74f703b3d6eaf1751e4c44c86b13ad4d57","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:gnome-nvidia","repository":"ghcr.io/tuna-os/skipjack","tag":"gnome-nvidia"},"qualification":{"browser":null,"browserBuildReceiptDigest":null,"buildOrigin":"browser","inheritedFrom":"skipjack:gnome:linux/amd64","isoDigest":"sha256:bb68387f392860560a0320552c5046bf3fac0d335441991c8bbf09cb45ecf0ee","producer":{"ref":"refs/heads/main","repository":"tuna-os/iso-builder","runAttempt":1,"runId":42936641805,"sha":"bc990cb4a2598e9386945fdf8174f10675cc29a1","workflow":".github/workflows/ci.yml"},"qualifiedAt":"2026-11-11T03:07:30Z","reason":null,"receiptDigest":"sha256:5017c5b42e6a3749919c5fdc384992876e9ed274fbdf13240454df7f9a2dab72","receiptImageDigest":"sha256:5edcb582bc2a86d932aab2b8ca3c6d27ecb88608573cda3883fcbfc15922177c","receiptPlatform":"linux/amd64","receiptSchema":"BrowserIsoQualificationReceipt/v1","resources":null,"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:e62b8493eeaf5b8d710459cad2c86cd608685d1d6cc744a95f3e03d78a030f50","engineRevision":"sha256:5f2b637d06bf2d954e71bff4f362586e880ffa183c7e841789334ccf09786d17","indexDigest":"sha256:da21cb96cb5333b5687f36e763e426f5c703907308efe79241d15fe994674bee","installerRevision":"sha256:ff28c254d0f0c3fc303cdcd2d7cae1632a55e6f92f1f887c4c6f00559d82417b","liveOverlayBaseDigest":"sha256:0945da2194dbb66bdbce8d945b247a74f703b3d6eaf1751e4c44c86b13ad4d57","liveOverlayDigest":"sha256:47c5e34551c6b00256a101e99633393066518b617db2cbeaba952153df45d17c","platformManifestDigest":"sha256:0945da2194dbb66bdbce8d945b247a74f703b3d6eaf1751e4c44c86b13ad4d57"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"gnome-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:gnome-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2370501109,"desktop":"gnome","digest":"sha256:4d0475e256ca220c0a76b32dd020155c61a53d33529901fb399549ca3998bbca","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:gnome","repository":"ghcr.io/tuna-os/skipjack","tag":"gnome"},"qualification":{"browser":null,"browserBuildReceiptDigest":null,"buildOrigin":"browser","isoDigest":"sha256:bb68387f392860560a0320552c5046bf3fac0d335441991c8bbf09cb45ecf0ee","producer":{"ref":"refs/heads/main","repository":"tuna-os/iso-builder","runAttempt":1,"runId":42936641805,"sha":"bc990cb4a2598e9386945fdf8174f10675cc29a1","workflow":".github/workflows/ci.yml"},"qualifiedAt":"2026-11-11T03:07:30Z","reason":null,"receiptDigest":"sha256:5017c5b42e6a3749919c5fdc384992876e9ed274fbdf13240454df7f9a2dab72","receiptImageDigest":"sha256:5edcb582bc2a86d932aab2b8ca3c6d27ecb88608573cda3883fcbfc15922177c","receiptPlatform":"linux/amd64","receiptSchema":"BrowserIsoQualificationReceipt/v1","resources":null,"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:0ba29e87e0401d4c181a8d843f78f973ed8f210778f9ea6f9bab417a80f06f4b","engineRevision":"sha256:5f2b637d06bf2d954e71bff4f362586e880ffa183c7e841789334ccf09786d17","indexDigest":null,"installerRevision":"sha256:ff28c254d0f0c3fc303cdcd2d7cae1632a55e6f92f1f887c4c6f00559d82417b","liveOverlayBaseDigest":"sha256:5edcb582bc2a86d932aab2b8ca3c6d27ecb88608573cda3883fcbfc15922177c","liveOverlayDigest":"sha256:7c8908dbb6aa9adc291b6b7732bf338ad64ba40141d12db26b1f1a9deb581b8c","platformManifestDigest":"sha256:5edcb582bc2a86d932aab2b8ca3c6d27ecb88608573cda3883fcbfc15922177c"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":2370499165,"desktop":"gnome","digest":"sha256:fe44704b2f29b0763145a6e46c0f37855f4d923699334c661071870384845da8","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:gnome","repository":"ghcr.io/tuna-os/skipjack","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:4d056c4a4248d1a9b7123fe3808ceb202a08e73a35bb3a1ade0c7655d6a02fc7","engineRevision":null,"indexDigest":"sha256:3cbdf0d7f418a70554f0e8174d0d6c656737b0d3bb83bad181795814ae2d6874","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:fe44704b2f29b0763145a6e46c0f37855f4d923699334c661071870384845da8"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"skipjack"},"targetKey":"skipjack:gnome:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3028815976,"desktop":"kde","digest":"sha256:e8011b8cfb72cb65f60100509db37225359f444134273acf8a09bbddc54e7087","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:kde-hwe","repository":"ghcr.io/tuna-os/skipjack","tag":"kde-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:acbb79b7fa1e1088668a7e8ff68dc3153d188e76eaee744b9d638632e9ae730c","engineRevision":null,"indexDigest":"sha256:39209037a10723f3ac73653cba806e153c159cd214376c83ad7d80c654395caf","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:e8011b8cfb72cb65f60100509db37225359f444134273acf8a09bbddc54e7087"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"kde-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:kde-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2898024002,"desktop":"kde","digest":"sha256:8d51fb4da37434f0fecce38ee94c536f0a0a350e4c451ae01aaf319386c183a8","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:kde-hwe","repository":"ghcr.io/tuna-os/skipjack","tag":"kde-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:8f79d21fd54683b7110fb789aa8093b71430a87aff788a051e1be02cadc8ef6c","engineRevision":null,"indexDigest":"sha256:39209037a10723f3ac73653cba806e153c159cd214376c83ad7d80c654395caf","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:8d51fb4da37434f0fecce38ee94c536f0a0a350e4c451ae01aaf319386c183a8"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"kde-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"skipjack"},"targetKey":"skipjack:kde-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2621959858,"desktop":"kde","digest":"sha256:75ad16ed666cd6186667ddf895479919fff586ae96b36c8df0a9636ac642cdf0","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:kde-nvidia","repository":"ghcr.io/tuna-os/skipjack","tag":"kde-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:fdd960f3003117b1674a773341cec118a7e5fae7e79bb9db4df994bdb681e611","engineRevision":null,"indexDigest":"sha256:ad88a2b6ad4f0ac29dabfb731860f12d1a46420fa18bd9f8ae3ae3a3d8d4e650","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:75ad16ed666cd6186667ddf895479919fff586ae96b36c8df0a9636ac642cdf0"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"kde-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:kde-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3030562693,"desktop":"kde","digest":"sha256:3bffbedce5593ad4eec49eabcda0c04c29d49ecc8410e2b7b9c28f0b1c0e4699","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:kde","repository":"ghcr.io/tuna-os/skipjack","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:cae23c70031e792cea7ebfa71178b251b0310b37c4c8e91973a9bfc987e7b014","engineRevision":null,"indexDigest":"sha256:639ea8382d80731d68aa5c4b3d8b31dbef926fe2ed4195edfcdb8e9f20f15aa9","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:3bffbedce5593ad4eec49eabcda0c04c29d49ecc8410e2b7b9c28f0b1c0e4699"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2899749352,"desktop":"kde","digest":"sha256:c219ef0949ab3b8b744e7e04b07e8dabbdd74c38c9a381828a87e5f54a5cae25","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:kde","repository":"ghcr.io/tuna-os/skipjack","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:33b91d6ac97deef7eff8684e48d4341dcf62323574878ffd9f782c61313825ff","engineRevision":null,"indexDigest":"sha256:639ea8382d80731d68aa5c4b3d8b31dbef926fe2ed4195edfcdb8e9f20f15aa9","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:c219ef0949ab3b8b744e7e04b07e8dabbdd74c38c9a381828a87e5f54a5cae25"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"kde","hardwareScope":"generic","platform":"linux/arm64","variant":"skipjack"},"targetKey":"skipjack:kde:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1772690786,"desktop":"niri","digest":"sha256:98c6e1240e61ef7e41b1941f9cb8d04135b55b3868f2895cc396bb991d9e5019","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:niri-hwe","repository":"ghcr.io/tuna-os/skipjack","tag":"niri-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:66f3eeb5c293381186926b505b240209984dd7a4ec3c6f5881aad45e3aff8dff","engineRevision":null,"indexDigest":"sha256:97878c0a0aa663777a1323bf335c6d40b6640e32a9d65d1310c45508e58fe62d","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:98c6e1240e61ef7e41b1941f9cb8d04135b55b3868f2895cc396bb991d9e5019"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"niri-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:niri-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1659030059,"desktop":"niri","digest":"sha256:74c8d60a16ea44e3df2857363cdfb8bb516597ecddd18e6297c1ab1e8b819923","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:niri-hwe","repository":"ghcr.io/tuna-os/skipjack","tag":"niri-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:c97d82348111a9bdb0e05eb6319eff3fc3200c7b8ffe34d5b639679d68c5df24","engineRevision":null,"indexDigest":"sha256:97878c0a0aa663777a1323bf335c6d40b6640e32a9d65d1310c45508e58fe62d","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:74c8d60a16ea44e3df2857363cdfb8bb516597ecddd18e6297c1ab1e8b819923"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"niri-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"skipjack"},"targetKey":"skipjack:niri-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2409877820,"desktop":"niri","digest":"sha256:0538b5c7323abcffa4edda22146d432357dd002b521f6d93d05f3bb7b313d02f","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:niri-nvidia","repository":"ghcr.io/tuna-os/skipjack","tag":"niri-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:19db74f6933d0fec051c90f04d1ee3ee521b77a1f4fe9be71414f6a1a2147f5d","engineRevision":null,"indexDigest":"sha256:a2931c8c306bd87af98a2132e09c1777d3e124bf8584710e8193d82ab809715a","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:0538b5c7323abcffa4edda22146d432357dd002b521f6d93d05f3bb7b313d02f"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"niri-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:niri-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1774256274,"desktop":"niri","digest":"sha256:de3ccb175873ef7e7b121ddd7a8e86899ef054303f496fa392f9cd4e9e2ec51f","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:niri","repository":"ghcr.io/tuna-os/skipjack","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:580fb81353af2ecf1bdb89d9945b7897b263ed3785b26510a283af853abcd982","engineRevision":null,"indexDigest":"sha256:3417a024872e5dbe9ceb54ccb3df50d1c5954d52420e461c5fc26fc8032e15f3","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:de3ccb175873ef7e7b121ddd7a8e86899ef054303f496fa392f9cd4e9e2ec51f"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"niri","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:niri:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1659465421,"desktop":"niri","digest":"sha256:1b3f6506456de93877d0cbcfd897e96d70809bad5fac90244c59999816041672","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:niri","repository":"ghcr.io/tuna-os/skipjack","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:e3184700f46f60f271e5760009dfd2c126b03272345d10025ae4722abc9ce48b","engineRevision":null,"indexDigest":"sha256:3417a024872e5dbe9ceb54ccb3df50d1c5954d52420e461c5fc26fc8032e15f3","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:1b3f6506456de93877d0cbcfd897e96d70809bad5fac90244c59999816041672"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"niri","hardwareScope":"generic","platform":"linux/arm64","variant":"skipjack"},"targetKey":"skipjack:niri:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1707652798,"desktop":"tuna","digest":"sha256:909e492432358720eec6a645d608c94c9fde24e451f9a7eac10d2f2eb7aac36b","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:tuna","repository":"ghcr.io/tuna-os/skipjack","tag":"tuna"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:493b4a5957d5472ab1d5e94b51727e4fbc243873f84febca27317835bfa24e1f","engineRevision":null,"indexDigest":"sha256:1411af451b85ae1a7740702b07075ff8ffac5020a550f526cfba24b24bfbcb72","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:909e492432358720eec6a645d608c94c9fde24e451f9a7eac10d2f2eb7aac36b"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"tuna","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:tuna:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1570766093,"desktop":"xfce","digest":"sha256:88da37f9faa69fcd463ab90484e0bd165ff94960c2de07ecdf12287ea49e27f2","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:xfce","repository":"ghcr.io/tuna-os/skipjack","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:7a27f872ab31de5d60ec1a5c88c1f58fac031a54082d4c9739123d893699efed","engineRevision":null,"indexDigest":"sha256:a88c897f4770765dccba6d6d9a3f93f88e0a94aa15195a18eaca51059ed1136a","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:88da37f9faa69fcd463ab90484e0bd165ff94960c2de07ecdf12287ea49e27f2"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:xfce:linux/amd64"},{"availability":{"available":false,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/stingray:base","repository":"ghcr.io/tuna-os/stingray","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":null,"indexDigest":null,"installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"stingray"},"targetKey":"stingray:base:linux/amd64"},{"availability":{"available":false,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/stingray:base","repository":"ghcr.io/tuna-os/stingray","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":null,"indexDigest":null,"installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base","hardwareScope":"generic","platform":"linux/arm64","variant":"stingray"},"targetKey":"stingray:base:linux/arm64"},{"availability":{"available":false,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"gnome","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/stingray:gnome","repository":"ghcr.io/tuna-os/stingray","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":null,"indexDigest":null,"installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"stingray"},"targetKey":"stingray:gnome:linux/amd64"},{"availability":{"available":false,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"gnome","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/stingray:gnome","repository":"ghcr.io/tuna-os/stingray","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":null,"indexDigest":null,"installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome","hardwareScope":"generic","platform":"linux/arm64","variant":"stingray"},"targetKey":"stingray:gnome:linux/arm64"},{"availability":{"available":false,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"kde","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/stingray:kde","repository":"ghcr.io/tuna-os/stingray","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":null,"indexDigest":null,"installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"stingray"},"targetKey":"stingray:kde:linux/amd64"},{"availability":{"available":false,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"kde","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/stingray:kde","repository":"ghcr.io/tuna-os/stingray","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":null,"indexDigest":null,"installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"kde","hardwareScope":"generic","platform":"linux/arm64","variant":"stingray"},"targetKey":"stingray:kde:linux/arm64"},{"availability":{"available":false,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"xfce","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/stingray:xfce","repository":"ghcr.io/tuna-os/stingray","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":null,"indexDigest":null,"installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"stingray"},"targetKey":"stingray:xfce:linux/amd64"},{"availability":{"available":false,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"xfce","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/stingray:xfce","repository":"ghcr.io/tuna-os/stingray","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":null,"indexDigest":null,"installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"xfce","hardwareScope":"generic","platform":"linux/arm64","variant":"stingray"},"targetKey":"stingray:xfce:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1672457116,"desktop":"","digest":"sha256:a17071371a3d986708606d08a3d74e41d0573bcdf949c4429c7d083eab678cb2","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/wahoo:base","repository":"ghcr.io/tuna-os/wahoo","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:345eefbda94dfd6ae8ff4b497b767384e7d6bd9e95f3cc1b7850ca2f0f7238e5","engineRevision":null,"indexDigest":"sha256:0e7b2afd52f4cf85b2358b283c6ef28ca26994d4e9697d65b16c699e3b87a1b5","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:a17071371a3d986708606d08a3d74e41d0573bcdf949c4429c7d083eab678cb2"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"wahoo"},"targetKey":"wahoo:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1491655859,"desktop":"","digest":"sha256:6fdd66eda5069fce567208fb568ee55eb247851cf6c63e3d481cc123d27e0bc9","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/wahoo:base","repository":"ghcr.io/tuna-os/wahoo","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:1e584b74147e2ecb1427d7a9bafe1e4d0b6923ff3e9ee252484c4ea8e570a05d","engineRevision":null,"indexDigest":"sha256:0e7b2afd52f4cf85b2358b283c6ef28ca26994d4e9697d65b16c699e3b87a1b5","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:6fdd66eda5069fce567208fb568ee55eb247851cf6c63e3d481cc123d27e0bc9"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base","hardwareScope":"generic","platform":"linux/arm64","variant":"wahoo"},"targetKey":"wahoo:base:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2102155786,"desktop":"cosmic","digest":"sha256:819931bfff17db7e3d0c60c20706b98b8732c96f0f95d3fd26a19b9174a9ec47","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/wahoo:cosmic","repository":"ghcr.io/tuna-os/wahoo","tag":"cosmic"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:ae9ff3049459d0ce95ad474933aa37c66e349764a63894d3cb216bf427d5585c","engineRevision":null,"indexDigest":"sha256:cc20ba1d9f00c5d35a1e2162badb3269efce45bc495a0e0b4fbb569ed354f1e0","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:819931bfff17db7e3d0c60c20706b98b8732c96f0f95d3fd26a19b9174a9ec47"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"cosmic","hardwareScope":"generic","platform":"linux/amd64","variant":"wahoo"},"targetKey":"wahoo:cosmic:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1906913472,"desktop":"cosmic","digest":"sha256:b21c469bdbff9e662b6e9ded92ba561f0322d629827af8cca4c4feb88fda0386","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/wahoo:cosmic","repository":"ghcr.io/tuna-os/wahoo","tag":"cosmic"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:a2fcf50a8de8fab01d4259cb3b198d4e9e03d06f72292ccbc5544dfc09cca998","engineRevision":null,"indexDigest":"sha256:cc20ba1d9f00c5d35a1e2162badb3269efce45bc495a0e0b4fbb569ed354f1e0","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:b21c469bdbff9e662b6e9ded92ba561f0322d629827af8cca4c4feb88fda0386"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"cosmic","hardwareScope":"generic","platform":"linux/arm64","variant":"wahoo"},"targetKey":"wahoo:cosmic:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2045915937,"desktop":"gnome","digest":"sha256:c3f999e5044ab4a9302435500b1d1dbe0c4e9911b7703ca320057a2e37dd6d7b","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/wahoo:gnome","repository":"ghcr.io/tuna-os/wahoo","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:f6b08d05265889f933c5479cbebe915940150edd4caa8a613c549d68bf0f885d","engineRevision":null,"indexDigest":"sha256:e4d20fcba364559ad173368c7d6f40574ead0fbea740dd9c09bb1409efe86344","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:c3f999e5044ab4a9302435500b1d1dbe0c4e9911b7703ca320057a2e37dd6d7b"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"wahoo"},"targetKey":"wahoo:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1858709118,"desktop":"gnome","digest":"sha256:7c70f5d17221eec275fdc027704a056543cf6911f6b1c07383c4258f67172d1c","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/wahoo:gnome","repository":"ghcr.io/tuna-os/wahoo","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:f6a55ed21c69da66ab82cfb2642dedb6d1e80f85471e4fb21d64350604140cd1","engineRevision":null,"indexDigest":"sha256:e4d20fcba364559ad173368c7d6f40574ead0fbea740dd9c09bb1409efe86344","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:7c70f5d17221eec275fdc027704a056543cf6911f6b1c07383c4258f67172d1c"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome","hardwareScope":"generic","platform":"linux/arm64","variant":"wahoo"},"targetKey":"wahoo:gnome:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2994797655,"desktop":"kde","digest":"sha256:04cc186adb99a0a495045d0548e709ff2503a2168517988fc824d05a8f3831bc","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/wahoo:kde","repository":"ghcr.io/tuna-os/wahoo","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:be72194956f90eba686272341daf4d77b65fee093d54ad0cfb79a7920a39ea61","engineRevision":null,"indexDigest":"sha256:565a6efef2b39c735b9eefdd7d06baab152e3b706ed09704473faf50ce48e801","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:04cc186adb99a0a495045d0548e709ff2503a2168517988fc824d05a8f3831bc"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"wahoo"},"targetKey":"wahoo:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2771868592,"desktop":"kde","digest":"sha256:a57c8c68d114e493d45ea776e261931f2089a7c7f2057f46b0a6948dce6a0ccd","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/wahoo:kde","repository":"ghcr.io/tuna-os/wahoo","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:f9e8e5c81391bc52f7c2f6e3dd76898ce1eb6dc17b0dff7667e3974c1b84e273","engineRevision":null,"indexDigest":"sha256:565a6efef2b39c735b9eefdd7d06baab152e3b706ed09704473faf50ce48e801","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:a57c8c68d114e493d45ea776e261931f2089a7c7f2057f46b0a6948dce6a0ccd"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"kde","hardwareScope":"generic","platform":"linux/arm64","variant":"wahoo"},"targetKey":"wahoo:kde:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1865745274,"desktop":"tuna","digest":"sha256:3d05e36068199cdf8f2e8bba00f79fc220b51aa2eec0ab448d036f026fa90ad8","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/wahoo:tuna","repository":"ghcr.io/tuna-os/wahoo","tag":"tuna"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:8155db6b63bdc7fc7be697c2ff8f158f6300eacf70001d361de6b12b00c73791","engineRevision":null,"indexDigest":"sha256:865ec5320f25ae368316f07b4d3b49b5e0600308e5bc50b973ace90a5b53a46d","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:3d05e36068199cdf8f2e8bba00f79fc220b51aa2eec0ab448d036f026fa90ad8"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"tuna","hardwareScope":"generic","platform":"linux/amd64","variant":"wahoo"},"targetKey":"wahoo:tuna:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1510164765,"desktop":"","digest":"sha256:d599be60a6906132505e6ee56633d7be6c11d42a64f58800c65a34cd5fa75e1c","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:base-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"base-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:73908dd8fd08ce97d7868be69f7b9a854e5b16cd758adb2f0617de35ffc6ac24","engineRevision":null,"indexDigest":"sha256:90a6f44f1a9c37c950de5f06af335ee21f1a9a417c657c547ebfa987e542e1f8","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:d599be60a6906132505e6ee56633d7be6c11d42a64f58800c65a34cd5fa75e1c"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:base-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1506179403,"desktop":"","digest":"sha256:854c7224341d6a8b3a8b62c17a294ee050c7bb6329f992a73b7872e24c8d8008","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:base-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"base-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:6ea0e2d1e48c339ad5b442c72db9c8ccc3c963f7e08975a1f8a0db40159d0a62","engineRevision":null,"indexDigest":"sha256:90a6f44f1a9c37c950de5f06af335ee21f1a9a417c657c547ebfa987e542e1f8","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:854c7224341d6a8b3a8b62c17a294ee050c7bb6329f992a73b7872e24c8d8008"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"base-hwe","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"yellowfin"},"targetKey":"yellowfin:base-hwe:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1413897628,"desktop":"","digest":"sha256:b2f3cab60d0e1fb9a039b6225583d1bb72d2750fd65907eb52abe4b0afb58adc","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:base-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"base-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:172fbcdcf94294d289c3691c470a86953836b14d73340961afd827cc49691761","engineRevision":null,"indexDigest":"sha256:90a6f44f1a9c37c950de5f06af335ee21f1a9a417c657c547ebfa987e542e1f8","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:b2f3cab60d0e1fb9a039b6225583d1bb72d2750fd65907eb52abe4b0afb58adc"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"yellowfin"},"targetKey":"yellowfin:base-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2145058738,"desktop":"","digest":"sha256:4334ee5d3938a904ea35bc8af7cbb99f042141cf31bbf4e15765e784743edfb5","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:base-nvidia","repository":"ghcr.io/tuna-os/yellowfin","tag":"base-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:bc10e6f6f631343d4a508355e9eb1cdcd17582a9f44d446f752a1eafe7cb9e1d","engineRevision":null,"indexDigest":"sha256:eee61a971b4768c3b062b0788c930ba51e78312d120868290189c4671642c68e","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:4334ee5d3938a904ea35bc8af7cbb99f042141cf31bbf4e15765e784743edfb5"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:base-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1475808148,"desktop":"","digest":"sha256:23423bddb52e7cd7aece66dca9cec7de3f79d4b85a09d92a4105d745681f800c","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:base","repository":"ghcr.io/tuna-os/yellowfin","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:bb66e401e6150c8c58b8d9d8dbd4b6126d8a22964d92c44277ca991517b91f28","engineRevision":null,"indexDigest":"sha256:5c28cbde8c919decfad97364f0c933db08b06e346bfeb0217953fa05e5fa125a","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:23423bddb52e7cd7aece66dca9cec7de3f79d4b85a09d92a4105d745681f800c"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"base","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:base:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1474757076,"desktop":"","digest":"sha256:c2720b0725302d5650368b8c477773f6220b2fc4a85a1681c1394ed29bdffb3c","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:base","repository":"ghcr.io/tuna-os/yellowfin","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:b01b249427b7b07dba74b3191fc222ea851dfe893361782b04f6964d32bbfefe","engineRevision":null,"indexDigest":"sha256:5c28cbde8c919decfad97364f0c933db08b06e346bfeb0217953fa05e5fa125a","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:c2720b0725302d5650368b8c477773f6220b2fc4a85a1681c1394ed29bdffb3c"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"base","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"yellowfin"},"targetKey":"yellowfin:base:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1376658273,"desktop":"","digest":"sha256:87575c5543917c8ec1f28dd16eab13ad96916ab1549aac7c7e0e05964f114803","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:base","repository":"ghcr.io/tuna-os/yellowfin","tag":"base"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":"sha256:d543a0a749ded83c7434c835771f184acb03e5cc4b513ff3840b8ba8bdb7724c","engineRevision":null,"indexDigest":"sha256:5c28cbde8c919decfad97364f0c933db08b06e346bfeb0217953fa05e5fa125a","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:87575c5543917c8ec1f28dd16eab13ad96916ab1549aac7c7e0e05964f114803"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"base","hardwareScope":"generic","platform":"linux/arm64","variant":"yellowfin"},"targetKey":"yellowfin:base:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1885365111,"desktop":"cosmic","digest":"sha256:06628133f3f1f8cab38e16bac3cd651a521e844edfcafeaa83a9306f6e7ccb01","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:cosmic-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"cosmic-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:33051fc8fe8252aec275a18136300ce46cef8219ed9868b291b69887d2de877c","engineRevision":null,"indexDigest":"sha256:5859a259d50b2571ec175427e855d13fe2fc06125dc85913c57273bdf475e41c","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:06628133f3f1f8cab38e16bac3cd651a521e844edfcafeaa83a9306f6e7ccb01"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:cosmic-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2521016141,"desktop":"cosmic","digest":"sha256:5bbe6420c260eec31bef84ba4171e3874f6c57982906791d2b18663567e988ee","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:cosmic-nvidia","repository":"ghcr.io/tuna-os/yellowfin","tag":"cosmic-nvidia"},"qualification":{"browser":null,"browserBuildReceiptDigest":null,"buildOrigin":"browser","inheritedFrom":"yellowfin:cosmic:linux/amd64","isoDigest":"sha256:43495acf00ac32d4e2c074b0322108c74c08604a612798197345dde2f7f79b11","producer":{"ref":"refs/heads/main","repository":"tuna-os/iso-builder","runAttempt":1,"runId":43429623777,"sha":"d9caeb74007553b3fce16ae846e0863eab7da36f","workflow":".github/workflows/ci.yml"},"qualifiedAt":"2026-11-13T14:31:27Z","reason":null,"receiptDigest":"sha256:cdfe079183527408416e772a2d4f0fd0f5cf8cf7244bd277f74e93d00d9d58a6","receiptImageDigest":"sha256:3bb7ec5fc63b27f9468967a8fe6df90f72c705a88f9707754186ada5377a5e1a","receiptPlatform":"linux/amd64","receiptSchema":"BrowserIsoQualificationReceipt/v1","resources":null,"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:9ffb699bb52f436248c4a1c2500261703dd9a78d4253390ec4a77edc7f171f48","engineRevision":"sha256:399389ecea74de0b9fe8495766a6e33a3592675e2106600f90ea44ae023a1bdd","indexDigest":"sha256:0e249ec1ce421c7dfa53d5c03df82d72b440c64933bc309625a13bb2179ad0ec","installerRevision":"sha256:735ea3881ba71bf42d24fdd495f6e31cc6e9c595e024e1f9565fa11fb9e4c22c","liveOverlayBaseDigest":"sha256:5bbe6420c260eec31bef84ba4171e3874f6c57982906791d2b18663567e988ee","liveOverlayDigest":"sha256:8e54df302af5c3967b38943eaa0c91f1437c86194c08a30ec930434c81a253e4","platformManifestDigest":"sha256:5bbe6420c260eec31bef84ba4171e3874f6c57982906791d2b18663567e988ee"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:cosmic-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1885768662,"desktop":"cosmic","digest":"sha256:1111e34f3aea458406d12878723f7cd8225e1dbbbc5c2818bea2acf495310a06","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:cosmic","repository":"ghcr.io/tuna-os/yellowfin","tag":"cosmic"},"qualification":{"browser":null,"browserBuildReceiptDigest":null,"buildOrigin":"browser","isoDigest":"sha256:43495acf00ac32d4e2c074b0322108c74c08604a612798197345dde2f7f79b11","producer":{"ref":"refs/heads/main","repository":"tuna-os/iso-builder","runAttempt":1,"runId":43429623777,"sha":"d9caeb74007553b3fce16ae846e0863eab7da36f","workflow":".github/workflows/ci.yml"},"qualifiedAt":"2026-11-13T14:31:27Z","reason":null,"receiptDigest":"sha256:cdfe079183527408416e772a2d4f0fd0f5cf8cf7244bd277f74e93d00d9d58a6","receiptImageDigest":"sha256:3bb7ec5fc63b27f9468967a8fe6df90f72c705a88f9707754186ada5377a5e1a","receiptPlatform":"linux/amd64","receiptSchema":"BrowserIsoQualificationReceipt/v1","resources":null,"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:6642fe37b5f7058165cb3738e7da0245ed51f0a1e4c46a788988a758d7957bc5","engineRevision":"sha256:399389ecea74de0b9fe8495766a6e33a3592675e2106600f90ea44ae023a1bdd","indexDigest":"sha256:894b9d7f05c49ab7cb588239fe6e64a174c9c94d6331667f06d4186835a17260","installerRevision":"sha256:735ea3881ba71bf42d24fdd495f6e31cc6e9c595e024e1f9565fa11fb9e4c22c","liveOverlayBaseDigest":"sha256:3bb7ec5fc63b27f9468967a8fe6df90f72c705a88f9707754186ada5377a5e1a","liveOverlayDigest":"sha256:4083156e51717d96ab8f101b5acb55c6209d278fba64c830b619e078cc0db1af","platformManifestDigest":"sha256:3bb7ec5fc63b27f9468967a8fe6df90f72c705a88f9707754186ada5377a5e1a"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:cosmic:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2347162320,"desktop":"gnome","digest":"sha256:e604d63099bacd621e26ea04fcb8973d1a25fa2d2c0692bf1cac14ffd886fdec","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:gnome-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"gnome-hwe"},"qualification":{"browser":null,"browserBuildReceiptDigest":null,"buildOrigin":"browser","isoDigest":"sha256:b89810de251bd5e795e348a33929209a1ae14ec6d0587ba16cf8b1f8d4f9bc47","producer":{"ref":"refs/heads/main","repository":"tuna-os/iso-builder","runAttempt":1,"runId":43435708021,"sha":"d9caeb74007553b3fce16ae846e0863eab7da36f","workflow":".github/workflows/ci.yml"},"qualifiedAt":"2026-11-13T15:41:35Z","reason":null,"receiptDigest":"sha256:813854e8ba9646f8ba52fa4f2bbdec5a1dcb44619950f036511424952c5f20c0","receiptImageDigest":"sha256:e604d63099bacd621e26ea04fcb8973d1a25fa2d2c0692bf1cac14ffd886fdec","receiptPlatform":"linux/amd64","receiptSchema":"BrowserIsoQualificationReceipt/v1","resources":null,"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:4f5c8e12f8a9cbab0f599b739266a73b8e9ee0de44707c8cc190128156c08fba","engineRevision":"sha256:399389ecea74de0b9fe8495766a6e33a3592675e2106600f90ea44ae023a1bdd","indexDigest":"sha256:fb5515e8352c50d057ccf957fe9b548f415a507c44ede0f93001eb8932f0d6f9","installerRevision":"sha256:ff28c254d0f0c3fc303cdcd2d7cae1632a55e6f92f1f887c4c6f00559d82417b","liveOverlayBaseDigest":"sha256:e604d63099bacd621e26ea04fcb8973d1a25fa2d2c0692bf1cac14ffd886fdec","liveOverlayDigest":"sha256:b648c9756f292c5bfde83600a9a5a420dbf900762e76928235e902130fc9ac21","platformManifestDigest":"sha256:e604d63099bacd621e26ea04fcb8973d1a25fa2d2c0692bf1cac14ffd886fdec"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:gnome-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":2344255541,"desktop":"gnome","digest":"sha256:605224a402c6dad3465899656cbfd1b35af181abb2fe74c8f6c4f30435457ac1","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:gnome-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"gnome-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:b52f2b3c10613b875fbe7524ff2b77c288cd12e5ba6450aa2d0ee27eb9acc88d","engineRevision":null,"indexDigest":"sha256:fb5515e8352c50d057ccf957fe9b548f415a507c44ede0f93001eb8932f0d6f9","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:605224a402c6dad3465899656cbfd1b35af181abb2fe74c8f6c4f30435457ac1"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"gnome-hwe","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"yellowfin"},"targetKey":"yellowfin:gnome-hwe:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2982658472,"desktop":"gnome","digest":"sha256:696a6eeb9a0122160bb5fad4babae1147ca0ae63e81808ae46258cb8aaf8f9b1","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:gnome-nvidia","repository":"ghcr.io/tuna-os/yellowfin","tag":"gnome-nvidia"},"qualification":{"browser":null,"browserBuildReceiptDigest":null,"buildOrigin":"browser","inheritedFrom":"yellowfin:gnome:linux/amd64","isoDigest":"sha256:ed605fb99c95707e2b52f87f3e981029d555d8337016d71d6d0291c9fb82a6f7","producer":{"ref":"refs/heads/main","repository":"tuna-os/iso-builder","runAttempt":1,"runId":42433495020,"sha":"47d73427cbc09559c2112b649701207a40e4cb71","workflow":".github/workflows/ci.yml"},"qualifiedAt":"2026-11-08T03:11:11Z","reason":null,"receiptDigest":"sha256:27ca38794686c4a40fee4ebf80ac5d42bc4ecbf73e9999915f96fef0a07049ed","receiptImageDigest":"sha256:04aa1acf6115143eaa0674d04edb6f3cc5c4222e4fe01831b238324748b5a786","receiptPlatform":"linux/amd64","receiptSchema":"BrowserIsoQualificationReceipt/v1","resources":null,"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:a28c49bdd0338859c40ec646deead19965c564a487cb694934fdd7ffbe440ff5","engineRevision":"sha256:2b47b4b078edd5172b4d920a4863d269fd45a5905c1bfb859e91ab9c071c23f5","indexDigest":"sha256:7eb34d43eb838c1a299f1f50b8dca97fa71885770a66f3bfb2dea74436950ea6","installerRevision":"sha256:ff28c254d0f0c3fc303cdcd2d7cae1632a55e6f92f1f887c4c6f00559d82417b","liveOverlayBaseDigest":"sha256:696a6eeb9a0122160bb5fad4babae1147ca0ae63e81808ae46258cb8aaf8f9b1","liveOverlayDigest":"sha256:4d80cdf5c053f378a0cfa9d20548096b159a099b8989caaba30a2521685f1660","platformManifestDigest":"sha256:696a6eeb9a0122160bb5fad4babae1147ca0ae63e81808ae46258cb8aaf8f9b1"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:gnome-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2347542026,"desktop":"gnome","digest":"sha256:5ef3050fe3f24814df3daf24afc2668555ae38bb3b8c1aabfaec13641daf659c","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:gnome","repository":"ghcr.io/tuna-os/yellowfin","tag":"gnome"},"qualification":{"browser":null,"browserBuildReceiptDigest":null,"buildOrigin":"browser","isoDigest":"sha256:ed605fb99c95707e2b52f87f3e981029d555d8337016d71d6d0291c9fb82a6f7","producer":{"ref":"refs/heads/main","repository":"tuna-os/iso-builder","runAttempt":1,"runId":42433495020,"sha":"47d73427cbc09559c2112b649701207a40e4cb71","workflow":".github/workflows/ci.yml"},"qualifiedAt":"2026-11-08T03:11:11Z","reason":null,"receiptDigest":"sha256:27ca38794686c4a40fee4ebf80ac5d42bc4ecbf73e9999915f96fef0a07049ed","receiptImageDigest":"sha256:04aa1acf6115143eaa0674d04edb6f3cc5c4222e4fe01831b238324748b5a786","receiptPlatform":"linux/amd64","receiptSchema":"BrowserIsoQualificationReceipt/v1","resources":null,"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:1f0e8b00eb48b0960a5e983ad7b556ec1c223934c9c08ee6cac4cc3649df610c","engineRevision":"sha256:2b47b4b078edd5172b4d920a4863d269fd45a5905c1bfb859e91ab9c071c23f5","indexDigest":null,"installerRevision":"sha256:ff28c254d0f0c3fc303cdcd2d7cae1632a55e6f92f1f887c4c6f00559d82417b","liveOverlayBaseDigest":"sha256:04aa1acf6115143eaa0674d04edb6f3cc5c4222e4fe01831b238324748b5a786","liveOverlayDigest":"sha256:99585c88442b91202f314e4e151f49b93c1419d252720401436b5269c3918a17","platformManifestDigest":"sha256:04aa1acf6115143eaa0674d04edb6f3cc5c4222e4fe01831b238324748b5a786"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":2344788108,"desktop":"gnome","digest":"sha256:08bc4d30a958c749be782bdaafc7e97254126e7acfea809f8220e10ffd66b94b","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:gnome","repository":"ghcr.io/tuna-os/yellowfin","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:13afe054aa43729538839f5998d0bc29eddb67cd6fe8468463d34a1fb9d0205e","engineRevision":null,"indexDigest":"sha256:359162900f51f23e3801a80e1da28d6c706c83fa314a3238520cdb260eedeb3c","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:08bc4d30a958c749be782bdaafc7e97254126e7acfea809f8220e10ffd66b94b"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"yellowfin"},"targetKey":"yellowfin:gnome:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3006752501,"desktop":"kde","digest":"sha256:9d23845656fe3c3d53840eecbdbf851092686d6d89067ca6e01c2dcbcd8d3a49","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:kde-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"kde-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:24dd93fda5f571e4bb30e576a43ae5438245d24627f67b92e865339a8fd3befd","engineRevision":null,"indexDigest":"sha256:33b280759d58305076f64a7893f3abedbd1b848642261897fbf4cc1e8f5bbe42","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:9d23845656fe3c3d53840eecbdbf851092686d6d89067ca6e01c2dcbcd8d3a49"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:kde-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":3000279756,"desktop":"kde","digest":"sha256:05a8a2b72f880dbf4ea54be484f4f97c9b601a353ed5efe316fb532eea6187b5","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:kde-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"kde-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:acd24650b0781958d061a97543a2f77c64cc711dad4822b555a59d29b96992e7","engineRevision":null,"indexDigest":"sha256:33b280759d58305076f64a7893f3abedbd1b848642261897fbf4cc1e8f5bbe42","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:05a8a2b72f880dbf4ea54be484f4f97c9b601a353ed5efe316fb532eea6187b5"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"kde-hwe","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"yellowfin"},"targetKey":"yellowfin:kde-hwe:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2880166619,"desktop":"kde","digest":"sha256:4b460d4acf27bda9e4a04312fd9a708dac3151915a646f56d135d898fadaf24b","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:kde-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"kde-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:96325d8d872bef5bf3512f71bdd1a2855deb95cf03261c62b2b4bffeda6d9c93","engineRevision":null,"indexDigest":"sha256:33b280759d58305076f64a7893f3abedbd1b848642261897fbf4cc1e8f5bbe42","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:4b460d4acf27bda9e4a04312fd9a708dac3151915a646f56d135d898fadaf24b"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"kde-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"yellowfin"},"targetKey":"yellowfin:kde-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3641166941,"desktop":"kde","digest":"sha256:cc827a7d60f89986597aeddc22b917081b5c7cab9467c39d0d6a8ec3b9d7fea1","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:kde-nvidia","repository":"ghcr.io/tuna-os/yellowfin","tag":"kde-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:68c01ab438d602f94498dfb17c3b40aeb144a28a565f45bc1d0b12d94cbf13ab","engineRevision":null,"indexDigest":"sha256:f375d402ae1d39edfe52f9aeebf6bea4999f3ef8b77cb30e80dd0d145721017d","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:cc827a7d60f89986597aeddc22b917081b5c7cab9467c39d0d6a8ec3b9d7fea1"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:kde-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3007470379,"desktop":"kde","digest":"sha256:498a2703ef9298a584b3c4fb109d905267d26d9d6e8bcdefbcf17d4a9f0b1755","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:kde","repository":"ghcr.io/tuna-os/yellowfin","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:e1352fe5213ddd6eefe09754efddda6268d721262c6a2091e4f9287b9350701a","engineRevision":null,"indexDigest":"sha256:5f3d234a76dd0626c68af1ed9a49ba7d2cc8bd8d615634f99bb85aad295cfcc6","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:498a2703ef9298a584b3c4fb109d905267d26d9d6e8bcdefbcf17d4a9f0b1755"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":3000711976,"desktop":"kde","digest":"sha256:1fc071fa9b9c9875faff9ab9e6bb98d7260fe7b7a39d41004ec5d59cd7426359","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:kde","repository":"ghcr.io/tuna-os/yellowfin","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:6e36ff2a145a29bcecf1fec7803a27b06160c933a5799902c8c6b0498a1cb846","engineRevision":null,"indexDigest":"sha256:5f3d234a76dd0626c68af1ed9a49ba7d2cc8bd8d615634f99bb85aad295cfcc6","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:1fc071fa9b9c9875faff9ab9e6bb98d7260fe7b7a39d41004ec5d59cd7426359"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"yellowfin"},"targetKey":"yellowfin:kde:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2881140812,"desktop":"kde","digest":"sha256:4a606e2611e042582ccbeb5bbb9f6fd3f3e6e554de1049a0d71dddd09c8b1970","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:kde","repository":"ghcr.io/tuna-os/yellowfin","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:8270b84e46af892957beddf6feff8e18aa3d106daeebcc325aab0f70149366d8","engineRevision":null,"indexDigest":"sha256:5f3d234a76dd0626c68af1ed9a49ba7d2cc8bd8d615634f99bb85aad295cfcc6","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:4a606e2611e042582ccbeb5bbb9f6fd3f3e6e554de1049a0d71dddd09c8b1970"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"kde","hardwareScope":"generic","platform":"linux/arm64","variant":"yellowfin"},"targetKey":"yellowfin:kde:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1751476648,"desktop":"niri","digest":"sha256:8b351239b9019118dccfdcfe0d20ba8b9756e966c6e7da90b980f797161a0ec7","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:niri-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"niri-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:a8e9fb834c6cc88762f587838cdb3410cf5ce07687db1a019a506cf9eec3b387","engineRevision":null,"indexDigest":"sha256:c4cd8f2a3898788f65dac9c5f0ccdf3010e11ee18856d8b481dd4ad836c45059","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:8b351239b9019118dccfdcfe0d20ba8b9756e966c6e7da90b980f797161a0ec7"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:niri-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1760470174,"desktop":"niri","digest":"sha256:c669c537235e87f8db73947327668865dc42aae795b0b3ccd75771a3ecf6268a","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:niri-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"niri-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:25a701b771f5cb1bcac40e08715628da4b3b3ed3ebf2ce600c2104aa0ca1ebf0","engineRevision":null,"indexDigest":"sha256:c4cd8f2a3898788f65dac9c5f0ccdf3010e11ee18856d8b481dd4ad836c45059","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:c669c537235e87f8db73947327668865dc42aae795b0b3ccd75771a3ecf6268a"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"niri-hwe","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"yellowfin"},"targetKey":"yellowfin:niri-hwe:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1642450097,"desktop":"niri","digest":"sha256:e7501ff9334f9722a8ff5024a1a6e57048db3011dd6487f10a4d379de4a9c016","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:niri-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"niri-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:32f701454b05e49b24290acf81d9587606e8d853c6c142d83f37e6675ed8a308","engineRevision":null,"indexDigest":"sha256:c4cd8f2a3898788f65dac9c5f0ccdf3010e11ee18856d8b481dd4ad836c45059","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:e7501ff9334f9722a8ff5024a1a6e57048db3011dd6487f10a4d379de4a9c016"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"niri-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"yellowfin"},"targetKey":"yellowfin:niri-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2385979362,"desktop":"niri","digest":"sha256:8a5159ff7d712d843c328ef98c144e051263a44cc9b8118914b229adf6b2e165","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:niri-nvidia","repository":"ghcr.io/tuna-os/yellowfin","tag":"niri-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:8a7fc3a4d132a7ed01250aa44983cf29f4352a340f1dcc716cdd65c70576b67c","engineRevision":null,"indexDigest":"sha256:bc8af844b76026ac577dba3a915534e1ede03fb494822c5ed8dc146d19f5eab8","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:8a5159ff7d712d843c328ef98c144e051263a44cc9b8118914b229adf6b2e165"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:niri-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1751965194,"desktop":"niri","digest":"sha256:1e58b158fbc73d54d5e94af99fb3506101b2115b78c72a870eb11a91dc0c55a2","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:niri","repository":"ghcr.io/tuna-os/yellowfin","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:499e64a0ab08f522ab607aa06096478f20eea3e7b8084dfba47be92d4b7280cb","engineRevision":null,"indexDigest":"sha256:4958c9d7e82c9b8f2a4072dfbe277e73bb17e3cde1c4cfb4d7d6df440828085e","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:1e58b158fbc73d54d5e94af99fb3506101b2115b78c72a870eb11a91dc0c55a2"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:niri:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1761001832,"desktop":"niri","digest":"sha256:e0fe9adf32ad42177ad71eff809ed8f28d1a60d07f750a0f88cc2cdd3ec698e3","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:niri","repository":"ghcr.io/tuna-os/yellowfin","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:7ae7af494da25653d817853adfa5c067a831bf9394c9e1be6aafb50616e59d2e","engineRevision":null,"indexDigest":"sha256:4958c9d7e82c9b8f2a4072dfbe277e73bb17e3cde1c4cfb4d7d6df440828085e","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:e0fe9adf32ad42177ad71eff809ed8f28d1a60d07f750a0f88cc2cdd3ec698e3"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"niri","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"yellowfin"},"targetKey":"yellowfin:niri:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1642824395,"desktop":"niri","digest":"sha256:bbe23a94edc249e481a56db9cd9adfa2ef3655937da9dd2a2b2416065fb85f57","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:niri","repository":"ghcr.io/tuna-os/yellowfin","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:86b9d8672bbe2538a3fd64ad889aaa334cd6f4836c895dde5864fba79f5cad0f","engineRevision":null,"indexDigest":"sha256:4958c9d7e82c9b8f2a4072dfbe277e73bb17e3cde1c4cfb4d7d6df440828085e","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:bbe23a94edc249e481a56db9cd9adfa2ef3655937da9dd2a2b2416065fb85f57"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"niri","hardwareScope":"generic","platform":"linux/arm64","variant":"yellowfin"},"targetKey":"yellowfin:niri:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1688201279,"desktop":"tuna","digest":"sha256:770300ae48ce132c3dc6bf9ff52ac0b93bc9fdccf1aef1f2cb4e844c1b2027da","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:tuna","repository":"ghcr.io/tuna-os/yellowfin","tag":"tuna"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:39b0741fa2dab06e0f5bc81917c3b19dcbd6e967d5d83eb0a0efb00dd149515b","engineRevision":null,"indexDigest":"sha256:1c71db7555bf6f87272b3f0b6d70d3e4fb156d06033828f187a631641656b0f4","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:770300ae48ce132c3dc6bf9ff52ac0b93bc9fdccf1aef1f2cb4e844c1b2027da"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"tuna","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:tuna:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1548415631,"desktop":"xfce","digest":"sha256:7242a3234e6ddd255b13201a521a46b808666027f3f24dfd50d0846b438ece8f","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:xfce-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"xfce-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:fa65177d26694f80154e9bba8a4846bdce134d20f0e05d7789ea484b82dc0c74","engineRevision":null,"indexDigest":"sha256:8df15c5291083f5396fd850879c7864df3f3d07f97c3e1c269d29e5103d1f2d6","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:7242a3234e6ddd255b13201a521a46b808666027f3f24dfd50d0846b438ece8f"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:xfce-hwe:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1549410380,"desktop":"xfce","digest":"sha256:cfc21bdcf8074219c0bad2ae0561cf8903353a7ff8c7b9ba773bc873bb95a3a9","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:xfce-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"xfce-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:5ee1912fce8a8e5139687edc11d23cc5459a488a70aa42f637eb7fce78f05783","engineRevision":null,"indexDigest":"sha256:8df15c5291083f5396fd850879c7864df3f3d07f97c3e1c269d29e5103d1f2d6","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:cfc21bdcf8074219c0bad2ae0561cf8903353a7ff8c7b9ba773bc873bb95a3a9"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"xfce-hwe","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"yellowfin"},"targetKey":"yellowfin:xfce-hwe:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2183490822,"desktop":"xfce","digest":"sha256:7b5ced1064dcb62ec227fa37e3c4fee92b2adb5eea194291b3c5693dcf60755a","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:xfce-nvidia","repository":"ghcr.io/tuna-os/yellowfin","tag":"xfce-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:21a16f34df49f114f7b8d9abf7b1a0c3fc9b4dabd957cec56e2c7336ce40a796","engineRevision":null,"indexDigest":"sha256:d4b424436c19636cc3801689ae0a2b2ef1c03d54a1cfe8a5c7cbfe643e8e08aa","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:7b5ced1064dcb62ec227fa37e3c4fee92b2adb5eea194291b3c5693dcf60755a"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:xfce-nvidia:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1548755607,"desktop":"xfce","digest":"sha256:e8c26ac4e3e83ead62cc6afb35e52b68ff605fecc73956d7da3d9fac6d14831c","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:xfce","repository":"ghcr.io/tuna-os/yellowfin","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"no-qualification-receipt","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:b0fe07da4ee726f1f89b5db467aa58e93bf6c27d4928734a28bd08589643c1c0","engineRevision":null,"indexDigest":"sha256:b2d696b71521a85486e0e9d6d3511673ad0be56feb4b45ed6f68769ae915b940","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:e8c26ac4e3e83ead62cc6afb35e52b68ff605fecc73956d7da3d9fac6d14831c"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"yellowfin"},"targetKey":"yellowfin:xfce:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1549645150,"desktop":"xfce","digest":"sha256:f64ab1416943da228243b69b6fff5d6c07ffe790e61d1a0c40238b89c60cfcb0","hasSdBoot":false,"kernelVer":"","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:xfce","repository":"ghcr.io/tuna-os/yellowfin","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"platform-has-no-receipt-basis","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:ecbf8e19c6a429930e972a8c24137835610049678e8a2c69de86aa2c0dcbe5d7","engineRevision":null,"indexDigest":"sha256:b2d696b71521a85486e0e9d6d3511673ad0be56feb4b45ed6f68769ae915b940","installerRevision":null,"liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:f64ab1416943da228243b69b6fff5d6c07ffe790e61d1a0c40238b89c60cfcb0"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"yellowfin"},"targetKey":"yellowfin:xfce:linux/amd64/v2"}]};

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
    // An nvidia target inherits its sibling's receipt (tunaOS iso_delivery
    // `inherits`): the receipt proves the sibling's image, so the digest match
    // below does not apply; the target builds its own image on its own overlay
    // (`pinned` checks the overlay's base). inheritedFrom must be exactly the
    // same variant's non-nvidia sibling on linux/amd64.
    const parts = String(entry?.target?.flavor || "").split("-");
    const at = parts.indexOf("nvidia");
    const sibling = at < 0 ? "" : parts.filter((_, i) => i !== at).join("-");
    const inherits = "inheritedFrom" in q;
    const inheritsOk = inherits && platform === "linux/amd64" && sibling !== "" &&
      q.inheritedFrom === `${entry.target.variant}:${sibling}:linux/amd64`;
    complete = common && digest(q.receiptImageDigest) && q.receiptPlatform === "linux/amd64" &&
      (!inherits || inheritsOk) &&
      p.repository === "tuna-os/iso-builder" && p.workflow === ".github/workflows/ci.yml" &&
      p.ref === "refs/heads/main" && typeof p.sha === "string" && /^[0-9a-f]{40}$/.test(p.sha) &&
      run(p.runId) && run(p.runAttempt) &&
      (platform === "linux/amd64" ? pinned && (inherits || q.receiptImageDigest === ri.platformManifestDigest)
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

// presetSink: a sink the caller opened earlier (quick-start.js asks for the
// save location while the click still counts as a user gesture).
async function build(presetSink = null) {
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
    s = presetSink || await isoSink(name);
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
    globalThis.tboxQuickRefresh?.();
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
    // An explicit ref also keeps a catalog flavor that is not a configured
    // desktop (gnome-hwe, gnome-nvidia): v1 desktops list only base DEs, and
    // clearing the field mid-inspect reads as "the selected image has changed".
    const offered = VARIANTS.some(v => v.id === parsed.variant && v.des.includes(parsed.flavor));
    if (!entry || (!selectionWasExplicit && !(entry.scheduled || entry.availability?.available)) || (!selectionWasExplicit && !offered)) {
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
