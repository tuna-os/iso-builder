// Run the same web fixture as the native Go parity test without a GUI toolchain.
// The Go test still owns comparison with the actual native catalog loader.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');

test('native catalog harness loads the current web runtime dependencies', () => {
  const source = fs.readFileSync(path.join(root, 'native/catalog_variants_test.go'), 'utf8');
  const modules = source.match(/for _, file := range \[\]string\{([^}]+)\}/);
  const fixture = source.match(/script := `([\s\S]*?)\n`/);
  assert.ok(modules, 'native runtime dependency list must remain discoverable');
  assert.ok(fixture, 'native web fixture must remain discoverable');
  const names = [...modules[1].matchAll(/"([^"]+)"/g)].map(match => match[1]);
  const input = [...names, 'app.js'].map(name => fs.readFileSync(path.join(root, 'app/public', name), 'utf8')).join('\n');
  const result = spawnSync(process.execPath, ['-e', fixture[1]], {
    cwd: path.join(root, 'native'), input, encoding: 'utf8', timeout: 15000, maxBuffer: 5 * 1024 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  const snapshot = JSON.parse(fs.readFileSync(path.join(root, 'app/public/catalog-snapshot.json'), 'utf8'));
  assert.equal(actual.snapshotDigest, snapshot.snapshotDigest);
  assert.equal(actual.coverageDigest, snapshot.coverageDigest);
  assert.equal(actual.targetCount, snapshot.targets.length);
  assert.ok(actual.variants.length > 0);
  for (const variant of actual.variants) {
    assert.ok(variant.desktops.length > 0, variant.id);
    for (const desktop of variant.desktops) assert.ok(Array.isArray(variant.platforms[desktop]), `${variant.id}:${desktop}`);
  }
});
