/* Validate engine observations without filling gaps from requests or catalogs.
 * Shared by the browser and the independent test-only diagnostic collector.
 * This is a shape check, not producer authentication or media qualification.
 */
(function (root) {
  function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  function digest(value) {
    return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
  }
  function platform(value) {
    if (!record(value) || typeof value.architecture !== "string" || !value.architecture.trim() ||
        (value.variant !== undefined && typeof value.variant !== "string")) {
      throw new Error("invalid observed platform descriptor");
    }
    return { architecture: value.architecture, ...(value.variant !== undefined ? { variant: value.variant } : {}) };
  }
  function text(value, pattern) {
    return typeof value === "string" && value.length > 0 && value === value.trim() &&
      !/[\x00-\x1f\x7f]/.test(value) && (!pattern || pattern.test(value));
  }
  const appIdPattern = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+$/;
  function fileObservation(value, expectedPath) {
    if (!record(value) || !text(value.path) || value.path.startsWith("/") ||
        value.path.split("/").some(part => !part || part === "." || part === "..") ||
        (expectedPath !== undefined && value.path !== expectedPath) || !digest(value.sha256) ||
        !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes <= 0) {
      throw new Error("invalid observed installer file");
    }
    return { path: value.path, sha256: value.sha256, sizeBytes: value.sizeBytes };
  }
  function installerObservation(value) {
    if (!record(value) || !record(value.stampClaims)) throw new Error("invalid observed installer inputs");
    const claims = value.stampClaims;
    if ((claims.appId !== undefined && !text(claims.appId, appIdPattern)) ||
        (claims.revision !== undefined && !digest(claims.revision)) ||
        (claims.bundleSha256Claim !== undefined && !digest(claims.bundleSha256Claim) &&
          !["remote", "unknown"].includes(claims.bundleSha256Claim))) {
      throw new Error("invalid observed installer stamp claims");
    }
    const result = { sourceStamp: fileObservation(value.sourceStamp, "etc/tunaos/live-source.json"),
      stampClaims: {
        ...(claims.appId !== undefined ? { appId: claims.appId } : {}),
        ...(claims.revision !== undefined ? { revision: claims.revision } : {}),
        ...(claims.bundleSha256Claim !== undefined ? { bundleSha256Claim: claims.bundleSha256Claim } : {}),
      } };
    let helperPath;
    if (value.deployment !== undefined) {
      const deployed = value.deployment;
      const ref = typeof deployed?.ref === "string" ? deployed.ref.split("/") : [];
      if (!record(deployed) || !text(deployed.appId, appIdPattern) ||
          !["x86_64", "aarch64"].includes(deployed.arch) ||
          ref.length !== 4 || ref[0] !== "app" || ref[1] !== deployed.appId || ref[2] !== deployed.arch ||
          !text(ref[3], /^[^\s/]+$/) || [".", ".."].includes(ref[3]) ||
          !digest(deployed.deployedCommit) || !digest(deployed.metadataSha256) ||
          typeof deployed.sourceStampMatched !== "boolean" ||
          (deployed.sourceStampMatched && (claims.appId !== deployed.appId || claims.revision !== deployed.deployedCommit))) {
        throw new Error("invalid observed installer deployment");
      }
      result.deployment = { appId: deployed.appId, ref: deployed.ref, arch: deployed.arch,
        deployedCommit: deployed.deployedCommit, metadataSha256: deployed.metadataSha256,
        sourceStampMatched: deployed.sourceStampMatched };
      helperPath = `var/lib/flatpak/app/${deployed.appId}/${deployed.arch}/${ref[3]}/${deployed.deployedCommit.slice(7)}/files/bin/fisherman`;
    }
    if (value.helper !== undefined) {
      if (!helperPath) throw new Error("invalid observed installer helper without deployment");
      result.helper = fileObservation(value.helper, helperPath);
    }
    if (value.shippedRecipe !== undefined) {
      result.shippedRecipe = fileObservation(value.shippedRecipe, "etc/bootc-installer/recipe.json");
    }
    if (value.missingReason !== undefined) {
      if (!["invalid-source-stamp", "deployment-missing", "ambiguous-deployment",
        "deployment-metadata-missing", "source-stamp-deployment-mismatch"].includes(value.missingReason)) {
        throw new Error("invalid observed installer missing reason");
      }
      result.missingReason = value.missingReason;
    }
    return result;
  }
  function engineObservation(value) {
    if (!record(value) || value.module !== "github.com/tuna-os/tacklebox" ||
        !["github.com/tuna-os/tacklebox/cmd/tbwasm", "github.com/tuna-os/tacklebox/cmd/purebuild"].includes(value.package) ||
        !text(value.goVersion) ||
        (value.vcsRevision !== undefined && !text(value.vcsRevision, /^[0-9a-f]{40}$/)) ||
        (value.vcsModified !== undefined && !["true", "false"].includes(value.vcsModified))) {
      throw new Error("invalid observed engine build info");
    }
    return { module: value.module, package: value.package, goVersion: value.goVersion,
      ...(value.vcsRevision !== undefined ? { vcsRevision: value.vcsRevision } : {}),
      ...(value.vcsModified !== undefined ? { vcsModified: value.vcsModified } : {}) };
  }
  function validateBuildResult(value, writtenBytes) {
    if (!Number.isSafeInteger(writtenBytes) || writtenBytes <= 0 || !record(value) ||
        !Number.isSafeInteger(value.bytesWritten) || value.bytesWritten !== writtenBytes) {
      throw new Error("invalid observed build byte count");
    }
    const inputs = value.observedInputs;
    const source = inputs?.source;
    const config = source?.config;
    const descriptor = config?.descriptor;
    const overlay = inputs?.overlay;
    if (!record(inputs) || inputs.schemaVersion !== 1 || !record(source) || !digest(source.manifestDigest) ||
        (source.indexDigest !== undefined && !digest(source.indexDigest)) ||
        !record(config) || typeof config.bytesVerified !== "boolean" || !record(descriptor) ||
        !digest(descriptor.digest) || !Number.isSafeInteger(descriptor.size) || descriptor.size < 0 ||
        typeof descriptor.mediaType !== "string" || !descriptor.mediaType.trim()) {
      throw new Error("invalid observed source inputs");
    }
    let content;
    if (config.content !== undefined) {
      if (!config.bytesVerified || !record(config.content)) throw new Error("invalid observed config content");
      content = {};
      for (const field of ["os", "architecture", "variant"]) {
        if (config.content[field] !== undefined) {
          if (!text(config.content[field], /^[^\s]+$/)) throw new Error("invalid observed config content");
          content[field] = config.content[field];
        }
      }
    }
    for (const field of ["registryEndpoint", "repository", "requestedReference"]) {
      if (source[field] !== undefined &&
          (typeof source[field] !== "string" || !source[field] || /[\s\x00-\x1f\x7f]/.test(source[field]))) {
        throw new Error("invalid observed source coordinates");
      }
    }
    if (source.registryEndpoint !== undefined) {
      let endpoint;
      try { endpoint = new URL(source.registryEndpoint); } catch (_) {
        throw new Error("invalid observed registry endpoint");
      }
      if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password ||
          /[?#]/.test(source.registryEndpoint)) throw new Error("invalid observed registry endpoint");
    }
    if (source.platformDescriptor !== undefined && source.indexDigest === undefined) {
      throw new Error("observed platform descriptor requires an index digest");
    }
    if (!record(overlay) || !["custom-image", "absent", "applied"].includes(overlay.status) ||
        typeof overlay.layersApplied !== "boolean" || typeof overlay.baseAnnotationMatched !== "boolean" ||
        (overlay.status === "applied"
          ? !overlay.layersApplied || !digest(overlay.manifestDigest)
          : overlay.layersApplied || overlay.baseAnnotationMatched || overlay.manifestDigest !== undefined)) {
      throw new Error("invalid observed overlay inputs");
    }
    if (overlay.baseDigest !== undefined && (overlay.status !== "applied" || !digest(overlay.baseDigest))) {
      throw new Error("invalid observed overlay base digest");
    }
    const installer = inputs.installer !== undefined ? installerObservation(inputs.installer) : undefined;
    const engine = inputs.engine !== undefined ? engineObservation(inputs.engine) : undefined;
    // Copy only fields in the observed contract. Unknown claims (qualified,
    // producer, requested platform, etc.) cannot hitch a ride in diagnostics.
    return {
      bytesWritten: value.bytesWritten,
      observedInputs: {
        schemaVersion: 1,
        source: {
          manifestDigest: source.manifestDigest,
          ...(source.registryEndpoint !== undefined ? { registryEndpoint: source.registryEndpoint } : {}),
          ...(source.repository !== undefined ? { repository: source.repository } : {}),
          ...(source.requestedReference !== undefined ? { requestedReference: source.requestedReference } : {}),
          ...(source.indexDigest !== undefined ? { indexDigest: source.indexDigest } : {}),
          ...(source.platformDescriptor !== undefined ? { platformDescriptor: platform(source.platformDescriptor) } : {}),
          config: {
            descriptor: {
              digest: descriptor.digest, size: descriptor.size, mediaType: descriptor.mediaType,
              ...(descriptor.platform !== undefined ? { platform: platform(descriptor.platform) } : {}),
            },
            bytesVerified: config.bytesVerified,
            ...(content !== undefined ? { content } : {}),
          },
        },
        overlay: {
          status: overlay.status,
          ...(overlay.manifestDigest !== undefined ? { manifestDigest: overlay.manifestDigest } : {}),
          ...(overlay.baseDigest !== undefined ? { baseDigest: overlay.baseDigest } : {}),
          layersApplied: overlay.layersApplied, baseAnnotationMatched: overlay.baseAnnotationMatched,
        },
        ...(installer !== undefined ? { installer } : {}),
        ...(engine !== undefined ? { engine } : {}),
      },
    };
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { validateBuildResult };
  else root.tboxValidateBuildResult = validateBuildResult;
})(globalThis);
