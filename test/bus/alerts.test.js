const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeAlert,
  isAdmittedAlert,
  isStillActive,
  MAX_DURATION_SEC,
} = require('../../src/bus/alerts');

// Real shapes pulled from COTA's live Alert/Alerts.pb feed during research —
// see AGENTS.md's "Deferred" section and the plan that built this gate.

test('normalizeAlert: protobuf-shaped entity (Long fields, translation arrays) normalizes to plain data', () => {
  const entity = {
    id: '45287',
    alert: {
      effect: 2,
      cause: 9,
      activePeriod: [
        { start: { toNumber: () => 1782471120 }, end: { toNumber: () => 1782492900 } },
      ],
      informedEntity: [
        { routeId: '007', stopId: 'INTSAWW' },
        { routeId: '007', stopId: 'PORGRON' },
        { routeId: '007', stopId: 'INTSAWW' }, // duplicate stop, same route
      ],
      headerText: {
        translation: [
          { text: 'Cancelled stops on Route 007 NORTHEAST, SOUTHWEST.', language: 'en' },
        ],
      },
      descriptionText: {
        translation: [
          {
            text: 'Cancelled stops on Route 007 NORTHEAST, SOUTHWEST Block 0707 between INTERNATIONAL GATEWAY & SAWYER RD at 6:52 AM and E MOUND ST & S 4TH ST at 12:55 PM.',
            language: 'en',
          },
        ],
      },
    },
  };
  const alert = normalizeAlert(entity);
  assert.equal(alert.id, '45287');
  assert.equal(alert.effect, 2);
  assert.equal(alert.cause, 9);
  assert.deepEqual(alert.activePeriods, [{ start: 1782471120, end: 1782492900 }]);
  assert.deepEqual(alert.routeIds, ['007']); // deduped across repeated stop-scoped entries
  assert.equal(alert.headerText, 'Cancelled stops on Route 007 NORTHEAST, SOUTHWEST.');
  assert.match(alert.descriptionText, /Block 0707/);
  assert.deepEqual(alert.cancelledTrips, []); // no .trip on any informedEntity row here
});

// Real shape: a single "cancelled stops" alert had 415 informedEntity rows
// (one per stop the cancelled trip would have served) across just 5 actual
// trips. normalizeAlert must dedupe down to the 5 trips, not 415/204.
test("normalizeAlert: dedupes a whole-block cancellation's many stop-scoped rows down to its actual distinct trips", () => {
  const trips = [
    { tripId: '1051675', startTime: '05:57:00' },
    { tripId: '1051751', startTime: '07:49:00' },
    { tripId: '1051682', startTime: '09:25:00' },
    { tripId: '1051758', startTime: '11:18:00' },
    { tripId: '1051724', startTime: '13:03:00' },
  ];
  const informedEntity = [];
  for (const t of trips) {
    for (let i = 0; i < 80; i++) {
      informedEntity.push({
        routeId: '008',
        stopId: `STOP${i}`,
        trip: {
          tripId: t.tripId,
          startTime: t.startTime,
          startDate: '20260626',
          scheduleRelationship: 'CANCELED',
        },
      });
    }
  }
  const entity = {
    id: '45270',
    alert: {
      effect: 2,
      informedEntity,
      headerText: {
        translation: [{ text: 'Cancelled stops on Route 008 NORTH, SOUTH.', language: 'en' }],
      },
      descriptionText: { translation: [{ text: 'irrelevant for this test', language: 'en' }] },
    },
  };
  const alert = normalizeAlert(entity);
  assert.equal(alert.cancelledTrips.length, 5);
  // Sorted by startTime ascending.
  assert.deepEqual(
    alert.cancelledTrips.map((t) => t.startTime),
    ['05:57:00', '07:49:00', '09:25:00', '11:18:00', '13:03:00'],
  );
});

test('isAdmittedAlert: real short-term REDUCED_SERVICE example (id 45287, ~6h window) is admitted', () => {
  const alert = {
    effect: 2, // REDUCED_SERVICE
    activePeriods: [{ start: 1782471120, end: 1782492900 }], // ~6.05h
  };
  assert.equal(isAdmittedAlert(alert), true);
});

test('isAdmittedAlert: real long-running stop closure (id 29437, S JAMES RD & E BROAD ST, open-ended) is vetoed', () => {
  const alert = {
    effect: 9, // STOP_MOVED
    activePeriods: [{ start: 1741095720, end: 32503698000 }], // COTA's "no defined end" sentinel
  };
  assert.equal(isAdmittedAlert(alert), false);
});

test('isAdmittedAlert: a real long-running DETOUR (id 31617, airport reroute, same sentinel) is vetoed', () => {
  const alert = {
    effect: 4, // DETOUR
    activePeriods: [{ start: 1752507060, end: 32503698000 }],
  };
  assert.equal(isAdmittedAlert(alert), false);
});

test('isAdmittedAlert: boundary — just under 7 days is admitted, exactly 7 days is vetoed', () => {
  const start = 1_700_000_000;
  const justUnder = { effect: 4, activePeriods: [{ start, end: start + MAX_DURATION_SEC - 1 }] };
  const exactly = { effect: 4, activePeriods: [{ start, end: start + MAX_DURATION_SEC }] };
  assert.equal(isAdmittedAlert(justUnder), true);
  assert.equal(isAdmittedAlert(exactly), false);
});

test('isAdmittedAlert: effect outside the admitted set is vetoed regardless of duration', () => {
  const alert = { effect: 1, activePeriods: [{ start: 0, end: 60 }] }; // NO_SERVICE, 1 minute
  assert.equal(isAdmittedAlert(alert), false);
});

test('isAdmittedAlert: an open-ended period (no end at all) is treated as standing and vetoed', () => {
  const alert = { effect: 2, activePeriods: [{ start: 1700000000, end: null }] };
  assert.equal(isAdmittedAlert(alert), false);
});

test('isAdmittedAlert: no active_period at all is treated as standing and vetoed', () => {
  const alert = { effect: 4, activePeriods: [] };
  assert.equal(isAdmittedAlert(alert), false);
});

test('isAdmittedAlert: multiple periods — gated on the longest one present', () => {
  const alert = {
    effect: 4,
    activePeriods: [
      { start: 0, end: 3600 }, // 1h, short
      { start: 10000, end: 10000 + MAX_DURATION_SEC * 2 }, // way over threshold
    ],
  };
  assert.equal(isAdmittedAlert(alert), false);
});

// --- isStillActive: resolution-sweep helper, deliberately independent of the admit gate ---

test('isStillActive: nowMs (epoch ms) within an activePeriod (epoch sec) is active', () => {
  const nowMs = 1_700_000_500_000;
  const alert = { activePeriods: [{ start: 1_700_000_000, end: 1_700_001_000 }] };
  assert.equal(isStillActive(alert, nowMs), true);
});

test('isStillActive: nowMs past every activePeriod is not active', () => {
  const nowMs = 1_700_002_000_000;
  const alert = { activePeriods: [{ start: 1_700_000_000, end: 1_700_001_000 }] };
  assert.equal(isStillActive(alert, nowMs), false);
});

test('isStillActive: an open-ended (no end) period is active for any future now', () => {
  const alert = { activePeriods: [{ start: 1_700_000_000, end: null }] };
  assert.equal(isStillActive(alert, 9_999_999_999_000), true);
});

test('isStillActive: no active_period at all means always active', () => {
  assert.equal(isStillActive({ activePeriods: [] }, Date.now()), true);
});

test('isStillActive: null alert (dropped from the feed entirely) is not active', () => {
  assert.equal(isStillActive(null, Date.now()), false);
});

test('isStillActive: stays active even for an effect/duration the admit gate would now reject (e.g. extended into a standing notice)', () => {
  // A reroute originally short-term, since extended far past the 7-day admit
  // threshold — still genuinely ongoing, so the resolution sweep must not
  // treat it as resolved just because a NEW post wouldn't qualify.
  const nowMs = 1_700_010_000_000;
  const alert = {
    effect: 4,
    activePeriods: [{ start: 1_700_000_000, end: 1_700_000_000 + MAX_DURATION_SEC * 3 }],
  };
  assert.equal(isAdmittedAlert(alert), false);
  assert.equal(isStillActive(alert, nowMs), true);
});
