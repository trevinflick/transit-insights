// COTA's board policy waives fares whenever the National Weather Service
// issues a heat or cold advisory/warning for Franklin County — see
// src/bus/fareWaiver.js for the original (COTA GTFS-feed) design and why
// it's kept as a fallback: that feed has carried zero fare/weather text
// despite hours of a live, publicly-announced waiver, so this NWS path is
// the primary trigger.
//
// Unlike the GTFS path, there's no COTA-authored alert text to pass
// through here — buildNwsFareWaiverPostText synthesizes the post, so its
// wording is deliberately conservative: it states which services are free
// (COTA's own confirmed policy language) and cites the actual triggering
// NWS event for verifiability, but avoids asserting a precise end-clock-time
// we can't fully guarantee (COTA matched today's multi-day warning with a
// multi-day waiver, but that's observed behavior for one event, not a
// contractual guarantee for every future one).
const { graphemeLength, POST_MAX_CHARS } = require('../shared/post');

// Confirmed live against api.weather.gov/alerts/types (filtered to
// heat/cold) — current valid NWS event-type strings. Deliberately excludes
// the "Watch" tiers (Extreme Heat Watch, Extreme Cold Watch): COTA's policy
// says "advisory or warning," not "watch," which is a lower-confidence
// forecast tier, not a declared event.
const FARE_WAIVER_EVENTS = new Set([
  'Heat Advisory',
  'Extreme Heat Warning',
  'Cold Weather Advisory',
  'Extreme Cold Warning',
]);

const COLD_EVENTS = new Set(['Cold Weather Advisory', 'Extreme Cold Warning']);

function isFareWaiverTrigger(nwsAlert) {
  return FARE_WAIVER_EVENTS.has(nwsAlert.event);
}

// Cold events get the frozen-face emoji instead of the thermometer — known
// exactly here (unlike the GTFS-fallback path in fareWaiver.js, which only
// has free text to guess from), so this is a precise lookup, not a heuristic.
function tagEmoji(event) {
  return COLD_EVENTS.has(event) ? '🥶' : '🌡';
}

function parseTs(s) {
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
}

// Returns the local-calendar date value for a UTC ms timestamp —
// year*10000 + month*100 + day, comparable as an integer.
function localDateValue(ms) {
  const d = new Date(ms);
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

// Admission gate: true when the advisory's onset **date** (in local time)
// has been reached, regardless of the exact onset clock time. COTA's policy
// is all-day on the onset date (e.g. onset at noon → fares waived all day),
// so a date comparison is correct here — use isNwsAlertActive (below) for
// the resolution sweep, which needs exact-timestamp precision at the end.
function isNwsAlertOnsetDateReached(nwsAlert, nowMs = Date.now()) {
  if (!nwsAlert) return false;
  const start = parseTs(nwsAlert.onset) ?? parseTs(nwsAlert.effective);
  if (start == null) return true; // no onset info → treat as already in effect
  return localDateValue(start) <= localDateValue(nowMs);
}

// `ends` is the forecast end of the actual hazard; `expires` is just when
// the CAP message itself expires (often much sooner, as NWS re-issues
// updates) — prefer `ends`, falling back to `expires` only when `ends` is
// absent. Mirrors isStillActive in src/bus/alerts.js (same "no period info
// at all = treat as not-yet-determined" caution, applied to onset instead).
function isNwsAlertActive(nwsAlert, nowMs = Date.now()) {
  if (!nwsAlert) return false;
  const start = parseTs(nwsAlert.onset) ?? parseTs(nwsAlert.effective);
  const end = parseTs(nwsAlert.ends) ?? parseTs(nwsAlert.expires);
  if (start != null && nowMs < start) return false;
  if (end != null && nowMs > end) return false;
  return true;
}

function buildNwsFareWaiverPostText(nwsAlert) {
  const event = nwsAlert.event || 'extreme weather event';
  const tag = `${tagEmoji(nwsAlert.event)} Free fares — extreme weather alert`;
  const article = /^[aeiou]/i.test(event) ? 'an' : 'a';
  const body =
    `COTA has waived fares systemwide (fixed-route buses, Mainstream, and ` +
    `COTA//Plus) due to ${article} ${event} in Franklin County. ` +
    `Free rides for as long as the ${event.toLowerCase()} remains in effect.`;
  const full = `${tag}\n${body}`;
  if (graphemeLength(full) <= POST_MAX_CHARS) return full;

  const ellipsis = '…';
  const budget = POST_MAX_CHARS - graphemeLength(`${tag}\n${ellipsis}`);
  const trimmedBody = Array.from(body).slice(0, Math.max(0, budget)).join('');
  return `${tag}\n${trimmedBody}${ellipsis}`;
}

module.exports = {
  FARE_WAIVER_EVENTS,
  isFareWaiverTrigger,
  isNwsAlertOnsetDateReached,
  isNwsAlertActive,
  buildNwsFareWaiverPostText,
};
