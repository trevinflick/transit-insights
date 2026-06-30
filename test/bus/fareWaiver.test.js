const test = require('node:test');
const assert = require('node:assert/strict');
const { isFareWaiverAlert, buildFareWaiverPostText } = require('../../src/bus/fareWaiver');

// --- isFareWaiverAlert: text-pattern gate, not effect/cause-based --------
// Real COTA fare-waiver headlines (collected from news coverage, since
// nothing has appeared in the live feed yet) all pair the word "fare(s)"
// with a waiver verb: "COTA waives fares," "no fares," "fare-free,"
// "suspending fares."

test('isFareWaiverAlert: "COTA waives fares" phrasing matches', () => {
  const alert = {
    headerText: 'COTA waives fares due to extreme heat advisory.',
    descriptionText: 'Fares are free for the remainder of today.',
  };
  assert.equal(isFareWaiverAlert(alert), true);
});

test('isFareWaiverAlert: "no fares" phrasing matches', () => {
  const alert = {
    headerText: 'No fares Thursday due to heat advisory',
    descriptionText: null,
  };
  assert.equal(isFareWaiverAlert(alert), true);
});

test('isFareWaiverAlert: "suspending fares" phrasing matches', () => {
  const alert = {
    headerText: null,
    descriptionText: 'COTA is suspending fares on all routes due to a cold weather warning.',
  };
  assert.equal(isFareWaiverAlert(alert), true);
});

test('isFareWaiverAlert: a real live DETOUR/reroute alert (no fare mention) does not match', () => {
  const alert = {
    headerText: 'Reroute on Line 007 NORTHEAST',
    descriptionText:
      'Rerouted from N HAMILTON RD & E 5TH AVE to JOHN GLENN INTERNATIONAL AIRPORT BAGGAGE CLAIM.',
  };
  assert.equal(isFareWaiverAlert(alert), false);
});

test('isFareWaiverAlert: a real live cancelled-stops alert (no fare mention) does not match', () => {
  const alert = {
    headerText: 'Cancelled stops on Route 008 NORTH, SOUTH.',
    descriptionText:
      'Cancelled stops on Route 008 NORTH, SOUTH Block 0809 between A at 5:57 AM and B at 1:03 PM.',
  };
  assert.equal(isFareWaiverAlert(alert), false);
});

test('isFareWaiverAlert: "fare" mentioned without any waiver verb does not match', () => {
  const alert = {
    headerText: 'Fare payment kiosk at High St & Broad St temporarily out of service.',
    descriptionText: null,
  };
  assert.equal(isFareWaiverAlert(alert), false);
});

test('isFareWaiverAlert: missing text entirely does not match', () => {
  assert.equal(isFareWaiverAlert({ headerText: null, descriptionText: null }), false);
});

// --- buildFareWaiverPostText ---------------------------------------------

test("buildFareWaiverPostText: tags and passes through COTA's own header/description", () => {
  const alert = {
    headerText: 'COTA waives fares due to extreme heat advisory.',
    descriptionText: 'Free rides through the end of the day on all fixed routes.',
  };
  const text = buildFareWaiverPostText(alert);
  assert.equal(
    text,
    '🌡 Free fares — extreme weather alert\n' +
      'COTA waives fares due to extreme heat advisory.\n' +
      'Free rides through the end of the day on all fixed routes.',
  );
});

test('buildFareWaiverPostText: missing descriptionText omits the second line cleanly', () => {
  const alert = { headerText: 'No fares today due to extreme heat.', descriptionText: null };
  const text = buildFareWaiverPostText(alert);
  assert.equal(text, '🌡 Free fares — extreme weather alert\nNo fares today due to extreme heat.');
});

test("buildFareWaiverPostText: a 'cold' mention (no 'heat') uses the frozen-face emoji", () => {
  const alert = {
    headerText: 'No fares today due to a cold weather advisory.',
    descriptionText: null,
  };
  const text = buildFareWaiverPostText(alert);
  assert.match(text, /^🥶 Free fares/);
});

test("buildFareWaiverPostText: a 'heat' mention uses the thermometer, even if 'cold' also appears", () => {
  const alert = {
    headerText: 'No fares today due to extreme heat.',
    descriptionText: 'Stay cool, the cold drinks are on us too.',
  };
  const text = buildFareWaiverPostText(alert);
  assert.match(text, /^🌡 Free fares/);
});

test('buildFareWaiverPostText: no heat/cold mention at all defaults to the thermometer', () => {
  const alert = { headerText: 'COTA waives fares systemwide today.', descriptionText: null };
  const text = buildFareWaiverPostText(alert);
  assert.match(text, /^🌡 Free fares/);
});

test('buildFareWaiverPostText: stays under the post limit, truncating an oversized body', () => {
  const alert = {
    headerText: 'No fares today.',
    descriptionText: 'x'.repeat(400),
  };
  const text = buildFareWaiverPostText(alert);
  const { graphemeLength, POST_MAX_CHARS } = require('../../src/shared/post');
  assert.ok(graphemeLength(text) <= POST_MAX_CHARS);
  assert.match(text, /…$/);
});
