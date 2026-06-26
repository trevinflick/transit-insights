// Post text for a service alert. For most alert types there's no structured
// detection to phrase — COTA's own headerText/descriptionText are already
// human-authored, consistently formatted strings (e.g. "Reroute on Line 7
// NORTHEAST" / "Rerouted from A to B"), so this is mostly pass-through with
// a route tag line prefixed, not a from-scratch sentence builder like the
// old CTA pipeline's extractBetweenStations/extractDirection (those existed
// because CTA's alert text needed parsing; COTA's is already structured by
// routeId/effect, so there's nothing to extract).
//
// Whole-trip/block cancellations are the one case worth a real rewrite:
// COTA's own descriptionText says only a vague "between A at 5:57 AM and B
// at 1:03 PM," when the alert data actually carries every cancelled trip's
// start time — riders care which specific runs are gone, not a fuzzy
// window. See alert.cancelledTrips (src/bus/alerts.js#normalizeAlert).
// Said as "buses cancelled," not "trips cancelled" — scheduleRelationship
// CANCELED means the bus simply never runs (confirmed against the live feed:
// every "cancelled stops" alert uses this, no other relationship value), and
// "trip" is transit jargon that risks reading as a partial/detour skip
// rather than a full no-show.
const { routeTitle } = require('./routes');
const { formatGtfsTimeOfDay } = require('../shared/format');
const { graphemeLength, POST_MAX_CHARS } = require('../shared/post');

function buildAlertBody(alert) {
  if (alert.cancelledTrips && alert.cancelledTrips.length > 0) {
    const n = alert.cancelledTrips.length;
    const times = alert.cancelledTrips.map((t) => formatGtfsTimeOfDay(t.startTime)).join(', ');
    const lead = alert.headerText ? `${alert.headerText}\n` : '';
    return `${lead}${n} bus${n === 1 ? '' : 'es'} cancelled today: ${times}`;
  }
  return [alert.headerText, alert.descriptionText].filter(Boolean).join('\n');
}

function buildAlertPostText(alert) {
  const routeTags = (alert.routeIds || []).map((r) => routeTitle(r)).join(', ');
  const tag = routeTags ? `⚠ ${routeTags} — service alert` : '⚠ Service alert';
  const body = buildAlertBody(alert);
  const full = body ? `${tag}\n${body}` : tag;
  if (graphemeLength(full) <= POST_MAX_CHARS) return full;

  // Trim the body, not the tag — keep the route/severity context intact.
  const ellipsis = '…';
  const budget = POST_MAX_CHARS - graphemeLength(`${tag}\n${ellipsis}`);
  const trimmedBody = Array.from(body).slice(0, Math.max(0, budget)).join('');
  return `${tag}\n${trimmedBody}${ellipsis}`;
}

// Alt text for the disruption map (src/map/bus/disruption.js) — only built
// when that map actually rendered, so this assumes routeIds is non-empty.
function buildAlertAltText(alert) {
  const routeTags = (alert.routeIds || []).map((r) => routeTitle(r)).join(', ');
  return `Map highlighting the ${routeTags} route pattern(s) affected by today's service alert.`;
}

module.exports = { buildAlertPostText, buildAlertAltText };
