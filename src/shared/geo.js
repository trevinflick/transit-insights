const EARTH_RADIUS_FT = 20902231; // feet

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function haversineFt(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_FT * Math.asin(Math.sqrt(h));
}

/**
 * Walk pattern points in seq order and return a parallel array of cumulative
 * distance in feet. The CTA API only populates pdist on stop points, so we can't
 * rely on it for slicing arbitrary windows of the polyline.
 */
function cumulativeDistances(points) {
  const result = new Array(points.length);
  result[0] = 0;
  for (let i = 1; i < points.length; i++) {
    result[i] = result[i - 1] + haversineFt(points[i - 1], points[i]);
  }
  return result;
}

/**
 * Bearing in degrees (0 = north, 90 = east) from point a to point b.
 */
function bearing(a, b) {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// 10% of route length, capped — keeps short routes from getting a zone that
// swallows most of the line.
const TERMINAL_ZONE_CAP_FT = 1500;
function terminalZoneFt(lengthFt) {
  return Math.min(TERMINAL_ZONE_CAP_FT, lengthFt * 0.1);
}

// Nearest-segment projection of (lat, lon) onto an ordered polyline
// (`linePoints` as [lat, lon] pairs, `cumDist` the parallel cumulative-feet
// array from cumulativeDistances). Returns the along-line distance only —
// used by bunchingVideo.js/gapVideo.js for snapping a vehicle's raw position
// onto the route for video rendering. Vertex-snapping would be off by
// hundreds of feet on sparse polylines, so this projects onto segments.
function snapToLine(lat, lon, linePoints, cumDist) {
  let bestDist = Infinity;
  let bestCum = 0;
  for (let i = 0; i < linePoints.length - 1; i++) {
    const ax = linePoints[i][1];
    const ay = linePoints[i][0];
    const bx = linePoints[i + 1][1];
    const by = linePoints[i + 1][0];
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    let t = 0;
    if (lenSq > 0) t = Math.max(0, Math.min(1, ((lon - ax) * dx + (lat - ay) * dy) / lenSq));
    const projLat = ay + t * dy;
    const projLon = ax + t * dx;
    const d = haversineFt({ lat, lon }, { lat: projLat, lon: projLon });
    if (d < bestDist) {
      bestDist = d;
      const segLen = cumDist[i + 1] - cumDist[i];
      bestCum = cumDist[i] + t * segLen;
    }
  }
  return bestCum;
}

// Inverse of snapToLine: the {lat, lon} at a given along-line distance.
// Binary-searches cumDist (monotonically increasing) for the bracketing
// segment, then linearly interpolates within it. Clamps to the line's
// endpoints outside [cumDist[0], cumDist[last]].
function pointAlongLine(linePoints, cumDist, dist) {
  if (linePoints.length === 0) return null;
  if (dist <= cumDist[0]) return { lat: linePoints[0][0], lon: linePoints[0][1] };
  const last = linePoints.length - 1;
  if (dist >= cumDist[last]) return { lat: linePoints[last][0], lon: linePoints[last][1] };
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cumDist[mid] <= dist) lo = mid;
    else hi = mid;
  }
  const span = cumDist[hi] - cumDist[lo];
  const t = span === 0 ? 0 : (dist - cumDist[lo]) / span;
  const a = linePoints[lo];
  const b = linePoints[hi];
  return { lat: a[0] + t * (b[0] - a[0]), lon: a[1] + t * (b[1] - a[1]) };
}

module.exports = {
  haversineFt,
  cumulativeDistances,
  bearing,
  terminalZoneFt,
  TERMINAL_ZONE_CAP_FT,
  snapToLine,
  pointAlongLine,
};
