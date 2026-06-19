// Display names keyed by COTA's `route_id` (zero-padded, e.g. "022"), sourced
// from COTA's published GTFS routes.txt so every active route is represented.
// Extend the bunching/speedmap/gaps/ghosts arrays below to start tracking
// additional routes without touching this map.
const names = {
  '001': 'Kenny/Livingston',
  '002': 'E Main/N High',
  '003': 'Northwest/Harrisburg',
  '004': 'Indianola/Lockbourne',
  '005': 'W 5th Ave/Refugee',
  '006': 'Sullivant',
  '007': 'Mt Vernon',
  '008': 'Karl/S High/Parsons',
  '009': 'W Mound/Brentnell',
  '010': 'E Broad/W Broad',
  '011': 'Bryden/Maize',
  '012': 'McKinley/Fields',
  '021': 'Hilliard Rome',
  '022': 'OSU-Rickenbacker',
  '023': 'James-Stelzer',
  '024': 'Hamilton Rd',
  '025': 'Brice',
  '031': 'Hudson',
  '032': 'N Broadway',
  '033': 'Henderson',
  '034': 'Morse',
  '035': 'Dublin-Granville',
  '041': 'Crosswoods-Polaris',
  '042': 'Sharon Woods',
  '043': 'Westerville',
  '044': 'Easton',
  '045': 'New Albany',
  '046': 'Gahanna',
  '051': 'Reynoldsburg',
  '052': 'Canal Winchester',
  '061': 'Grove City',
  '071': 'Hilliard',
  '072': 'Tuttle',
  '073': 'Dublin',
  '074': 'Smoky Row',
  '075': 'Arlington/1st Ave',
  101: 'CMAX',
  102: 'Polaris Pkwy/N High',
  141: 'Columbus Zoo',
  152: 'AirConnect',
  201: 'SmartRide New Albany - Red',
  202: 'SmartRide New Albany - Blue',
};

// Routes polled for gap detection. Hand-curated from real-world verification
// (transiteverywhere.com + COTA's published timetables), not purely from
// scripts/compute-low-frequency-routes.js's computed medians, because of two
// distinct artifacts found on COTA's network:
//   - Paired departures (route 8: two buses ~8 min apart, then a longer gap
//     before the next pair) used to bias the per-hour median toward the
//     short intra-pair gap — confirmed wrong against COTA's real PDF
//     timetable (15 min, not 8-11). FIXED at the source as of the
//     resolveHourlyHeadway irregularity check in scripts/fetch-gtfs.js — a
//     fresh GTFS rebuild now computes 8 correctly, so this is no longer a
//     reason to distrust 8 specifically, but the route stays hand-listed.
//   - Branch-splitting (CMAX, and apparently 1/2/10): two genuinely separate
//     origin→destination patterns sharing one origin, each running ~30 min
//     alone — the "dominant pattern wins" hoisting logic picks just one, so
//     the computed value reads half the rider-facing frequency. This is a
//     DIFFERENT failure mode (no single pattern's gaps are irregular, so
//     resolveHourlyHeadway's check never fires) and remains unfixed — don't
//     trust the computed numbers for routes that exhibit it; verify against
//     a real source before adding/removing here.
const gaps = ['001', '002', '006', '008', '010', '023', '034', '101'];

// Routes polled for ghost-bus detection. Independent of bunching/gaps: a
// dedicated observer cron (scripts/observeBuses.js) fetches positions for
// these routes on a fixed cadence so the hourly rollup has consistent
// coverage regardless of what other jobs sampled. Same curation as `gaps`.
const ghosts = ['001', '002', '006', '008', '010', '023', '034', '101'];

// Routes eligible for the thin-gap detector (bin/bus/thin-gaps.js) — outside
// the curated `gaps`/`ghosts` core, with usable (if not fully trusted — see
// the note above) GTFS headway data. Most computed via
// `node scripts/fetch-gtfs.js` then `node scripts/compute-low-frequency-routes.js`
// against the 2026-06-18 snapshot, minus the routes promoted into
// gaps/ghosts above.
//
// 011/032/033 are a different case: their per-pattern headway computation
// produces nothing at all (each alternates between two termini from the same
// origin, same issue as CMAX — see the note above — so no single pattern
// ever gets 2 same-hour departures), but scripts/fetch-gtfs.js's
// computeFallbackHeadway() recovers a coarse whole-day median gap for them
// (~30-60 min, consistent with real-world spacing) once they have ≥4
// same-direction trips at a sane (≤120 min) spacing. This is what let route
// 33 — riders' most common "buses never show up" complaint — get thin-gap
// coverage at all; it had zero index entry before this fix.
//
// 10 routes (041-046, 061, 071, 074, 075) are AM/PM-only commuter shuttles —
// 1-3 trips per direction, hours apart — and deliberately do NOT get a
// fallback headway (computeFallbackHeadway's maxGapMin guard rejects them):
// a "headway" derived from one ~10-hour gap isn't a usable "is this route
// still running" signal. 4 more (141 Zoo, 152 AirConnect, 201/202 SmartRide)
// have zero scheduled trips in the feed at all. All 14 stay excluded from
// gaps/ghosts/lowFrequency — re-check after a GTFS refresh in case service
// patterns change.
const lowFrequency = [
  '003', // 30.0 min
  '004', // 30.0 min
  '005', // 48.0 min
  '007', // 30.0 min
  '011', // ~60 min (fallback — branch-alternating, see note above)
  '012', // 20.0 min
  '021', // 59.0 min
  '022', // 30.0 min
  '024', // 30.0 min
  '025', // 50.0 min
  '031', // 30.0 min
  '032', // ~60 min (fallback — branch-alternating, see note above)
  '033', // ~30 min (fallback — branch-alternating, see note above)
  '035', // 56.0 min
  '051', // 24.0 min
  '052', // 30.0 min
  '072', // 25.0 min
  '073', // 25.0 min
  '102', // 29.0 min
];

// Every active COTA route.
const allRoutes = Object.keys(names);

// COTA's GTFS route_short_name: ordinary routes drop the route_id's
// zero-padding ("002" -> "2"); CMAX (route_id "101") is a branded BRT line,
// not a numbered route — its short name is "CMAX", confirmed against COTA's
// real routes.txt (route_id 101, route_short_name "CMAX").
const shortNames = {
  101: 'CMAX',
};

function routeShortName(route) {
  return shortNames[route] || String(route).replace(/^0+(?=\d)/, '');
}

// Bare display label: "Route 2" for numbered routes, or just "CMAX" for
// branded lines whose short name already reads as a full name.
function routeLabel(route) {
  const short = routeShortName(route);
  return short === names[route] ? short : `Route ${short}`;
}

// Full display title with the descriptive name: "Route 2 (E Main/N High)",
// or just "CMAX" (skips the redundant "Route CMAX (CMAX)").
function routeTitle(route) {
  const name = names[route];
  const short = routeShortName(route);
  if (!name || short === name) return routeLabel(route);
  return `Route ${short} (${name})`;
}

module.exports = {
  names,
  gaps,
  ghosts,
  lowFrequency,
  allRoutes,
  routeShortName,
  routeLabel,
  routeTitle,
};
