const test = require('node:test');
const assert = require('node:assert/strict');
const Path = require('node:path');
const Fs = require('node:fs');
const Os = require('node:os');
const Database = require('better-sqlite3');

function loadWithDb() {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'ctabot-fleet-history-'));
  process.env.HISTORY_DB_PATH = Path.join(dir, 'history.sqlite');
  for (const m of ['../../src/shared/history', '../../src/shared/fleetHistory']) {
    delete require.cache[require.resolve(m)];
  }
  const history = require('../../src/shared/history');
  const fleet = require('../../src/shared/fleetHistory');
  return {
    db: history.getDb(),
    fleet,
    cleanup: () => {
      history.getDb().close();
      delete require.cache[require.resolve('../../src/shared/history')];
      delete process.env.HISTORY_DB_PATH;
      Fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// 2026-10-20 14:00 EDT
const T = Date.UTC(2026, 9, 20, 18, 0);
const MIN = 60 * 1000;

test('etDate: uses America/New_York calendar date, not UTC', () => {
  const { fleet, cleanup } = loadWithDb();
  try {
    assert.equal(fleet.etDate(Date.UTC(2026, 9, 21, 2, 0)), '2026-10-20'); // 10pm EDT
    assert.equal(fleet.etDate(Date.UTC(2026, 11, 1, 4, 30)), '2026-11-30'); // 11:30pm EST
  } finally {
    cleanup();
  }
});

test('fleetNumber: strips COTA leading 1 from 5-digit ids only', () => {
  const { fleet, cleanup } = loadWithDb();
  try {
    assert.equal(fleet.fleetNumber('12602'), '2602');
    assert.equal(fleet.fleetNumber(11303), '1303');
    assert.equal(fleet.fleetNumber('2602'), '2602');
  } finally {
    cleanup();
  }
});

test('recordFleetTick: accumulates ticks, routes, and the daily peak', () => {
  const { db, fleet, cleanup } = loadWithDb();
  try {
    fleet.recordFleetTick(
      [
        { vid: '12602', label: '2602', route: '010' },
        { vid: '11303', label: '1303', route: '002' },
        { vid: '11304', label: '1304', route: '002' },
      ],
      T,
    );
    fleet.recordFleetTick([{ vid: '12602', label: '2602', route: '024' }], T + MIN);

    const row = db.prepare("SELECT * FROM vehicle_days WHERE vehicle_id = '12602'").get();
    assert.equal(row.date, '2026-10-20');
    assert.equal(row.label, '2602');
    assert.equal(row.ticks, 2);
    assert.equal(row.first_ts, T);
    assert.equal(row.last_ts, T + MIN);
    assert.equal(row.routes, '010,024');

    const [day] = fleet.getFleetDays();
    assert.equal(day.peakActive, 3);
    assert.equal(day.peakTs, T);
    assert.equal(day.distinct, 3);
    assert.deepEqual(day.bySeries, { 13: 2, 26: 1 });
  } finally {
    cleanup();
  }
});

test('seedFromObservations: idempotent, and merges with live ticks', () => {
  const { db, fleet, cleanup } = loadWithDb();
  try {
    const src = new Database(':memory:');
    src.exec('CREATE TABLE observations (ts INTEGER, kind TEXT, route TEXT, vehicle_id TEXT)');
    const ins = src.prepare("INSERT INTO observations VALUES (?, 'bus', ?, ?)");
    ins.run(T - 2 * MIN, '010', '12602');
    ins.run(T - 2 * MIN, '002', '11303');
    ins.run(T - MIN, '003', '12602');
    ins.run(T - 3 * 24 * 60 * MIN, '004', '12601'); // earlier date

    fleet.seedFromObservations(src);
    fleet.seedFromObservations(src);
    fleet.recordFleetTick([{ vid: '12602', label: '2602', route: '010' }], T);

    const row = db.prepare("SELECT * FROM vehicle_days WHERE vehicle_id = '12602'").get();
    assert.equal(row.ticks, 3); // 2 seeded (max'd, not doubled) + 1 live
    assert.equal(row.first_ts, T - 2 * MIN);
    assert.equal(row.last_ts, T);
    assert.equal(row.routes, '003,010');
    assert.equal(row.label, '2602');

    const vehicles = fleet.getVehicles({ series: '26' });
    assert.deepEqual(
      vehicles.map((v) => [v.label, v.firstDate, v.daysInService]),
      [
        ['2601', '2026-10-17', 1],
        ['2602', '2026-10-20', 1],
      ],
    );
    assert.equal(fleet.getFleetDays({ from: '2026-10-20' })[0].peakActive, 2);
  } finally {
    cleanup();
  }
});
