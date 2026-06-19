# cota-insights

A Bluesky bot that turns COTA (Central Ohio Transit Authority) live bus
GTFS-realtime data into Columbus-specific transit-quality visualizations.

This is a single-agency fork of the original [cta-insights](https://github.com/cailinpitt/cta-insights)
project (Chicago CTA bus/train + Metra). Columbus has no rail transit, so
this fork is bus-only; CTA/Metra-specific code (train detection, Metra
commuter-rail support, the alerts-republish + "pulse" disruption pipeline,
and the chicagotransitalerts.app web-archive integration) was removed rather
than adapted — see `AGENTS.md` for what was deferred and why.

This README is written for operators running their own copy.

## What it posts

Each major feature has a deep-dive in [`docs/`](docs/): [bunching](docs/BUNCHING.md),
[gaps](docs/GAPS.md), [ghosting](docs/GHOSTING.md), [speedmaps](docs/SPEEDMAP.md).
(Those docs were written for the original CTA fork — the detection logic they
describe is unchanged, but a few train-only passages no longer apply here.)

- **Bunching** — clusters of buses on the same route/direction, as an
  annotated map. Reply includes a ~10-minute timelapse video of the cluster.
- **Gaps** — long stretches with no bus service, compared against the
  scheduled headway from GTFS.
- **Speedmap** — a bus route color-coded by observed speed over a 1-hour
  window.
- **Heatmap** — weekly/monthly rollup of chronic bunching + gap stops,
  plotted across the COTA service area.
- **Ghost buses** — hourly rollup of routes with materially fewer active
  buses than the schedule implies.
- **Historical callouts** — posts carry frequency and severity context from
  prior posts in `history.sqlite`, e.g. *"3rd Route 22 bunch reported today"*
  or *"tightest reported on this route in 30 days"*.

The bot tracks every route in COTA's published GTFS feed — see
`src/bus/routes.js`.

## Setup

1. **Clone and install**
   ```
   git clone <this-repo>
   cd cota-insights
   npm install
   ```

2. **Install `ffmpeg`** — required for bunching timelapse replies.
   ```
   brew install ffmpeg    # macOS
   apt install ffmpeg     # Debian/Ubuntu
   ```

3. **Create `.env`** — `cp .env.example .env` and fill in:

   | Var | What it's for | Where to get it |
   |---|---|---|
   | `MAPBOX_TOKEN` | Mapbox Static Images API | [account.mapbox.com](https://account.mapbox.com/access-tokens/) |
   | `BLUESKY_SERVICE` | Bluesky PDS URL | defaults to `https://bsky.social` |
   | `BLUESKY_BUS_IDENTIFIER` | Bot handle or DID | your Bluesky account |
   | `BLUESKY_BUS_APP_PASSWORD` | Bot app password | bsky.app → Settings → App Passwords |

   No COTA API key is needed — its GTFS-realtime feeds are public and
   unauthenticated.

4. **Build the GTFS index** — required before any gap or ghost detection runs.
   ```
   npm run fetch-gtfs
   ```

5. **Fetch traffic signals** — optional, one-time. Annotates bus bunching
   timelapse videos with intersection signals (Columbus metro bounding box).
   ```
   npm run fetch-signals
   ```

6. **Smoke test** — loads every bin file with `--check`.
   ```
   npm run smoke
   ```

7. **Try a dry run** — writes an image under `assets/`, does not post.
   ```
   npm run bunching:dry
   ```

## Running it

Everything is designed to be driven by cron. There's no long-running
process — each script does one detection or rollup and exits. The full
schedule lives in [`cron/crontab.txt`](cron/crontab.txt). On a fresh server
with no other cron jobs you can install it with `crontab cron/crontab.txt`.
**On any server that already has unrelated cron jobs**, DO NOT use that
destructive form — it replaces every job for the user. Instead, merge
between the `# COTA-INSIGHTS-START` / `# COTA-INSIGHTS-END` markers (or just
run `scripts/install-crontab.sh`, which does this safely); the crontab
file's header has the manual procedure too.

Each line uses [`bin/cron-run.sh`](bin/cron-run.sh) — a small wrapper that
handles `cd` to the repo root, timestamps each invocation, and redirects
stdout/stderr to `cron/<log-name>-cron.log`. So a job entry is just:

```cron
1-59/20 * * * * /home/you/cota-insights/bin/cron-run.sh bus-bunching bin/bus/bunching.js
```

instead of repeating the boilerplate on every line.

### Log rotation

Each cron job appends to `cron/<name>-cron.log`, so the log files grow
without bound by default. [`cron/logrotate.conf`](cron/logrotate.conf) is a
template policy (daily, 10MB size cap, 14 compressed rotations,
`copytruncate` to preserve the inode `cron-run.sh` writes to). Install it
once on the server with:

```
sudo scripts/install-logrotate.sh
```

The installer detects the owner of the local `cron/` directory and
substitutes placeholders before writing to `/etc/logrotate.d/`, then
validates the result with `logrotate -d`. The system's daily logrotate timer
picks it up overnight; the `su` directive is required because the cron log
directory isn't root-owned.

### Monitoring

Liveness is delegated to [healthchecks.io](https://healthchecks.io).
`cron-run.sh` pings `https://hc-ping.com/<ping-key>/<slug>/start` before a
job runs and `.../<slug>/<exit-code>?create=1` after, where `<slug>` is the
job's log-name. The exit code lets healthchecks alert on both silence (the
box/network/COTA feed died) and a job that ran but crashed, and the
start/finish pair lets it measure each job's run **duration**. The
`?create=1` ([auto-provisioning](https://healthchecks.io/docs/autoprovisioning/))
means the first ping for a slug creates its check automatically — no
pre-registration.

Pinging is a no-op unless `cron/healthchecks.env` exists on the server; copy
[`cron/healthchecks.env.example`](cron/healthchecks.env.example) and follow
its setup notes.

## Scripts reference

All bin scripts accept `--dry-run` (writes image under `assets/` instead of
posting). Recap scripts additionally accept `--window week|month` (default
`month`).

### Posting
| Command | Description |
|---|---|
| `npm run bunching` / `:dry` | Bus bunching detection |
| `npm run gaps` / `:dry` | Bus gap detection |
| `npm run speedmap` / `:dry` | Bus speedmap collection (1-hour window) |
| `npm run recap` / `:dry` | Bus recap — bunching heatmap + threaded gap-leaderboard reply |
| `npm run ghosts` / `:dry` | Bus ghost rollup (hourly) |
| `node bin/bus/cross-bunching.js` (`--dry-run` for dry) | Cross-route bunching (2+ routes piled up at one corner) |
| `node bin/bus/thin-gaps.js` (`--dry-run` for dry) | Gap detection for low-frequency routes |
| `node bin/audit-alerts.js` | Health audit — surfaces cooldown bloat and stuck DB rows |

### Observers / maintenance
| Command | Description |
|---|---|
| `npm run observe-buses` | Bus observer — polls COTA's GTFS-realtime feed and records positions (no posting). Run every minute. |
| `npm run fetch-gtfs` | Rebuild `data/gtfs/index.json` + `data/gtfs/schedule.sqlite`. Run daily. |
| `npm run fetch-signals` | Rebuild `data/signals/signals.json` from OpenStreetMap. Run monthly. |

### Dev
| Command | Description |
|---|---|
| `npm test` | Run the test suite (`node --test`). |
| `npm run smoke` | Load each bin with `--check` — fast sanity check after edits. |
| `npm run format` | Format all JS/JSON with [Biome](https://biomejs.dev/). |
| `npm run lint` | Report Biome lint warnings (no changes written). |
| `npm run check` | Format + apply safe lint fixes across the whole repo. |

Formatting + safe lint fixes run automatically on `git commit` via a husky
pre-commit hook (`.husky/pre-commit` → `lint-staged` → `biome check --write`
on staged `*.{js,json}` files only). Config lives in `biome.json`. After
cloning, `npm install` runs `prepare` which installs the hook for you.

## How it works

Each major feature has a deep-dive doc in [`docs/`](docs/):
- [BUNCHING.md](docs/BUNCHING.md) — cluster detection
- [GAPS.md](docs/GAPS.md) — long-gap detection vs. scheduled headway
- [GHOSTING.md](docs/GHOSTING.md) — hourly missing-vehicle detection
- [SPEEDMAP.md](docs/SPEEDMAP.md) — colored route speed maps

### Data sources
- **COTA GTFS-realtime** — `VehiclePositions`/`TripUpdates` protobuf feeds,
  public and unauthenticated, polled by each script for its detection
  window. See `AGENTS.md` for the feed URLs and the direction_id/pdist
  gotchas. `ServiceAlerts` is decoded but not yet wired to a posting bot.
- **GTFS static feed** — the scheduled baseline for gap and ghost detection,
  and the source of route shapes used to recover an along-route distance
  (`pdist`) the realtime feed doesn't provide. Rebuilt daily from COTA's
  published bundle into `data/gtfs/index.json`. Headways/durations are keyed
  **per pattern** — `(route, direction) → patterns[]`, where each pattern is
  one origin→dest terminal pair with its own `(day_type, hour) → { median
  headway, median trip duration }`. A live vehicle's pattern is matched to a
  group by its endpoint coordinates.
- **OpenStreetMap (Overpass)** — traffic signal nodes inside the Columbus
  metro bounding box, used to annotate bus bunching timelapses. Rebuilt
  monthly.
- **Mapbox Static Images API** — base maps for every rendered image.

### Observation flow
Every call to `getVehicles` writes a row to the `observations` table in
`history.sqlite`. That means *every* job — bunching, gaps, speedmaps —
contributes data that ghost detection later consumes.

Routes not touched by bunching or gaps need an explicit observer run to show
up in the ghost rollups. `scripts/observeBuses.js` handles that, polling
COTA's feed every minute. Bunching, gaps, and speedmap all read the
resulting snapshot via `getVehiclesCachedOrFresh` (90s cache window) so the
observer is the only poll site for the all-routes workload — COTA's feeds
have no daily-request cap, so this is about avoiding redundant decodes, not
quota protection.

### History DB and callouts
`state/history.sqlite` records every detection (posted or
cooldown-suppressed) and every observation. Retention is 90 days. Two things
feed off it:
- **Cooldown** — posts for the same route/direction inside a short window
  are suppressed to avoid spam.
- **Callouts** — each post is annotated with frequency and severity from
  prior records, e.g. *"3rd Route 22 bunch reported today"* or *"largest gap
  reported on this route in 30 days"*.

SQLite runs in **WAL mode**. If you inspect `history.sqlite` with a CLI
while jobs are running, recent rows may still live in `history.sqlite-wal`
until checkpoint.

### Ghost detection math
```
expected_active = trip_duration / headway
missing = expected_active − observed_active
```
`observed_active` is the median distinct-vehicle count per polling snapshot
over the past hour. A ghost event requires **both**:
- `missing / expected_active` ≥ 25%, **and**
- `missing` ≥ 3 vehicles in absolute terms.

The absolute floor keeps single-vehicle routes (where a 1-bus gap is 50% of
expected) from producing hair-trigger posts.

### GTFS freshness gates
`loadIndex()` checks the age of `data/gtfs/index.json`:
- **> 2 days old** — warns on stderr.
- **> 7 days old** — throws.

Because the index honors `calendar_dates.txt`, a stale index misreports
holiday/special-service days. The fatal threshold makes a missed cron loud
rather than silently reporting against the wrong schedule.

## State and storage

Local state (gitignored, operator-managed):

| Path | Purpose | Rebuilt by |
|---|---|---|
| `state/posted.json` | Cooldown keys + timestamps | each posting job |
| `state/history.sqlite` | Detections + observations, 90-day window | each posting + observer job |
| `data/gtfs/index.json` | Schedule lookup + route shapes | `npm run fetch-gtfs` (daily) |
| `data/gtfs/schedule.sqlite` | Per-trip scheduled stop curves (adherence) | `npm run fetch-gtfs` (daily) |
| `data/signals/signals.json` | OSM traffic signals | `npm run fetch-signals` (monthly) |
| `data/patterns/*.json` | Cached route shapes (24h TTL; recap.js also reads these) | populated on demand |

## Examples gallery

The screenshots below are from the original Chicago/CTA deployment this was
forked from — kept as illustrations of the post format until this bot has
run against COTA long enough to swap in real Columbus examples.

### Bunching
> 🚌 Route 22 (OSU-Rickenbacker) — Eastbound
> 4 buses within 330 ft near Broad & High
> 📊 3rd Route 22 bunch reported today

![Bus bunching example](docs/images/bus-bunching.jpg)

Reply: ~10-minute timelapse video of the cluster, with intersection traffic
signals and bus stops annotated.

### Gap
> 🕳️ Route 10 (E Broad/W Broad) — Westbound
> No bus near Broad & Glenwood for ~20 min — scheduled around every 6 min this hour
>
> Last seen: #1934 · Next up: #8021

![Bus gap example](docs/images/bus-gap.jpg)

Reply: ~10-minute timelapse following the next bus closing in on the wait
stop, with a live ETA readout (deep gaps stay a still). See
[GAPS.md](docs/GAPS.md#timelapse-reply).

### Speedmap
> 🚦 Route 21 (Hilliard Rome) — Westbound
> 10:00 PM–11:00 PM ET · average speed 12.9 mph
>
> Each colored segment of the route shows how fast buses were moving there:
> 🟥 under 5 mph — stopped or crawling
> 🟧 5–10 mph — slow
> 🟨 10–15 mph — moderate
> 🟩 15+ mph — moving well

![Bus speedmap](docs/images/bus-speedmap.jpg)

### Recap
> 🚌 Chronic bus bunching spots, this week
>
> 97 bunches observed near 27 stops:
> · Broad & High — Route 2 (9)
> · High & 11th — Routes 2, 31 (5)
>
> Only what the bot observed; real totals are higher.

![Bus heatmap](docs/images/heatmap-bus.jpg)

Reply: a square bar chart of headway gaps by route over the same window.

### Ghost rollup
> 👻 Ghost buses, past hour
>
> 🚌 Route 10 (E Broad/W Broad) WB · 4 of 12 missing (31%) · every ~7 min instead of ~5

![Bus ghost rollup](docs/images/ghost-bus.jpg)

## Contributing and issues

COTA data © Central Ohio Transit Authority. Base maps © Mapbox, ©
OpenStreetMap contributors.
