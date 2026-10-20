# Fleet history

Which COTA buses were in service on which days, kept permanently (the
`observations` table only holds 7 days). Built to answer questions like "when
did the new 26xx buses enter service?" and "are more buses on the road than
before?"

## Data

- `vehicle_days` — one row per bus per America/New_York calendar date it
  reported a position: `label` (fleet number), first/last time seen, `ticks`
  (observer minutes seen), and the routes it ran.
- `fleet_days` — per date, the most buses reporting in a single observer tick
  (`peak_active`) and when.

Written every minute by `scripts/observeBuses.js` via
`src/shared/fleetHistory.js#recordFleetTick`. Neither table is rolled off.

**Fleet numbers.** COTA's GTFS-rt `vehicle.label` is the number painted on
the bus (e.g. `2602`); `vehicle.id` is `"1"` + that (`12602`). The first two
digits are the series, which tracks model year (13xx = 2013 … 26xx = 2026).
`fleetNumber()` derives the label from the id when the feed's label isn't
available (seeding from old observations).

**Peak vs. distinct.** `peak_active` is the best "buses on the road" number;
distinct buses per day also counts a bus that ran one short trip.

## Commands

```sh
# Per-date peak + distinct buses by series, and each 26xx bus's first day
docker exec transit-insights node scripts/fleet-report.js --days=60 --series=26
docker exec transit-insights node scripts/fleet-report.js --csv > fleet.csv

# Backfill from DB snapshots (idempotent; also folds in live observations)
docker exec transit-insights node scripts/seed-fleet-history.js /app/state/db-backups
```

## Coverage

Seeded from the 43 daily snapshots in `state/db-backups/` on the server
(Sep 8 – Oct 20, 2026, each holding 7 days of observations), so history starts
**Sep 1, 2026**. The first 26xx bus (2602) appeared Sep 4, 2026.
