const { test } = require('node:test');
const assert = require('node:assert');

const lines = require('../../src/metra/lines');
const { parsePosition, parseTripUpdate, parseAlert } = require('../../src/metra/api');
const {
  parseGtfsTime,
  buildLineGeometry,
  buildLineStations,
} = require('../../scripts/fetch-metra-gtfs');

// --- lines.js ---

test('all 11 lines have a name, color, and text color', () => {
  assert.strictEqual(lines.ALL_LINES.length, 11);
  for (const l of lines.ALL_LINES) {
    assert.ok(lines.LINE_NAMES[l], `${l} has a name`);
    assert.match(lines.LINE_COLORS[l], /^[0-9A-F]{6}$/i, `${l} color is a hex`);
    assert.match(lines.LINE_TEXT_COLORS[l], /^[0-9A-F]{6}$/i, `${l} text color is a hex`);
  }
});

test('lineLabel falls back to the raw id for unknown lines', () => {
  assert.strictEqual(lines.lineLabel('UP-N'), 'Union Pacific North');
  assert.strictEqual(lines.lineLabel('ZZ'), 'ZZ');
});

test('webKey lowercases the route id and is null-safe', () => {
  assert.strictEqual(lines.webKey('MD-W'), 'md-w');
  assert.strictEqual(lines.webKey(null), null);
});

// --- api.js normalizers (decoded-entity shaped inputs) ---

test('parsePosition pulls trip, position, vehicle, and timestamp', () => {
  const entity = {
    vehicle: {
      trip: { tripId: 'BNSF_BN1272_V2_B', routeId: 'BNSF', scheduleRelationship: 0 },
      position: { latitude: 41.85, longitude: -87.9, bearing: 270 },
      vehicle: { id: '8474', label: '1272' },
      timestamp: 1781043109,
    },
  };
  const p = parsePosition(entity);
  assert.strictEqual(p.tripId, 'BNSF_BN1272_V2_B');
  assert.strictEqual(p.routeId, 'BNSF');
  assert.strictEqual(p.label, '1272');
  assert.strictEqual(p.scheduleRelationship, 'SCHEDULED');
  assert.strictEqual(p.lat, 41.85);
  assert.strictEqual(p.ts, 1781043109);
});

test('parsePosition returns null when there is no vehicle payload', () => {
  assert.strictEqual(parsePosition({ tripUpdate: {} }), null);
});

test('parseTripUpdate maps stop updates and CANCELED relationship', () => {
  const entity = {
    tripUpdate: {
      trip: { tripId: 'UP-W_UW60_V2_B', routeId: 'UP-W', scheduleRelationship: 3 },
      vehicle: { label: '60' },
      timestamp: 1781043173,
      stopTimeUpdate: [
        { stopSequence: 1, stopId: 'ELBURN', scheduleRelationship: 2 },
        {
          stopSequence: 28,
          stopId: 'CUS',
          scheduleRelationship: 0,
          arrival: { time: 1781043533, delay: 120 },
        },
      ],
    },
  };
  const tu = parseTripUpdate(entity);
  assert.strictEqual(tu.tripId, 'UP-W_UW60_V2_B');
  assert.strictEqual(tu.scheduleRelationship, 'CANCELED');
  assert.strictEqual(tu.stopUpdates.length, 2);
  assert.strictEqual(tu.stopUpdates[0].scheduleRelationship, 'NO_DATA');
  assert.strictEqual(tu.stopUpdates[1].arrivalTime, 1781043533);
  assert.strictEqual(tu.stopUpdates[1].delay, 120);
});

test('parseAlert extracts informed entity, effect, and translated text', () => {
  const entity = {
    id: 'DevAPI-1',
    alert: {
      informedEntity: [{ agencyId: 'METRA', routeId: 'NCS' }],
      cause: 1,
      effect: 8,
      headerText: { translation: [{ text: 'NCS - ADA Accessibility', language: 'en' }] },
      descriptionText: { translation: [{ text: 'Station construction.', language: 'en' }] },
    },
  };
  const a = parseAlert(entity);
  assert.strictEqual(a.id, 'DevAPI-1');
  assert.strictEqual(a.informedEntities[0].routeId, 'NCS');
  assert.strictEqual(a.header, 'NCS - ADA Accessibility');
  assert.strictEqual(a.description, 'Station construction.');
  // effect 8 is UNKNOWN_EFFECT in the GTFS-rt enum — Metra's common default.
  assert.strictEqual(a.effect, 'UNKNOWN_EFFECT');
});

// --- fetch-metra-gtfs.js pure helpers ---

test('parseGtfsTime handles >24h times and blanks', () => {
  assert.strictEqual(parseGtfsTime('04:08:00'), 4 * 3600 + 8 * 60);
  assert.strictEqual(parseGtfsTime('25:15:00'), 25 * 3600 + 15 * 60);
  assert.strictEqual(parseGtfsTime(''), null);
  assert.strictEqual(parseGtfsTime(null), null);
});

test('buildLineGeometry groups every shape used by a line into polylines', () => {
  const trips = {
    t1: { route_id: 'BNSF', shape_id: 'BNSF_IB_1' },
    t2: { route_id: 'BNSF', shape_id: 'BNSF_OB_1' },
    t3: { route_id: 'BNSF', shape_id: 'BNSF_IB_1' }, // dup shape — collapses
  };
  const byShape = new Map([
    [
      'BNSF_IB_1',
      [
        { seq: 2, lat: 41.7, lon: -88.3 },
        { seq: 4, lat: 41.8, lon: -88.2 },
      ],
    ],
    [
      'BNSF_OB_1',
      [
        { seq: 2, lat: 41.8, lon: -88.2 },
        { seq: 4, lat: 41.7, lon: -88.3 },
      ],
    ],
  ]);
  const geo = buildLineGeometry(trips, byShape);
  assert.strictEqual(geo.BNSF.length, 2);
  assert.deepStrictEqual(geo.BNSF[0][0], [41.7, -88.3]);
});

test('buildLineStations uses the longest trip and maps through stops', () => {
  const trips = {
    short: { route_id: 'UP-W', stop_times: [{ stop_id: 'A', stop_sequence: 1 }] },
    long: {
      route_id: 'UP-W',
      stop_times: [
        { stop_id: 'A', stop_sequence: 1 },
        { stop_id: 'B', stop_sequence: 2 },
      ],
    },
  };
  const stops = {
    A: { name: 'Elburn', lat: 41.8, lon: -88.5 },
    B: { name: 'La Fox', lat: 41.9, lon: -88.4 },
  };
  const st = buildLineStations(trips, stops);
  assert.strictEqual(st['UP-W'].length, 2);
  assert.deepStrictEqual(st['UP-W'][0], { id: 'A', name: 'Elburn', lat: 41.8, lon: -88.5 });
});
