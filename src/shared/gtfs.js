const Path = require('node:path');
const Fs = require('fs-extra');
const Database = require('better-sqlite3');
const { haversineFt } = require('./geo');

const INDEX_PATH = Path.join(__dirname, '..', '..', 'data', 'gtfs', 'index.json');
// Warn at 2d because calendar_dates.txt makes the index date-specific — it
// now represents *today*, not a week. Fatal at 7d so a cron outage produces a
// visible failure instead of silent under-reporting against a stale schedule.
const STALE_WARN_MS = 2 * 24 * 60 * 60 * 1000;
const STALE_FATAL_MS = 7 * 24 * 60 * 60 * 1000;

let _index = null;

function loadIndex() {
  if (_index) return _index;
  if (!Fs.existsSync(INDEX_PATH)) {
    throw new Error(`GTFS index not found at ${INDEX_PATH}. Run: node scripts/fetch-gtfs.js`);
  }
  _index = Fs.readJsonSync(INDEX_PATH);
  const age = Date.now() - (_index.generatedAt || 0);
  const days = Math.round(age / (24 * 60 * 60 * 1000));
  if (age > STALE_FATAL_MS) {
    throw new Error(
      `GTFS index is ${days} days old (>${STALE_FATAL_MS / (24 * 60 * 60 * 1000)}d) — re-run scripts/fetch-gtfs.js before retrying`,
    );
  }
  if (age > STALE_WARN_MS) {
    console.warn(
      `GTFS index is ${days} days old — re-run fetch-gtfs.js (calendar_dates makes it date-specific)`,
    );
  }
  return _index;
}

// Day-type bucket for a given instant in Chicago time. Matches the keys
// produced by fetch-gtfs.js (weekday/saturday/sunday/weekend).
function dayTypeFor(now = new Date()) {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
  }).format(now);
  if (weekday === 'Sat') return 'saturday';
  if (weekday === 'Sun') return 'sunday';
  return 'weekday';
}

function chicagoHour(now = new Date()) {
  const h = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    hour12: false,
  }).format(now);
  return parseInt(h, 10);
}

function chicagoMinuteOfHour(now = new Date()) {
  const m = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    minute: '2-digit',
  }).format(now);
  return parseInt(m, 10);
}

// Service-day transition is fuzzy around 4 AM: CTA encodes a trip that runs
// at 1:15 AM Sunday as "25:15:00" under Saturday's service_id, so at 1 AM
// Sunday wall-clock the right bucket is Saturday's. We always consult both
// yesterday's and today's dayType — the only question is which to prefer.
// Before 4 AM: prefer prior (today's service hasn't really started).
// After 4 AM: prefer today (but fall back to prior if today has no entry and
// yesterday's service is still running mid-route).
const LATE_NIGHT_CUTOFF_HOUR = 4;

// Resolve an hourly value from a {dayType: {hour: value}} map. Returns null
// if neither today's nor yesterday's bucket has an entry for the current hour
// — that means "no scheduled service," which callers should treat as "skip,"
// not "interpolate from another hour."
function hourlyLookup(byDayType, now) {
  if (!byDayType) return null;
  const hour = chicagoHour(now);
  const todayDt = dayTypeFor(now);
  const priorDt = dayTypeFor(new Date(now.getTime() - 24 * 60 * 60 * 1000));

  // Before 4 AM, prefer prior day's bucket — yesterday's service is still
  // running its late-night tail (CTA encodes 1:15 AM Sunday as 25:15:00 under
  // Saturday's service_id). After 4 AM, today's bucket is authoritative; do
  // NOT fall back to prior day, because an M-F-only route would otherwise
  // pick up Friday's counts on Saturday morning and look "scheduled."
  const candidates = hour < LATE_NIGHT_CUTOFF_HOUR ? [priorDt, todayDt] : [todayDt];
  if (candidates.some((dt) => dt === 'saturday' || dt === 'sunday')) candidates.push('weekend');

  for (const dt of candidates) {
    const byHour = byDayType[dt];
    if (byHour && byHour[hour] != null) return byHour[hour];
  }
  return null;
}

/**
 * Resolve a pattern to a GTFS direction_id ("0" or "1") by comparing the
 * pattern's last point (the route's end terminal) to each direction's last
 * stop from GTFS. Returns null if the route isn't indexed or if no terminal
 * data exists. Cached by pid since pattern geometry rarely changes.
 */
const _directionCache = new Map();
function resolveDirection(pattern) {
  // Cache positive hits only. Caching null would freeze a "missing route"
  // lookup forever, so a route added to a freshly regenerated index would
  // never resolve in a long-running process.
  const cached = _directionCache.get(pattern.pid);
  if (cached) return cached;
  const index = loadIndex();
  const byDir = index.routes[pattern.route];
  if (!byDir) return null;
  const first = pattern.points[0];
  const end = pattern.points[pattern.points.length - 1];
  // Score each GTFS direction by (end-of-pattern → end terminal) PLUS
  // (start-of-pattern → origin terminal). Short-turn patterns that end mid-
  // route previously scored by end-distance alone and could land on the wrong
  // direction; adding the origin term forces the right pick when origin data
  // is present. Fall back to end-only when origin is absent (older index).
  let best = null;
  let bestScore = Infinity;
  for (const dir of ['0', '1']) {
    const info = byDir[dir];
    if (!info || info.terminalLat == null) continue;
    const endDist = haversineFt({ lat: info.terminalLat, lon: info.terminalLon }, end);
    const originDist =
      info.originLat != null && first
        ? haversineFt({ lat: info.originLat, lon: info.originLon }, first)
        : 0;
    const score = endDist + originDist;
    if (score < bestScore) {
      bestScore = score;
      best = dir;
    }
  }
  if (best) _directionCache.set(pattern.pid, best);
  return best;
}

// Resolve the directional bucket of an indexed bus route, then pull `field`
// (`headways` or `durations`) and look it up by hour. Single source of truth
// for both `expectedHeadwayMin` and `expectedTripMinutes`.
function busLookup(route, pattern, field, now) {
  const index = loadIndex();
  const byDir = index.routes[route];
  if (!byDir) return null;
  const dir = resolveDirection({ ...pattern, route });
  if (!dir) return null;
  const dirInfo = byDir[dir];
  if (!dirInfo?.[field]) return null;
  return hourlyLookup(dirInfo[field], now);
}

// Treat each hour's value as anchored at the hour's midpoint and linearly
// blend toward the neighboring hour based on minute-of-hour. Smooths the
// ramp-down/ramp-up around hour boundaries (e.g. 72 eastbound averages 4.8 min
// in hour 21 but 9.5 min in hour 22 — at 9:50 the indexed value is wildly
// optimistic). Only meaningful for rate-like fields (headways, durations); not
// applied to count-like fields like activeByHour.
function interpolatedHourlyLookup(byDayType, now) {
  const cur = hourlyLookup(byDayType, now);
  if (cur == null) return null;
  const m = chicagoMinuteOfHour(now);
  const offsetMs = (m < 30 ? -1 : 1) * 60 * 60 * 1000;
  const neighbor = hourlyLookup(byDayType, new Date(now.getTime() + offsetMs));
  if (neighbor == null) return cur;
  const alpha = m < 30 ? (30 - m) / 60 : (m - 30) / 60;
  return cur * (1 - alpha) + neighbor * alpha;
}

// Combined origin+dest endpoint distance beyond which a live pattern is judged
// to match NO indexed pattern group, so we fall back to the direction-level
// (dominant pattern) headway rather than snap to a wrong group.
const PATTERN_MATCH_TOLERANCE_FT = 3960; // 0.75 mi

// Match a live pattern to the indexed pattern group (origin→dest) whose
// endpoints are closest. Headway/duration are measured within a single pattern,
// so a group isn't corrupted by short-turns/branches that share the direction
// (the old per-direction median read the 66 at ~6 min vs a true 30). Falls back
// to the direction-level dominant pattern when the route has no pattern list
// (older index) or nothing matches within tolerance.
// Pure: pick the pattern group whose (origin → dest) endpoints best match the
// given first/last points, or null when none is within `tolerance`. Scores
// dest-distance plus origin-distance so a short-turn that shares the origin but
// ends mid-route doesn't snap to the through pattern. Exported for testing.
function matchPattern(patterns, first, last, tolerance = PATTERN_MATCH_TOLERANCE_FT) {
  let best = null;
  let bestScore = Infinity;
  for (const p of patterns || []) {
    if (p.terminalLat == null || !last) continue;
    const destD = haversineFt(
      { lat: p.terminalLat, lon: p.terminalLon },
      { lat: last.lat, lon: last.lon },
    );
    const origD =
      p.originLat != null && first
        ? haversineFt({ lat: p.originLat, lon: p.originLon }, { lat: first.lat, lon: first.lon })
        : 0;
    const score = destD + origD;
    if (score < bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best && bestScore <= tolerance ? best : null;
}

const _patternGroupCache = new Map(); // pid → resolved group
function resolvePatternGroup(pattern) {
  const cached = _patternGroupCache.get(pattern.pid);
  if (cached) return cached;
  const dir = resolveDirection(pattern);
  if (!dir) return null;
  const dirInfo = loadIndex().routes[pattern.route]?.[dir];
  if (!dirInfo) return null;
  if (!dirInfo.patterns?.length) return dirInfo; // older index — direction-level only
  const first = pattern.points[0];
  const last = pattern.points[pattern.points.length - 1];
  // Fall back to the direction-level dominant pattern when nothing matches.
  const resolved = matchPattern(dirInfo.patterns, first, last) || dirInfo;
  _patternGroupCache.set(pattern.pid, resolved);
  return resolved;
}

function expectedHeadwayMin(route, pattern, now = new Date()) {
  const grp = resolvePatternGroup({ ...pattern, route });
  if (!grp?.headways) return null;
  return interpolatedHourlyLookup(grp.headways, now);
}

function expectedTripMinutes(route, pattern, now = new Date()) {
  const grp = resolvePatternGroup({ ...pattern, route });
  if (!grp?.durations) return null;
  return interpolatedHourlyLookup(grp.durations, now);
}

// Ground-truth count of trips scheduled to be in-progress at some point during
// the current hour — the correct target for ghost-vs-observed comparison.
// Replaces `duration / headway`, which was biased during service ramp-up.
function expectedActiveTrips(route, pattern, now = new Date()) {
  return busLookup(route, pattern, 'activeByHour', now);
}

// Route-level active trips: sums activeByHour across every GTFS direction for
// the given route, no pattern required. Returns null when the route is
// unindexed or has no entry for the hour (= no scheduled service). Used by
// speedmap to filter out routes that won't be running during a collection
// window.
function expectedBusRouteActiveTrips(route, now = new Date()) {
  const index = loadIndex();
  const byDir = index.routes[route];
  if (!byDir) return null;
  let sum = 0;
  let any = false;
  for (const dirInfo of Object.values(byDir)) {
    const v = hourlyLookup(dirInfo.activeByHour, now);
    if (v != null) {
      sum += v;
      any = true;
    }
  }
  return any ? sum : null;
}

// Route-level headway, no pattern required. Picks the LONGER scheduled headway
// across directions so that a "no observations" window is sized conservatively
// (longer window → fewer false fires when one direction is much sparser than
// the other). Returns null when the route is unindexed or has no entry for the
// current hour. Used by the thin-gap detector.
function expectedBusRouteHeadwayMin(route, now = new Date()) {
  const index = loadIndex();
  const byDir = index.routes[route];
  if (!byDir) return null;
  let max = null;
  for (const dirInfo of Object.values(byDir)) {
    const v = hourlyLookup(dirInfo.headways, now);
    if (v != null && (max == null || v > max)) max = v;
  }
  return max;
}

// Resolve a trip_id straight off the static index — built by
// scripts/fetch-gtfs.js from trips.txt, keyed exactly as COTA's
// GTFS-realtime feed tags it (no suffix mismatch to normalize, unlike
// Metra). Used by src/bus/api.js to recover a vehicle's true direction_id
// and shape_id: COTA's realtime VehiclePositions reports a direction_id that
// does NOT reliably match the static schedule's for the same trip — confirmed
// against a live sample (realtime said 7, static said 1) — so direction must
// always be resolved this way, never trusted off the live feed.
function getTripMeta(tripId) {
  const index = loadIndex();
  return index.trips?.[tripId] || null;
}

// Ordered [{ lat, lon, distFt }] for a shape_id, built by fetch-gtfs.js from
// shapes.txt with haversine-measured cumulative distance (not GTFS's own
// shape_dist_traveled, which isn't trustworthy-by-default across feeds). Used
// by shapeProjection.js to recover the pdist-equivalent CTA's BusTime API
// gives for free but COTA's GTFS-realtime doesn't.
function getShapePoints(shapeId) {
  const index = loadIndex();
  return index.shapes?.[shapeId] || null;
}

// --- Bus schedule adherence (how late/early a specific bus is) ---
//
// A live vehicle self-reports the scheduled start of the trip it's running
// (getvehicles `stst`/`stsd`, surfaced as schedStartSec/schedStartDate). That
// plus the route uniquely identifies the GTFS trip — its first-stop
// departure_time equals stst — so we never have to guess which scheduled trip a
// bus belongs to. This is what makes adherence work even inside a bunch, where
// several buses sit at the same place at the same time: each carries its own
// anchor. The per-trip scheduled (stop position → time) curves live in the
// SQLite schedule built by scripts/fetch-gtfs.js (too large for index.json).

const SCHED_DB_PATH =
  process.env.GTFS_SCHEDULE_DB_PATH ||
  Path.join(__dirname, '..', '..', 'data', 'gtfs', 'schedule.sqlite');
// Equirectangular ft-per-degree, good enough for the few-hundred-foot
// projection distances we care about (matches geo.js's EARTH_RADIUS_FT).
const R_FT = 20902231;
const FT_PER_DEG = (Math.PI / 180) * R_FT;
// Beyond this from the trip's stop path the bus isn't credibly on this trip
// (GPS junk, wrong-trip match, off-route deadhead) — we omit rather than guess.
const MAX_OFFROUTE_FT = 600;
// Adherence larger than this is almost always a bad match or a service-day
// wrap (after-midnight trips the daily index doesn't carry); omit instead.
const MAX_PLAUSIBLE_DEV_MIN = 45;

let _schedDb; // undefined = not tried, null = absent, else Database
let _schedStmt = null;
function schedDb() {
  if (_schedDb !== undefined) return _schedDb;
  _schedDb = Fs.existsSync(SCHED_DB_PATH)
    ? new Database(SCHED_DB_PATH, { readonly: true, fileMustExist: true })
    : null;
  return _schedDb;
}

// Seconds since midnight in Chicago wall-clock for `now`. Matches the base of
// GTFS scheduled times (and stst) for daytime trips; the plausibility cap above
// absorbs the after-midnight service-day wrap that this doesn't model.
function chicagoSecondsOfDay(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const g = (k) => +parts.find((p) => p.type === k).value;
  return (g('hour') % 24) * 3600 + g('minute') * 60 + g('second');
}

// Project a bus's (lat, lon) onto a trip's ordered stop path and read off the
// scheduled time at that point. `stops` = [{ lat, lon, schedSec }] in sequence.
// Returns { distFt, schedSec } for the closest segment — distFt is the
// off-path distance (our confidence gate), schedSec the interpolated scheduled
// time. Null if fewer than two stops. Pure; exported for testing.
function deviationFromStops(
  stops,
  lat,
  lon,
  { ftPerDegLon = FT_PER_DEG * Math.cos((lat * Math.PI) / 180) } = {},
) {
  if (!stops || stops.length < 2) return null;
  const px = lon * ftPerDegLon;
  const py = lat * FT_PER_DEG;
  let best = null;
  for (let i = 0; i < stops.length - 1; i++) {
    const ax = stops[i].lon * ftPerDegLon;
    const ay = stops[i].lat * FT_PER_DEG;
    const bx = stops[i + 1].lon * ftPerDegLon;
    const by = stops[i + 1].lat * FT_PER_DEG;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const distFt = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (!best || distFt < best.distFt) {
      const schedSec = stops[i].schedSec + t * (stops[i + 1].schedSec - stops[i].schedSec);
      best = { distFt, schedSec };
    }
  }
  return best;
}

// How late (+) or early (−) a bus is, in minutes, or null when we can't say
// confidently. `vehicle` needs { route, schedStartSec, lat, lon }. `now` is the
// snapshot clock the position was observed at.
function scheduleDeviationMin(vehicle, now = new Date()) {
  if (!vehicle || vehicle.schedStartSec == null || vehicle.route == null) return null;
  if (!Number.isFinite(vehicle.lat) || !Number.isFinite(vehicle.lon)) return null;
  const db = schedDb();
  if (!db) return null;
  if (!_schedStmt) {
    _schedStmt = db.prepare(
      'SELECT trip_id AS tripId, lat, lon, sched_sec AS schedSec FROM sched_stops WHERE route = ? AND start_sec = ? ORDER BY trip_id, seq',
    );
  }
  const rows = _schedStmt.all(String(vehicle.route), vehicle.schedStartSec);
  if (rows.length === 0) return null;
  // Group by trip — two trips can share a (route, start_sec); the bus's own
  // direction's stop path is the one it actually lies along, so projection
  // distance disambiguates.
  const byTrip = new Map();
  for (const r of rows) {
    if (!byTrip.has(r.tripId)) byTrip.set(r.tripId, []);
    byTrip.get(r.tripId).push(r);
  }
  let best = null;
  for (const stops of byTrip.values()) {
    const res = deviationFromStops(stops, vehicle.lat, vehicle.lon);
    if (res && (!best || res.distFt < best.distFt)) best = res;
  }
  if (!best || best.distFt > MAX_OFFROUTE_FT) return null;
  const dev = (chicagoSecondsOfDay(now) - best.schedSec) / 60;
  if (!Number.isFinite(dev) || Math.abs(dev) > MAX_PLAUSIBLE_DEV_MIN) return null;
  return dev;
}

module.exports = {
  loadIndex,
  scheduleDeviationMin,
  deviationFromStops,
  chicagoSecondsOfDay,
  expectedHeadwayMin,
  expectedTripMinutes,
  expectedActiveTrips,
  expectedBusRouteActiveTrips,
  expectedBusRouteHeadwayMin,
  resolveDirection,
  matchPattern,
  dayTypeFor,
  chicagoHour,
  chicagoMinuteOfHour,
  hourlyLookup,
  getTripMeta,
  getShapePoints,
};
