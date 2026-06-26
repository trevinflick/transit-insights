// System-wide fleet-degradation rollup. gaps.js/ghosts.js/thin-gaps.js
// already record a meta_signal for every gap/ghost/thin-gap candidate
// (posted or suppressed) — this detector is a pure aggregation over rows
// already queried from that table, looking for "many routes degraded at
// once" rather than any single route's own worst moments. Built because
// per-route daily caps (e.g. bin/bus/gaps.js's BUS_GAP_DAILY_CAP=3) mean a
// route stuck bad all day only shows its 3 worst posts — this catches the
// network-wide pattern that implies (e.g. a fleet-wide vehicle shortage)
// without asserting a cause the bot can't actually confirm.

const ROLLUP_SOURCES = new Set(['gap', 'ghost', 'thin-gap']);
const MIN_SEVERITY = 0.5;
// ~30% of the 27 routes gap/ghost/thin-gap detection actually covers
// (gaps ∪ ghosts ∪ lowFrequency in src/bus/routes.js) — high enough that a
// handful of routine, unrelated gaps in any 2-hour window doesn't trip it.
const MIN_ROUTES_FOR_ROLLUP = 8;

/**
 * `rows` are meta_signals-shaped: { line, source, severity, ... } — typically
 * every row in a trailing window for kind='bus', unfiltered by source (this
 * function does that filtering itself, in pure/testable code rather than in
 * SQL). Dedupes by route: a route flagged multiple times, or by more than
 * one source, counts once, using its highest severity seen.
 *
 * Returns null when fewer than `minRoutes` distinct routes qualify, else
 * `{ degradedCount, monitoredRouteCount, worstRoutes }` (worstRoutes = up to
 * 3 route ids, highest severity first).
 */
function detectSystemWideDegradation(
  rows,
  {
    monitoredRouteCount,
    minRoutes = MIN_ROUTES_FOR_ROLLUP,
    minSeverity = MIN_SEVERITY,
    sources = ROLLUP_SOURCES,
  } = {},
) {
  const bySeverity = new Map();
  for (const r of rows || []) {
    if (!sources.has(r.source)) continue;
    if (r.severity == null || r.severity < minSeverity) continue;
    const prev = bySeverity.get(r.line);
    if (prev == null || r.severity > prev) bySeverity.set(r.line, r.severity);
  }
  if (bySeverity.size < minRoutes) return null;

  const worstRoutes = [...bySeverity.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([line]) => line);

  return { degradedCount: bySeverity.size, monitoredRouteCount, worstRoutes };
}

module.exports = {
  detectSystemWideDegradation,
  ROLLUP_SOURCES,
  MIN_SEVERITY,
  MIN_ROUTES_FOR_ROLLUP,
};
