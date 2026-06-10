const shared = require('../shared/bluesky');

// Metra runs two accounts, mirroring the CTA split (analytics vs alerts):
//   loginMetra       — analytics bot (speedmap, recap). Sibling of loginTrain.
//   loginMetraAlerts — disruptions/alerts (cancellations, delays, republished
//                      GTFS-rt alerts). Sibling of loginAlerts, but Metra-only so
//                      its thread space stays self-contained rather than mixing
//                      into the shared CTA alerts account.
function loginMetra() {
  return shared.login(process.env.BLUESKY_METRA_IDENTIFIER, process.env.BLUESKY_METRA_APP_PASSWORD);
}

function loginMetraAlerts() {
  return shared.login(
    process.env.BLUESKY_METRA_ALERTS_IDENTIFIER,
    process.env.BLUESKY_METRA_ALERTS_APP_PASSWORD,
  );
}

module.exports = { loginMetra, loginMetraAlerts, ...shared };
