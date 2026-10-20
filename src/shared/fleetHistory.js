const { getDb } = require('./history');

// Permanent per-bus, per-day fleet history (vehicle_days + fleet_days in
// history.js). observations roll off after 7 days, so this is the only record
// of which buses were in service when — e.g. when a new 26xx series entered
// service, or whether total buses on the road went up.

const DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function etDate(ts) {
  return DATE_FMT.format(new Date(ts));
}

// COTA's vehicle.id is "1" + the fleet number (11303 -> 1303), confirmed
// against vehicle.label for every bus in the live feed. Used when the feed's
// label isn't available, e.g. when seeding from old observations.
function fleetNumber(vehicleId) {
  const s = String(vehicleId);
  return /^1\d{4}$/.test(s) ? s.slice(1) : s;
}

function mergeRoutes(a, b) {
  const set = new Set([...(a ? a.split(',') : []), ...(b ? b.split(',') : [])]);
  return [...set].sort().join(',') || null;
}

// rows: [{ date, vehicle_id, label, first_ts, last_ts, ticks, routes }]
// Merges into existing rows: earliest first_ts, latest last_ts, route union.
// ticks is summed for live ticks (addTicks) and max'd for seeding, where
// overlapping snapshots each hold a partial count of the same day.
function upsertVehicleDays(db, rows, { addTicks }) {
  const get = db.prepare('SELECT * FROM vehicle_days WHERE date = ? AND vehicle_id = ?');
  const put = db.prepare(`
    INSERT OR REPLACE INTO vehicle_days (date, vehicle_id, label, first_ts, last_ts, ticks, routes)
    VALUES (@date, @vehicle_id, @label, @first_ts, @last_ts, @ticks, @routes)
  `);
  for (const r of rows) {
    const old = get.get(r.date, r.vehicle_id);
    if (!old) {
      put.run(r);
      continue;
    }
    put.run({
      date: r.date,
      vehicle_id: r.vehicle_id,
      label: r.label || old.label,
      first_ts: Math.min(old.first_ts, r.first_ts),
      last_ts: Math.max(old.last_ts, r.last_ts),
      ticks: addTicks ? old.ticks + r.ticks : Math.max(old.ticks, r.ticks),
      routes: mergeRoutes(old.routes, r.routes),
    });
  }
}

function upsertFleetDay(db, { date, peak_active, peak_ts }) {
  db.prepare(`
    INSERT INTO fleet_days (date, peak_active, peak_ts) VALUES (?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET peak_active = excluded.peak_active, peak_ts = excluded.peak_ts
    WHERE excluded.peak_active > fleet_days.peak_active
  `).run(date, peak_active, peak_ts);
}

// Called once per observer tick with the full-system vehicle list. Errors are
// swallowed so a logger hiccup never breaks the observer.
function recordFleetTick(vehicles, now = Date.now()) {
  if (!vehicles || vehicles.length === 0) return;
  try {
    const db = getDb();
    const date = etDate(now);
    const byVid = new Map();
    for (const v of vehicles) {
      if (!v?.vid) continue;
      const vid = String(v.vid);
      const prev = byVid.get(vid);
      byVid.set(vid, {
        date,
        vehicle_id: vid,
        label: v.label != null ? String(v.label) : fleetNumber(vid),
        first_ts: now,
        last_ts: now,
        ticks: 1,
        routes: mergeRoutes(prev?.routes, v.route != null ? String(v.route) : null),
      });
    }
    db.transaction(() => {
      upsertVehicleDays(db, [...byVid.values()], { addTicks: true });
      upsertFleetDay(db, { date, peak_active: byVid.size, peak_ts: now });
    })();
  } catch (e) {
    console.warn(`recordFleetTick failed: ${e.message}`);
  }
}

// Folds a (possibly old, possibly snapshot) DB's bus observations into the
// permanent tables of `target`. Idempotent: re-running over the same or
// overlapping sources leaves the same result.
function seedFromObservations(source, target = getDb()) {
  const ticks = source
    .prepare(`
      SELECT ts, vehicle_id, group_concat(DISTINCT route) routes
      FROM observations WHERE kind = 'bus'
      GROUP BY ts, vehicle_id ORDER BY ts
    `)
    .all();
  const days = new Map();
  const peaks = new Map();
  let curTs = null;
  let curCount = 0;
  const closeTick = () => {
    if (curTs == null) return;
    const date = etDate(curTs);
    const p = peaks.get(date);
    if (!p || curCount > p.peak_active)
      peaks.set(date, { date, peak_active: curCount, peak_ts: curTs });
  };
  for (const t of ticks) {
    if (t.ts !== curTs) {
      closeTick();
      curTs = t.ts;
      curCount = 0;
    }
    curCount++;
    const date = etDate(t.ts);
    const key = `${date}|${t.vehicle_id}`;
    const d = days.get(key);
    if (!d) {
      days.set(key, {
        date,
        vehicle_id: t.vehicle_id,
        label: fleetNumber(t.vehicle_id),
        first_ts: t.ts,
        last_ts: t.ts,
        ticks: 1,
        routes: mergeRoutes(null, t.routes),
      });
    } else {
      d.last_ts = t.ts;
      d.ticks++;
      d.routes = mergeRoutes(d.routes, t.routes);
    }
  }
  closeTick();
  target.transaction(() => {
    upsertVehicleDays(target, [...days.values()], { addTicks: false });
    for (const p of peaks.values()) upsertFleetDay(target, p);
  })();
  return { vehicleDays: days.size, dates: peaks.size };
}

// Per-date summary: distinct buses, peak at once, and distinct buses per
// series (first two digits of the fleet number).
function getFleetDays({ from = '0000-00-00', to = '9999-99-99' } = {}) {
  const db = getDb();
  const peaks = db
    .prepare('SELECT * FROM fleet_days WHERE date BETWEEN ? AND ? ORDER BY date')
    .all(from, to);
  const series = db
    .prepare(`
      SELECT date, substr(label, 1, 2) series, count(*) n FROM vehicle_days
      WHERE date BETWEEN ? AND ? GROUP BY date, series
    `)
    .all(from, to);
  return peaks.map((p) => {
    const bySeries = {};
    for (const s of series) if (s.date === p.date) bySeries[s.series] = s.n;
    const distinct = Object.values(bySeries).reduce((a, b) => a + b, 0);
    return { date: p.date, peakActive: p.peak_active, peakTs: p.peak_ts, distinct, bySeries };
  });
}

// One row per bus: first/last date seen and days in service. Optional label
// prefix filter, e.g. '26' for the 26xx series.
function getVehicles({ series } = {}) {
  return getDb()
    .prepare(`
      SELECT label, vehicle_id vehicleId, min(first_ts) firstTs, max(last_ts) lastTs,
             min(date) firstDate, max(date) lastDate, count(*) daysInService
      FROM vehicle_days WHERE (? IS NULL OR label LIKE ? || '%')
      GROUP BY vehicle_id ORDER BY firstTs
    `)
    .all(series ?? null, series ?? null);
}

module.exports = {
  etDate,
  fleetNumber,
  recordFleetTick,
  seedFromObservations,
  getFleetDays,
  getVehicles,
};
