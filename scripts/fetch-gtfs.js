// Builds a headway index for gap detection. Bot runtime reads the precomputed
// JSON so it doesn't re-parse GTFS on every invocation.
require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env') });
const axios = require('axios');
const Fs = require('fs-extra');
const Database = require('better-sqlite3');
const Path = require('node:path');
const { exec, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const readline = require('node:readline');

const execAsync = promisify(exec);

const { withCumulativeDistFt, projectOntoShape } = require('../src/bus/shapeProjection');

const GTFS_URL = 'https://www.cota.com/data/cota.gtfs.zip';
const ZIP_PATH = '/tmp/cota-gtfs.zip';
const OUT_PATH = Path.join(__dirname, '..', 'data', 'gtfs', 'index.json');
// Per-trip scheduled stop curves for bus schedule-adherence (scheduleDeviationMin).
// Kept in SQLite, not index.json — it's ~1M+ rows (every bus trip × every stop).
const SCHED_DB_PATH = Path.join(__dirname, '..', 'data', 'gtfs', 'schedule.sqlite');

// Index every active COTA route so any consumer (bunching, speedmap, gaps,
// ghosts) can resolve schedule data without per-list bookkeeping.
const { allRoutes } = require('../src/bus/routes');
const BUS_ROUTES = [...allRoutes].sort();

async function downloadGtfs() {
  if (Fs.existsSync(ZIP_PATH)) {
    const age = Date.now() - Fs.statSync(ZIP_PATH).mtimeMs;
    if (age < 24 * 60 * 60 * 1000) {
      console.log('Using cached GTFS zip (< 1 day old)');
      return;
    }
  }
  console.log(`Downloading GTFS from ${GTFS_URL}...`);
  const resp = await axios.get(GTFS_URL, { responseType: 'arraybuffer', timeout: 120000 });
  Fs.writeFileSync(ZIP_PATH, resp.data);
  console.log(`  ${(resp.data.length / 1024 / 1024).toFixed(1)} MB`);
}

async function readFromZip(filename) {
  const { stdout } = await execAsync(`unzip -p "${ZIP_PATH}" "${filename}"`, {
    maxBuffer: 512 * 1024 * 1024,
  });
  return stdout;
}

function streamFromZip(filename, onLine) {
  return new Promise((resolve, reject) => {
    const proc = spawn('unzip', ['-p', ZIP_PATH, filename]);
    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', onLine);
    rl.on('close', resolve);
    proc.on('error', reject);
    proc.stderr.on('data', (d) => process.stderr.write(d));
  });
}

// RFC 4180-aware — stops.txt has quoted fields with embedded commas.
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else cur += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') {
        out.push(cur);
        cur = '';
      } else cur += c;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parseCsv(text) {
  const lines = text.split('\n').filter((l) => l.length > 0);
  const header = parseCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = parseCsvLine(lines[i]);
    const row = {};
    for (let j = 0; j < header.length; j++) row[header[j]] = parts[j];
    rows.push(row);
  }
  return rows;
}

// GTFS times can exceed 24h ("25:15:00" = 1:15am next day). Caller mods by 86400.
function parseGtfsTime(s) {
  if (!s) return null;
  const [h, m, sec] = s.split(':').map((x) => parseInt(x, 10));
  return h * 3600 + m * 60 + (sec || 0);
}

function median(arr) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Coarse fallback headway for routes whose per-pattern, per-hour headway
// computation produced nothing — e.g. a route that alternates between two
// termini from the same origin every ~30 min, so each branch individually
// never gets 2 same-pattern departures within one clock hour even though the
// route overall runs fine. Ignores pattern and hour-of-day entirely: just the
// median gap across every same-direction departure that day-type. Guarded by
// `minTrips` (a 2-trip AM/PM commuter shuttle shouldn't produce a "headway"
// from one giant gap) and `maxGapMin` (an AM/PM shuttle's multi-hour gap
// isn't a usable "is this route still running" signal even with 2+ trips).
// Pure; exported for testing.
function computeFallbackHeadway(departureSeconds, { minTrips = 4, maxGapMin = 120 } = {}) {
  if (!departureSeconds || departureSeconds.length < minTrips) return null;
  const sorted = [...departureSeconds].sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) gaps.push((sorted[i] - sorted[i - 1]) / 60);
  const medMin = median(gaps);
  if (medMin == null || medMin > maxGapMin) return null;
  return Math.round(medMin * 10) / 10;
}

// Headway for one (pattern, dayType, hour) bucket. Default is the median of
// consecutive departure gaps — correct when departures are roughly evenly
// spaced. But some routes run in close PAIRS (e.g. two buses ~8 min apart,
// then a longer gap before the next pair) — confirmed against COTA's real
// published Route 8 timetable: this hour-bucketed gap data read 8-11 min,
// the PDF schedule says 15. The median there just picks whichever gap length
// happens to be more common in this hour's small sample, not the rider-facing
// average spacing. Detected via the ratio between the largest and smallest
// gap in the bucket (a clean, evenly-spaced schedule keeps this near 1;
// pairing pushes it well past `irregularRatioThreshold`) — when triggered,
// falls back to a count-based estimate (60 min / departures this hour), which
// is insensitive to how those departures happen to cluster within the hour.
// Pure; exported for testing.
function resolveHourlyHeadway(times, { irregularRatioThreshold = 2 } = {}) {
  if (!times || times.length < 2) return null;
  const sorted = [...times].sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) gaps.push((sorted[i] - sorted[i - 1]) / 60);
  if (gaps.length >= 2) {
    const maxGap = Math.max(...gaps);
    const minGap = Math.min(...gaps);
    if (minGap > 0 && maxGap / minGap > irregularRatioThreshold) {
      return Math.round((60 / sorted.length) * 10) / 10;
    }
  }
  const medMin = median(gaps);
  return medMin == null ? null : Math.round(medMin * 10) / 10;
}

// Coarse day_type bucket — Sat/Sun stay separate since headways differ a lot.
function dayTypeFor(cal) {
  const weekday =
    cal.monday === '1' &&
    cal.tuesday === '1' &&
    cal.wednesday === '1' &&
    cal.thursday === '1' &&
    cal.friday === '1';
  const sat = cal.saturday === '1';
  const sun = cal.sunday === '1';
  if (weekday && !sat && !sun) return 'weekday';
  if (!weekday && sat && !sun) return 'saturday';
  if (!weekday && !sat && sun) return 'sunday';
  if (sat && sun && !weekday) return 'weekend';
  return null; // mixed/unusual services — skip so we don't mash weekday + weekend headways together
}

// Honors calendar.txt date ranges + calendar_dates.txt exceptions for today.
function resolveServiceDayTypes({ calendars, calendarDates, todayStr, todayDow }) {
  const addForToday = new Set();
  const removeForToday = new Set();
  for (const r of calendarDates) {
    if (r.date !== todayStr) continue;
    if (r.exception_type === '1') addForToday.add(r.service_id);
    else if (r.exception_type === '2') removeForToday.add(r.service_id);
  }
  const out = new Map();
  for (const c of calendars) {
    const dt = dayTypeFor(c);
    if (!dt) continue;
    if (todayStr < c.start_date || todayStr > c.end_date) continue;
    if (removeForToday.has(c.service_id)) continue;
    out.set(c.service_id, dt);
  }
  if (addForToday.size) {
    const fallbackDt = todayDow === 'Sat' ? 'saturday' : todayDow === 'Sun' ? 'sunday' : 'weekday';
    for (const sid of addForToday) {
      if (!out.has(sid)) out.set(sid, fallbackDt);
    }
  }
  return { serviceDayType: out, addForToday, removeForToday };
}

// Day-level dominance, not per-hour: per-hour was too aggressive for Route 55
// at 2 AM. ≥60% threshold means short-turn-only periods keep all origins.
const BUS_DOMINANCE_THRESHOLD = 0.6;
function computeBusDominantOrigin(tripMeta, firstStopId, { log = false } = {}) {
  const counts = new Map();
  for (const [tripId, meta] of tripMeta) {
    const origin = firstStopId.get(tripId);
    if (!origin) continue;
    const k = `${meta.route}|${meta.dir}`;
    if (!counts.has(k)) counts.set(k, new Map());
    const m = counts.get(k);
    m.set(origin, (m.get(origin) || 0) + 1);
  }
  const dominant = new Map();
  for (const [k, c] of counts) {
    let best = null;
    let bestCount = -1;
    let total = 0;
    for (const [stopId, n] of c) {
      total += n;
      if (n > bestCount) {
        bestCount = n;
        best = stopId;
      }
    }
    if (best && bestCount / total >= BUS_DOMINANCE_THRESHOLD) {
      dominant.set(k, best);
    } else if (log) {
      console.log(
        `bus ${k}: no dominant origin (top=${bestCount}/${total}, ${c.size} origins) — keeping all`,
      );
    }
  }
  return dominant;
}

// Build the per-trip scheduled stop curves used by scheduleDeviationMin. One row
// per (bus trip, stop): keyed by (route, start_sec) where start_sec is the
// trip's first-stop departure — the value a live bus reports as `stst`, so the
// runtime joins a vehicle straight to its scheduled curve. Rebuilt from scratch
// each run so it tracks today's active service like index.json.
function writeScheduleDb({ busTripStops, tripMeta, firstDeparture, byStopId }) {
  console.log('Building schedule.sqlite (per-trip scheduled stop curves)...');
  Fs.ensureDirSync(Path.dirname(SCHED_DB_PATH));
  Fs.removeSync(SCHED_DB_PATH);
  const db = new Database(SCHED_DB_PATH);
  db.pragma('journal_mode = OFF');
  db.pragma('synchronous = OFF');
  db.exec(`
    CREATE TABLE sched_stops (
      route TEXT NOT NULL,
      start_sec INTEGER NOT NULL,
      trip_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      sched_sec INTEGER NOT NULL
    );
  `);
  const insert = db.prepare(
    'INSERT INTO sched_stops (route, start_sec, trip_id, seq, lat, lon, sched_sec) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  let trips = 0;
  let rows = 0;
  const tx = db.transaction(() => {
    for (const [tripId, stopList] of busTripStops) {
      const meta = tripMeta.get(tripId);
      const startSec = firstDeparture.get(tripId);
      if (!meta || startSec == null || stopList.length < 2) continue;
      const ordered = [...stopList].sort((a, b) => a.seq - b.seq);
      let wrote = 0;
      for (const s of ordered) {
        const stop = byStopId.get(s.stopId);
        if (!stop || s.schedSec == null) continue;
        const lat = parseFloat(stop.stop_lat);
        const lon = parseFloat(stop.stop_lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        insert.run(meta.route, startSec, tripId, s.seq, lat, lon, s.schedSec);
        wrote++;
      }
      if (wrote >= 2) {
        trips++;
        rows += wrote;
      }
    }
  });
  tx();
  db.exec('CREATE INDEX idx_sched_route_start ON sched_stops(route, start_sec)');
  db.close();
  const bytes = Fs.statSync(SCHED_DB_PATH).size;
  console.log(
    `  wrote ${rows} stop rows across ${trips} bus trips (${(bytes / 1024 / 1024).toFixed(1)} MB)`,
  );
}

async function main() {
  console.log(`Indexing ${BUS_ROUTES.length} bus routes: ${BUS_ROUTES.join(', ')}`);
  await downloadGtfs();

  console.log('Reading calendar.txt...');
  const calendars = parseCsv(await readFromZip('calendar.txt'));
  const today = new Date();
  const todayStr = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;

  // Holiday service: exception_type=1 force-adds, =2 force-removes. Without
  // this, holidays (Memorial Day, Thanksgiving) ghost-fire en masse.
  console.log('Reading calendar_dates.txt...');
  let calendarDates = [];
  try {
    calendarDates = parseCsv(await readFromZip('calendar_dates.txt'));
  } catch (e) {
    console.warn(
      `  could not read calendar_dates.txt: ${e.message} — proceeding without exceptions`,
    );
  }
  const todayDow = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
  }).format(today);
  const { serviceDayType, addForToday, removeForToday } = resolveServiceDayTypes({
    calendars,
    calendarDates,
    todayStr,
    todayDow,
  });
  console.log(
    `  ${serviceDayType.size} service_ids active on ${todayStr} (+${addForToday.size} added / -${removeForToday.size} removed via calendar_dates)`,
  );

  console.log('Reading trips.txt...');
  const trips = parseCsv(await readFromZip('trips.txt'));
  const busRouteSet = new Set(BUS_ROUTES);
  const tripMeta = new Map();
  for (const t of trips) {
    if (!busRouteSet.has(t.route_id)) continue;
    const dt = serviceDayType.get(t.service_id);
    if (!dt) continue;
    tripMeta.set(t.trip_id, {
      route: t.route_id,
      dir: t.direction_id,
      dayType: dt,
      serviceId: t.service_id,
      headsign: t.trip_headsign || t.direction || '',
      shapeId: t.shape_id || null,
    });
  }
  console.log(`  ${tripMeta.size} bus trips in scope`);

  console.log('Streaming stop_times.txt...');
  // Per trip: first-stop departure (min stop_sequence) and last-stop id (max).
  const firstDeparture = new Map(); // trip_id → seconds
  const firstSeq = new Map();
  const firstStopId = new Map(); // trip_id → stop_id (origin)
  const lastStopId = new Map(); // trip_id → stop_id
  const lastArrival = new Map(); // trip_id → seconds (last-stop arrival)
  const lastSeq = new Map();
  // Every stop of every in-scope BUS trip, for the schedule-adherence curve:
  // trip_id → [{ seq, stopId, schedSec }]. Bus only — rail adherence isn't a
  // consumer yet and would roughly double the row count.
  const busTripStops = new Map();

  let header = null;
  let tripIdIdx = -1;
  let stopIdIdx = -1;
  let depIdx = -1;
  let arrIdx = -1;
  let seqIdx = -1;
  await streamFromZip('stop_times.txt', (line) => {
    if (!header) {
      header = line.split(',').map((s) => s.replace(/"/g, '').trim());
      tripIdIdx = header.indexOf('trip_id');
      stopIdIdx = header.indexOf('stop_id');
      depIdx = header.indexOf('departure_time');
      arrIdx = header.indexOf('arrival_time');
      seqIdx = header.indexOf('stop_sequence');
      return;
    }
    const parts = line.split(',');
    const tripId = parts[tripIdIdx];
    if (!tripMeta.has(tripId)) return;
    const seq = parseInt(parts[seqIdx], 10);
    if (!busTripStops.has(tripId)) busTripStops.set(tripId, []);
    busTripStops.get(tripId).push({
      seq,
      stopId: parts[stopIdIdx],
      schedSec: parseGtfsTime(parts[arrIdx]),
    });
    const prevFirst = firstSeq.get(tripId);
    if (prevFirst === undefined || seq < prevFirst) {
      firstSeq.set(tripId, seq);
      firstDeparture.set(tripId, parseGtfsTime(parts[depIdx]));
      firstStopId.set(tripId, parts[stopIdIdx]);
    }
    const prevLast = lastSeq.get(tripId);
    if (prevLast === undefined || seq > prevLast) {
      lastSeq.set(tripId, seq);
      lastStopId.set(tripId, parts[stopIdIdx]);
      lastArrival.set(tripId, parseGtfsTime(parts[arrIdx]));
    }
  });
  console.log(`  first/last stop times captured for ${firstDeparture.size} trips`);

  console.log('Reading stops.txt...');
  const stops = parseCsv(await readFromZip('stops.txt'));
  const byStopId = new Map(stops.map((s) => [s.stop_id, s]));

  writeScheduleDb({ busTripStops, tripMeta, firstDeparture, byStopId });

  // Concurrent service_ids (daytime + Owl) overlap one dayType — resolve
  // dominance per hour so each picks the right one.
  const serviceTripCounts = new Map(); // key: route|dir|dayType|hour|serviceId → count
  for (const [tripId, meta] of tripMeta) {
    const dep = firstDeparture.get(tripId);
    if (dep == null) continue;
    const hour = Math.floor(dep / 3600) % 24;
    const k = `${meta.route}|${meta.dir}|${meta.dayType}|${hour}|${meta.serviceId}`;
    serviceTripCounts.set(k, (serviceTripCounts.get(k) || 0) + 1);
  }
  const dominantService = new Map(); // key: route|dir|dayType|hour → serviceId
  for (const [k, c] of serviceTripCounts) {
    const [route, dir, dayType, hour, serviceId] = k.split('|');
    const rdth = `${route}|${dir}|${dayType}|${hour}`;
    const prev = dominantService.get(rdth);
    if (!prev || c > prev.count) dominantService.set(rdth, { serviceId, count: c });
  }

  // Ground-truth active-trip count: trips whose [dep, arr] overlaps each hour.
  // Keyed per direction (NOT per pattern) and counts EVERY revenue trip —
  // short-turns and overlay service still put vehicles on the street, so
  // "how many should be active right now" must include them. Replaces the old
  // `duration / headway` approximation that broke during ramp-up.
  const activeBuckets = new Map(); // route|dir|dayType|hour → fractional count
  const activeKey = (route, dir, dayType, hour) => `${route}|${dir}|${dayType}|${hour}`;
  for (const [tripId, meta] of tripMeta) {
    const dep = firstDeparture.get(tripId);
    const arr = lastArrival.get(tripId);
    if (dep == null || arr == null || arr <= dep) continue;
    const startHour = Math.floor(dep / 3600);
    const endHour = Math.floor((arr - 1) / 3600);
    for (let h = startHour; h <= endHour; h++) {
      const hStart = h * 3600;
      const hEnd = hStart + 3600;
      const overlap = Math.min(arr, hEnd) - Math.max(dep, hStart);
      if (overlap <= 0) continue;
      const k = activeKey(meta.route, meta.dir, meta.dayType, h % 24);
      activeBuckets.set(k, (activeBuckets.get(k) || 0) + overlap / 3600);
    }
  }

  // Headway/duration are measured PER PATTERN — grouped by (origin terminal →
  // destination terminal) — not per direction. Mixing patterns in one bucket
  // corrupts the median: owl short-turns made the 66 read ~6 min when the
  // through service is 30, and a route with two start terminals (87) collapsed
  // to <1 min by comparing departures from different terminals. With origin and
  // dest in the key each group is a single pattern, so first-departure gaps are
  // meaningful again. Cross-date-range family dupes are still removed via
  // dominantService; garage pull-outs/deadheads form their own tiny groups and
  // fall out below for lack of any 2+ -departure hour.
  const headwayBuckets = new Map(); // route|dir|origin|dest|dayType|hour → [dep,...]
  const durationBuckets = new Map(); // same key → [durMin,...]
  const patternTripCount = new Map(); // route|dir|origin|dest → total trips
  const patternHeadsign = new Map(); // route|dir|origin|dest → headsign
  // Unfiltered departures per (route,dir,dayType) — no pattern split, no hour
  // bucketing — the substrate for computeFallbackHeadway when a route's
  // per-pattern headway computation produces nothing (see that function).
  const allDeparturesByRouteDirDayType = new Map();
  for (const [tripId, meta] of tripMeta) {
    const dep = firstDeparture.get(tripId);
    if (dep == null) continue;
    const rddKey = `${meta.route}|${meta.dir}|${meta.dayType}`;
    if (!allDeparturesByRouteDirDayType.has(rddKey)) allDeparturesByRouteDirDayType.set(rddKey, []);
    allDeparturesByRouteDirDayType.get(rddKey).push(dep);
    const hour = Math.floor(dep / 3600) % 24;
    const dominant = dominantService.get(`${meta.route}|${meta.dir}|${meta.dayType}|${hour}`);
    if (!dominant || dominant.serviceId !== meta.serviceId) continue;
    const origin = firstStopId.get(tripId);
    const dest = lastStopId.get(tripId);
    if (!origin || !dest) continue;
    const pk = `${meta.route}|${meta.dir}|${origin}|${dest}`;
    patternTripCount.set(pk, (patternTripCount.get(pk) || 0) + 1);
    if (!patternHeadsign.has(pk)) patternHeadsign.set(pk, meta.headsign || '');
    const key = `${pk}|${meta.dayType}|${hour}`;
    if (!headwayBuckets.has(key)) headwayBuckets.set(key, []);
    headwayBuckets.get(key).push(dep);
    const arr = lastArrival.get(tripId);
    if (arr != null && arr > dep) {
      if (!durationBuckets.has(key)) durationBuckets.set(key, []);
      durationBuckets.get(key).push((arr - dep) / 60);
    }
  }

  // Fold per-(pattern, dayType, hour) buckets into per-pattern headway/duration
  // maps — see resolveHourlyHeadway for how a bucket's headway is derived.
  const patternData = new Map(); // route|dir → Map(origin|dest → { origin, dest, headways, durations })
  for (const [key, times] of headwayBuckets) {
    if (times.length < 2) continue; // need 2 departures to measure a gap
    const [route, dir, origin, dest, dayType, hourStr] = key.split('|');
    const hour = parseInt(hourStr, 10);
    const headwayMin = resolveHourlyHeadway(times);
    if (headwayMin == null) continue;
    const rd = `${route}|${dir}`;
    if (!patternData.has(rd)) patternData.set(rd, new Map());
    const pm = patternData.get(rd);
    const pk = `${origin}|${dest}`;
    if (!pm.has(pk)) pm.set(pk, { origin, dest, headways: {}, durations: {} });
    const pat = pm.get(pk);
    if (!pat.headways[dayType]) pat.headways[dayType] = {};
    pat.headways[dayType][hour] = headwayMin;
    const durations = durationBuckets.get(key);
    if (durations && durations.length > 0) {
      const medDur = median(durations);
      if (medDur != null) {
        if (!pat.durations[dayType]) pat.durations[dayType] = {};
        pat.durations[dayType][hour] = Math.round(medDur * 10) / 10;
      }
    }
  }

  // Emit. Each direction carries its full pattern list (consumers match a live
  // pattern's endpoints to the right group) plus the dominant pattern's
  // headway/duration/terminals hoisted to the direction level — a fallback for
  // patternless consumers and for live patterns that match no group.
  const out = { generatedAt: Date.now(), routes: {}, trips: {}, shapes: {} };
  for (const [rd, pm] of patternData) {
    const [route, dir] = rd.split('|');
    const list = [];
    for (const pat of pm.values()) {
      if (Object.keys(pat.headways).length === 0) continue;
      const pk = `${route}|${dir}|${pat.origin}|${pat.dest}`;
      const o = byStopId.get(pat.origin);
      const d = byStopId.get(pat.dest);
      list.push({
        headsign: patternHeadsign.get(pk) || '',
        tripCount: patternTripCount.get(pk) || 0,
        originLat: o ? parseFloat(o.stop_lat) : null,
        originLon: o ? parseFloat(o.stop_lon) : null,
        terminalLat: d ? parseFloat(d.stop_lat) : null,
        terminalLon: d ? parseFloat(d.stop_lon) : null,
        headways: pat.headways,
        durations: pat.durations,
      });
    }
    if (list.length === 0) continue;
    list.sort((a, b) => b.tripCount - a.tripCount); // dominant pattern first
    const dom = list[0];
    if (!out.routes[route]) out.routes[route] = {};
    out.routes[route][dir] = {
      headsign: dom.headsign,
      terminalLat: dom.terminalLat,
      terminalLon: dom.terminalLon,
      originLat: dom.originLat,
      originLon: dom.originLon,
      headways: dom.headways,
      durations: dom.durations,
      patterns: list,
    };
  }

  // Active-trip counts emit separately — hours with zero starts can still
  // have trips in progress that began earlier. Create the route/dir entry
  // here too (not just from the headway-bearing pattern loop above) — a
  // route whose patterns never individually got 2 same-hour departures
  // (e.g. one that alternates between two termini from the same origin)
  // still has perfectly good activeByHour data and shouldn't lose it for
  // lack of a headway-bearing pattern.
  for (const [key, count] of activeBuckets) {
    const [route, dir, dayType, hourStr] = key.split('|');
    const hour = parseInt(hourStr, 10);
    if (!out.routes[route]) out.routes[route] = {};
    if (!out.routes[route][dir]) {
      out.routes[route][dir] = {
        headsign: null,
        terminalLat: null,
        terminalLon: null,
        originLat: null,
        originLon: null,
        headways: {},
        durations: {},
        patterns: [],
      };
    }
    if (!out.routes[route][dir].activeByHour) out.routes[route][dir].activeByHour = {};
    if (!out.routes[route][dir].activeByHour[dayType])
      out.routes[route][dir].activeByHour[dayType] = {};
    out.routes[route][dir].activeByHour[dayType][hour] = Math.round(count * 10) / 10;
  }

  // Coarse fallback headway: routes whose per-pattern computation produced no
  // headway at all (branch-alternating routes — see computeFallbackHeadway)
  // still need *some* headway value for expectedBusRouteHeadwayMin /
  // bin/bus/thin-gaps.js to size its detection window. Only fills hours that
  // already have activeByHour data, and only when the route has enough
  // same-direction trips at a sane-enough spacing — see computeFallbackHeadway's
  // minTrips/maxGapMin guards.
  for (const [route, byDir] of Object.entries(out.routes)) {
    for (const [dir, info] of Object.entries(byDir)) {
      if (Object.keys(info.headways).length > 0) continue; // already has real per-pattern headway
      for (const dayType of Object.keys(info.activeByHour || {})) {
        const departures = allDeparturesByRouteDirDayType.get(`${route}|${dir}|${dayType}`);
        const fallback = computeFallbackHeadway(departures);
        if (fallback == null) continue;
        if (!info.headways[dayType]) info.headways[dayType] = {};
        for (const hour of Object.keys(info.activeByHour[dayType])) {
          info.headways[dayType][hour] = fallback;
        }
      }
    }
  }

  // trip_id → { route, dir, shapeId } so the GTFS-realtime adapter (src/bus/api.js)
  // can resolve a live vehicle's true direction_id and shape — COTA's realtime
  // direction_id doesn't reliably match the static schedule's for the same trip,
  // so this lookup, not the live field, is the source of truth.
  for (const [tripId, meta] of tripMeta) {
    out.trips[tripId] = { route: meta.route, dir: meta.dir, shapeId: meta.shapeId };
  }

  console.log('Reading shapes.txt...');
  const usedShapeIds = new Set([...tripMeta.values()].map((m) => m.shapeId).filter(Boolean));
  let shapeRows = [];
  try {
    shapeRows = parseCsv(await readFromZip('shapes.txt'));
  } catch (e) {
    console.warn(
      `  could not read shapes.txt: ${e.message} — pdist projection will be unavailable`,
    );
  }
  const shapePoints = new Map(); // shape_id → [{ lat, lon, seq }]
  for (const r of shapeRows) {
    if (!usedShapeIds.has(r.shape_id)) continue;
    if (!shapePoints.has(r.shape_id)) shapePoints.set(r.shape_id, []);
    shapePoints.get(r.shape_id).push({
      lat: parseFloat(r.shape_pt_lat),
      lon: parseFloat(r.shape_pt_lon),
      seq: parseInt(r.shape_pt_sequence, 10),
    });
  }
  // Pick one representative trip per shape_id (the one with the most stops,
  // for the most complete stop list) to merge named stops into the shape's
  // point list — CTA's BusTime pattern is exactly this: an ordered polyline
  // with stop waypoints (type 'S') interleaved. src/bus/patterns.js#findNearestStop
  // assumes every pattern has at least one such point and isn't defensive
  // about an empty list, so every shape used by an active trip must get one.
  const tripsByShapeId = new Map(); // shape_id → [trip_id, ...]
  for (const [tripId, meta] of tripMeta) {
    if (!meta.shapeId) continue;
    if (!tripsByShapeId.has(meta.shapeId)) tripsByShapeId.set(meta.shapeId, []);
    tripsByShapeId.get(meta.shapeId).push(tripId);
  }

  for (const [shapeId, points] of shapePoints) {
    const ordered = [...points].sort((a, b) => a.seq - b.seq);
    // Cumulative distance measured ourselves (haversine) rather than trusting
    // shapes.txt's own shape_dist_traveled column — see shapeProjection.js.
    const shapeWithDist = withCumulativeDistFt(ordered);

    const candidateTrips = tripsByShapeId.get(shapeId) || [];
    let bestStops = null;
    for (const tripId of candidateTrips) {
      const stops = busTripStops.get(tripId);
      if (stops && (!bestStops || stops.length > bestStops.length)) bestStops = stops;
    }
    const stopPoints = [];
    for (const s of bestStops || []) {
      const stop = byStopId.get(s.stopId);
      if (!stop) continue;
      const lat = parseFloat(stop.stop_lat);
      const lon = parseFloat(stop.stop_lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const proj = projectOntoShape(lat, lon, shapeWithDist);
      stopPoints.push({
        lat,
        lon,
        distFt: proj ? proj.distFt : 0,
        type: 'S',
        stopId: s.stopId,
        stopName: stop.stop_name || s.stopId,
      });
    }
    if (stopPoints.length === 0) {
      console.warn(
        `  shape ${shapeId}: no stops resolved — bunching/gap "near stop" text will be unavailable`,
      );
    }

    out.shapes[shapeId] = [...shapeWithDist, ...stopPoints].sort((a, b) => a.distFt - b.distFt);
  }
  console.log(`  ${out.shapes ? Object.keys(out.shapes).length : 0} shapes geometried`);

  Fs.ensureDirSync(Path.dirname(OUT_PATH));
  Fs.writeJsonSync(OUT_PATH, out);
  const bytes = Fs.statSync(OUT_PATH).size;
  const routeCount = Object.keys(out.routes).length;
  const tripCount = Object.keys(out.trips).length;
  const shapeCount = Object.keys(out.shapes).length;
  console.log(
    `Wrote ${OUT_PATH} (${(bytes / 1024).toFixed(1)} KB, ${routeCount} routes, ${tripCount} trips, ${shapeCount} shapes)`,
  );
}

module.exports = {
  computeBusDominantOrigin,
  BUS_DOMINANCE_THRESHOLD,
  resolveServiceDayTypes,
  dayTypeFor,
  computeFallbackHeadway,
  resolveHourlyHeadway,
};

if (require.main === module) {
  main().catch((e) => {
    console.error(e.stack || e);
    process.exit(1);
  });
}
