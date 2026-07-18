#!/usr/bin/env node
// Per-line COTA cancellation analysis for the electric-bus-recall write-up.
// Joins three sources:
//   1. Cancellations   — state/history.sqlite alert_posts.cancelled_trip_count
//                        (weekday first_seen only; backfilled from Bluesky)
//   2. Scheduled trips — COTA static GTFS, weekday service only (authoritative
//                        denominator; see scripts/lib/gtfsScheduleCounts.js for
//                        why NOT schedule.sqlite)
//   3. Headway/buses   — data/gtfs/index.json weekday headways + activeByHour
//
// For each route it reports: weekday scheduled trips, advertised daytime
// headway, buses needed in service at peak, average trips cancelled per active
// weekday, the share of the day's service that removes, and the resulting
// effective headway.
//
// Usage:
//   node scripts/analyze-cancellations-by-line.js [--days=N] [--csv] [--recovery=N]
//
//   --days=N       window of past days to include (default 30)
//   --csv          emit per-line CSV to stdout instead of the text report
//   --recovery=N   fleet = peak revenue buses x N, for recovery/layover + spares
//                  (default 1.15; 1 = peak revenue buses only)
//
// "Effective headway" is a daily-average estimate: advertised ÷ (1 − share
// cut). Real gaps cluster worse than the average (cancellations bunch in the
// peaks), so treat it as a floor on how much worse service actually got.

require('../src/shared/env');

const Path = require('node:path');
const Fs = require('node:fs');
const argv = require('minimist')(process.argv.slice(2));
const Database = require('better-sqlite3');
const { loadScheduleCounts } = require('./lib/gtfsScheduleCounts');
const { routeLabel } = require('../src/bus/routes');

const DAYS = Math.max(1, Math.min(365, Number(argv.days) || 30));
const CSV_MODE = !!argv.csv;
const KIND = 'bus-service-alert';
const DAY_MS = 24 * 60 * 60 * 1000;
// Buses-needed is peak revenue-service buses; real fleet assignment adds
// terminal recovery/layover and spares. Scale the peak by this factor for a
// closer-to-real estimate. Override with --recovery=N (1 = no adjustment).
const RECOVERY_FACTOR = Number.isFinite(Number(argv.recovery)) ? Number(argv.recovery) : 1.15;

// --- Eastern-time helpers (COTA is America/New_York) ---
function etParts(ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t).value;
  return { year: get('year'), month: get('month'), day: get('day'), weekday: get('weekday') };
}
function etDateKey(ms) {
  const p = etParts(ms);
  return `${p.year}-${p.month}-${p.day}`;
}
function isWeekday(ms) {
  return !['Sat', 'Sun'].includes(etParts(ms).weekday);
}

// --- Headway + buses-needed from the GTFS index (weekday profile) ---
// buses needed = peak over weekday hours of the summed simultaneous active
// buses across directions (what activeByHour already measures — run time ÷
// headway). advertised headway = median weekday daytime (6a–6p) headway across
// directions, i.e. the frequency COTA markets ("the 8 every 15 min").
function loadIndexMetrics() {
  const idxPath = Path.join(__dirname, '..', 'data', 'gtfs', 'index.json');
  const idx = JSON.parse(Fs.readFileSync(idxPath, 'utf8'));
  const out = new Map();
  for (const [route, dirs] of Object.entries(idx.routes)) {
    const hours = new Set();
    const headwaySamples = [];
    for (const d of Object.values(dirs)) {
      const active = d.activeByHour?.weekday || {};
      for (const h of Object.keys(active)) hours.add(h);
      const hw = d.headways?.weekday || {};
      for (let h = 6; h <= 18; h++) {
        if (hw[h] != null) headwaySamples.push(hw[h]);
      }
    }
    let busesPeak = 0;
    for (const h of hours) {
      let sum = 0;
      for (const d of Object.values(dirs)) sum += d.activeByHour?.weekday?.[h] || 0;
      if (sum > busesPeak) busesPeak = sum;
    }
    headwaySamples.sort((a, b) => a - b);
    const median = headwaySamples.length
      ? headwaySamples[Math.floor(headwaySamples.length / 2)]
      : null;
    out.set(route, {
      busesNeeded: busesPeak > 0 ? Math.ceil(busesPeak) : null,
      advertisedHeadway: median,
    });
  }
  return out;
}

// --- Cancellations per route, weekday only, over the window ---
function loadCancellations(since) {
  const histPath =
    process.env.HISTORY_DB_PATH || Path.join(__dirname, '..', 'state', 'history.sqlite');
  const db = new Database(histPath, { readonly: true });
  const rows = db
    .prepare(
      `SELECT routes, first_seen_ts, cancelled_trip_count
       FROM alert_posts
       WHERE kind = ? AND cancelled_trip_count IS NOT NULL AND first_seen_ts >= ?`,
    )
    .all(KIND, since);
  db.close();

  const byRoute = new Map(); // route → { total, days:Set }
  const weekdayDays = new Set(); // system-wide distinct active weekdays
  const perDay = new Map(); // dayKey → system total (weekdays only)
  let totalWeekday = 0;

  for (const r of rows) {
    if (!isWeekday(r.first_seen_ts)) continue;
    const n = r.cancelled_trip_count;
    const day = etDateKey(r.first_seen_ts);
    totalWeekday += n;
    weekdayDays.add(day);
    perDay.set(day, (perDay.get(day) || 0) + n);
    for (const route of (r.routes || '').split(',').filter(Boolean)) {
      const key = route.trim();
      const e = byRoute.get(key) || { total: 0, days: new Set() };
      e.total += n;
      e.days.add(day);
      byRoute.set(key, e);
    }
  }
  return { byRoute, weekdayDays, perDay, totalWeekday };
}

function pad(s, n) {
  return String(s).padStart(n);
}
function lpad(s, n) {
  return String(s).padEnd(n);
}

async function main() {
  const now = Date.now();
  const since = now - DAYS * DAY_MS;

  const { counts, totals } = await loadScheduleCounts();
  const indexMetrics = loadIndexMetrics();
  const cancel = loadCancellations(since);

  // Build per-route rows for every route that had cancellations.
  const rows = [];
  for (const [route, c] of cancel.byRoute) {
    const weekdaySched = counts.weekday.get(route) || null;
    const m = indexMetrics.get(route) || {};
    const activeDays = c.days.size;
    const avgPerActiveDay = activeDays ? c.total / activeDays : 0;
    const pctCut = weekdaySched ? avgPerActiveDay / weekdaySched : null;
    const effectiveHeadway =
      m.advertisedHeadway != null && pctCut != null && pctCut < 1
        ? m.advertisedHeadway / (1 - pctCut)
        : null;
    const busesWithRecovery =
      m.busesNeeded != null ? Math.ceil(m.busesNeeded * RECOVERY_FACTOR) : null;
    rows.push({
      route,
      label: routeLabel(route),
      weekdaySched,
      advertisedHeadway: m.advertisedHeadway ?? null,
      busesNeeded: m.busesNeeded ?? null,
      busesWithRecovery,
      total: c.total,
      activeDays,
      avgPerActiveDay,
      pctCut,
      effectiveHeadway,
    });
  }
  rows.sort((a, b) => b.total - a.total);

  if (CSV_MODE) {
    process.stdout.write(
      'route,route_label,weekday_scheduled_trips,advertised_headway_min,buses_needed_peak,buses_needed_with_recovery,cancelled_total_weekday,active_weekdays,avg_cancelled_per_active_day,pct_of_service_cut,effective_headway_min\n',
    );
    for (const r of rows) {
      process.stdout.write(
        [
          r.route,
          `"${r.label}"`,
          r.weekdaySched ?? '',
          r.advertisedHeadway ?? '',
          r.busesNeeded ?? '',
          r.busesWithRecovery ?? '',
          r.total,
          r.activeDays,
          r.avgPerActiveDay.toFixed(1),
          r.pctCut != null ? (r.pctCut * 100).toFixed(1) : '',
          r.effectiveHeadway != null ? r.effectiveHeadway.toFixed(1) : '',
        ].join(',') + '\n',
      );
    }
    return;
  }

  // --- Text report ---
  const activeWeekdays = cancel.weekdayDays.size;
  const avgSystemPerDay = activeWeekdays ? cancel.totalWeekday / activeWeekdays : 0;
  const peakDay = [...cancel.perDay.entries()].sort((a, b) => b[1] - a[1])[0];

  console.log(`\nCOTA cancellations vs scheduled service — weekdays, last ${DAYS} days`);
  console.log('='.repeat(72));
  console.log(`Weekday scheduled trips (system):   ${totals.weekday.toLocaleString()}`);
  console.log(
    `  (Saturday ${totals.saturday.toLocaleString()}, Sunday ${totals.sunday.toLocaleString()} — for reference)`,
  );
  console.log(`Active recall weekdays in window:   ${activeWeekdays}`);
  console.log(
    `Avg trips cancelled / weekday:      ${avgSystemPerDay.toFixed(0)}  (${((avgSystemPerDay / totals.weekday) * 100).toFixed(1)}% of all weekday service)`,
  );
  if (peakDay) {
    const pk = new Date(peakDay[0] + 'T12:00:00').toLocaleDateString('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
    console.log(
      `Worst weekday:                      ${peakDay[1]} cancelled on ${pk}  (${((peakDay[1] / totals.weekday) * 100).toFixed(1)}% of service)`,
    );
  }
  console.log(`\nDispatch reported: "5–10 missed or delayed trips daily" — that was the`);
  console.log(`CNG-maintenance side effect only, not these pre-announced cancellations.`);

  const colR = 22;
  const colSched = 7;
  const colHw = 6;
  const colBus = 6;
  const colFleet = 7;
  const colAvg = 8;
  const colPct = 7;
  const colEff = 8;
  console.log('\nPer line (sorted by total weekday cancellations):\n');
  console.log(
    lpad('Route', colR) +
      pad('Sched', colSched) +
      pad('Adv hw', colHw) +
      pad('Buses', colBus) +
      pad('Fleet', colFleet) +
      pad('Avg/day', colAvg) +
      pad('% cut', colPct) +
      pad('Eff hw', colEff),
  );
  console.log('─'.repeat(colR + colSched + colHw + colBus + colFleet + colAvg + colPct + colEff));
  for (const r of rows) {
    console.log(
      lpad(r.label, colR) +
        pad(r.weekdaySched ?? '—', colSched) +
        pad(r.advertisedHeadway != null ? `${r.advertisedHeadway}m` : '—', colHw) +
        pad(r.busesNeeded ?? '—', colBus) +
        pad(r.busesWithRecovery ?? '—', colFleet) +
        pad(r.avgPerActiveDay.toFixed(1), colAvg) +
        pad(r.pctCut != null ? `${(r.pctCut * 100).toFixed(0)}%` : '—', colPct) +
        pad(r.effectiveHeadway != null ? `${r.effectiveHeadway.toFixed(0)}m` : '—', colEff),
    );
  }
  console.log('\nSched = weekday scheduled trips · Adv hw = advertised daytime headway');
  console.log(
    `Buses = peak buses in revenue service · Fleet = with ${RECOVERY_FACTOR}x recovery/spares`,
  );
  console.log('Eff hw = effective headway after cuts (daily average; peak-hour gaps run worse).');
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
