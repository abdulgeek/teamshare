#!/usr/bin/env node
// Copies the two standalone, dependency-free CLIs into the plugin's bin/ so
// they ship twice from ONE source file each.
//
// Why a copy rather than an import: the marketplace entry
// (.claude-plugin/marketplace.json) installs `./packages/plugin` and nothing
// else, so anything under packages/server is simply absent on an installed
// machine. And why bin/ at all: Claude Code puts every installed plugin's
// bin/ directory on PATH, which turns these into plain commands a slash
// command can run by name — no ${CLAUDE_PLUGIN_ROOT}, no path quoting, no
// curl, nothing to download.
//
// Drift is caught, not hoped away: packages/plugin/bin/bin-sync.test.mjs
// fails if either copy differs from its source, and names this script.
import { readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SYNCED_BINS = [
  { from: 'packages/server/src/teamshare-team.mjs', to: 'packages/plugin/bin/teamshare-team' },
  { from: 'packages/server/src/teamshare-connect.mjs', to: 'packages/plugin/bin/teamshare-connect' },
];

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const { from, to } of SYNCED_BINS) {
    const source = readFileSync(join(root, from));
    mkdirSync(dirname(join(root, to)), { recursive: true });
    writeFileSync(join(root, to), source);
    chmodSync(join(root, to), 0o755);
    console.log(`synced ${from} -> ${to}`);
  }
}
