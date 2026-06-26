const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAlertPostText, buildAlertAltText } = require('../../src/bus/alertPost');
const { graphemeLength, POST_MAX_CHARS } = require('../../src/shared/post');

test("buildAlertPostText: tags the route and passes COTA's own text through", () => {
  const alert = {
    routeIds: ['007'],
    headerText: 'Cancelled stops on Route 007 NORTHEAST, SOUTHWEST.',
    descriptionText:
      'Cancelled stops on Route 007 NORTHEAST, SOUTHWEST Block 0707 between INTERNATIONAL GATEWAY & SAWYER RD at 6:52 AM and E MOUND ST & S 4TH ST at 12:55 PM.',
  };
  const text = buildAlertPostText(alert);
  assert.match(text, /^⚠ Route 7 \(Mt Vernon\) — service alert\n/);
  assert.match(text, /Cancelled stops on Route 007/);
});

test('buildAlertPostText: multiple routes are all tagged', () => {
  const alert = { routeIds: ['002', '101'], headerText: 'Reroute', descriptionText: null };
  const text = buildAlertPostText(alert);
  assert.match(text, /^⚠ Route 2 \(E Main\/N High\), CMAX — service alert/);
});

test('buildAlertPostText: no routeIds falls back to a generic tag', () => {
  const alert = { routeIds: [], headerText: 'System-wide notice', descriptionText: null };
  const text = buildAlertPostText(alert);
  assert.match(text, /^⚠ Service alert\nSystem-wide notice/);
});

test('buildAlertPostText: missing descriptionText omits the second line cleanly', () => {
  const alert = { routeIds: ['008'], headerText: 'Just a headline', descriptionText: null };
  const text = buildAlertPostText(alert);
  assert.equal(text, '⚠ Route 8 (Karl/S High/Parsons) — service alert\nJust a headline');
});

test('buildAlertPostText: stays under the post limit, truncating an oversized body', () => {
  const alert = {
    routeIds: ['023'],
    headerText: 'Long-winded notice',
    descriptionText: 'x'.repeat(400),
  };
  const text = buildAlertPostText(alert);
  assert.ok(graphemeLength(text) <= POST_MAX_CHARS);
  assert.match(text, /…$/);
  assert.match(text, /^⚠ Route 23 \(James-Stelzer\) — service alert\n/);
});

// Whole-trip cancellations: real COTA descriptionText only gives a vague
// "between A at 5:57 AM and B at 1:03 PM" window — riders care which actual
// trips are gone, which the alert data has (cancelledTrips), so this
// replaces the vague description with the precise list.
test('buildAlertPostText: cancelledTrips replaces the vague description with an exact bus-time list', () => {
  const alert = {
    routeIds: ['008'],
    headerText: 'Cancelled stops on Route 008 NORTH, SOUTH.',
    descriptionText:
      'Cancelled stops on Route 008 NORTH, SOUTH Block 0809 between A at 5:57 AM and B at 1:03 PM.',
    cancelledTrips: [
      { tripId: '1051675', startTime: '05:57:00' },
      { tripId: '1051751', startTime: '07:49:00' },
      { tripId: '1051682', startTime: '09:25:00' },
      { tripId: '1051758', startTime: '11:18:00' },
      { tripId: '1051724', startTime: '13:03:00' },
    ],
  };
  const text = buildAlertPostText(alert);
  assert.equal(
    text,
    '⚠ Route 8 (Karl/S High/Parsons) — service alert\n' +
      'Cancelled stops on Route 008 NORTH, SOUTH.\n' +
      '5 buses cancelled today: 5:57 AM, 7:49 AM, 9:25 AM, 11:18 AM, 1:03 PM',
  );
  assert.doesNotMatch(text, /between A at/); // the vague original description is gone
});

test('buildAlertPostText: a single cancelled bus uses singular "bus"', () => {
  const alert = {
    routeIds: ['008'],
    headerText: null,
    descriptionText: null,
    cancelledTrips: [{ tripId: '1', startTime: '14:00:00' }],
  };
  const text = buildAlertPostText(alert);
  assert.match(text, /1 bus cancelled today: 2:00 PM$/);
});

test('buildAlertAltText: names the affected routes', () => {
  const alt = buildAlertAltText({ routeIds: ['008'] });
  assert.equal(
    alt,
    "Map highlighting the Route 8 (Karl/S High/Parsons) route pattern(s) affected by today's service alert.",
  );
});
