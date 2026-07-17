#!/usr/bin/env node
// Extreme-weather fare waivers: COTA's board policy waives all fares
// (fixed-route, Mainstream, COTA//Plus) for the remainder of any day the
// National Weather Service issues a heat or cold advisory/warning for
// Franklin County. Primary trigger is the NWS Alerts API directly
// (src/shared/nws.js + src/bus/fareWaiverNws.js) — the literal documented
// condition behind COTA's policy. COTA's own GTFS-rt Alert/Alerts.pb feed
// (src/bus/fareWaiver.js) is kept as a no-op fallback: despite hours of a
// live, publicly-announced waiver, that feed has carried zero fare/weather
// text, so it's not relied on as the primary signal. One-shot: fetch both
// sources → gate each → post (pinned to the profile) → resolution sweep
// (unpin, silent).
require('../../src/shared/env');

const argv = require('minimist')(process.argv.slice(2));

const { getAlertsFeed } = require('../../src/bus/api');
const { normalizeAlert, isStillActive } = require('../../src/bus/alerts');
const { isFareWaiverAlert, buildFareWaiverPostText } = require('../../src/bus/fareWaiver');
const { getActiveAlertsForZone } = require('../../src/shared/nws');
const {
  isFareWaiverTrigger,
  isNwsAlertOnsetDateReached,
  isNwsAlertActive,
  buildNwsFareWaiverPostText,
} = require('../../src/bus/fareWaiverNws');
const { loginBus, postText, pinPost, unpinPost } = require('../../src/bus/bluesky');
const history = require('../../src/shared/history');
const { setup, runBin } = require('../../src/shared/runBin');

// Distinct kind so listUnresolvedAlerts/audit coverage can't cross-
// contaminate with the route-disruption 'bus-service-alert' kind. Shared
// across both sources — an NWS-triggered post and a (currently hypothetical)
// COTA-feed post are the same kind of event from a rider's perspective.
const KIND = 'bus-fare-waiver';

// NWS ids are long `urn:oid:...` strings; COTA GTFS ids are short numeric
// strings — cheap, no-migration way to know which "is this still active"
// checker applies to an alert_posts row without a dedicated source column.
const isNwsId = (id) => id.startsWith('urn:');

let agentPromise = null;

// Shared by both the GTFS and NWS candidate lists below — handles the
// already-known short-circuit, supersession (a new alert_id while one's
// still open resolves the old one immediately and lets the new pin simply
// overwrite, rather than unpin-then-repin), and posting + pinning. Pulled
// out of the loop bodies so neither source duplicates this logic.
async function processCandidate({ id, headline, shortDescription, text }, now, getAgent) {
  const existing = history.getAlertPost(id);
  if (existing) {
    // Already known — refresh last_seen_ts tracking, don't post again.
    if (!argv['dry-run']) {
      history.recordAlertSeen(
        { alertId: id, kind: KIND, headline, shortDescription, postUri: existing.post_uri },
        now,
      );
    }
    return;
  }

  const superseded = history.listUnresolvedAlerts(KIND)[0] || null;
  console.log(
    `New fare-waiver alert ${id}${superseded ? ` (supersedes ${superseded.alert_id})` : ''}`,
  );

  if (argv['dry-run']) {
    console.log(`\n--- DRY RUN alert ${id} ---\n${text}`);
    return;
  }

  // Record before posting (posted: implied by postUri arriving after) so a
  // crash mid-post doesn't silently retry-post on the next tick.
  history.recordAlertSeen(
    { alertId: id, kind: KIND, headline, shortDescription, postUri: null },
    now,
  );
  const agent = await getAgent();
  const result = await postText(agent, text);
  console.log(`Posted alert ${id}: ${result.url}`);
  history.recordAlertSeen(
    { alertId: id, kind: KIND, headline, shortDescription, postUri: result.uri },
    now,
  );

  if (superseded) {
    history.recordAlertResolved({ alertId: superseded.alert_id, replyUri: null }, now);
    console.log(`Resolved superseded fare-waiver alert ${superseded.alert_id}`);
  }
  await pinPost(agent, { uri: result.uri, cid: result.cid });
}

async function main() {
  setup();
  const now = Date.now();

  const getAgent = () => {
    if (!agentPromise) agentPromise = loginBus();
    return agentPromise;
  };

  const feed = await getAlertsFeed();
  const gtfsAlerts = feed.entity.map(normalizeAlert);
  const gtfsAdmitted = gtfsAlerts.filter(isFareWaiverAlert);

  const nwsAlerts = await getActiveAlertsForZone();
  const nwsAdmitted = nwsAlerts.filter(
    (a) => isFareWaiverTrigger(a) && isNwsAlertOnsetDateReached(a, now),
  );

  console.log(
    `${feed.entity.length} COTA alerts (${gtfsAdmitted.length} fare-waiver-shaped), ` +
      `${nwsAlerts.length} active NWS alerts for Franklin County (${nwsAdmitted.length} fare-waiver triggers)`,
  );

  for (const alert of gtfsAdmitted) {
    await processCandidate(
      {
        id: alert.id,
        headline: alert.headerText,
        shortDescription: alert.descriptionText,
        text: buildFareWaiverPostText(alert),
      },
      now,
      getAgent,
    );
  }
  for (const nwsAlert of nwsAdmitted) {
    await processCandidate(
      {
        id: nwsAlert.id,
        headline: nwsAlert.headline,
        shortDescription: null,
        text: buildNwsFareWaiverPostText(nwsAlert),
      },
      now,
      getAgent,
    );
  }

  if (argv['dry-run']) return;

  // Resolution sweep: checked against each row's RAW source feed (any
  // alert/NWS entry, not just fare-waiver-shaped) — same debounced
  // clear-tick pattern bin/bus/alerts.js uses. Only a feed-drop or a
  // genuinely elapsed active window resolves it.
  const gtfsById = new Map(gtfsAlerts.map((a) => [a.id, a]));
  const nwsById = new Map(nwsAlerts.map((a) => [a.id, a]));
  for (const row of history.listUnresolvedAlerts(KIND)) {
    const stillActive = isNwsId(row.alert_id)
      ? isNwsAlertActive(nwsById.get(row.alert_id) || null, now)
      : isStillActive(gtfsById.get(row.alert_id) || null, now);
    if (stillActive) {
      history.resetAlertClearTicks(row.alert_id);
      continue;
    }
    const ticks = history.incrementAlertClearTicks(row.alert_id, now);
    if (ticks >= history.ALERT_CLEAR_TICKS) {
      if (row.post_uri) {
        const agent = await getAgent();
        await unpinPost(agent, row.post_uri);
      }
      // Silent resolution, matching bin/bus/alerts.js — fares quietly going
      // back to normal isn't itself worth a reply post.
      history.recordAlertResolved({ alertId: row.alert_id, replyUri: null }, now);
      console.log(`Resolved fare-waiver alert ${row.alert_id} (unpinned, silent)`);
    }
  }
}

if (require.main === module) {
  runBin(main);
}
