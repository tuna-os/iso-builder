// The gate specs need a target the catalog refuses. The committed snapshot
// qualifies skipjack:gnome linux/amd64 once its receipt is committed, so these
// tests serve the same snapshot with that one entry returned to the state it
// had before qualification. UI state-machine tests only; real admission of the
// qualified entry is tested without this route (verify-catalog.py, app tests).
const catalog = require('../../app/public/catalog-snapshot.json');

const UNQUALIFIED_KEY = 'skipjack:gnome:linux/amd64';

async function unqualifiedSkipjackCatalog(page) {
  const doc = structuredClone(catalog);
  const entry = doc.targets.find((target) => target.targetKey === UNQUALIFIED_KEY);
  entry.qualification = {
    browser: null, qualifiedAt: null, reason: 'no-qualification-receipt',
    receiptDigest: null, resources: null, status: 'unqualified',
  };
  await page.route('**/catalog-snapshot.json', (route) => route.fulfill({ json: doc }));
  return doc;
}

module.exports = { unqualifiedSkipjackCatalog };
