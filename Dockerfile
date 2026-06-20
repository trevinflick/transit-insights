# Single-container deployment: the app + its cron schedule both live here, so
# `docker compose up -d` alone fully activates scheduling — no host crontab
# needed. See AGENTS.md and cron/crontab.txt for what runs when.
FROM node:22-bookworm-slim

# cron drives the schedule; curl is used by bin/cron-run.sh for healthchecks.io
# pings; sqlite3 is the CLI used by scripts/backup-db.sh (kept for parity even
# though off-box backups aren't wired up yet — see docs/BACKUPS.md); unzip is
# shelled out to by scripts/fetch-gtfs.js to read COTA's GTFS zip (present on
# macOS by default, so this was invisible until building for Linux).
RUN apt-get update && apt-get install -y --no-install-recommends \
    cron curl sqlite3 unzip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
# package.json's "prepare" script installs husky's git hooks via the husky
# CLI, which isn't present here (devDependency, omitted in a prod install,
# and there's no .git in the image anyway) — drop just that script so `npm ci`
# doesn't fail on it. Other packages' own install/postinstall scripts (e.g.
# better-sqlite3's prebuilt-binary fetch) are untouched.
RUN npm pkg delete scripts.prepare && npm ci --omit=dev

COPY . .

# state/ and data/ are gitignored (runtime DB + GTFS cache) — create them so
# the bind-mounted volumes in docker-compose.yml have somewhere to land even
# before the first run populates them.
RUN mkdir -p /app/state /app/data/gtfs /app/data/patterns

# Bake the cron schedule into root's crontab, substituting the placeholder
# repo path for this image's checkout — mirrors what scripts/install-crontab.sh
# does for a host crontab, just targeting the image instead.
RUN sed 's#/path/to/cota-insights#/app#g' cron/crontab.txt | crontab -

CMD ["cron", "-f"]
