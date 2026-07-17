const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isFareWaiverTrigger,
  isNwsAlertOnsetDateReached,
  isNwsAlertActive,
  buildNwsFareWaiverPostText,
} = require('../../src/bus/fareWaiverNws');

// Real shape pulled from the live NWS Alerts API during research (Franklin
// County, OH, zone OHZ046) — see the plan that built this.
const REAL_HEAT_WARNING = {
  id: 'urn:oid:2.49.0.1.840.0.c2eefff4caaa48dcd9648ab383d2241fe8e58931.002.2',
  event: 'Extreme Heat Warning',
  headline:
    'Extreme Heat Warning issued June 30 at 12:43AM EDT until July 2 at 8:00PM EDT by NWS Wilmington OH',
  onset: '2026-06-30T12:00:00-04:00',
  effective: '2026-06-30T00:43:00-04:00',
  expires: '2026-06-30T15:00:00-04:00',
  ends: '2026-07-02T20:00:00-04:00',
  areaDesc: 'Franklin',
};

test('isFareWaiverTrigger: confirmed-live heat/cold advisory/warning event types match', () => {
  for (const event of [
    'Heat Advisory',
    'Extreme Heat Warning',
    'Cold Weather Advisory',
    'Extreme Cold Warning',
  ]) {
    assert.equal(isFareWaiverTrigger({ event }), true, event);
  }
});

test('isFareWaiverTrigger: Watch tiers are excluded (not a declared advisory/warning yet)', () => {
  assert.equal(isFareWaiverTrigger({ event: 'Extreme Heat Watch' }), false);
  assert.equal(isFareWaiverTrigger({ event: 'Extreme Cold Watch' }), false);
});

test('isFareWaiverTrigger: an unrelated event type does not match', () => {
  assert.equal(isFareWaiverTrigger({ event: 'Flood Warning' }), false);
});

// Advisory issued July 14 for July 15 onset — the scenario that triggered the bug fix.
const FUTURE_ONSET_ADVISORY = {
  id: 'urn:oid:2.49.0.1.840.0.abc123.001.1',
  event: 'Heat Advisory',
  headline: 'Heat Advisory issued July 14 at 10:00AM EDT until July 15 at 8:00PM EDT',
  onset: '2026-07-15T12:00:00-04:00', // noon July 15
  effective: '2026-07-14T10:00:00-04:00',
  expires: '2026-07-14T18:00:00-04:00',
  ends: '2026-07-15T20:00:00-04:00',
  areaDesc: 'Franklin',
};

test('isNwsAlertOnsetDateReached: does NOT admit a future-onset advisory (issued day before)', () => {
  // July 14 at any hour — onset date is July 15, not yet reached
  const july14Morning = Date.parse('2026-07-14T09:00:00-04:00');
  const july14Evening = Date.parse('2026-07-14T23:00:00-04:00');
  assert.equal(isNwsAlertOnsetDateReached(FUTURE_ONSET_ADVISORY, july14Morning), false);
  assert.equal(isNwsAlertOnsetDateReached(FUTURE_ONSET_ADVISORY, july14Evening), false);
});

test('isNwsAlertOnsetDateReached: admits on onset date even before the onset clock time', () => {
  // July 15 at 9am — onset is noon July 15, but date has been reached
  const july15Morning = Date.parse('2026-07-15T09:00:00-04:00');
  assert.equal(isNwsAlertOnsetDateReached(FUTURE_ONSET_ADVISORY, july15Morning), true);
});

test('isNwsAlertOnsetDateReached: admits after the onset clock time on onset date', () => {
  const july15Afternoon = Date.parse('2026-07-15T14:00:00-04:00');
  assert.equal(isNwsAlertOnsetDateReached(FUTURE_ONSET_ADVISORY, july15Afternoon), true);
});

test('isNwsAlertOnsetDateReached: admits on days after onset', () => {
  const july16 = Date.parse('2026-07-16T08:00:00-04:00');
  assert.equal(isNwsAlertOnsetDateReached(FUTURE_ONSET_ADVISORY, july16), true);
});

test('isNwsAlertOnsetDateReached: no onset info treated as already in effect', () => {
  assert.equal(isNwsAlertOnsetDateReached({ onset: null, effective: null }, Date.now()), true);
});

test('isNwsAlertOnsetDateReached: null alert returns false', () => {
  assert.equal(isNwsAlertOnsetDateReached(null, Date.now()), false);
});

test('isNwsAlertActive: real live example is active right now (within onset..ends)', () => {
  const now = Date.parse('2026-06-30T18:00:00-04:00'); // mid-afternoon, within the window
  assert.equal(isNwsAlertActive(REAL_HEAT_WARNING, now), true);
});

test('isNwsAlertActive: before onset is not active', () => {
  const now = Date.parse('2026-06-30T01:00:00-04:00'); // after `effective`, before `onset`
  assert.equal(isNwsAlertActive(REAL_HEAT_WARNING, now), false);
});

test('isNwsAlertActive: uses `ends`, not the earlier `expires`, for the active window', () => {
  // expires is 2026-06-30T15:00, ends is 2026-07-02T20:00 -- this moment is
  // past expires but well before ends, and must still read as active.
  const now = Date.parse('2026-07-01T12:00:00-04:00');
  assert.equal(isNwsAlertActive(REAL_HEAT_WARNING, now), true);
});

test('isNwsAlertActive: past `ends` is not active', () => {
  const now = Date.parse('2026-07-03T00:00:00-04:00');
  assert.equal(isNwsAlertActive(REAL_HEAT_WARNING, now), false);
});

test('isNwsAlertActive: falls back to `expires` when `ends` is absent', () => {
  const alert = {
    onset: null,
    effective: '2026-06-30T00:00:00-04:00',
    ends: null,
    expires: '2026-06-30T06:00:00-04:00',
  };
  assert.equal(isNwsAlertActive(alert, Date.parse('2026-06-30T03:00:00-04:00')), true);
  assert.equal(isNwsAlertActive(alert, Date.parse('2026-06-30T07:00:00-04:00')), false);
});

test('isNwsAlertActive: null alert (dropped from the feed) is not active', () => {
  assert.equal(isNwsAlertActive(null, Date.now()), false);
});

test('buildNwsFareWaiverPostText: states the services covered and cites the real trigger', () => {
  const text = buildNwsFareWaiverPostText(REAL_HEAT_WARNING);
  assert.match(text, /^🌡 Free fares — extreme weather alert\n/);
  assert.match(text, /fixed-route buses, Mainstream, and COTA\/\/Plus/);
  assert.match(text, /an Extreme Heat Warning in Franklin County/);
  assert.match(text, /extreme heat warning remains in effect/);
});

test('buildNwsFareWaiverPostText: cold events get the frozen-face emoji, heat events get the thermometer', () => {
  assert.match(buildNwsFareWaiverPostText({ event: 'Cold Weather Advisory' }), /^🥶 Free fares/);
  assert.match(buildNwsFareWaiverPostText({ event: 'Extreme Cold Warning' }), /^🥶 Free fares/);
  assert.match(buildNwsFareWaiverPostText({ event: 'Heat Advisory' }), /^🌡 Free fares/);
  assert.match(buildNwsFareWaiverPostText({ event: 'Extreme Heat Warning' }), /^🌡 Free fares/);
});

test('buildNwsFareWaiverPostText: picks "a" vs "an" correctly by event name', () => {
  assert.match(buildNwsFareWaiverPostText({ event: 'Heat Advisory' }), /due to a Heat Advisory/);
  assert.match(
    buildNwsFareWaiverPostText({ event: 'Cold Weather Advisory' }),
    /due to a Cold Weather Advisory/,
  );
  assert.match(
    buildNwsFareWaiverPostText({ event: 'Extreme Cold Warning' }),
    /due to an Extreme Cold Warning/,
  );
});

test('buildNwsFareWaiverPostText: stays under the post limit, truncating an oversized event name', () => {
  const { graphemeLength, POST_MAX_CHARS } = require('../../src/shared/post');
  const alert = { ...REAL_HEAT_WARNING, event: 'X'.repeat(400) };
  const text = buildNwsFareWaiverPostText(alert);
  assert.ok(graphemeLength(text) <= POST_MAX_CHARS);
  assert.match(text, /…$/);
});
