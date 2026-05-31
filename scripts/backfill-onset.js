#!/usr/bin/env node
// ONE-SHOT — delete after the initial --apply run. The live detector
// (src/train/pulse.js recoverConcreteOnset) handles onset for everything going
// forward; this script exists only to fix events already on record when the
// fix shipped, and isn't part of any pipeline.
//
// Backfill concrete onset on past pulse-cold train detections.
//
// A cold run is only posted once it's already been cold a while, so the last
// train through it often predates the detection lookback. When that happened,
// ingest stored evidence.minutesSinceLastTrain = null and the web export floored
// onset_ts to the cold threshold (a lower bound, not a measurement). The live
// detector now recovers a concrete onset from the wider 2h position history
// (src/train/pulse.js recoverConcreteOnset); this script applies the same
// recovery retroactively so recent event pages get the accurate start.
//
// Scope / limits:
//   - Only `source = 'observed'` (pulse-cold) TRAIN rows with a null
//     minutesSinceLastTrain — i.e. the floored ones the fix targets. Held
//     ('observed-held') and thin-service rows are out of scope.
//   - Positions roll off at 7 days (observations.ROLLOFF_MS), so only events
//     from the last ~7 days can be re-derived; older rows are skipped.
//   - Run geometry isn't persisted, so it's reconstructed from the stored
//     from_station/to_station along the branch matching the row's direction.
//     Rows whose stations can't be located on a branch are skipped.
//   - Idempotent: only fills a null minutesSinceLastTrain, never overwrites a
//     value a prior run (or live ingest) already measured.
//
// Defaults to a dry run. Pass --apply to write.

require('../src/shared/env');
const Database = require('better-sqlite3');
const {
  recoverConcreteOnset,
  ONSET_WIDEN_CAP_MS,
  stationsAlongBranch,
} = require('../src/train/pulse');
const { buildLineBranches } = require('../src/train/speedmap');
const trainLines = require('../src/train/data/trainLines.json');
const trainStations = require('../src/train/data/trainStations.json');

const DB_PATH =
  process.env.HISTORY_DB || '/home/cailin/Development/cta-insights/state/history.sqlite';
const APPLY = process.argv.includes('--apply');
const POSITION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function parseEvidence(json) {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// Re-derive the cold run's [runLoFt, runHiFt] and the branch geometry from the
// stored endpoint station names. Returns { points, cumDist, trDrFilter,
// runLoFt, runHiFt } or null when the stations can't be located on one branch.
function reconstructRun(line, fromStation, toStation) {
  let branches;
  try {
    branches = buildLineBranches(trainLines, line);
  } catch {
    return null;
  }
  for (const branch of branches) {
    const { points, cumDist, totalFt, trDrFilter } = branch;
    if (!totalFt || points.length < 2) continue;
    const onBranch = stationsAlongBranch(trainStations, line, points, cumDist);
    const from = onBranch.find((s) => s.station.name === fromStation);
    const to = onBranch.find((s) => s.station.name === toStation);
    if (!from || !to) continue;
    const runLoFt = Math.min(from.trackDist, to.trackDist);
    const runHiFt = Math.max(from.trackDist, to.trackDist);
    if (runHiFt <= runLoFt) continue;
    return { points, cumDist, trDrFilter, runLoFt, runHiFt };
  }
  return null;
}

function main() {
  const db = new Database(DB_PATH, APPLY ? {} : { readonly: true });

  // Anchor the retention floor on the newest position we actually hold, not
  // wall-clock now — a stale DB copy would otherwise reject every row.
  const maxPosTs =
    db.prepare("SELECT MAX(ts) AS ts FROM observations WHERE kind = 'train'").get()?.ts ?? null;
  const retentionFloorTs = maxPosTs != null ? maxPosTs - POSITION_RETENTION_MS : 0;

  const rows = db
    .prepare(
      `SELECT id, ts, line, direction, from_station, to_station, evidence
         FROM disruption_events
        WHERE kind = 'train' AND source = 'observed' AND posted = 1
          AND from_station IS NOT NULL AND to_station IS NOT NULL
          AND ts >= ?
        ORDER BY ts ASC`,
    )
    .all(retentionFloorTs);

  // Pre-load the train positions once; filter per row in JS. (7 days of train
  // positions is well within memory and far cheaper than a query per row.)
  const positions = db
    .prepare(
      `SELECT ts, route AS line, direction AS trDr, lat, lon
         FROM observations
        WHERE kind = 'train' AND lat IS NOT NULL AND lon IS NOT NULL AND ts >= ?`,
    )
    .all(retentionFloorTs);
  const posByLine = new Map();
  for (const p of positions) {
    let arr = posByLine.get(p.line);
    if (!arr) {
      arr = [];
      posByLine.set(p.line, arr);
    }
    arr.push(p);
  }

  const update = db.prepare('UPDATE disruption_events SET evidence = ? WHERE id = ?');

  let examined = 0;
  let alreadyConcrete = 0;
  let noGeometry = 0;
  let noRecovery = 0;
  let changed = 0;
  const examples = [];

  for (const row of rows) {
    const evidence = parseEvidence(row.evidence);
    if (!evidence) continue;
    examined++;
    // Only fill the floored rows — never overwrite a measured value.
    if (evidence.minutesSinceLastTrain != null) {
      alreadyConcrete++;
      continue;
    }

    const run = reconstructRun(row.line, row.from_station, row.to_station);
    if (!run) {
      noGeometry++;
      continue;
    }

    // Positions on this line at or before the post time, within the 2h cap.
    const linePos = (posByLine.get(row.line) || []).filter(
      (p) => p.ts <= row.ts && p.ts >= row.ts - ONSET_WIDEN_CAP_MS,
    );
    const onsetTs = recoverConcreteOnset({
      positions: linePos,
      points: run.points,
      cumDist: run.cumDist,
      trDrFilter: run.trDrFilter,
      runLoFt: run.runLoFt,
      runHiFt: run.runHiFt,
      now: row.ts,
    });
    if (onsetTs == null) {
      noRecovery++;
      continue;
    }

    const minutesSinceLastTrain = Math.round((row.ts - onsetTs) / 60000);
    if (minutesSinceLastTrain <= 0) {
      noRecovery++;
      continue;
    }
    const nextEvidence = { ...evidence, minutesSinceLastTrain };
    changed++;
    if (examples.length < 30) {
      examples.push(
        `#${row.id} ${row.line} ${row.from_station}→${row.to_station}: ` +
          `floor ${evidence.coldThresholdMin ?? '?'}m → concrete ${minutesSinceLastTrain}m`,
      );
    }
    if (APPLY) update.run(JSON.stringify(nextEvidence), row.id);
  }

  console.log(
    `Examined ${examined} posted pulse-cold train rows in the retained window ` +
      `(${rows.length} candidates since ${new Date(retentionFloorTs).toISOString()}).`,
  );
  console.log(
    `  already concrete: ${alreadyConcrete} · no geometry: ${noGeometry} · no recovery: ${noRecovery}`,
  );
  if (examples.length > 0) console.log(examples.join('\n'));
  console.log(
    `\n${APPLY ? 'Updated' : 'Would update'} ${changed} rows. ${APPLY ? '' : 'Re-run with --apply to write.'}`,
  );
  db.close();
}

main();
