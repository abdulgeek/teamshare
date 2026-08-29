#!/usr/bin/env bash
# Emits the teamshare MCP auth/identity headers as a JSON object.
# Reads ~/.teamshare.json, the single config file written by /teamshare-setup.
set -euo pipefail

CONFIG="${HOME}/.teamshare.json"
if [ ! -f "$CONFIG" ]; then
  echo '{}'
  exit 0
fi

node -e '
const fs = require("node:fs");
try {
  const c = JSON.parse(fs.readFileSync(process.env.HOME + "/.teamshare.json", "utf8"));
  if (!c.token || !c.email || !c.name) { process.stdout.write("{}"); process.exit(0); }
  process.stdout.write(JSON.stringify({
    "Authorization": "Bearer " + c.token,
    "X-Teamshare-Email": String(c.email).trim().toLowerCase(),
    "X-Teamshare-Name": String(c.name).trim()
  }));
} catch {
  process.stdout.write("{}");
}
'
