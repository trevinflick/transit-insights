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
  requireMapboxToken,
  fetchMapboxStatic,
} = require('../common');

async function renderSpeedmap(pattern, binSpeeds) {
  const points = pattern.points; // { lat, lon, ... }
  const cumDist = cumulativeDistances(points);
  const slices = sliceIntoSegments(points, cumDist, binSpeeds.length);

  // Full-route dark halo rendered first, then each colored segment layered on top.
  const fullEncoded = encodeURIComponent(encode(points.map((p) => [p.lat, p.lon])));
  const overlays = [`path-${SPEEDMAP_HALO_STROKE}+${ROUTE_HALO_COLOR}(${fullEncoded})`];

  for (let i = 0; i < slices.length; i++) {
    if (slices[i].length < 2) continue;
    const encoded = encodeURIComponent(encode(slices[i].map((p) => [p.lat, p.lon])));
    const color = colorForBusSpeed(binSpeeds[i]);
    overlays.push(`path-${SPEEDMAP_SEGMENT_STROKE}+${color}(${encoded})`);
  }

  const token = requireMapboxToken();
  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${overlays.join(',')}/auto/${WIDTH}x${HEIGHT}@2x?access_token=${token}&padding=30`;
  const data = await fetchMapboxStatic(url);
  return sharp(data).jpeg({ quality: 85 }).toBuffer();
}

module.exports = { renderSpeedmap };
