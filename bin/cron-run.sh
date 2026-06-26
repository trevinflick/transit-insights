#!/bin/bash
# Usage: cron-run.sh <log-name> <script> [args...]
# Runs `node <script> <args...>` from the repo root, appending stamped output
# to cron/<log-name>-cron.log. Exists so crontab entries don't each repeat the
# cd/printf/redirect boilerplate.
set -e
cd "$(dirname "$0")/.."
NAME=$1
SCRIPT=$2
shift 2
LOG=cron/$NAME-cron.log
printf "\n\n=== $(date) $NAME ===\n" >> "$LOG"

# Resolve node's absolute path — cron runs with a minimal PATH that won't
# include Homebrew's bin dirs, so a bare `node` call fails silently under
# cron even when it works fine in an interactive shell. Checks the common
# install locations across platforms (Linux package managers put it at
# /usr/bin, Homebrew on Apple Silicon at /opt/homebrew, Intel Homebrew at
# /usr/local) plus whatever PATH resolves to when this script is run
# interactively, with NODE_BIN as an escape hatch for anything unusual.
if [ -z "${NODE_BIN:-}" ]; then
  for candidate in /usr/bin/node /opt/homebrew/bin/node /usr/local/bin/node "$(command -v node 2>/dev/null)"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      NODE_BIN="$candidate"
      break
    fi
  done
fi
if [ -z "${NODE_BIN:-}" ]; then
  echo "cron-run.sh: could not find a node binary (checked /usr/bin, /opt/homebrew/bin, /usr/local/bin, PATH) — set NODE_BIN explicitly" >> "$LOG"
  exit 1
fi

# healthchecks.io monitoring (optional). Only the slugs in HC_MONITORED ping
# (and thus auto-create a check); the curated set is the committed source of
# truth for "what's watched" — edit it here and `git pull` on the server to
# widen/narrow coverage. Jobs not listed simply don't ping. No-op entirely
# unless cron/healthchecks.env exists (see the .example). Single-agency
# bus-only roster (11 jobs) — comfortably under the 20-check free tier, so
# everything except the low-stakes weekly/monthly recap is watched.
HC_MONITORED="observe-buses bus-cross-bunching bus-bunching bus-gaps bus-thin-gaps bus-ghosts bus-speedmap bus-fleet-rollup bus-alerts fetch-gtfs audit-alerts"
[ -f cron/healthchecks.env ] && . cron/healthchecks.env
case " $HC_MONITORED " in *" $NAME "*) hc_watched=1 ;; *) hc_watched= ;; esac

# $1 = endpoint suffix: "start" before the run, the exit code after. healthchecks
# measures run duration as the gap between the start and completion pings, and
# treats a non-zero exit code as failure (so a job that ran but crashed alerts
# too). -m caps curl so a hung ping never wedges the cron slot; pings are never
# fatal to the job. ?create=1 auto-creates the check on first ping (no-op once it
# exists; see cron/healthchecks.env.example for tuning the auto-created defaults).
hc_ping() {
  [ -n "$HC_PING_KEY" ] && [ -n "$hc_watched" ] || return 0
  curl -fsS -m 10 --retry 2 -X POST \
    "${HC_PING_URL:-https://hc-ping.com}/$HC_PING_KEY/$NAME/$1?create=1" >/dev/null 2>&1 || true
}

# Signal start so healthchecks can time the run, then relax -e so a non-zero exit
# still sends the completion ping instead of aborting the wrapper before it.
hc_ping start
set +e
"$NODE_BIN" "$SCRIPT" "$@" >> "$LOG" 2>&1
rc=$?
hc_ping "$rc"

exit $rc
