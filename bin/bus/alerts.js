#!/usr/bin/env node
// COTA service alerts: stop closures, reroutes, reduced service — gated to
// short-term disruptions only (see src/bus/alerts.js for why and the real
// feed data that calibrated the gate). One-shot: fetch → gate → post new
// admitted alerts → sweep for resolutions. Text-only for v1 (no disruption
// map — the old CTA pipeline's renderBusDisruption was CTA-specific).
require('../../src/shared/env');

const argv = require('minimist')(process.argv.slice(2));

const { getAlertsFeed } = require('../../src/bus/api');
const { normalizeAlert, isAdmittedAlert, isStillActive } = require('../../src/bus/alerts');
const { buildAlertPostText } = require('../../src/bus/alertPost');
const { loginBus, postText } = require('../../src/bus/bluesky');
const history = require('../../src/shared/history');
const { setup, runBin } = require('../../src/shared/runBin');

// Distinct from the 'bus' kind used by gaps/ghosts/pulse so listUnresolvedAlerts
// and route-LIKE queries against alert_posts can't cross-contaminate between
// detector types that happen to share a table.
const KIND = 'bus-service-alert';

// COTA can have a genuinely large batch of admitted alerts at once (e.g. a
// bad day cancels whole blocks across many routes — observed 22 simultaneous
// admitted alerts during testing). Cap new posts per run, same spirit as
// bin/bus/gaps.js's BUS_GAP_DAILY_CAP, so one tick can't flood the timeline.
// Anything past the cap is simply not recorded this run, so it's picked back
// up and posted on a later tick (every 15 min) until the backlog clears.
const MAX_NEW_POSTS_PER_RUN = 5;

async function main() {
  setup();
  const now = Date.now();

  const feed = await getAlertsFeed();
  const allAlerts = feed.entity.map(normalizeAlert);
  const admitted = allAlerts.filter((a) => isAdmittedAlert(a, now));
  console.log(`${feed.entity.length} total alerts, ${admitted.length} admitted after gating`);

  let agentPromise = null;
  const getAgent = () => {
    if (!agentPromise) agentPromise = loginBus();
    return agentPromise;
  };

  let newPostCount = 0;
  for (const alert of admitted) {
    const existing = history.getAlertPost(alert.id);
    if (existing) {
      // Already known (posted, or a prior run recorded it before a post
      // landed) — just refresh last_seen_ts/version tracking via the normal
      // recordAlertSeen flow below; don't post again.
      if (!argv['dry-run']) {
        history.recordAlertSeen(
          {
            alertId: alert.id,
            kind: KIND,
            routes: alert.routeIds.join(','),
            headline: alert.headerText,
            shortDescription: alert.descriptionText,
            postUri: existing.post_uri,
          },
          now,
        );
      }
      continue;
    }

    if (newPostCount >= MAX_NEW_POSTS_PER_RUN) {
      console.log(
        `At ${MAX_NEW_POSTS_PER_RUN}/run cap, deferring alert ${alert.id} to a later tick`,
      );
      continue;
    }

    const text = buildAlertPostText(alert);
    console.log(`New admitted alert ${alert.id} (routes: ${alert.routeIds.join(', ') || 'none'})`);

    if (argv['dry-run']) {
      console.log(`\n--- DRY RUN alert ${alert.id} ---\n${text}`);
      newPostCount += 1;
      continue;
    }
    newPostCount += 1;

    // Record before posting (posted: implied by postUri arriving after) so a
    // crash mid-post doesn't silently retry-post on the next tick.
    history.recordAlertSeen(
      {
        alertId: alert.id,
        kind: KIND,
        routes: alert.routeIds.join(','),
        headline: alert.headerText,
        shortDescription: alert.descriptionText,
        postUri: null,
      },
      now,
    );
    const agent = await getAgent();
    const result = await postText(agent, text);
    console.log(`Posted alert ${alert.id}: ${result.url}`);
    history.recordAlertSeen(
      {
        alertId: alert.id,
        kind: KIND,
        routes: alert.routeIds.join(','),
        headline: alert.headerText,
        shortDescription: alert.descriptionText,
        postUri: result.uri,
      },
      now,
    );
  }

  if (argv['dry-run']) return;

  // Resolution sweep: checked against the RAW feed (any effect/duration),
  // not the admitted subset — an alert that outgrew the admit gate's
  // duration threshold is still a real, ongoing disruption, not resolved.
  // Only a feed-drop or a genuinely elapsed active_period clears it, via the
  // same debounced clear-tick mechanism the CTA pipeline already used.
  const byId = new Map(allAlerts.map((a) => [a.id, a]));
  for (const row of history.listUnresolvedAlerts(KIND)) {
    const stillActive = isStillActive(byId.get(row.alert_id) || null, now);
    if (stillActive) {
      history.resetAlertClearTicks(row.alert_id);
      continue;
    }
    const ticks = history.incrementAlertClearTicks(row.alert_id, now);
    if (ticks >= history.ALERT_CLEAR_TICKS) {
      // Silent resolution for v1 — a COTA alert dropping from the feed isn't
      // itself newsworthy the way a CTA service-restoration announcement
      // was; no "all clear" reply post.
      history.recordAlertResolved({ alertId: row.alert_id, replyUri: null }, now);
      console.log(`Resolved alert ${row.alert_id} (silent, no reply post)`);
    }
  }
}

if (require.main === module) {
  runBin(main);
}
