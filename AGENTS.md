# AGENTS.md

Operating notes for AI agents editing this repo. Companion to `README.md`
(operator-facing) and `docs/` (per-feature deep-dives).

## What this is

A Bluesky bot (`@<cota-handle>`, env var `BLUESKY_BUS_*`) that turns COTA's
live GTFS-realtime bus data into Columbus-specific transit-quality posts.
**Cron-driven, no daemon.** Each `bin/bus/<feature>.js` is a one-shot:
detect → render → post → exit.

- This is a single-agency fork (COTA, bus-only — Columbus has no rail).
  There is no `bin/train/`, `bin/metra/`, or alerts/pulse pipeline; those
  existed in the upstream CTA/Chicago project this was forked from and were
  removed deliberately, not left out by accident — see "Deferred" below.
- **Detectors** are pure functions in `src/bus/<feature>.js`; **bins** in
  `bin/bus/<feature>.js` wire them to the GTFS-rt feed/DB/post/render.
- Persistent state in `state/history.sqlite` (WAL, 90-day rolloff). Schema +
  migrations: `src/shared/history.js#db()`. The schema still carries a
  `kind` column from the upstream multi-agency project — every row is
  `kind='bus'` here.

**Read first**: `README.md`, `cron/crontab.txt` (what runs when), `docs/
{BUNCHING,GAPS,GHOSTING,SPEEDMAP}.md` (still mostly accurate but were
written for the CTA fork — some sections describe train-only behavior that
no longer applies here).

## COTA's GTFS-realtime feeds (confirmed live, no API key)

- VehiclePositions: `https://gtfs-rt.cota.vontascloud.com/TMGTFSRealTimeWebService/Vehicle/VehiclePositions.pb`
- TripUpdates: `.../TripUpdate/TripUpdates.pb`
- ServiceAlerts: `.../Alert/Alerts.pb` (decoded, not yet wired to a republish bot — see Deferred)
- Static GTFS: `https://www.cota.com/data/cota.gtfs.zip`

Key facts learned from inspecting the live feeds directly (not just docs),
load-bearing for `src/bus/api.js` and `scripts/fetch-gtfs.js`:

- `trip_id` and `route_id` match **exactly** between realtime and static —
  no suffix-mismatch problem to normalize (unlike Metra's old `_A`/`_B` in
  the upstream project).
- **Realtime `direction_id` does NOT reliably match the static schedule's**
  for the same trip (observed `7` live vs `1` in `trips.txt`). Always
  resolve direction (and shape, for pdist) via `getTripMeta(tripId)` in
  `src/shared/gtfs.js` — never trust the live field.
- COTA's VehiclePositions has no `pdist`-equivalent (CTA's BusTime gave this
  for free). Recovered by projecting onto the trip's static shape —
  `src/bus/shapeProjection.js#projectOntoShape`, fed by per-shape_id
  `{ lat, lon, distFt }` arrays `scripts/fetch-gtfs.js` builds into
  `data/gtfs/index.json`'s `shapes` key (cumulative distance is
  haversine-measured ourselves, not trusted off GTFS's own
  `shape_dist_traveled`).
- No API key/quota concerns — these are public, unauthenticated, polled
  protobuf endpoints, not a metered REST API like CTA's BusTime 100k/day cap.

## Hard rules

- `npm test` must pass with zero failures before any commit.
- Don't auto-commit, push, or pull. Wait to be asked.
- Deploy = commit + push from local + `git pull` on the server. Never scp.
- Don't hardcode usernames/paths in committed configs — parameterize and
  substitute at install time (`scripts/install-crontab.sh`,
  `scripts/install-logrotate.sh`).
- Husky pre-commit runs `biome check --write` on staged `*.{js,json}`. On
  failure, fix the cause and create a new commit (don't amend).
- Update docs alongside code so they don't go stale.

## Invariants that break things if violated

- **Compute callouts BEFORE `recordX(...)`** — else the new event is compared
  against itself.
- **Always call `recordX({..., posted: false})` on cooldown skips** — recap
  and analytics need the row.
- `data/gtfs/index.json` and `data/gtfs/schedule.sqlite` are gitignored,
  rebuilt nightly by `scripts/fetch-gtfs.js`, and date-specific
  (`calendar_dates.txt` makes the index represent *today*) — `loadIndex()`
  throws past 7 days old. After laptop sleep / cron outage, run
  `npm run fetch-gtfs` before manual runs.
- **Don't merge the active vs. headway/duration loops in `fetch-gtfs.js`**.
  `activeByHour` is keyed per direction and counts every revenue trip;
  `headways`/`durations` are keyed **per pattern** (origin→dest, after the
  dominant service_id filter). Merging suppresses ghost detection on
  multi-terminal routes — see `docs/GHOSTING.md`.
- **Headways are per-pattern, not per-direction.** Each `routes[r][dir]`
  carries a `patterns[]` list (one entry per origin→dest terminal pair);
  `headways`/`durations`/`terminalLat`… at the direction level are the
  *dominant* pattern's, kept as a fallback. Consumers resolve a live pid
  (= shape_id) to a group via `matchPattern` in `src/shared/gtfs.js`
  (endpoint match).
- **Pids are stringified everywhere** so cache and fresh-feed rows compare
  strict-equal. For this fork, `pid` is COTA's GTFS `shape_id`.
- **`getPattern(pid)` is a synchronous index lookup, not a live API call**
  (COTA's shapes are static). `src/bus/patterns.js#loadPattern` still writes
  the result to `data/patterns/{pid}.json` as a side effect — not for
  caching a slow network call anymore, but because `src/shared/recap.js`
  reads those files directly off disk to resolve bunching-event locations
  for the heatmap. Don't remove the disk write without fixing that coupling.
- **Route names/keys are zero-padded GTFS route_ids** (e.g. `"022"`, not
  `"22"`) — that's the literal join key across the realtime feed, the static
  schedule, and `src/bus/routes.js`. Don't bare-number them.

### Deferred (not built in this fork — see git history for the upstream reference implementation)

Alerts republishing and "pulse" (live-inferred service-suspension) were
deliberately deferred when this was forked from the CTA/Chicago project,
because COTA's ServiceAlerts feed has no severity score and is dominated
today by long-running per-stop construction/detour notices rather than
transient disruptions — a different significance-gate design is needed than
CTA's text-pattern + severity-score gate, and that needs more real
disruption examples to calibrate against. If/when this gets built: base the
gate on `effect`/`cause` enums + `active_period` duration (long-running ⇒
standing infra notice, veto; short-term `REDUCED_SERVICE`/route-wide
`DETOUR` ⇒ admit), not text patterns.

## Where to look for X

| Editing… | Start here |
|---|---|
| Cron schedule / cadence | `cron/crontab.txt` |
| DB schema, cooldown helpers, callouts | `src/shared/history.js` |
| Observation reads/writes | `src/shared/observations.js` |
| Cooldown acquire / race | `src/shared/state.js`, `src/shared/postDetection.js` |
| GTFS index lookups / build | `src/shared/gtfs.js`, `scripts/fetch-gtfs.js` |
| COTA GTFS-realtime decode + pdist recovery | `src/bus/api.js`, `src/bus/shapeProjection.js` |
| Bunching / Gap / Ghost detection | `src/bus/{bunching,gaps,ghosts}.js` |
| Speedmap | `src/bus/speedmap.js` |
| Threading + post helpers | `src/shared/bluesky.js` |
| Map renderers | `src/map/index.js`, `src/map/common.js` |
| Recap | `src/shared/recap.js`, `src/shared/recapPost.js` |
| Bus route list | `src/bus/routes.js` |
| Event-replay track archiver | `bin/export-event-tracks.js`, `src/shared/eventTracks.js`, `docs/REPLAY.md` |
| Video dropout/bridge/ghost model | `src/shared/videoTracks.js`, `docs/REPLAY.md` |
| Cron wrapper | `bin/cron-run.sh` |

## Operational levers

| Lever | File | Note |
|---|---|---|
| Ghost min snapshots | `src/bus/ghosts.js` | `MIN_SNAPSHOTS = 4` |
| History rolloff | `src/shared/history.js` | `ROLLOFF_DAYS = 90` |
| Observation rolloff | `src/shared/observations.js` | `ROLLOFF_MS = 7d` |
| GTFS staleness | `src/shared/gtfs.js` | `STALE_FATAL_MS = 7d` |

## Dev commands

`npm test` (full suite), `npm run smoke` (`--check` import smoke for each
`bin/bus/*.js`), `npm run check`/`lint` (Biome), `npm run <feature>:dry` (run
a bin without posting).

## Required env vars

`.env` at repo root (see `.env.example`):

- `BLUESKY_SERVICE` (optional, default `https://bsky.social`)
- `BLUESKY_BUS_{IDENTIFIER,APP_PASSWORD}`
- `MAPBOX_TOKEN`
- `HISTORY_DB_PATH` overrides default `state/history.sqlite` (tests)

No COTA API key is needed — its GTFS-realtime feeds are public.
