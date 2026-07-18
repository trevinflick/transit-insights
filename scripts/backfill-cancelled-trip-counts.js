#!/usr/bin/env node
// One-shot backfill: reads all cancellation posts from the COTA bot's
// Bluesky profile, then updates alert_posts.cancelled_trip_count for every
// row that has a matching post_uri but no trip count yet.
//
// Safe to re-run: only touches rows where cancelled_trip_count IS NULL.
// Prints a summary of what was updated, what was already filled, and what
// had no matching post (posts older than the Bluesky API's history window
// may not come back).
//
// Usage:
//   node scripts/backfill-cancelled-trip-counts.js [--dry-run] [--actor=HANDLE]
//
//   --dry-run    Print what would be updated without writing to the DB
//   --actor      Bluesky handle (default: cbusbot.bsky.social)

require('../src/shared/env');

const Path = require('node:path');
const argv = require('minimist')(process.argv.slice(2));
const Database = require('better-sqlite3');

const DRY_RUN = !!argv['dry-run'];
const ACTOR = argv.actor || 'cbusbot.bsky.social';
const KIND = 'bus-service-alert';
const PUBLIC_API = 'https://public.api.bsky.app';

const CANCELLED_RE = /\b(\d+)\s+buses?\s+cancelled\s+today\b/i;
const MORE_CANCELLED_RE = /\b(\d+)\s+more\s+buses?\s+cancelled\b/i;

function parseCancellationCount(text) {
  const m = CANCELLED_RE.exec(text) || MORE_CANCELLED_RE.exec(text);
  return m ? parseInt(m[1], 10) : null;
}

async function fetchPage(cursor) {
  const url = new URL(`${PUBLIC_API}/xrpc/app.bsky.feed.getAuthorFeed`);
  url.searchParams.set('actor', ACTOR);
  url.searchParams.set('limit', '100');
  url.searchParams.set('filter', 'posts_with_replies');
  if (cursor) url.searchParams.set('cursor', cursor);
  const resp = await fetch(url.toString());
  if (!resp.ok) throw new Error(`Bluesky API error ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

async function buildUriToCountMap(neededUris) {
  const map = new Map(); // uri → count
  let cursor = null;
  let page = 0;

  console.log(`Fetching posts from @${ACTOR} to build uri→count lookup...`);

  while (true) {
    page++;
    const data = await fetchPage(cursor);
    const items = data.feed || [];

    for (const item of items) {
      if (item.reason?.$type === 'app.bsky.feed.defs#reasonRepost') continue;
      const post = item.post;
      if (!post?.uri) continue;
      const text = post.record?.text || '';
      const count = parseCancellationCount(text);
      if (count != null) map.set(post.uri, count);
    }

    process.stdout.write(
      `  page ${page}: ${items.length} fetched, ${map.size} cancellation posts found so far\r`,
    );

    // Stop early if we've found all the URIs we need and the oldest post
    // in this page predates anything we could need.
    if (!data.cursor || items.length === 0) break;
    cursor = data.cursor;
  }

  process.stdout.write('\n');
  console.log(`Done — ${map.size} cancellation posts across ${page} pages`);
  return map;
}

async function main() {
  const histPath =
    process.env.HISTORY_DB_PATH || Path.join(__dirname, '..', 'state', 'history.sqlite');
  const db = new Database(histPath);

  // Find rows needing a backfill
  const pending = db
    .prepare(
      `SELECT alert_id, post_uri, headline
       FROM alert_posts
       WHERE kind = ? AND cancelled_trip_count IS NULL AND post_uri IS NOT NULL`,
    )
    .all(KIND);

  const alreadyFilled = db
    .prepare(
      `SELECT COUNT(*) as c FROM alert_posts
       WHERE kind = ? AND cancelled_trip_count IS NOT NULL`,
    )
    .get(KIND).c;

  const noPostUri = db
    .prepare(
      `SELECT COUNT(*) as c FROM alert_posts
       WHERE kind = ? AND post_uri IS NULL`,
    )
    .get(KIND).c;

  console.log(`alert_posts (kind=${KIND}):`);
  console.log(`  Already have count: ${alreadyFilled}`);
  console.log(`  Need backfill:      ${pending.length}`);
  console.log(`  No post_uri (never posted, silent-resolved): ${noPostUri}`);

  if (pending.length === 0) {
    console.log('\nNothing to backfill.');
    db.close();
    return;
  }

  const neededUris = new Set(pending.map((r) => r.post_uri));
  const uriToCount = await buildUriToCountMap(neededUris);

  const updateStmt = db.prepare(
    'UPDATE alert_posts SET cancelled_trip_count = ? WHERE alert_id = ?',
  );

  let updated = 0;
  let notFound = 0;
  let notCancellation = 0;

  const doUpdate = db.transaction(() => {
    for (const row of pending) {
      const count = uriToCount.get(row.post_uri);
      if (count == null) {
        // Either the post wasn't a cancellation (e.g. a reroute alert) or
        // Bluesky didn't return it (very old posts beyond API history).
        if (uriToCount.has(row.post_uri)) {
          notCancellation++;
        } else {
          notFound++;
          console.log(`  Not found in feed: ${row.post_uri} (${row.headline?.slice(0, 60)})`);
        }
        continue;
      }
      if (DRY_RUN) {
        console.log(`  [dry-run] Would set ${row.alert_id} → ${count} trips`);
      } else {
        updateStmt.run(count, row.alert_id);
      }
      updated++;
    }
  });

  doUpdate();

  console.log(`\n${DRY_RUN ? '[dry-run] Would update' : 'Updated'}: ${updated} rows`);
  console.log(`Not a cancellation alert (reroute/detour): ${notCancellation}`);
  console.log(`Not found in Bluesky feed (too old or deleted): ${notFound}`);

  db.close();
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
