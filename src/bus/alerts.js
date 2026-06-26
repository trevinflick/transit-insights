// COTA ServiceAlerts gate. Deliberately deferred when this project forked
// from the CTA/Chicago bot (see AGENTS.md's "Deferred" section) for lack of
// a good significance gate — CTA's text-pattern + severity-score approach
// doesn't apply here (COTA's feed has no severity score). Per AGENTS.md's
// own forward-looking note, this gates on `effect`/`cause` enums + the
// active_period duration instead: long-running per-stop construction/
// detour notices (confirmed the majority of COTA's real feed — 34 of 52
// live entries span >30 days as of this writing) are standing infra notices
// and vetoed; short-term reroutes/closures are admitted.
//
// Pure, no I/O — normalizeAlert/isAdmittedAlert take/return plain objects so
// they're testable without a live feed. The actual fetch lives in
// src/bus/api.js#getAlertsFeed (same transport/logic split as elsewhere in
// this codebase).
const { longToNum } = require('./api');

// GTFS-realtime Alert.Effect enum (transit_realtime.Alert.Effect). Admit
// only the short-term-disruption effects — NOT the long-running standing
// notices (NO_SERVICE/SIGNIFICANT_DELAYS etc. are dominated by COTA's
// per-stop construction backlog per the real-feed audit that informed this
// gate) or low-signal effects (OTHER_EFFECT/UNKNOWN_EFFECT/NO_EFFECT).
const REDUCED_SERVICE = 2;
const DETOUR = 4;
const STOP_MOVED = 9;
const ADMITTED_EFFECTS = new Set([REDUCED_SERVICE, DETOUR, STOP_MOVED]);

// Strict less-than: an alert whose longest active_period is exactly 7 days
// leans toward veto, matching AGENTS.md's caution against over-posting
// standing notices.
const MAX_DURATION_SEC = 7 * 24 * 60 * 60;

// entity = a decoded FeedEntity from src/bus/api.js#getAlertsFeed (raw
// protobuf shape). Normalizes to a plain object so the gate never touches
// protobuf-specific types (Long, translation arrays, ...).
function normalizeAlert(entity) {
  const a = entity.alert || {};
  const informedEntity = a.informedEntity || [];
  const activePeriods = (a.activePeriod || []).map((p) => ({
    start: longToNum(p.start),
    end: longToNum(p.end),
  }));
  const routeIds = [...new Set(informedEntity.map((ie) => ie.routeId).filter(Boolean))];
  // Whole-trip cancellations (effect=REDUCED_SERVICE, "Cancelled stops on
  // Route N ...") carry a `trip` on every informedEntity row — one per stop
  // the cancelled trip would have served, so the SAME tripId repeats
  // hundreds of times (one real alert had 415 rows / 204 distinct stops
  // across just 5 trips). Dedupe down to the actual distinct trips; that
  // count is the useful rider-facing number, not the stop count.
  const tripsById = new Map();
  for (const ie of informedEntity) {
    if (ie.trip?.tripId != null && !tripsById.has(ie.trip.tripId)) {
      tripsById.set(ie.trip.tripId, {
        tripId: String(ie.trip.tripId),
        startTime: ie.trip.startTime || null,
      });
    }
  }
  const cancelledTrips = [...tripsById.values()].sort((x, y) =>
    (x.startTime || '').localeCompare(y.startTime || ''),
  );
  const firstText = (ts) => ts?.translation?.[0]?.text || null;
  return {
    id: String(entity.id),
    effect: a.effect,
    cause: a.cause,
    activePeriods,
    routeIds,
    cancelledTrips,
    headerText: firstText(a.headerText),
    descriptionText: firstText(a.descriptionText),
  };
}

// An open-ended period (no `end`, or COTA's "no defined end" sentinel —
// observed as end ≈ 32503698000, year 3000) is a standing notice by
// construction: its duration is unbounded, so it always fails the < 7-day
// admit check below without needing to special-case the sentinel value.
function periodDurationSec(p) {
  if (p.start == null || p.end == null) return Infinity;
  return p.end - p.start;
}

// `alert` is a normalizeAlert()-shaped plain object. `now` is accepted for
// signature symmetry with other detectors in this codebase but isn't
// currently used — the gate is duration-based (activePeriod's own span), not
// "is it active right now."
function isAdmittedAlert(alert, _now = Date.now()) {
  if (!ADMITTED_EFFECTS.has(alert.effect)) return false;
  const periods = alert.activePeriods || [];
  if (periods.length === 0) return false; // no window at all — treat as standing, veto
  const longest = Math.max(...periods.map(periodDurationSec));
  return longest < MAX_DURATION_SEC;
}

// For the resolution sweep: is `alert` (still present in the raw feed, any
// effect/duration — NOT re-gated through isAdmittedAlert) currently within
// one of its own active_periods? Deliberately independent of the admit
// gate — if COTA extends a short-term reroute into a standing notice, the
// disruption is still real and ongoing from a rider's perspective, so it
// must NOT be swept into "resolved" just because it stopped qualifying for
// a NEW post. Only a feed-drop or a genuinely elapsed period resolves it
// (see bin/bus/alerts.js's sweep). `nowMs` is epoch milliseconds (this
// codebase's usual `Date.now()` convention); GTFS-rt periods are epoch
// seconds, converted here so callers don't have to remember the mismatch.
function isStillActive(alert, nowMs = Date.now()) {
  if (!alert) return false;
  const nowSec = Math.floor(nowMs / 1000);
  const periods = alert.activePeriods || [];
  if (periods.length === 0) return true; // no period at all = always active per spec
  return periods.some(
    (p) => (p.start == null || p.start <= nowSec) && (p.end == null || p.end >= nowSec),
  );
}

module.exports = {
  normalizeAlert,
  isAdmittedAlert,
  isStillActive,
  ADMITTED_EFFECTS,
  MAX_DURATION_SEC,
  REDUCED_SERVICE,
  DETOUR,
  STOP_MOVED,
};
