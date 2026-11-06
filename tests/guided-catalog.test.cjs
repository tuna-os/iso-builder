'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const G = require('../app/public/guided-catalog.js');
const bluefin = require('./fixtures/guided-bluefin.json');
const bazzite = require('./fixtures/guided-bazzite.json');
const realSnapshot = require('../app/public/catalog-snapshot.json');
const copy = value => JSON.parse(JSON.stringify(value));
const digest = char => `sha256:${char.repeat(64)}`;
const NOW = '2026-10-20T16:55:00Z';
const flavorMetadata = {
  gnome: { desktop: 'gnome', edition: 'standard' },
  'gnome-hwe': { desktop: 'gnome', edition: 'hwe' },
  kde: { desktop: 'kde', edition: 'standard' },
  'kde-nvidia': { desktop: 'kde', edition: 'nvidia' },
};
const offered = { flavorMetadata, isOffered: () => true };

function targetData() {
  const keys = [
    'yellowfin:gnome:linux/amd64/v2',
    'yellowfin:kde:linux/amd64/v2',
    'yellowfin:gnome-hwe:linux/amd64/v2',
    'yellowfin:kde-nvidia:linux/amd64',
    'yellowfin:kde:linux/arm64',
    'albacore:gnome:linux/amd64/v2',
  ];
  const targets = keys.map(key => {
    const entry = realSnapshot.targets.find(target => target.targetKey === key);
    assert.ok(entry, `real target fixture exists: ${key}`);
    return copy(entry);
  });
  // Admission tests need one scheduled target the registry did not publish.
  targets.find(entry => entry.targetKey === 'yellowfin:gnome-hwe:linux/amd64/v2').availability.available = false;
  const snapshot = { ...copy(realSnapshot), targets };
  const catalog = {
    schemaVersion: 1, kind: 'guided-image-catalog', catalogId: 'tunaos-test',
    generatedAt: NOW, snapshotDigest: snapshot.snapshotDigest,
    leaves: targets.map(entry => ({ id: entry.targetKey, source: { kind: 'target', targetKey: entry.targetKey }, facets: {}, notices: [] })),
  };
  return { catalog, snapshot };
}

function previewCatalog(rows) {
  return {
    schemaVersion: 1, kind: 'guided-image-catalog', catalogId: 'test-preview', generatedAt: NOW, snapshotDigest: null,
    leaves: rows.map((facets, index) => ({
      id: `test/image-${index}/stable/linux/amd64`,
      source: {
        kind: 'preview', ref: `ghcr.io/example/image-${index}:stable`, platform: 'linux/amd64',
        evidence: [{ url: 'https://example.org/images', checkedAt: NOW, claims: ['ref', 'platform', 'desktop', 'hardware', 'channel'] }],
      },
      facets: Object.fromEntries(Object.entries(facets).map(([key, value]) => [key, Array.isArray(value) ? value : [value]])), notices: [],
    })),
  };
}

function configuration(catalog, options = {}) {
  const facets = {};
  const joined = G.validate(catalog, options.snapshot, { ...offered, previewOnly: true });
  for (const leaf of joined.leaves) {
    for (const [key, values] of Object.entries(leaf.facets)) {
      facets[key] ||= new Set();
      values.forEach(value => facets[key].add(value));
    }
  }
  const keys = Object.keys(facets);
  return {
    schema_version: 2, preview_only: options.previewOnly ?? true,
    selection: {
      paths: [{ id: 'base-first', label: 'Start with a base', facets: keys }, { id: 'desktop-first', label: 'Start with a desktop', facets: [...keys].reverse() }],
      default_path: 'base-first',
      facets: keys.map(id => ({ id, label: id, values: [...facets[id]].map(value => ({ id: value, label: value })) })),
      recommendations: [],
    },
    default_selection: options.defaultId ? { kind: 'leaf', leaf_id: options.defaultId } : { kind: 'none' },
  };
}
function modelFor(catalog, options = {}) {
  return G.createModel(catalog, options.snapshot, options.config || configuration(catalog, options), offered);
}
function permutations(items) {
  return items.length ? items.flatMap((item, index) => permutations(items.filter((_, i) => i !== index)).map(rest => [item, ...rest])) : [[]];
}
function choose(model, state, facet, value) {
  const result = G.chooseFacet(model, state, facet, value);
  assert.equal(result.ok, true, result.reason);
  return result.state;
}

test('UMD exposes the same portable API without a browser DOM', () => {
  const context = { URL };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../app/public/guided-catalog.js'), 'utf8'), context);
  assert.equal(typeof context.TboxGuidedCatalog.validate, 'function');
  assert.deepEqual(Object.keys(context.TboxGuidedCatalog), Object.keys(G));
});

test('verified Bluefin fixtures preserve three distinct x86-64 identities and the experimental Utah channel', () => {
  const joined = G.validate(bluefin, null, { previewOnly: true });
  assert.equal(joined.leaves.length, 3);
  assert.deepEqual(joined.leaves.map(leaf => leaf.source.ref), ['ghcr.io/projectbluefin/dakota:stable', 'ghcr.io/ublue-os/bluefin:stable', 'ghcr.io/projectbluefin/utah:testing']);
  assert.deepEqual(joined.leaves.map(leaf => leaf.facets.family[0]), ['dakota', 'classic', 'utah']);
  assert.deepEqual(joined.leaves.map(leaf => leaf.facets.channel[0]), ['stable', 'stable', 'testing']);
  for (const leaf of joined.leaves) {
    assert.deepEqual(leaf.facets.platform, ['linux/amd64']);
    assert.deepEqual(leaf.facets.desktop, ['gnome']);
    assert.equal(leaf.entry, null);
    assert.equal(leaf.available, false);
    assert.equal(leaf.selectable, true);
    assert.equal('qualification' in leaf, false);
    assert.equal('targetKey' in leaf.source, false);
  }
  assert.equal(joined.leaves.some(leaf => leaf.source.platform === 'linux/arm64'), false);
  const utah = joined.leaves.find(leaf => leaf.facets.family.includes('utah'));
  assert.equal(utah.id, 'bluefin/utah/testing/linux/amd64');
  assert.ok(utah.notices.some(notice => notice.code === 'coming-soon' && /pre-alpha/.test(notice.text)));
  assert.ok(utah.source.evidence.some(evidence => evidence.claims.includes('platform') && evidence.url.includes('/.github/workflows/build.yml')));
  assert.ok(joined.leaves[0].notices.some(notice => notice.code === 'alpha'));
});

test('all ten Bazzite repository fixtures are literal, with no synthesized suffixes', () => {
  const joined = G.validate(bazzite, null, { previewOnly: true });
  const expected = [
    'bazzite', 'bazzite-gnome', 'bazzite-deck', 'bazzite-deck-gnome',
    'bazzite-deck-nvidia', 'bazzite-deck-nvidia-gnome', 'bazzite-nvidia',
    'bazzite-gnome-nvidia', 'bazzite-nvidia-open', 'bazzite-gnome-nvidia-open',
  ].map(repo => `ghcr.io/ublue-os/${repo}:stable`).sort();
  assert.deepEqual(joined.leaves.map(leaf => leaf.source.ref).sort(), expected);
  assert.ok(joined.leaves.every(leaf => leaf.source.platform === 'linux/amd64'));
  assert.ok(joined.leaves.every(leaf => leaf.facets.channel[0] === 'stable'));
  const gamingNvidia = joined.leaves.filter(leaf => leaf.source.ref.includes('deck-nvidia'));
  assert.equal(gamingNvidia.length, 2);
  assert.ok(gamingNvidia.every(leaf => leaf.notices.some(notice => notice.sourceUrl && /nvidia/i.test(notice.text))));
  const model = modelFor(bazzite);
  assert.equal(G.candidates(model, { hardware: 'handheld', graphics: 'nvidia' }).length, 0);
  assert.equal(G.candidates(model, { hardware: 'htpc', graphics_generation: 'legacy' }).length, 0);
});

test('reviewed Bazzite device, GPU and generation paths resolve exact leaves and only HTPC NVIDIA asks acknowledgement', () => {
  const model = modelFor(bazzite);
  assert.equal(model.leaves.length, 10);
  assert.equal(G.candidates(model, { hardware: 'desktop', graphics: 'nvidia' }).length, 4);
  assert.equal(G.candidates(model, { hardware: 'desktop', graphics: 'nvidia', graphics_generation: 'modern' }).length, 2);
  assert.equal(G.candidates(model, { hardware: 'desktop', graphics: 'nvidia', graphics_generation: 'legacy' }).length, 2);
  assert.equal(G.candidates(model, { hardware: 'htpc', graphics: 'nvidia' }).length, 2);
  assert.equal(G.candidates(model, { hardware: 'htpc', graphics: 'amd-intel' }).length, 2);
  assert.equal(G.candidates(model, { hardware: 'handheld', graphics: 'amd-intel' }).length, 2);
  assert.equal(G.candidates(model, { graphics: 'amd-intel', graphics_generation: 'modern' }).length, 0);
  const acknowledgement = model.leaves.filter(leaf => leaf.notices.some(notice => notice.requiresAcknowledgement === true));
  assert.deepEqual(acknowledgement.map(leaf => leaf.source.ref).sort(), ['ghcr.io/ublue-os/bazzite-deck-nvidia-gnome:stable', 'ghcr.io/ublue-os/bazzite-deck-nvidia:stable']);
  assert.ok(acknowledgement.every(leaf => leaf.facets.hardware.length === 1 && leaf.facets.hardware[0] === 'htpc'));
  for (const leaf of model.leaves) {
    const filters = Object.fromEntries(Object.entries(leaf.facets).map(([facet, values]) => [facet, values[0]]));
    assert.deepEqual(G.candidates(model, filters).map(candidate => candidate.id), [leaf.id]);
    assert.deepEqual(G.candidates(model, Object.fromEntries(Object.entries(filters).reverse())).map(candidate => candidate.id), [leaf.id]);
    assert.equal(leaf.entry, null);
  }
});

test('unknown keys fail closed at every preview wire object boundary', () => {
  for (const location of [
    catalog => catalog,
    catalog => catalog.leaves[0],
    catalog => catalog.leaves[0].source,
    catalog => catalog.leaves[0].source.evidence[0],
    catalog => catalog.leaves[0].facets,
    catalog => catalog.leaves[0].notices[0],
  ]) {
    const catalog = copy(bluefin);
    location(catalog).unexpected = true;
    assert.throws(() => G.validate(catalog, null, { previewOnly: true }), /unknown/);
  }
});

test('notice acknowledgement is a strict optional boolean, never qualification evidence', () => {
  const catalog = copy(bluefin);
  const baseline = G.validate(catalog, null, { previewOnly: true });
  assert.equal(baseline.leaves[0].notices[0].requiresAcknowledgement === true, false);
  for (const value of [true, false]) {
    catalog.leaves[0].notices[0].requiresAcknowledgement = value;
    const joined = G.validate(catalog, null, { previewOnly: true });
    assert.equal(joined.leaves[0].notices[0].requiresAcknowledgement, value);
    assert.equal(joined.leaves[0].entry, null);
    assert.equal(joined.leaves[0].available, false);
    assert.equal('qualification' in joined.leaves[0], false);
    assert.equal(joined.leaves[0].selectable, true, 'acknowledgement belongs to the UI review step, not qualification admission');
  }
  for (const value of ['false', 'true', 0, 1, null, {}, []]) {
    catalog.leaves[0].notices[0].requiresAcknowledgement = value;
    assert.throws(() => G.validate(catalog, null, { previewOnly: true }), /requiresAcknowledgement must be a boolean/);
  }
  catalog.leaves[0].notices[0].requiresAcknowledgement = false;
  catalog.leaves[0].notices[0].acknowledgementBypassesQualification = true;
  assert.throws(() => G.validate(catalog, null, { previewOnly: true }), /unknown/);
});

test('preview sources reject execution, availability, qualification and target fields', () => {
  for (const key of ['availability', 'qualification', 'qualified', 'targetKey', 'resolvedInputs', 'receiptDigest', 'executionOptions']) {
    const catalog = copy(bluefin);
    catalog.leaves[0].source[key] = true;
    assert.throws(() => G.validate(catalog, null, { previewOnly: true }), /unknown/);
  }
  assert.throws(() => G.validate(bluefin, null), /preview_only/);
  assert.throws(() => G.validate(bluefin, null, { previewOnly: false }), /preview_only/);
  assert.throws(() => G.createModel(bluefin, null, { ...configuration(bluefin), preview_only: false }), /preview_only/);
});

test('documentation must cover both ref and platform, with bounded verified syntax', () => {
  for (const claim of ['ref', 'platform']) {
    const catalog = copy(bluefin);
    catalog.leaves[0].source.evidence.forEach(item => { item.claims = item.claims.filter(value => value !== claim); });
    catalog.leaves[0].source.evidence = catalog.leaves[0].source.evidence.filter(item => item.claims.length);
    assert.throws(() => G.validate(catalog, null, { previewOnly: true }), /cover ref and platform/);
  }
  for (const change of [
    catalog => { catalog.generatedAt = '2026-02-30T00:00:00Z'; },
    catalog => { catalog.generatedAt = '2026-10-20T16:55:00+00:00'; },
    catalog => { catalog.leaves[0].source.evidence[0].checkedAt = 'not-a-date'; },
    catalog => { catalog.leaves[0].source.evidence[0].claims = ['qualified']; },
    catalog => { catalog.leaves[0].source.evidence[0].claims = ['ref', 'ref']; },
    catalog => { catalog.leaves[0].source.evidence[0].url = 'javascript:alert(1)'; },
    catalog => { catalog.leaves[0].source.evidence[0].url = 'https://user:pass@example.org/images'; },
    catalog => { catalog.leaves[0].source.evidence[0].url = 'https://example.org:8443/images'; },
    catalog => { catalog.leaves[0].source.evidence[0].url = 'https://example.org\\@evil.test'; },
    catalog => { catalog.leaves[0].notices[0].text = '<script>alert(1)</script>'; },
    catalog => { catalog.leaves[0].notices[0].text = 'plain\ntext'; },
    catalog => { catalog.leaves[0].notices[0].text = 'x'.repeat(2049); },
    catalog => { catalog.leaves[0].id = 'x'.repeat(193); },
    catalog => { catalog.leaves[0].facets.family = ['x'.repeat(65)]; },
  ]) {
    const catalog = copy(bluefin);
    change(catalog);
    assert.throws(() => G.validate(catalog, null, { previewOnly: true }), /Guided catalog:/);
  }
});

test('malformed, implicit and unsupported image identities fail closed', () => {
  for (const ref of ['bluefin:stable', 'ublue-os/bluefin:stable', 'https://ghcr.io/ublue-os/bluefin:stable', 'ghcr.io/a/../b:stable', 'ghcr.io/ublue-os/bluefin', 'ghcr.io:70000/ublue-os/bluefin:stable']) {
    const catalog = copy(bluefin);
    catalog.leaves[0].source.ref = ref;
    assert.throws(() => G.validate(catalog, null, { previewOnly: true }), /reference|port/);
  }
  for (const value of ['linux/arm64/v8', 'linux/riscv64', 'Linux/amd64', 'amd64']) {
    const catalog = copy(bluefin);
    catalog.leaves[0].source.platform = value;
    assert.throws(() => G.validate(catalog, null, { previewOnly: true }), /platform/);
  }
});

test('duplicate IDs, duplicate preview tuples and contradictory platform facets are rejected', () => {
  const duplicateId = copy(bluefin);
  duplicateId.leaves[1].id = duplicateId.leaves[0].id;
  assert.throws(() => G.validate(duplicateId, null, { previewOnly: true }), /duplicate leaf ID/);
  const duplicateTuple = copy(bluefin);
  duplicateTuple.leaves[1].source = copy(duplicateTuple.leaves[0].source);
  assert.throws(() => G.validate(duplicateTuple, null, { previewOnly: true }), /duplicate preview/);
  const contradictory = copy(bluefin);
  contradictory.leaves[0].facets.platform = ['linux/arm64'];
  assert.throws(() => G.validate(contradictory, null, { previewOnly: true }), /contradictory preview/);
});

test('required fields, array bounds, duplicate facets and non-JSON objects fail closed', () => {
  for (const change of [
    catalog => { delete catalog.leaves[0].notices; },
    catalog => { catalog.leaves = []; },
    catalog => { catalog.leaves = Array(4097).fill(catalog.leaves[0]); },
    catalog => { catalog.leaves[0].facets.family = []; },
    catalog => { catalog.leaves[0].facets.family = ['classic', 'classic']; },
    catalog => { catalog.leaves[0].facets.family = Array.from({ length: 17 }, (_, i) => `family-${i}`); },
    catalog => { catalog.leaves[0].notices = Array(9).fill({ code: 'notice', text: 'Notice' }); },
    catalog => { catalog.leaves[0].source.evidence = []; },
    catalog => { catalog.leaves[0].facets = Object.create({ desktop: ['gnome'] }); },
  ]) {
    const catalog = copy(bluefin);
    change(catalog);
    assert.throws(() => G.validate(catalog, null, { previewOnly: true }), /Guided catalog:/);
  }
});

test('target joins require the exact bound snapshot and exact targetKey, without ref fallback', () => {
  const { catalog, snapshot } = targetData();
  assert.equal(G.validate(catalog, snapshot, offered).leaves.length, catalog.leaves.length);
  assert.throws(() => G.validate(catalog, null, offered), /snapshotDigest/);
  assert.throws(() => G.validate({ ...catalog, snapshotDigest: null }, snapshot, offered), /snapshotDigest/);
  assert.throws(() => G.validate(catalog, { ...snapshot, snapshotDigest: digest('0') }, offered), /snapshotDigest/);
  const missing = copy(snapshot);
  missing.targets.shift();
  assert.throws(() => G.validate(catalog, missing, offered), /dangling targetKey/);
  const duplicate = copy(snapshot);
  duplicate.targets.push(copy(duplicate.targets[0]));
  assert.throws(() => G.validate(catalog, duplicate, offered), /duplicate snapshot targetKey/);
  const aliased = copy(catalog);
  aliased.leaves[0].id = 'friendly-image-alias';
  assert.throws(() => G.validate(aliased, snapshot, offered), /must equal its targetKey/);
  const refInjection = copy(catalog);
  refInjection.leaves[0].source.ref = snapshot.targets[0].publication.ref;
  assert.throws(() => G.validate(refInjection, snapshot, offered), /unknown/);
});

test('primary flavor metadata derives desktop and edition without splitting names', () => {
  const { catalog, snapshot } = targetData();
  const joined = G.validate(catalog, snapshot, offered);
  const hwe = joined.leaves.find(leaf => leaf.id.includes('gnome-hwe'));
  const nvidia = joined.leaves.find(leaf => leaf.id.includes('kde-nvidia'));
  assert.deepEqual(hwe.facets.desktop, ['gnome']);
  assert.deepEqual(hwe.facets.edition, ['hwe']);
  assert.deepEqual(nvidia.facets.desktop, ['kde']);
  assert.deepEqual(nvidia.facets.edition, ['nvidia']);
  assert.throws(() => G.validate(catalog, snapshot, { isOffered: () => true }), /missing primary flavor metadata/);
  const wrongMetadata = copy(flavorMetadata);
  wrongMetadata['gnome-hwe'].qualified = true;
  assert.throws(() => G.validate(catalog, snapshot, { ...offered, flavorMetadata: wrongMetadata }), /unknown/);
  const strange = targetData();
  strange.snapshot.targets[0].target.flavor = 'opaque-flavor';
  const metadata = { ...flavorMetadata, 'opaque-flavor': { desktop: 'kde', edition: 'hwe' } };
  assert.deepEqual(G.validate(strange.catalog, strange.snapshot, { ...offered, flavorMetadata: metadata }).leaves[0].facets.desktop, ['kde']);
});

test('derived target facets cannot be overridden or invented by catalog presentation', () => {
  const { catalog, snapshot } = targetData();
  for (const [facet, value] of [['base', 'other'], ['platform', 'linux/arm64'], ['hardware', 'apple-t2'], ['desktop', 'kde'], ['edition', 'nvidia'], ['family', 'made-up']]) {
    const bad = copy(catalog);
    bad.leaves[0].facets[facet] = [value];
    assert.throws(() => G.validate(bad, snapshot, offered), /contradictory or unverified target facet/);
  }
});

test('joining and filtering do not mutate or freeze CatalogSnapshot engine evidence', () => {
  const { catalog, snapshot } = targetData();
  const before = JSON.stringify(snapshot);
  const joined = G.validate(catalog, snapshot, offered);
  assert.equal(JSON.stringify(snapshot), before);
  assert.equal(Object.isFrozen(snapshot), false);
  assert.equal(Object.isFrozen(snapshot.targets[0]), false);
  assert.notEqual(joined.leaves[0].entry, snapshot.targets[0]);
  assert.deepEqual(joined.leaves[0].entry, snapshot.targets[0]);
  assert.equal(Object.isFrozen(joined.leaves[0].entry.qualification), true);
  assert.throws(() => { joined.leaves[0].entry.qualification.status = 'qualified'; }, TypeError);
});

test('target admission requires available===true and explicit existing offered policy', () => {
  const { catalog, snapshot } = targetData();
  const joined = G.validate(catalog, snapshot, offered);
  const scheduledOnly = joined.leaves.find(leaf => leaf.entry.scheduled && !leaf.available);
  assert.ok(scheduledOnly);
  assert.equal(scheduledOnly.selectable, false);
  assert.match(scheduledOnly.unavailableReason, /not currently available/);
  const unavailable = joined.leaves.filter(leaf => !leaf.available);
  assert.ok(unavailable.every(leaf => !leaf.selectable));
  assert.ok(G.validate(catalog, snapshot, { flavorMetadata }).leaves.every(leaf => !leaf.selectable));
  assert.ok(G.validate(catalog, snapshot, { ...offered, isOffered: () => 'yes' }).leaves.every(leaf => !leaf.selectable));
  assert.ok(G.validate(catalog, snapshot, { ...offered, isOffered: () => false }).leaves.every(leaf => !leaf.selectable));
  const availableUnqualified = joined.leaves.find(leaf => leaf.available && leaf.entry.qualification.status !== 'qualified');
  assert.ok(availableUnqualified?.selectable, 'review admission is independent of unchanged execution qualification');
  const model = modelFor(catalog, { snapshot, previewOnly: false });
  assert.equal(G.selectLeaf(model, G.initialState(model), scheduledOnly.id).ok, false);
  assert.ok(G.candidates(model).every(leaf => leaf.available));
  assert.equal(G.candidates(model, {}, { includeUnavailable: true }).length, catalog.leaves.length);
});

test('configuration v2 order and subsets cannot manufacture or qualify a leaf', () => {
  const config = configuration(bluefin);
  config.selection.facets.find(facet => facet.id === 'family').values = [
    { id: 'invented', label: 'Qualified new image' }, { id: 'classic', label: 'Classic is qualified' },
  ];
  config.selection.recommendations = [{ leaf_id: bluefin.leaves[1].id, label: 'Qualified', reason: 'Recommended' }];
  const model = modelFor(bluefin, { config });
  assert.equal(model.leaves.length, 1);
  assert.equal(model.leaves[0].id, bluefin.leaves[1].id);
  assert.equal(model.leaves[0].entry, null);
  assert.deepEqual(G.facetOptions(model, G.initialState(model), 'family').map(option => option.id), ['classic']);
  assert.equal(G.candidates(model, { family: 'invented' }).length, 0);
  assert.throws(() => G.createModel(bluefin, null, { ...config, schema_version: 1 }), /configuration v2/);
});

test('presentation metadata is bounded and safe, with optional image cards preserved', () => {
  const config = configuration(bluefin);
  const family = config.selection.facets.find(facet => facet.id === 'family');
  family.values[0].card = { image_url: '/assets/dakota-card.webp', image_alt: 'Dakota desktop', badge: 'Recommended' };
  const model = modelFor(bluefin, { config });
  assert.deepEqual(G.facetOptions(model, G.initialState(model), 'family')[0].card, family.values[0].card);
  for (const image_url of ['javascript:alert(1)', '//evil.example/img.png', '/assets/../secret.png', 'data:image/svg+xml,hello']) {
    const bad = copy(config);
    bad.selection.facets.find(facet => facet.id === 'family').values[0].card.image_url = image_url;
    assert.throws(() => modelFor(bluefin, { config: bad }), /HTTPS/);
  }
  for (const mutate of [
    value => { value.selection.unknown = true; },
    value => { value.selection.paths[0].facets.push(value.selection.paths[0].facets[0]); },
    value => { value.selection.default_path = 'absent'; },
    value => { value.selection.facets[0].values[0].qualification = true; },
    value => { value.selection.facets[0].label = '<b>Family</b>'; },
    value => { value.selection.recommendations = [{ leaf_id: 'absent', label: 'X', reason: 'Y' }]; },
    value => { value.default_selection = { kind: 'image', image: 'ghcr.io/evil/image:stable' }; },
  ]) {
    const bad = copy(config);
    mutate(bad);
    assert.throws(() => modelFor(bluefin, { config: bad }), /Guided catalog:/);
  }
});

test('every permutation of the same four facet predicates resolves identical target identity/ref/platform', () => {
  const { catalog, snapshot } = targetData();
  const model = modelFor(catalog, { snapshot, previewOnly: false });
  const predicates = [['base', 'yellowfin'], ['desktop', 'gnome'], ['hardware', 'generic'], ['platform', 'linux/amd64/v2']];
  const expected = ['yellowfin:gnome:linux/amd64/v2'];
  for (const permutation of permutations(predicates)) {
    let state = G.initialState(model);
    for (const [facet, value] of permutation) state = choose(model, state, facet, value);
    assert.deepEqual(G.candidates(model, state).map(leaf => leaf.id), expected);
    assert.equal(state.selectedLeafId, null, 'narrowing never silently chooses the first leaf');
    state = G.selectLeaf(model, state, expected[0]).state;
    const leaf = G.resolveSelection(model, state);
    assert.equal(leaf.entry.publication.ref, 'ghcr.io/tuna-os/yellowfin:gnome');
    assert.equal(leaf.entry.target.platform, 'linux/amd64/v2');
  }
});

test('multi-valued facets are alternatives and missing facets are never wildcards', () => {
  const catalog = previewCatalog([{ base: 'alpha', desktop: 'gnome', graphics: ['amd', 'intel'] }, { base: 'beta', desktop: 'kde' }]);
  const joined = G.validate(catalog, null, { previewOnly: true });
  assert.equal(G.candidates(joined, { base: 'alpha', graphics: 'amd' }).length, 1);
  assert.equal(G.candidates(joined, { base: 'alpha', graphics: 'intel' }).length, 1);
  assert.equal(G.candidates(joined, { base: 'beta', graphics: 'amd' }).length, 0);
  assert.equal(G.candidates(joined, { base: 'alpha', desktop: 'kde' }).length, 0);
  assert.equal(G.candidates(joined, { invented: 'value' }).length, 0);
});

test('a conditional presentation facet retains inapplicable leaves until explicitly chosen', () => {
  const catalog = previewCatalog([{ desktop: 'gnome', graphics: 'amd' }, { desktop: 'gnome', graphics: 'nvidia', edition: 'modern' }]);
  const model = modelFor(catalog);
  assert.equal(model.leaves.length, 2);
  const amd = choose(model, G.initialState(model), 'graphics', 'amd');
  assert.equal(G.candidates(model, amd).length, 1);
  assert.equal(G.candidates(model, amd)[0].facets.edition, undefined);
  assert.equal(G.candidates(model, { graphics: 'amd', edition: 'modern' }).length, 0);
  assert.equal(G.facetOptions(model, amd, 'edition')[0].disabled, true);
});

test('graphics generation narrows NVIDIA desktop choices without inventing AMD/Intel generation compatibility', () => {
  const catalog = previewCatalog([
    { hardware: 'desktop', graphics: 'amd-intel', desktop: 'kde' },
    { hardware: 'desktop', graphics: 'nvidia', graphics_generation: 'modern', desktop: 'kde' },
    { hardware: 'desktop', graphics: 'nvidia', graphics_generation: 'legacy', desktop: 'kde' },
    { hardware: 'htpc', graphics: 'amd-intel', desktop: 'kde' },
    { hardware: 'handheld', graphics: 'amd-intel', desktop: 'kde' },
  ]);
  const model = modelFor(catalog);
  assert.equal(model.leaves.length, 5, 'conditional generation does not exclude other hardware or graphics');
  let desktop = choose(model, G.initialState(model), 'hardware', 'desktop');
  desktop = choose(model, desktop, 'desktop', 'kde');
  const amdIntel = choose(model, desktop, 'graphics', 'amd-intel');
  assert.equal(G.candidates(model, amdIntel).length, 1);
  assert.equal(G.candidates(model, amdIntel)[0].facets.graphics_generation, undefined);
  assert.ok(G.facetOptions(model, amdIntel, 'graphics_generation').every(option => option.disabled));
  assert.equal(G.candidates(model, { ...amdIntel.filters, graphics_generation: 'modern' }).length, 0);
  const nvidia = choose(model, desktop, 'graphics', 'nvidia');
  assert.deepEqual(G.facetOptions(model, nvidia, 'graphics_generation').map(option => [option.id, option.disabled, option.count]), [['modern', false, 1], ['legacy', false, 1]]);
  const modern = choose(model, nvidia, 'graphics_generation', 'modern');
  assert.equal(G.candidates(model, modern)[0].id, catalog.leaves[1].id);
  const legacy = choose(model, nvidia, 'graphics_generation', 'legacy');
  assert.equal(G.candidates(model, legacy)[0].id, catalog.leaves[2].id);
  const changeGraphics = G.chooseFacet(model, modern, 'graphics', 'amd-intel');
  assert.deepEqual(changeGraphics.conflict.affected, [{ facetId: 'graphics_generation', value: 'modern' }]);
  assert.deepEqual(changeGraphics.conflict.proposedState.filters, { graphics: 'amd-intel', desktop: 'kde', hardware: 'desktop' });
  const changeHardware = G.chooseFacet(model, modern, 'hardware', 'handheld');
  assert.deepEqual(changeHardware.conflict.affected, [{ facetId: 'graphics', value: 'nvidia' }, { facetId: 'graphics_generation', value: 'modern' }]);
  assert.deepEqual(changeHardware.conflict.proposedState.filters, { hardware: 'handheld', desktop: 'kde' });
});

test('selection bounds match the ten-facet source vocabulary and 256 presentation values', () => {
  assert.equal(G.FACETS.length, 10);
  assert.ok(G.FACETS.includes('graphics_generation'));
  const facets = Object.fromEntries(G.FACETS.map(facet => [facet, facet === 'platform' ? 'linux/amd64' : 'value']));
  const catalog = previewCatalog([facets]);
  const config = configuration(catalog);
  assert.equal(config.selection.facets.length, 10);
  assert.equal(config.selection.paths[0].facets.length, 10);
  assert.equal(modelFor(catalog, { config }).leaves.length, 1);
  const family = config.selection.facets.find(facet => facet.id === 'family');
  family.values = [{ id: 'value', label: 'Value' }, ...Array.from({ length: 255 }, (_, index) => ({ id: `choice-${index}`, label: `Choice ${index}` }))];
  assert.equal(modelFor(catalog, { config }).leaves.length, 1);
  family.values.push({ id: 'choice-255', label: 'Choice 255' });
  assert.throws(() => modelFor(catalog, { config }), /1\.\.256/);
  for (const mutate of [
    value => { value.selection.facets = []; },
    value => { value.selection.facets.push(copy(value.selection.facets[0])); },
    value => { value.selection.paths[0].facets = []; },
    value => { value.selection.paths[0].facets.push('family'); },
  ]) {
    const bad = configuration(catalog);
    mutate(bad);
    assert.throws(() => modelFor(catalog, { config: bad }), /1\.\.10/);
  }
});

test('facet counts exclude the current facet predicate and explain disabled options', () => {
  const catalog = previewCatalog([{ base: 'alpha', desktop: 'gnome' }, { base: 'alpha', desktop: 'kde' }, { base: 'beta', desktop: 'kde' }]);
  const model = modelFor(catalog);
  let state = choose(model, G.initialState(model), 'base', 'alpha');
  state = choose(model, state, 'desktop', 'gnome');
  const desktop = G.facetOptions(model, state, 'desktop');
  assert.equal(desktop.find(option => option.id === 'gnome').count, 1);
  assert.equal(desktop.find(option => option.id === 'kde').count, 1);
  const base = G.facetOptions(model, state, 'base');
  assert.equal(base.find(option => option.id === 'beta').disabled, true);
  assert.match(base.find(option => option.id === 'beta').reason, /No image matches/);
});

test('defaults select only their exact identity without prefilled predicates or fallback', () => {
  const model = modelFor(bluefin, { defaultId: bluefin.leaves[0].id });
  const state = G.initialState(model);
  assert.deepEqual(state.filters, {});
  assert.equal(state.selectedLeafId, bluefin.leaves[0].id);
  assert.equal(state.origin, 'default');
  const compatible = choose(model, state, 'desktop', 'gnome');
  assert.equal(compatible.selectedLeafId, bluefin.leaves[0].id);
  const other = choose(model, compatible, 'family', 'classic');
  assert.equal(other.selectedLeafId, null);
  assert.equal(G.candidates(model, other).length, 1);
  assert.equal(G.resolveSelection(model, other), null);
  const missingModel = modelFor(bluefin, { defaultId: 'missing/default' });
  const missingState = G.initialState(missingModel);
  assert.equal(missingState.selectedLeafId, 'missing/default');
  assert.match(missingState.unavailable.reason, /no longer available/);
  assert.equal(G.resolveSelection(missingModel, missingState), null);
});

test('missing or unavailable configured defaults remain visible and do not pick alternatives', () => {
  const { catalog, snapshot } = targetData();
  const id = 'yellowfin:gnome-hwe:linux/amd64/v2';
  const model = modelFor(catalog, { snapshot, previewOnly: false, defaultId: id });
  const state = G.initialState(model);
  assert.equal(state.selectedLeafId, id);
  assert.match(state.unavailable.reason, /not currently available/);
  assert.equal(G.resolveSelection(model, state), null);
  assert.ok(G.candidates(model, state).length > 1, 'valid alternatives are available without automatic replacement');
});

test('path switching and removing a predicate preserve compatible choices and explicit leaf identity', () => {
  const model = modelFor(bluefin);
  let state = choose(model, G.initialState(model), 'family', 'classic');
  state = choose(model, state, 'desktop', 'gnome');
  state = G.selectLeaf(model, state, bluefin.leaves[1].id).state;
  const before = JSON.stringify(state);
  const switched = G.changePath(model, state, 'desktop-first').state;
  assert.equal(JSON.stringify(state), before);
  assert.deepEqual(switched.filters, state.filters);
  assert.deepEqual(switched.facetOrder, state.facetOrder);
  assert.equal(switched.selectedLeafId, state.selectedLeafId);
  assert.equal(switched.origin, 'explicit');
  const cleared = G.clearFacet(model, switched, 'family').state;
  assert.equal(G.candidates(model, cleared).length, 3);
  assert.equal(cleared.selectedLeafId, state.selectedLeafId);
  assert.deepEqual(cleared.filters, { desktop: 'gnome' });
  assert.equal(G.changePath(model, state, 'unknown').ok, false);
});

test('conflicting edits return exact affected selections and preserve maximal compatible predicates', () => {
  const catalog = previewCatalog([
    { base: 'alpha', desktop: 'gnome', hardware: 'generic', graphics: 'amd' },
    { base: 'beta', desktop: 'kde', hardware: 'generic', graphics: 'amd' },
    { base: 'beta', desktop: 'gnome', hardware: 'apple-t2', graphics: 'nvidia' },
  ]);
  const model = modelFor(catalog);
  let state = G.initialState(model);
  for (const [facet, value] of Object.entries({ base: 'alpha', desktop: 'gnome', hardware: 'generic', graphics: 'amd' })) state = choose(model, state, facet, value);
  state = G.selectLeaf(model, state, catalog.leaves[0].id).state;
  const before = JSON.stringify(state);
  const change = G.chooseFacet(model, state, 'base', 'beta');
  assert.equal(change.ok, false);
  assert.equal(change.state, state);
  assert.equal(JSON.stringify(state), before);
  assert.deepEqual(change.conflict.affected, [{ facetId: 'desktop', value: 'gnome' }]);
  assert.deepEqual(change.conflict.proposedState.filters, { base: 'beta', graphics: 'amd', hardware: 'generic' });
  assert.equal(change.conflict.proposedState.selectedLeafId, null);
  const accepted = G.chooseFacet(model, state, 'base', 'beta', { confirmConflicts: true });
  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.state, change.conflict.proposedState);
  assert.equal(accepted.state.selectedLeafId, null);
  assert.equal(Object.isFrozen(change.conflict.proposedState.filters), true);
});

test('equally small reconciliations preserve the most recently explicit compatible choice', () => {
  const catalog = previewCatalog([
    { base: 'alpha', desktop: 'gnome', graphics: 'amd' },
    { base: 'beta', desktop: 'kde', graphics: 'amd' },
    { base: 'beta', desktop: 'gnome', graphics: 'nvidia' },
  ]);
  const model = modelFor(catalog);
  for (const order of [['desktop', 'graphics'], ['graphics', 'desktop']]) {
    let state = choose(model, G.initialState(model), 'base', 'alpha');
    for (const facet of order) state = choose(model, state, facet, facet === 'desktop' ? 'gnome' : 'amd');
    const result = G.chooseFacet(model, state, 'base', 'beta');
    assert.equal(result.ok, false);
    assert.equal(result.conflict.affected[0].facetId, order[0]);
    assert.ok(own(result.conflict.proposedState.filters, order[1]));
  }
  function own(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
});

test('explicit leaf selection never ignores incompatible predicates or substitutes a missing ID', () => {
  const model = modelFor(bluefin);
  const state = choose(model, G.initialState(model), 'family', 'classic');
  assert.equal(G.selectLeaf(model, state, bluefin.leaves[0].id).ok, false);
  assert.equal(G.selectLeaf(model, state, 'missing/leaf').ok, false);
  assert.equal(G.selectLeaf(model, state, null).ok, false);
  assert.equal(G.chooseFacet(model, state, 'family', 'unmapped-family').ok, false);
  assert.equal(G.chooseFacet(model, state, 'unknown', 'anything').ok, false);
  assert.equal(G.clearFacet(model, state, 'unknown').ok, false);
  assert.equal(state.selectedLeafId, null);
});

test('ambiguous terminal candidates require explicit image selection, never array order', () => {
  const catalog = previewCatalog([{ desktop: 'gnome' }, { desktop: 'gnome' }]);
  const model = modelFor(catalog);
  const state = choose(model, G.initialState(model), 'desktop', 'gnome');
  assert.equal(G.candidates(model, state).length, 2);
  assert.equal(G.resolveSelection(model, state), null);
  assert.equal(state.selectedLeafId, null);
  const reversed = modelFor({ ...catalog, leaves: [...catalog.leaves].reverse() });
  assert.equal(G.resolveSelection(reversed, state), null);
  const selected = G.selectLeaf(model, state, catalog.leaves[1].id);
  assert.equal(G.resolveSelection(model, selected.state).id, catalog.leaves[1].id);
});

test('refresh preserves disappeared explicit identity and filters with visible unavailable state', () => {
  const model = modelFor(bluefin, { defaultId: bluefin.leaves[0].id });
  let state = choose(model, G.initialState(model), 'family', 'classic');
  state = G.selectLeaf(model, state, bluefin.leaves[1].id).state;
  const changedCatalog = { ...copy(bluefin), leaves: [copy(bluefin.leaves[0])] };
  const nextModel = modelFor(changedCatalog, { defaultId: bluefin.leaves[0].id });
  const refreshed = G.refreshState(nextModel, state);
  assert.equal(refreshed.selectedLeafId, bluefin.leaves[1].id);
  assert.equal(refreshed.origin, 'explicit');
  assert.deepEqual(refreshed.filters, { family: 'classic' });
  assert.match(refreshed.unavailable.reason, /no longer available/);
  assert.equal(G.resolveSelection(nextModel, refreshed), null);
  const broadened = G.clearFacet(nextModel, refreshed, 'family').state;
  assert.equal(broadened.selectedLeafId, bluefin.leaves[1].id);
  assert.ok(broadened.unavailable);
  assert.equal(G.candidates(nextModel, broadened).length, 1);
});

test('evidenceKey changes on source evidence and snapshot execution evidence changes, not key order', () => {
  const joined = G.validate(bluefin, null, { previewOnly: true });
  const changed = copy(bluefin);
  changed.leaves[0].source.evidence[0].checkedAt = '2026-10-21T00:00:00Z';
  assert.notEqual(G.validate(changed, null, { previewOnly: true }).leaves[0].evidenceKey, joined.leaves[0].evidenceKey);
  const { catalog, snapshot } = targetData();
  const before = G.validate(catalog, snapshot, offered).leaves[0].evidenceKey;
  const reordered = copy(snapshot);
  reordered.targets[0].resolvedInputs = Object.fromEntries(Object.entries(reordered.targets[0].resolvedInputs).reverse());
  assert.equal(G.validate(catalog, reordered, offered).leaves[0].evidenceKey, before);
  const changedSnapshot = copy(snapshot);
  changedSnapshot.targets[0].resolvedInputs.platformManifestDigest = digest('a');
  assert.notEqual(G.validate(catalog, changedSnapshot, offered).leaves[0].evidenceKey, before);
});

test('evidenceKey invalidates stale warning acknowledgement and compatibility facts but excludes config wording', () => {
  const catalog = copy(bazzite);
  const leaf = catalog.leaves.find(item => item.notices.some(notice => notice.requiresAcknowledgement));
  const id = leaf.id;
  const before = G.validate(catalog, null, { previewOnly: true }).leaves.find(item => item.id === id).evidenceKey;
  leaf.notices.find(notice => notice.requiresAcknowledgement).text += ' Review updated limitations.';
  const warningChanged = G.validate(catalog, null, { previewOnly: true }).leaves.find(item => item.id === id).evidenceKey;
  assert.notEqual(warningChanged, before, 'same notice code with new warning text requires a fresh acknowledgement');
  leaf.facets.hardware = ['desktop'];
  const compatibilityChanged = G.validate(catalog, null, { previewOnly: true }).leaves.find(item => item.id === id).evidenceKey;
  assert.notEqual(compatibilityChanged, warningChanged);
  const config = configuration(catalog);
  const model = modelFor(catalog, { config });
  config.selection.facets[0].label = 'A different presentation label';
  const relabeled = modelFor(catalog, { config });
  assert.equal(model.leaves.find(item => item.id === id).evidenceKey, relabeled.leaves.find(item => item.id === id).evidenceKey);
});

test('all model states and returned option metadata are immutable', () => {
  const model = modelFor(bluefin);
  const state = G.initialState(model);
  assert.ok(Object.isFrozen(model));
  assert.ok(Object.isFrozen(model.leaves[0].facets.desktop));
  assert.ok(Object.isFrozen(state.filters));
  assert.ok(Object.isFrozen(G.facetOptions(model, state, 'family')[0]));
  assert.throws(() => { state.filters.family = 'classic'; }, TypeError);
  assert.throws(() => { model.leaves[0].source.ref = 'ghcr.io/evil/image:stable'; }, TypeError);
});
