// Generates requests.json: the BuildRequest v1 documents app/public/app.js
// buildRequestFromForm produces when the guided picker selects each target
// below, computed by running the real app.js functions in a VM against the
// catalog copies embedded in the helper. Run via `go generate ./...` in
// desktop/helper (internal/catalog/catalog.go), never by hand-editing output.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repo = path.join(__dirname, '../../../../..');
const pub = path.join(repo, 'app/public');
const embedded = path.join(__dirname, '../../catalog/embedded');
const TARGETS = [
  'skipjack:gnome:linux/amd64', // browser-qualified
  'flounder:xfce:linux/amd64',
  'albacore:gnome-hwe:linux/amd64/v2',
  'albacore:kde:linux/arm64',
];

const src = fs.readFileSync(path.join(pub, 'app.js'), 'utf8');
function slice(start, end) {
  const a = src.indexOf(start);
  const b = a < 0 ? -1 : src.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error(`app.js no longer contains ${JSON.stringify(start)} … ${JSON.stringify(end)}`);
  return src.slice(a, b);
}
const code = [
  slice('let SHIM = ', 'const DEFAULT_CATALOG_SNAPSHOT'),
  slice('function catalogQualification(', '// TEST-ONLY seam'),
  slice('const STRICT_OBSERVED_BOTH_IMAGE', 'function loadCatalogSnapshot('),
  slice('function parseImage(', '// ── Image picker'),
  slice('const NATIVE_V3_VARIANTS', 'let operationSeq'),
  slice('function buildRequestFromForm(', 'function rebuildCurrentOperation('),
  'globalThis.__build = () => buildRequestFromForm().request;',
].join('\n');

const { validate } = require(path.join(pub, 'builder-config.js'));
const { suggestions } = require(path.join(pub, 'flatpak-defaults.js'));
const read = (name) => JSON.parse(fs.readFileSync(path.join(embedded, name), 'utf8'));
const BUILDER_CONFIG = validate(read('builder-config.json'));
const catalogSnapshot = read('catalog-snapshot.json');
const guided = read('guided-catalog.json');

let form = {};
let flatpaks = [];
const context = {
  BUILDER_CONFIG, catalogSnapshot,
  $: (id) => (id in form ? { value: form[id] } : null),
  fpCollect: () => flatpaks.slice(),
  pkgCollect: () => [],
  repoCmds: [],
};
vm.createContext(context);
vm.runInContext(code, context);

const fixtures = TARGETS.map((key) => {
  const leaf = guided.leaves.find((l) => l.id === key);
  const entry = catalogSnapshot.targets.find((t) => t.targetKey === key);
  if (!leaf || !entry) throw new Error(`fixture target ${key} is not in the embedded catalog; pick another`);
  const desktop = leaf.facets.desktop[0];
  const declared = (BUILDER_CONFIG.desktops.find((d) => d.id === desktop) || {}).default_flatpaks || [];
  flatpaks = suggestions({}, declared).ids;
  // What the guided picker leaves in the form for this leaf (app.js
  // refreshGuidedPicker/applyBuilderBranding): image = publication ref,
  // platform = target platform, label = configured volume label.
  form = {
    image: entry.publication.ref,
    variant: entry.target.variant,
    platform: entry.target.platform,
    label: BUILDER_CONFIG.output.volume_label,
  };
  return { target: key, desktop, request: JSON.parse(JSON.stringify(context.__build())) };
});
if (!fixtures.some((f) => f.request.qualificationId)) throw new Error('no fixture target is browser-qualified any more; pick one that is');
fs.writeFileSync(path.join(__dirname, 'requests.json'), JSON.stringify(fixtures, null, 2) + '\n');
