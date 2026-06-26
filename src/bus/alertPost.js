// Post text for a service alert. Unlike gaps/ghosts/bunching, there's no
// structured detection to phrase — COTA's own headerText/descriptionText
// are already human-authored, consistently formatted strings (e.g. "Reroute
// on Line 7 NORTHEAST" / "Rerouted from A to B"), so this is mostly
// pass-through with a route tag line prefixed, not a from-scratch sentence
// builder like the old CTA pipeline's extractBetweenStations/extractDirection
// (those existed because CTA's alert text needed parsing; COTA's is already
// structured by routeId/effect, so there's nothing to extract).
const { routeTitle } = require('./routes');
const { graphemeLength, POST_MAX_CHARS } = require('../shared/post');

function buildAlertPostText(alert) {
  const routeTags = (alert.routeIds || []).map((r) => routeTitle(r)).join(', ');
  const tag = routeTags ? `⚠ ${routeTags} — service alert` : '⚠ Service alert';
  const body = [alert.headerText, alert.descriptionText].filter(Boolean).join('\n');
  const full = body ? `${tag}\n${body}` : tag;
  if (graphemeLength(full) <= POST_MAX_CHARS) return full;

  // Trim the body, not the tag — keep the route/severity context intact.
  const ellipsis = '…';
  const budget = POST_MAX_CHARS - graphemeLength(`${tag}\n${ellipsis}`);
  const trimmedBody = Array.from(body).slice(0, Math.max(0, budget)).join('');
  return `${tag}\n${trimmedBody}${ellipsis}`;
}

module.exports = { buildAlertPostText };
