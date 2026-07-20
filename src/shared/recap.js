// Heatmap aggregates bunching events to lat/lon hotspots. The gap leaderboard
// stays line-level since gaps are a dispatch/headway phenomenon, not a
// location one. Only posted=1 rows count — cooldown-suppressed duplicates
// would inflate counts on chronically-bad routes.

const Path = require('node:path');
const Fs = require('fs-extra');
const { getDb } = require('./history');

const PATTERNS_DIR = Path.join(__dirname, '..', '..', 'data', 'patterns');
const DAY_MS = 24 * 60 * 60 * 1000;

// Don't fetch patterns over the network during heatmap assembly — read from
// disk only and skip events whose pid isn't cached.
const _patternCache = new Map();
function readCachedPattern(pid) {
  if (_patternCache.has(pid)) return _patternCache.get(pid);
  const path = Path.join(PATTERNS_DIR, `${pid}.json`);
  const pattern = Fs.existsSync(path) ? Fs.readJsonSync(path) : null;
  _patternCache.set(pid, pattern);
  return pattern;
}

function resolveBusStop({ direction, near_stop }) {
  if (!direction || !near_stop) return null;
  const pattern = readCachedPattern(direction);
  if (!pattern) return null;
  const stop = pattern.points.find((p) => p.type === 'S' && p.stopName === near_stop);
  return stop ? { lat: stop.lat, lon: stop.lon } : null;
}

// Last-resort fallback when the event's pid pattern is missing — search every
// cached pattern by stop name. Lets stale events still contribute.
function resolveBusStopAnywhere(stopName) {
  if (!stopName) return null;
  for (const file of Fs.readdirSync(PATTERNS_DIR)) {
    if (!file.endsWith('.json')) continue;
    const pid = file.replace(/\.json$/, '');
    const pattern = readCachedPattern(pid);
    if (!pattern) continue;
    const stop = pattern.points.find((p) => p.type === 'S' && p.stopName === stopName);
    if (stop) return { lat: stop.lat, lon: stop.lon };
  }
  return null;
}

// Round to 4 decimals (~11m) so events at the same intersection bucket
// together even when patterns report slightly different stop coordinates.
function bucket(events, resolve) {
  const buckets = new Map();
  for (const ev of events) {
    const loc = resolve(ev);
    if (!loc) continue;
    const key = `${loc.name || ev.near_stop}|${loc.lat.toFixed(4)}|${loc.lon.toFixed(4)}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.count += 1;
      existing.bunching += ev.source === 'bunching' ? 1 : 0;
      existing.gap += ev.source === 'gap' ? 1 : 0;
      if (ev.route) existing.routes.add(ev.route);
    } else {
      buckets.set(key, {
        label: loc.name || ev.near_stop,
        lat: loc.lat,
        lon: loc.lon,
        count: 1,
        bunching: ev.source === 'bunching' ? 1 : 0,
        gap: ev.source === 'gap' ? 1 : 0,
        routes: new Set(ev.route ? [ev.route] : []),
      });
    }
  }
  return [...buckets.values()]
    .map((b) => ({ ...b, routes: [...b.routes] }))
    .sort((a, b) => b.count - a.count);
}

function loadEvents(kind, since, until) {
  const db = getDb();
  return db
    .prepare(`
    SELECT route, direction, near_stop FROM bunching_events
    WHERE kind = ? AND posted = 1 AND ts >= ? AND ts < ? AND near_stop IS NOT NULL
  `)
    .all(kind, since, until)
    .map((r) => ({ ...r, source: 'bunching' }));
}

function loadBusHeatmap(since, until) {
  const events = loadEvents('bus', since, until);
  return bucket(events, (ev) => resolveBusStop(ev) || resolveBusStopAnywhere(ev.near_stop));
}

function loadGapLeaderboard(kind, since, until) {
  const db = getDb();
  const rows = db
    .prepare(`
    SELECT route, COUNT(*) AS count FROM gap_events
    WHERE kind = ? AND posted = 1 AND ts >= ? AND ts < ? AND route IS NOT NULL
    GROUP BY route
    ORDER BY count DESC
  `)
    .all(kind, since, until);
  return rows.map((r) => ({ route: r.route, count: r.count }));
}

// Aggregates whole-block bus cancellations for the recap window. Each
// alert_posts row (kind='bus-service-alert') with a non-null
// cancelled_trip_count is one COTA cancellation announcement; a "3 more buses
// cancelled" thread reply is its own alert_id/row, so summing every row's
// count over the window is the total cancelled bus trips (matches how the
// Bluesky post history tallies). Rows without a count (reroutes/detours, or
// alerts predating trip-count tracking) are excluded by the WHERE clause.
//
// Anchored on first_seen_ts (when COTA published the cancellation), grouped
// into Eastern calendar days so "peak day" and "days with cancellations" line
// up with how a rider reads the week.
function loadCancellationSummary(since, until) {
  const db = getDb();
  const rows = db
    .prepare(`
    SELECT routes, first_seen_ts, cancelled_trip_count
    FROM alert_posts
    WHERE kind = 'bus-service-alert'
      AND cancelled_trip_count IS NOT NULL
      AND first_seen_ts >= ? AND first_seen_ts < ?
  `)
    .all(since, until);

  let totalCancelled = 0;
  const byDay = new Map(); // dayKey → { count, ms } (ms = earliest ts that day)
  const byRoute = new Map(); // route_id → count
  for (const r of rows) {
    const n = r.cancelled_trip_count;
    totalCancelled += n;
    const dayKey = ctDateKey(r.first_seen_ts);
    const day = byDay.get(dayKey) || { count: 0, ms: r.first_seen_ts };
    day.count += n;
    day.ms = Math.min(day.ms, r.first_seen_ts);
    byDay.set(dayKey, day);
    for (const route of (r.routes || '').split(',').filter(Boolean)) {
      const key = route.trim();
      byRoute.set(key, (byRoute.get(key) || 0) + n);
    }
  }

  const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const activeDays = days.length;
  const peak = days.reduce(
    (best, cur) => (cur[1].count > (best?.[1].count ?? -1) ? cur : best),
    null,
  );
  const topRoutes = [...byRoute.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([route, count]) => ({ route, count }));

  return {
    totalCancelled,
    alertCount: rows.length,
    activeDays,
    avgPerActiveDay: activeDays ? totalCancelled / activeDays : 0,
    peakDay: peak ? { label: ctShortLabel(peak[1].ms), count: peak[1].count } : null,
    topRoutes,
  };
}

// Probe both ET offsets (EST=-5, EDT=-4) and pick the one that round-trips
// to the desired wall time — avoids pulling in a tz library.
function ctWallTimeAsUtcMs(year, month, day, hour) {
  for (const offsetHours of [4, 5]) {
    const candidate = Date.UTC(year, month - 1, day, offsetHours, 0, 0);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
    }).formatToParts(new Date(candidate));
    const get = (t) => parseInt(parts.find((p) => p.type === t).value, 10);
    if (
      get('year') === year &&
      get('month') === month &&
      get('day') === day &&
      get('hour') === hour
    ) {
      return candidate;
    }
  }
  throw new Error(`No UTC offset lands ${year}-${month}-${day} ${hour}:00 in America/New_York`);
}

function ctDateParts(ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t) => parseInt(parts.find((p) => p.type === t).value, 10);
  return { year: get('year'), month: get('month'), day: get('day') };
}

// "2026-07-16" (Eastern calendar day) — a sortable per-day grouping key.
function ctDateKey(ms) {
  const { year, month, day } = ctDateParts(ms);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// "Thu, Jul 16" — reader-facing short label in Eastern time.
function ctShortLabel(ms) {
  return new Date(ms).toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

// `month` covers the prior calendar month in CT (e.g. on May 1, all of
// April). Matches how readers think about "monthly recap" better than a
// rolling 30-day window.
function rangeForWindow(window, now = Date.now()) {
  if (window === 'week') {
    // The 7 full calendar days ending yesterday (Eastern). Anchoring to
    // start-of-day (rather than the old until=now) keeps the window exactly
    // 7 days and keeps the post day itself out of the label — a Sun Jul 19
    // run reports "Jul 12 – 18", not "Jul 12 – 19". Dates are computed via UTC
    // arithmetic then resolved to ET midnight so the window stays
    // calendar-aligned and DST-safe (same approach as the month branch).
    const today = ctDateParts(now);
    const startCal = new Date(Date.UTC(today.year, today.month - 1, today.day - 7));
    const endCal = new Date(Date.UTC(today.year, today.month - 1, today.day - 1));
    const startParts = {
      year: startCal.getUTCFullYear(),
      month: startCal.getUTCMonth() + 1,
      day: startCal.getUTCDate(),
    };
    const endParts = {
      year: endCal.getUTCFullYear(),
      month: endCal.getUTCMonth() + 1,
      day: endCal.getUTCDate(),
    };
    const since = ctWallTimeAsUtcMs(startParts.year, startParts.month, startParts.day, 0);
    const until = ctWallTimeAsUtcMs(today.year, today.month, today.day, 0);
    return { since, until, label: formatRangeLabel(startParts, endParts) };
  }
  if (window === 'month') {
    const today = ctDateParts(now);
    const priorMonth = today.month === 1 ? 12 : today.month - 1;
    const priorYear = today.month === 1 ? today.year - 1 : today.year;
    const since = ctWallTimeAsUtcMs(priorYear, priorMonth, 1, 0);
    const until = ctWallTimeAsUtcMs(today.year, today.month, 1, 0);
    const lastDay = new Date(today.year, today.month - 1, 0).getDate();
    const start = { year: priorYear, month: priorMonth, day: 1 };
    const end = { year: priorYear, month: priorMonth, day: lastDay };
    // Year-disambiguate the label across calendar boundaries (Jan 1 → "Dec 1 – 31, 2025").
    const baseLabel = formatRangeLabel(start, end);
    const label = priorYear !== today.year ? `${baseLabel}, ${priorYear}` : baseLabel;
    return { since, until, label };
  }
  throw new Error(`Unknown window: ${window}`);
}

function formatRangeLabel(start, end) {
  const sameYear = start.year === end.year;
  const sameMonth = sameYear && start.month === end.month;
  const startStr = `${MONTH_NAMES[start.month - 1]} ${start.day}`;
  if (sameMonth) return `${startStr} – ${end.day}`;
  const endStr = `${MONTH_NAMES[end.month - 1]} ${end.day}`;
  return sameYear
    ? `${startStr} – ${endStr}`
    : `${startStr}, ${start.year} – ${endStr}, ${end.year}`;
}

module.exports = {
  loadBusHeatmap,
  loadGapLeaderboard,
  loadCancellationSummary,
  rangeForWindow,
  // exported for tests
  bucket,
  formatRangeLabel,
};
