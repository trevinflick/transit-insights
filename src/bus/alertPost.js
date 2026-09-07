// Post text for a service alert. For most alert types there's no structured
// detection to phrase — COTA's own headerText/descriptionText are already
// human-authored, consistently formatted strings (e.g. "Reroute on Line 7
// NORTHEAST" / "Rerouted from A to B"), so this is mostly pass-through with
// a route tag line prefixed, not a from-scratch sentence builder like the
// old CTA pipeline's extractBetweenStations/extractDirection (those existed
// because CTA's alert text needed parsing; COTA's is already structured by
// routeId/effect, so there's nothing to extract).
//
// Whole-trip/block cancellations are the one case worth a real rewrite —
// COTA's own headerText/descriptionText for these ("Cancelled stops on
// Route 008 NORTH, SOUTH... between A at 5:57 AM and B at 1:03 PM") has
// three problems: a zero-padded route number duplicating the tag line's
// already-correct "Route 8", "NORTH, SOUTH" reading like two separate
// routes rather than one route's two directions, and "Cancelled stops"
// itself misleading readers into picturing specific stops removed rather
// than entire scheduled buses never running. Dropped entirely in favor of
// our own line built from the alert data directly — the tag line already
// names the route, the map (when it renders) already shows which
// direction(s) are affected, and the precise per-bus time list says more
// than COTA's vague "between A and B" window ever did. See
// alert.cancelledTrips (src/bus/alerts.js#normalizeAlert).
//
// Said as "bus trips cancelled," not just "buses cancelled" — matches the
// recap's wording (src/shared/recapPost.js) and reads as scheduled runs that
// never happened, not a claim that vehicles were pulled from the fleet.
// scheduleRelationship CANCELED means the bus simply never runs (confirmed
// against the live feed: every "cancelled stops" alert uses this, no other
// relationship value). Said as "cancelled today," not "upcoming buses
// cancelled" — the listed times are a real mix of already-passed and
// still-to-come (COTA pre-announces a block's whole remaining day at once),
// so "upcoming" would be wrong for whichever ones already passed by the
// time this posts; "today" makes no tense claim and is correct either way.
//
// Direction is added parenthetically from the headerText COTA already
// writes ("Cancelled stops on Route 008 NORTH, SOUTH.") — the short
// cardinal labels there ("NORTH", "SOUTH") are extracted and reformatted as
// "northbound & southbound" so riders know whether this affects their
// direction. Whole-block cancellations always affect both directions (the
// bus runs back and forth all day), but stating that explicitly removes any
// ambiguity.
const { routeTitle, routeTitleForPattern } = require('./routes');
const { getTripMeta, getShapePoints } = require('../shared/gtfs');
const { formatGtfsTimeOfDay } = require('../shared/format');
const { graphemeLength, POST_MAX_CHARS } = require('../shared/post');

// Resolves the SPECIFIC branch for a route with per-branch headsigns
// (currently just route 1's Kenny/Livingston split) from the alert's own
// cancelled trips, rather than the combined routeTitle(). A block's trips
// normally stay on one branch all day, but if this alert's cancelled trips
// for `route` don't all agree on the same branch, fall back to the combined
// name rather than asserting a single (possibly wrong) one. Also falls back
// on any GTFS-index lookup failure (missing/stale index) — the route tag
// line is core to every alert post, so it must never throw and take the
// whole post down over what's ultimately a cosmetic disambiguation.
function resolveRouteTitle(route, alert) {
  try {
    const trips = (alert.cancelledTrips || [])
      .map((t) => getTripMeta(t.tripId))
      .filter((meta) => meta && meta.route === route);
    if (trips.length === 0) return routeTitle(route);
    const titles = new Set(
      trips.map((meta) => {
        const points = meta.shapeId ? getShapePoints(meta.shapeId) : null;
        return points
          ? routeTitleForPattern(route, { pid: meta.shapeId, points })
          : routeTitle(route);
      }),
    );
    return titles.size === 1 ? [...titles][0] : routeTitle(route);
  } catch (_e) {
    return routeTitle(route);
  }
}

// "Cancelled stops on Route 008 NORTH, SOUTH." → ["NORTH", "SOUTH"]
// Returns null when the header doesn't match the expected COTA format.
function extractDirections(headerText) {
  if (!headerText) return null;
  const m = headerText.match(/Cancelled stops on Route \d+\s+([A-Z, ]+?)\s*\./);
  if (!m) return null;
  return m[1]
    .split(/,\s*/)
    .map((d) => d.trim())
    .filter(Boolean);
}

// ["NORTH", "SOUTH"] → "northbound & southbound"
// ["NORTHEAST"] → "northeastbound"
function formatDirections(dirs) {
  if (!dirs || dirs.length === 0) return null;
  const labels = dirs.map((d) => {
    const s = d.toLowerCase();
    return s.charAt(0).toUpperCase() + s.slice(1) + 'bound';
  });
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} & ${labels[1]}`;
  return 'both directions';
}

function buildAlertBody(alert, { isReply = false } = {}) {
  if (alert.cancelledTrips && alert.cancelledTrips.length > 0) {
    const n = alert.cancelledTrips.length;
    const times = alert.cancelledTrips.map((t) => formatGtfsTimeOfDay(t.startTime)).join(', ');
    const dirs = formatDirections(extractDirections(alert.headerText));
    const qualifier = dirs ? ` (${dirs})` : '';
    // "more bus trips cancelled" signals to a reader scrolling into a thread
    // reply that this is an additional cancellation on top of whatever's
    // above, not a standalone daily summary — without needing to know the
    // total upfront.
    const verb = isReply
      ? `more bus trip${n === 1 ? '' : 's'} cancelled`
      : `bus trip${n === 1 ? '' : 's'} cancelled today`;
    return `${n} ${verb}${qualifier}: ${times}`;
  }
  return [alert.headerText, alert.descriptionText].filter(Boolean).join('\n');
}

function buildAlertPostText(alert, { isReply = false } = {}) {
  const routeTags = (alert.routeIds || []).map((r) => resolveRouteTitle(r, alert)).join(', ');
  const tag = routeTags ? `⚠ ${routeTags} — service alert` : '⚠ Service alert';
  const body = buildAlertBody(alert, { isReply });
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
  const routeTags = (alert.routeIds || []).map((r) => resolveRouteTitle(r, alert)).join(', ');
  return `Map highlighting the ${routeTags} route pattern(s) affected by today's service alert.`;
}

module.exports = { buildAlertPostText, buildAlertAltText };
