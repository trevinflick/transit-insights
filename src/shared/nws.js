const axios = require('axios');
const { withRetry } = require('./retry');

// National Weather Service Alerts API — public, unauthenticated, no key.
// Used (so far) only for COTA's extreme-heat/cold fare-waiver trigger (see
// src/bus/fareWaiverNws.js): COTA's own board policy waives fares whenever
// NWS issues a heat/cold advisory or warning for Franklin County, so this is
// the literal documented trigger condition, not a proxy for it.
const BASE = 'https://api.weather.gov';

// Franklin County, OH's NWS public-forecast zone. Confirmed live by
// cross-referencing a real active alert's geocode.UGC (includes OHZ046)
// against its geocode.SAME FIPS list (includes 039049, Franklin County's
// standard FIPS code), then verifying that querying by this zone directly
// returns exactly the alerts that cover Franklin County — not a broader or
// narrower set. Zone codes are stable NWS identifiers, not expected to
// change.
const FRANKLIN_COUNTY_ZONE = 'OHZ046';

// NWS requires a descriptive User-Agent identifying the application (not a
// browser UA) — requests without one are more likely to be rate-limited.
const USER_AGENT = 'transit-insights-bot (https://github.com/, contact via repo)';

// Returns the array of currently-active alert `properties` objects (already
// plain JSON, no protobuf-style decode needed) for `zone`. Each entry has at
// least { id, event, onset, effective, ends, expires, headline, areaDesc }.
async function getActiveAlertsForZone(zone = FRANKLIN_COUNTY_ZONE) {
  const { data } = await withRetry(
    () =>
      axios.get(`${BASE}/alerts/active`, {
        params: { zone },
        headers: { 'User-Agent': USER_AGENT },
        timeout: 15000,
      }),
    { label: `NWS alerts/active?zone=${zone}` },
  );
  return (data.features || []).map((f) => f.properties);
}

module.exports = { getActiveAlertsForZone, FRANKLIN_COUNTY_ZONE };
