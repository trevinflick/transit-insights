#!/usr/bin/env node
// Analyzes COTA bus cancellation alerts from the history DB and compares to
// the total scheduled daily trips. Outputs a day-by-day table and an ASCII
// bar chart. Run on the production server for real data.
//
// Usage:
//   node scripts/analyze-cancellations.js [--days=N] [--csv]
//
//   --days=N   Number of past days to show (default 30)
//   --csv      Emit CSV to stdout instead of the text report
//
// The script reads from:
//   - state/history.sqlite (alert_posts where kind='bus-service-alert')
//   - data/gtfs/schedule.sqlite (sched_stops, for total daily trip count)
//
// cancelled_trip_count is only populated for alerts recorded after the column
// was added. For older rows, the column is NULL and the trip count is shown
// as unknown.

require('../src/shared/env');

const Path = require('node:path');
const argv = require('minimist')(process.argv.slice(2));
const Database = require('better-sqlite3');

const DAYS = Math.max(1, Math.min(365, Number(argv.days) || 30));
const CSV_MODE = !!argv.csv;
const KIND = 'bus-service-alert';
const DAY_MS = 24 * 60 * 60 * 1000;

// Columbus is America/New_York; DST transitions at 2am so noon is always safe.
function startOfDay(ts) {
  const d = new Date(ts);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  const y = get('year'),
    m = get('month'),
    day = get('day');
  const h = get('hour'),
    mi = get('minute'),
    s = get('second');
  const asUtc = Date.UTC(+y, +m - 1, +day, +h, +mi, +s);
  const offsetMs = d.getTime() - asUtc;
  return Date.UTC(+y, +m - 1, +day) + offsetMs;
}

function formatDate(ts) {
  return new Date(ts).toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

function isoDate(ts) {
  return new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// Load total scheduled trips for today from the GTFS schedule DB. Used as
// the denominator for %-cancelled. Returns null if the schedule DB is missing.
function loadTotalScheduledTrips() {
  const schedPath = Path.join(__dirname, '..', 'data', 'gtfs', 'schedule.sqlite');
  try {
    const sched = new Database(schedPath, { readonly: true });
    const row = sched.prepare('SELECT COUNT(DISTINCT trip_id) as c FROM sched_stops').get();
    sched.close();
    return row?.c ?? null;
  } catch (_e) {
    return null;
  }
}

function main() {
  const histPath =
    process.env.HISTORY_DB_PATH || Path.join(__dirname, '..', 'state', 'history.sqlite');
  const hist = new Database(histPath, { readonly: true });

  const now = Date.now();
  const windowStart = startOfDay(now - (DAYS - 1) * DAY_MS);

  // One row per alert. Each alert is one COTA block-cancellation (covers one
  // set of trips on typically one route for the day). cancelled_trip_count may
  // be NULL for alerts predating that column.
  const alerts = hist
    .prepare(
      `SELECT alert_id, routes, headline, first_seen_ts, cancelled_trip_count
       FROM alert_posts
       WHERE kind = ? AND first_seen_ts >= ?
       ORDER BY first_seen_ts ASC`,
    )
    .all(KIND, windowStart);

  hist.close();

  // Group by calendar day.
  const byDay = new Map(); // isoDate → { alerts, cancelledTrips, routes: Set }
  for (const row of alerts) {
    const key = isoDate(row.first_seen_ts);
    if (!byDay.has(key))
      byDay.set(key, { alerts: 0, cancelledTrips: 0, hasCount: false, routes: new Set() });
    const d = byDay.get(key);
    d.alerts += 1;
    if (row.cancelled_trip_count != null) {
      d.cancelledTrips += row.cancelled_trip_count;
      d.hasCount = true;
    }
    for (const r of (row.routes || '').split(',').filter(Boolean)) d.routes.add(r.trim());
  }

  // Fill in days with no alerts so the chart is contiguous.
  for (let t = windowStart; t <= now; t += DAY_MS) {
    const key = isoDate(t);
    if (!byDay.has(key))
      byDay.set(key, { alerts: 0, cancelledTrips: 0, hasCount: false, routes: new Set() });
  }

  const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  const totalScheduled = loadTotalScheduledTrips();

  if (CSV_MODE) {
    process.stdout.write(
      'date,alert_count,cancelled_trips,routes_affected,total_scheduled,pct_cancelled\n',
    );
    for (const [dateKey, d] of days) {
      const trips = d.hasCount ? d.cancelledTrips : '';
      const pct =
        d.hasCount && totalScheduled ? ((d.cancelledTrips / totalScheduled) * 100).toFixed(2) : '';
      process.stdout.write(
        `${dateKey},${d.alerts},${trips},${d.routes.size},${totalScheduled ?? ''},${pct}\n`,
      );
    }
    return;
  }

  // Text report
  const maxCancelled = Math.max(...days.map(([, d]) => d.cancelledTrips), 1);
  const BAR_WIDTH = 30;

  const colDate = 12;
  const colAlerts = 7;
  const colTrips = 15;
  const colRoutes = 8;
  const colPct = 8;

  function pad(s, n) {
    return String(s).padStart(n);
  }
  function lpad(s, n) {
    return String(s).padEnd(n);
  }

  const header =
    lpad('Date', colDate) +
    pad('Alerts', colAlerts) +
    pad('Trips cxld', colTrips) +
    pad('Routes', colRoutes) +
    pad('% total', colPct) +
    '  Chart';
  const divider = '─'.repeat(header.length + BAR_WIDTH);

  console.log(`\nCOTA bus cancellation analysis — last ${DAYS} days`);
  if (totalScheduled != null) {
    console.log(`Total scheduled trips today (GTFS proxy): ${totalScheduled.toLocaleString()}`);
  } else {
    console.log('(GTFS schedule unavailable — run npm run fetch-gtfs for % figures)');
  }
  console.log();
  console.log(header);
  console.log(divider);

  let totalAlerts = 0;
  let totalTrips = 0;
  let daysWithData = 0;

  for (const [dateKey, d] of days) {
    totalAlerts += d.alerts;
    if (d.hasCount) totalTrips += d.cancelledTrips;
    if (d.alerts > 0) daysWithData += 1;

    const tripsLabel = d.hasCount ? String(d.cancelledTrips) : d.alerts > 0 ? '?' : '0';
    const pctLabel =
      d.hasCount && totalScheduled
        ? `${((d.cancelledTrips / totalScheduled) * 100).toFixed(1)}%`
        : d.alerts > 0
          ? '?'
          : '';
    const barLen = d.hasCount
      ? Math.round((d.cancelledTrips / maxCancelled) * BAR_WIDTH)
      : d.alerts > 0
        ? Math.round((d.alerts / Math.max(...days.map(([, x]) => x.alerts), 1)) * BAR_WIDTH)
        : 0;
    const bar = '█'.repeat(barLen);

    const dateFmt = new Date(dateKey + 'T12:00:00').toLocaleDateString('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });

    console.log(
      lpad(dateFmt, colDate) +
        pad(d.alerts || '', colAlerts) +
        pad(tripsLabel, colTrips) +
        pad(d.routes.size || '', colRoutes) +
        pad(pctLabel, colPct) +
        '  ' +
        bar,
    );
  }

  console.log(divider);
  console.log(
    `${lpad('TOTAL', colDate)}${pad(totalAlerts, colAlerts)}${pad(totalTrips || '?', colTrips)}`,
  );
  console.log();

  if (days.some(([, d]) => d.alerts > 0 && !d.hasCount)) {
    console.log(
      'Note: "?" trip counts are for alerts recorded before trip-count tracking was added.',
    );
    console.log('      Alert count is shown as a proxy for those days.');
  }

  // Route leaderboard
  const routeTotals = new Map();
  for (const row of alerts) {
    for (const r of (row.routes || '').split(',').filter(Boolean)) {
      const key = r.trim();
      routeTotals.set(key, (routeTotals.get(key) || 0) + (row.cancelled_trip_count ?? 1));
    }
  }
  if (routeTotals.size > 0) {
    const sorted = [...routeTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.log('Routes most affected (by trip cancellations or alert proxy):');
    for (const [route, count] of sorted) {
      console.log(`  Route ${route.replace(/^0+/, '')}: ${count}`);
    }
    console.log();
  }

  console.log(`Active days in window: ${daysWithData} of ${days.length}`);
  if (totalScheduled != null && totalTrips > 0) {
    const avgPerDay = (totalTrips / Math.max(daysWithData, 1)).toFixed(1);
    console.log(`Average cancelled trips on active days: ${avgPerDay}`);
    console.log(
      `vs. Dispatch's "5–10 per day" claim — over ${daysWithData} days with cancellations`,
    );
  }
}

main();
