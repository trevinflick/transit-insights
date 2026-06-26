#!/usr/bin/env node
// System-wide fleet-degradation rollup: when many routes show gap/ghost/
// thin-gap signals at once (consistent with a network-wide vehicle
// shortage, e.g. a recall pulling buses from service), post one summary
// instead of relying on per-route posts — those are capped per route per
// day and so understate how constant a network-wide problem is. Fire-and-
// forget: no resolution/clear post, just a long cooldown between rollups.
require('../../src/shared/env');

const argv = require('minimist')(process.argv.slice(2));

const {
  gaps: gapRoutes,
  ghosts: ghostRoutes,
  lowFrequency,
  routeLabel,
} = require('../../src/bus/routes');
const { detectSystemWideDegradation } = require('../../src/bus/fleetRollup');
const history = require('../../src/shared/history');
const { acquireCooldown } = require('../../src/shared/state');
const { loginBus, postText } = require('../../src/bus/bluesky');
const { setup, runBin } = require('../../src/shared/runBin');

const WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours
const COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours
const COOLDOWN_KEY = 'fleet-rollup';

// Every route gap/ghost/thin-gap detection actually covers — the honest
// denominator for "X of Y routes degraded" (not allRoutes, which includes
// routes with no schedule baseline to even measure a gap against).
const MONITORED_ROUTES = new Set([...gapRoutes, ...ghostRoutes, ...lowFrequency]);

async function main() {
  setup();
  const now = Date.now();

  const rows = history.getRecentMetaSignals({ kind: 'bus', withinMs: WINDOW_MS }, now);
  const result = detectSystemWideDegradation(rows, { monitoredRouteCount: MONITORED_ROUTES.size });

  if (!result) {
    console.log('No system-wide degradation pattern detected');
    return;
  }

  console.log(
    `Degraded: ${result.degradedCount} of ${result.monitoredRouteCount} monitored routes — worst: ${result.worstRoutes.join(', ')}`,
  );

  const worstLabels = result.worstRoutes.map((r) => routeLabel(r));
  const text = `⚠ ${result.degradedCount} of ${result.monitoredRouteCount} monitored routes showing service gaps in the past 2 hours — wider than usual across the system.\nWorst: ${worstLabels.join(', ')}`;

  if (argv['dry-run']) {
    console.log(`\n--- DRY RUN ---\n${text}`);
    return;
  }

  if (!acquireCooldown(COOLDOWN_KEY, now, COOLDOWN_MS)) {
    console.log('On cooldown, skipping');
    return;
  }

  const agent = await loginBus();
  const posted = await postText(agent, text);
  console.log(`Posted: ${posted.url}`);
}

module.exports = { MONITORED_ROUTES };

if (require.main === module) {
  runBin(main);
}
