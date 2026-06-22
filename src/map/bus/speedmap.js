const sharp = require('sharp');
const { encode } = require('../../shared/polyline');
const { cumulativeDistances } = require('../../shared/geo');
const { colorForBusSpeed } = require('../../bus/speedmap');
const {
  STYLE,
  WIDTH,
  HEIGHT,
  ROUTE_HALO_COLOR,
  SPEEDMAP_SEGMENT_STROKE,
  SPEEDMAP_HALO_STROKE,
  sliceIntoSegments,
  thinPolylinePoints,
  requireMapboxToken,
  fetchMapboxStatic,
} = require('../common');

// Per-overlay point caps that keep the static-map URL well under Mapbox/HTTP
// length limits. GTFS shapes carry a vertex every few feet, and encoding that
// same dense geometry once for the halo PLUS once per colored segment
// multiplied the density ~41x — long/complex routes (e.g. 102) blew past the
// URL length limit (HTTP 414) before this. The halo draws the whole route at
// once so it gets more budget; each colored segment only covers ~1/40th of
// the route and stays visually smooth with far fewer points.
const HALO_MAX_POINTS = 150;
const SEGMENT_MAX_POINTS = 20;

async function renderSpeedmap(pattern, binSpeeds) {
  const points = pattern.points; // { lat, lon, ... }
  const cumDist = cumulativeDistances(points);
  const slices = sliceIntoSegments(points, cumDist, binSpeeds.length);

  // Full-route dark halo rendered first, then each colored segment layered on top.
  const haloPoints = thinPolylinePoints(points, HALO_MAX_POINTS);
  const fullEncoded = encodeURIComponent(encode(haloPoints.map((p) => [p.lat, p.lon])));
  const overlays = [`path-${SPEEDMAP_HALO_STROKE}+${ROUTE_HALO_COLOR}(${fullEncoded})`];

  for (let i = 0; i < slices.length; i++) {
    if (slices[i].length < 2) continue;
    const segPoints = thinPolylinePoints(slices[i], SEGMENT_MAX_POINTS);
    const encoded = encodeURIComponent(encode(segPoints.map((p) => [p.lat, p.lon])));
    const color = colorForBusSpeed(binSpeeds[i]);
    overlays.push(`path-${SPEEDMAP_SEGMENT_STROKE}+${color}(${encoded})`);
  }

  const token = requireMapboxToken();
  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${overlays.join(',')}/auto/${WIDTH}x${HEIGHT}@2x?access_token=${token}&padding=30`;
  const data = await fetchMapboxStatic(url);
  return sharp(data).jpeg({ quality: 85 }).toBuffer();
}

module.exports = { renderSpeedmap };
