// Post text for a cross-route bus pileup (2+ routes stacked at one spot).
// Unlike the per-route bunching post, the headline is a PLACE, and buses are
// grouped by route with the disc number each carries on the map.
const { routeTitle, routeLabel: routeShortLabel } = require('./routes');
const { groupByRoute } = require('./crossBunching');
const { formatCallouts } = require('../shared/history');
const { formatDistance, keycapNumber } = require('../shared/format');
const { graphemeLength, POST_MAX_CHARS } = require('../shared/post');

// Kept as `routeLabel` for external callers (bin/bus/cross-bunching.js's map
// legend) — delegates to the shared full-title formatter.
function routeLabel(route) {
  return routeTitle(route);
}

// `ctx` = { placeName }. Returns the primary post text.
//
// A downtown convergence (most routes pass within a couple blocks of each
// other near a hub) can stack 10+ routes into one cluster — listing every
// bus on every route then blows past Bluesky's 300-grapheme cap and the post
// call throws, silently dropping a real pileup. byRoute is already
// most-vehicles-first (groupByRoute), so on overflow we keep that prefix and
// summarize the rest, mirroring buildRollupPost's truncation in shared/post.js.
function buildPostText(cluster, ctx, callouts = []) {
  const { placeName } = ctx;
  const { byRoute } = groupByRoute(cluster);
  const where = placeName ? ` near ${placeName}` : '';
  const routeCount = byRoute.length;
  const head = `🚍 ${cluster.vehicles.length} buses from ${routeCount} routes bunched${where}`;
  const lines = byRoute.map((g) => {
    const list = g.vids.map((x) => `#${x.vid} (${keycapNumber(x.n)})`).join(', ');
    return `${routeLabel(g.route)}: ${list}`;
  });
  const tail = formatCallouts(callouts);
  const tailSuffix = tail ? `\n\n${tail}` : '';

  for (let k = lines.length; k >= 0; k--) {
    const dropped = lines.length - k;
    const body =
      dropped === 0
        ? lines.join('\n')
        : k === 0
          ? `…and ${dropped} more route${dropped === 1 ? '' : 's'}`
          : `${lines.slice(0, k).join('\n')}\n…and ${dropped} more route${dropped === 1 ? '' : 's'}`;
    const text = `${head}\n\n${body}${tailSuffix}`;
    if (graphemeLength(text) <= POST_MAX_CHARS) return text;
  }
  return `${head}${tailSuffix}`;
}

function buildAltText(cluster, ctx) {
  const { placeName } = ctx;
  const where = placeName ? ` near ${placeName}` : '';
  const routes = cluster.routes.map((r) => routeShortLabel(r)).join(', ');
  return `Map${where} showing ${cluster.vehicles.length} buses from ${cluster.routeCount} routes (${routes}) bunched within ${formatDistance(cluster.spanFt)} of each other.`;
}

function buildVideoPostText(video, cluster) {
  const elapsed = video?.elapsedSec
    ? `${Math.max(1, Math.round(video.elapsedSec / 60))} min`
    : 'Several minutes';
  return `${elapsed} of recent movement from this ${cluster.vehicles.length}-bus, ${cluster.routeCount}-route pileup.`;
}

function buildVideoAltText(cluster, ctx = {}) {
  const where = ctx.placeName ? ` near ${ctx.placeName}` : '';
  return `Timelapse map${where} showing recent movement of ${cluster.vehicles.length} bunched buses from ${cluster.routeCount} routes.`;
}

module.exports = { buildPostText, buildAltText, buildVideoPostText, buildVideoAltText, routeLabel };
