// Service-alert disruption map: highlights the affected route pattern(s) on
// a basemap. Built for whole-trip/block cancellations specifically — those
// can affect 200+ individual stops across a handful of trips (too many to
// name in a post), but the affected ROUTE is easy to show and gives riders
// an immediate "is this my route" visual. Single-stop closures/detours
// don't use this (COTA's own alert text already names the one stop).
const sharp = require('sharp');
const { encode } = require('../../shared/polyline');
const { fitZoom } = require('../../shared/projection');
const {
  STYLE,
  WIDTH,
  HEIGHT,
  requireMapboxToken,
  fetchMapboxStatic,
  thinPolylinePoints,
  bboxOf,
} = require('../common');

const ROUTE_HALO_STROKE = 11;
const ROUTE_HALO_COLOR = '000000';
const ROUTE_CORE_STROKE = 6;
const ROUTE_CORE_COLOR = 'ff2a6d'; // same pink/red used for bus markers elsewhere — reads as "alert"
const MAX_POINTS_PER_SHAPE = 150; // same URL-length guard as speedmap/bunching/gaps

// `shapes` = [{ points: [{lat,lon}, ...] }, ...] — one entry per distinct
// pattern affected (e.g. the cancelled trips' resolved shapes, deduped by
// shape_id by the caller). Returns null if nothing renderable was passed in
// (caller falls back to a text-only post, matching the rest of this codebase).
async function renderDisruptionMap(shapes) {
  const overlays = [];
  const allPoints = [];
  for (const shape of shapes || []) {
    const thinned = thinPolylinePoints(shape.points, MAX_POINTS_PER_SHAPE);
    if (thinned.length < 2) continue;
    const encoded = encodeURIComponent(encode(thinned.map((p) => [p.lat, p.lon])));
    overlays.push(`path-${ROUTE_HALO_STROKE}+${ROUTE_HALO_COLOR}(${encoded})`);
    overlays.push(`path-${ROUTE_CORE_STROKE}+${ROUTE_CORE_COLOR}(${encoded})`);
    allPoints.push(...thinned);
  }
  if (overlays.length === 0) return null;

  const bbox = bboxOf(allPoints);
  const rawZoom = fitZoom(bbox, WIDTH, HEIGHT, 60);
  const zoom = Math.max(10, Math.min(16, Math.floor(rawZoom)));
  const centerLat = (bbox.minLat + bbox.maxLat) / 2;
  const centerLon = (bbox.minLon + bbox.maxLon) / 2;

  const token = requireMapboxToken();
  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${overlays.join(',')}/${centerLon.toFixed(5)},${centerLat.toFixed(5)},${zoom.toFixed(2)}/${WIDTH}x${HEIGHT}@2x?access_token=${token}`;
  const data = await fetchMapboxStatic(url);
  return sharp(data).jpeg({ quality: 85 }).toBuffer();
}

module.exports = { renderDisruptionMap };
