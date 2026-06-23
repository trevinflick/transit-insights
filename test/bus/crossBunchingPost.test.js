const test = require('node:test');
const assert = require('node:assert/strict');
const { detectCrossRouteBunches } = require('../../src/bus/crossBunching');
const { buildPostText, buildAltText } = require('../../src/bus/crossBunchingPost');
const { graphemeLength, POST_MAX_CHARS } = require('../../src/shared/post');
const { bus, FRESH } = require('../helpers');

const FT_PER_MILLIDEG_LAT = 365;
const dLatForFt = (ft) => ft / FT_PER_MILLIDEG_LAT / 1000;
const at = (vid, route, ft) =>
  bus({ vid, route, pid: `p${route}`, lat: 41.9 + dLatForFt(ft), lon: -87.65 });

// detectCrossRouteBunches is only used here as a fixture builder for post-text
// formatting tests, unrelated to its route-combo allowlist policy — disable
// that gate so arbitrary fake routes (22/36/8) still produce a cluster.

test('headline names the place and route count; groups buses by route', () => {
  const vs = [at('5678', '22', 0), at('1234', '36', 200), at('1235', '36', 400)];
  const [cluster] = detectCrossRouteBunches(vs, { now: FRESH, allowedRouteSets: null });
  const text = buildPostText(cluster, { placeName: 'Clark & Belmont' }, []);
  assert.match(text, /3 buses from 2 routes bunched near Clark & Belmont/);
  // Bigger group (Route 36, ×2) listed first, with keycap disc numbers.
  const route36Idx = text.indexOf('Route 36');
  const route22Idx = text.indexOf('Route 22');
  assert.ok(route36Idx > -1 && route22Idx > route36Idx, 'Route 36 listed before Route 22');
  assert.match(text, /#1234 \(1️⃣\)/);
  assert.match(text, /#5678 \(3️⃣\)/);
});

test('appends callouts when present', () => {
  const vs = [at('a', '22', 0), at('b', '36', 200), at('c', '8', 400)];
  const [cluster] = detectCrossRouteBunches(vs, { now: FRESH, allowedRouteSets: null });
  const text = buildPostText(cluster, { placeName: 'X & Y' }, ['biggest pileup in 30 days']);
  assert.match(text, /📊 biggest pileup in 30 days/);
});

test('alt text lists the routes and span', () => {
  const vs = [at('a', '22', 0), at('b', '36', 200), at('c', '8', 400)];
  const [cluster] = detectCrossRouteBunches(vs, { now: FRESH, allowedRouteSets: null });
  const alt = buildAltText(cluster, { placeName: 'X & Y' });
  assert.match(alt, /Route 22/);
  assert.match(alt, /3 buses from 3 routes/);
});

// A downtown convergence of many routes (real COTA case: 20 buses / 11 routes
// at once near High & Broad) used to list every bus on every route and blow
// past Bluesky's 300-grapheme cap, crashing the post call outright instead
// of posting. buildPostText must always stay under the cap, keeping the
// biggest groups and summarizing the rest.
test('buildPostText truncates a large multi-route cluster instead of exceeding the post limit', () => {
  const routes = ['001', '002', '003', '004', '005', '007', '008', '009', '010', '011', '102'];
  const vehicles = [];
  let vid = 1000;
  for (let i = 0; i < 20; i++)
    vehicles.push({ vid: String(vid++), route: routes[i % routes.length] });
  const cluster = { vehicles, routes, routeCount: routes.length, spanFt: 800 };
  const text = buildPostText(cluster, { placeName: 'High Street & Broad Street' }, [
    'biggest pileup in 30 days',
  ]);
  assert.ok(graphemeLength(text) <= POST_MAX_CHARS);
  assert.match(text, /…and \d+ more routes?/);
  assert.match(text, /20 buses from 11 routes bunched/);
  assert.match(text, /📊 biggest pileup in 30 days/);
});

test('buildPostText does not truncate a cluster that already fits', () => {
  const vs = [at('a', '22', 0), at('b', '36', 200), at('c', '8', 400)];
  const [cluster] = detectCrossRouteBunches(vs, { now: FRESH, allowedRouteSets: null });
  const text = buildPostText(cluster, { placeName: 'X & Y' }, []);
  assert.doesNotMatch(text, /…and/);
});
