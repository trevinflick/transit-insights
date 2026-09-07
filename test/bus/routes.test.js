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
  routeTitleForPattern,
  branchLabelForHeadsign,
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

// branchLabelForHeadsign: route 1's post-2026-09-07 Kenny/Livingston split.
// Real GTFS trip_headsign values confirmed against the live feed the day the
// new schedule launched.
test("branchLabelForHeadsign resolves both of route 1's Kenny headsigns", () => {
  assert.equal(branchLabelForHeadsign('001', '1 KENNY TO DOWNTOWN'), 'Route 1 Kenny');
  assert.equal(branchLabelForHeadsign('001', '1 KENNY TO OSU DUBLIN'), 'Route 1 Kenny');
});

test("branchLabelForHeadsign resolves both of route 1's Livingston headsigns", () => {
  assert.equal(branchLabelForHeadsign('001', '1 LIVINGSTON TO DOWNTOWN'), 'Route 1 Livingston');
  assert.equal(
    branchLabelForHeadsign('001', '1 LIVINGSTON TO REYNOLDSBURG PARK AND RIDE'),
    'Route 1 Livingston',
  );
});

test('branchLabelForHeadsign is case-insensitive', () => {
  assert.equal(branchLabelForHeadsign('001', 'kenny to downtown'), 'Route 1 Kenny');
});

test('branchLabelForHeadsign returns null (not a guess) for an unmatched route-1 headsign', () => {
  // The real short-turn variant seen in the 2026-09-07 GTFS pull — genuine
  // route 1 service, but neither branded line, so no label should be forced.
  assert.equal(branchLabelForHeadsign('001', '1 OLENTANGY TO RIVERSIDE HOSPITAL'), null);
});

test('branchLabelForHeadsign returns null for a route with no branch mapping', () => {
  assert.equal(branchLabelForHeadsign('002', 'anything at all'), null);
});

test('branchLabelForHeadsign returns null for a missing/empty headsign', () => {
  assert.equal(branchLabelForHeadsign('001', null), null);
  assert.equal(branchLabelForHeadsign('001', ''), null);
});

// routeTitleForPattern's fallback paths — all short-circuit before touching
// the GTFS index, so they're deterministic regardless of whether
// data/gtfs/index.json exists in this environment.
test('routeTitleForPattern falls back to routeTitle for a route with no branch mapping', () => {
  assert.equal(
    routeTitleForPattern('002', { pid: '123', points: [{ lat: 1, lon: 1 }] }),
    routeTitle('002'),
  );
});

test('routeTitleForPattern falls back to routeTitle when no pattern is given', () => {
  assert.equal(routeTitleForPattern('001', null), routeTitle('001'));
  assert.equal(routeTitleForPattern('001', undefined), routeTitle('001'));
});

test('routeTitleForPattern falls back to routeTitle when the pattern has no points', () => {
  assert.equal(routeTitleForPattern('001', {}), routeTitle('001'));
  assert.equal(routeTitleForPattern('001', { pid: '123', points: [] }), routeTitle('001'));
});

// End-to-end against the real GTFS index (same convention as the
// gap/ghost/lowFrequency coverage tests above — this suite already assumes
// data/gtfs/index.json is present). Regression coverage for a real incident:
// resolvePatternGroup wasn't exported from src/shared/gtfs.js, so this always
// silently fell back to the generic name via routeTitleForPattern's
// catch-and-fall-back — the fallback tests above still passed, masking it.
// Endpoints are route 1's real origin/terminal coordinates confirmed in the
// 2026-09-07 GTFS pull.
test('routeTitleForPattern resolves the real Kenny and Livingston branches from the live index', () => {
  const kenny = {
    pid: 'test-kenny',
    points: [
      { lat: 40.097961, lon: -83.168121 }, // OSU Outpatient Care Dublin
      { lat: 39.949237, lon: -82.999864 }, // Downtown
    ],
  };
  const livingston = {
    pid: 'test-livingston',
    points: [
      { lat: 39.96864, lon: -82.99363 }, // Downtown-side origin
      { lat: 39.939288, lon: -82.82751 }, // Reynoldsburg Park & Ride
    ],
  };
  assert.equal(routeTitleForPattern('001', kenny), 'Route 1 Kenny');
  assert.equal(routeTitleForPattern('001', livingston), 'Route 1 Livingston');
});
