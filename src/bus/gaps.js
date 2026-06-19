const STALE_MS = 3 * 60 * 1000;
// 10 mph ≈ 880 ft/min once stops + signals are factored in. Crude, but only
// used as a ratio against GTFS-scheduled headway — not an absolute ETA.
const TYPICAL_SPEED_FT_PER_MIN = 880;
const { terminalZoneFt } = require('../shared/geo');
const { projectOntoShape } = require('./shapeProjection');
// Absolute floor protects low-frequency routes (30-min schedule) from
// spamming on every 31-min drift.
const RATIO_THRESHOLD = 2.5;
const ABSOLUTE_MIN_MIN = 15;
// "Is this sibling vehicle still on the shared trunk" gate for
// isGapFilledBySibling — same order of magnitude as this codebase's other
// "meaningfully on this route" thresholds (scheduleDeviationMin's
// MAX_OFFROUTE_FT=600, bunching's 800 ft cluster threshold).
const SIBLING_MAX_PERP_FT = 1200;

function detectAllGaps(vehicles, expectedHeadwayForPid, patternForPid, now = new Date()) {
  const fresh = vehicles.filter((v) => now - v.tmstmp < STALE_MS);

  const byPid = new Map();
  for (const v of fresh) {
    if (!byPid.has(v.pid)) byPid.set(v.pid, []);
    byPid.get(v.pid).push(v);
  }

  const gaps = [];
  for (const [pid, group] of byPid) {
    if (group.length < 2) continue;
    const expectedMin = expectedHeadwayForPid(pid);
    if (expectedMin == null) continue;

    const sorted = [...group].sort((a, b) => a.pdist - b.pdist);
    const pattern = patternForPid(pid);
    const patternLengthFt = pattern?.lengthFt || 0;
    if (!patternLengthFt) continue;
    const zoneFt = terminalZoneFt(patternLengthFt);
    // Named stops along the pattern, used to find the pair flanking each gap.
    const patternStops = (pattern?.points || []).filter(
      (p) => p.type === 'S' && p.stopName && p.pdist != null,
    );

    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      const gapFt = b.pdist - a.pdist;
      const gapMin = gapFt / TYPICAL_SPEED_FT_PER_MIN;

      // Buses inside the terminal zone aren't in "service territory" yet —
      // their headway measurement against the next bus is misleading.
      if (a.pdist < zoneFt) continue;
      if (patternLengthFt - b.pdist < zoneFt) continue;

      const ratio = gapMin / expectedMin;
      if (gapMin < ABSOLUTE_MIN_MIN) continue;
      if (ratio < RATIO_THRESHOLD) continue;

      // Stops flanking the empty stretch — the stop just *outside* each bus — so
      // the post can name the gap as a range ("between A and B") instead of
      // collapsing a multi-mile hole onto one stop. flankBefore sits behind the
      // trailing bus (a, lower pdist); flankAfter sits ahead of the leading bus
      // (b, higher pdist).
      let flankBefore = null;
      let flankAfter = null;
      for (const s of patternStops) {
        if (s.pdist < a.pdist) {
          if (!flankBefore || s.pdist > flankBefore.pdist) flankBefore = s;
        } else if (s.pdist > b.pdist) {
          if (!flankAfter || s.pdist < flankAfter.pdist) flankAfter = s;
        }
      }

      gaps.push({
        pid,
        route: a.route,
        // a is upstream (sorted by pdist asc) — a rider near `leading` (b) just
        // watched it pass and is waiting on `trailing` (a).
        leading: b,
        trailing: a,
        flankBefore: flankBefore
          ? {
              stopName: flankBefore.stopName,
              pdist: flankBefore.pdist,
              lat: flankBefore.lat,
              lon: flankBefore.lon,
            }
          : null,
        flankAfter: flankAfter
          ? {
              stopName: flankAfter.stopName,
              pdist: flankAfter.pdist,
              lat: flankAfter.lat,
              lon: flankAfter.lon,
            }
          : null,
        gapFt,
        gapMin,
        expectedMin,
        ratio,
      });
    }
  }

  gaps.sort((a, b) => b.ratio - a.ratio);
  return gaps;
}

// detectAllGaps groups strictly by pid (one specific shape) for its spatial
// pdist math. A route that splits into two termini from one origin (e.g.
// COTA Route 2: "TO REYNOLDSBURG" and "TO HAMILTON ROAD", each ~30 min alone,
// ~15 min combined) gets tracked as two fully separate streams even though
// riders experience one combined service — a bus running on the sibling
// pattern doesn't "fill" a gap detected on the one being watched, producing
// a false "no buses" post while a real bus passes through nearby. This
// checks whether a sibling-pattern vehicle is currently geometrically inside
// the gap's empty stretch, projected onto the *gap's own* pattern shape via
// projectOntoShape — gated by `maxPerpFt` so a sibling that's already
// diverged onto its own branch (large perpendicular distance from this
// shape) correctly does NOT suppress the gap; only one still on the shared
// trunk does. `resolveGroupDir(route, pattern)` should be the same resolver
// passed to detectBusGhosts (src/shared/gtfs.js#resolveDirection in
// production) so "sibling" means "same GTFS direction_id", not just
// "same cardinal label". Pure; exported for testing.
function isGapFilledBySibling({
  gap,
  pattern,
  vehicles,
  resolveGroupDir,
  getPattern,
  now = new Date(),
  maxPerpFt = SIBLING_MAX_PERP_FT,
}) {
  const groupDir = resolveGroupDir(gap.route, pattern);
  if (groupDir == null) return false;

  const shapePoints = (pattern.points || []).map((p) => ({
    lat: p.lat,
    lon: p.lon,
    distFt: p.pdist,
  }));

  const candidates = (vehicles || []).filter(
    (v) => v.route === gap.route && v.pid !== gap.pid && now - v.tmstmp < STALE_MS,
  );
  for (const v of candidates) {
    const siblingPattern = getPattern(v.pid);
    if (!siblingPattern) continue;
    if ((resolveGroupDir(gap.route, siblingPattern) ?? null) !== groupDir) continue;

    const proj = projectOntoShape(v.lat, v.lon, shapePoints);
    if (!proj || proj.perpFt > maxPerpFt) continue;
    if (proj.distFt > gap.trailing.pdist && proj.distFt < gap.leading.pdist) return true;
  }
  return false;
}

module.exports = {
  detectAllGaps,
  isGapFilledBySibling,
  RATIO_THRESHOLD,
  ABSOLUTE_MIN_MIN,
  TYPICAL_SPEED_FT_PER_MIN,
  SIBLING_MAX_PERP_FT,
};
