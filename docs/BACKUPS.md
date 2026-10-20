# Database backups

The history DB (`state/history.sqlite`, ~140 MB as of Oct 2026 and growing) is
the one piece of irreplaceable state on the server — it can't be rebuilt from
the code or the COTA feeds. It's backed up off-box to **Cloudflare R2** daily.

- `scripts/backup-db.sh` — snapshot → integrity-check → gzip → upload to R2.
- `scripts/restore-db.sh` — pull a snapshot back down and verify it.

Both run **inside the container** (`docker exec transit-insights …`); the
image ships `sqlite3` and `rclone`. The newest 7 snapshots are also kept in
`tmp/db-backups/`, which is bind-mounted so they survive rebuilds. A failed
upload exits non-zero and pings the `db-backup` healthchecks.io check (when
`cron/healthchecks.env` exists), so it alerts instead of failing silently.

> History: until Oct 2026 rclone wasn't in the image and no rclone config
> existed, so every upload failed (logged only to `cron/backup-db-cron.log`).
> The 43 local snapshots that piled up (Sep 8 – Oct 20, 2026) were copied to
> `state/db-backups/` on the server and seeded the permanent fleet tables —
> see `docs/FLEET.md`.

The snapshot is taken with SQLite's online `.backup`, which is WAL-safe and
does not block the bots mid-write. A raw `cp` of the `.sqlite` file is **not**
safe — it can capture a torn state while the `-wal` file holds uncommitted
writes.

## One-time setup (on the server)

### 1. rclone

Already in the image (Dockerfile). Its config lives in `rclone/` at the repo
root on the host (gitignored), bind-mounted to `/root/.config/rclone`.

### 2. Create the R2 bucket + API token (Cloudflare dashboard)

1. **R2 → Create bucket** → name it `cta-insights-db-backups` (the scripts'
   default, inherited from the upstream CTA project; to use another name, set
   `RCLONE_REMOTE=r2:<bucket>` on the cron line in `cron/crontab.txt`).
2. **R2 → Manage R2 API Tokens → Create API Token**:
   - Permission: **Object Read & Write**
   - Scope it to that bucket.
   - Save the **Access Key ID**, **Secret Access Key**, and the
     **S3 endpoint** (`https://<account-id>.r2.cloudflarestorage.com`).

### 3. Configure the `r2` rclone remote

Run this on the server and paste your own credentials — the secret is written
to `rclone/rclone.conf` on the host, never to this repo:

```sh
docker exec transit-insights rclone config create r2 s3 \
  provider=Cloudflare \
  access_key_id=<ACCESS_KEY_ID> \
  secret_access_key=<SECRET_ACCESS_KEY> \
  endpoint=https://<account-id>.r2.cloudflarestorage.com \
  acl=private
```

Verify:

```sh
docker exec transit-insights rclone lsd r2:              # lists the bucket
docker exec transit-insights /app/scripts/backup-db.sh   # first real backup
docker exec transit-insights /app/scripts/restore-db.sh --list
```

### 4. Retention (R2 lifecycle rule)

The backup script keeps 7 local copies; remote retention is handled by an
R2 lifecycle rule rather than scripted deletes (safer — the server can't
accidentally wipe history). In the dashboard: **R2 → cta-insights-db-backups →
Settings → Object lifecycle rules → Add rule → delete objects N days after
creation**.

Each snapshot is ~50 MB gzipped (Oct 2026), so even 30 days (~1.5 GB) fits
comfortably in R2's 10 GB free tier. Also enable **abort incomplete
multipart uploads after 1 day** in the same rule — the server's older rclone
uploads multipart, and a failed part would otherwise linger and accrue
storage.

## Schedule

A daily 04:17 entry is in `cron/crontab.txt` under `--- Backups ---`, baked
into the image's crontab like every other job. It runs off-peak, clear of
`fetch-gtfs` (03:15).

Logs: `cron/backup-db-cron.log`.

## Restoring

```sh
docker exec transit-insights /app/scripts/restore-db.sh --list   # see what's available
docker exec transit-insights /app/scripts/restore-db.sh          # fetch + verify the latest
docker exec transit-insights /app/scripts/restore-db.sh history-YYYYMMDD-HHMMSS.sqlite.gz
```

The restore script never overwrites the live DB on its own — it verifies the
snapshot into `tmp/db-backups/` and prints the manual swap-in steps (stop
writers → copy into place → re-enable cron). Test a restore periodically; an
unverified backup is only a guess.
