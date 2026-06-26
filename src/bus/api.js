const axios = require('axios');
const GtfsRt = require('gtfs-realtime-bindings');
const { recordBusObservations, getLatestBusSnapshot } = require('../shared/observations');
const { withRetry } = require('../shared/retry');
const { getTripMeta, getShapePoints } = require('../shared/gtfs');
const { bearing } = require('../shared/geo');
const { projectOntoShape } = require('./shapeProjection');

// COTA GTFS-realtime feeds. Protocol Buffers (GTFS-rt v2.0), public and
// unauthenticated (confirmed live — no api key/token needed), refreshed
// roughly every 30s server-side (Vontas TransitMaster).
const BASE = 'https://gtfs-rt.cota.vontascloud.com/TMGTFSRealTimeWebService';

const { transit_realtime } = GtfsRt;
const FeedMessage = transit_realtime.FeedMessage;

async function fetchFeed(path) {
  const { data } = await withRetry(
    () =>
      axios.get(`${BASE}/${path}`, {
        responseType: 'arraybuffer',
        timeout: 15000,
      }),
    { label: `COTA ${path}` },
  );
  return FeedMessage.decode(new Uint8Array(data));
}

// protobufjs decodes 64-bit fields as Long objects; everything downstream
// wants plain numbers (epoch seconds). Null-safe.
function longToNum(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v.toNumber === 'function') return v.toNumber();
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

// "HH:MM:SS" (may exceed 24h for an owl trip) → seconds since service-day
// midnight. Matches what CTA's `stst` meant: the trip's first-stop departure
// time, which scheduleDeviationMin joins against schedule.sqlite's start_sec.
function parseGtfsStartTime(s) {
  if (!s) return null;
  const parts = s.split(':').map((x) => parseInt(x, 10));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  const [h, m, sec] = parts;
  return h * 3600 + m * 60 + sec;
}

// Resolves a GTFS-realtime VehiclePosition entity into the same shape
// CTA's BusTime parseVehicle() produced, so src/bus/{bunching,gaps,ghosts,
// speedmap}.js need zero changes. COTA's realtime trip_id/route_id match the
// static schedule exactly (confirmed against a live sample — no suffix
// mismatch to normalize, unlike Metra), but the realtime direction_id does
// NOT reliably match the static schedule's for the same trip (observed 7
// live vs 1 static for the same trip_id) — direction and shape (for pdist)
// are therefore always resolved via the trip_id → static lookup
// (getTripMeta), never trusted off the live feed.
function parseVehicle(entity) {
  const v = entity.vehicle;
  if (!v) return null;
  const trip = v.trip || {};
  const pos = v.position || {};
  const tripId = trip.tripId != null ? String(trip.tripId) : null;
  const meta = tripId ? getTripMeta(tripId) : null;
  const lat = Number.isFinite(pos.latitude) ? pos.latitude : null;
  const lon = Number.isFinite(pos.longitude) ? pos.longitude : null;
  const shapeId = meta?.shapeId ?? null;

  let pdist = null;
  if (shapeId != null && lat != null && lon != null) {
    const shapePoints = getShapePoints(String(shapeId));
    const proj = shapePoints ? projectOntoShape(lat, lon, shapePoints) : null;
    if (proj) pdist = proj.distFt;
  }

  const ts = longToNum(v.timestamp);
  return {
    vid: v.vehicle?.id ?? null,
    route: meta?.route ?? (trip.routeId != null ? String(trip.routeId) : null),
    pid: shapeId != null ? String(shapeId) : null,
    lat,
    lon,
    heading: Number.isFinite(pos.bearing) ? pos.bearing : null,
    pdist,
    schedStartSec: parseGtfsStartTime(trip.startTime),
    tmstmp: ts != null ? new Date(ts * 1000) : null,
  };
}

async function getVehicles(routes, { record = true } = {}) {
  const feed = await fetchFeed('Vehicle/VehiclePositions.pb');
  const routeSet = routes?.length ? new Set(routes.map(String)) : null;
  const results = (feed.entity || [])
    .map(parseVehicle)
    .filter((v) => v?.vid != null && v.route != null && (!routeSet || routeSet.has(v.route)));
  if (record) recordBusObservations(results);
  return results;
}

const CARDINAL_BOUNDS = ['Northbound', 'Eastbound', 'Southbound', 'Westbound'];
// Buckets a bearing (0=N, 90=E, 180=S, 270=W) into the nearest cardinal
// "-bound" label — the only vocabulary post text expects (bin/bus/ghosts.js's
// abbreviateDirection matches /(North|South|East|West)bound/i; COTA has no
// intercardinal-only patterns that would need finer buckets).
function cardinalBound(brg) {
  const idx = Math.round((((brg % 360) + 360) % 360) / 90) % 4;
  return CARDINAL_BOUNDS[idx];
}

// COTA's shapes are static — sourced from the precomputed index
// (scripts/fetch-gtfs.js), not a live API call like CTA's getpatterns.
// `pid` is the GTFS shape_id. The shape's own point list already carries
// named-stop entries (type 'S') merged in at index-build time — see
// fetch-gtfs.js — matching CTA's pattern.points contract closely enough for
// patterns.js#findNearestStop and the bunching/gap "near stop" text.
async function getPattern(pid) {
  const shapePoints = getShapePoints(String(pid));
  if (!shapePoints || shapePoints.length < 2) {
    throw new Error(`No shape found for pid ${pid}`);
  }
  const direction = cardinalBound(bearing(shapePoints[0], shapePoints[shapePoints.length - 1]));
  return {
    pid: String(pid),
    direction,
    lengthFt: shapePoints[shapePoints.length - 1].distFt,
    points: shapePoints.map((p, seq) => ({
      seq,
      lat: p.lat,
      lon: p.lon,
      type: p.type,
      stopId: p.stopId,
      stopName: p.stopName,
      pdist: p.distFt,
    })),
  };
}

// COTA's nearest equivalent to CTA's single-stop countdown predictions
// (`prdctdn`, "DUE" or minutes) is TripUpdates.pb's per-stop predicted
// arrival times for the vehicle's current trip. Returns the same
// `{ stpid, prdctdn }` shape bin/bus/gaps.js already parses ("DUE" or a
// whole-minute countdown string). Pure given a decoded feed; exported for
// fixture-based unit tests.
function predictionsFromFeed(feed, vid, now = Date.now()) {
  const entity = (feed.entity || []).find(
    (e) => e.tripUpdate?.vehicle?.id != null && String(e.tripUpdate.vehicle.id) === String(vid),
  );
  const stopTimeUpdate = entity?.tripUpdate?.stopTimeUpdate || [];
  return stopTimeUpdate
    .map((s) => {
      const predictedSec = longToNum(s.arrival?.time ?? s.departure?.time);
      if (predictedSec == null || s.stopId == null) return null;
      const minutes = Math.round((predictedSec * 1000 - now) / 60000);
      return { stpid: String(s.stopId), prdctdn: minutes <= 1 ? 'DUE' : String(minutes) };
    })
    .filter(Boolean);
}

async function getPredictions({ vid }) {
  if (!vid) return [];
  const feed = await fetchFeed('TripUpdate/TripUpdates.pb');
  return predictionsFromFeed(feed, vid);
}

// Raw decoded ServiceAlerts feed — gating/normalization lives in
// src/bus/alerts.js, this just owns the fetch/decode (same responsibility
// split as VehiclePositions/TripUpdates above).
async function getAlertsFeed() {
  return fetchFeed('Alert/Alerts.pb');
}

// Returns `{ vehicles, now, source }`. COTA's GTFS-realtime feeds are public
// and unauthenticated (no daily-request cap like CTA's BusTime, so the cache
// here is about avoiding redundant decodes within a tick, not quota
// protection). The default 90s maxStaleMs covers the ~60s observe-buses
// cadence — bunching/gaps/pulse all hit the cache, so observe-buses is the
// only poll site for the all-routes workload.
async function getVehiclesCachedOrFresh(routes, { maxStaleMs = 90 * 1000 } = {}) {
  const cached = getLatestBusSnapshot(routes, maxStaleMs);
  if (cached && cached.vehicles.length > 0) {
    return { vehicles: cached.vehicles, now: new Date(cached.snapshotTs), source: 'cache' };
  }
  const vehicles = await getVehicles(routes);
  return { vehicles, now: new Date(), source: 'fetch' };
}

module.exports = {
  getVehicles,
  getVehiclesCachedOrFresh,
  getPattern,
  getPredictions,
  getAlertsFeed,
  parseVehicle,
  longToNum,
  // Exposed for unit tests.
  cardinalBound,
  parseGtfsStartTime,
  predictionsFromFeed,
};
