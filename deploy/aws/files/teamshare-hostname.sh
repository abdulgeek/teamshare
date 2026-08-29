#!/bin/bash
# teamshare-hostname.sh — point Caddy at this instance's CURRENT public IP.
#
# THIS IS THE SINGLE SOURCE OF TRUTH for hostname regeneration. Like
# teamshare-backup.sh, this exact file is embedded verbatim into
# user_data.sh.tpl (base64, so Terraform's ${...} templating can never collide
# with this script's own shell syntax) and can be delivered unchanged to a
# running instance over SSM.
#
# WHY THIS EXISTS
#
# The TLS hostname is <public-ip>.sslip.io, derived from the instance's own
# address. cloud-init runs user_data as `scripts-per-once`, so the bootstrap
# that originally wrote the Caddyfile never runs again. A REBOOT keeps the
# public IP and is harmless, but a STOP/START assigns a new one — and without
# this unit the Caddyfile would still name the old address. Caddy would then
# serve (and try to renew) a certificate for a hostname that no longer
# resolves to this box, leaving teamshare completely unreachable rather than
# merely relocated. That is a silent outage that would only surface the next
# time someone opened a session.
#
# Running this on every boot, before Caddy starts, makes the server heal
# itself: after a stop/start it comes back on the new <ip>.sslip.io with a
# freshly issued certificate. Clients still hold the old URL and must
# reconnect (an Elastic IP is the fix for that half — see eip.tf), but the
# server itself is never left broken.

set -euo pipefail

CADDYFILE="/etc/caddy/Caddyfile"

IMDS_TOKEN=$(curl -fsS -X PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
PUBLIC_IP=$(curl -fsS -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" \
  "http://169.254.169.254/latest/meta-data/public-ipv4")

if [ -z "$PUBLIC_IP" ]; then
  echo "teamshare-hostname: FATAL: IMDS returned no public IPv4" >&2
  exit 1
fi

HOSTNAME_NEW="${PUBLIC_IP}.sslip.io"
HOSTNAME_OLD=$(awk 'NR==1{print $1}' "$CADDYFILE" 2>/dev/null || true)

if [ "$HOSTNAME_OLD" = "$HOSTNAME_NEW" ]; then
  echo "teamshare-hostname: unchanged ($HOSTNAME_NEW)"
  exit 0
fi

printf '%s {\n    reverse_proxy 127.0.0.1:8787\n}\n' "$HOSTNAME_NEW" > "$CADDYFILE"
echo "teamshare-hostname: updated ${HOSTNAME_OLD:-<none>} -> $HOSTNAME_NEW"
echo "teamshare-hostname: clients configured against the old URL must reconnect"

# Only reload if Caddy is already up — on boot this unit runs *before* Caddy,
# which then simply starts with the corrected file.
if systemctl is-active --quiet caddy; then
  systemctl reload caddy || systemctl restart caddy
  echo "teamshare-hostname: caddy reloaded"
fi
