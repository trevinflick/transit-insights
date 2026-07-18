#!/usr/bin/env node
// Raw per-alert cancellation export — one row per COTA service-alert record in
// state/history.sqlite (kind='bus-service-alert'), for ad-hoc analysis. This is
// the atomic data the aggregated reports (analyze-cancellations*.js) are built
// from; export it to CSV and pivot however you like.
//
// One row = one alert_id. A whole-block cancellation and its "N more buses
// cancelled" thread replies are each their own alert_id/row. cancelled_trip_count
// is the trip count for that alert (empty for reroutes/detours, and for alerts
// recorded before trip-count tracking that the Bluesky backfill couldn't match).
//
// The exact per-trip departure times ("8:11 AM, 9:18 AM…") are NOT stored in the
// DB — only the count — so they aren't in this export. Parse them from the
// Bluesky post text via scripts/fetch-bluesky-cancellations.js --save if needed.
//
// Usage:
//   node scripts/export-cancellations-raw.js [--days=N] [--cancellations-only]
//
//   --days=N               only rows first seen in the last N days (default: all)
//   --cancellations-only   drop reroute/detour rows (those with no trip count)
//
// Writes CSV to stdout.

require('../src/shared/env');

const Path = require('node:path');
const argv = require('minimist')(process.argv.slice(2));
const Database = require('better-sqlite3');

const KIND = 'bus-service-alert';
const DAY_MS = 24 * 60 * 60 * 1000;

function etDatetime(ms) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ms));
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`;
}
function etDate(ms) {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}
function etWeekday(ms) {
  return new Date(ms).toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
  });
}
function dayType(weekdayShort) {
  if (weekdayShort === 'Sat') return 'saturday';
  if (weekdayShort === 'Sun') return 'sunday';
  return 'weekday';
}

// RFC-4180 CSV field: quote when it contains a comma, quote, or newline;
// double any embedded quotes.
function csv(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function main() {
  const histPath =
    process.env.HISTORY_DB_PATH || Path.join(__dirname, '..', 'state', 'history.sqlite');
  const db = new Database(histPath, { readonly: true });

  const params = [KIND];
  let where = 'kind = ?';
  if (argv.days) {
    where += ' AND first_seen_ts >= ?';
    params.push(Date.now() - Math.max(1, Number(argv.days)) * DAY_MS);
  }
  if (argv['cancellations-only']) {
    where += ' AND cancelled_trip_count IS NOT NULL';
  }

  const rows = db
    .prepare(
      `SELECT alert_id, routes, headline, first_seen_ts, last_seen_ts, resolved_ts,
              cancelled_trip_count, post_uri
       FROM alert_posts
       WHERE ${where}
       ORDER BY first_seen_ts ASC`,
    )
    .all(...params);
  db.close();

  const header = [
    'alert_id',
    'first_seen_ts',
    'datetime_et',
    'date_et',
    'weekday',
    'day_type',
    'is_cancellation',
    'cancelled_trip_count',
    'routes',
    'headline',
    'first_seen_iso_utc',
    'last_seen_iso_utc',
    'resolved_iso_utc',
    'post_uri',
  ];
  process.stdout.write(header.join(',') + '\n');

  for (const r of rows) {
    const wd = etWeekday(r.first_seen_ts);
    const line = [
      r.alert_id,
      r.first_seen_ts,
      etDatetime(r.first_seen_ts),
      etDate(r.first_seen_ts),
      wd,
      dayType(wd),
      r.cancelled_trip_count != null ? 1 : 0,
      r.cancelled_trip_count ?? '',
      r.routes ?? '',
      r.headline ?? '',
      new Date(r.first_seen_ts).toISOString(),
      r.last_seen_ts != null ? new Date(r.last_seen_ts).toISOString() : '',
      r.resolved_ts != null ? new Date(r.resolved_ts).toISOString() : '',
      r.post_uri ?? '',
    ];
    process.stdout.write(line.map(csv).join(',') + '\n');
  }
}

main();
