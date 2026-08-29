#!/bin/bash
# Templated by Terraform (ec2.tf) — every dollar-brace placeholder below is
# substituted by `templatefile()` before this ever reaches the instance, not
# by bash.
set -euxo pipefail

exec > >(tee -a /var/log/teamshare-bootstrap.log) 2>&1
echo "=== teamshare bootstrap starting $(date -u) ==="

# ---------------------------------------------------------------------------
# 1. Build prerequisites for the better-sqlite3 native module.
# ---------------------------------------------------------------------------
dnf install -y gcc-c++ make python3 git tar

# ---------------------------------------------------------------------------
# 2. Node 20, pinned, from the official tarball. Deliberately NOT
#    `dnf install nodejs` — the distro package drifts and does not guarantee
#    the >= 20 the app requires.
# ---------------------------------------------------------------------------
mkdir -p /opt/node
curl -fsSL "https://nodejs.org/dist/v${node_version}/node-v${node_version}-linux-arm64.tar.xz" -o /tmp/node.tar.xz
tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1
rm -f /tmp/node.tar.xz

for bin in node npm npx corepack; do
  ln -sf "/opt/node/bin/$bin" "/usr/local/bin/$bin"
done

# ---------------------------------------------------------------------------
# 3. pnpm via corepack, pinned to match this repo's pnpm-lock.yaml
#    (lockfileVersion 9.0). --install-directory makes the shim location
#    explicit rather than depending on corepack's default placement logic.
# ---------------------------------------------------------------------------
/usr/local/bin/corepack enable --install-directory=/usr/local/bin
/usr/local/bin/corepack prepare "pnpm@${pnpm_version}" --activate

# ---------------------------------------------------------------------------
# 4. Clone and build teamshare.
# ---------------------------------------------------------------------------
rm -rf /opt/teamshare
git clone --depth 1 "${repo_url}" /opt/teamshare
cd /opt/teamshare
/usr/local/bin/pnpm install --frozen-lockfile
/usr/local/bin/pnpm --filter teamshare-server build

# ---------------------------------------------------------------------------
# 5. Dedicated unprivileged system user + database directory. The database is
#    the entire team's shared memory — see deploy/aws/README.md for backups.
# ---------------------------------------------------------------------------
id -u teamshare >/dev/null 2>&1 || useradd --system --no-create-home --shell /sbin/nologin teamshare
mkdir -p /var/lib/teamshare
chown -R teamshare:teamshare /var/lib/teamshare
chmod 750 /var/lib/teamshare

# ---------------------------------------------------------------------------
# 6. Caddy: pinned official release binary, no third-party dnf repo.
# ---------------------------------------------------------------------------
curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v${caddy_version}/caddy_${caddy_version}_linux_arm64.tar.gz" -o /tmp/caddy.tar.gz
tar -xzf /tmp/caddy.tar.gz -C /tmp caddy
install -m 0755 /tmp/caddy /usr/local/bin/caddy
rm -f /tmp/caddy.tar.gz /tmp/caddy
# Belt-and-suspenders alongside the unit's AmbientCapabilities below; harmless
# if libcap's setcap isn't present on the image.
setcap 'cap_net_bind_service=+ep' /usr/local/bin/caddy || true

id -u caddy >/dev/null 2>&1 || useradd --system --no-create-home --shell /sbin/nologin caddy
mkdir -p /etc/caddy /var/lib/caddy /var/log/caddy
chown -R caddy:caddy /var/lib/caddy /var/log/caddy

# The TLS hostname is derived from this instance's own public IPv4, discovered
# at boot via IMDSv2. It is done here rather than templated in by Terraform
# because this account is at its Elastic IP quota (all addresses are in use by
# other p3m infrastructure), so there is no address known ahead of time.
#
# Consequence worth knowing: the public IP — and therefore this URL — changes
# if the instance is ever STOPPED and started again (a reboot keeps it). If
# that happens, teammates must reconnect against the new URL. See the README.
IMDS_TOKEN=$(curl -fsS -X PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 300" || true)
PUBLIC_IP=$(curl -fsS -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" \
  "http://169.254.169.254/latest/meta-data/public-ipv4" || true)

if [ -z "$PUBLIC_IP" ]; then
  echo "FATAL: could not determine this instance's public IPv4 from IMDS;" >&2
  echo "Caddy has no hostname to request a certificate for." >&2
  exit 1
fi

TEAMSHARE_HOSTNAME="$${PUBLIC_IP}.sslip.io"
echo "teamshare hostname: $TEAMSHARE_HOSTNAME" > /etc/teamshare-hostname

cat > /etc/caddy/Caddyfile <<CADDYFILE
$${TEAMSHARE_HOSTNAME} {
    reverse_proxy 127.0.0.1:8787
}
CADDYFILE

# ---------------------------------------------------------------------------
# 7. systemd units. Both Restart=always and enabled at boot, so the whole
#    stack comes back on its own after a reboot or a crash.
# ---------------------------------------------------------------------------
cat > /etc/systemd/system/teamshare.service <<'UNIT'
[Unit]
Description=teamshare MCP server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=teamshare
Group=teamshare
WorkingDirectory=/opt/teamshare
ExecStart=/usr/local/bin/node /opt/teamshare/packages/server/dist/cli.js serve --port 8787 --host 127.0.0.1 --db /var/lib/teamshare/teamshare.db
Restart=always
RestartSec=3
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT
# NOTE on binding: `--host 127.0.0.1` is passed explicitly above (it's also
# the CLI's default) so the process only ever accepts loopback connections —
# Caddy reaches it over 127.0.0.1, and it is never reachable from another
# interface even if the security group below were ever loosened. Being
# explicit here documents that intent at the place an operator will read it.

cat > /etc/systemd/system/caddy.service <<'UNIT'
[Unit]
Description=Caddy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=caddy
Group=caddy
# The caddy user is created with --no-create-home, so /home/caddy does not
# exist. Without these, Caddy falls back to $HOME/.local/share/caddy for its
# certificate storage, fails with "mkdir /home/caddy: permission denied", and
# never even attempts ACME issuance — the server then answers TLS handshakes
# with an internal error and looks, misleadingly, like a network problem.
# /var/lib/caddy is created and chowned to this user above.
Environment=HOME=/var/lib/caddy
Environment=XDG_DATA_HOME=/var/lib/caddy
Environment=XDG_CONFIG_HOME=/var/lib/caddy
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
Restart=always
RestartSec=3
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now teamshare.service
systemctl enable --now caddy.service

echo "=== teamshare bootstrap finished $(date -u) ==="
