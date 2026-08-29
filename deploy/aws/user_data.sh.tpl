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

# The TLS hostname is <public-ip>.sslip.io, derived from this instance's own
# address. That derivation lives in ONE place — files/teamshare-hostname.sh —
# which also runs on every subsequent boot via teamshare-hostname.service, so
# a stop/start (which assigns a new public IP) cannot leave Caddy serving a
# certificate for a hostname that no longer points here. See that script's
# header for the full reasoning.
# Installed straight from the clone at /opt/teamshare — the repo IS the single
# source of truth, so there is nothing to embed, base64, or keep in sync, and
# user_data stays well under EC2's 16 KB limit.
install -m 0750 /opt/teamshare/deploy/aws/files/teamshare-hostname.sh /usr/local/bin/teamshare-hostname.sh

cat > /etc/systemd/system/teamshare-hostname.service <<'UNIT'
[Unit]
Description=Point Caddy at this instance's current public IP
After=network-online.target
Wants=network-online.target
Before=caddy.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/teamshare-hostname.sh

[Install]
WantedBy=multi-user.target
UNIT

# Writes the initial Caddyfile too, so there is no separate first-boot path.
/usr/local/bin/teamshare-hostname.sh
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
Environment=TEAMSHARE_SIGNUP_SECRET=${signup_secret}
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
#
# NOTE on the signup secret: `Environment=TEAMSHARE_SIGNUP_SECRET=` above is
# templated from the Terraform variable of the same name (variables.tf) — set
# it there, once, and share it with the org; that's what replaces handing out
# per-team tokens individually. Left unset (the variable's default), this
# renders as an empty value, which `teamshare serve` treats exactly like the
# variable never being set at all: it generates one on first boot instead
# (recoverable only via `teamshare signup-secret --show` over SSM — see
# deploy/aws/README.md's break-glass section).

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
systemctl enable teamshare-hostname.service
systemctl enable --now caddy.service

# ---------------------------------------------------------------------------
# 8. Automated S3 backups. The backup logic lives in exactly one place —
#    deploy/aws/files/teamshare-backup.sh — and is installed straight from the
#    clone at /opt/teamshare rather than embedded, so the repo is the single
#    template's own $${...} interpolation. That means the copy written to
#    /usr/local/bin below is byte-for-byte the same script an operator can
#    ship straight to this instance over SSM without touching user_data at
#    all (see deploy/aws/README.md for that command and the restore
#    procedure). The script installs its own runtime dependency (sqlite3) on
#    first run, so nothing else needs to happen here.
# ---------------------------------------------------------------------------
install -o root -g root -m 0750 /opt/teamshare/deploy/aws/files/teamshare-backup.sh /usr/local/bin/teamshare-backup.sh

cat > /etc/systemd/system/teamshare-backup.service <<'UNIT'
[Unit]
Description=teamshare SQLite database backup to S3
After=teamshare.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/teamshare-backup.sh
UNIT

cat > /etc/systemd/system/teamshare-backup.timer <<'UNIT'
[Unit]
Description=Run teamshare-backup.service daily

[Timer]
OnCalendar=daily
Persistent=true
Unit=teamshare-backup.service

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now teamshare-backup.timer

echo "=== teamshare bootstrap finished $(date -u) ==="
