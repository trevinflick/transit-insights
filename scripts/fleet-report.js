#!/usr/bin/env node
// Prints the permanent fleet history: per-date buses in service (distinct
// and peak at once, split by series) and when each bus was first seen.
//
// Usage:
//   node scripts/fleet-report.js [--days=N] [--series=26] [--csv]
//
//   --days=N     Dates to show (default 60)
//   --series=XX  Also list each bus whose fleet number starts with XX, with
//                its first/last date in service
//   --csv        Emit the per-date table as CSV instead of text

require('../src/shared/env');

const argv = require('minimist')(process.argv.slice(2));
const { etDate, getFleetDays, getVehicles } = require('../src/shared/fleetHistory');

const DAYS = Math.max(1, Number(argv.days) || 60);
const from = etDate(Date.now() - DAYS * 24 * 60 * 60 * 1000);
const days = getFleetDays({ from });
const allSeries = [...new Set(days.flatMap((d) => Object.keys(d.bySeries)))].sort();

if (argv.csv) {
  console.log(
    ['date', 'peak_active', 'distinct', ...allSeries.map((s) => `series_${s}xx`)].join(','),
  );
  for (const d of days) {
    console.log(
      [d.date, d.peakActive, d.distinct, ...allSeries.map((s) => d.bySeries[s] || 0)].join(','),
    );
  }
  process.exit(0);
}

const pad = (v, n) => String(v).padStart(n);
console.log(`date        dow  peak  buses  ${allSeries.map((s) => pad(`${s}xx`, 4)).join(' ')}`);
for (const d of days) {
  const dow = new Date(`${d.date}T12:00:00Z`).toUTCString().slice(0, 3);
  const cols = allSeries.map((s) => pad(d.bySeries[s] || 0, 4)).join(' ');
  console.log(`${d.date}  ${dow}  ${pad(d.peakActive, 4)}  ${pad(d.distinct, 5)}  ${cols}`);
}

if (argv.series != null) {
  const series = String(argv.series);
  console.log(`\n${series}xx buses (first seen, last seen, days in service):`);
  for (const v of getVehicles({ series })) {
    const first = new Date(v.firstTs).toLocaleString('en-US', { timeZone: 'America/New_York' });
    console.log(`  ${v.label}  ${first}  ${v.lastDate}  ${pad(v.daysInService, 3)}`);
  }
}
