// COTA's board policy waives all fares (fixed-route, Mainstream, COTA//Plus)
// for the remainder of any day the National Weather Service issues a heat or
// cold advisory/warning for Franklin County — published, per news coverage,
// "through Rider and Service Alerts." That's the same Alert/Alerts.pb feed
// src/bus/alerts.js already polls, so this reuses normalizeAlert from there
// rather than re-decoding anything.
//
// GTFS-realtime's Effect enum has no fare-specific value, and COTA's `cause`
// field is unreliable in practice (observed cause=undefined on plenty of
// live alerts that clearly have a real cause) — so unlike alerts.js's
// effect/duration gate, this one is text-pattern based. Every real COTA
// fare-waiver headline found in news research uses the word "fare(s)"
// explicitly ("COTA waives fares," "no fares," "fare-free," "suspending
// fares") paired with a waiver verb — that pairing is the signal. Checked
// against the live feed (60 active entities at time of writing): zero
// false-positive risk today, since nothing fare-related is in it yet.
const { graphemeLength, POST_MAX_CHARS } = require('../shared/post');

const FARE_RX = /\bfares?\b/i;
const WAIVER_RX = /\b(free|waiv|suspend)/i;
// "No fares" doesn't pair with WAIVER_RX above ("no" alone isn't a waiver
// verb) but is itself one of the most common real COTA headline shapes
// ("COTA Announces No Fares for Thursday").
const NO_FARES_RX = /\bno\s+fares?\b/i;

function isFareWaiverAlert(alert) {
  const text = `${alert.headerText || ''} ${alert.descriptionText || ''}`;
  if (NO_FARES_RX.test(text)) return true;
  return FARE_RX.test(text) && WAIVER_RX.test(text);
}

// Unlike fareWaiverNws.js (which knows the exact NWS event type), this path
// only has COTA's free text to go on — a simple "mentions cold but not heat"
// heuristic, defaulting to the thermometer for heat/ambiguous/unspecified
// text rather than risk mislabeling a heat waiver as a cold one.
const COLD_TEXT_RX = /\bcold\b/i;
const HEAT_TEXT_RX = /\bheat\b/i;
function tagEmoji(text) {
  return COLD_TEXT_RX.test(text) && !HEAT_TEXT_RX.test(text) ? '🥶' : '🌡';
}

// Pass-through of COTA's own headerText/descriptionText, same philosophy as
// every other alert type in src/bus/alertPost.js except cancelled-buses
// (which got a rewrite because COTA's own text was demonstrably confusing —
// no such evidence exists here, so trust COTA's officially-authored wording
// for the specifics, e.g. exactly when it ends). Tag line is deliberately
// not the disruption "⚠" used elsewhere — fares being free isn't bad news.
function buildFareWaiverPostText(alert) {
  const body = [alert.headerText, alert.descriptionText].filter(Boolean).join('\n');
  const tag = `${tagEmoji(body)} Free fares — extreme weather alert`;
  const full = body ? `${tag}\n${body}` : tag;
  if (graphemeLength(full) <= POST_MAX_CHARS) return full;

  const ellipsis = '…';
  const budget = POST_MAX_CHARS - graphemeLength(`${tag}\n${ellipsis}`);
  const trimmedBody = Array.from(body).slice(0, Math.max(0, budget)).join('');
  return `${tag}\n${trimmedBody}${ellipsis}`;
}

module.exports = { isFareWaiverAlert, buildFareWaiverPostText, FARE_RX, WAIVER_RX, NO_FARES_RX };
