const test = require('node:test');
const assert = require('node:assert/strict');
const { detectSystemWideDegradation, MIN_ROUTES_FOR_ROLLUP } = require('../../src/bus/fleetRollup');

const sig = (line, source, severity) => ({ line, source, severity, ts: Date.now() });

test('below threshold: fewer than minRoutes distinct degraded routes does not trigger', () => {
  const rows = ['001', '002', '003'].map((r) => sig(r, 'gap', 0.8));
  const result = detectSystemWideDegradation(rows, { monitoredRouteCount: 27, minRoutes: 8 });
  assert.equal(result, null);
});

test('at threshold: exactly minRoutes distinct degraded routes triggers', () => {
  const routes = Array.from({ length: MIN_ROUTES_FOR_ROLLUP }, (_, i) =>
    String(i + 1).padStart(3, '0'),
  );
  const rows = routes.map((r) => sig(r, 'gap', 0.8));
  const result = detectSystemWideDegradation(rows, { monitoredRouteCount: 27 });
  assert.ok(result);
  assert.equal(result.degradedCount, MIN_ROUTES_FOR_ROLLUP);
  assert.equal(result.monitoredRouteCount, 27);
});

test('severity floor: rows below minSeverity are excluded from the count', () => {
  const above = Array.from({ length: 7 }, (_, i) =>
    sig(String(i + 1).padStart(3, '0'), 'gap', 0.8),
  );
  const below = Array.from({ length: 5 }, (_, i) =>
    sig(String(i + 100).padStart(3, '0'), 'gap', 0.2),
  );
  const result = detectSystemWideDegradation([...above, ...below], {
    monitoredRouteCount: 27,
    minRoutes: 8,
  });
  // Only 7 routes clear the severity floor — below the 8-route bar.
  assert.equal(result, null);
});

test('dedup: a route flagged by multiple sources counts once', () => {
  const routes = Array.from({ length: 7 }, (_, i) => String(i + 1).padStart(3, '0'));
  const rows = [
    ...routes.map((r) => sig(r, 'gap', 0.7)),
    // route '001' also shows up via ghost and thin-gap — still one route.
    sig('001', 'ghost', 0.9),
    sig('001', 'thin-gap', 0.6),
  ];
  const result = detectSystemWideDegradation(rows, { monitoredRouteCount: 27, minRoutes: 7 });
  assert.ok(result);
  assert.equal(result.degradedCount, 7);
});

test('worstRoutes ranks by highest severity seen per route, capped at 3', () => {
  const routes = Array.from({ length: 8 }, (_, i) => String(i + 1).padStart(3, '0'));
  const rows = routes.map((r, i) => sig(r, 'gap', 0.5 + i * 0.05)); // 008 highest
  const result = detectSystemWideDegradation(rows, { monitoredRouteCount: 27, minRoutes: 8 });
  assert.ok(result);
  assert.equal(result.worstRoutes.length, 3);
  assert.deepEqual(result.worstRoutes, ['008', '007', '006']);
});

test('a source outside the rollup set (e.g. cross-bunching) is ignored', () => {
  const routes = Array.from({ length: 8 }, (_, i) => String(i + 1).padStart(3, '0'));
  const rows = routes.map((r) => sig(r, 'cross-bunching', 0.9));
  const result = detectSystemWideDegradation(rows, { monitoredRouteCount: 27, minRoutes: 8 });
  assert.equal(result, null);
});

test('empty/null input returns null', () => {
  assert.equal(detectSystemWideDegradation([], { monitoredRouteCount: 27 }), null);
  assert.equal(detectSystemWideDegradation(null, { monitoredRouteCount: 27 }), null);
});
