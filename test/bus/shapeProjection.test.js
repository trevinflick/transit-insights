const test = require('node:test');
const assert = require('node:assert/strict');
const { haversineFt } = require('../../src/shared/geo');
const { projectOntoShape, withCumulativeDistFt } = require('../../src/bus/shapeProjection');

// Simple due-north line (constant longitude) so expected distances are easy
// to reason about without longitude/cos(lat) scaling surprises.
const NORTH_LINE = [
  { lat: 39.95, lon: -83.0 },
  { lat: 39.96, lon: -83.0 },
  { lat: 39.97, lon: -83.0 },
];

test('withCumulativeDistFt: starts at 0 and is monotonically increasing', () => {
  const withDist = withCumulativeDistFt(NORTH_LINE);
  assert.equal(withDist[0].distFt, 0);
  assert.ok(withDist[1].distFt > 0);
  assert.ok(withDist[2].distFt > withDist[1].distFt);
});

test('withCumulativeDistFt: cumulative distance matches haversine sum', () => {
  const withDist = withCumulativeDistFt(NORTH_LINE);
  const leg1 = haversineFt(NORTH_LINE[0], NORTH_LINE[1]);
  const leg2 = haversineFt(NORTH_LINE[1], NORTH_LINE[2]);
  assert.ok(Math.abs(withDist[1].distFt - leg1) < 1e-6);
  assert.ok(Math.abs(withDist[2].distFt - (leg1 + leg2)) < 1e-6);
});

test('withCumulativeDistFt: preserves lat/lon', () => {
  const withDist = withCumulativeDistFt(NORTH_LINE);
  for (let i = 0; i < NORTH_LINE.length; i++) {
    assert.equal(withDist[i].lat, NORTH_LINE[i].lat);
    assert.equal(withDist[i].lon, NORTH_LINE[i].lon);
  }
});

test('projectOntoShape: returns null for fewer than 2 points', () => {
  assert.equal(projectOntoShape(39.96, -83.0, []), null);
  assert.equal(projectOntoShape(39.96, -83.0, [{ lat: 39.96, lon: -83.0, distFt: 0 }]), null);
  assert.equal(projectOntoShape(39.96, -83.0, null), null);
});

test('projectOntoShape: a point exactly on the line projects with ~0 perpendicular distance', () => {
  const shape = withCumulativeDistFt(NORTH_LINE);
  const mid = NORTH_LINE[1];
  const proj = projectOntoShape(mid.lat, mid.lon, shape);
  assert.ok(proj.perpFt < 1, `expected near-zero perpFt, got ${proj.perpFt}`);
  assert.ok(
    Math.abs(proj.distFt - shape[1].distFt) < 1,
    `expected distFt ~${shape[1].distFt}, got ${proj.distFt}`,
  );
});

test('projectOntoShape: a point off the line gets a positive perpendicular distance', () => {
  const shape = withCumulativeDistFt(NORTH_LINE);
  // ~0.001 deg east of the midpoint — off-line but alongside it.
  const proj = projectOntoShape(39.96, -82.999, shape);
  assert.ok(proj.perpFt > 100, `expected a meaningful off-line distance, got ${proj.perpFt}`);
  // Should still land near the midpoint's along-shape distance.
  assert.ok(Math.abs(proj.distFt - shape[1].distFt) < shape[2].distFt * 0.1);
});

test('projectOntoShape: a point before the start clamps to distFt 0', () => {
  const shape = withCumulativeDistFt(NORTH_LINE);
  const proj = projectOntoShape(39.94, -83.0, shape);
  assert.equal(proj.distFt, 0);
});

test('projectOntoShape: a point past the end clamps to the shape total length', () => {
  const shape = withCumulativeDistFt(NORTH_LINE);
  const proj = projectOntoShape(39.99, -83.0, shape);
  const total = shape[shape.length - 1].distFt;
  assert.ok(Math.abs(proj.distFt - total) < 1e-6);
});

test('projectOntoShape: monotonic walk along the line gives increasing distFt', () => {
  const shape = withCumulativeDistFt(NORTH_LINE);
  const lats = [39.951, 39.955, 39.961, 39.965];
  const dists = lats.map((lat) => projectOntoShape(lat, -83.0, shape).distFt);
  for (let i = 1; i < dists.length; i++) assert.ok(dists[i] > dists[i - 1]);
});
