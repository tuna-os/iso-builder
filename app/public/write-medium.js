/* Installer medium writer: fetch, verify and save the prepared image.
 *
 * CI builds the installer medium once and publishes it as an OCI image on
 * ghcr.io (tuna-os/tunaOS#4905, ADR 0018). The browser builds nothing: it
 * streams the image's chunks through the relay into a file the user picks.
 * The file holds the same bytes as the raw medium, so it boots as an ISO
 * and also works with `dd`.
 *
 * The engine export this module calls is written by another session
 * (tacklebox feat/write-medium-wasm, stacked on tuna-os/tacklebox#512).
 * Until it lands, tests inject a mock with the same signature:
 *
 *   result = await writeMedium(
 *     { ref, manifestDigest, expectedSha256, sizeBytes },
 *     async (u8) => { ... },              // raw medium bytes, in disk order
 *     ({ stage, done, total }) => { ... }, // optional progress; may be omitted
 *   );
 *   // result: { bytesWritten, sha256: "sha256:…", manifestDigest }
 *
 * The chunk contract (media types, chunk table, verification order) is
 * tacklebox docs/write-medium.md, "Image contract (v1)". Memory use is
 * constant: chunks stream to the sink, and the engine holds one buffer.
 * A stream needs only the file size: no 4 GiB engine memory hold, no layer
 * cache, no second copy for spooling.
 */
(function (root) {
  'use strict';

  const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
  const OCI_REF_RE = /^[a-z0-9.-]+(?::[0-9]{1,5})?\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|@sha256:[0-9a-f]{64})$/;

  function fail(message) { throw new Error(`Installer medium: ${message}`); }

  // The catalog pins one installer image per cell (tuna-os/tunaOS#4910
  // publishes it by digest after the strict harness passes). Anything
  // missing or malformed means "no installer medium for this cell", never a
  // guessed reference.
  function installerForEntry(entry) {
    const installer = entry && entry.installer;
    if (installer === undefined || installer === null) return null;
    if (typeof installer !== 'object' || Array.isArray(installer)) return null;
    const { ref, manifestDigest, sha256, sizeBytes, receiptDigest, cosignIdentity } = installer;
    if (typeof ref !== 'string' || !OCI_REF_RE.test(ref)) return null;
    if (typeof manifestDigest !== 'string' || !DIGEST_RE.test(manifestDigest)) return null;
    if (typeof sha256 !== 'string' || !DIGEST_RE.test(sha256)) return null;
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) return null;
    if (typeof receiptDigest !== 'string' || !DIGEST_RE.test(receiptDigest)) return null;
    if (typeof cosignIdentity !== 'string' || !cosignIdentity.trim()) return null;
    return Object.freeze({ ref, manifestDigest, sha256, sizeBytes, receiptDigest, cosignIdentity: cosignIdentity.trim() });
  }
  function shortDigest(digest) {
    return typeof digest === 'string' && DIGEST_RE.test(digest) ? `${digest.slice(0, 12)}…` : 'unknown';
  }
  function mediumFileName(installer) {
    const ref = typeof installer?.ref === 'string' ? installer.ref : installer;
    const m = /\/([^/:@]+?)(-installer)?(?::([^/@]+))?(@sha256:[0-9a-f]{64})?$/.exec(ref || '');
    if (!m) return 'tunaos-installer.iso';
    const stem = (m[1] || 'tunaos').replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^-+/, '') || 'tunaos';
    const tag = m[3] ? `-${m[3].replace(/[^A-Za-z0-9_.-]+/g, '_')}` : '';
    return `${stem}${tag}-installer.iso`;
  }

  // The engine's own checks (per-chunk digests, stream hash, read-back) stay
  // inside the engine. This validates the engine's receipt against the
  // catalog pin before the page records or delivers anything.
  function validateInstallerResult(installer, result, writtenBytes) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) fail('engine returned no result');
    const { bytesWritten, sha256, manifestDigest } = result;
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten !== writtenBytes) {
      fail(`invalid ISO byte count (engine said ${String(bytesWritten)}, sink took ${writtenBytes})`);
    }
    if (bytesWritten !== installer.sizeBytes) {
      fail(`size mismatch: wrote ${bytesWritten} bytes, the catalog pins ${installer.sizeBytes}`);
    }
    if (typeof sha256 !== 'string' || !DIGEST_RE.test(sha256)) fail('engine returned no raw image digest');
    if (sha256 !== installer.sha256) fail('installer image digest mismatch: these are not the bytes CI qualified');
    if (manifestDigest !== undefined && manifestDigest !== installer.manifestDigest) fail('manifest digest mismatch');
    // The receipt records the installer image digest and the raw sha256.
    return Object.freeze({ installerDigest: installer.manifestDigest, rawSha256: sha256, bytesWritten });
  }

  async function writeInstallerImage({ installer, write, onProgress, impl }) {
    if (!installer || typeof installer !== 'object') fail('no installer pin');
    if (typeof write !== 'function') fail('no byte sink');
    const run = impl || root.tboxWriteMedium;
    if (typeof run !== 'function') {
      fail('this engine build has no write-medium support (tboxWriteMedium missing): hard-refresh to load the current tbox.wasm');
    }
    let writtenBytes = 0;
    const countingWrite = async (u8) => {
      if (!(u8 instanceof Uint8Array)) fail('engine sent a non-byte chunk');
      writtenBytes += u8.byteLength;
      if (!Number.isSafeInteger(writtenBytes)) fail('byte count overflow');
      await write(u8);
    };
    const progress = typeof onProgress === 'function'
      ? (stage, done, total) => onProgress({ stage, done, total })
      : undefined;
    const result = await run(
      { ref: installer.ref, manifestDigest: installer.manifestDigest, expectedSha256: installer.sha256, sizeBytes: installer.sizeBytes },
      countingWrite,
      progress,
    );
    return validateInstallerResult(installer, result, writtenBytes);
  }

  const api = { installerForEntry, shortDigest, mediumFileName, validateInstallerResult, writeInstallerImage };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.TboxWriteMedium = api;
})(globalThis);
