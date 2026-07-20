const test = require('node:test');
const assert = require('node:assert/strict');
const { bucket, formatRangeLabel, rangeForWindow } = require('../../src/shared/recap');

test('bucket groups events at the same coords and counts sources', () => {
  const events = [
    { near_stop: 'A', source: 'bunching' },
    { near_stop: 'A', source: 'gap' },
    { near_stop: 'A', source: 'gap' },
    { near_stop: 'B', source: 'bunching' },
  ];
  const resolve = (ev) =>
    ev.near_stop === 'A' ? { lat: 41.9, lon: -87.6 } : { lat: 41.8, lon: -87.7 };
  const out = bucket(events, resolve);
  assert.equal(out.length, 2);
  assert.equal(out[0].label, 'A');
  assert.equal(out[0].count, 3);
  assert.equal(out[0].bunching, 1);
  assert.equal(out[0].gap, 2);
  assert.equal(out[1].label, 'B');
  assert.equal(out[1].count, 1);
});

test('bucket sorts by count descending', () => {
  const events = [
    { near_stop: 'Low', source: 'gap' },
    { near_stop: 'High', source: 'gap' },
    { near_stop: 'High', source: 'gap' },
    { near_stop: 'High', source: 'gap' },
  ];
  const resolve = (ev) => ({ lat: ev.near_stop === 'High' ? 41 : 42, lon: -87 });
  const out = bucket(events, resolve);
  assert.equal(out[0].label, 'High');
  assert.equal(out[0].count, 3);
  assert.equal(out[1].label, 'Low');
});

test('bucket skips events that do not resolve to a location', () => {
  const events = [
    { near_stop: 'Known', source: 'gap' },
    { near_stop: 'Unknown', source: 'gap' },
  ];
  const resolve = (ev) => (ev.near_stop === 'Known' ? { lat: 41, lon: -87 } : null);
  const out = bucket(events, resolve);
  assert.equal(out.length, 1);
  assert.equal(out[0].label, 'Known');
});

test('formatRangeLabel collapses same-month ranges', () => {
  assert.equal(
    formatRangeLabel({ year: 2026, month: 4, day: 1 }, { year: 2026, month: 4, day: 30 }),
    'Apr 1 – 30',
  );
});

test('formatRangeLabel spells both months when the range crosses a month boundary', () => {
  assert.equal(
    formatRangeLabel({ year: 2026, month: 3, day: 25 }, { year: 2026, month: 4, day: 23 }),
    'Mar 25 – Apr 23',
  );
});

test('formatRangeLabel includes years when the range crosses years', () => {
  assert.equal(
    formatRangeLabel({ year: 2025, month: 12, day: 1 }, { year: 2026, month: 1, day: 1 }),
    'Dec 1, 2025 – Jan 1, 2026',
  );
});

test('rangeForWindow month handles February leap-year boundary', () => {
  // 2024 is a leap year — Feb has 29 days.
  const r2024 = rangeForWindow('month', Date.UTC(2024, 2, 1, 15));
  assert.equal(r2024.label, 'Feb 1 – 29');
  // 2026 is not — Feb has 28 days.
  const r2026 = rangeForWindow('month', Date.UTC(2026, 2, 1, 15));
  assert.equal(r2026.label, 'Feb 1 – 28');
});

test('rangeForWindow month on Jan 1 covers the prior December with year', () => {
  const r = rangeForWindow('month', Date.UTC(2026, 0, 1, 15));
  assert.equal(r.label, 'Dec 1 – 31, 2025');
});

test('rangeForWindow week covers the 7 full days ending yesterday, not the post day', () => {
  // Sunday Jul 19 2026, 10:20 AM ET (14:20 UTC) — when bus-recap --window=week runs.
  const r = rangeForWindow('week', Date.UTC(2026, 6, 19, 14, 20));
  // Reports the prior week (Jul 12–18), excluding the post day (Jul 19).
  assert.equal(r.label, 'Jul 12 – 18');
  // Window is exactly 7 calendar days, aligned to ET midnight boundaries.
  assert.equal(r.until - r.since, 7 * 24 * 60 * 60 * 1000);
});
