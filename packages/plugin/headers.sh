#!/usr/bin/env bash
# Emits the teamshare *identity* headers (X-Teamshare-Name / X-Teamshare-Email)
# as a JSON object. Never emits Authorization — the static "headers" map in
# .mcp.json supplies that from ${user_config.TEAMSHARE_TOKEN}. Claude Code
# deliberately scrubs CLAUDE_PLUGIN_OPTION_* (credential-shaped) env vars from
# this helper's process, so the token is not available here by design — this
# script must never try to source or forward it.
#
# Identity resolves in this order:
#   1. `git config user.name` / `user.email` — the normal path, zero setup.
#   2. ~/.teamshare.json's name/email, if that file exists and has both — keeps
#      --plugin-dir development and existing installs working.
#   3. Neither yields both values — emit exactly {} so the server rejects
#      cleanly with 400 rather than half-authenticating.
#
# Stdout is a single JSON object and nothing else; any stray output corrupts
# the header map Claude Code merges this into.
set -euo pipefail

node -e '
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function gitIdentity() {
  try {
    const name = execFileSync("git", ["config", "--get", "user.name"], {
      timeout: 1500,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString("utf8").trim();
    const email = execFileSync("git", ["config", "--get", "user.email"], {
      timeout: 1500,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString("utf8").trim();
    if (name && email) return { name, email };
  } catch {
    // No git binary, not a repo, or identity unset: fall through.
  }
  return null;
}

function fileIdentity() {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), ".teamshare.json"), "utf8");
    const cfg = JSON.parse(raw);
    if (cfg.name && cfg.email) return { name: cfg.name, email: cfg.email };
  } catch {
    // No config file, unreadable, or malformed: fall through.
  }
  return null;
}

const identity = gitIdentity() || fileIdentity();
if (!identity) {
  process.stdout.write("{}");
} else {
  process.stdout.write(JSON.stringify({
    "X-Teamshare-Name": String(identity.name).trim(),
    "X-Teamshare-Email": String(identity.email).trim().toLowerCase(),
  }));
}
'
