// COTA's GTFS-realtime VehiclePositions gives raw lat/lon but no along-route
// distance ("pdist") the way CTA's BusTime API does server-side. This
// recovers it by snapping the live position onto the trip's precomputed
// static-GTFS shape (see scripts/fetch-gtfs.js, which builds the per-shape_id
// `{ lat, lon, distFt }` arrays from shapes.txt). Nearest-segment projection,
// not vertex-snap — with sparse shapes, snapping to the nearest vertex can be
// off by hundreds of feet, which breaks bunching/gap clustering.
const { haversineFt, cumulativeDistances } = require('../shared/geo');

// Local cos(lat) longitude scaling, recomputed per segment from its own
// endpoints rather than one hardcoded city latitude, so this stays correct
// across any service area.
function projectOntoShape(lat, lon, shapePoints) {
  if (!shapePoints || shapePoints.length < 2) return null;
  let bestAlongFt = 0;
  let bestPerpFt = Infinity;
  for (let i = 0; i < shapePoints.length - 1; i++) {
    const a = shapePoints[i];
    const b = shapePoints[i + 1];
    const cosLat = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
    const ax = a.lon * cosLat;
    const ay = a.lat;
    const bx = b.lon * cosLat;
    const by = b.lat;
    const px = lon * cosLat;
    const py = lat;
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    let t = 0;
    if (lenSq > 0) t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
    const projLat = ay + t * dy;
    const projLon = (ax + t * dx) / cosLat;
    const perpFt = haversineFt({ lat, lon }, { lat: projLat, lon: projLon });
    if (perpFt < bestPerpFt) {
      bestPerpFt = perpFt;
      const segLen = b.distFt - a.distFt;
      bestAlongFt = a.distFt + t * segLen;
    }
  }
  return { distFt: bestAlongFt, perpFt: bestPerpFt };
}

// Attaches cumulative along-shape distance (feet, haversine-measured — not
// trusted off GTFS's own shape_dist_traveled, which some feeds populate in
// inconsistent units or not at all) to an ordered [{lat, lon}, ...] shape.
function withCumulativeDistFt(points) {
  const cum = cumulativeDistances(points);
  return points.map((p, i) => ({ lat: p.lat, lon: p.lon, distFt: cum[i] }));
}

module.exports = { projectOntoShape, withCumulativeDistFt };
