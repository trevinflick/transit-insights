// Authoritative scheduled-trip counts per route, split by service day type
// (weekday / Saturday / Sunday), read straight from COTA's static GTFS.
//
// Why not read state/schedule.sqlite? That table is the union of every active
// service_id (weekday + Saturday + Sunday trips all together — ~5,400 rows),
// so its per-route counts are ~2.3x a single day and useless as a
// "% of a day's service" denominator. calendar.txt is the source of truth for
// which service_id runs on which day, so we classify service_ids ourselves and
// count trips.txt against them.
//
// Shells out to `unzip -p` exactly like scripts/fetch-gtfs.js (the container
// has unzip; no Node zip dependency). Only route_id/service_id are read from
// trips.txt — both precede the quoted trip_headsign column, so naive
// comma-splitting is safe for the fields we use.

const { execSync } = require('node:child_process');
const Fs = require('node:fs');

const GTFS_URL = 'https://www.cota.com/data/cota.gtfs.zip';
const CACHE_PATH = '/tmp/cota-gtfs-analysis.zip';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

async function ensureZip() {
  try {
    const st = Fs.statSync(CACHE_PATH);
    if (Date.now() - st.mtimeMs < MAX_AGE_MS) return CACHE_PATH;
  } catch (_e) {
    // not cached yet
  }
  const resp = await fetch(GTFS_URL);
  if (!resp.ok) throw new Error(`GTFS download failed: HTTP ${resp.status}`);
  Fs.writeFileSync(CACHE_PATH, Buffer.from(await resp.arrayBuffer()));
  return CACHE_PATH;
}

function readCsv(zipPath, name) {
  const out = execSync(`unzip -p "${zipPath}" "${name}"`, {
    maxBuffer: 256 * 1024 * 1024,
  }).toString('utf8');
  const lines = out.split(/\r?\n/).filter(Boolean);
  const hdr = lines[0].split(',').map((s) => s.replace(/"/g, '').trim());
  return { hdr, rows: lines.slice(1) };
}

// Classify a calendar.txt row to exactly one bucket. COTA's calendar is a
// clean split (one service_id per day type), but a stray supplemental that
// runs any weekday is bucketed 'weekday' so its trips aren't lost.
function classifyService(p, ci) {
  const runs = (day) => p[ci(day)] === '1';
  if (['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].some(runs)) return 'weekday';
  if (runs('saturday')) return 'saturday';
  if (runs('sunday')) return 'sunday';
  return 'other';
}

// Returns { counts: { weekday: Map<route,n>, saturday, sunday },
//           totals: { weekday, saturday, sunday } }.
async function loadScheduleCounts() {
  const zip = await ensureZip();

  const cal = readCsv(zip, 'calendar.txt');
  const ci = (n) => cal.hdr.indexOf(n);
  const svcClass = new Map();
  for (const line of cal.rows) {
    const p = line.split(',');
    svcClass.set(p[ci('service_id')], classifyService(p, ci));
  }

  const trips = readCsv(zip, 'trips.txt');
  const ti = (n) => trips.hdr.indexOf(n);
  const routeIdx = ti('route_id');
  const svcIdx = ti('service_id');
  const counts = { weekday: new Map(), saturday: new Map(), sunday: new Map() };
  const totals = { weekday: 0, saturday: 0, sunday: 0 };
  for (const line of trips.rows) {
    const p = line.split(',');
    const cls = svcClass.get(p[svcIdx]);
    if (!counts[cls]) continue; // 'other'/undefined — not a day-type bucket
    const route = p[routeIdx];
    counts[cls].set(route, (counts[cls].get(route) || 0) + 1);
    totals[cls] += 1;
  }
  return { counts, totals };
}

module.exports = { loadScheduleCounts };
