#!/bin/bash
# teamshare-backup.sh — back up /var/lib/teamshare/teamshare.db to S3.
#
# THIS IS THE SINGLE SOURCE OF TRUTH for the backup logic. This exact file is:
#
#   1. Embedded verbatim into deploy/aws/user_data.sh.tpl at instance boot,
#      via a base64-encoded Terraform template variable (backup_script_b64 in
#      ec2.tf) — never through templatefile() string interpolation, so this
#      script's own `$`/`{}` usage can never collide with Terraform's, and
#      the copy that ends up on a freshly-built box is byte-for-byte this
#      file.
#   2. Deliverable, unmodified, to the already-running instance via SSM
#      without touching user_data at all — see deploy/aws/README.md for the
#      exact `aws ssm send-command` invocation.
#
# Because both paths ship the same bytes, there is nothing to keep in sync by
# hand. Do not inline a copy of this logic anywhere else.
#
# It is intentionally self-contained and takes no Terraform-templated values:
# the destination bucket is derived at runtime from this instance's own AWS
# account ID (via IMDSv2), using the same "teamshare-backups-<account-id>"
# convention that deploy/aws/backup.tf uses when it creates the bucket. One
# naming rule, two independent derivations of it, so they cannot drift apart.
#
# Never logs or echoes the database contents or the team token — only paths,
# the bucket/key, and pass/fail status.

set -euo pipefail

DB_PATH="/var/lib/teamshare/teamshare.db"
TMP_BACKUP="$(mktemp --suffix=.db /tmp/teamshare-backup.XXXXXX)"

cleanup() {
  rm -f "$TMP_BACKUP"
}
trap cleanup EXIT

log() {
  echo "teamshare-backup: $*"
}

fail() {
  log "ERROR: $*"
  exit 1
}

log "starting backup at $(date -u +%Y-%m-%dT%H:%M:%SZ)"

[ -f "$DB_PATH" ] || fail "database not found at $DB_PATH"

# --- Dependencies -----------------------------------------------------------
if ! command -v sqlite3 >/dev/null 2>&1; then
  log "sqlite3 not found; installing (dnf install -y sqlite)"
  dnf install -y sqlite || fail "failed to install sqlite (sqlite3 CLI)"
fi

command -v aws >/dev/null 2>&1 || fail "aws CLI not found on this instance (expected preinstalled on Amazon Linux 2023)"
command -v python3 >/dev/null 2>&1 || fail "python3 not found on this instance (needed to parse the IMDS identity document)"

# --- Derive this account's backup bucket, via IMDSv2 ------------------------
IMDS_TOKEN=$(curl -fsS -X PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 300") || fail "could not obtain an IMDSv2 token"

IDENTITY_DOC=$(curl -fsS -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" \
  "http://169.254.169.254/latest/dynamic/instance-identity/document") || fail "could not fetch the instance identity document"

ACCOUNT_ID=$(printf '%s' "$IDENTITY_DOC" | python3 -c 'import json,sys; print(json.load(sys.stdin)["accountId"])') || fail "could not parse account ID from identity document"
REGION=$(printf '%s' "$IDENTITY_DOC" | python3 -c 'import json,sys; print(json.load(sys.stdin)["region"])') || fail "could not parse region from identity document"

[ -n "$ACCOUNT_ID" ] || fail "empty account ID"
[ -n "$REGION" ] || fail "empty region"

BUCKET="teamshare-backups-${ACCOUNT_ID}"

# --- Online backup, never a raw file copy -----------------------------------
# The server holds the database open in WAL mode. A plain `cp` can grab a
# torn, inconsistent snapshot mid-write. SQLite's own `.backup` command uses
# the online backup API, which is safe to run against a live writer.
log "running sqlite3 online backup: $DB_PATH -> $TMP_BACKUP"
sqlite3 "$DB_PATH" ".backup '$TMP_BACKUP'" || fail "sqlite3 .backup failed"

# --- Verify before trusting it -----------------------------------------------
# An unverified backup looks like protection and isn't. Confirm the copy is
# actually a sound SQLite database before it goes anywhere.
INTEGRITY=$(sqlite3 "$TMP_BACKUP" "PRAGMA integrity_check;") || fail "PRAGMA integrity_check query failed"
if [ "$INTEGRITY" != "ok" ]; then
  fail "integrity check failed: $INTEGRITY"
fi
log "integrity check passed"

# --- Upload with a timestamped key ------------------------------------------
TS_DATE=$(date -u +%Y/%m/%d)
TS_FULL=$(date -u +%Y%m%dT%H%M%SZ)
KEY="teamshare/${TS_DATE}/teamshare-${TS_FULL}.db"

log "uploading to s3://${BUCKET}/${KEY}"
aws s3 cp "$TMP_BACKUP" "s3://${BUCKET}/${KEY}" --region "$REGION" --only-show-errors \
  || fail "upload to s3://${BUCKET}/${KEY} failed"

log "backup complete: s3://${BUCKET}/${KEY}"
