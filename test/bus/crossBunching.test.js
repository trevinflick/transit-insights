const test = require('node:test');
const assert = require('node:assert/strict');
const {
  detectCrossRouteBunches,
  groupByRoute,
  isAtTerminal,
  isAtPulseHub,
  isAllowedRouteCombo,
  LAYOVER_TERMINAL_FT,
  PULSE_HUBS,
  ALLOWED_ROUTE_SETS,
} = require('../../src/bus/crossBunching');
const { bus, FRESH } = require('../helpers');

const FT_PER_MILLIDEG_LAT = 365;
const dLatForFt = (ft) => ft / FT_PER_MILLIDEG_LAT / 1000;
// Place a bus `ft` north of a base point, on a given route.
const at = (vid, route, ft, extra = {}) =>
  bus({ vid, route, pid: `p${route}`, lat: 41.9 + dLatForFt(ft), lon: -87.65, ...extra });

// These fixtures use arbitrary fake route ids (22/36/8/9/12/49) to test the
// clustering mechanism itself, independent of the route-combo policy — pass
// allowedRouteSets: null to disable that gate so they keep testing what they
// say they test. The policy itself gets its own tests further down.
const ANY_ROUTES = { allowedRouteSets: null };

test('detects a multi-route pileup (2 routes, 3 buses)', () => {
  const vs = [at('a', '22', 0), at('b', '22', 200), at('c', '36', 400)];
  const [bunch] = detectCrossRouteBunches(vs, { now: FRESH, ...ANY_ROUTES });
  assert.equal(bunch.vehicles.length, 3);
  assert.deepEqual(bunch.routes, ['22', '36']);
  assert.equal(bunch.routeCount, 2);
});

test('ignores a single-route cluster (that is regular bunching)', () => {
  const vs = [at('a', '22', 0), at('b', '22', 200), at('c', '22', 400)];
  assert.equal(detectCrossRouteBunches(vs, { now: FRESH, ...ANY_ROUTES }).length, 0);
});

test('ignores a multi-route cluster below the vehicle minimum', () => {
  const vs = [at('a', '22', 0), at('b', '36', 200)];
  assert.equal(detectCrossRouteBunches(vs, { now: FRESH, ...ANY_ROUTES }).length, 0);
});

test('separates two distant pileups and ranks larger first', () => {
  const vs = [
    at('a', '22', 0),
    at('b', '36', 200),
    at('c', '8', 400),
    at('d', '9', 9000),
    at('e', '12', 9200),
    at('f', '12', 9400),
    at('g', '49', 9600),
  ];
  const bunches = detectCrossRouteBunches(vs, { now: FRESH, ...ANY_ROUTES });
  assert.equal(bunches.length, 2);
  assert.equal(bunches[0].vehicles.length, 4); // the d..g cluster
});

test('congestion gate: drops a cluster with too few stopped members', () => {
  const vs = [at('a', '22', 0), at('b', '36', 200), at('c', '8', 400)];
  const stoppedIds = new Set(['a']); // only 1 of 3 confirmed stopped
  assert.equal(detectCrossRouteBunches(vs, { now: FRESH, stoppedIds, ...ANY_ROUTES }).length, 0);
});

test('congestion gate: keeps a cluster with enough stopped members', () => {
  const vs = [at('a', '22', 0), at('b', '36', 200), at('c', '8', 400)];
  const stoppedIds = new Set(['a', 'b']);
  assert.equal(detectCrossRouteBunches(vs, { now: FRESH, stoppedIds, ...ANY_ROUTES }).length, 1);
});

test('drops stale fixes outside the freshness window', () => {
  const vs = [
    at('a', '22', 0),
    at('b', '36', 200),
    at('c', '8', 400, { tmstmp: FRESH - 5 * 60 * 1000 }),
  ];
  assert.equal(detectCrossRouteBunches(vs, { now: FRESH, ...ANY_ROUTES }).length, 0);
});

test('layover gate: drops tagged buses before clustering', () => {
  const vs = [at('a', '22', 0), at('b', '36', 200), at('c', '8', 400)];
  // a + c laying over → only #36 remains → single-route → no post.
  assert.equal(
    detectCrossRouteBunches(vs, { now: FRESH, layoverIds: new Set(['a', 'c']), ...ANY_ROUTES })
      .length,
    0,
  );
  // Untagged, the same set posts.
  assert.equal(detectCrossRouteBunches(vs, { now: FRESH, ...ANY_ROUTES }).length, 1);
});

test('isAtTerminal flags positions within margin of either pattern end', () => {
  const len = 10000;
  assert.equal(isAtTerminal(100, len), true); // near start
  assert.equal(isAtTerminal(len - 100, len), true); // near end
  assert.equal(isAtTerminal(5000, len), false); // mid-route
  assert.equal(isAtTerminal(LAYOVER_TERMINAL_FT + 1, len), false); // just past the start zone
  assert.equal(isAtTerminal(Number.NaN, len), false);
  assert.equal(isAtTerminal(100, 0), false); // degenerate pattern
});

test('isAtPulseHub: true within radius of a known hub, false outside', () => {
  const hubs = [{ lat: 39.965, lon: -83.002, radiusFt: 1000 }];
  assert.equal(isAtPulseHub({ lat: 39.965, lon: -83.002 }, hubs), true);
  assert.equal(isAtPulseHub({ lat: 39.9655, lon: -83.0025 }, hubs), true); // nearby, within radius
  assert.equal(isAtPulseHub({ lat: 39.99, lon: -83.002 }, hubs), false); // ~8800 ft away
});

// Real COTA pattern: every hour on the hour, most of the network converges at
// N High St & W Long St for a scheduled transfer — not unplanned congestion.
// A cluster centered there must never count as a cross-route pileup, even
// though it otherwise clears every other gate (vehicles, routes, congestion).
// allowedRouteSets disabled so this is unambiguously testing the hub gate,
// not the (also-failing) route-combo gate.
test('pulse-hub gate: a cluster centered on the downtown transfer point is excluded', () => {
  const hubLat = PULSE_HUBS[0].lat;
  const hubLon = PULSE_HUBS[0].lon;
  const vs = [
    bus({ vid: 'a', route: '001', pid: 'p1', lat: hubLat, lon: hubLon }),
    bus({ vid: 'b', route: '002', pid: 'p2', lat: hubLat + 0.0005, lon: hubLon }),
    bus({ vid: 'c', route: '008', pid: 'p8', lat: hubLat - 0.0005, lon: hubLon }),
  ];
  assert.equal(detectCrossRouteBunches(vs, { now: FRESH, ...ANY_ROUTES }).length, 0);
});

test('pulse-hub gate: a cluster elsewhere downtown still fires normally', () => {
  const vs = [at('a', '22', 0), at('b', '36', 200), at('c', '8', 400)];
  assert.equal(detectCrossRouteBunches(vs, { now: FRESH, ...ANY_ROUTES }).length, 1);
});

// --- route-combo allowlist: cross-bunching only posts for a known-good pair ---

test('isAllowedRouteCombo: exact match passes, subset/superset/different pair fail', () => {
  const allowed = [['002', '102']];
  assert.equal(isAllowedRouteCombo(new Set(['002', '102']), allowed), true);
  assert.equal(isAllowedRouteCombo(new Set(['102', '002']), allowed), true); // order-independent
  assert.equal(isAllowedRouteCombo(new Set(['002']), allowed), false); // subset
  assert.equal(isAllowedRouteCombo(new Set(['002', '102', '012']), allowed), false); // superset
  assert.equal(isAllowedRouteCombo(new Set(['002', '012']), allowed), false); // different pair
});

test('route-combo gate: the default-allowed pair still posts', () => {
  const [routeA, routeB] = ALLOWED_ROUTE_SETS[0];
  const vs = [at('a', routeA, 0), at('b', routeA, 200), at('c', routeB, 400)];
  assert.equal(detectCrossRouteBunches(vs, { now: FRESH }).length, 1);
});

// Real false positive: a 3-route cluster (002/012/025) near 1333 Fields Ave
// cleared every other gate (vehicles, routes, congestion, not a known hub)
// but isn't the known-good corridor overlap — suppressed by default now.
test('route-combo gate: a real-world non-hub false positive (002/012/025) is suppressed by default', () => {
  const vs = [at('a', '002', 0), at('b', '012', 200), at('c', '025', 400)];
  const stoppedIds = new Set(['a', 'b', 'c']);
  assert.equal(detectCrossRouteBunches(vs, { now: FRESH, stoppedIds }).length, 0);
});

test('groupByRoute numbers buses across routes, biggest group first', () => {
  const vs = [at('a', '22', 0), at('b', '36', 200), at('c', '36', 400)];
  const [bunch] = detectCrossRouteBunches(vs, { now: FRESH, ...ANY_ROUTES });
  const { byRoute, labels } = groupByRoute(bunch);
  assert.equal(byRoute[0].route, '36'); // 2 buses → listed first
  assert.equal(byRoute[1].route, '22');
  assert.equal(labels.size, 3);
  assert.deepEqual(
    byRoute[0].vids.map((x) => x.vid),
    ['b', 'c'],
  );
});
