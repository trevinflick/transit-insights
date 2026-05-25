const { LINE_NAMES, shortStationName } = require('./api');
const { formatCallouts } = require('../shared/history');
const { formatMinutes, formatDistance, elapsedMinutesLabel } = require('../shared/format');

function buildPostText(gap, callouts = []) {
  const lineName = LINE_NAMES[gap.line];
  const dest = gap.leading.destination;
  const where = shortStationName(gap.nearStation?.name || gap.leading.nextStation);
  const whereClause = where ? ` near ${where}` : '';
  // `leading` is the train already past the gap (last seen); `trailing` is the
  // next one a rider is waiting for. "(last)/(next)" read as ambiguous ("last
  // train" = final train of the night), so spell the rider roles out — the map
  // tags the two discs L/N to match.
  const lastSeen = gap.leading?.rn ? `#${gap.leading.rn}` : null;
  const nextUp = gap.trailing?.rn ? `#${gap.trailing.rn}` : null;
  const runsLine =
    lastSeen || nextUp
      ? `\n\n${[lastSeen && `Last seen: ${lastSeen}`, nextUp && `Next up: ${nextUp}`].filter(Boolean).join(' · ')}`
      : '';
  // Tilde on the modeled gap: it's a distance/speed estimate, not a measured
  // ETA (see docs/GAPS.md). The schedule headway stays bare — it's a lookup.
  const base = `🕳️ ${lineName} Line — to ${dest}\n\n~${formatMinutes(gap.gapMin)} gap${whereClause} — currently scheduled every ${formatMinutes(gap.expectedMin)}${runsLine}`;
  const tail = formatCallouts(callouts);
  return tail ? `${base}\n\n${tail}` : base;
}

function buildAltText(gap) {
  const lineName = LINE_NAMES[gap.line];
  const dest = gap.leading.destination;
  const where = shortStationName(gap.nearStation?.name);
  const whereClause = where ? ` near ${where}` : '';
  return `Map of the ${lineName} Line toward ${dest} showing a ${formatMinutes(gap.gapMin)} gap between trains${whereClause}.`;
}

// Timelapse reply text. The clip follows the next train approaching the wait
// stop, so the headline is its progress toward the platform — the rider's real
// question — not the inter-train span a bunching clip reports.
function buildGapVideoPostText(result) {
  const stop = shortStationName(result.stopName) || 'the stop';
  const elapsed = elapsedMinutesLabel(result.elapsedSec);
  if (result.reached) {
    return `${elapsed} later, the next train reached ${stop}.\n🎬 the wait is over`;
  }
  return `${elapsed} later, the next train had closed to ${formatDistance(result.endDistFt)} from ${stop}.\n🎬 ${formatDistance(result.startDistFt)} → ${formatDistance(result.endDistFt)}`;
}

function buildGapVideoAltText(gap, result) {
  const lineName = LINE_NAMES[gap.line];
  const dest = gap.leading.destination;
  const stop = shortStationName(result.stopName) || 'the stop';
  return `Timelapse map of the ${lineName} Line toward ${dest} showing the next train approaching ${stop} over ${formatMinutes(result.elapsedSec / 60)}.`;
}

module.exports = { buildPostText, buildAltText, buildGapVideoPostText, buildGapVideoAltText };
