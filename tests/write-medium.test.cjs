const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installerForEntry, mediumFileName, validateInstallerResult, writeInstallerImage } = require('../app/public/write-medium.js');

const D = (c) => `sha256:${c.repeat(64)}`;
const pin = () => ({
  ref: 'ghcr.io/tuna-os/flounder-installer:stable',
  manifestDigest: D('a'), sha256: D('b'), sizeBytes: 8,
  receiptDigest: D('c'), cosignIdentity: 'https://github.com/tuna-os/tunaOS/.github/workflows/ci.yml@refs/heads/main',
});

test('entries without an installer pin report null; malformed pins report null', () => {
  assert.equal(installerForEntry({}), null);
  assert.equal(installerForEntry({ installer: null }), null);
  assert.equal(installerForEntry({ installer: { ...pin(), sizeBytes: -1 } }), null);
  assert.equal(installerForEntry({ installer: { ...pin(), sha256: 'nope' } }), null);
  assert.equal(installerForEntry({ installer: { ...pin(), cosignIdentity: '  ' } }), null);
});

test('a well-formed pin is accepted and frozen', () => {
  const got = installerForEntry({ installer: pin() });
  assert.equal(got.ref, pin().ref);
  assert.equal(got.sizeBytes, 8);
  assert.ok(Object.isFrozen(got));
});

test('file names stem from the installer reference', () => {
  assert.equal(mediumFileName(pin()), 'flounder-stable-installer.iso');
  assert.equal(mediumFileName({ ref: 'ghcr.io/tuna-os/flounder-installer@sha256:' + 'd'.repeat(64) }), 'flounder-installer.iso');
});

test('result validation refuses size and digest drift', () => {
  const ok = { bytesWritten: 8, sha256: D('b'), manifestDigest: D('a') };
  assert.deepEqual(validateInstallerResult(pin(), ok, 8).rawSha256, D('b'));
  assert.throws(() => validateInstallerResult(pin(), { ...ok, sha256: D('e') }, 8), /digest mismatch/);
  assert.throws(() => validateInstallerResult(pin(), { ...ok, bytesWritten: 7 }, 7), /size mismatch/);
  assert.throws(() => validateInstallerResult(pin(), { ...ok, manifestDigest: D('e') }, 8), /manifest digest mismatch/);
  assert.throws(() => validateInstallerResult(pin(), null, 0), /no result/);
});

test('writeInstallerImage streams in order and records the receipt', async () => {
  const seen = [];
  const impl = async ({ ref, manifestDigest, expectedSha256, sizeBytes }, write, onProgress) => {
    assert.equal(ref, pin().ref);
    assert.equal(manifestDigest, pin().manifestDigest);
    assert.equal(expectedSha256, pin().sha256);
    assert.equal(sizeBytes, 8);
    await write(new Uint8Array([1, 2, 3]));
    await write(new Uint8Array([4, 5, 6, 7, 8]));
    onProgress && onProgress('fetch', 1, 2);
    return { bytesWritten: 8, sha256: D('b'), manifestDigest: D('a') };
  };
  const progress = [];
  const receipt = await writeInstallerImage({
    installer: pin(),
    write: async (u8) => { seen.push(...u8); },
    onProgress: (p) => { progress.push(p); },
    impl,
  });
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(receipt, { installerDigest: D('a'), rawSha256: D('b'), bytesWritten: 8 });
  assert.deepEqual(progress, [{ stage: 'fetch', done: 1, total: 2 }]);
});

test('writeInstallerImage fails without an engine export', async () => {
  const saved = globalThis.tboxWriteMedium;
  delete globalThis.tboxWriteMedium;
  try {
    await assert.rejects(() => writeInstallerImage({ installer: pin(), write: async () => {} }), /no write-medium support/);
  } finally {
    if (saved !== undefined) globalThis.tboxWriteMedium = saved;
  }
});
