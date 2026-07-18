#!/usr/bin/env node
// Peak vehicle requirement (PVR) — how many physical buses COTA's weekday
// schedule actually needs on the street at once — computed from GTFS blocks,
// not per-route trip overlap.
//
// Why blocks: a `block_id` is one bus's chain of trips for the day, and COTA's
// blocks interline across routes (a bus does one Route 45 trip, then runs Route
// 24 all evening). So the honest vehicle count is the peak number of blocks
// simultaneously "pulled out," which already bakes in COTA's own deadhead,
// layover, and interlining decisions. Per-route counting (and the GTFS index's
// hourly-average activeByHour) can't see this and undercounts.
//
// A block is "in service" from its first trip's departure to its last trip's
// arrival, EXCEPT that a gap longer than --layover-max minutes is treated as
// the bus pulling back to the garage (it splits into two in-service segments,
// so the bus isn't counted while parked). Short gaps between trips are layover
// — the bus stays out and is counted. We sweep every minute and take the max
// number of simultaneous in-service segments.
//
// The peak is robust to the layover threshold (at rush hour buses are running,
// not parked); the threshold mostly moves the midday trough. We print a few
// thresholds so you can see that directly.
//
// Pure schedule analysis — no history DB. Reads COTA static GTFS directly, so
// it runs anywhere (downloads the feed if not cached).
//
// Service is resolved for a specific representative summer weekday (--date) via
// calendar.txt + calendar_dates.txt, so exception-based service like the summer
// Zoo bus (Route 141, added through calendar_dates) is correctly included.
//
// Usage:
//   node scripts/analyze-fleet-requirement.js [--layover-max=N] [--date=YYYY-MM-DD] [--csv]
//
//   --layover-max=N   gap (min) above which a bus is assumed to pull in
//                     (default 30). Only affects the midday trough, not the peak.
//   --date=YYYY-MM-DD representative weekday to resolve service for (default a
//                     mid-summer Wednesday, when the Zoo bus runs).
//   --csv             emit the minute-by-minute active-buses curve to stdout

require('../src/shared/env');

const argv = require('minimist')(process.argv.slice(2));
const { ensureZip, readCsv, resolveServiceIdsForDate } = require('./lib/gtfsScheduleCounts');

const LAYOVER_MAX = Number.isFinite(Number(argv['layover-max'])) ? Number(argv['layover-max']) : 30;
const TARGET_DATE = argv.date ? String(argv.date) : '2026-07-15'; // a mid-summer Wednesday
const CSV_MODE = !!argv.csv;
const HORIZON_MIN = 30 * 60; // sweep 30h to cover after-midnight (owl) trips

// Reported fleet from the Dispatch article.
const CNG_BUSES = 239;
const TOTAL_FLEET = 289; // 239 CNG + 50 electric

// "HH:MM:SS" → minutes since midnight (H may exceed 24 for after-midnight trips).
function parseGtfsTime(t) {
  if (!t) return null;
  const p = t.split(':');
  const h = Number(p[0]);
  const m = Number(p[1]);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

function fmtMin(m) {
  const day = m >= 24 * 60 ? ' (+1)' : '';
  let h = Math.floor((m % (24 * 60)) / 60);
  const mm = String(m % 60).padStart(2, '0');
  const ap = h < 12 ? 'a' : 'p';
  h = ((h + 11) % 12) + 1;
  return `${h}:${mm}${ap}${day}`;
}

// Break a block's sorted trips into in-service segments, splitting on any
// inter-trip gap longer than `layoverMax`.
function blockSegments(trips, layoverMax) {
  const sorted = [...trips].sort((a, b) => a.dep - b.dep);
  const segs = [];
  let start = sorted[0].dep;
  let end = sorted[0].arr;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].dep - end;
    if (gap <= layoverMax) {
      end = Math.max(end, sorted[i].arr);
    } else {
      segs.push([start, end]);
      start = sorted[i].dep;
      end = sorted[i].arr;
    }
  }
  segs.push([start, end]);
  return segs;
}

// Peak simultaneous in-service segments (buses on the street) + the curve.
function computePeak(byBlock, layoverMax) {
  const delta = new Array(HORIZON_MIN + 1).fill(0);
  let segmentCount = 0;
  for (const trips of byBlock.values()) {
    for (const [s, e] of blockSegments(trips, layoverMax)) {
      const a = Math.max(0, Math.min(HORIZON_MIN, Math.round(s)));
      const b = Math.max(0, Math.min(HORIZON_MIN, Math.round(e)));
      if (b <= a) continue;
      delta[a] += 1; // in service at minute a
      delta[b] -= 1; // free at minute b (arrival = released)
      segmentCount += 1;
    }
  }
  const curve = new Array(HORIZON_MIN).fill(0);
  let cur = 0;
  let peak = 0;
  let peakMin = 0;
  for (let m = 0; m < HORIZON_MIN; m++) {
    cur += delta[m];
    curve[m] = cur;
    if (cur > peak) {
      peak = cur;
      peakMin = m;
    }
  }
  return { peak, peakMin, curve, segmentCount };
}

async function main() {
  const zip = await ensureZip();
  const activeServices = await resolveServiceIdsForDate(TARGET_DATE);

  // Trips operating on the target date → route + block.
  const trips = readCsv(zip, 'trips.txt');
  const ti = (n) => trips.hdr.indexOf(n);
  const tripIdx = ti('trip_id');
  const svcIdx = ti('service_id');
  const routeIdx = ti('route_id');
  const blockIdx = ti('block_id');
  const tripMeta = new Map(); // trip_id → { route, block }
  for (const line of trips.rows) {
    const p = line.split(',');
    if (!activeServices.has(p[svcIdx])) continue;
    tripMeta.set(p[tripIdx], { route: p[routeIdx], block: p[blockIdx] });
  }

  // First departure / last arrival per weekday trip, from stop_times.
  const st = readCsv(zip, 'stop_times.txt');
  const si = (n) => st.hdr.indexOf(n);
  const stTripIdx = si('trip_id');
  const arrIdx = si('arrival_time');
  const depIdx = si('departure_time');
  const seqIdx = si('stop_sequence');
  const agg = new Map(); // trip_id → { minSeq, maxSeq, dep, arr }
  for (const line of st.rows) {
    const p = line.split(',');
    const tid = p[stTripIdx];
    if (!tripMeta.has(tid)) continue;
    const seq = Number(p[seqIdx]);
    let a = agg.get(tid);
    if (!a) {
      a = { minSeq: Infinity, maxSeq: -Infinity, dep: null, arr: null };
      agg.set(tid, a);
    }
    if (seq < a.minSeq) {
      const d = parseGtfsTime(p[depIdx]);
      if (d != null) {
        a.minSeq = seq;
        a.dep = d;
      }
    }
    if (seq > a.maxSeq) {
      const arr = parseGtfsTime(p[arrIdx]);
      if (arr != null) {
        a.maxSeq = seq;
        a.arr = arr;
      }
    }
  }

  // Group trips by block.
  const byBlock = new Map(); // block → [{ dep, arr }]
  let usableTrips = 0;
  for (const [tid, meta] of tripMeta) {
    const a = agg.get(tid);
    if (!a || a.dep == null || a.arr == null || a.arr <= a.dep) continue;
    if (!byBlock.has(meta.block)) byBlock.set(meta.block, []);
    byBlock.get(meta.block).push({ dep: a.dep, arr: a.arr });
    usableTrips += 1;
  }

  const result = computePeak(byBlock, LAYOVER_MAX);

  if (CSV_MODE) {
    process.stdout.write('minute_of_day,time,active_buses\n');
    // 4:00a (240) through 2:00a next day (1560) covers the full service day.
    for (let m = 240; m <= 1560; m++) {
      process.stdout.write(`${m},${fmtMin(m)},${result.curve[m]}\n`);
    }
    return;
  }

  console.log('\nCOTA weekday peak vehicle requirement (from GTFS blocks)');
  console.log('='.repeat(64));
  console.log(`Service resolved for:                       ${TARGET_DATE} (incl. summer Zoo bus)`);
  console.log(`Distinct blocks (bus-days of work):         ${byBlock.size}`);
  console.log(`Revenue trips that day:                     ${usableTrips}`);
  console.log(`Layover pull-in threshold:                  ${LAYOVER_MAX} min\n`);

  console.log(
    `PEAK buses simultaneously in service:  ${result.peak}  at ${fmtMin(result.peakMin)}`,
  );
  console.log('');

  // Sensitivity to the layover threshold — shows the peak barely moves.
  console.log('Sensitivity to the pull-in threshold:');
  for (const thr of [15, 30, 45, 60, Infinity]) {
    const r = computePeak(byBlock, thr);
    const label = thr === Infinity ? 'never pull in' : `${thr} min`;
    console.log(`  gap > ${String(label).padEnd(13)} → peak ${r.peak} at ${fmtMin(r.peakMin)}`);
  }
  console.log('');

  // Hourly snapshot of the curve (value at :00 of each hour).
  console.log('Buses in service through the day (at each hour):');
  for (let h = 5; h <= 24; h++) {
    const v = result.curve[h * 60] || 0;
    const bar = '█'.repeat(Math.round(v / 4));
    console.log(`  ${String(h % 24).padStart(2, '0')}:00  ${String(v).padStart(3)}  ${bar}`);
  }
  console.log('');

  // Fleet context.
  const spareVsCng = ((CNG_BUSES / result.peak - 1) * 100).toFixed(0);
  const spareVsTotal = ((TOTAL_FLEET / result.peak - 1) * 100).toFixed(0);
  console.log('Against the reported fleet:');
  console.log(`  Peak buses needed:        ${result.peak}`);
  console.log(`  CNG buses (post-recall):  ${CNG_BUSES}   → ${spareVsCng}% above peak need`);
  console.log(`  Total fleet (pre-recall): ${TOTAL_FLEET}   → ${spareVsTotal}% above peak need`);
  console.log('\nNote: schedule-based (buses the timetable requires), summer service, revenue');
  console.log('trips only (excludes garage pull-out/in). A real spare ratio is ~15–20%.');
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
