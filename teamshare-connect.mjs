#!/usr/bin/env node
// Convenience entry point so the command is short and memorable:
//
//   node teamshare-connect.mjs <server-url> <team-token>
//
// The implementation lives in packages/server/src/teamshare-connect.mjs and is
// shared with the `teamshare connect` subcommand. This file only forwards to
// it — keep it free of logic so there is never a second implementation to
// drift. Forwarding as a child process (rather than importing) preserves the
// script's own entry-point guard, its stdio, and its exit code.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, 'packages', 'server', 'src', 'teamshare-connect.mjs');

const result = spawnSync(process.execPath, [target, ...process.argv.slice(2)], {
  stdio: 'inherit',
});

if (result.error) {
  process.stderr.write(`teamshare-connect: could not run ${target}\n${result.error.message}\n`);
  process.exit(1);
}

process.exit(result.status ?? 1);
