// Metra delay detection — the analog of CTA "gaps", reframed for a timetabled
// railroad. On a clockface schedule the rider-facing number isn't a headway
// ratio, it's "how late is my train": delay = predicted − scheduled arrival.
//
// The raw per-stop delay is already captured every tick by observeMetra
// (metra_trip_updates.delay_sec, straight from the GTFS-rt StopTimeEvent), so
// this module doesn't re-fetch — it works over the per-trip MAX delay across the
// rollup window (the worst lateness each train reached this hour). The bin
// records trains past the threshold to disruption_events (website-data-first,
// like cancellations) and folds a per-line "N trains 15+ min late" line into the
// hourly service rollup. Pure + injected so it's unit-testable.

// A Metra train is "significantly late" at 15+ min. Metra's own on-time bar is
// < 6 min at the terminal, but posting every 6-min-late train would be constant
// noise — 15 min is clearly newsworthy and keeps the rollup quiet on normal days.
// Tunable; calibrate against a shadow week.
const DELAY_THRESHOLD_SEC = 15 * 60;

// Filter per-trip max-delay rows to the significant ones. `rows` is
// [{tripId, route, maxDelay}] (seconds). Returns enriched delay events sorted
// worst-first, each carrying delaySec + delayMin for the post + evidence.
function significantDelays(rows, thresholdSec = DELAY_THRESHOLD_SEC) {
  return rows
    .filter((r) => Number.isFinite(r.maxDelay) && r.maxDelay >= thresholdSec)
    .map((r) => ({
      tripId: r.tripId,
      route: r.route,
      delaySec: r.maxDelay,
      delayMin: Math.round(r.maxDelay / 60),
      source: 'delay',
    }))
    .sort((a, b) => b.delaySec - a.delaySec);
}

module.exports = { significantDelays, DELAY_THRESHOLD_SEC };
