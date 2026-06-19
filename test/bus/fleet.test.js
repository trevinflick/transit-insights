const test = require('node:test');
const assert = require('node:assert/strict');
const { isArticulated } = require('../../src/bus/fleet');

// COTA's articulated-bus vid ranges aren't catalogued yet (data/artics.json
// is empty) — isArticulated should fall back to false for everything until
// real fleet data is added.
test('isArticulated: returns false for any vid while no ranges are catalogued', () => {
  for (const vid of ['4000', '11302', '1000', 8302]) {
    assert.equal(isArticulated(vid), false, `${vid} should not be artic (no ranges loaded)`);
  }
});

test('isArticulated: returns false for unparseable vids', () => {
  assert.equal(isArticulated(null), false);
  assert.equal(isArticulated(undefined), false);
  assert.equal(isArticulated(''), false);
  assert.equal(isArticulated('abc'), false);
});
