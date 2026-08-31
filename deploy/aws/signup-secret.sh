#!/usr/bin/env bash
# Print this instance's signup secret to stdout, and nothing else.
#
# The secret gates POST /teams. It was generated on the server's first boot
# (the `signup_secret` Terraform variable was never set), so this SSM path is
# the only way to read it back — see README.md's break-glass section.
#
# Deliberately prints the bare value with no label, so it composes:
#
#   TEAMSHARE_SIGNUP_SECRET=$(./signup-secret.sh) teamshare-team create-team "My Team"
#
# used that way the secret never appears on screen, in shell history, or in
# `ps` output — the same rule every other credential in this project follows.
set -euo pipefail

INSTANCE_ID="${TEAMSHARE_INSTANCE_ID:-i-06218a66d9378d97b}"
REGION="${AWS_REGION:-us-east-1}"

command -v aws >/dev/null || { echo "aws CLI not found" >&2; exit 1; }
aws sts get-caller-identity >/dev/null 2>&1 || {
  echo "No usable AWS credentials. Export them, or source the account's .env, then retry." >&2
  exit 1
}

command_id=$(aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --region "$REGION" \
  --document-name AWS-RunShellScript \
  --comment "read teamshare signup secret" \
  --parameters 'commands=["/usr/local/bin/node /opt/teamshare/packages/server/dist/cli.js signup-secret --show --db /var/lib/teamshare/teamshare.db"]' \
  --query 'Command.CommandId' --output text)

# Poll rather than sleep a fixed amount: SSM takes a variable second or three
# to dispatch, and a short fixed sleep returns an empty string that looks
# exactly like "there is no secret".
for _ in $(seq 1 30); do
  status=$(aws ssm get-command-invocation --command-id "$command_id" \
    --instance-id "$INSTANCE_ID" --region "$REGION" \
    --query 'Status' --output text 2>/dev/null || echo Pending)
  case "$status" in
    Success) break ;;
    Failed|TimedOut|Cancelled)
      echo "SSM command $status" >&2
      aws ssm get-command-invocation --command-id "$command_id" --instance-id "$INSTANCE_ID" \
        --region "$REGION" --query 'StandardErrorContent' --output text >&2
      exit 1 ;;
  esac
  sleep 2
done

secret=$(aws ssm get-command-invocation --command-id "$command_id" \
  --instance-id "$INSTANCE_ID" --region "$REGION" \
  --query 'StandardOutputContent' --output text | tr -d '\r\n')

[ -n "$secret" ] || { echo "empty secret returned — is teamshare running on $INSTANCE_ID?" >&2; exit 1; }
printf '%s\n' "$secret"
