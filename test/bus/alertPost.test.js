const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAlertPostText } = require('../../src/bus/alertPost');
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
