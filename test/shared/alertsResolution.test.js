const test = require('node:test');
const assert = require('node:assert/strict');
const Path = require('node:path');
const Fs = require('node:fs');
const Os = require('node:os');

function freshDbPath() {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'ctabot-alerts-'));
  return Path.join(dir, 'history.sqlite');
}

function loadHistoryWithDb(dbPath) {
  process.env.HISTORY_DB_PATH = dbPath;
  delete require.cache[require.resolve('../../src/shared/history')];
  const history = require('../../src/shared/history');
  history.getDb();
  return {
    history,
    cleanup: () => {
      try {
        history.getDb().close();
      } catch (_e) {
        /* ignore */
      }
      delete require.cache[require.resolve('../../src/shared/history')];
      delete process.env.HISTORY_DB_PATH;
      try {
        Fs.rmSync(Path.dirname(dbPath), { recursive: true, force: true });
      } catch (_e) {
        /* ignore */
      }
    },
  };
}

test('clear_ticks column exists after init', () => {
  const { history, cleanup } = loadHistoryWithDb(freshDbPath());
  try {
    const cols = history
      .getDb()
      .prepare('PRAGMA table_info(alert_posts)')
      .all()
      .map((c) => c.name);
    assert.ok(cols.includes('clear_ticks'));
  } finally {
    cleanup();
  }
});

test('incrementAlertClearTicks returns the new value', () => {
  const { history, cleanup } = loadHistoryWithDb(freshDbPath());
  try {
    history.recordAlertSeen({
      alertId: 'a1',
      kind: 'train',
      routes: 'red',
      headline: 'h',
      postUri: 'at://x/y/z',
    });
    assert.equal(history.incrementAlertClearTicks('a1'), 1);
    assert.equal(history.incrementAlertClearTicks('a1'), 2);
  } finally {
    cleanup();
  }
});

test('resetAlertClearTicks zeroes the counter', () => {
  const { history, cleanup } = loadHistoryWithDb(freshDbPath());
  try {
    history.recordAlertSeen({
      alertId: 'a1',
      kind: 'train',
      routes: 'red',
      headline: 'h',
      postUri: 'at://x/y/z',
    });
    history.incrementAlertClearTicks('a1');
    history.incrementAlertClearTicks('a1');
    history.resetAlertClearTicks('a1');
    const row = history.getAlertPost('a1');
    assert.equal(row.clear_ticks, 0);
  } finally {
    cleanup();
  }
});

test('recordAlertSeen on existing row refreshes headline and routes', () => {
  const { history, cleanup } = loadHistoryWithDb(freshDbPath());
  try {
    history.recordAlertSeen({
      alertId: 'a1',
      kind: 'train',
      routes: 'red',
      headline: 'old',
      postUri: null,
    });
    history.recordAlertSeen({
      alertId: 'a1',
      kind: 'train',
      routes: 'red,blue',
      headline: 'new',
      postUri: 'at://x/y/z',
    });
    const row = history.getAlertPost('a1');
    assert.equal(row.headline, 'new');
    assert.equal(row.routes, 'red,blue');
    assert.equal(row.post_uri, 'at://x/y/z');
  } finally {
    cleanup();
  }
});

test('recordAlertSeen claim then update preserves first_seen_ts and fills post_uri', () => {
  const { history, cleanup } = loadHistoryWithDb(freshDbPath());
  try {
    const t0 = 1_700_000_000_000;
    history.recordAlertSeen(
      { alertId: 'a1', kind: 'train', routes: 'red', headline: 'h', postUri: null },
      t0,
    );
    let row = history.getAlertPost('a1');
    assert.equal(row.post_uri, null);
    assert.equal(row.first_seen_ts, t0);

    history.recordAlertSeen(
      { alertId: 'a1', kind: 'train', routes: 'red', headline: 'h', postUri: 'at://x/y/z' },
      t0 + 1000,
    );
    row = history.getAlertPost('a1');
    assert.equal(row.post_uri, 'at://x/y/z');
    assert.equal(row.first_seen_ts, t0);
    assert.equal(row.last_seen_ts, t0 + 1000);
  } finally {
    cleanup();
  }
});

test('listUnresolvedAlerts excludes resolved rows', () => {
  const { history, cleanup } = loadHistoryWithDb(freshDbPath());
  try {
    history.recordAlertSeen({
      alertId: 'a1',
      kind: 'train',
      routes: 'red',
      headline: 'h',
      postUri: 'at://x/y/z',
    });
    history.recordAlertSeen({
      alertId: 'a2',
      kind: 'train',
      routes: 'red',
      headline: 'h',
      postUri: 'at://x/y/z2',
    });
    history.recordAlertResolved({ alertId: 'a2', replyUri: null });
    const rows = history.listUnresolvedAlerts('train');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].alert_id, 'a1');
  } finally {
    cleanup();
  }
});

test('resolution gating: increments below threshold, posts at threshold', () => {
  const { history, cleanup } = loadHistoryWithDb(freshDbPath());
  try {
    history.recordAlertSeen({
      alertId: 'a1',
      kind: 'train',
      routes: 'red',
      headline: 'h',
      postUri: 'at://x/y/z',
    });
    let n = 0;
    for (let i = 1; i < history.ALERT_CLEAR_TICKS; i++) {
      n = history.incrementAlertClearTicks('a1');
      assert.ok(n < history.ALERT_CLEAR_TICKS, `tick ${i} should not be enough`);
    }
    n = history.incrementAlertClearTicks('a1');
    assert.ok(n >= history.ALERT_CLEAR_TICKS, 'threshold tick should reach the threshold');
  } finally {
    cleanup();
  }
});

test('resolved_ts backdates to first missing tick, not threshold tick', () => {
  const { history, cleanup } = loadHistoryWithDb(freshDbPath());
  try {
    history.recordAlertSeen({
      alertId: 'a1',
      kind: 'train',
      routes: 'red',
      headline: 'h',
      postUri: 'at://x/y/z',
    });
    const firstMissTs = 1_700_000_000_000;
    // Walk up to (but not over) the threshold, stamping pending_resolved_ts
    // on the first miss only.
    for (let i = 0; i < history.ALERT_CLEAR_TICKS - 1; i++) {
      history.incrementAlertClearTicks('a1', firstMissTs + i * 120_000);
    }
    // Threshold tick fires now, far in the future.
    const thresholdTs = firstMissTs + 999_999_000;
    history.incrementAlertClearTicks('a1', thresholdTs);
    history.recordAlertResolved({ alertId: 'a1', replyUri: null }, thresholdTs);
    const rows = history.listUnresolvedAlerts('train');
    assert.equal(rows.length, 0, 'alert should be resolved');
    // Re-read directly since listUnresolvedAlerts filters resolved rows out.
    const { getAlertPost } = history;
    const row = getAlertPost('a1');
    assert.equal(
      row.resolved_ts,
      firstMissTs,
      'resolved_ts should match first miss, not threshold tick',
    );
    assert.equal(row.pending_resolved_ts, null, 'pending should be cleared after resolve');
  } finally {
    cleanup();
  }
});

test('resetAlertClearTicks clears pending_resolved_ts so next clear run gets its own first-tick stamp', () => {
  const { history, cleanup } = loadHistoryWithDb(freshDbPath());
  try {
    history.recordAlertSeen({
      alertId: 'a1',
      kind: 'train',
      routes: 'red',
      headline: 'h',
      postUri: 'at://x/y/z',
    });
    history.incrementAlertClearTicks('a1', 1000);
    history.resetAlertClearTicks('a1');
    const { getAlertPost } = history;
    assert.equal(getAlertPost('a1').pending_resolved_ts, null);
    history.incrementAlertClearTicks('a1', 5000);
    assert.equal(getAlertPost('a1').pending_resolved_ts, 5000);
  } finally {
    cleanup();
  }
});
