# Purple Line Cold-Stretch FP — Bug Audit & Unified Fix Plan

Investigation triggered by the 2026-05-13 19:50 CDT false positive at
https://chicagotransitalerts.app/event/3mlrlx6cx3j2i/ (Sedgwick → Quincy,
`branch-0-outbound`, evidence `minutesSinceLastTrain: 26`,
`coldThresholdMin: 26`, `headwayMin: 10.3`).

## What actually happened at 19:50 tonight

Candidate just crossed the 25.83-min threshold (`max(15, 2.5 × 10.3)`) by
0.17 min.

From raw observations in the prod sqlite:

- **Last NB obs in the Loop trunk: 19:24** — vehicle 521, destination
  "Linden", trDr=1, lat 41.91 (it had come up from lat 41.89 at 19:20).
- **No Purple trains anywhere south of lat 41.95 after 19:35.** All later
  obs are vehicles 520/524/525 cycling between Howard (42.02) and Linden
  (42.07) — the shuttle.
- **Express PM rush per CTA schedule ends ~6:55 PM.** Vehicle 521 was the
  last NB Express deadhead returning to Linden.

Service was doing exactly what it's supposed to: PM Express ended, NB
stragglers cleared out, shuttle continues. The bot saw a 26-min cold Loop
trunk and posted.

This is the **same FP shape** as 2026-05-11 10:50 (Chicago → Quincy) and
2026-05-04 11:10 (Sedgwick → Quincy) — the comment in `src/train/pulse.js`
lines 282–287 literally calls those out as the reason the south-of-Howard
veto exists. The veto didn't fire.

---

## All the bugs — grouped by failure class

### Class A — south-of-Howard veto gated by a wrong time-of-day predicate

**Bug 1 (caused tonight's FP).** `purpleExpressLikelyActive(now)` in
`bin/train/pulse.js` returns true for hours `[14, 20)` weekday afternoons.
At 19:50, the gate says Express is "likely active" → `purpleOffPeak = false`
→ the south-of-Howard veto at `src/train/pulse.js:288–293` is skipped. But
Express PM rush actually ends ~6:55 PM and the last NB deadhead clears the
Loop trunk ~7:25 PM. From ~19:00 to ~20:00 the gate is wrong every time it
matters.

**Bug 2 (symmetric on AM side).** AM window `[5, 10)` has the same
trailing-edge issue: Express AM rush ends ~9:25 AM, last NB deadheads clear
~10:00. The 2026-05-11 10:50 Chicago → Quincy FP sat right in this
trailing edge.

**Bug 3 (structural).** The whole `purpleExpressLikelyActive` predicate is
hard-coded by hour-of-day. Schedule changes (CTA changes service patterns
periodically; weekend/holiday variations) silently break it. There's no
link to GTFS or to observed traffic.

### Class B — corridor bbox doesn't track current service

**Bug 4.** The corridor uses a **6 h lookback**. Once *any* Express-era
Loop-trunk obs lands in that window, the bbox stays extended south for the
next 6 h — covering the entire shuttle period and well into owl service.
That's why the south-of-Howard veto is the only thing standing between a
normal evening and an FP every night.

**Bug 5.** `excludeDestinations: ['Loop']` is incomplete. In the 6 h before
tonight's post, **4,572 obs had destination "Linden"** and reached as far
south as lat 41.876 (Quincy). Those are NB return-to-yard deadheads. They
keep the bbox extending through the Loop trunk regardless of the filter.

**Bug 6.** `excludeDestinations` is only applied when
`purpleOffPeak === true`. So during the same wrong-window where Bug 1
fires, the corridor isn't even being clipped. Double-fault.

### Class C — south-of-Howard veto is a band-aid, not a model

**Bug 7.** The veto is a hard-coded lat constant (`HOWARD_LAT = 42.01906`)
and a hard-coded set of mid-polyline turnaround stations
(`MID_POLYLINE_TURNAROUND_STATIONS: { p: ['Howard'] }`). The detector has
no semantic concept of "what segment of this line is currently in revenue
service" — it bolts on station-specific exceptions for every failure
pattern.

**Bug 8.** The veto only checks `from` and `to` station latitudes. A cold
run with one endpoint just north of Howard and the other deep in the Loop
would pass `to.lat < HOWARD_LAT` but only by a single station; the full
*span* of the run could still be 90% south of Howard and we should still
reject.

### Class D — weak detector behavior independent of Purple

**Bug 9.** The aliasing veto (`src/train/pulse.js:364–378`) only catches
trains that bracket the cold run **between two consecutive observations**.
The dominant "end of service" pattern is: a train enters the run, gets to
its last position inside the run, then *exits* the dir-matched feed (either
changes trDr at the turnaround or simply stops being a dir-match). That
looks identical to "outage starts where the last train was." No aliasing
fires.

**Bug 10.** The terminal-adjacency margin uses 1.2× threshold. Tonight:
coldMs 26 min, threshold 25.83 min → 26 / 25.83 = 1.007×. Even if Quincy
were classified terminal-adjacent (it's near the corridor's east end), this
would have rejected the candidate — but only because tonight was *just*
over threshold. A 30-min cold tail would still pass.

**Bug 11.** The wind-down gate uses `expectedTrainActiveTripsAnyDir`.
Purple GTFS at 19:50 still shows the shuttle (≥1 trip/hr), so the line
isn't "winding down" — but the Loop trunk *portion* is permanently dark for
the night. There's no concept of partial-line wind-down.

**Bug 12.** The synthetic full-line path's cold-start grace probe
(`recentlyActive` over 60 min) helps only when the line is *totally*
silent. It doesn't help when the active corridor has shrunk to a
sub-segment.

**Bug 13.** `expectedTrainDispatchesInWindow(line, null, …)` passes `null`
for direction. For a round-trip line being evaluated on
`branch-0-outbound`, this counts dispatches in *both* directions, so the
dispatch-continuity veto fires too eagerly (could mask real one-direction
outages) or not at all (overcounts).

**Bug 14.** `MID_POLYLINE_TURNAROUND_STATIONS` and other Purple-specific
corrections live only in `detectDeadSegments`. `detectHeldClusters` has its
own terminal-zone clip from polyline ends but no concept of
Howard-as-mid-turnaround. A pair of trains laying over at/near Howard
during shuttle service can produce held FPs.

**Bug 15 (process).** The cycle of patches is itself a bug. Every Purple
FP gets a one-off veto (south-of-Howard hour gate, Howard mid-turnaround
set, destination filter on `Loop` only, corridor bbox 6 h…). Each patch
adds another knob, and the next FP just slips between knobs. There's no
integration test that says "given last night's data, the bot does not
post." Replay scripts exist (`scripts/replay-pulse.js`) but aren't tied to
a corpus of known FPs.

---

## Plan — fix it once instead of patching nightly

The right fix replaces the time-of-day + destination-string heuristics with
a **derived "active corridor"** that comes from the observations themselves
on a short window. Everything else follows.

### Step 1 — replace `purpleExpressLikelyActive` and `corridorBbox` with `activeServiceRange(line, window)`

For each line, on every tick, compute the along-track range currently
occupied by trains observed in the **last 30 min** (not 6 h). For
round-trip lines, compute **per direction** (one range for outbound trDr,
one for inbound trDr).

For Purple specifically:

- During Express hours, dir-matched obs span the full Linden ↔ Loop
  polyline → active range is the whole branch.
- During shuttle hours, all dir-matched obs in the last 30 min sit between
  Howard and Linden → active range is Linden ↔ Howard.
- During the transition (last NB deadhead at 19:24 → all obs north of
  Howard by 19:54), the active range tightens automatically within 30
  minutes of the last Loop-trunk train.

The detector then **only evaluates bins inside the active range**. The Loop
trunk simply isn't part of the corridor when no Linden-bound train has
been seen there in 30 min. No FPs possible.

This deletes:

- `purpleExpressLikelyActive` (Bugs 1, 2, 3)
- `excludeDestinations: ['Loop']` (Bugs 5, 6)
- The `HOWARD_LAT` south-of-Howard veto (Bugs 7, 8)
- `MID_POLYLINE_TURNAROUND_STATIONS.p` (Bug 14, in part)
- The 6 h corridor lookback (Bug 4)

It generalizes to every other line — Yellow shuttle bus substitution, Pink
weekend pattern changes, any partial-line outage — without per-line
constants.

### Step 2 — tighten the "last train left, not bracketed" case

Extend the aliasing veto with an **exit-veto** (Bug 9): if any in-direction
train's trajectory has its last observation **inside** the cold run and
that observation is within ~1× headway of `now`, the run was just
*vacated*, not stranded — that's a tail, not an outage. This catches the
"last Express NB train left the Loop trunk at 19:24" case even without the
active-range fix.

### Step 3 — per-direction GTFS gate

Change `expectedTrainDispatchesInWindow(line, null, …)` to pass the
candidate's `directionHint` (Bug 13). On Purple branch-0-outbound at
19:50, GTFS knows there are zero scheduled NB Express dispatches → veto
fires before we even consider it.

Add a per-direction wind-down gate alongside the line-wide one (Bug 11):
if expected outbound trips this hour < 1, skip outbound-branch evaluation
entirely while leaving inbound alone.

### Step 4 — apply the same active-range gate to `detectHeldClusters`

Plumb `activeServiceRange` through to held detection (Bug 14). Clusters
outside the active range are not considered.

### Step 5 — regression corpus + replay test

The reason this cycle hasn't ended is that there's no automated check.
Add `test/train/pulseReplayFixtures.test.js`:

- Pin a small set of `(line, timeRange)` pairs from confirmed FPs — at
  minimum tonight (2026-05-13 19:30–20:30 Purple), the 2026-05-11 AM
  Chicago → Quincy, 2026-05-04 Sedgwick → Quincy, 2026-05-12 Central →
  Noyes, 2026-05-06 Central → Main.
- For each, dump the actual `observations` rows the bot saw into a fixture
  file (one-time export from the prod DB).
- The test runs `detectDeadSegments` against the fixture and asserts
  `candidates.length === 0`.

Also add a "must still detect" corpus from real outages (CTA-confirmed
alerts on Purple). The fix is accepted only when **both** suites pass.

### Step 6 — delete the patch layer

Once Steps 1–4 are in and the regression suite passes, remove
`purpleExpressLikelyActive`, `MID_POLYLINE_TURNAROUND_STATIONS`, the
`HOWARD_LAT` veto, and the `purpleOffPeak` option from
`detectDeadSegments`. These become explicit dead code rather than
load-bearing patches whose interactions nobody can fully reason about.

### Sequencing (all today)

1. **Step 5 first** — build the regression corpus from the prod DB
   (tonight's FP + the 4 prior FPs). Land the failing tests so every
   subsequent commit has a target. ~30 min.
2. **Step 1** — implement `activeServiceRange` and wire it into
   `detectDeadSegments` as the new corridor source. Run the FP corpus
   green and the existing pulse tests green. ~1–2 hr.
3. **Steps 2, 3, 4** — exit-veto, per-direction GTFS/wind-down gate,
   active-range plumbed into `detectHeldClusters`. Each lands as its own
   commit with its own corpus assertion. ~1–2 hr total.
4. **Step 6** — same day, after the corpus is green: delete
   `purpleExpressLikelyActive`, `MID_POLYLINE_TURNAROUND_STATIONS`, the
   `HOWARD_LAT` veto, and the `purpleOffPeak` plumbing. The corpus is the
   safety net; we don't need 7 days of live data because the corpus *is*
   the live data, replayed. ~15 min.

Deploy to the server tonight. If a new FP shape shows up tomorrow, it gets
added to the corpus as a new fixture and a new commit — same loop, but
now the loop has teeth.
