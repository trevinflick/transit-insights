const { test } = require('node:test');
const assert = require('node:assert');

const lines = require('../../src/metra/lines');
const { parsePosition, parseTripUpdate, parseAlert } = require('../../src/metra/api');
const {
  parseGtfsTime,
  buildLineGeometry,
  buildLineStations,
} = require('../../scripts/fetch-metra-gtfs');
const {
  isSignificantMetraAlert,
  alertRelevance,
  buildMetraAlertText,
} = require('../../src/metra/metraAlerts');
const {
  buildLineCorridor,
  buildMetraTracks,
  computeMetraSamples,
  directionLabel,
} = require('../../src/metra/speedmap');

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

// --- metraAlerts.js significance gate ---

function alert({ route = 'BNSF', header = '', description = '', effect = 'UNKNOWN_EFFECT' } = {}) {
  const informedEntities =
    route === null ? [{ agencyId: 'METRA' }] : [{ agencyId: 'METRA', routeId: route }];
  return { id: 'X', informedEntities, effect, header, description };
}

test('alert gate admits a real cancellation', () => {
  assert.ok(
    isSignificantMetraAlert(
      alert({
        header: 'UPW train #56 will not operate',
        description: 'due to a mechanical failure',
      }),
    ),
  );
});

test('alert gate rejects ADA / construction / elevator notices', () => {
  assert.ok(
    !isSignificantMetraAlert(
      alert({
        header: 'NCS - Grayslake ADA Accessibility',
        description: 'use alternate boarding stations during station construction',
      }),
    ),
  );
  assert.ok(!isSignificantMetraAlert(alert({ header: 'Kenosha Elevator Out of Service' })));
  assert.ok(!isSignificantMetraAlert(alert({ header: 'Kedzie Station Construction' })));
});

test('alert gate requires a magnitude for delays (bare "delay" is not major)', () => {
  assert.ok(
    !isSignificantMetraAlert(alert({ description: 'minor delay expected during construction' })),
  );
  assert.ok(
    isSignificantMetraAlert(
      alert({ header: 'Train 334', description: 'operating 22 to 27 minutes behind schedule' }),
    ),
  );
});

test('alert gate admits on a strong structured effect regardless of keywords', () => {
  assert.ok(isSignificantMetraAlert(alert({ header: 'Service note', effect: 'NO_SERVICE' })));
});

test('alertRelevance distinguishes line-scoped from agency-wide', () => {
  assert.deepStrictEqual(alertRelevance(alert({ route: 'ME' })).lines, ['ME']);
  const wide = alertRelevance(alert({ route: null }));
  assert.ok(wide.agencyWide && wide.lines.length === 0 && wide.relevant);
});

test('buildMetraAlertText is Metra-branded and within the post limit', () => {
  const text = buildMetraAlertText(
    alert({ header: 'UPW train #56 will not operate', description: 'x'.repeat(400) }),
  );
  assert.match(text, /Per Metra/);
  assert.ok([...text].length <= 300);
});

// --- speedmap detector ---

test('buildLineCorridor returns the longest polyline for a line', () => {
  const geo = {
    BNSF: [
      [
        [41.7, -88.3],
        [41.71, -88.2],
      ],
      [
        [41.7, -88.3],
        [41.71, -88.2],
        [41.72, -88.1],
        [41.73, -88.0],
      ],
    ],
  };
  const c = buildLineCorridor(geo, 'BNSF');
  assert.strictEqual(c.points.length, 4);
  assert.ok(c.totalFt > 0 && c.cumDist.length === 4);
  assert.strictEqual(buildLineCorridor(geo, 'NOPE'), null);
});

test('buildMetraTracks groups by trip and resolves direction from the index', () => {
  const rows = [
    { ts: 1, trip_id: 'T1', lat: 41.7, lon: -88.3 },
    { ts: 2, trip_id: 'T1', lat: 41.71, lon: -88.2 },
    { ts: 1, trip_id: 'T2', lat: 41.8, lon: -88.1 },
  ];
  const tracks = buildMetraTracks(rows, { T1: { direction_id: 1 }, T2: { direction_id: 0 } });
  assert.strictEqual(tracks.get('T1').get('1').length, 2);
  assert.strictEqual(tracks.get('T2').get('0').length, 1);
});

test('computeMetraSamples yields a plausible mph for a ~0.8mi/60s hop', () => {
  const geo = {
    L: [
      [
        [41.85, -87.9],
        [41.86, -87.9],
        [41.87, -87.9],
        [41.88, -87.9],
      ],
    ],
  };
  const c = buildLineCorridor(geo, 'L');
  const rows = [
    { ts: 0, route: 'L', trip_id: 'T1', lat: 41.852, lon: -87.9 },
    { ts: 60000, route: 'L', trip_id: 'T1', lat: 41.864, lon: -87.9 },
  ];
  const { byDir } = computeMetraSamples(rows, c, { T1: { direction_id: 1 } });
  const samples = byDir.get('1');
  assert.ok(samples && samples.length === 1);
  assert.ok(samples[0].mph > 20 && samples[0].mph < 90, `mph ${samples[0].mph}`);
});

test('directionLabel maps GTFS direction_id to rider labels', () => {
  assert.strictEqual(directionLabel('1'), 'Inbound');
  assert.strictEqual(directionLabel('0'), 'Outbound');
  assert.strictEqual(directionLabel('unknown'), 'Unknown direction');
});
