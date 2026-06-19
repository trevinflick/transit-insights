const test = require('node:test');
const assert = require('node:assert');
const { resolveStopOnRoute, normalizeStopName } = require('../../src/bus/patterns');

const PATTERN_A = {
  points: [
    { type: 'W', lat: 0, lon: 0 },
    { type: 'S', stopName: 'Archer & Nottingham', pdist: 1234 },
    { type: 'S', stopName: 'Archer & Pulaski', pdist: 2500 },
  ],
};
const PATTERN_B = {
  points: [{ type: 'S', stopName: 'Broad & High', pdist: 500 }],
};
const PATTERNS = { a: PATTERN_A, b: PATTERN_B };
const loadPattern = async (pid) => PATTERNS[pid];

test('normalizeStopName lowercases + collapses whitespace', () => {
  assert.equal(normalizeStopName('Archer & Nottingham'), 'archer & nottingham');
  assert.equal(normalizeStopName('  Belmont,  Halsted  '), 'belmont halsted');
});

test('resolveStopOnRoute: exact match resolves', async () => {
  const hit = await resolveStopOnRoute({
    pids: ['a'],
    loadPattern,
    stopName: 'Archer & Nottingham',
  });
  assert.ok(hit, 'expected match');
  assert.equal(hit.pid, 'a');
  assert.equal(hit.stopName, 'Archer & Nottingham');
  assert.equal(typeof hit.pdist, 'number');
  assert.ok(hit.pdist > 0);
});

test('resolveStopOnRoute: junction "/" form matches "&" stop name', async () => {
  // Headlines often write "Archer/Nottingham"; pattern has "& "
  const hit = await resolveStopOnRoute({
    pids: ['a'],
    loadPattern,
    stopName: 'Archer/Nottingham',
  });
  assert.ok(hit, 'expected junction-canonicalized match');
  assert.equal(hit.stopName, 'Archer & Nottingham');
});

test('resolveStopOnRoute: unknown stop returns null', async () => {
  const hit = await resolveStopOnRoute({
    pids: ['a'],
    loadPattern,
    stopName: 'Nonexistent & Foo',
  });
  assert.equal(hit, null);
});

test('resolveStopOnRoute: tries multiple pids and returns first match', async () => {
  const hit = await resolveStopOnRoute({
    pids: ['b', 'a'],
    loadPattern,
    stopName: 'Archer & Nottingham',
  });
  assert.ok(hit);
  assert.equal(hit.pid, 'a');
});

test('resolveStopOnRoute: empty inputs return null', async () => {
  assert.equal(await resolveStopOnRoute({ pids: [], loadPattern, stopName: 'X' }), null);
  assert.equal(await resolveStopOnRoute({ pids: ['a'], loadPattern, stopName: '' }), null);
});

test('resolveStopOnRoute: works with mock loadPattern (no fs)', async () => {
  const mockPattern = {
    points: [
      { type: 'W', lat: 0, lon: 0 },
      { type: 'S', stopName: 'Belmont & Halsted', pdist: 1234 },
      { type: 'S', stopName: 'Belmont & Sheffield', pdist: 2500 },
    ],
  };
  const mockLoad = async (_pid) => mockPattern;
  const hit = await resolveStopOnRoute({
    pids: ['fakepid'],
    loadPattern: mockLoad,
    stopName: 'Belmont/Halsted',
  });
  assert.deepEqual(hit, { pid: 'fakepid', pdist: 1234, stopName: 'Belmont & Halsted' });
});
