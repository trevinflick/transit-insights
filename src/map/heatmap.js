const sharp = require('sharp');
const { fitZoom, project } = require('../shared/projection');
const {
  STYLE,
  WIDTH,
  HEIGHT,
  requireMapboxToken,
  fetchMapboxStatic,
  bboxOf,
  paddedBbox,
} = require('./common');

const CIRCLE_COLOR = '#ff2a6d';
const CIRCLE_STROKE = '#fff';
// Log scaling so 10 incidents → ~3× a 1-incident spot, not 10×.
function radiusForCount(count) {
  return Math.round(12 + 14 * Math.log2(count + 1));
}

// Greedy pixel-distance merge: stop names that are geographically close (a
// few intersections apart) project to overlapping circles at citywide zoom,
// hiding smaller bubbles behind big ones. Merge any pair whose centers are
// closer than the larger of the two radii — keep merging until stable.
function clusterByPixels(points, centerLat, centerLon, zoom, width, height, radiusFn) {
  const items = points.map((p) => {
    const { x, y } = project(p.lat, p.lon, centerLat, centerLon, zoom, width, height);
    return {
      x,
      y,
      count: p.count,
      r: radiusFn(p.count),
      // Optional group tag — when set, clustering refuses merges across
      // groups so an inset-bbox bubble doesn't absorb non-inset stations.
      group: p.group,
      // Keep the dominant label so the alt text from the post still maps to a
      // recognizable intersection.
      labels: [{ label: p.label, count: p.count }],
    };
  });

  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i];
        const b = items[j];
        if (a.group && b.group && a.group !== b.group) continue;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < (a.r + b.r) * 0.5) {
          const newCount = a.count + b.count;
          // Weighted centroid keeps the merged bubble visually anchored on
          // the heavier of the two stops.
          const wx = (a.x * a.count + b.x * b.count) / newCount;
          const wy = (a.y * a.count + b.y * b.count) / newCount;
          a.x = wx;
          a.y = wy;
          a.count = newCount;
          a.r = radiusFn(newCount);
          a.labels = [...a.labels, ...b.labels].sort((x, y) => y.count - x.count);
          items.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  return items;
}

function renderClusters(clusters) {
  const sorted = [...clusters].sort((a, b) => a.count - b.count);
  return sorted.map((c) => {
    const fontSize = Math.max(12, Math.round(c.r * 0.9));
    return [
      `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="${c.r}" fill="${CIRCLE_COLOR}" fill-opacity="0.55" stroke="${CIRCLE_STROKE}" stroke-width="2"/>`,
      `<text x="${c.x.toFixed(1)}" y="${(c.y + fontSize / 3).toFixed(1)}" fill="#fff" text-anchor="middle" font-family="Inter, Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="700" stroke="#000" stroke-width="2" paint-order="stroke">${c.count}</text>`,
    ].join('');
  });
}

function legendSamples(maxCount) {
  if (maxCount <= 1) return [1];
  if (maxCount <= 5) return [1, maxCount];
  const mid = Math.max(3, Math.round(maxCount / 3));
  return [1, mid, maxCount];
}

// Sample-dot legend so the image is self-explanatory: counts are events per
// hotspot, sized log-proportionally. Returns { svg, width } so the caller can
// anchor it without overflowing the map. Samples include the largest cluster
// on this map so a "42" hotspot doesn't render bigger than any legend dot.
function buildLegend(maxCount) {
  const samples = legendSamples(maxCount);
  // Scaled-down radii — a 1:1 with map circles makes the legend dwarf small
  // hotspots; halving still preserves the relative scale.
  const legendR = (count) => Math.round(6 + 8 * Math.log2(count + 1));
  const radii = samples.map(legendR);
  const maxR = Math.max(...radii);
  const padX = 14;
  const padY = 12;
  const gap = 16;
  const titleH = 22;
  const innerW = radii.reduce((a, r) => a + 2 * r, 0) + gap * (samples.length - 1);
  const width = innerW + padX * 2;
  const height = titleH + padY + 2 * maxR + padY;
  const cy = titleH + padY + maxR;

  let cx = padX;
  const dots = [];
  for (let i = 0; i < samples.length; i++) {
    const r = radii[i];
    const dotCx = cx + r;
    dots.push(
      `<circle cx="${dotCx}" cy="${cy}" r="${r}" fill="${CIRCLE_COLOR}" fill-opacity="0.55" stroke="${CIRCLE_STROKE}" stroke-width="2"/>`,
      `<text x="${dotCx}" y="${cy + 5}" fill="#fff" text-anchor="middle" font-family="Inter, Helvetica, Arial, sans-serif" font-size="13" font-weight="700" stroke="#000" stroke-width="2" paint-order="stroke">${samples[i]}</text>`,
    );
    cx += 2 * r + gap;
  }

  const svg = `
    <rect x="0" y="0" width="${width}" height="${height}" rx="6" fill="#000" fill-opacity="0.7" stroke="#fff" stroke-width="1"/>
    <text x="${width / 2}" y="${padY + 14}" fill="#fff" text-anchor="middle" font-family="Inter, Helvetica, Arial, sans-serif" font-size="13" font-weight="600">Events per hotspot</text>
    ${dots.join('\n')}`;
  return { svg, width, height };
}

async function renderHeatmap({ points }) {
  // Data-driven bbox (not a hardcoded city extent) so this centers correctly
  // regardless of service area. Floor span keeps fitZoom sane for a tight
  // single-hotspot window; the zoom clamp below covers the rest.
  const bbox = paddedBbox(bboxOf(points), 0.15, 0.05);
  const centerLat = (bbox.minLat + bbox.maxLat) / 2;
  const centerLon = (bbox.minLon + bbox.maxLon) / 2;
  const rawZoom = fitZoom(bbox, WIDTH, HEIGHT, 40);
  const zoom = Math.max(9, Math.min(13, rawZoom));

  const token = requireMapboxToken();
  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${centerLon.toFixed(5)},${centerLat.toFixed(5)},${zoom.toFixed(2)}/${WIDTH}x${HEIGHT}@2x?access_token=${token}`;
  const baseMap = await fetchMapboxStatic(url, 30000);

  const clusters = clusterByPixels(
    points,
    centerLat,
    centerLon,
    zoom,
    WIDTH,
    HEIGHT,
    radiusForCount,
  );
  const maxClusterCount = clusters.reduce((m, c) => Math.max(m, c.count), 0);
  const legend = buildLegend(maxClusterCount);
  const legendX = WIDTH - legend.width - 20;
  const legendY = 20;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">${renderClusters(clusters).join('\n')}<g transform="translate(${legendX}, ${legendY})">${legend.svg}</g></svg>`;

  return sharp(baseMap)
    .resize(WIDTH, HEIGHT)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 85 })
    .toBuffer();
}

module.exports = { renderHeatmap, radiusForCount };
