const test = require('node:test');
const assert = require('node:assert/strict');
const { loadIndex } = require('../../src/shared/gtfs');
const {
  ghosts,
  gaps,
  lowFrequency,
  allRoutes,
  names,
  routeShortName,
  routeLabel,
  routeTitle,
} = require('../../src/bus/routes');

// Gaps and ghosts both *require* GTFS lookups (headway/expected-active gates)
// — a missing index entry there silently disables detection. allRoutes is
// broader (includes seasonal variants that CTA omits from the published GTFS
// feed); pulse tolerates missing entries by skipping the route, so it's not
// asserted here.
test('every gap/ghost-polled bus route is present in the GTFS index', () => {
  const idx = loadIndex();
  const polled = [...new Set([...ghosts, ...gaps])];
  const missing = polled.filter((r) => !idx.routes[r]);
  assert.deepEqual(missing, [], `re-run scripts/fetch-gtfs.js to index: ${missing.join(', ')}`);
});

// thin-gap detector needs headway + activeByHour from the index to fire, and
// the eligibility list is precomputed against a specific GTFS snapshot — drift
// (a route disappearing from CTA's feed) should be caught here, not silently.
test('every lowFrequency route is present in the GTFS index', () => {
  const idx = loadIndex();
  const missing = lowFrequency.filter((r) => !idx.routes[r]);
  assert.deepEqual(
    missing,
    [],
    `re-run scripts/compute-low-frequency-routes.js: ${missing.join(', ')}`,
  );
});

// The whole point of the thin-gap detector is to cover routes outside the
// curated lists. Overlap means duplicate posts and confused readers.
test('lowFrequency does not overlap with gaps or ghosts', () => {
  const covered = new Set([...gaps, ...ghosts]);
  const overlap = lowFrequency.filter((r) => covered.has(r));
  assert.deepEqual(overlap, []);
});

// COTA's GTFS-realtime route_id is the join key everywhere (live feed and
// static schedule agree exactly — no suffix/shadow quirk like CTA's Night
// Owl routes), so allRoutes should be exactly every route in `names`.
test('allRoutes is exactly every route in names, zero-padded', () => {
  assert.deepEqual(new Set(allRoutes), new Set(Object.keys(names)));
  for (const r of allRoutes)
    assert.match(r, /^\d{3}$/, `expected a zero-padded route_id, got ${r}`);
});

test('routeShortName strips zero-padding for display, except CMAX', () => {
  assert.equal(routeShortName('002'), '2');
  assert.equal(routeShortName('023'), '23');
  assert.equal(routeShortName('102'), '102');
  assert.equal(routeShortName('101'), 'CMAX');
});

test('routeLabel reads "Route N" for numbered routes and bare "CMAX" for the branded line', () => {
  assert.equal(routeLabel('002'), 'Route 2');
  assert.equal(routeLabel('023'), 'Route 23');
  assert.equal(routeLabel('101'), 'CMAX');
});

test('routeTitle includes the descriptive name without a redundant "Route CMAX (CMAX)"', () => {
  assert.equal(routeTitle('002'), 'Route 2 (E Main/N High)');
  assert.equal(routeTitle('023'), 'Route 23 (James-Stelzer)');
  assert.equal(routeTitle('101'), 'CMAX');
});
