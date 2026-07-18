#!/usr/bin/env node
// Fetches all posts from the COTA bot's Bluesky profile and tallies historical
// bus cancellation data from the post text.
//
// Uses the public Bluesky API — no credentials needed.
//
// Usage:
//   node scripts/fetch-bluesky-cancellations.js [options]
//
//   --actor=HANDLE   Bluesky handle (default: cbusbot.bsky.social)
//   --since=DATE     Only count posts on or after this date (YYYY-MM-DD)
//   --until=DATE     Only count posts before this date (YYYY-MM-DD)
//   --csv            Emit CSV to stdout
//   --save=FILE      Save raw post data as JSON for offline re-parsing
//   --load=FILE      Parse from a previously saved JSON file (no network)
//   --verbose        Print each matched post as it's processed

const argv = require('minimist')(process.argv.slice(2));

const ACTOR = argv.actor || 'cbusbot.bsky.social';
const CSV_MODE = !!argv.csv;
const VERBOSE = !!argv.verbose;
const SAVE_PATH = argv.save || null;
const LOAD_PATH = argv.load || null;

const sinceTs = argv.since ? Date.parse(argv.since + 'T00:00:00-05:00') : 0;
const untilTs = argv.until ? Date.parse(argv.until + 'T23:59:59-05:00') : Infinity;

// Matches: "3 buses cancelled today" or "3 bus cancelled today"
const CANCELLED_RE = /\b(\d+)\s+buses?\s+cancelled\s+today\b/i;
// Matches: "3 more buses cancelled" or "1 more bus cancelled"
const MORE_CANCELLED_RE = /\b(\d+)\s+more\s+buses?\s+cancelled\b/i;

function isoDate(ts) {
  return new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function parseCancellation(text) {
  const m = CANCELLED_RE.exec(text) || MORE_CANCELLED_RE.exec(text);
  return m ? parseInt(m[1], 10) : null;
}

// Bluesky public API — no auth required for public profiles.
const PUBLIC_API = 'https://public.api.bsky.app';

async function fetchPage(cursor) {
  const url = new URL(`${PUBLIC_API}/xrpc/app.bsky.feed.getAuthorFeed`);
  url.searchParams.set('actor', ACTOR);
  url.searchParams.set('limit', '100');
  url.searchParams.set('filter', 'posts_with_replies');
  if (cursor) url.searchParams.set('cursor', cursor);

  const resp = await fetch(url.toString());
  if (!resp.ok) throw new Error(`API error ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

async function fetchAllPosts() {
  const posts = [];
  let cursor = null;
  let page = 0;

  process.stderr.write(`Fetching posts from @${ACTOR}...\n`);

  while (true) {
    page++;
    const data = await fetchPage(cursor);
    const items = data.feed || [];

    let hitBoundary = false;
    for (const item of items) {
      // Skip reposts
      if (item.reason?.$type === 'app.bsky.feed.defs#reasonRepost') continue;
      const post = item.post;
      const text = post?.record?.text || '';
      const createdAt = post?.record?.createdAt || post?.indexedAt || null;
      const ts = createdAt ? Date.parse(createdAt) : null;

      if (ts != null && ts < sinceTs) {
        hitBoundary = true;
        break;
      }

      posts.push({ uri: post.uri, text, createdAt, ts });
    }

    process.stderr.write(
      `  page ${page}: ${items.length} items fetched, ${posts.length} total so far\n`,
    );

    if (hitBoundary || !data.cursor || items.length === 0) break;
    cursor = data.cursor;
  }

  return posts;
}

function tallyCancellations(posts) {
  const byDay = new Map(); // isoDate → { count, routeTotals: Map<route, n>, posts: [] }

  for (const post of posts) {
    const ts = post.ts;
    if (ts == null) continue;
    if (ts < sinceTs || ts > untilTs) continue;

    const count = parseCancellation(post.text);
    if (count == null) continue;

    const day = isoDate(ts);
    if (!byDay.has(day)) byDay.set(day, { count: 0, routeTotals: new Map(), posts: [] });
    const d = byDay.get(day);
    d.count += count;
    d.posts.push({ ts, count, text: post.text, uri: post.uri });

    // Extract route from "⚠ Route 7 (Mt Vernon)" or "⚠ Route 7"
    const routeMatch = post.text.match(/Route\s+(\d+)/i);
    if (routeMatch) {
      const r = routeMatch[1];
      d.routeTotals.set(r, (d.routeTotals.get(r) || 0) + count);
    }

    if (VERBOSE) {
      process.stderr.write(`  ${day} +${count} — ${post.text.slice(0, 80).replace(/\n/g, ' ')}\n`);
    }
  }

  return new Map([...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

function printReport(byDay) {
  const days = [...byDay.entries()];
  if (days.length === 0) {
    console.log('No cancellation posts found in the specified window.');
    return;
  }

  const maxCount = Math.max(...days.map(([, d]) => d.count), 1);
  const BAR_WIDTH = 35;
  const colDate = 14;
  const colCount = 7;

  function pad(s, n) {
    return String(s).padStart(n);
  }
  function lpad(s, n) {
    return String(s).padEnd(n);
  }

  const header = lpad('Date', colDate) + pad('Cxld', colCount) + '  Chart';
  const divider = '─'.repeat(colDate + colCount + 2 + BAR_WIDTH);

  const total = days.reduce((s, [, d]) => s + d.count, 0);
  const totalDays = days.length;
  const avgPerDay = (total / totalDays).toFixed(1);
  const maxDay = days.reduce((best, cur) => (cur[1].count > best[1].count ? cur : best));

  // Separate weekdays from weekends for a more meaningful average
  const weekdayCounts = days
    .filter(([d]) => {
      const dow = new Date(d + 'T12:00:00').getDay();
      return dow >= 1 && dow <= 5;
    })
    .map(([, d]) => d.count);
  const weekdayAvg = weekdayCounts.length
    ? (weekdayCounts.reduce((a, b) => a + b, 0) / weekdayCounts.length).toFixed(1)
    : 'n/a';

  process.stdout.write(`\nCOTA bus cancellations — parsed from @${ACTOR} posts\n`);
  process.stdout.write(
    `${totalDays} days with cancellations · ${total.toLocaleString()} total cancelled bus trips\n`,
  );
  process.stdout.write(`Weekday average: ${weekdayAvg}/day · All-day average: ${avgPerDay}/day\n`);
  process.stdout.write(`Peak day: ${maxDay[1].count} on ${maxDay[0]}\n`);
  process.stdout.write(`Dispatch reported: "5–10 missed or delayed per day" (system-wide)\n\n`);
  process.stdout.write(header + '\n');
  process.stdout.write(divider + '\n');

  for (const [day, d] of days) {
    const barLen = Math.round((d.count / maxCount) * BAR_WIDTH);
    const bar = '█'.repeat(barLen);
    const dateFmt = new Date(day + 'T12:00:00').toLocaleDateString('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
    process.stdout.write(lpad(dateFmt, colDate) + pad(d.count, colCount) + '  ' + bar + '\n');
  }

  process.stdout.write(divider + '\n');
  process.stdout.write(lpad('TOTAL', colDate) + pad(total.toLocaleString(), colCount) + '\n\n');

  // Route leaderboard — aggregated across all days
  const routeTotals = new Map();
  for (const [, d] of days) {
    for (const [r, n] of d.routeTotals) {
      routeTotals.set(r, (routeTotals.get(r) || 0) + n);
    }
  }
  const sorted = [...routeTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  if (sorted.length > 0) {
    process.stdout.write('Most-cancelled routes (by trip count):\n');
    for (const [r, n] of sorted) {
      const bar = '█'.repeat(Math.round((n / sorted[0][1]) * 20));
      process.stdout.write(`  Route ${r.padStart(3)}: ${String(n).padStart(4)}  ${bar}\n`);
    }
    process.stdout.write('\n');
  }
}

function printCsv(byDay) {
  process.stdout.write('date,cancelled_buses,routes\n');
  for (const [day, d] of byDay) {
    const routes = [...d.routeTotals.keys()].sort((a, b) => +a - +b).join('|');
    process.stdout.write(`${day},${d.count},${routes}\n`);
  }
}

async function main() {
  let posts;

  if (LOAD_PATH) {
    process.stderr.write(`Loading posts from ${LOAD_PATH}...\n`);
    posts = JSON.parse(require('fs').readFileSync(LOAD_PATH, 'utf8'));
  } else {
    posts = await fetchAllPosts();
    if (SAVE_PATH) {
      require('fs').writeFileSync(SAVE_PATH, JSON.stringify(posts, null, 2));
      process.stderr.write(`Saved ${posts.length} posts to ${SAVE_PATH}\n`);
    }
  }

  process.stderr.write(`Parsed ${posts.length} posts total\n`);

  const byDay = tallyCancellations(posts);
  const matched = [...byDay.values()].reduce((s, d) => s + d.posts.length, 0);
  process.stderr.write(`Matched ${matched} cancellation posts across ${byDay.size} days\n\n`);

  if (CSV_MODE) {
    printCsv(byDay);
  } else {
    printReport(byDay);
  }
}

main().catch((e) => {
  process.stderr.write(`Error: ${e.message}\n`);
  process.exit(1);
});
