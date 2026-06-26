function formatDistance(ft) {
  if (ft < 1000) return `${Math.round(ft)} ft`;
  return `${(ft / 5280).toFixed(2)} mi`;
}

function formatMinutes(m) {
  return `${Math.round(m)} min`;
}

function formatMinSec(totalSec) {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function elapsedMinutesLabel(totalSec) {
  const m = Math.max(1, Math.round(totalSec / 60));
  return m === 1 ? '1 minute' : `${m} minutes`;
}

// Render a positive integer as keycap-emoji digits (1 → 1️⃣, 13 → 1️⃣3️⃣) so a
// bus's map-disc position reads as a distinct tag, not just another number next
// to its vehicle id and late/early minutes.
function keycapNumber(n) {
  return String(n)
    .split('')
    .map((d) => (d >= '0' && d <= '9' ? `${d}️⃣` : d))
    .join('');
}

// Schedule adherence as plain words, no +/- signs (the signs read ambiguously).
// Positive minutes = behind schedule (late), negative = ahead (early). Rounds to
// the minute; anything that rounds to 0 reads "on time". Returns null for a null/
// non-finite input so callers can simply omit the annotation.
function formatDeviation(min) {
  if (min == null || !Number.isFinite(min)) return null;
  const r = Math.round(min);
  if (r === 0) return 'on time';
  return r > 0 ? `${r} min late` : `${-r} min early`;
}

function formatTimeET(date) {
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/New_York',
  });
}

// GTFS trip start_time/stop_times.txt times are agency-local wall clock
// already (COTA = Eastern) — no timezone math needed, unlike formatTimeET
// above which converts a UTC instant. Just reformat "HH:MM:SS" (may exceed
// 24h for an owl trip) to "5:57 AM" for display. Returns the input as-is if
// it doesn't parse, rather than throwing on a malformed feed value.
function formatGtfsTimeOfDay(hhmmss) {
  const parts = String(hhmmss)
    .split(':')
    .map((x) => parseInt(x, 10));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return hhmmss;
  const h = parts[0] % 24;
  const m = parts[1];
  const period = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

module.exports = {
  formatDistance,
  formatMinutes,
  formatMinSec,
  elapsedMinutesLabel,
  formatDeviation,
  keycapNumber,
  formatTimeET,
  formatGtfsTimeOfDay,
};
