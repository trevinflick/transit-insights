const test = require('node:test');
const assert = require('node:assert/strict');
const { formatGtfsTimeOfDay } = require('../../src/shared/format');

test('formatGtfsTimeOfDay: morning and afternoon times', () => {
  assert.equal(formatGtfsTimeOfDay('05:57:00'), '5:57 AM');
  assert.equal(formatGtfsTimeOfDay('13:03:00'), '1:03 PM');
});

test('formatGtfsTimeOfDay: noon and midnight boundaries', () => {
  assert.equal(formatGtfsTimeOfDay('12:00:00'), '12:00 PM');
  assert.equal(formatGtfsTimeOfDay('00:00:00'), '12:00 AM');
});

test("formatGtfsTimeOfDay: owl trip past 24h wraps to the next day's clock time", () => {
  assert.equal(formatGtfsTimeOfDay('25:30:00'), '1:30 AM');
});

test('formatGtfsTimeOfDay: malformed input is returned as-is rather than throwing', () => {
  assert.equal(formatGtfsTimeOfDay('not-a-time'), 'not-a-time');
  assert.equal(formatGtfsTimeOfDay(null), null);
});
