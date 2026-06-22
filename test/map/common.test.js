const test = require('node:test');
const assert = require('node:assert/strict');
const { thinPolylinePoints } = require('../../src/map/common');

test('thinPolylinePoints: no-op when already at or under the cap', () => {
  const points = [{ lat: 1 }, { lat: 2 }, { lat: 3 }];
  assert.deepEqual(thinPolylinePoints(points, 5), points);
  assert.deepEqual(thinPolylinePoints(points, 3), points);
});

test('thinPolylinePoints: decimates to exactly maxPoints, keeping both endpoints', () => {
  const points = Array.from({ length: 1000 }, (_, i) => ({ lat: i }));
  const thinned = thinPolylinePoints(points, 50);
  assert.equal(thinned.length, 50);
  assert.deepEqual(thinned[0], points[0]);
  assert.deepEqual(thinned[thinned.length - 1], points[points.length - 1]);
});

test('thinPolylinePoints: maxPoints < 2 returns just the first point', () => {
  const points = [{ lat: 1 }, { lat: 2 }, { lat: 3 }];
  assert.deepEqual(thinPolylinePoints(points, 1), [{ lat: 1 }]);
  assert.deepEqual(thinPolylinePoints(points, 0), [{ lat: 1 }]);
});

test('thinPolylinePoints: null/undefined/empty input returns []', () => {
  assert.deepEqual(thinPolylinePoints(null), []);
  assert.deepEqual(thinPolylinePoints(undefined), []);
  assert.deepEqual(thinPolylinePoints([]), []);
});
