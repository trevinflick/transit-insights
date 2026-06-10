// Metra speedmap — corridor speeds colored by how fast trains are actually
// moving. Position-based, so it reuses the CTA train speedmap geometry/sampling
// machinery (snap-to-line, per-segment mph, binning) wholesale; the only Metra
// specifics are (a) reading recorded positions from the DB instead of polling
// live for an hour (observeMetra already densifies the observations table at
// 30s), (b) resolving direction from the GTFS trip_id → schedule index rather
// than a CTA trDr code, and (c) faster speed thresholds (commuter rail cruises
// at 50–70 mph vs the L's ~25).
//
// v1 scope: render the line's single longest GTFS shape as the corridor. Trains
// on diverging branches (ME's South Chicago/Blue Island, UP-NW McHenry, RI
// branches) project off-line and are dropped by maxPerpFt — branch coverage is
// a later refinement. Documented in docs/METRA.md.

const { cumulativeDistances } = require('../shared/geo');
const { computeTrainSamples } = require('../train/speedmap');

// Commuter rail runs much faster than the L, so the CTA TRAIN_THRESHOLDS
// (15/25/35/45) would paint nearly everything green. These spread the gradient
// across Metra's real range: red = crawling (approaching a terminal / congested),
// green = track speed.
const METRA_THRESHOLDS = { orange: 25, yellow: 40, purple: 55, green: 70 };

// Metra express segments legitimately hit ~79 mph, so the 70 mph CTA cap would
// drop real samples. 95 still rejects snap/feed artifacts.
const METRA_SAMPLE_OPTS = { maxMph: 95, maxPerpFt: 1500 };

// Pick a line's representative corridor: the longest GTFS shape (most points).
// metraLines.json maps route_id → array of polylines (one per shape: directions
// + branches). Returns { points: [[lat,lon],…], cumDist, totalFt } or null.
function buildLineCorridor(metraLines, route) {
  const polylines = metraLines[route] || [];
  let best = null;
  for (const pl of polylines) {
    if (!Array.isArray(pl) || pl.length < 2) continue;
    if (!best || pl.length > best.length) best = pl;
  }
  if (!best) return null;
  const cumDist = cumulativeDistances(best.map(([lat, lon]) => ({ lat, lon })));
  return { points: best, cumDist, totalFt: cumDist[cumDist.length - 1] };
}

// GTFS direction_id by convention: 1 = inbound (toward downtown Chicago),
// 0 = outbound. Used for ribbon labels.
function directionLabel(dirKey) {
  if (dirKey === '1') return 'Inbound';
  if (dirKey === '0') return 'Outbound';
  return 'Unknown direction';
}

// Build the `tracks` structure computeTrainSamples expects — Map<trackKey,
// Map<dirKey, positions[]>> — from recorded observation rows. Each trip_id is a
// track; its direction comes from the schedule index. Positions sorted later by
// computeTrainSamples. Rows without a usable trip/direction are still binned
// under 'unknown' so a corridor with stale geometry still renders something.
function buildMetraTracks(rows, tripIndex) {
  const tracks = new Map();
  for (const r of rows) {
    if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon)) continue;
    const key = r.trip_id || r.vehicle_id;
    if (!key) continue;
    const dir = r.trip_id ? tripIndex?.[r.trip_id]?.direction_id : null;
    const dirKey = dir == null ? 'unknown' : String(dir);
    if (!tracks.has(key)) tracks.set(key, new Map());
    const byDir = tracks.get(key);
    if (!byDir.has(dirKey)) byDir.set(dirKey, []);
    byDir.get(dirKey).push({ t: r.ts, lat: r.lat, lon: r.lon });
  }
  return tracks;
}

// Compute per-direction speed samples for one line over the supplied position
// rows. Returns { byDir, rnsByDir, stats } straight from computeTrainSamples
// (keyed by dirKey '0'/'1'/'unknown').
function computeMetraSamples(rows, corridor, tripIndex) {
  const tracks = buildMetraTracks(rows, tripIndex);
  return computeTrainSamples(tracks, corridor.points, corridor.cumDist, METRA_SAMPLE_OPTS);
}

module.exports = {
  METRA_THRESHOLDS,
  METRA_SAMPLE_OPTS,
  buildLineCorridor,
  buildMetraTracks,
  computeMetraSamples,
  directionLabel,
};
