#!/usr/bin/env node
// Backfills the permanent fleet tables (vehicle_days, fleet_days) from the
// 7-day observations window held in the live DB and in old DB snapshots.
// Idempotent — safe to re-run over the same or overlapping inputs.
//
// Usage:
//   node scripts/seed-fleet-history.js [snapshot.sqlite[.gz] | dir ...]
//
// With no arguments, seeds from the live DB's own observations only. A
// directory argument means every history-*.sqlite[.gz] inside it (e.g.
// state/db-backups/). Gzipped snapshots are decompressed one at a time to a
// temp file next to the live DB, then deleted.

require('../src/shared/env');

const Fs = require('node:fs');
const Path = require('node:path');
const Zlib = require('node:zlib');
const Database = require('better-sqlite3');
const { getDb } = require('../src/shared/history');
const { seedFromObservations } = require('../src/shared/fleetHistory');

function expand(args) {
  const files = [];
  for (const a of args) {
    if (Fs.statSync(a).isDirectory()) {
      for (const f of Fs.readdirSync(a).sort()) {
        if (/^history-.*\.sqlite(\.gz)?$/.test(f)) files.push(Path.join(a, f));
      }
    } else {
      files.push(a);
    }
  }
  return files;
}

function main() {
  const target = getDb();
  const tmp = Path.join(Path.dirname(target.name), `seed-fleet-${process.pid}.sqlite`);
  for (const file of expand(process.argv.slice(2))) {
    let path = file;
    if (file.endsWith('.gz')) {
      Fs.writeFileSync(tmp, Zlib.gunzipSync(Fs.readFileSync(file)));
      path = tmp;
    }
    const source = new Database(path, { readonly: true });
    try {
      const r = seedFromObservations(source, target);
      console.log(`${Path.basename(file)}: ${r.vehicleDays} bus-days over ${r.dates} date(s)`);
    } finally {
      source.close();
      if (path === tmp) Fs.rmSync(tmp, { force: true });
    }
  }
  const r = seedFromObservations(target, target);
  console.log(`live observations: ${r.vehicleDays} bus-days over ${r.dates} date(s)`);
}

main();
