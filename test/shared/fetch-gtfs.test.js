const test = require('node:test');
const assert = require('node:assert/strict');
const {
  computeBusDominantOrigin,
  BUS_DOMINANCE_THRESHOLD,
  resolveServiceDayTypes,
  computeFallbackHeadway,
  resolveHourlyHeadway,
} = require('../../scripts/fetch-gtfs');

function mkTrips(spec) {
  const tripMeta = new Map();
  const firstStopId = new Map();
  let n = 0;
  for (const { route, dir, origin, count, mode = 'bus' } of spec) {
    for (let i = 0; i < count; i++) {
      const id = `T${n++}`;
      tripMeta.set(id, { route, dir, mode });
      firstStopId.set(id, origin);
    }
  }
  return { tripMeta, firstStopId };
}

test('threshold constant is 60%', () => {
  assert.equal(BUS_DOMINANCE_THRESHOLD, 0.6);
});

test('dominance locks onto the main origin when it carries >=60% of trips', () => {
  const { tripMeta, firstStopId } = mkTrips([
    { route: '55', dir: '0', origin: 'MAIN', count: 80 },
    { route: '55', dir: '0', origin: 'GARAGE', count: 20 },
  ]);
  const dom = computeBusDominantOrigin(tripMeta, firstStopId);
  assert.equal(dom.get('55|0'), 'MAIN');
});

test('dominance skips the key when the top origin is under 60% (keeps all origins)', () => {
  const { tripMeta, firstStopId } = mkTrips([
    { route: '66', dir: '1', origin: 'A', count: 50 },
    { route: '66', dir: '1', origin: 'B', count: 50 },
  ]);
  const dom = computeBusDominantOrigin(tripMeta, firstStopId);
  assert.equal(dom.has('66|1'), false);
});

test('exactly 60% qualifies (>= threshold, not strictly greater)', () => {
  const { tripMeta, firstStopId } = mkTrips([
    { route: '77', dir: '0', origin: 'MAIN', count: 6 },
    { route: '77', dir: '0', origin: 'ALT', count: 4 },
  ]);
  const dom = computeBusDominantOrigin(tripMeta, firstStopId);
  assert.equal(dom.get('77|0'), 'MAIN');
});

test('trips missing an origin are skipped without crashing', () => {
  const tripMeta = new Map([
    ['T1', { route: '9', dir: '0', mode: 'bus' }],
    ['T2', { route: '9', dir: '0', mode: 'bus' }],
    ['T3', { route: '9', dir: '0', mode: 'bus' }],
  ]);
  const firstStopId = new Map([
    ['T1', 'X'],
    ['T2', 'X'],
  ]); // T3 has no origin
  const dom = computeBusDominantOrigin(tripMeta, firstStopId);
  assert.equal(dom.get('9|0'), 'X');
});

const WEEKDAY_CAL = {
  service_id: 'REG',
  monday: '1',
  tuesday: '1',
  wednesday: '1',
  thursday: '1',
  friday: '1',
  saturday: '0',
  sunday: '0',
  start_date: '20260101',
  end_date: '20261231',
};
const SUNDAY_CAL = {
  service_id: 'SUN',
  monday: '0',
  tuesday: '0',
  wednesday: '0',
  thursday: '0',
  friday: '0',
  saturday: '0',
  sunday: '1',
  start_date: '20260101',
  end_date: '20261231',
};

test('calendar_dates exception_type=2 removes the regular service_id on the target date', () => {
  const { serviceDayType, removeForToday } = resolveServiceDayTypes({
    calendars: [WEEKDAY_CAL],
    calendarDates: [{ date: '20260525', service_id: 'REG', exception_type: '2' }],
    todayStr: '20260525',
    todayDow: 'Mon',
  });
  assert.equal(serviceDayType.has('REG'), false);
  assert.equal(removeForToday.has('REG'), true);
});

test('calendar_dates exception_type=1 adds a holiday-only service_id', () => {
  const { serviceDayType, addForToday } = resolveServiceDayTypes({
    calendars: [WEEKDAY_CAL],
    calendarDates: [
      { date: '20260525', service_id: 'REG', exception_type: '2' },
      { date: '20260525', service_id: 'HOLIDAY', exception_type: '1' },
    ],
    todayStr: '20260525',
    todayDow: 'Mon',
  });
  assert.equal(serviceDayType.get('HOLIDAY'), 'weekday');
  assert.equal(addForToday.has('HOLIDAY'), true);
  assert.equal(serviceDayType.has('REG'), false);
});

test('calendar_dates exceptions for other dates are ignored', () => {
  const { serviceDayType } = resolveServiceDayTypes({
    calendars: [WEEKDAY_CAL],
    calendarDates: [{ date: '20260526', service_id: 'REG', exception_type: '2' }],
    todayStr: '20260525',
    todayDow: 'Mon',
  });
  assert.equal(serviceDayType.get('REG'), 'weekday');
});

test('added holiday service_id maps to saturday when today is Saturday', () => {
  const { serviceDayType } = resolveServiceDayTypes({
    calendars: [],
    calendarDates: [{ date: '20260704', service_id: 'JULY4', exception_type: '1' }],
    todayStr: '20260704',
    todayDow: 'Sat',
  });
  assert.equal(serviceDayType.get('JULY4'), 'saturday');
});

test('service_ids outside their active date range are still excluded', () => {
  const { serviceDayType } = resolveServiceDayTypes({
    calendars: [{ ...SUNDAY_CAL, start_date: '20260601', end_date: '20260831' }],
    calendarDates: [],
    todayStr: '20260422',
    todayDow: 'Wed',
  });
  assert.equal(serviceDayType.has('SUN'), false);
});

test('staggered two-origin scenario: dominant terminal drives bucketing', () => {
  // Simulates Bug C: a main terminal with 70% of trips plus a garage pullout
  // with 30%. The dominance filter keeps only main-terminal trips downstream
  // so the per-hour headway median reflects the rider-facing schedule.
  const { tripMeta, firstStopId } = mkTrips([
    { route: '20', dir: '0', origin: 'TERMINAL', count: 70 },
    { route: '20', dir: '0', origin: 'GARAGE', count: 30 },
  ]);
  const dom = computeBusDominantOrigin(tripMeta, firstStopId);
  assert.equal(dom.get('20|0'), 'TERMINAL');
});

// --- computeFallbackHeadway: coarse headway for branch-alternating routes --

// Departure seconds-since-midnight for a route alternating between two
// termini every ~15 min (the real Route 33 / CMAX shape) — each branch
// individually never gets 2 same-hour departures, but the route overall
// runs every ~30 min, which is what the fallback should recover.
function depsEveryNMin(startMin, count, stepMin) {
  return Array.from({ length: count }, (_, i) => (startMin + i * stepMin) * 60);
}

test('computeFallbackHeadway: accepts a consistent ~30 min spaced day of departures', () => {
  const deps = depsEveryNMin(300, 30, 30); // 5:00 AM, every 30 min, 30 trips
  assert.equal(computeFallbackHeadway(deps), 30);
});

test('computeFallbackHeadway: rejects a 2-trip AM/PM commuter shuttle (huge gap)', () => {
  const deps = [6 * 3600 + 43 * 60, 17 * 3600 + 3 * 60]; // 6:43 AM, 5:03 PM
  assert.equal(computeFallbackHeadway(deps), null);
});

test('computeFallbackHeadway: rejects fewer than minTrips even if evenly spaced', () => {
  const deps = depsEveryNMin(300, 3, 30); // only 3 trips, default minTrips=4
  assert.equal(computeFallbackHeadway(deps), null);
});

test('computeFallbackHeadway: rejects when the median gap exceeds maxGapMin', () => {
  const deps = depsEveryNMin(300, 5, 150); // 5 trips, 150 min apart
  assert.equal(computeFallbackHeadway(deps), null);
});

test('computeFallbackHeadway: accepts right at the minTrips/maxGapMin boundary', () => {
  const deps = depsEveryNMin(300, 4, 120); // exactly 4 trips, exactly 120 min apart
  assert.equal(computeFallbackHeadway(deps), 120);
});

test('computeFallbackHeadway: custom minTrips/maxGapMin thresholds are honored', () => {
  const deps = depsEveryNMin(300, 3, 45);
  assert.equal(computeFallbackHeadway(deps, { minTrips: 3 }), 45);
  assert.equal(computeFallbackHeadway(deps, { minTrips: 3, maxGapMin: 30 }), null);
});

test('computeFallbackHeadway: null/empty input returns null', () => {
  assert.equal(computeFallbackHeadway(null), null);
  assert.equal(computeFallbackHeadway([]), null);
});

test('computeFallbackHeadway: unsorted input is sorted before measuring gaps', () => {
  const deps = depsEveryNMin(300, 6, 20);
  const shuffled = [deps[3], deps[0], deps[5], deps[1], deps[4], deps[2]];
  assert.equal(computeFallbackHeadway(shuffled), 20);
});

// --- resolveHourlyHeadway: per-(pattern,hour) headway, robust to paired departures --

function mkTimes(minuteOffsets) {
  return minuteOffsets.map((m) => m * 60);
}

test('resolveHourlyHeadway: evenly-spaced departures use the plain median', () => {
  // 4 departures, 15 min apart — the common case.
  assert.equal(resolveHourlyHeadway(mkTimes([0, 15, 30, 45])), 15);
});

test('resolveHourlyHeadway: real Route 8 pairing (8,21,8) resolves to the count-based ~15, not the median 8', () => {
  // The actual confirmed-bad case: COTA's PDF timetable says every 15 min;
  // GTFS shows two buses ~8 min apart then a ~21 min gap before the next
  // pair. Median-of-gaps would read 8 (the more common short gap) — wrong.
  const times = mkTimes([13, 21, 42, 50]); // gaps: 8, 21, 8
  assert.equal(resolveHourlyHeadway(times), 15);
});

test('resolveHourlyHeadway: mild jitter stays under the threshold and keeps the median', () => {
  // gaps of 15 and 20 — a 1.33x ratio, ordinary scheduling jitter, not pairing.
  const times = mkTimes([0, 15, 35]);
  assert.equal(resolveHourlyHeadway(times), 17.5);
});

test('resolveHourlyHeadway: exactly one gap (2 departures) never triggers the irregularity check', () => {
  // Nothing to compare a lone gap against — keep the literal gap, no count-based override.
  assert.equal(resolveHourlyHeadway(mkTimes([0, 16])), 16);
});

test('resolveHourlyHeadway: custom irregularRatioThreshold is honored', () => {
  const times = mkTimes([0, 10, 25]); // gaps: 10, 15 -> ratio 1.5
  assert.equal(resolveHourlyHeadway(times), 12.5); // default threshold (2) keeps median
  assert.equal(resolveHourlyHeadway(times, { irregularRatioThreshold: 1.4 }), 20); // 60/3, count-based
});

test('resolveHourlyHeadway: fewer than 2 departures returns null', () => {
  assert.equal(resolveHourlyHeadway([]), null);
  assert.equal(resolveHourlyHeadway(mkTimes([0])), null);
  assert.equal(resolveHourlyHeadway(null), null);
});

test('resolveHourlyHeadway: unsorted input is sorted before measuring gaps', () => {
  const times = mkTimes([30, 0, 45, 15]);
  assert.equal(resolveHourlyHeadway(times), 15);
});
