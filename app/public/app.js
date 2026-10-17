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

const DEFAULT_CATALOG_SNAPSHOT = {"schemaVersion":1,"kind":"catalog-snapshot","producerRevision":"tunaos-build-config-v1","generatedAt":"2026-10-17T00:00:00Z","coverageDigest":"sha256:b18eb495d710513cda36b490f8ae65312896b045ce521b6ea35a2f1f2858d475","snapshotDigest":"sha256:b77f4c4f1e54d541c924c80519c102a416e8f750d0a783eff100d53d3fd1609d","targets":[{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":2044171796,"desktop":"cosmic","digest":"sha256:89ec1ed097cc2414b99e48761a38edaae9fbcd06c1f293f547881dfb833d0bea","hasSdBoot":false,"kernelVer":"6.12.0-266.el10.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:cosmic","repository":"ghcr.io/tuna-os/albacore","tag":"cosmic"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:cc1270f1aa89e6211ea9e7fb58cbf5cb338ff2c40a74055cada6824c1373834a","resources":{"compressedBytes":2044171796,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:00ac84fe43251762356706faf22e5ee3c6015bc2238cd60f1f2b7b30a95169e6","engineRevision":"tacklebox-1.0","indexDigest":"sha256:8d3222b6bb7075c0a73dfee0d06cc4fcda30611170e9a049bca44500b7bde257","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:89ec1ed097cc2414b99e48761a38edaae9fbcd06c1f293f547881dfb833d0bea"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"cosmic","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"albacore"},"targetKey":"albacore:cosmic:linux/amd64/v2"},{"availability":{"available":false,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"cosmic","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/albacore:cosmic","repository":"ghcr.io/tuna-os/albacore","tag":"cosmic"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"cosmic","hardwareScope":"generic","platform":"linux/arm64","variant":"albacore"},"targetKey":"albacore:cosmic:linux/arm64"},{"availability":{"available":false,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":false,"compressedSize":0,"desktop":"gnome","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/albacore:gnome-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"gnome-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"gnome-hwe","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"albacore"},"targetKey":"albacore:gnome-hwe:linux/amd64/v2"},{"availability":{"available":false,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"gnome","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/albacore:gnome-hwe","repository":"ghcr.io/tuna-os/albacore","tag":"gnome-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":false,"target":{"cpuBaseline":"armv8-a","flavor":"gnome-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"albacore"},"targetKey":"albacore:gnome-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1980579439,"desktop":"gnome","digest":"sha256:77f30260625cd4bc991b73bb07acf31faf3c7afdaa9ca5249783d9fdb8b7dcc5","hasSdBoot":false,"kernelVer":"6.12.0-266.el10.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:gnome","repository":"ghcr.io/tuna-os/albacore","tag":"gnome"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:35c6c0819b43bb564924efc60e801931e687921e38ca9008637ebca8bfebd3d1","resources":{"compressedBytes":1980579439,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:440cc69fb7bafa6562bf92bffa2c286c8de8a8f61d9c15009035eea039aa7012","engineRevision":"tacklebox-1.0","indexDigest":"sha256:9cbcd834be816cff9e2a05f46b31463e9cfe1efbee95d7c986c4105dcc132ead","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:77f30260625cd4bc991b73bb07acf31faf3c7afdaa9ca5249783d9fdb8b7dcc5"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"albacore"},"targetKey":"albacore:gnome:linux/amd64/v2"},{"availability":{"available":false,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"gnome","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/albacore:gnome","repository":"ghcr.io/tuna-os/albacore","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":false,"target":{"cpuBaseline":"armv8-a","flavor":"gnome","hardwareScope":"generic","platform":"linux/arm64","variant":"albacore"},"targetKey":"albacore:gnome:linux/arm64"},{"availability":{"available":false,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":false,"compressedSize":0,"desktop":"kde","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/albacore:kde-nvidia","repository":"ghcr.io/tuna-os/albacore","tag":"kde-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":false,"target":{"cpuBaseline":"x86-64-v2","flavor":"kde-nvidia","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"albacore"},"targetKey":"albacore:kde-nvidia:linux/amd64/v2"},{"availability":{"available":false,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"kde","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/albacore:kde-nvidia","repository":"ghcr.io/tuna-os/albacore","tag":"kde-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":false,"target":{"cpuBaseline":"armv8-a","flavor":"kde-nvidia","hardwareScope":"generic","platform":"linux/arm64","variant":"albacore"},"targetKey":"albacore:kde-nvidia:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":2104241604,"desktop":"kde","digest":"sha256:7cafb10f53867cfe571a026886c40c6ff492c1412dee13c9190c23a8a9f943c6","hasSdBoot":false,"kernelVer":"6.12.0-266.el10.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:kde","repository":"ghcr.io/tuna-os/albacore","tag":"kde"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:1e8993963d9c66c66b0d50d0772832b915474e730f4824dc5b58c5d077f8466e","resources":{"compressedBytes":2104241604,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:1414e7ef2c15c5ec91c0a793b0be75136e74e9e0e6d17a2cdc0586abdfeaaca1","engineRevision":"tacklebox-1.0","indexDigest":"sha256:af820a1c275a293f0a66512031698ec95f5cef44b85d1a9f01eb6e2621eb10c3","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:7cafb10f53867cfe571a026886c40c6ff492c1412dee13c9190c23a8a9f943c6"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"albacore"},"targetKey":"albacore:kde:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2005353888,"desktop":"kde","digest":"sha256:e616f6553b83c0a9e495eda5078ca508af283362dd3c007f8f14f0661c19597a","hasSdBoot":false,"kernelVer":"6.12.0-266.el10.aarch64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:kde","repository":"ghcr.io/tuna-os/albacore","tag":"kde"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:134e95faaf4186fbdfb9377bde7e1a95b63bae748b48cc73a53bdac2c9e440e9","resources":{"compressedBytes":2005353888,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:fcf4b59c00e8f552517e296c9a1596d98196fafea838d1d28611b4ddd4ad5224","engineRevision":"tacklebox-1.0","indexDigest":"sha256:af820a1c275a293f0a66512031698ec95f5cef44b85d1a9f01eb6e2621eb10c3","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:e616f6553b83c0a9e495eda5078ca508af283362dd3c007f8f14f0661c19597a"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"kde","hardwareScope":"generic","platform":"linux/arm64","variant":"albacore"},"targetKey":"albacore:kde:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1918813355,"desktop":"niri","digest":"sha256:6b531056ed52bc90d498735fcf1a55da015de0177120e847cb72ce88668aae48","hasSdBoot":false,"kernelVer":"6.12.0-266.el10.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:niri","repository":"ghcr.io/tuna-os/albacore","tag":"niri"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:30a88503d1c76191e2ce1d097b066d1076e1625e2cf7bb9e31cea80b1bf23565","resources":{"compressedBytes":1918813355,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:015ec48f2d04eb8c672317b5f33a4d102a189cf4753ba8adbd16ec515bb01123","engineRevision":"tacklebox-1.0","indexDigest":"sha256:adda71b9093d34961f09416b1a4d0e14be686779f7b6ce752c4fcda1020bacf2","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:6b531056ed52bc90d498735fcf1a55da015de0177120e847cb72ce88668aae48"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"niri","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"albacore"},"targetKey":"albacore:niri:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1803182057,"desktop":"niri","digest":"sha256:614cc1c600024242858d33b5768d9b455e49c7656419d9d20ffad4746eba5cb6","hasSdBoot":false,"kernelVer":"6.12.0-266.el10.aarch64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:niri","repository":"ghcr.io/tuna-os/albacore","tag":"niri"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:76532b45d3a210583612512cdbc2e8792fa8d390ff2436b731782b7c6b40de4e","resources":{"compressedBytes":1803182057,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:6880154ddfaeb117c4cfaffcf394596a94efb1cf27c0847d2d9f35fa2deb61ed","engineRevision":"tacklebox-1.0","indexDigest":"sha256:adda71b9093d34961f09416b1a4d0e14be686779f7b6ce752c4fcda1020bacf2","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:614cc1c600024242858d33b5768d9b455e49c7656419d9d20ffad4746eba5cb6"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"niri","hardwareScope":"generic","platform":"linux/arm64","variant":"albacore"},"targetKey":"albacore:niri:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1709796959,"desktop":"xfce","digest":"sha256:2f960ee6482318e827203c37b5d58c454cc46912cb1c56d60bed1e7fb63e8893","hasSdBoot":false,"kernelVer":"6.12.0-266.el10.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/albacore:xfce","repository":"ghcr.io/tuna-os/albacore","tag":"xfce"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:d4f66f32a2bca8a44fe99ad3ca8a78371bea840332e819d78d25a5370aff8baf","resources":{"compressedBytes":1709796959,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:33aca30c516cfef060523caa40b2090055c7e70583e89c22f6a71eab333978e2","engineRevision":"tacklebox-1.0","indexDigest":"sha256:ec6f93f1fbb943e0ff5cf50010260bb1f45054589d82b02e78b28847db4c4318","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:2f960ee6482318e827203c37b5d58c454cc46912cb1c56d60bed1e7fb63e8893"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"albacore"},"targetKey":"albacore:xfce:linux/amd64/v2"},{"availability":{"available":false,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"xfce","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/albacore:xfce","repository":"ghcr.io/tuna-os/albacore","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":false,"target":{"cpuBaseline":"armv8-a","flavor":"xfce","hardwareScope":"generic","platform":"linux/arm64","variant":"albacore"},"targetKey":"albacore:xfce:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2613417964,"desktop":"cosmic","digest":"sha256:7018a41b60a94a68ef1a70e072e9c010b5e641b0562501d94d3213622fe4d02d","hasSdBoot":true,"kernelVer":"6.15.0-300.fc44.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:cosmic","repository":"ghcr.io/tuna-os/bonito","tag":"cosmic"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:0af78cc00215b766503558bd79c409cac5dbb1c9bbff1e4b7177e568c705d164","resources":{"compressedBytes":2613417964,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:3e77276045089c691bfddd866817afa72a39489d313e19322cc513534cc5ff82","engineRevision":"tacklebox-1.0","indexDigest":"sha256:b9c7de43c642dea0a2e1d0e2948c6de46166df24e2532c850c170b8c568272eb","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:7018a41b60a94a68ef1a70e072e9c010b5e641b0562501d94d3213622fe4d02d"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:cosmic:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2478193114,"desktop":"cosmic","digest":"sha256:bb79061f430d0928fad3c4821fb82f4f5b566825a26bd6977c57aeeb71e78cc0","hasSdBoot":true,"kernelVer":"6.15.0-300.fc44.aarch64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:cosmic","repository":"ghcr.io/tuna-os/bonito","tag":"cosmic"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:3a8973774791dd31de3505e36fd85007bc952029cf7a63b9b4e8226459fb27cd","resources":{"compressedBytes":2478193114,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:9dee5d6746a0e854b0cc32ae1bc58df61e219314d465d6f2e8b72fe916ff700b","engineRevision":"tacklebox-1.0","indexDigest":"sha256:b9c7de43c642dea0a2e1d0e2948c6de46166df24e2532c850c170b8c568272eb","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:bb79061f430d0928fad3c4821fb82f4f5b566825a26bd6977c57aeeb71e78cc0"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"cosmic","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito"},"targetKey":"bonito:cosmic:linux/arm64"},{"availability":{"available":false,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"gnome","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome-asahi","repository":"ghcr.io/tuna-os/bonito","tag":"gnome-asahi"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome-asahi","hardwareScope":"apple-silicon","platform":"linux/arm64","variant":"bonito"},"targetKey":"bonito:gnome-asahi:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":4200000000,"desktop":"gnome","digest":"sha256:b6f5d12588da8756963f6a796e7b6f71e363baa96ca3aba20d8b60c8b4dc30df","hasSdBoot":true,"kernelVer":"6.15.0-300.fc44.x86_64","layerCount":68,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome-hwe","repository":"ghcr.io/tuna-os/bonito","tag":"gnome-hwe"},"qualification":{"browser":{"engine":"chromium","wasm32":false},"qualifiedAt":"2026-10-17T00:00:00Z","reason":"exceeds-wasm32-memory-ceiling","receiptDigest":"sha256:60da32b55c0a7811fe858225fd0c63ba6663e4830945631d6b0d3ced6696da97","resources":{"compressedBytes":4200000000,"layerCount":68,"minFreeStorageBytes":16000000000},"status":"local-only"},"required":true,"resolvedInputs":{"configDigest":"sha256:b763ef1225174a6d2281a229a81500a77181d14ca5498760f3e65cadc64bc431","engineRevision":"tacklebox-1.0","indexDigest":"sha256:5fd8015e9585aae98a5fbfe3aa86a1cbd22e132876ef0706f635e7d71e7c0fe0","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:b6f5d12588da8756963f6a796e7b6f71e363baa96ca3aba20d8b60c8b4dc30df"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:gnome-hwe:linux/amd64"},{"availability":{"available":false,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"gnome","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome-hwe","repository":"ghcr.io/tuna-os/bonito","tag":"gnome-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito"},"targetKey":"bonito:gnome-hwe:linux/arm64"},{"availability":{"available":false,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"gnome","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome-t2","repository":"ghcr.io/tuna-os/bonito","tag":"gnome-t2"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome-t2","hardwareScope":"apple-t2","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:gnome-t2:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2583934657,"desktop":"gnome","digest":"sha256:4c7e81e560bd0850146b7dfb767742cd07ea47064eaabacc78f7f5c56a97cdb5","hasSdBoot":true,"kernelVer":"6.15.0-300.fc44.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome","repository":"ghcr.io/tuna-os/bonito","tag":"gnome"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:d05141366a2a1394c1148c9e41f22efe3e4f9f86420112c5e56781a121d867dd","resources":{"compressedBytes":2583934657,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:1626594be26c6eb132b54f046adbd26d10becb2dfc9172aab0265440740ea617","engineRevision":"tacklebox-1.0","indexDigest":"sha256:f864f07f9865094f5daac1f4816f2e62645efe5241487384304f3401363c50c0","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:4c7e81e560bd0850146b7dfb767742cd07ea47064eaabacc78f7f5c56a97cdb5"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2454524662,"desktop":"gnome","digest":"sha256:ed8e5af1a2e1352d3612741c848f1aea856875ec01658745f03c3735432a1abd","hasSdBoot":true,"kernelVer":"6.15.0-300.fc44.aarch64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:gnome","repository":"ghcr.io/tuna-os/bonito","tag":"gnome"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:fb81bc2a5e15977474d05e6f8f002c6d899f88ca3fa79c8653daec9be140837c","resources":{"compressedBytes":2454524662,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:24b2c830b56310aa5181bed9edfb97e4625c8aa3b33069cf999c8d465d23c363","engineRevision":"tacklebox-1.0","indexDigest":"sha256:f864f07f9865094f5daac1f4816f2e62645efe5241487384304f3401363c50c0","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:ed8e5af1a2e1352d3612741c848f1aea856875ec01658745f03c3735432a1abd"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito"},"targetKey":"bonito:gnome:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":4200000000,"desktop":"kde","digest":"sha256:a1df03ce38f34becf94ee612df8d275710d4840d5d40060a8a75487e32e1545b","hasSdBoot":true,"kernelVer":"6.15.0-300.fc44.x86_64","layerCount":68,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:kde-nvidia","repository":"ghcr.io/tuna-os/bonito","tag":"kde-nvidia"},"qualification":{"browser":{"engine":"chromium","wasm32":false},"qualifiedAt":"2026-10-17T00:00:00Z","reason":"exceeds-wasm32-memory-ceiling","receiptDigest":"sha256:77e05d354e7534499282affce7a8dd80e45079d21d2b1c284423a529fa02e79c","resources":{"compressedBytes":4200000000,"layerCount":68,"minFreeStorageBytes":16000000000},"status":"local-only"},"required":true,"resolvedInputs":{"configDigest":"sha256:a6f70ab15ce956f8bd60b0d87c71ffa26af5a880f96f6db2a453e3382e84c2f1","engineRevision":"tacklebox-1.0","indexDigest":"sha256:15b1e9a26cf547b80bf2b3c85691a83e4ac4be14d41c2d12ba6a5aeb442e067a","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:a1df03ce38f34becf94ee612df8d275710d4840d5d40060a8a75487e32e1545b"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:kde-nvidia:linux/amd64"},{"availability":{"available":false,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"kde","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/bonito:kde-nvidia","repository":"ghcr.io/tuna-os/bonito","tag":"kde-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":false,"target":{"cpuBaseline":"armv8-a","flavor":"kde-nvidia","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito"},"targetKey":"bonito:kde-nvidia:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3301592834,"desktop":"kde","digest":"sha256:afc10d5157316c14b3548b6d7fdc7d1c2e8dd990fbd8c56ad69c8303c9456b31","hasSdBoot":true,"kernelVer":"6.15.0-300.fc44.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:kde","repository":"ghcr.io/tuna-os/bonito","tag":"kde"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:68f6a8cfc46f6d66a95d6a6905652fa130fe4b49c8aabfe99a545bdb38290d78","resources":{"compressedBytes":3301592834,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:e0813db05eff0bcbd736b2da99cdde35c82cdd7596f190b1cfb6c96a657251df","engineRevision":"tacklebox-1.0","indexDigest":"sha256:4a940b00940b32ca286a6ea3f952bd427edf810978ecdd5b00296bcecc19ac4c","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:afc10d5157316c14b3548b6d7fdc7d1c2e8dd990fbd8c56ad69c8303c9456b31"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3140883902,"desktop":"kde","digest":"sha256:0fd2f86baff59f3d2b0f1a440c8da63ae1beda5d4c6b034507b1a105703c0303","hasSdBoot":true,"kernelVer":"6.15.0-300.fc44.aarch64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:kde","repository":"ghcr.io/tuna-os/bonito","tag":"kde"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:32d43cc7c3bf8ef33d20a0fc3e0bcc3835fefb9526280b86ffe2e84e4de7dfc3","resources":{"compressedBytes":3140883902,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:253de3922ba7b3a15b1f61239debbcbde829b57bc25eeff1b1b14d7c2b3797ed","engineRevision":"tacklebox-1.0","indexDigest":"sha256:4a940b00940b32ca286a6ea3f952bd427edf810978ecdd5b00296bcecc19ac4c","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:0fd2f86baff59f3d2b0f1a440c8da63ae1beda5d4c6b034507b1a105703c0303"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"kde","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito"},"targetKey":"bonito:kde:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2179936062,"desktop":"niri","digest":"sha256:d624ae6f038ce7e8a0f50ee18bc94123a7e90373fe08b243e84c8b27d6d8861f","hasSdBoot":true,"kernelVer":"6.15.0-300.fc44.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:niri","repository":"ghcr.io/tuna-os/bonito","tag":"niri"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:24ebed35cdc01093f423b488706fecd2cad884e526946a1516d6f07fef288263","resources":{"compressedBytes":2179936062,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:ce16f00a33ac93ecfc4c90bb9afd21d744d8dda1bf000d5dab290e9ffdc459bf","engineRevision":"tacklebox-1.0","indexDigest":"sha256:9934029210b5d4e028b43e986818515b46f269f129e73c59d4c29b796c489951","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:d624ae6f038ce7e8a0f50ee18bc94123a7e90373fe08b243e84c8b27d6d8861f"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:niri:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2053182900,"desktop":"niri","digest":"sha256:9bce289c8499d3ce6f14c1af325e6b607cce5c3cdacc04a2832189d0e8256352","hasSdBoot":true,"kernelVer":"6.15.0-300.fc44.aarch64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:niri","repository":"ghcr.io/tuna-os/bonito","tag":"niri"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:ac5d8c9516b3de635fef7d982e1cfb9f823d2e618e3bfddd6c4a20206aedb602","resources":{"compressedBytes":2053182900,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:470b0560a801736d37e926bfd61626034674ec6ceb2bb942fa4c79da6fa23db6","engineRevision":"tacklebox-1.0","indexDigest":"sha256:9934029210b5d4e028b43e986818515b46f269f129e73c59d4c29b796c489951","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:9bce289c8499d3ce6f14c1af325e6b607cce5c3cdacc04a2832189d0e8256352"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"niri","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito"},"targetKey":"bonito:niri:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2713164193,"desktop":"xfce","digest":"sha256:fd8de7f74ade83db5d81babfd238d8a184cf74c8bb0dab1440e0a8d741dd858c","hasSdBoot":true,"kernelVer":"6.15.0-300.fc44.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:xfce","repository":"ghcr.io/tuna-os/bonito","tag":"xfce"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:635488a5f5320a9af2256f05a351f3c7e1e4fddbea0ebe5670494e77bda6613c","resources":{"compressedBytes":2713164193,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:57218d1a494f6100f63024438d57cc33940b2228145ec96ac54bbcd254ef5b59","engineRevision":"tacklebox-1.0","indexDigest":"sha256:1cb1aad4af93e3cd95bf4c43e3e51139967f201245cb09735431cdfad77575b4","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:fd8de7f74ade83db5d81babfd238d8a184cf74c8bb0dab1440e0a8d741dd858c"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"bonito"},"targetKey":"bonito:xfce:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2566808859,"desktop":"xfce","digest":"sha256:6e9daee3afcce8e48536ea4ec74dba0ceb90944c82910c4f814f909dfa38b937","hasSdBoot":true,"kernelVer":"6.15.0-300.fc44.aarch64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/bonito:xfce","repository":"ghcr.io/tuna-os/bonito","tag":"xfce"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:121ee0519831733c13b2cd79e70f98a59c5a25958e89744a3154f952a1e1cc40","resources":{"compressedBytes":2566808859,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:243a146b24a660148ca9f4f03eb35a17ab92e69abe5edcf3e66f89f616609e03","engineRevision":"tacklebox-1.0","indexDigest":"sha256:1cb1aad4af93e3cd95bf4c43e3e51139967f201245cb09735431cdfad77575b4","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:6e9daee3afcce8e48536ea4ec74dba0ceb90944c82910c4f814f909dfa38b937"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"xfce","hardwareScope":"generic","platform":"linux/arm64","variant":"bonito"},"targetKey":"bonito:xfce:linux/arm64"},{"availability":{"available":false,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"kde","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/flounder:kde-nvidia","repository":"ghcr.io/tuna-os/flounder","tag":"kde-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder"},"targetKey":"flounder:kde-nvidia:linux/amd64"},{"availability":{"available":false,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"kde","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/flounder:kde-nvidia","repository":"ghcr.io/tuna-os/flounder","tag":"kde-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":false,"target":{"cpuBaseline":"armv8-a","flavor":"kde-nvidia","hardwareScope":"generic","platform":"linux/arm64","variant":"flounder"},"targetKey":"flounder:kde-nvidia:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1340212962,"desktop":"kde","digest":"sha256:e3bffeeb849d243256b95782953b778d942bdd3f6dab2ae3ed05ef986e4f5257","hasSdBoot":true,"kernelVer":"6.12.100+deb13-amd64","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:kde","repository":"ghcr.io/tuna-os/flounder","tag":"kde"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:61bae171f7bbb2e59d2f334a1fc460c51bab1fea8b0f32b7f90fce38e671b4c4","resources":{"compressedBytes":1340212962,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:32c3cfb0ca5bdd1d9b791b58ea248dafc227a4aa7beb273f1c75bb4e831c188a","engineRevision":"tacklebox-1.0","indexDigest":"sha256:798a16fcd153745b7062a13ce8e0e05576b19eaad193da2c108ebd4730bb1c25","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:e3bffeeb849d243256b95782953b778d942bdd3f6dab2ae3ed05ef986e4f5257"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder"},"targetKey":"flounder:kde:linux/amd64"},{"availability":{"available":false,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"kde","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/flounder:kde","repository":"ghcr.io/tuna-os/flounder","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":false,"target":{"cpuBaseline":"armv8-a","flavor":"kde","hardwareScope":"generic","platform":"linux/arm64","variant":"flounder"},"targetKey":"flounder:kde:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1109276326,"desktop":"xfce","digest":"sha256:3356237baed1fc9ccd0b9e33809144925a55646b982c43e08ac62e95e5cbf9af","hasSdBoot":true,"kernelVer":"6.12.100+deb13-amd64","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/flounder:xfce","repository":"ghcr.io/tuna-os/flounder","tag":"xfce"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:f2b4fdbea9022277ec16f644190cc27e0b0583cfd626e0e71e03afaf3021433b","resources":{"compressedBytes":1109276326,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:eaef82e918b91ea64aff755b311cf2b6261c859010773ce69634c3adffea60ae","engineRevision":"tacklebox-1.0","indexDigest":"sha256:c5d457d574268fbb029e7a6bcbec49d8bb5090ef7d858331ad2348227717705a","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:3356237baed1fc9ccd0b9e33809144925a55646b982c43e08ac62e95e5cbf9af"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"flounder"},"targetKey":"flounder:xfce:linux/amd64"},{"availability":{"available":false,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"xfce","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/flounder:xfce","repository":"ghcr.io/tuna-os/flounder","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":false,"target":{"cpuBaseline":"armv8-a","flavor":"xfce","hardwareScope":"generic","platform":"linux/arm64","variant":"flounder"},"targetKey":"flounder:xfce:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2073994754,"desktop":"cosmic","digest":"sha256:e3727ff64f525f06c9f7b6a81ea9e5ed03729e3ba1a81b3401eb4eae357e778e","hasSdBoot":true,"kernelVer":"6.15.0-14-generic","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:cosmic","repository":"ghcr.io/tuna-os/grouper","tag":"cosmic"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:26daaea25dd6fa3229dc18c8794a9175658e72f54255d0adda2d3a3e25470312","resources":{"compressedBytes":2073994754,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:f7fe9049a191e381d192b37fe692f4b201b4a9b6644ac20ecdee4898259ed4d6","engineRevision":"tacklebox-1.0","indexDigest":"sha256:b10cb0384153207dcde475942c50c6e4a1e24a1103b107b78acc89f37c1f5d21","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:e3727ff64f525f06c9f7b6a81ea9e5ed03729e3ba1a81b3401eb4eae357e778e"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic","hardwareScope":"generic","platform":"linux/amd64","variant":"grouper"},"targetKey":"grouper:cosmic:linux/amd64"},{"availability":{"available":false,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"cosmic","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/grouper:cosmic","repository":"ghcr.io/tuna-os/grouper","tag":"cosmic"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":false,"target":{"cpuBaseline":"armv8-a","flavor":"cosmic","hardwareScope":"generic","platform":"linux/arm64","variant":"grouper"},"targetKey":"grouper:cosmic:linux/arm64"},{"availability":{"available":false,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"gnome","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/grouper:gnome-asahi","repository":"ghcr.io/tuna-os/grouper","tag":"gnome-asahi"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"hardware-scope-unsupported","receiptDigest":null,"resources":null,"status":"unsupported"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome-asahi","hardwareScope":"apple-silicon","platform":"linux/arm64","variant":"grouper"},"targetKey":"grouper:gnome-asahi:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2184235538,"desktop":"gnome","digest":"sha256:aa617e32cedd574ed9a51b7c65f0607ab6ca54f351761f164c1f30071e368314","hasSdBoot":true,"kernelVer":"6.15.0-14-generic","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:gnome","repository":"ghcr.io/tuna-os/grouper","tag":"gnome"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:a4df0e9bced89a08efe2e06fb38bf9cffbbe0419cbd3b2140df36b0cfc98ea4c","resources":{"compressedBytes":2184235538,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:b1d84e1a73d16a2b27da0ca0f13cada44ff7da4ebcda658c2af6760f0eee9a4b","engineRevision":"tacklebox-1.0","indexDigest":"sha256:cf79db53329b5f0415c8daa909ad5237d32f293fa3678c8ef51ebae0033c295e","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:aa617e32cedd574ed9a51b7c65f0607ab6ca54f351761f164c1f30071e368314"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"grouper"},"targetKey":"grouper:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2174211501,"desktop":"gnome","digest":"sha256:3d5e8bedb46705776861c96cdfc7687b884be5d46457a2d470f1ee0152d0f1f0","hasSdBoot":true,"kernelVer":"6.15.0-14-generic","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:gnome","repository":"ghcr.io/tuna-os/grouper","tag":"gnome"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:f07ae1dc20b71a99b9312a862fc228c671be0df49eab3d00bd5af49eba8624b7","resources":{"compressedBytes":2174211501,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:d17353925d19640e8df6cdcbac8a104cd0bc4d1818357aad02319c0539212335","engineRevision":"tacklebox-1.0","indexDigest":"sha256:cf79db53329b5f0415c8daa909ad5237d32f293fa3678c8ef51ebae0033c295e","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:3d5e8bedb46705776861c96cdfc7687b884be5d46457a2d470f1ee0152d0f1f0"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome","hardwareScope":"generic","platform":"linux/arm64","variant":"grouper"},"targetKey":"grouper:gnome:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1976881424,"desktop":"kde","digest":"sha256:b8b4c6f1066449e956914cc34a8fa1f4a47d8d2243da33f8046ea6e5b503a188","hasSdBoot":true,"kernelVer":"6.15.0-14-generic","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:kde","repository":"ghcr.io/tuna-os/grouper","tag":"kde"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:b067c9533a2871c777a320c58366b4b40ca3b45def506832491a04c14bf4c75f","resources":{"compressedBytes":1976881424,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:c71bb940acea915395a99804527202cfd0b30b0997a8b15cc66f6e1650aa3899","engineRevision":"tacklebox-1.0","indexDigest":"sha256:93bff3969fcda5dc347aa783c9ef0749aafd1021da6206acd28f9b35c340f6c9","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:b8b4c6f1066449e956914cc34a8fa1f4a47d8d2243da33f8046ea6e5b503a188"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"grouper"},"targetKey":"grouper:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1969808509,"desktop":"kde","digest":"sha256:f1a32893cbaded232c563c53ed0a887e1f25624e8a61521ce7cda6a9f4eea5f7","hasSdBoot":true,"kernelVer":"6.15.0-14-generic","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:kde","repository":"ghcr.io/tuna-os/grouper","tag":"kde"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:8737c4032efa240662088ad4da08e4548699c4ad727956a7121603144a2d9523","resources":{"compressedBytes":1969808509,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:a70cfe9b46c096a36da625f83f93ae4a423ff3b601321107c31195da86656efc","engineRevision":"tacklebox-1.0","indexDigest":"sha256:93bff3969fcda5dc347aa783c9ef0749aafd1021da6206acd28f9b35c340f6c9","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:f1a32893cbaded232c563c53ed0a887e1f25624e8a61521ce7cda6a9f4eea5f7"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"kde","hardwareScope":"generic","platform":"linux/arm64","variant":"grouper"},"targetKey":"grouper:kde:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1803467462,"desktop":"xfce","digest":"sha256:fed146a7caade1e6e2a0a0114424c8f16ebd86b11273328384f966e7f2def5f8","hasSdBoot":true,"kernelVer":"6.15.0-14-generic","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:xfce","repository":"ghcr.io/tuna-os/grouper","tag":"xfce"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:b8873554f0a181bc342f9da3c24a3c2f556603e1775fb75d680bfc5c1644bc8d","resources":{"compressedBytes":1803467462,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:1a5a7942cd6968e5c8af3937e81ff1342956e52cac1b844e27cf1a7e49fab975","engineRevision":"tacklebox-1.0","indexDigest":"sha256:c8c9b6c6976cdb992fb955ccd1bff608da4c674415ccc49c16a849e4c73d098a","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:fed146a7caade1e6e2a0a0114424c8f16ebd86b11273328384f966e7f2def5f8"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"grouper"},"targetKey":"grouper:xfce:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1798688784,"desktop":"xfce","digest":"sha256:b9a5367f592d771f0cbd564927d3e1ca5dc7d242939544f2b727b2b6a79ac0ae","hasSdBoot":true,"kernelVer":"6.15.0-14-generic","layerCount":65,"pkgManager":"apt","repoFamily":"debian"},"publication":{"ref":"ghcr.io/tuna-os/grouper:xfce","repository":"ghcr.io/tuna-os/grouper","tag":"xfce"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:7a4d21246f881b447bafb52ea577c6f84c6fb4e4b9631832c34510fd271160ee","resources":{"compressedBytes":1798688784,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:004113fa32cd82aeb4ca9aed82870b0d86d06de8ee2d497ac43d4258c22a643f","engineRevision":"tacklebox-1.0","indexDigest":"sha256:c8c9b6c6976cdb992fb955ccd1bff608da4c674415ccc49c16a849e4c73d098a","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:b9a5367f592d771f0cbd564927d3e1ca5dc7d242939544f2b727b2b6a79ac0ae"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"xfce","hardwareScope":"generic","platform":"linux/arm64","variant":"grouper"},"targetKey":"grouper:xfce:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":3541207386,"desktop":"kde","digest":"sha256:5de7d0d0c85ca1d732d2812d268a953f15e2edb33857b4e3af2d75fbf0485f5e","hasSdBoot":true,"kernelVer":"6.15.2-gentoo-dist","layerCount":65,"pkgManager":"emerge","repoFamily":"gentoo"},"publication":{"ref":"ghcr.io/tuna-os/guppy:kde","repository":"ghcr.io/tuna-os/guppy","tag":"kde"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:b3d9c07b3b1b6f313678efb9f6c1b5cddcd997e0ed2f399d9a0ad61821bb4b2c","resources":{"compressedBytes":3541207386,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:b6834ff4cfcdd1094c44979b1ee34f9818866e83fcf844a313cae364ca18a991","engineRevision":"tacklebox-1.0","indexDigest":"sha256:f21929ce658aa238e5265c53ea5c8fc3fef26dd350ed6879a8dc305360623cca","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:5de7d0d0c85ca1d732d2812d268a953f15e2edb33857b4e3af2d75fbf0485f5e"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"guppy"},"targetKey":"guppy:kde:linux/amd64"},{"availability":{"available":false,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"kde","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/guppy:kde","repository":"ghcr.io/tuna-os/guppy","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":false,"target":{"cpuBaseline":"armv8-a","flavor":"kde","hardwareScope":"generic","platform":"linux/arm64","variant":"guppy"},"targetKey":"guppy:kde:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2683575187,"desktop":"xfce","digest":"sha256:cdd32b7bdc2e9f0a28ddc1ed93981687200406e62d67e4b458e13fe7732f38b3","hasSdBoot":true,"kernelVer":"6.15.2-gentoo-dist","layerCount":65,"pkgManager":"emerge","repoFamily":"gentoo"},"publication":{"ref":"ghcr.io/tuna-os/guppy:xfce","repository":"ghcr.io/tuna-os/guppy","tag":"xfce"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:1e651d95b4d61b540c0f1788099f7fd4db4cb9b06d50e8cf18f5365b134a1571","resources":{"compressedBytes":2683575187,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:2525a1dc6a071197bbf7445cdad7f76805260edf26b12ed7fd30431a0d1ed5df","engineRevision":"tacklebox-1.0","indexDigest":"sha256:72db4d532067309ce2e9db3c523b59ea3b1a596be0908af8eceeca2c84f9667e","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:cdd32b7bdc2e9f0a28ddc1ed93981687200406e62d67e4b458e13fe7732f38b3"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"guppy"},"targetKey":"guppy:xfce:linux/amd64"},{"availability":{"available":false,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"xfce","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/guppy:xfce","repository":"ghcr.io/tuna-os/guppy","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":false,"target":{"cpuBaseline":"armv8-a","flavor":"xfce","hardwareScope":"generic","platform":"linux/arm64","variant":"guppy"},"targetKey":"guppy:xfce:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2158635219,"desktop":"cosmic","digest":"sha256:31e3427fdc5920d5fa40cfe680b423fcb0a5bf2fbda890a2f2591ba832e25811","hasSdBoot":true,"kernelVer":"6.15.2-arch1-1","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:cosmic","repository":"ghcr.io/tuna-os/marlin","tag":"cosmic"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:f3579564af01c41ba913a21277db42762ae7901bd631833ddbb6a1eb9b9b75db","resources":{"compressedBytes":2158635219,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:93610ea9184a1f777d19bf4d2df9b70dfd1e5914cf978cca413431825bbc41b3","engineRevision":"tacklebox-1.0","indexDigest":"sha256:1f37a9eb1ef864d2c751ff7c4308e07ac7a59b87f403af49e1645d04ed96b884","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:31e3427fdc5920d5fa40cfe680b423fcb0a5bf2fbda890a2f2591ba832e25811"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:cosmic:linux/amd64"},{"availability":{"available":false,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"cosmic","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/marlin:cosmic","repository":"ghcr.io/tuna-os/marlin","tag":"cosmic"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":false,"target":{"cpuBaseline":"armv8-a","flavor":"cosmic","hardwareScope":"generic","platform":"linux/arm64","variant":"marlin"},"targetKey":"marlin:cosmic:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2241350510,"desktop":"gnome","digest":"sha256:4dc0785f0299ba5b6447f5a80bf56f89412bdf0f3e20995ac84aa4a493d3e01c","hasSdBoot":true,"kernelVer":"6.15.2-arch1-1","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:gnome","repository":"ghcr.io/tuna-os/marlin","tag":"gnome"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:e8c3292f33e6e98c231c6bf29d3080224e72b20519c7dedab4b5a359a8f1fddf","resources":{"compressedBytes":2241350510,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:4e70f56dedbbca648ac05068e18a8468c955305290c18e1e4a8ec9c1b3e36525","engineRevision":"tacklebox-1.0","indexDigest":"sha256:73e5bbbccbf7ca6afadde3b4181b5b8c7e9cd71c6ba4cb836093d32856bbe5cc","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:4dc0785f0299ba5b6447f5a80bf56f89412bdf0f3e20995ac84aa4a493d3e01c"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2343631618,"desktop":"gnome","digest":"sha256:c42160f1b4f77313e20817b435867f1c6d355045a3583f645ae8c2c9ea4db19b","hasSdBoot":true,"kernelVer":"6.15.2-arch1-1","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:gnome","repository":"ghcr.io/tuna-os/marlin","tag":"gnome"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:6c8b3e2523d0e4f86701a3c52e91461375e3e03243152447649fe479e0e90519","resources":{"compressedBytes":2343631618,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:f5e5f04db4ef53fae5613dac124eaca83e14291e9573e4c25e454010c1eb2980","engineRevision":"tacklebox-1.0","indexDigest":"sha256:73e5bbbccbf7ca6afadde3b4181b5b8c7e9cd71c6ba4cb836093d32856bbe5cc","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:c42160f1b4f77313e20817b435867f1c6d355045a3583f645ae8c2c9ea4db19b"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome","hardwareScope":"generic","platform":"linux/arm64","variant":"marlin"},"targetKey":"marlin:gnome:linux/arm64"},{"availability":{"available":false,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"kde","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/marlin:kde-nvidia","repository":"ghcr.io/tuna-os/marlin","tag":"kde-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:kde-nvidia:linux/amd64"},{"availability":{"available":false,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"kde","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/marlin:kde-nvidia","repository":"ghcr.io/tuna-os/marlin","tag":"kde-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":false,"target":{"cpuBaseline":"armv8-a","flavor":"kde-nvidia","hardwareScope":"generic","platform":"linux/arm64","variant":"marlin"},"targetKey":"marlin:kde-nvidia:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2169534873,"desktop":"kde","digest":"sha256:84cc14c124a307ec6f2e2a1c8c5141b272135a711a0a25347b370da46b526566","hasSdBoot":true,"kernelVer":"6.15.2-arch1-1","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:kde","repository":"ghcr.io/tuna-os/marlin","tag":"kde"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:4402a1108ee039aca67744c1c4683308ea31d134e4cecb413229001117d47696","resources":{"compressedBytes":2169534873,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:28b685bc8f7c2d5784dda16c196177e52c26bfea5b3b6e4df9654e1a09ef0e79","engineRevision":"tacklebox-1.0","indexDigest":"sha256:d6050a0af4ea38ce54f2e2609c778e99ea2c54814a3c2631a2da6eb0c0093f51","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:84cc14c124a307ec6f2e2a1c8c5141b272135a711a0a25347b370da46b526566"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:kde:linux/amd64"},{"availability":{"available":false,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"kde","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/marlin:kde","repository":"ghcr.io/tuna-os/marlin","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":false,"target":{"cpuBaseline":"armv8-a","flavor":"kde","hardwareScope":"generic","platform":"linux/arm64","variant":"marlin"},"targetKey":"marlin:kde:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1716167643,"desktop":"niri","digest":"sha256:5276dbe03d29719593c2f6b2fa98da165e6046a91aaa47933dc752c2918cb038","hasSdBoot":true,"kernelVer":"6.15.2-arch1-1","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:niri","repository":"ghcr.io/tuna-os/marlin","tag":"niri"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:5d4de62adb1557e54179bb979ede49d4104644e4b2a2745ca22f5d71930b151e","resources":{"compressedBytes":1716167643,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:47893332085d656c0119bdbedc46f9be0d95b869e5a61ece1841000f2f47948b","engineRevision":"tacklebox-1.0","indexDigest":"sha256:365845f9fb22f1a7449ef3bce20a0dcb58f747ca6beba27959ca624e2cbc8626","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:5276dbe03d29719593c2f6b2fa98da165e6046a91aaa47933dc752c2918cb038"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:niri:linux/amd64"},{"availability":{"available":false,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"niri","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/marlin:niri","repository":"ghcr.io/tuna-os/marlin","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":false,"target":{"cpuBaseline":"armv8-a","flavor":"niri","hardwareScope":"generic","platform":"linux/arm64","variant":"marlin"},"targetKey":"marlin:niri:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1845097033,"desktop":"xfce","digest":"sha256:a74b4902325f66a03205f17fe802bbd4d5b8a95f9a9e9be7ca0fafc1cfb64d57","hasSdBoot":true,"kernelVer":"6.15.2-arch1-1","layerCount":65,"pkgManager":"pacman","repoFamily":"arch"},"publication":{"ref":"ghcr.io/tuna-os/marlin:xfce","repository":"ghcr.io/tuna-os/marlin","tag":"xfce"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:f0b38dbf492981efd955007071885015e6557cab214da4a1550545475f2aa1ed","resources":{"compressedBytes":1845097033,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:9421b6ed8cabc15616d0503fd249331af6bfe81fc4e75e0f5eb6c22a3804c918","engineRevision":"tacklebox-1.0","indexDigest":"sha256:7e388e2b06b836161bd702ab8542975e0ceb950d0cd5d3ac238f8aea29d83ee6","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:a74b4902325f66a03205f17fe802bbd4d5b8a95f9a9e9be7ca0fafc1cfb64d57"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"marlin"},"targetKey":"marlin:xfce:linux/amd64"},{"availability":{"available":false,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"xfce","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/marlin:xfce","repository":"ghcr.io/tuna-os/marlin","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":false,"target":{"cpuBaseline":"armv8-a","flavor":"xfce","hardwareScope":"generic","platform":"linux/arm64","variant":"marlin"},"targetKey":"marlin:xfce:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1742165475,"desktop":"cosmic","digest":"sha256:35108792e2895d9f4c27536c39943911b21cab79ce1dac647d31e3f95d645a78","hasSdBoot":true,"kernelVer":"6.15.2-1-default","layerCount":65,"pkgManager":"zypper","repoFamily":"opensuse"},"publication":{"ref":"ghcr.io/tuna-os/sailfin:cosmic","repository":"ghcr.io/tuna-os/sailfin","tag":"cosmic"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:a7a16934dc8be7dc28e3b5e5446248d2fcb5fa1c093263798b9fa1e109143ba5","resources":{"compressedBytes":1742165475,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:1b4df279cddf24a22ef79a8cc335e1eae302ebf3666899b95ec172fdda04f770","engineRevision":"tacklebox-1.0","indexDigest":"sha256:1e7411c1beb16adc51a550be277b663e3fc33bdf5945e5728ef2704040912f6c","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:35108792e2895d9f4c27536c39943911b21cab79ce1dac647d31e3f95d645a78"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"cosmic","hardwareScope":"generic","platform":"linux/amd64","variant":"sailfin"},"targetKey":"sailfin:cosmic:linux/amd64"},{"availability":{"available":false,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"cosmic","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/sailfin:cosmic","repository":"ghcr.io/tuna-os/sailfin","tag":"cosmic"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":false,"target":{"cpuBaseline":"armv8-a","flavor":"cosmic","hardwareScope":"generic","platform":"linux/arm64","variant":"sailfin"},"targetKey":"sailfin:cosmic:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1865291060,"desktop":"gnome","digest":"sha256:8c2d7add585c2d7add9f65af061ce22472eca04633a0310f01a46b589b173ee2","hasSdBoot":true,"kernelVer":"6.15.2-1-default","layerCount":65,"pkgManager":"zypper","repoFamily":"opensuse"},"publication":{"ref":"ghcr.io/tuna-os/sailfin:gnome","repository":"ghcr.io/tuna-os/sailfin","tag":"gnome"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:9435156e5c61259cb98658d1da3819c124f781b017a9653edab09820f50b8102","resources":{"compressedBytes":1865291060,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:b218dd3655bf7b1442dd18309e07e34d750cf8f8786de46817a2e7b0f7f618ab","engineRevision":"tacklebox-1.0","indexDigest":"sha256:9906d80bc6184448d619be33fd8db589c5086e00b1bef4d466d782a76173ff16","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:8c2d7add585c2d7add9f65af061ce22472eca04633a0310f01a46b589b173ee2"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"sailfin"},"targetKey":"sailfin:gnome:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1904048895,"desktop":"gnome","digest":"sha256:15f8300c0ead03237a7d423fdd85d77407057c7ecc53eb2c96c6a01611db06b3","hasSdBoot":true,"kernelVer":"6.15.2-1-default","layerCount":65,"pkgManager":"zypper","repoFamily":"opensuse"},"publication":{"ref":"ghcr.io/tuna-os/sailfin:gnome","repository":"ghcr.io/tuna-os/sailfin","tag":"gnome"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:f85fcdd981a54c7140d1afced4b035eb0ae125be04f8f453e12860261206d158","resources":{"compressedBytes":1904048895,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:eda30f7211b2a5c497cbecd6c03f590076aa43ed9a292cf73f77bcec65768a47","engineRevision":"tacklebox-1.0","indexDigest":"sha256:9906d80bc6184448d619be33fd8db589c5086e00b1bef4d466d782a76173ff16","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:15f8300c0ead03237a7d423fdd85d77407057c7ecc53eb2c96c6a01611db06b3"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome","hardwareScope":"generic","platform":"linux/arm64","variant":"sailfin"},"targetKey":"sailfin:gnome:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":2225917883,"desktop":"kde","digest":"sha256:7aead67142b8976c79dc003297cf1c7c9025ec9ad6864ccd8810ca78e8794798","hasSdBoot":true,"kernelVer":"6.15.2-1-default","layerCount":65,"pkgManager":"zypper","repoFamily":"opensuse"},"publication":{"ref":"ghcr.io/tuna-os/sailfin:kde","repository":"ghcr.io/tuna-os/sailfin","tag":"kde"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:5246810285ea92e9c7500f89b8cb00cba1db7ad8c2b9dbaa4ac0e69b004bf80d","resources":{"compressedBytes":2225917883,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:7bd2ec91f97013bd864f758162bec86d1d5d4072e55b99c2c6c6790155885837","engineRevision":"tacklebox-1.0","indexDigest":"sha256:3becd9046a6332c9187a4a66714f87e4ffd0fe7f3ba8cb8c0087df9927cfd190","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:7aead67142b8976c79dc003297cf1c7c9025ec9ad6864ccd8810ca78e8794798"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"sailfin"},"targetKey":"sailfin:kde:linux/amd64"},{"availability":{"available":false,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"kde","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/sailfin:kde","repository":"ghcr.io/tuna-os/sailfin","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":false,"target":{"cpuBaseline":"armv8-a","flavor":"kde","hardwareScope":"generic","platform":"linux/arm64","variant":"sailfin"},"targetKey":"sailfin:kde:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1624489022,"desktop":"niri","digest":"sha256:584cdca7ea56848e6ae78db292a6c82dec8f22435ef6f9cc2a12ad744ab1b3a4","hasSdBoot":true,"kernelVer":"6.15.2-1-default","layerCount":65,"pkgManager":"zypper","repoFamily":"opensuse"},"publication":{"ref":"ghcr.io/tuna-os/sailfin:niri","repository":"ghcr.io/tuna-os/sailfin","tag":"niri"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:f5f587e9623c62c57783e8b1c566ca17e86fb99a1f570417ab3fcf703ffc2a02","resources":{"compressedBytes":1624489022,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:c3ae4e249c8b59e8af809f46549ba41b0dc8944eec0b9f35688e5a935fe4f43a","engineRevision":"tacklebox-1.0","indexDigest":"sha256:ccdf1bbc53a45e8bf73df49ef9d4e6a553b1b80dd626411132bac0f48327723e","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:584cdca7ea56848e6ae78db292a6c82dec8f22435ef6f9cc2a12ad744ab1b3a4"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"niri","hardwareScope":"generic","platform":"linux/amd64","variant":"sailfin"},"targetKey":"sailfin:niri:linux/amd64"},{"availability":{"available":false,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"niri","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/sailfin:niri","repository":"ghcr.io/tuna-os/sailfin","tag":"niri"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":false,"target":{"cpuBaseline":"armv8-a","flavor":"niri","hardwareScope":"generic","platform":"linux/arm64","variant":"sailfin"},"targetKey":"sailfin:niri:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1680268998,"desktop":"xfce","digest":"sha256:05167b7973c48980fd7f7cb80d48a07f151b57a42b5b3bbd34d02358215a984c","hasSdBoot":true,"kernelVer":"6.15.2-1-default","layerCount":65,"pkgManager":"zypper","repoFamily":"opensuse"},"publication":{"ref":"ghcr.io/tuna-os/sailfin:xfce","repository":"ghcr.io/tuna-os/sailfin","tag":"xfce"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:8ebcde128474f92c60b75000a5c5a9b2390352984fccf9418bb5ba40dcee5b21","resources":{"compressedBytes":1680268998,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:c1dc1d957109b87dbd55b3857d3c54006e9b5ecbcbe89a0d477deaf1f12571b8","engineRevision":"tacklebox-1.0","indexDigest":"sha256:e0c7a8393cc4f3b948d4b8c9027818ff04ae26c5b4015a0eb0d0e1f0c438004f","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:05167b7973c48980fd7f7cb80d48a07f151b57a42b5b3bbd34d02358215a984c"},"scheduled":true,"target":{"cpuBaseline":"x86-64","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"sailfin"},"targetKey":"sailfin:xfce:linux/amd64"},{"availability":{"available":false,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"xfce","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/sailfin:xfce","repository":"ghcr.io/tuna-os/sailfin","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":false,"target":{"cpuBaseline":"armv8-a","flavor":"xfce","hardwareScope":"generic","platform":"linux/arm64","variant":"sailfin"},"targetKey":"sailfin:xfce:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1897088938,"desktop":"cosmic","digest":"sha256:75cec5e5d0c52a820c43316c4fd36e6eb88a29f9407702c15b5e65c17a86be7e","hasSdBoot":false,"kernelVer":"6.12.0-266.el10.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:cosmic","repository":"ghcr.io/tuna-os/skipjack","tag":"cosmic"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:4f74670e0644be55e259e0ecd186f56fd3defbafbfb65e55978d5f4f6e943a5c","resources":{"compressedBytes":1897088938,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:cf7868e41752da985c9f7249e84cdfc54532da56c4a5d51a484ebcf57f91e70c","engineRevision":"tacklebox-1.0","indexDigest":"sha256:ab143ae72e9e6388ea35ad37601d6d3985240bdf9e86d4991d17c141cc200d16","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:75cec5e5d0c52a820c43316c4fd36e6eb88a29f9407702c15b5e65c17a86be7e"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"cosmic","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:cosmic:linux/amd64"},{"availability":{"available":false,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"cosmic","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/skipjack:cosmic","repository":"ghcr.io/tuna-os/skipjack","tag":"cosmic"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"cosmic","hardwareScope":"generic","platform":"linux/arm64","variant":"skipjack"},"targetKey":"skipjack:cosmic:linux/arm64"},{"availability":{"available":false,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"gnome","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/skipjack:gnome-hwe","repository":"ghcr.io/tuna-os/skipjack","tag":"gnome-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"gnome-hwe","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:gnome-hwe:linux/amd64"},{"availability":{"available":false,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"gnome","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/skipjack:gnome-hwe","repository":"ghcr.io/tuna-os/skipjack","tag":"gnome-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":false,"target":{"cpuBaseline":"armv8-a","flavor":"gnome-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"skipjack"},"targetKey":"skipjack:gnome-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1834956338,"desktop":"gnome","digest":"sha256:01ae7e79d4ec2ddbf7388660e10e6405800f70e19a44e5474be7b7943e3c8486","hasSdBoot":false,"kernelVer":"6.12.0-266.el10.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:gnome","repository":"ghcr.io/tuna-os/skipjack","tag":"gnome"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:cec983eb16183953e01e61bc00dadd84b3abb37ac48fc7714c9c6f10e78151a7","resources":{"compressedBytes":1834956338,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:51ed9e6cf6b35fee26b5670c4b9a0e3b3befc1b485abf8ea4b3351a72f702f27","engineRevision":"tacklebox-1.0","indexDigest":"sha256:f318dbf25a8bebf63384de761a1f5da4ca72b027a2bc755ec1ff09e88cba3cc8","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:01ae7e79d4ec2ddbf7388660e10e6405800f70e19a44e5474be7b7943e3c8486"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:gnome:linux/amd64"},{"availability":{"available":false,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"gnome","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/skipjack:gnome","repository":"ghcr.io/tuna-os/skipjack","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":false,"target":{"cpuBaseline":"armv8-a","flavor":"gnome","hardwareScope":"generic","platform":"linux/arm64","variant":"skipjack"},"targetKey":"skipjack:gnome:linux/arm64"},{"availability":{"available":false,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"kde","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/skipjack:kde-nvidia","repository":"ghcr.io/tuna-os/skipjack","tag":"kde-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"kde-nvidia","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:kde-nvidia:linux/amd64"},{"availability":{"available":false,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"kde","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/skipjack:kde-nvidia","repository":"ghcr.io/tuna-os/skipjack","tag":"kde-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":false,"target":{"cpuBaseline":"armv8-a","flavor":"kde-nvidia","hardwareScope":"generic","platform":"linux/arm64","variant":"skipjack"},"targetKey":"skipjack:kde-nvidia:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1975368017,"desktop":"kde","digest":"sha256:79e7b410de94a28d04f431576a1eb1cdfa0fa08c7433ac03b6bcf7b793f5f6d2","hasSdBoot":false,"kernelVer":"6.12.0-266.el10.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:kde","repository":"ghcr.io/tuna-os/skipjack","tag":"kde"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:5192f38f36d0871340468fbdb314591c0f43c9107e741f71fe51aac7eab7b211","resources":{"compressedBytes":1975368017,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:a07efa434eda3149bcd9981af69e2807951ee96aff6239f573a91e846fac8304","engineRevision":"tacklebox-1.0","indexDigest":"sha256:c8260d5138bd10ddae59d3828522b16aec3961b02e069b1ae8daa82bcff6a892","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:79e7b410de94a28d04f431576a1eb1cdfa0fa08c7433ac03b6bcf7b793f5f6d2"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:kde:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1869207521,"desktop":"kde","digest":"sha256:07ff98edd770fa2cf5860c95a1bb3e4915fc3cf8f9b4efc52b622588364c9f71","hasSdBoot":false,"kernelVer":"6.12.0-266.el10.aarch64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:kde","repository":"ghcr.io/tuna-os/skipjack","tag":"kde"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:cb0dbdceeff6a7e29a78e27ef520d09cc8fea5ca00aa27828a8879c3ba10c941","resources":{"compressedBytes":1869207521,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:c505393af7ec20cab8851ff46f3328b32613a37c5066730c260b52adb5ae7aaf","engineRevision":"tacklebox-1.0","indexDigest":"sha256:c8260d5138bd10ddae59d3828522b16aec3961b02e069b1ae8daa82bcff6a892","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:07ff98edd770fa2cf5860c95a1bb3e4915fc3cf8f9b4efc52b622588364c9f71"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"kde","hardwareScope":"generic","platform":"linux/arm64","variant":"skipjack"},"targetKey":"skipjack:kde:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1762828614,"desktop":"niri","digest":"sha256:ea33facb8ba893c24925809174142ed8ccc850ed819610c5534b6e9eae8c5d0a","hasSdBoot":false,"kernelVer":"6.12.0-266.el10.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:niri","repository":"ghcr.io/tuna-os/skipjack","tag":"niri"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:70a1585e09af56f7bb6e8d224dd68f338f57bccffe44dd09d6161e805f2e40c6","resources":{"compressedBytes":1762828614,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:292cfd7632065b4bc3f7b4fb3d5d77b358c6afc83ef60362229bfe1829313cba","engineRevision":"tacklebox-1.0","indexDigest":"sha256:df4f011855ef430ce896fe42acef195972c3108c9cb3a5d477d5d3bd97530657","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:ea33facb8ba893c24925809174142ed8ccc850ed819610c5534b6e9eae8c5d0a"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"niri","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:niri:linux/amd64"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1651740086,"desktop":"niri","digest":"sha256:fb9e446415fd59a4f075b21a2677677ff66e251017ac34d135cad8aa5d537307","hasSdBoot":false,"kernelVer":"6.12.0-266.el10.aarch64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:niri","repository":"ghcr.io/tuna-os/skipjack","tag":"niri"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:413a0384b64b8439047c8bf29613987bc6d23b208de608c9839e51c19de6dc39","resources":{"compressedBytes":1651740086,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:f0b6f57fec7475b503e644b60c869f6b9c20b8f6552c9b420930ff4233315d2b","engineRevision":"tacklebox-1.0","indexDigest":"sha256:df4f011855ef430ce896fe42acef195972c3108c9cb3a5d477d5d3bd97530657","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:fb9e446415fd59a4f075b21a2677677ff66e251017ac34d135cad8aa5d537307"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"niri","hardwareScope":"generic","platform":"linux/arm64","variant":"skipjack"},"targetKey":"skipjack:niri:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1559524359,"desktop":"xfce","digest":"sha256:e889345c859cf2a47c9f20ecc050ad4e2c1d37283e1fc071ecbe5aa68bc45dab","hasSdBoot":false,"kernelVer":"6.12.0-266.el10.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/skipjack:xfce","repository":"ghcr.io/tuna-os/skipjack","tag":"xfce"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:0cdcd527b2aac0a9e29e6f5ad528dec4a000b292d4d823e99f11a1f025d14182","resources":{"compressedBytes":1559524359,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:b4bb30506bc35f6530d5d1fc5c2340c07ea1fcef1e66154c6ce58d49a0ec4b05","engineRevision":"tacklebox-1.0","indexDigest":"sha256:c96b311e94809547362fb0c9b72826e2a610553424162d2e9b6d0c6a0e355567","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:e889345c859cf2a47c9f20ecc050ad4e2c1d37283e1fc071ecbe5aa68bc45dab"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64","variant":"skipjack"},"targetKey":"skipjack:xfce:linux/amd64"},{"availability":{"available":false,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"xfce","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/skipjack:xfce","repository":"ghcr.io/tuna-os/skipjack","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":false,"target":{"cpuBaseline":"armv8-a","flavor":"xfce","hardwareScope":"generic","platform":"linux/arm64","variant":"skipjack"},"targetKey":"skipjack:xfce:linux/arm64"},{"availability":{"available":false,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"cosmic","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/wahoo:cosmic","repository":"ghcr.io/tuna-os/wahoo","tag":"cosmic"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"cosmic","hardwareScope":"generic","platform":"linux/amd64","variant":"wahoo"},"targetKey":"wahoo:cosmic:linux/amd64"},{"availability":{"available":false,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"cosmic","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/wahoo:cosmic","repository":"ghcr.io/tuna-os/wahoo","tag":"cosmic"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"cosmic","hardwareScope":"generic","platform":"linux/arm64","variant":"wahoo"},"targetKey":"wahoo:cosmic:linux/arm64"},{"availability":{"available":false,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"gnome","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/wahoo:gnome","repository":"ghcr.io/tuna-os/wahoo","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64","variant":"wahoo"},"targetKey":"wahoo:gnome:linux/amd64"},{"availability":{"available":false,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"gnome","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/wahoo:gnome","repository":"ghcr.io/tuna-os/wahoo","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"gnome","hardwareScope":"generic","platform":"linux/arm64","variant":"wahoo"},"targetKey":"wahoo:gnome:linux/arm64"},{"availability":{"available":false,"ociPlatform":{"architecture":"amd64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"kde","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/wahoo:kde","repository":"ghcr.io/tuna-os/wahoo","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":true,"target":{"cpuBaseline":"x86-64-v3","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64","variant":"wahoo"},"targetKey":"wahoo:kde:linux/amd64"},{"availability":{"available":false,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"kde","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/wahoo:kde","repository":"ghcr.io/tuna-os/wahoo","tag":"kde"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"kde","hardwareScope":"generic","platform":"linux/arm64","variant":"wahoo"},"targetKey":"wahoo:kde:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1867977282,"desktop":"cosmic","digest":"sha256:9f465145df9b932ed2bcd65dc17aab70c7243142ddc8c485e75a0faac2ab92ae","hasSdBoot":false,"kernelVer":"6.12.0-266.el10.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:cosmic","repository":"ghcr.io/tuna-os/yellowfin","tag":"cosmic"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:5c9103dafdca2ecca259139468ea03eb060b1ff45497018ddcea23d5ed9f4d8f","resources":{"compressedBytes":1867977282,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:9a4c9302472b1fa4f5111b6c8e069e001e7080cef73c744452d57beb2df68cd4","engineRevision":"tacklebox-1.0","indexDigest":"sha256:57267c84ec4c27b9982b05cbec309fe2df9aef90abfc50fae6750223e1355593","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:9f465145df9b932ed2bcd65dc17aab70c7243142ddc8c485e75a0faac2ab92ae"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"cosmic","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"yellowfin"},"targetKey":"yellowfin:cosmic:linux/amd64/v2"},{"availability":{"available":false,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"cosmic","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:cosmic","repository":"ghcr.io/tuna-os/yellowfin","tag":"cosmic"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"cosmic","hardwareScope":"generic","platform":"linux/arm64","variant":"yellowfin"},"targetKey":"yellowfin:cosmic:linux/arm64"},{"availability":{"available":false,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":false,"compressedSize":0,"desktop":"gnome","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:gnome-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"gnome-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"gnome-hwe","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"yellowfin"},"targetKey":"yellowfin:gnome-hwe:linux/amd64/v2"},{"availability":{"available":false,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"gnome","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:gnome-hwe","repository":"ghcr.io/tuna-os/yellowfin","tag":"gnome-hwe"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":false,"target":{"cpuBaseline":"armv8-a","flavor":"gnome-hwe","hardwareScope":"generic","platform":"linux/arm64","variant":"yellowfin"},"targetKey":"yellowfin:gnome-hwe:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1802434486,"desktop":"gnome","digest":"sha256:bbf07c11dbd467aa9d5989ebd62a675dfc7ae1da2da0ec2b4d39a5108e691f9f","hasSdBoot":false,"kernelVer":"6.12.0-266.el10.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:gnome","repository":"ghcr.io/tuna-os/yellowfin","tag":"gnome"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:7c56ce0de9ac070b6832e6f9874c96ca88d46da0c50ff9600afbd5e5d22f3785","resources":{"compressedBytes":1802434486,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:b651b30517d7fb5456f46ff874eafdd1ab4da41b6146e624de3ae4ea8522be6f","engineRevision":"tacklebox-1.0","indexDigest":"sha256:420cb184f3ad20676db923ae4e83f85f1444baaaf79349497c519cf849fab6f9","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:bbf07c11dbd467aa9d5989ebd62a675dfc7ae1da2da0ec2b4d39a5108e691f9f"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"gnome","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"yellowfin"},"targetKey":"yellowfin:gnome:linux/amd64/v2"},{"availability":{"available":false,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"gnome","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:gnome","repository":"ghcr.io/tuna-os/yellowfin","tag":"gnome"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":false,"target":{"cpuBaseline":"armv8-a","flavor":"gnome","hardwareScope":"generic","platform":"linux/arm64","variant":"yellowfin"},"targetKey":"yellowfin:gnome:linux/arm64"},{"availability":{"available":false,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":false,"compressedSize":0,"desktop":"kde","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:kde-nvidia","repository":"ghcr.io/tuna-os/yellowfin","tag":"kde-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":false,"target":{"cpuBaseline":"x86-64-v2","flavor":"kde-nvidia","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"yellowfin"},"targetKey":"yellowfin:kde-nvidia:linux/amd64/v2"},{"availability":{"available":false,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"kde","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:kde-nvidia","repository":"ghcr.io/tuna-os/yellowfin","tag":"kde-nvidia"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":false,"target":{"cpuBaseline":"armv8-a","flavor":"kde-nvidia","hardwareScope":"generic","platform":"linux/arm64","variant":"yellowfin"},"targetKey":"yellowfin:kde-nvidia:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1940761693,"desktop":"kde","digest":"sha256:f814b57e1cc171f0542df1645bb8ca94f4c012138cdd104e4d6fdf0002b65f2b","hasSdBoot":false,"kernelVer":"6.12.0-266.el10.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:kde","repository":"ghcr.io/tuna-os/yellowfin","tag":"kde"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:8391848f6c02bcbdc395f99f05b2c4a035e473fa204b33317601af5e66904f99","resources":{"compressedBytes":1940761693,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:5314319c15355a25852360cc2d02fc3a7229053404458d9b0d5feeb6c27ed224","engineRevision":"tacklebox-1.0","indexDigest":"sha256:56e190216c53782aa385e08d3d6eaeb1b4c1d0a0c26993d3ee2af869a39ecb54","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:f814b57e1cc171f0542df1645bb8ca94f4c012138cdd104e4d6fdf0002b65f2b"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"kde","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"yellowfin"},"targetKey":"yellowfin:kde:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1842323628,"desktop":"kde","digest":"sha256:8579c73da428e5dd4564656f198ae1ba658e4c46911f42c5f4816e1d7c359746","hasSdBoot":false,"kernelVer":"6.12.0-266.el10.aarch64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:kde","repository":"ghcr.io/tuna-os/yellowfin","tag":"kde"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:4ba525dc72069d1cae32585cfe6d6575f774976ad01165c97bbdb0478facd7f3","resources":{"compressedBytes":1842323628,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:1c36ec076410c4a9594eb3993fdd9b8c9537a0ac1edbbb78e0c243d16cade439","engineRevision":"tacklebox-1.0","indexDigest":"sha256:56e190216c53782aa385e08d3d6eaeb1b4c1d0a0c26993d3ee2af869a39ecb54","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:8579c73da428e5dd4564656f198ae1ba658e4c46911f42c5f4816e1d7c359746"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"kde","hardwareScope":"generic","platform":"linux/arm64","variant":"yellowfin"},"targetKey":"yellowfin:kde:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1742671260,"desktop":"niri","digest":"sha256:4adc714284034c35ebacaa40e4f092a9d645ecd2aff279f54dd16365a4dfb500","hasSdBoot":false,"kernelVer":"6.12.0-266.el10.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:niri","repository":"ghcr.io/tuna-os/yellowfin","tag":"niri"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:0d5e2106c7349c4e032382cce720205a5ed27f0cf932d6e1939e968c4bd7ec58","resources":{"compressedBytes":1742671260,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:6fd98f6ff1cdf2e8d4ec9919f3db6c15f227c32dbf2d6e84c91c7e4b6b08ffa4","engineRevision":"tacklebox-1.0","indexDigest":"sha256:4068890b6dfae85400128bef8280f488443d9aac2d4a756e603d36d1feda5c9d","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:4adc714284034c35ebacaa40e4f092a9d645ecd2aff279f54dd16365a4dfb500"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"niri","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"yellowfin"},"targetKey":"yellowfin:niri:linux/amd64/v2"},{"availability":{"available":true,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":true,"compressedSize":1625636839,"desktop":"niri","digest":"sha256:d79e74fb14fe2eacaa54be00be4a8aa365b6261c03a788074bf98dbc0ba4f1bd","hasSdBoot":false,"kernelVer":"6.12.0-266.el10.aarch64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:niri","repository":"ghcr.io/tuna-os/yellowfin","tag":"niri"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:d1c749cc3bf6ae57d4b36706a658a575435237ae2265349754230169f3b48080","resources":{"compressedBytes":1625636839,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:7d662e14eb36ccdc344914e4f8a7346e1b7b8e4fc95fb1b9c51a2d07fd477829","engineRevision":"tacklebox-1.0","indexDigest":"sha256:4068890b6dfae85400128bef8280f488443d9aac2d4a756e603d36d1feda5c9d","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:d79e74fb14fe2eacaa54be00be4a8aa365b6261c03a788074bf98dbc0ba4f1bd"},"scheduled":true,"target":{"cpuBaseline":"armv8-a","flavor":"niri","hardwareScope":"generic","platform":"linux/arm64","variant":"yellowfin"},"targetKey":"yellowfin:niri:linux/arm64"},{"availability":{"available":true,"ociPlatform":{"architecture":"amd64","os":"linux","variant":"v2"}},"facts":{"bootc":true,"compressedSize":1532012737,"desktop":"xfce","digest":"sha256:dda2d69d21c5b53944a876cbba55b7661c690bf0336e7884dc55864aaed38ebf","hasSdBoot":false,"kernelVer":"6.12.0-266.el10.x86_64","layerCount":65,"pkgManager":"dnf","repoFamily":"fedora"},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:xfce","repository":"ghcr.io/tuna-os/yellowfin","tag":"xfce"},"qualification":{"browser":{"engine":"chromium","wasm32":true},"qualifiedAt":"2026-10-17T00:00:00Z","reason":null,"receiptDigest":"sha256:4aa23ca5c649e10f4e1c35db2a97925751140631408d2120a8af0b49b5248149","resources":{"compressedBytes":1532012737,"layerCount":65,"minFreeStorageBytes":9500000000},"status":"qualified"},"required":true,"resolvedInputs":{"configDigest":"sha256:01d94c8c9922c636eb675fd6844ae358dceb65f619f00b645a17007611e74612","engineRevision":"tacklebox-1.0","indexDigest":"sha256:8a092ac01c707f0a892788e583d88f5834ee2f1453e4b80056c91f891686d545","installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":"sha256:dda2d69d21c5b53944a876cbba55b7661c690bf0336e7884dc55864aaed38ebf"},"scheduled":true,"target":{"cpuBaseline":"x86-64-v2","flavor":"xfce","hardwareScope":"generic","platform":"linux/amd64/v2","variant":"yellowfin"},"targetKey":"yellowfin:xfce:linux/amd64/v2"},{"availability":{"available":false,"ociPlatform":{"architecture":"arm64","os":"linux","variant":null}},"facts":{"bootc":false,"compressedSize":0,"desktop":"xfce","digest":null,"hasSdBoot":false,"kernelVer":"","layerCount":0,"pkgManager":"","repoFamily":""},"publication":{"ref":"ghcr.io/tuna-os/yellowfin:xfce","repository":"ghcr.io/tuna-os/yellowfin","tag":"xfce"},"qualification":{"browser":null,"qualifiedAt":null,"reason":"missing-platform-descriptor","receiptDigest":null,"resources":null,"status":"unqualified"},"required":true,"resolvedInputs":{"configDigest":null,"engineRevision":"tacklebox-1.0","indexDigest":null,"installerRevision":"remora-1.0","liveOverlayBaseDigest":null,"liveOverlayDigest":null,"platformManifestDigest":null},"scheduled":false,"target":{"cpuBaseline":"armv8-a","flavor":"xfce","hardwareScope":"generic","platform":"linux/arm64","variant":"yellowfin"},"targetKey":"yellowfin:xfce:linux/arm64"}]};

let catalogSnapshot = DEFAULT_CATALOG_SNAPSHOT;
let catalogSnapshotPromise = null;

function loadCatalogSnapshot() {
  if (catalogSnapshotPromise) return catalogSnapshotPromise;
  catalogSnapshotPromise = fetch("catalog-snapshot.json", { tboxMetadataOnly: true })
    .then((r) => (r.ok ? r.json() : DEFAULT_CATALOG_SNAPSHOT))
    .then((doc) => {
      if (doc && doc.schemaVersion === 1 && doc.kind === "catalog-snapshot" && Array.isArray(doc.targets)) {
        catalogSnapshot = doc;
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
    renderEditions();
    invalidateOperation("catalog-updated");
  }
  return catalogSnapshot;
};

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
    qualification = {
      status: catalogEntry.qualification?.status || "unqualified",
      reason: catalogEntry.qualification?.reason || null,
      qualifiedAt: catalogEntry.qualification?.qualifiedAt || null,
      receiptDigest: catalogEntry.qualification?.receiptDigest || null,
      browser: catalogEntry.qualification?.browser || null,
      resources: catalogEntry.qualification?.resources || null,
    };
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
  const built = buildRequestFromForm();
  currentOp = {
    id: ++operationSeq,
    state,
    ready: false,
    inspectedVia: null,
    storageBlocked: false,
    error: null,
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
  if (s.kind !== "opfs") return;

  const f = await s.fh.getFile();

  if (window.showSaveFilePicker) {
    try {
      const h = await showSaveFilePicker({ suggestedName: name, types: [{ description: "ISO image", accept: { "application/x-iso9660-image": [".iso"] } }] });
      const w = await h.createWritable();
      await f.stream().pipeTo(w);
      return;
    } catch (e) {
      if (e.name === "AbortError") return;
    }
  }

  const url = URL.createObjectURL(f);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 120_000);
}

function prepareDdi(ch) {
  if (isOperationBusy()) return;
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
      typeof window.tboxBuildIso === "function" && window.tboxBuildIso !== wasmNativeBuildIso;
    if (!hasBuildStub) {
      await window.loadWasm();
    }
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
    const bytes = await window.tboxBuildIso(
      { label, initrd, flatpaks, packages, extraRun, request: req },
      (u8) => s.w.write(u8),
    );
    await finishIsoSink(s, name);
    updatePostcardFilename(name);
    op.state = "completed";
    const dt = ((performance.now() - t0) / 1000).toFixed(1);
    $("stage").textContent = `Done — ${(bytes / 1e9).toFixed(2)} GB in ${dt}s.`;
    notify("ISO ready 🐟", `${(bytes / 1e9).toFixed(2)} GB written in ${dt}s`);
    log(`iso written: ${bytes} bytes`);
    $("postcard").classList.remove("hidden");
  } catch (e) {
    if (s?.w?.abort) {
      await s.w.abort().catch(() => {});
    }
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
    const qualStatus = entry?.qualification?.status || "unqualified";
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
