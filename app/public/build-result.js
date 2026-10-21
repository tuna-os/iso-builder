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
  function sourceRequest(source) {
    const keys = ["registryEndpoint", "repository", "requestedReference"];
    if (keys.every(key => source[key] === undefined)) return {};
    if (keys.some(key => typeof source[key] !== "string" || !source[key] || source[key].length > 2048)) {
      throw new Error("incomplete observed source request");
    }
    let endpoint;
    try { endpoint = new URL(source.registryEndpoint); } catch { throw new Error("invalid observed source endpoint"); }
    if (!/^https?:\/\//.test(source.registryEndpoint) || endpoint.href.replace(/\/$/, "") !== source.registryEndpoint ||
        !/^(?:\/[A-Za-z0-9._~-]+)*$/.test(endpoint.pathname === "/" ? "" : endpoint.pathname) ||
        !["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
        source.registryEndpoint.endsWith("/") || /[?#]/.test(source.registryEndpoint) || /\/\.{1,2}(?:\/|$)/.test(source.registryEndpoint) || /[%\\\s]/.test(source.registryEndpoint) ||
        endpoint.pathname.split("/").some(part => part === "." || part === "..") ||
        source.repository.length > 255 || !/^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/.test(source.repository) ||
        !/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|sha256:[0-9a-f]{64})$/.test(source.requestedReference)) {
      throw new Error("invalid observed source request");
    }
    return Object.fromEntries(keys.map(key => [key, source[key]]));
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
    // Copy only fields in the observed contract. Unknown claims (qualified,
    // producer, requested platform, etc.) cannot hitch a ride in diagnostics.
    return {
      bytesWritten: value.bytesWritten,
      observedInputs: {
        schemaVersion: 1,
        source: {
          ...sourceRequest(source),
          manifestDigest: source.manifestDigest,
          ...(source.indexDigest !== undefined ? { indexDigest: source.indexDigest } : {}),
          ...(source.platformDescriptor !== undefined ? { platformDescriptor: platform(source.platformDescriptor) } : {}),
          config: {
            descriptor: {
              digest: descriptor.digest, size: descriptor.size, mediaType: descriptor.mediaType,
              ...(descriptor.platform !== undefined ? { platform: platform(descriptor.platform) } : {}),
            },
            bytesVerified: config.bytesVerified,
          },
        },
        overlay: {
          status: overlay.status,
          ...(overlay.manifestDigest !== undefined ? { manifestDigest: overlay.manifestDigest } : {}),
          layersApplied: overlay.layersApplied, baseAnnotationMatched: overlay.baseAnnotationMatched,
        },
      },
    };
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { validateBuildResult };
  else root.tboxValidateBuildResult = validateBuildResult;
})(globalThis);
