const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildPostText,
  buildAltText,
  buildCancellationReplyText,
  buildCancellationReplyAlt,
} = require('../../src/shared/recapPost');

const routeLabel = (r) => `Route ${String(r).replace(/^0+(?=\d)/, '')}`;

const points = [
  { label: 'Foster & Marine Drive', lat: 41.97, lon: -87.64, count: 7, bunching: 1, gap: 6 },
  { label: 'Michigan & Delaware', lat: 41.9, lon: -87.62, count: 6, bunching: 0, gap: 6 },
  { label: 'Western & Pershing', lat: 41.82, lon: -87.69, count: 3, bunching: 3, gap: 0 },
  { label: 'Clark & Grand', lat: 41.89, lon: -87.63, count: 2, bunching: 2, gap: 0 },
];

test('buildPostText names the top-3 worst spots with counts', () => {
  const text = buildPostText({ mode: 'bus', window: 'month', points, totalIncidents: 18 });
  assert.ok(text.includes('🚌'));
  assert.ok(text.includes('this month'));
  assert.ok(text.includes('18 bunches'));
  assert.ok(text.includes('4 stops'));
  assert.ok(text.includes('Foster & Marine Drive (7)'));
  assert.ok(text.includes('Michigan & Delaware (6)'));
  assert.ok(text.includes('Western & Pershing (3)'));
  // 4th spot should NOT be called out.
  assert.ok(!text.includes('Clark & Grand'));
  // No leftover "Worst spots:" heading.
  assert.ok(!text.includes('Worst spots'));
});

test('buildPostText uses singular nouns when counts are 1', () => {
  const text = buildPostText({
    mode: 'train',
    window: 'week',
    points: [{ label: 'North/Clybourn', lat: 41.91, lon: -87.65, count: 1, bunching: 1, gap: 0 }],
    totalIncidents: 1,
  });
  assert.ok(text.includes('1 bunch '));
  assert.ok(text.includes('1 station'));
  assert.ok(!text.includes('1 stations'));
  assert.ok(!text.includes('1 bunches'));
});

test('buildPostText uses train noun and emoji for train mode', () => {
  const text = buildPostText({ mode: 'train', window: 'week', points, totalIncidents: 18 });
  assert.ok(text.includes('🚆'));
  assert.ok(text.includes('this week'));
  assert.ok(text.includes('stations'));
});

test('buildPostText handles an empty window cleanly', () => {
  const text = buildPostText({ mode: 'bus', window: 'week', points: [], totalIncidents: 0 });
  assert.ok(text.includes('No chronic bunching'));
  assert.ok(!text.includes('Worst spots'));
});

test('buildAltText summarizes the map for screen readers', () => {
  const alt = buildAltText({ mode: 'bus', window: 'month', points, totalIncidents: 18 });
  assert.ok(alt.includes('Heatmap of Columbus'));
  assert.ok(alt.includes('18 bunches'));
  assert.ok(alt.includes('4 stops'));
  assert.ok(alt.includes('Foster & Marine Drive (7)'));
});

const cancelSummary = {
  totalCancelled: 1708,
  alertCount: 62,
  activeDays: 6,
  avgPerActiveDay: 284.67,
  peakDay: { label: 'Thu, Jul 16', count: 327 },
  topRoutes: [
    { route: '006', count: 315 },
    { route: '007', count: 264 },
    { route: '008', count: 222 },
    { route: '033', count: 201 },
  ],
};

test('buildCancellationReplyText reports total, average, peak, and top-3 routes', () => {
  const text = buildCancellationReplyText({
    window: 'week',
    windowLabel: 'Jul 11 – 18',
    summary: cancelSummary,
    formatRoute: routeLabel,
  });
  assert.ok(text.includes('🚫'));
  assert.ok(text.includes('Jul 11 – 18'));
  assert.ok(text.includes('1708 scheduled bus trips cancelled across 6 days'));
  assert.ok(text.includes('avg 285/day'));
  assert.ok(text.includes('peak 327 on Thu, Jul 16'));
  assert.ok(text.includes('Route 6 (315)'));
  assert.ok(text.includes('Route 7 (264)'));
  assert.ok(text.includes('Route 8 (222)'));
  // Only top 3 routes are named.
  assert.ok(!text.includes('Route 33'));
  assert.ok(text.includes('real totals may be higher'));
});

test('buildCancellationReplyText handles an empty window cleanly', () => {
  const text = buildCancellationReplyText({
    window: 'week',
    windowLabel: 'Jul 11 – 18',
    summary: { totalCancelled: 0, activeDays: 0, topRoutes: [] },
    formatRoute: routeLabel,
  });
  assert.ok(text.includes('No bus cancellations recorded'));
  assert.ok(!text.includes('Hardest hit'));
});

test('buildCancellationReplyAlt summarizes cancellations for screen readers', () => {
  const alt = buildCancellationReplyAlt({
    window: 'week',
    windowLabel: 'Jul 11 – 18',
    summary: cancelSummary,
    formatRoute: routeLabel,
  });
  assert.ok(alt.includes('1708 scheduled trips cancelled across 6 days'));
  assert.ok(alt.includes('peaking at 327 on Thu, Jul 16'));
  assert.ok(alt.includes('Route 6 (315)'));
});
