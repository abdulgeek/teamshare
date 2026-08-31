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

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"

if [ -n "${TEAMSHARE_INSTANCE_ID:-}" ]; then
  INSTANCE_ID="$TEAMSHARE_INSTANCE_ID"
elif command -v terraform >/dev/null && [ -f "$SCRIPT_DIR/terraform.tfstate" ]; then
  INSTANCE_ID=$(terraform -chdir="$SCRIPT_DIR" output -raw instance_id)
else
  echo "Set TEAMSHARE_INSTANCE_ID, or run this next to local terraform state (deploy/aws/terraform.tfstate)." >&2
  echo "This script does not ship a production instance id." >&2
  exit 1
fi

[ -n "$INSTANCE_ID" ] || { echo "empty instance id" >&2; exit 1; }

region_args=()
if [ -n "$REGION" ]; then
  region_args=(--region "$REGION")
fi

command -v aws >/dev/null || { echo "aws CLI not found" >&2; exit 1; }
aws sts get-caller-identity >/dev/null 2>&1 || {
  echo "No usable AWS credentials. Export them, or source the account's .env, then retry." >&2
  exit 1
}

command_id=$(aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  ${region_args[@]+"${region_args[@]}"} \
  --document-name AWS-RunShellScript \
  --comment "read teamshare signup secret" \
  --parameters 'commands=["/usr/local/bin/node /opt/teamshare/packages/server/dist/cli.js signup-secret --show --db /var/lib/teamshare/teamshare.db"]' \
  --query 'Command.CommandId' --output text)

# Poll rather than sleep a fixed amount: SSM takes a variable second or three
# to dispatch, and a short fixed sleep returns an empty string that looks
# exactly like "there is no secret".
for _ in $(seq 1 30); do
  status=$(aws ssm get-command-invocation --command-id "$command_id" \
    --instance-id "$INSTANCE_ID" ${region_args[@]+"${region_args[@]}"} \
    --query 'Status' --output text 2>/dev/null || echo Pending)
  case "$status" in
    Success) break ;;
    Failed|TimedOut|Cancelled)
      echo "SSM command $status" >&2
      aws ssm get-command-invocation --command-id "$command_id" --instance-id "$INSTANCE_ID" \
        ${region_args[@]+"${region_args[@]}"} --query 'StandardErrorContent' --output text >&2
      exit 1 ;;
  esac
  sleep 2
done

secret=$(aws ssm get-command-invocation --command-id "$command_id" \
  --instance-id "$INSTANCE_ID" ${region_args[@]+"${region_args[@]}"} \
  --query 'StandardOutputContent' --output text | tr -d '\r\n')

[ -n "$secret" ] || { echo "empty secret returned — is teamshare running on $INSTANCE_ID?" >&2; exit 1; }
printf '%s\n' "$secret"
