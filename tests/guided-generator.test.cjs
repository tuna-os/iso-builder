'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const G = require('../app/public/guided-catalog.js');
const realSnapshot = require('../app/public/catalog-snapshot.json');
const bluefin = require('./fixtures/guided-bluefin.json');
const generator = path.resolve(__dirname, '../scripts/generate-guided-catalog.cjs');
const copy = value => JSON.parse(JSON.stringify(value));

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guided-generator-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const targets = ['yellowfin:gnome-hwe:linux/amd64/v2', 'yellowfin:kde-nvidia:linux/amd64', 'yellowfin:gnome:linux/amd64/v2'].map(key => {
    const entry = realSnapshot.targets.find(target => target.targetKey === key);
    assert.ok(entry, `snapshot fixture exists: ${key}`);
    return copy(entry);
  });
  const snapshot = { ...copy(realSnapshot), targets };
  const metadata = {
    schema_version: 1, kind: 'builder-flavor-metadata',
    flavors: [
      { id: 'gnome', desktop: 'gnome', edition: 'standard' },
      { id: 'gnome-hwe', desktop: 'gnome', edition: 'hwe' },
      { id: 'kde-nvidia', desktop: 'kde', edition: 'nvidia' },
    ],
  };
  const snapshotPath = path.join(directory, 'snapshot.json');
  const metadataPath = path.join(directory, 'metadata.json');
  const output = path.join(directory, 'output');
  fs.mkdirSync(output);
  function save() {
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2) + '\n');
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2) + '\n');
  }
  save();
  return {
    directory, snapshot, metadata, snapshotPath, metadataPath, output, save,
    run(...extra) {
      return spawnSync(process.execPath, [generator, '--snapshot', snapshotPath, '--metadata', metadataPath, '--output-dir', output, ...extra], { encoding: 'utf8', timeout: 15000 });
    },
    read(name) { return fs.readFileSync(path.join(output, name), 'utf8'); },
  };
}
function success(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
function failure(result) {
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0, 'invalid input must fail before publishing generated artifacts');
}

function previewFixture(t) {
  const f = fixture(t);
  const catalog = copy(bluefin);
  const joined = G.validate(catalog, null, { previewOnly: true });
  const facetIds = ['family', 'desktop', 'channel', 'platform', 'graphics'];
  const config = {
    schema_version: 2, preview_only: true,
    brand: {
      name: 'Bluefin preview', homepage_url: 'https://projectbluefin.io/',
      documentation_url: 'https://docs.projectbluefin.io/', disclaimer: 'Unofficial preview only.',
    },
    presentation: { headline: 'Preview a documented image', intro: 'Select a documented preset.', accent_color: '#4285f4' },
    output: { volume_label: 'BLUEFIN_DEMO', filename_prefix: 'bluefin-demo' },
    desktops: [{ id: 'gnome', default_flatpaks: [] }],
    selection: {
      paths: [{ id: 'family-first', label: 'Start with a family', facets: facetIds }],
      default_path: 'family-first',
      facets: facetIds.map(id => ({
        id, label: id, values: [...new Set(joined.leaves.flatMap(leaf => leaf.facets[id]))].map(value => ({ id: value, label: value })),
      })),
      recommendations: [],
    },
    default_selection: { kind: 'leaf', leaf_id: catalog.leaves[0].id },
    curated_app_sets: [],
  };
  const catalogPath = path.join(f.directory, 'preview-catalog.json');
  const configPath = path.join(f.directory, 'preview-config.json');
  function savePreview() {
    fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + '\n');
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  }
  savePreview();
  return {
    ...f, catalog, config, catalogPath, configPath, savePreview,
    runPreview(extra = [], includeConfig = true) {
      const args = [generator, '--catalog-input', catalogPath];
      if (includeConfig) args.push('--config', configPath);
      args.push('--output-dir', f.output, ...extra);
      return spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 15000 });
    },
  };
}

test('generator deterministically joins exact snapshot identities and source flavor metadata', t => {
  const f = fixture(t);
  const snapshotBefore = fs.readFileSync(f.snapshotPath, 'utf8');
  const metadataBefore = fs.readFileSync(f.metadataPath, 'utf8');
  success(f.run());
  const firstJson = f.read('guided-catalog.json');
  const firstJs = f.read('guided-catalog-data.js');
  const firstOmissions = f.read('guided-catalog-omissions.json');
  success(f.run());
  assert.equal(f.read('guided-catalog.json'), firstJson);
  assert.equal(f.read('guided-catalog-data.js'), firstJs);
  assert.equal(f.read('guided-catalog-omissions.json'), firstOmissions);
  assert.deepEqual(JSON.parse(firstOmissions), []);
  assert.equal(fs.readFileSync(f.snapshotPath, 'utf8'), snapshotBefore);
  assert.equal(fs.readFileSync(f.metadataPath, 'utf8'), metadataBefore);

  const catalog = JSON.parse(firstJson);
  assert.equal(catalog.snapshotDigest, f.snapshot.snapshotDigest);
  assert.equal(catalog.generatedAt, f.snapshot.generatedAt);
  assert.equal(catalog.schemaVersion, 1);
  assert.equal(catalog.kind, 'guided-image-catalog');
  assert.deepEqual(catalog.leaves.map(leaf => leaf.id), f.snapshot.targets.map(entry => entry.targetKey));
  for (const leaf of catalog.leaves) {
    const entry = f.snapshot.targets.find(item => item.targetKey === leaf.id);
    const metadata = f.metadata.flavors.find(item => item.id === entry.target.flavor);
    assert.deepEqual(leaf.source, { kind: 'target', targetKey: entry.targetKey });
    assert.deepEqual(leaf.facets, {
      base: [entry.target.variant], desktop: [metadata.desktop], hardware: [entry.target.hardwareScope],
      platform: [entry.target.platform], edition: [metadata.edition],
    });
    assert.deepEqual(leaf.notices, []);
    assert.equal('availability' in leaf, false);
    assert.equal('qualification' in leaf, false);
    assert.equal('ref' in leaf.source, false);
  }
  const context = {};
  vm.runInNewContext(firstJs, context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.TBOX_GUIDED_CATALOG)), catalog);
  const mapping = Object.fromEntries(f.metadata.flavors.map(({ id, desktop, edition }) => [id, { desktop, edition }]));
  assert.deepEqual(JSON.parse(JSON.stringify(context.TBOX_FLAVOR_METADATA)), mapping);
  const joined = G.validate(catalog, f.snapshot, { flavorMetadata: mapping, isOffered: () => true });
  assert.equal(joined.leaves.length, 3);
  assert.deepEqual(joined.leaves.map(leaf => leaf.entry), f.snapshot.targets);
});

test('generator --check succeeds on exact bytes and does not modify inputs or outputs', t => {
  const f = fixture(t);
  success(f.run());
  const names = ['guided-catalog.json', 'guided-catalog-data.js', 'guided-catalog-omissions.json'];
  const before = names.map(name => f.read(name));
  const inputBefore = [f.snapshotPath, f.metadataPath].map(file => fs.readFileSync(file, 'utf8'));
  success(f.run('--check'));
  assert.deepEqual(names.map(name => f.read(name)), before);
  assert.deepEqual([f.snapshotPath, f.metadataPath].map(file => fs.readFileSync(file, 'utf8')), inputBefore);
});

for (const name of ['guided-catalog.json', 'guided-catalog-data.js', 'guided-catalog-omissions.json']) {
  test(`generator --check rejects ${name} byte drift without silently repairing it`, t => {
    const f = fixture(t);
    success(f.run());
    const changed = f.read(name) + '\n';
    fs.writeFileSync(path.join(f.output, name), changed);
    const result = f.run('--check');
    failure(result);
    assert.match(result.stderr, /drifted/);
    assert.equal(f.read(name), changed);
  });
}

test('generator validates source facets without inferring flavor spelling', t => {
  const f = fixture(t);
  f.snapshot.targets[0].target.flavor = 'opaque-custom-flavor';
  f.metadata.flavors = [
    ...f.metadata.flavors.filter(item => item.id !== 'gnome-hwe'),
    { id: 'opaque-custom-flavor', desktop: 'kde', edition: 'asahi' },
  ];
  f.save();
  success(f.run());
  const catalog = JSON.parse(f.read('guided-catalog.json'));
  assert.deepEqual(catalog.leaves[0].facets.desktop, ['kde']);
  assert.deepEqual(catalog.leaves[0].facets.edition, ['asahi']);
  assert.deepEqual(catalog.leaves[0].facets.hardware, ['generic'], 'hardware always comes from snapshot target, not edition spelling');
});

test('generator rejects duplicate, malformed or unknown-key flavor metadata before writing outputs', t => {
  const f = fixture(t);
  const baseline = copy(f.metadata);
  const changes = [
    metadata => { metadata.schema_version = 2; },
    metadata => { metadata.kind = 'other'; },
    metadata => { metadata.qualification = 'qualified'; },
    metadata => { metadata.flavors.push(copy(metadata.flavors[0])); },
    metadata => { metadata.flavors[0].qualification = 'qualified'; },
    metadata => { metadata.flavors[0].desktop = '<script>'; },
    metadata => { metadata.flavors[0].edition = 'x'.repeat(65); },
    metadata => { metadata.flavors.push({ id: 'unused-flavor', desktop: 'INVALID', edition: 'standard' }); },
    metadata => { metadata.flavors.push({ id: 'invalid/flavor', desktop: 'gnome', edition: 'standard' }); },
  ];
  for (const change of changes) {
    Object.keys(f.metadata).forEach(key => { delete f.metadata[key]; });
    Object.assign(f.metadata, copy(baseline));
    change(f.metadata);
    f.save();
    failure(f.run());
    assert.deepEqual(fs.readdirSync(f.output), [], 'a rejected generation must not leave partial output');
  }
});

test('generator refuses duplicate targets or malformed derived platform evidence', t => {
  const f = fixture(t);
  f.snapshot.targets.push(copy(f.snapshot.targets[0]));
  f.save();
  failure(f.run());
  assert.deepEqual(fs.readdirSync(f.output), []);
  f.snapshot.targets.pop();
  f.snapshot.targets[0].target.platform = 'linux/riscv64';
  f.save();
  failure(f.run());
  assert.deepEqual(fs.readdirSync(f.output), []);
});

test('generator reports only explicitly unavailable unmapped targets in deterministic targetKey order', t => {
  const f = fixture(t);
  // Unavailable records of a flavor the pinned metadata does not know.
  const unmapped = ['linux/arm64', 'linux/amd64'].map(platform => {
    const entry = copy(realSnapshot.targets.find(target => target.targetKey === 'marlin:gnome:linux/amd64'));
    entry.target = { ...entry.target, flavor: 'roost', platform };
    entry.targetKey = `marlin:roost:${platform}`;
    entry.availability.available = false;
    return entry;
  });
  f.snapshot.targets.push(...unmapped);
  f.save();
  const before = fs.readFileSync(f.snapshotPath, 'utf8');
  success(f.run());
  const catalog = JSON.parse(f.read('guided-catalog.json'));
  assert.equal(catalog.leaves.length, 3);
  assert.ok(catalog.leaves.every(leaf => !leaf.id.includes(':roost:')));
  const omissions = JSON.parse(f.read('guided-catalog-omissions.json'));
  assert.deepEqual(omissions.map(item => item.targetKey), ['marlin:roost:linux/amd64', 'marlin:roost:linux/arm64']);
  assert.ok(omissions.every(item => typeof item.reason === 'string' && item.reason.includes('unavailable')));
  assert.ok(omissions.every(item => Object.keys(item).sort().join(',') === 'reason,targetKey'));
  assert.equal(fs.readFileSync(f.snapshotPath, 'utf8'), before);
  const reportBefore = f.read('guided-catalog-omissions.json');
  success(f.run());
  assert.equal(f.read('guided-catalog-omissions.json'), reportBefore);
});

test('generator fails rather than omit unmapped available or unknown-availability targets', t => {
  const f = fixture(t);
  f.snapshot.targets[0].target.flavor = 'unmapped-flavor';
  for (const availability of [true, undefined, null, 'false', 0]) {
    if (availability === undefined) delete f.snapshot.targets[0].availability.available;
    else f.snapshot.targets[0].availability.available = availability;
    f.save();
    failure(f.run());
    assert.deepEqual(fs.readdirSync(f.output), []);
  }
});

test('current stock snapshot generates one exact leaf per target and no omissions', t => {
  const f = fixture(t);
  const snapshotPath = path.resolve(__dirname, '../app/public/catalog-snapshot.json');
  const metadataPath = path.resolve(__dirname, '../app/public/builder-flavors.json');
  const before = fs.readFileSync(snapshotPath, 'utf8');
  const result = spawnSync(process.execPath, [generator, '--snapshot', snapshotPath, '--metadata', metadataPath, '--output-dir', f.output], { encoding: 'utf8', timeout: 15000 });
  success(result);
  assert.equal(JSON.parse(f.read('guided-catalog.json')).leaves.length, realSnapshot.targets.length);
  assert.deepEqual(JSON.parse(f.read('guided-catalog-omissions.json')), []);
  assert.equal(fs.readFileSync(snapshotPath, 'utf8'), before);
});

test('preview staging preserves all three documented Bluefin leaves, exact JSON and generated JS, with no flavor metadata', t => {
  const f = previewFixture(t);
  const inputBefore = fs.readFileSync(f.catalogPath, 'utf8');
  const configBefore = fs.readFileSync(f.configPath, 'utf8');
  success(f.runPreview());
  assert.equal(f.read('guided-catalog.json'), inputBefore);
  const catalog = JSON.parse(f.read('guided-catalog.json'));
  assert.equal(catalog.leaves.length, 3);
  assert.equal(catalog.snapshotDigest, null);
  assert.ok(catalog.leaves.every(leaf => leaf.source.kind === 'preview'));
  assert.equal(catalog.leaves.find(leaf => leaf.facets.family.includes('utah')).source.ref, 'ghcr.io/projectbluefin/utah:testing');
  const context = {};
  vm.runInNewContext(f.read('guided-catalog-data.js'), context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.TBOX_GUIDED_CATALOG)), catalog);
  assert.deepEqual(JSON.parse(JSON.stringify(context.TBOX_FLAVOR_METADATA)), {});
  assert.deepEqual(JSON.parse(f.read('guided-catalog-omissions.json')), []);
  const outputBefore = ['guided-catalog.json', 'guided-catalog-data.js', 'guided-catalog-omissions.json'].map(name => f.read(name));
  success(f.runPreview());
  success(f.runPreview(['--check']));
  assert.deepEqual(['guided-catalog.json', 'guided-catalog-data.js', 'guided-catalog-omissions.json'].map(name => f.read(name)), outputBefore);
  assert.equal(fs.readFileSync(f.catalogPath, 'utf8'), inputBefore);
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), configBefore);
});

test('preview staging requires an explicit valid v2 preview_only config before writing any output', t => {
  const f = previewFixture(t);
  const missing = f.runPreview([], false);
  failure(missing);
  assert.match(missing.stderr, /--config is required/);
  assert.deepEqual(fs.readdirSync(f.output), []);
  const baseline = copy(f.config);
  for (const mutate of [
    config => { config.preview_only = false; },
    config => { config.preview_only = 'true'; },
    config => { delete config.preview_only; },
    config => { config.qualification = 'qualified'; },
    config => {
      config.schema_version = 1;
      delete config.selection;
      config.desktops = [{ id: 'gnome', name: 'GNOME', description: 'Preview desktop', default_flatpaks: [] }];
      config.variants = [];
      config.default_selection = { kind: 'image', image: bluefin.leaves[0].source.ref, platform: 'linux/amd64' };
    },
  ]) {
    Object.keys(f.config).forEach(key => { delete f.config[key]; });
    Object.assign(f.config, copy(baseline));
    mutate(f.config);
    f.savePreview();
    failure(f.runPreview());
    assert.deepEqual(fs.readdirSync(f.output), []);
  }
});

test('preview staging rejects target leaves even in an otherwise valid preview-only deployment', t => {
  const f = previewFixture(t);
  const target = {
    id: 'yellowfin:gnome:linux/amd64/v2', source: { kind: 'target', targetKey: 'yellowfin:gnome:linux/amd64/v2' },
    facets: {}, notices: [],
  };
  for (const leaves of [[...copy(bluefin.leaves), copy(target)], [copy(target)]]) {
    f.catalog.leaves = leaves;
    f.savePreview();
    const result = f.runPreview();
    failure(result);
    assert.match(result.stderr, /preview leaves only/);
    assert.deepEqual(fs.readdirSync(f.output), []);
  }
});

test('preview staging preserves documentation and execution-evidence validation instead of trusting imported JSON', t => {
  const f = previewFixture(t);
  const baseline = copy(f.catalog);
  for (const mutate of [
    catalog => { catalog.leaves[0].source.qualification = 'qualified'; },
    catalog => { catalog.leaves[0].source.evidence = catalog.leaves[0].source.evidence.filter(item => !item.claims.includes('platform')); },
    catalog => { catalog.leaves[0].source.platform = 'linux/riscv64'; },
    catalog => { catalog.snapshotDigest = realSnapshot.snapshotDigest; },
    catalog => { catalog.leaves = []; },
  ]) {
    Object.keys(f.catalog).forEach(key => { delete f.catalog[key]; });
    Object.assign(f.catalog, copy(baseline));
    mutate(f.catalog);
    f.savePreview();
    failure(f.runPreview());
    assert.deepEqual(fs.readdirSync(f.output), []);
  }
});

for (const name of ['guided-catalog.json', 'guided-catalog-data.js', 'guided-catalog-omissions.json']) {
  test(`preview staging --check rejects ${name} drift without rewriting preview assets`, t => {
    const f = previewFixture(t);
    success(f.runPreview());
    const changed = f.read(name) + '\n';
    fs.writeFileSync(path.join(f.output, name), changed);
    const result = f.runPreview(['--check']);
    failure(result);
    assert.match(result.stderr, /drifted/);
    assert.equal(f.read(name), changed);
  });
}
