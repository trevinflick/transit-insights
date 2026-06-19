// COTA's GTFS-realtime feed doesn't expose vehicle type. We'd classify by vid
// range the same way CTA's fleet was, but COTA's articulated-bus ranges
// aren't catalogued yet — see ./data/artics.json (empty for now).
const articData = require('./data/artics.json');

const RANGES = Array.isArray(articData?.articRanges) ? articData.articRanges : [];

// Returns true when vid falls inside a known articulated range. Unknown vids
// (parse failures, future deliveries we haven't catalogued) return false —
// falsely classifying a 40-footer as artic is the worse failure mode.
function isArticulated(vid) {
  const n = parseInt(vid, 10);
  if (!Number.isFinite(n)) return false;
  for (const r of RANGES) {
    if (n >= r.lo && n <= r.hi) return true;
  }
  return false;
}

module.exports = { isArticulated };
