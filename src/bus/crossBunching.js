// Cross-route bus bunching — a pileup at one spot involving 2+ routes
// (e.g. 2 #22 + 3 #36 stacked at Clark & Belmont). The per-pattern detector in
// bunching.js can't see this: each route's pdist is a separate coordinate
// system, so it never compares a #22 against a #36. Here we cluster purely on
// geography (lat/lon) across ALL routes, then require the cluster to span 2+
// routes and show congestion. As of ALLOWED_ROUTE_SETS below, a cluster also
// has to match a known-good route combination to actually post — see that
// constant for why.
const { clusterByProximity, clusterStats } = require('../shared/geoClusters');
const { haversineFt } = require('../shared/geo');

const CROSS_RADIUS_FT = 660; // ~2 city blocks — an intersection + its approaches
const MIN_VEHICLES = 3; // a pileup, not just one bus meeting another
const MIN_ROUTES = 2; // the whole point: distinct routes, else regular bunching catches it
const MIN_STOPPED = 2; // congestion evidence — real pileup, not vehicles crossing in motion
const STALE_MS = 3 * 60 * 1000;

// Known timed-transfer "pulse" points: COTA converges most of the network at
// the same downtown stop near the top of every hour so riders can transfer
// between routes — confirmed from real cron history (firings at 06:00, 07:00,
// 08:00, 09:00… every hour on the hour, same ~10-route core, same spot). That's
// scheduled service, not unplanned congestion, so a cluster centered on a known
// hub never counts as a cross-route pileup. Add more entries if another hub
// turns up the same pattern elsewhere in the network.
const PULSE_HUBS = [
  { lat: 39.965, lon: -83.002, radiusFt: 1000 }, // N High St & W Long St, downtown
];

// True when a cluster's centroid sits within a known pulse hub's radius.
function isAtPulseHub(centroid, hubs = PULSE_HUBS) {
  return hubs.some((h) => haversineFt(centroid, h) <= h.radiusFt);
}

// Geofencing known hubs doesn't scale — every false positive so far has been
// a hub we hadn't found yet (downtown pulse point, then a second cluster
// involving routes 2/12/25 near 1333 Fields Ave that's neither a hub nor a
// real incident). Flip the default: cross-route bunching only fires for
// route combinations confirmed to share enough physical corridor that real
// bunching between just those routes is a meaningful signal, not a
// coincidental crossing. Routes 2 and 102 both run N High St for most of
// their length. Add a combination here only after confirming real, recurring
// physical overlap — not just an observed pileup.
const ALLOWED_ROUTE_SETS = [['002', '102']];

// True when a cluster's route set is EXACTLY one of the allowed combinations
// (not a superset/subset — a 3rd route along for the ride means it's not the
// known-good overlap, so it's suppressed like everything else).
function isAllowedRouteCombo(routes, allowed = ALLOWED_ROUTE_SETS) {
  return allowed.some((set) => set.length === routes.size && set.every((r) => routes.has(r)));
}

// Layover zone — a bus sitting at the start/end of its pattern is between trips,
// not pinned in street traffic. Several routes lay over together at the same
// transit center (e.g. Midway, where 47/55/63 all terminate), which otherwise
// reads as a multi-route "pileup". The bin tags these (parked AND at a terminal)
// as layoverIds; we drop them before clustering. (CTA omits a "near any 'L'
// station" signal — downtown stations are 30–400 ft apart, so it would blanket
// the Loop; see bin/bus/cross-bunching.js.)
const LAYOVER_TERMINAL_FT = 750; // distance from a pattern end to count as "at the terminal"

// A position is "at the terminal" when its pdist sits within marginFt of either
// end of its pattern (start-of-run or end-of-run layover). Pure; lengthFt is the
// pattern's total length in feet.
function isAtTerminal(pdistFt, lengthFt, marginFt = LAYOVER_TERMINAL_FT) {
  if (!Number.isFinite(pdistFt) || !Number.isFinite(lengthFt) || lengthFt <= 0) return false;
  return pdistFt <= marginFt || pdistFt >= lengthFt - marginFt;
}

// `vehicles` carry { vid, route, lat, lon, tmstmp }. `stoppedIds` is a Set of
// vids the caller has confirmed barely-moving (findParkedBusVids) — the
// congestion gate. Omit it to detect on geometry alone (tests / diagnostics).
// `layoverIds` is a Set of vids the caller classified as laying over (parked at
// a pattern terminal); they're dropped before clustering so a knot of routes
// resting at a transit center doesn't read as a street pileup. `allowedRouteSets`
// defaults to ALLOWED_ROUTE_SETS (production policy) — pass null to disable the
// route-combo gate entirely when testing the clustering mechanism in isolation.
// Returns clusters best-first: most vehicles, tie-break tightest span.
function detectCrossRouteBunches(
  vehicles,
  {
    now = Date.now(),
    stoppedIds = null,
    layoverIds = null,
    radiusFt = CROSS_RADIUS_FT,
    minVehicles = MIN_VEHICLES,
    minRoutes = MIN_ROUTES,
    minStopped = MIN_STOPPED,
    allowedRouteSets = ALLOWED_ROUTE_SETS,
  } = {},
) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const fresh = (vehicles || []).filter((v) => {
    const ts = v?.tmstmp instanceof Date ? v.tmstmp.getTime() : v?.tmstmp;
    return (
      Number.isFinite(v?.lat) &&
      Number.isFinite(v?.lon) &&
      Number.isFinite(ts) &&
      nowMs - ts < STALE_MS &&
      !layoverIds?.has(v.vid)
    );
  });

  const out = [];
  for (const members of clusterByProximity(fresh, { radiusFt })) {
    if (members.length < minVehicles) continue;
    const { spanFt, routes, centroid } = clusterStats(members, { routeKey: (v) => v.route });
    if (routes.size < minRoutes) continue;
    if (isAtPulseHub(centroid)) continue;
    if (allowedRouteSets && !isAllowedRouteCombo(routes, allowedRouteSets)) continue;
    if (stoppedIds) {
      const stopped = members.filter((v) => stoppedIds.has(v.vid)).length;
      if (stopped < minStopped) continue;
    }
    out.push({
      vehicles: members,
      routes: [...routes].sort(),
      routeCount: routes.size,
      spanFt: Math.round(spanFt),
      centroid,
    });
  }
  out.sort((a, b) =>
    a.vehicles.length !== b.vehicles.length
      ? b.vehicles.length - a.vehicles.length
      : a.spanFt - b.spanFt,
  );
  return out;
}

// Group a cluster's vehicles by route, each group sorted by vid, with a per-bus
// disc number (1 = first listed) for the map + post. Returns
// { byRoute: [{ route, vids:[{vid,n}] }], labels: Map<vid,n> } in route order
// (most vehicles first, tie-break route name).
function groupByRoute(cluster) {
  const groups = new Map();
  for (const v of cluster.vehicles) {
    if (!groups.has(v.route)) groups.set(v.route, []);
    groups.get(v.route).push(v);
  }
  const ordered = [...groups.entries()]
    .map(([route, vs]) => ({
      route,
      vehicles: vs.sort((a, b) => String(a.vid).localeCompare(String(b.vid))),
    }))
    .sort((a, b) =>
      a.vehicles.length !== b.vehicles.length
        ? b.vehicles.length - a.vehicles.length
        : String(a.route).localeCompare(String(b.route)),
    );
  const labels = new Map();
  let n = 0;
  const byRoute = ordered.map((g) => ({
    route: g.route,
    vids: g.vehicles.map((v) => {
      n += 1;
      labels.set(v.vid, n);
      return { vid: v.vid, n };
    }),
  }));
  return { byRoute, labels };
}

module.exports = {
  detectCrossRouteBunches,
  groupByRoute,
  isAtTerminal,
  isAtPulseHub,
  isAllowedRouteCombo,
  CROSS_RADIUS_FT,
  MIN_VEHICLES,
  MIN_ROUTES,
  MIN_STOPPED,
  LAYOVER_TERMINAL_FT,
  PULSE_HUBS,
  ALLOWED_ROUTE_SETS,
};
