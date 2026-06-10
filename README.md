# cta-insights

Bluesky bots that turn CTA train and bus tracker data into Chicago-specific transit visualizations.

- **Bus**: [@ctabusinsights.bsky.social](https://bsky.app/profile/ctabusinsights.bsky.social)
- **Train**: [@ctatraininsights.bsky.social](https://bsky.app/profile/ctatraininsights.bsky.social)
- **Alerts**: [@ctaalertinsights.bsky.social](https://bsky.app/profile/ctaalertinsights.bsky.social)
- **Metra**: [@metrainsights.bsky.social](https://bsky.app/profile/metrainsights.bsky.social) (analytics) · [@metraalertinsights.bsky.social](https://bsky.app/profile/metraalertinsights.bsky.social) (disruptions/alerts)

This README is written for operators running their own copy. If you just want to see the output, follow the accounts above. Scroll to the [Examples gallery](#examples-gallery) for sample posts.

## What it posts

> Each major feature has a deep-dive in [`docs/`](docs/): [bunching](docs/BUNCHING.md), [gaps](docs/GAPS.md), [ghosting](docs/GHOSTING.md), [speedmaps](docs/SPEEDMAP.md), [alerts + pulse](docs/ALERTS.md), [Metra](docs/METRA.md).

### Bus (`@ctabusinsights`)
- **Bunching** — clusters of buses on the same route/direction, as an annotated map. Reply includes a ~10-minute timelapse video of the cluster, with traffic signals and bus stops annotated.
- **Gaps** — long stretches with no bus service, compared against the scheduled headway from GTFS.
- **Speedmap** — a bus route color-coded by observed speed over a 1-hour window.
- **Heatmap** — weekly/monthly rollup of chronic bunching + gap stops, plotted across Chicago.
- **Ghost buses** — hourly rollup of routes with materially fewer active buses than the schedule implies.

### Train (`@ctatraininsights`)
- **Bunching** — clusters (2+) of L trains running too close together, with map + timelapse reply.
- **Gaps** — long stretches with no L service on a given line/direction, using the GTFS rail schedule.
- **Speedmap** — an L line color-coded by observed train speed, with a separate ribbon per direction. For Purple, truncates to the shuttle segment outside express hours.
- **Heatmap** — weekly/monthly rollup of chronic bunching + gap stations, with a Loop inset since five lines share the elevated rectangle.
- **Snapshot** — 15-minute timelapse of every active train system-wide, with a Loop inset.
- **Ghost trains** — hourly rollup of line/direction pairs missing trains vs. the schedule.

### Metra (`@metrainsights` / `@metraalertinsights`)
Commuter-rail support is being added in phases (see `docs/METRA.md` and the root `plan-6-9-26.md`). Metra is a timetabled railroad, so its detectors read GTFS-realtime schedule adherence directly rather than reconstructing it statistically. Live so far:
- **Alerts** — republishes Metra's GTFS-realtime service alerts (cancellations, delays, suspensions) to `@metraalertinsights`, filtered to drop ADA/construction/marketing notices, with a threaded resolved reply when the alert clears.
- **Speedmap** — a Metra line color-coded by observed train speed along the corridor, two ribbons by direction, posted to `@metrainsights`.
- **Cancellations + delays** — Metra-confirmed and bot-inferred cancellations, plus trains running 15+ min late, recorded to the DB and posted as a combined hourly per-line rollup to `@metraalertinsights` (silent when there's nothing).
- **Recap** — a weekly/monthly per-line on-time reliability chart to `@metrainsights`: `reliability = (scheduled − cancelled − 15-min-late) / scheduled`, with the scheduled-trip denominator counted from the GTFS timetable.
- **Coming next** — the chicagotransitalerts.app frontend (agency filter, Metra line/station pages, maps).

### Alerts (`@ctaalertinsights`)
- **Republished CTA alerts** — significant service alerts on tracked routes, filtered to drop the noisy "major" ones (single elevator out, block-party reroutes, etc.). Each post gets a threaded `✅ cleared` reply once CTA marks it resolved.
- **Segment-dim maps** — when a rail alert names a station-to-station stretch ("between Belmont and Howard"), the post includes a map dimming that segment of the line.
- **Pulse** — a bot-side detector that infers a rail service suspension from live train positions when a ≥2-mile stretch of a line goes cold for 15+ min. Often surfaces outages before CTA issues an alert; threaded under the official alert when one appears.
- **Related-observation quotes** — when an alert or pulse thread is live and the analytics bots post a bunching/gap event that matches the alert's route + direction + segment, the alerts account quote-replies the observation into the thread (cap 3/thread). Disable with `QUOTE_RELATED_POSTS=0`. See `docs/ALERTS.md` for the relevance filter.

### Both bus and train
- **Historical callouts** — posts carry frequency and severity context from prior posts in `history.sqlite`, e.g. *"3rd Route 66 bunch reported today"* or *"tightest reported on this line in 30 days"*.

The bus bot tracks a subset of CTA routes — see `src/bus/routes.js`. The train bot covers all 8 L lines.

## Setup

1. **Clone and install**
   ```
   git clone https://github.com/cailinpitt/cta-insights.git
   cd cta-insights
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
   | `CTA_TRAIN_KEY` | CTA Train Tracker API key | [transitchicago.com/developers](https://www.transitchicago.com/developers/) |
   | `CTA_BUS_KEY` | CTA Bus Tracker API key | same |
   | `MAPBOX_TOKEN` | Mapbox Static Images API | [account.mapbox.com](https://account.mapbox.com/access-tokens/) |
   | `BLUESKY_SERVICE` | Bluesky PDS URL | defaults to `https://bsky.social` |
   | `BLUESKY_BUS_IDENTIFIER` | Bus bot handle or DID | your Bluesky account |
   | `BLUESKY_BUS_APP_PASSWORD` | Bus bot app password | bsky.app → Settings → App Passwords |
   | `BLUESKY_TRAIN_IDENTIFIER` | Train bot handle or DID | same |
   | `BLUESKY_TRAIN_APP_PASSWORD` | Train bot app password | same |
   | `BLUESKY_ALERTS_IDENTIFIER` | Alerts bot handle or DID | same |
   | `BLUESKY_ALERTS_APP_PASSWORD` | Alerts bot app password | same |

4. **Build the GTFS index** — required before any gap or ghost detection runs.
   ```
   npm run fetch-gtfs
   ```

5. **Fetch traffic signals** — optional, one-time. Annotates bus bunching timelapse videos with intersection signals.
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

Everything is designed to be driven by cron. There's no long-running process — each script does one detection or rollup and exits. The full schedule lives in [`cron/crontab.txt`](cron/crontab.txt). On a fresh server with no other cron jobs you can install it with `crontab cron/crontab.txt`. **On any server that already has unrelated cron jobs**, DO NOT use that destructive form — it replaces every job for the user. Instead, merge between the `# CTA-INSIGHTS-START` / `# CTA-INSIGHTS-END` markers; the file's header has a step-by-step procedure.

Each line uses [`bin/cron-run.sh`](bin/cron-run.sh) — a small wrapper that handles `cd` to the repo root, timestamps each invocation, and redirects stdout/stderr to `cron/<log-name>-cron.log`. So a job entry is just:

```cron
4-59/15 * * * * /home/you/cta-insights/bin/cron-run.sh train-bunching bin/train/bunching.js
```

instead of repeating the boilerplate on every line. The snapshot timelapse runs in-process for ~15 minutes per invocation, so it's scheduled every 3 hours; everything else is fast and runs on its own cadence.

### Log rotation

Each cron job appends to `cron/<name>-cron.log`, so the log files grow without bound by default. [`cron/logrotate.conf`](cron/logrotate.conf) is a template policy (daily, 10MB size cap, 14 compressed rotations, `copytruncate` to preserve the inode `cron-run.sh` writes to). Install it once on the server with:

```
sudo scripts/install-logrotate.sh
```

The installer detects the owner of the local `cron/` directory and substitutes `CRON_LOG_DIR` / `SU_USER` / `SU_GROUP` placeholders before writing to `/etc/logrotate.d/cta-insights`, then validates the result with `logrotate -d`. The system's daily logrotate timer picks it up overnight; the `su` directive is required because the cron log directory isn't root-owned.

### Monitoring

Liveness is delegated to [healthchecks.io](https://healthchecks.io). `cron-run.sh` (and `push-web-data.sh`, via its EXIT trap) pings `https://hc-ping.com/<ping-key>/<slug>/start` before a job runs and `.../<slug>/<exit-code>?create=1` after, where `<slug>` is the job's log-name. The exit code lets healthchecks alert on both silence (the box/network/CTA API died) and a job that ran but crashed, and the start/finish pair lets it measure each job's run **duration**. The `?create=1` ([auto-provisioning](https://healthchecks.io/docs/autoprovisioning/)) means the first ping for a slug creates its check automatically — no pre-registration. Its dashboard is the at-a-glance "what ran recently / how long it took / what's overdue" view, and notification routing (email, ntfy, …) is configured in its UI — nothing to self-host.

Only a curated subset pings, via the `HC_MONITORED` allowlist in [`bin/cron-run.sh`](bin/cron-run.sh): the full roster is 23 jobs but the free tier caps at 20 checks, so the committed allowlist watches the ~18 that matter (canaries, posting bots, real-time detectors, GTFS freshness) and skips the low-stakes ones (recaps, snapshot, `fetch-signals`, `incident-roundup`). Widen/narrow by editing that list. Pinging is a no-op unless `cron/healthchecks.env` exists on the server; copy [`cron/healthchecks.env.example`](cron/healthchecks.env.example) and follow its setup notes (paste the project ping key; tune each auto-created check's period + grace, since they default to a loose 1d/1h).

## Scripts reference

All bin scripts accept `--dry-run` (writes image under `assets/` instead of posting). Recap scripts additionally accept `--window week|month` (default `month`).

### Posting
| Command | Description |
|---|---|
| `npm run bunching` / `:dry` | Bus bunching detection |
| `npm run gaps` / `:dry` | Bus gap detection |
| `npm run speedmap` / `:dry` | Bus speedmap collection (1-hour window) |
| `npm run recap` / `:dry` | Bus recap — bunching heatmap + threaded gap-leaderboard reply |
| `npm run ghosts` / `:dry` | Bus ghost rollup (hourly) |
| `npm run train-bunching` / `:dry` | Train bunching detection |
| `npm run train-gaps` / `:dry` | Train gap detection |
| `npm run train-speedmap` / `:dry` | Train speedmap collection (1-hour window) |
| `npm run train-recap` / `:dry` | Train recap — bunching heatmap + threaded gap-leaderboard reply |
| `npm run train-snapshot` / `:dry` | System-wide L snapshot |
| `npm run train-ghosts` / `:dry` | Train ghost rollup (hourly) |
| `node bin/bus/alerts.js` (`ALERTS_DRY_RUN=1` or `--dry-run` for dry) | Bus alert republishing + resolution replies |
| `node bin/train/alerts.js` (`ALERTS_DRY_RUN=1` or `--dry-run` for dry) | Train alert republishing + resolution replies (with segment-dim map when applicable) |
| `node bin/train/pulse.js` (`PULSE_DRY_RUN=1` or `--dry-run` for dry) | Bot-side rail disruption detector — station-anchored composite gate (≥2 cold stations, or 1 station + 3+ trains missed, or ≥2 mi run); synthesizes a full-branch candidate when a whole line goes dark |
| `node bin/train/disruption.js …` (`--dry-run` for dry) | Manual disruption poster (posts to the alerts account; operator passes CTA alert details as CLI args) |
| `node bin/audit-alerts.js` | Health audit — surfaces stuck alert posts, stuck pulse debounces, and cooldown bloat |

### Observers / maintenance
| Command | Description |
|---|---|
| `npm run observe-buses` | Bus observer — fetches every active CTA route and records positions (no posting). Run every minute. |
| `npm run fetch-gtfs` | Rebuild `data/gtfs/index.json`. Run daily. |
| `npm run fetch-signals` | Rebuild `data/signals/chicago.json` from OpenStreetMap. Run monthly. |

### Web archive

Two scripts publish a JSON snapshot of alerts and bot-detected disruptions to the [chicago-transit-alerts](https://github.com/cailinpitt/chicago-transit-alerts) repo, which renders them at [chicagotransitalerts.app](https://chicagotransitalerts.app).

| Command | Description |
|---|---|
| `node bin/export-web.js [output-path]` | Read `state/history.sqlite` (readonly) and emit a JSON document of unified **`incidents[]`** — each pairing an official CTA alert (`alert_posts`) with the bot-detected disruptions (`disruption_events`) and roundup signals (`roundup_anchors`) describing the same event. `buildIncidents` runs the alert↔observation merge here (so the web frontend doesn't have to), and normalizes train line keys to full names. Writes to `output-path` if given, otherwise stdout. Safe to run alongside live cron jobs. Format changes are recorded in the web repo's [data changelog](https://chicagotransitalerts.app/data/CHANGELOG.md). |
| `bin/push-web-data.sh` | Wrapper for the cron-driven publish loop. `cd`s into the cta-alert-history clone, pulls latest, runs `export-web.js` against `public/data/alerts.json`, and commits + pushes only if the file changed. Set `PAGES_REPO` and `CTA_INSIGHTS` env vars when the repo paths aren't `~/cta-alert-history` and `~/cta-insights`. Run every 7 minutes by cron. |

The split keeps `export-web.js` reusable (e.g. dump-to-stdout for ad-hoc inspection) while the wrapper carries all the git plumbing for the production pipeline.

### Dev
| Command | Description |
|---|---|
| `npm test` | Run the test suite (`node --test`). |
| `npm run smoke` | Load each bin with `--check` — fast sanity check after edits. |
| `npm run format` | Format all JS/JSON with [Biome](https://biomejs.dev/). |
| `npm run lint` | Report Biome lint warnings (no changes written). |
| `npm run check` | Format + apply safe lint fixes across the whole repo. |

Formatting + safe lint fixes run automatically on `git commit` via a husky pre-commit hook (`.husky/pre-commit` → `lint-staged` → `biome check --write` on staged `*.{js,json}` files only). Config lives in `biome.json`. After cloning, `npm install` runs `prepare` which installs the hook for you.

## How it works

Each major feature has a deep-dive doc in [`docs/`](docs/):
- [BUNCHING.md](docs/BUNCHING.md) — cluster detection for buses and trains
- [GAPS.md](docs/GAPS.md) — long-gap detection vs. scheduled headway
- [GHOSTING.md](docs/GHOSTING.md) — hourly missing-vehicle detection
- [SPEEDMAP.md](docs/SPEEDMAP.md) — colored route speed maps
- [ALERTS.md](docs/ALERTS.md) — CTA service alert republishing


### Data sources
- **CTA Bus Tracker** and **CTA Train Tracker** APIs — live vehicle positions, polled by each script for its detection window.
- **GTFS static feed** — the scheduled baseline for gap and ghost detection. Rebuilt daily from the CTA's published bundle into `data/gtfs/index.json`. Headways/durations are keyed **per pattern** — `(route/line, direction) → patterns[]`, where each pattern is one origin→dest terminal pair with its own `(day_type, hour) → { median headway, median trip duration }`. Measuring within a single pattern keeps short-turns and branches from corrupting the median (mixing them per-direction read the 66 at ~6 min vs a true 30 overnight). A live vehicle's pattern is matched to a group by its endpoint coordinates.
- **OpenStreetMap (Overpass)** — traffic signal nodes inside a Chicago bounding box, used to annotate bus bunching timelapses. Rebuilt monthly.
- **Mapbox Static Images API** — base maps for every rendered image.

### Observation flow
Every call to `getVehicles` (bus) and `getAllTrainPositions` (train) writes a row to the `observations` table in `history.sqlite`. That means *every* job — bunching, gaps, speedmaps, snapshots — contributes data that ghost detection later consumes.

Bus routes not touched by bunching or gaps need an explicit observer run to show up in the ghost rollups and bus pulse detection. `scripts/observeBuses.js` handles that, fetching every active CTA route every minute. Bunching, gaps, and pulse all read the resulting snapshot via `getVehiclesCachedOrFresh` (90s cache window) so the observer is the only API call site for the all-routes workload — that keeps the bus tracker under its 100k-call/day quota (~18.7k/day at this cadence). Trains don't need a dedicated observer — one API call returns all 8 lines and other jobs hit the API often enough.

### History DB and callouts
`state/history.sqlite` records every detection (posted or cooldown-suppressed) and every observation. Retention is 90 days. Two things feed off it:
- **Cooldown** — posts for the same route/direction inside a short window are suppressed to avoid spam. Tracked in `state/posted.json`.
- **Callouts** — each post is annotated with frequency and severity from prior records, e.g. *"3rd Route 66 bunch reported today"* or *"largest gap reported on this line in 30 days"*.

SQLite runs in **WAL mode**. If you inspect `history.sqlite` with a CLI while jobs are running, recent rows may still live in `history.sqlite-wal` until checkpoint.

### Ghost detection math
```
expected_active = trip_duration / headway
missing = expected_active − observed_active
```
`observed_active` is the median distinct-vehicle count per polling snapshot over the past hour. A ghost event requires **both**:
- `missing / expected_active` ≥ 25%, **and**
- `missing` ≥ 3 vehicles in absolute terms.

The absolute floor keeps single-vehicle routes (where a 1-bus gap is 50% of expected) from producing hair-trigger posts.

### GTFS freshness gates
`loadIndex()` checks the age of `data/gtfs/index.json`:
- **> 2 days old** — warns on stderr.
- **> 7 days old** — throws.

Because the index honors `calendar_dates.txt`, a stale index misreports holiday/special-service days. The fatal threshold makes a missed cron loud rather than silently reporting against the wrong schedule.

### Purple line (speedmap quirk)
Purple runs Linden↔Loop express during weekday rush, Linden↔Howard shuttle otherwise. The speedmap reads the scheduled trip duration from the GTFS index — a ~95-min trip means express is running, a ~14-min trip means shuttle, and the polyline is truncated at Howard when the window is shuttle-only.

## State and storage

Local state (gitignored, operator-managed):

| Path | Purpose | Rebuilt by |
|---|---|---|
| `state/posted.json` | Cooldown keys + timestamps | each posting job |
| `state/history.sqlite` | Detections + observations, 90-day window | each posting + observer job |
| `data/gtfs/index.json` | Schedule lookup | `npm run fetch-gtfs` (daily) |
| `data/signals/chicago.json` | OSM traffic signals | `npm run fetch-signals` (monthly) |
| `data/patterns/*.json` | Cached bus route patterns (7-day TTL) | populated on demand |

## Examples gallery

### Bus bunching
> 🚌 Route 66 (Chicago) — Eastbound
> 4 buses within 330 ft near Grand & Union
> 📊 3rd Route 66 bunch reported today

![Bus bunching example](docs/images/bus-bunching.jpg)

Reply: ~10-minute timelapse video of the cluster, with intersection traffic signals and bus stops annotated.

### Bus gap
> 🕳️ Route 76 (Diversey) — Westbound
> No bus near Diversey & Oak Park for ~20 min — scheduled around every 6 min this hour
>
> Last seen: #1934 · Next up: #8021

![Bus gap example](docs/images/bus-gap.jpg)

Reply: ~10-minute timelapse following the next bus closing in on the wait stop, with a live ETA readout (deep gaps stay a still). See [GAPS.md](docs/GAPS.md#timelapse-reply).

### Bus speedmap
> 🚦 Route 77 (Belmont) — Westbound
> 10:00 PM–11:00 PM CT · average speed 12.9 mph
>
> Each colored segment of the route shows how fast buses were moving there:
> 🟥 under 5 mph — stopped or crawling
> 🟧 5–10 mph — slow
> 🟨 10–15 mph — moderate
> 🟩 15+ mph — moving well

![Bus speedmap](docs/images/bus-speedmap.jpg)

### Bus recap
> 🚌 Chronic bus bunching spots, this week
>
> 97 bunches observed near 27 stops:
> · Grand & Union — Route 66 (9)
> · Michigan & Superior — Routes 147, 151 (5)
> · Washington & Canal — Routes 20, 56, 60 (5)
>
> Only what the bot observed; real totals are higher.

![Bus heatmap](docs/images/heatmap-bus.jpg)

Reply: a square bar chart of headway gaps by route over the same window.

### Bus ghost rollup
> 👻 Ghost buses, past hour
>
> 🚌 Route 146 (Inner Lake Shore/Michigan Exp.) SB · 4 of 12 missing (31%) · every ~7 min instead of ~5

![Bus ghost rollup](docs/images/ghost-bus.jpg)

### Train bunching
> 🚆 Green Line — to Harlem/Lake
> 2 trains within 0.27 mi near Pulaski

![Train bunching example](docs/images/train-bunching.jpg)

Reply: ~10-minute timelapse of the bunch.

### Train gap
> 🕳 Red Line — to 95th/Dan Ryan
> 18 min gap near Garfield — currently scheduled every 4 min
> 📊 2nd Red Line gap reported today · biggest gap vs schedule on this route in 30 days

![Train gap example](docs/images/train-gap.jpg)

### Train speedmap
> 🚦 Pink Line speedmap
> 12:00 PM–1:00 PM CT
> Toward 54th/Cermak: 24.0 mph
> 📊 slowest reported in 14 days
>
> Two parallel ribbons = the two travel directions.
> 🟥 under 15 mph · 🟧 15–25 · 🟨 25–35 · 🟪 35–45 · 🟩 45+ · ⬜ no data

![Train speedmap](docs/images/train-speedmap.jpg)

### Train snapshot
> 🚆 CTA L right now
> 5:00 PM CT · 110 trains system-wide
>
> Red 26 · Blue 28 · Brown 14 · Green 14 · Orange 7 · Purple 13 · Pink 8 · Yellow 0

![Train snapshot](docs/images/snapshot.jpg)

### Train recap
> 🚆 Chronic train bunching spots, this week
>
> 74 bunches observed near 18 stations:
> · Belmont — Red, Brown, Purple (7)
> · Adams/Wabash — Brown, Green, Purple (7)
> · Montrose — Blue (5)
>
> Only what the bot observed; real totals are higher.

![Train heatmap](docs/images/heatmap-train.jpg)

Reply: a square bar chart of headway gaps by line over the same window, with each bar in the line's brand color.

### Train ghost rollup
> 👻 Ghost trains, past hour
>
> 🟦 Blue Line → O'Hare · 3 of 8 missing (40%) · every ~17 min instead of ~10
>
> "Missing" = fewer trains than the full terminal-to-terminal schedule predicts.

![Train ghost rollup](docs/images/ghost-train.jpg)

## Contributing and issues

Issues and PRs welcome at [github.com/cailinpitt/cta-insights](https://github.com/cailinpitt/cta-insights).

CTA Bus and Train Tracker data © Chicago Transit Authority. Base maps © Mapbox, © OpenStreetMap contributors.
