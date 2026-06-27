const test = require('node:test');
const assert = require('node:assert/strict');
const Path = require('node:path');
const Fs = require('node:fs');
const Os = require('node:os');

// A route can have several independently-cancelled blocks fire their own
// alert_id over one day — findTodaysAlertPostForRoute finds the most recent
// same-day, same-route post so a new one can thread under it instead of
// reading like its own complete daily summary. See bin/bus/alerts.js.

function loadHistoryWithDb() {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'ctabot-alertthread-'));
  const dbPath = Path.join(dir, 'history.sqlite');
  process.env.HISTORY_DB_PATH = dbPath;
  delete require.cache[require.resolve('../../src/shared/history')];
  const history = require('../../src/shared/history');
  history.getDb();
  return {
    history,
    cleanup: () => {
      try {
        history.getDb().close();
      } catch (_) {
        /* ignore */
      }
      delete require.cache[require.resolve('../../src/shared/history')];
      delete process.env.HISTORY_DB_PATH;
      try {
        Fs.rmSync(dir, { recursive: true, force: true });
      } catch (_) {
        /* ignore */
      }
    },
  };
}

// A real Eastern noon, safely mid-day on both sides of any DST boundary.
const TODAY_NOON = new Date('2026-06-26T16:00:00Z').getTime();

test('findTodaysAlertPostForRoute: returns the more recent of two same-day, same-route posts', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    history.recordAlertSeen(
      {
        alertId: 'a1',
        kind: 'bus-service-alert',
        routes: '008',
        headline: 'h1',
        postUri: 'at://x/y/a1',
      },
      TODAY_NOON - 60 * 60 * 1000,
    );
    history.recordAlertSeen(
      {
        alertId: 'a2',
        kind: 'bus-service-alert',
        routes: '008',
        headline: 'h2',
        postUri: 'at://x/y/a2',
      },
      TODAY_NOON,
    );
    const found = history.findTodaysAlertPostForRoute(
      { kind: 'bus-service-alert', route: '008' },
      TODAY_NOON + 1000,
    );
    assert.equal(found.alert_id, 'a2');
  } finally {
    cleanup();
  }
});

test('findTodaysAlertPostForRoute: a different route does not match', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    history.recordAlertSeen(
      {
        alertId: 'a1',
        kind: 'bus-service-alert',
        routes: '008',
        headline: 'h',
        postUri: 'at://x/y/a1',
      },
      TODAY_NOON,
    );
    const found = history.findTodaysAlertPostForRoute(
      { kind: 'bus-service-alert', route: '009' },
      TODAY_NOON + 1000,
    );
    assert.equal(found, null);
  } finally {
    cleanup();
  }
});

test('findTodaysAlertPostForRoute: a not-yet-posted alert (no post_uri) is excluded', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    history.recordAlertSeen(
      { alertId: 'a1', kind: 'bus-service-alert', routes: '008', headline: 'h', postUri: null },
      TODAY_NOON,
    );
    const found = history.findTodaysAlertPostForRoute(
      { kind: 'bus-service-alert', route: '008' },
      TODAY_NOON + 1000,
    );
    assert.equal(found, null);
  } finally {
    cleanup();
  }
});

test('findTodaysAlertPostForRoute: a post from a prior Eastern day is excluded', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    const yesterday = TODAY_NOON - 24 * 60 * 60 * 1000;
    history.recordAlertSeen(
      {
        alertId: 'a1',
        kind: 'bus-service-alert',
        routes: '008',
        headline: 'h',
        postUri: 'at://x/y/a1',
      },
      yesterday,
    );
    const found = history.findTodaysAlertPostForRoute(
      { kind: 'bus-service-alert', route: '008' },
      TODAY_NOON,
    );
    assert.equal(found, null);
  } finally {
    cleanup();
  }
});

test('findTodaysAlertPostForRoute: a resolved alert still counts as a valid thread anchor', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    history.recordAlertSeen(
      {
        alertId: 'a1',
        kind: 'bus-service-alert',
        routes: '008',
        headline: 'h',
        postUri: 'at://x/y/a1',
      },
      TODAY_NOON,
    );
    history.recordAlertResolved({ alertId: 'a1', replyUri: null }, TODAY_NOON + 1000);
    const found = history.findTodaysAlertPostForRoute(
      { kind: 'bus-service-alert', route: '008' },
      TODAY_NOON + 2000,
    );
    assert.equal(found.alert_id, 'a1');
  } finally {
    cleanup();
  }
});

test('findTodaysAlertPostForRoute: a different kind does not match (no cross-contamination)', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    history.recordAlertSeen(
      { alertId: 'a1', kind: 'bus', routes: '008', headline: 'h', postUri: 'at://x/y/a1' },
      TODAY_NOON,
    );
    const found = history.findTodaysAlertPostForRoute(
      { kind: 'bus-service-alert', route: '008' },
      TODAY_NOON + 1000,
    );
    assert.equal(found, null);
  } finally {
    cleanup();
  }
});
