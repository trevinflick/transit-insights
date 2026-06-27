#!/usr/bin/env node
// COTA service alerts: stop closures, reroutes, reduced service — gated to
// short-term disruptions only (see src/bus/alerts.js for why and the real
// feed data that calibrated the gate). One-shot: fetch → gate → post new
// admitted alerts → sweep for resolutions.
require('../../src/shared/env');

const argv = require('minimist')(process.argv.slice(2));

const { getAlertsFeed } = require('../../src/bus/api');
const { normalizeAlert, isAdmittedAlert, isStillActive } = require('../../src/bus/alerts');
const { buildAlertPostText, buildAlertAltText } = require('../../src/bus/alertPost');
const { getTripMeta, getShapePoints } = require('../../src/shared/gtfs');
const { renderDisruptionMap } = require('../../src/map');
const { loginBus, postText, postWithImage } = require('../../src/bus/bluesky');
const { resolveReplyRef } = require('../../src/shared/bluesky');
const history = require('../../src/shared/history');
const { setup, writeDryRunAsset, runBin } = require('../../src/shared/runBin');

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

// Whole-trip cancellations can affect 200+ stops — too many to name — but
// the affected ROUTE is easy to show. Resolves each cancelled trip's actual
// shape (via the trip_id already carried on the alert, no guessing a
// "representative" pattern) and dedupes by shape_id, since a block usually
// repeats the same 1-2 shapes across all its trips for the day. Returns null
// (caller falls back to text-only) when there's nothing to resolve or the
// render itself fails.
async function buildAlertImage(alert) {
  if (!alert.cancelledTrips || alert.cancelledTrips.length === 0) return null;
  const shapeIds = new Set();
  for (const t of alert.cancelledTrips) {
    const meta = getTripMeta(t.tripId);
    if (meta?.shapeId) shapeIds.add(String(meta.shapeId));
  }
  const shapes = [...shapeIds]
    .map((shapeId) => getShapePoints(shapeId))
    .filter((points) => points && points.length >= 2)
    .map((points) => ({ points }));
  if (shapes.length === 0) return null;

  try {
    return await renderDisruptionMap(shapes);
  } catch (e) {
    console.warn(`Map render failed for alert ${alert.id} (${e.message}); will post text-only`);
    return null;
  }
}

// A route can have several independently-cancelled blocks fire their own
// alert_id over one day — without threading, each one reads like its own
// complete daily summary rather than an update on the same ongoing day.
// Finds the most recent already-posted alert today for any of this alert's
// routes (across multiple routes, picks the most recent — same pattern the
// old CTA pipeline's findRecentBusPulse used for pulse-threading).
function findThreadParent(alert, now) {
  let best = null;
  for (const route of alert.routeIds || []) {
    const row = history.findTodaysAlertPostForRoute({ kind: KIND, route }, now);
    if (row && (!best || row.first_seen_ts > best.first_seen_ts)) best = row;
  }
  return best;
}

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
    const image = await buildAlertImage(alert);
    const threadParent = findThreadParent(alert, now);
    console.log(
      `New admitted alert ${alert.id} (routes: ${alert.routeIds.join(', ') || 'none'}${image ? ', with map' : ''}${threadParent ? `, threading under ${threadParent.alert_id}` : ''})`,
    );

    if (argv['dry-run']) {
      const outPath = image
        ? writeDryRunAsset(image, `alert-${alert.id}-${Date.now()}.jpg`)
        : '(no map — text-only)';
      console.log(`\n--- DRY RUN alert ${alert.id} ---\n${text}\nImage: ${outPath}`);
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
    // resolveReplyRef walks the thread to its current latest leaf, so this
    // lands correctly even if threadParent itself was already a reply.
    const replyRef = threadParent ? await resolveReplyRef(agent, threadParent.post_uri) : null;
    const result = image
      ? await postWithImage(agent, text, image, buildAlertAltText(alert), replyRef)
      : await postText(agent, text, replyRef);
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
