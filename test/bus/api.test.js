const test = require('node:test');
const assert = require('node:assert/strict');
const { cardinalBound, parseGtfsStartTime, predictionsFromFeed } = require('../../src/bus/api');

test('cardinalBound: due north bearing', () => {
  assert.equal(cardinalBound(0), 'Northbound');
  assert.equal(cardinalBound(360), 'Northbound');
});

test('cardinalBound: due east/south/west bearings', () => {
  assert.equal(cardinalBound(90), 'Eastbound');
  assert.equal(cardinalBound(180), 'Southbound');
  assert.equal(cardinalBound(270), 'Westbound');
});

test('cardinalBound: buckets to the nearest cardinal, not just floor', () => {
  // 46 is closer to East (90) than North (0/360) once bucketed in 90-wide bins
  // centered on each cardinal (i.e. the boundary sits at 45, not 90).
  assert.equal(cardinalBound(44), 'Northbound');
  assert.equal(cardinalBound(46), 'Eastbound');
  assert.equal(cardinalBound(134), 'Eastbound');
  assert.equal(cardinalBound(136), 'Southbound');
});

test('cardinalBound: negative bearing normalizes into range', () => {
  assert.equal(cardinalBound(-90), 'Westbound');
});

test('parseGtfsStartTime: parses HH:MM:SS into seconds since midnight', () => {
  assert.equal(parseGtfsStartTime('00:00:00'), 0);
  assert.equal(parseGtfsStartTime('14:46:00'), 14 * 3600 + 46 * 60);
});

test('parseGtfsStartTime: handles owl trips past 24h', () => {
  assert.equal(parseGtfsStartTime('25:15:00'), 25 * 3600 + 15 * 60);
});

test('parseGtfsStartTime: null/malformed input returns null', () => {
  assert.equal(parseGtfsStartTime(null), null);
  assert.equal(parseGtfsStartTime(''), null);
  assert.equal(parseGtfsStartTime('not-a-time'), null);
});

function mkFeed(vehicleId, stopTimeUpdate) {
  return { entity: [{ tripUpdate: { vehicle: { id: vehicleId }, stopTimeUpdate } }] };
}

test('predictionsFromFeed: finds the entity matching vid and maps stop predictions', () => {
  const now = 1_000_000_000_000;
  const feed = mkFeed('11302', [
    { stopId: 'A', arrival: { time: now / 1000 + 5 * 60 } },
    { stopId: 'B', arrival: { time: now / 1000 + 12 * 60 } },
  ]);
  const preds = predictionsFromFeed(feed, '11302', now);
  assert.deepEqual(preds, [
    { stpid: 'A', prdctdn: '5' },
    { stpid: 'B', prdctdn: '12' },
  ]);
});

test('predictionsFromFeed: unknown vid returns empty array', () => {
  const feed = mkFeed('11302', [{ stopId: 'A', arrival: { time: 1000 } }]);
  assert.deepEqual(predictionsFromFeed(feed, '99999', 0), []);
});

test('predictionsFromFeed: imminent/past arrivals read as DUE', () => {
  const now = 1_000_000_000_000;
  const feed = mkFeed('11302', [
    { stopId: 'A', arrival: { time: now / 1000 } }, // right now
    { stopId: 'B', arrival: { time: now / 1000 - 60 } }, // 1 min ago
  ]);
  const preds = predictionsFromFeed(feed, '11302', now);
  assert.deepEqual(preds, [
    { stpid: 'A', prdctdn: 'DUE' },
    { stpid: 'B', prdctdn: 'DUE' },
  ]);
});

test('predictionsFromFeed: falls back to departure time when arrival is absent', () => {
  const now = 1_000_000_000_000;
  const feed = mkFeed('11302', [{ stopId: 'A', departure: { time: now / 1000 + 3 * 60 } }]);
  assert.deepEqual(predictionsFromFeed(feed, '11302', now), [{ stpid: 'A', prdctdn: '3' }]);
});

test('predictionsFromFeed: skips stop updates with no usable time or stopId', () => {
  const now = 1_000_000_000_000;
  const feed = mkFeed('11302', [{ stopId: null, arrival: { time: now / 1000 } }, { stopId: 'A' }]);
  assert.deepEqual(predictionsFromFeed(feed, '11302', now), []);
});
