#!/usr/bin/env node
// Hourly "buses in service" curve per route, straight from the GTFS index's
// activeByHour (see scripts/fetch-gtfs.js#L431 — the average number of buses
// simultaneously in revenue service each clock hour, measured by integrating
// each trip's [departure, arrival] overlap with the hour). This is the raw
// substrate behind the single "buses needed" (peak-hour) figure in
// analyze-cancellations-by-line.js — exported in full so the whole daily curve
// is visible (e.g. for a scrollytelling chart of how the fleet requirement
// rises and falls, and how it tracks the changing headway).
//
// Long/tidy format: one row per (route, day_type, hour).
//
// Usage:
//   node scripts/export-active-by-hour.js [--day-type=weekday]
//
//   --day-type=weekday|saturday|sunday   only this day type (default: all three)
//
// Writes CSV to stdout.

require('../src/shared/env');

const Path = require('node:path');
const Fs = require('node:fs');
const argv = require('minimist')(process.argv.slice(2));
const { routeLabel } = require('../src/bus/routes');

const DAY_TYPES = ['weekday', 'saturday', 'sunday'];

function routeSortKey(route) {
  const n = parseInt(route, 10);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

function main() {
  const only = argv['day-type'];
  if (only && !DAY_TYPES.includes(only)) {
    console.error(`--day-type must be one of: ${DAY_TYPES.join(', ')}`);
    process.exit(1);
  }
  const dayTypes = only ? [only] : DAY_TYPES;

  const idxPath = Path.join(__dirname, '..', 'data', 'gtfs', 'index.json');
  const idx = JSON.parse(Fs.readFileSync(idxPath, 'utf8'));

  process.stdout.write(
    'route,route_label,day_type,hour,active_dir0,active_dir1,active_combined,headway_dir0_min,headway_dir1_min\n',
  );

  const routes = Object.keys(idx.routes).sort(
    (a, b) => routeSortKey(a) - routeSortKey(b) || a.localeCompare(b),
  );

  for (const route of routes) {
    const dirs = idx.routes[route];
    const d0 = dirs['0'] || {};
    const d1 = dirs['1'] || {};
    const label = routeLabel(route);

    for (const dayType of dayTypes) {
      // Union of hours present in any direction for this day type.
      const hourSet = new Set();
      for (const d of Object.values(dirs)) {
        for (const h of Object.keys(d.activeByHour?.[dayType] || {})) hourSet.add(Number(h));
      }
      if (hourSet.size === 0) continue;
      const hours = [...hourSet].sort((a, b) => a - b);

      for (const h of hours) {
        const a0 = d0.activeByHour?.[dayType]?.[h] ?? 0;
        const a1 = d1.activeByHour?.[dayType]?.[h] ?? 0;
        // Combined across ALL directions (not just 0/1) in case a route has more.
        let combined = 0;
        for (const d of Object.values(dirs)) combined += d.activeByHour?.[dayType]?.[h] ?? 0;
        const hw0 = d0.headways?.[dayType]?.[h] ?? '';
        const hw1 = d1.headways?.[dayType]?.[h] ?? '';
        process.stdout.write(
          [route, `"${label}"`, dayType, h, a0, a1, Math.round(combined * 10) / 10, hw0, hw1].join(
            ',',
          ) + '\n',
        );
      }
    }
  }
}

main();
