#!/usr/bin/env bash
# Emits the teamshare *identity* headers (X-Teamshare-Name / X-Teamshare-Email)
# as a JSON object. Never emits Authorization — the static "headers" map in
# .mcp.json supplies that from ${user_config.TEAMSHARE_TOKEN}. Claude Code
# deliberately scrubs CLAUDE_PLUGIN_OPTION_* (credential-shaped) env vars from
# this helper's process, so the token is not available here by design — this
# script must never try to source or forward it.
#
# Identity must be deterministic per machine, not per directory. Claude Code
# invokes this helper with cwd set to the plugin directory (not the user's
# project), so a naive `git config --get` here would resolve a *different*
# identity than session-start.mjs, which runs with cwd = the user's project
# and can pick up a *repo-local* git identity. That mismatch silently
# attributes receipts to the wrong person and leaves the real reader's share
# reappearing forever (found via live testing). So identity resolves in this
# order — the same rule, hand-duplicated in session-start.mjs's gitIdentity();
# if this changes, update that file by hand in the same change:
#   1. Prefer `git config --global --get user.name` / `user.email`.
#   2. Run git with cwd forced to the home directory — never this script's
#      actual cwd — so a repo-local config can never influence the result,
#      including in the plain-`--get` fallback below (which otherwise reads
#      local scope too).
#   3. If the global value is empty, fall back to plain `git config --get`,
#      still executed from the home directory, so both sides still agree.
#   4. If neither yields both values, fall back to ~/.teamshare.json's
#      name/email, if that file exists and has both — keeps --plugin-dir
#      development and existing installs working.
#   5. Still nothing — emit exactly {} so the server rejects cleanly with 400
#      rather than half-authenticating.
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
  const home = os.homedir();
  function run(args) {
    try {
      return execFileSync("git", args, {
        cwd: home,
        timeout: 1500,
        stdio: ["ignore", "pipe", "ignore"],
      }).toString("utf8").trim();
    } catch {
      // No git binary, no repo at `home`, or the key is not set: treat as empty.
      return "";
    }
  }

  let name = run(["config", "--global", "--get", "user.name"]);
  let email = run(["config", "--global", "--get", "user.email"]);
  if (!name) name = run(["config", "--get", "user.name"]);
  if (!email) email = run(["config", "--get", "user.email"]);

  if (name && email) return { name, email };
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
