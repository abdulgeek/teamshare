#!/usr/bin/env node
import { existsSync, mkdirSync, openSync, closeSync, unlinkSync, writeSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createApp } from './app.js';
import { getOrCreateToken, hasToken, openDb, removeMember, rotateToken } from './db.js';

export interface Args {
  cmd: 'serve' | 'rotate-token' | 'remove-member' | 'doctor' | 'help';
  port: number;
  dbPath: string;
  expiryDays: number;
  email?: string;
}

const DEFAULT_DB = join(homedir(), '.teamshare', 'teamshare.db');

export function parseArgs(argv: string[]): Args {
  const args: Args = { cmd: 'serve', port: 8787, dbPath: DEFAULT_DB, expiryDays: 14 };
  const rest = [...argv];

  const first = rest[0];
  if (first && !first.startsWith('-')) {
    if (
      first === 'serve' ||
      first === 'rotate-token' ||
      first === 'remove-member' ||
      first === 'doctor' ||
      first === 'help'
    ) {
      args.cmd = first;
      rest.shift();
      if (args.cmd === 'remove-member' && rest[0] && !rest[0].startsWith('-')) {
        args.email = rest.shift();
      }
    } else {
      args.cmd = 'help';
    }
  }

  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (flag === '--port' && value) { args.port = Number(value); i++; }
    else if (flag === '--db' && value) { args.dbPath = value; i++; }
    else if (flag === '--expiry-days' && value) { args.expiryDays = Number(value); i++; }
  }

  return args;
}

// One server per database file. WAL is safe for concurrent readers but this
// process owns the file, and two servers on one DB is always a misconfiguration.
export function acquireLock(dbPath: string): () => void {
  const lockPath = `${dbPath}.lock`;
  mkdirSync(dirname(dbPath), { recursive: true });

  if (existsSync(lockPath)) {
    const pid = Number(readFileSync(lockPath, 'utf8').trim());
    // pid 0 targets our own process group and never throws, so an empty or
    // truncated lock file must be treated as stale rather than "alive".
    const plausible = Number.isInteger(pid) && pid > 0;
    let alive = false;
    if (plausible) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
    }
    if (alive) {
      throw new Error(`a teamshare server is already running for ${dbPath} (pid ${pid})`);
    }
    unlinkSync(lockPath); // stale lock from a crashed process
  }

  const fd = openSync(lockPath, 'w');
  writeSync(fd, String(process.pid));
  closeSync(fd);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { unlinkSync(lockPath); } catch { /* already gone */ }
  };
}

const HELP = `teamshare — shared context for coding agents

Usage:
  teamshare serve [--port 8787] [--db <path>] [--expiry-days 14]
  teamshare rotate-token [--db <path>]
  teamshare remove-member <email> [--db <path>]
  teamshare doctor
`;

// The exact text `serve` prints on stdout, kept as a pure function so the
// print-once behavior (spec §8, README) can be asserted without binding a
// port: main()'s serve path calls this with the token and whether it existed
// before this call, and this is the only place that formats that banner.
export function formatServeBanner(opts: {
  port: number;
  dbPath: string;
  token: string;
  alreadyHadToken: boolean;
}): string {
  const { port, dbPath, token, alreadyHadToken } = opts;
  const lines = [`teamshare server listening on port ${port}`, `database: ${dbPath}`, ''];

  if (alreadyHadToken) {
    lines.push(
      'A team token is already configured for this database (not shown again).',
      'To issue a new one, run: teamshare rotate-token',
      '',
    );
  } else {
    lines.push(
      'Team token (share with teammates, they run /teamshare-setup):',
      '',
      `  ${token}`,
      '',
    );
  }

  lines.push(
    'WARNING: serve plain HTTP only on a trusted network. Put TLS in front for anything else.',
    '',
  );
  return lines.join('\n');
}

interface TeamshareConfig {
  url: string;
  token: string;
  name: string;
  email: string;
}

const CONFIG_KEYS: (keyof TeamshareConfig)[] = ['url', 'token', 'name', 'email'];
const DEFAULT_URL = 'http://localhost:8787';

// homedir() is called here (not hoisted to a module constant) so a test can
// override HOME before invoking doctor and have it take effect, the same
// contract the SessionStart hook relies on.
function teamshareConfigPath(): string {
  return join(homedir(), '.teamshare.json');
}

function readTeamshareConfig(): { config: TeamshareConfig | null; path: string } {
  const path = teamshareConfigPath();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { config: null, path };
  }
  const obj = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  const hasAllKeys = CONFIG_KEYS.every((k) => typeof obj[k] === 'string' && (obj[k] as string).length > 0);
  if (!hasAllKeys) return { config: null, path };
  return {
    config: {
      url: obj.url as string,
      token: obj.token as string,
      name: obj.name as string,
      email: obj.email as string,
    },
    path,
  };
}

// Generous relative to the SessionStart hook's 1.5s budget on purpose: a PaaS
// cold start can blow past the hook's budget while the server is otherwise
// fine, and doctor exists specifically to tell those two situations apart.
const DOCTOR_TIMEOUT_MS = 10_000;

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOCTOR_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function runDoctor(): Promise<{ exitCode: number; output: string }> {
  const lines: string[] = [];
  let healthy = true;
  const problem = (msg: string) => {
    healthy = false;
    lines.push(`[PROBLEM] ${msg}`);
  };
  const ok = (msg: string) => lines.push(`[OK] ${msg}`);

  const { config, path: configPath } = readTeamshareConfig();

  if (!config) {
    problem(`${configPath} is missing or missing one of url/token/name/email — run /teamshare-setup`);
  } else {
    ok(`${configPath} present with all required keys`);
  }

  if (config) {
    lines.push(`[INFO] identity this machine would present: ${config.name} <${config.email.trim().toLowerCase()}>`);
  } else {
    lines.push('[INFO] identity: unknown — no usable config to read it from');
  }

  if (config) {
    const base = config.url.replace(/\/+$/, '');

    try {
      const res = await fetchWithTimeout(`${base}/health`);
      if (res.ok) ok(`server reachable at ${base}/health`);
      else problem(`${base}/health responded ${res.status} — the server is up but not healthy`);
    } catch (err) {
      problem(
        `could not reach ${base}/health (${(err as Error).message}) — is the server running at that URL?`,
      );
    }

    try {
      const res = await fetchWithTimeout(`${base}/unread`, {
        headers: {
          Authorization: `Bearer ${config.token}`,
          'X-Teamshare-Email': config.email.trim().toLowerCase(),
          'X-Teamshare-Name': config.name.trim(),
        },
      });
      if (res.status === 200) {
        const body = (await res.json().catch(() => null)) as { total?: number } | null;
        const n = body && typeof body.total === 'number' ? body.total : 'an unknown number of';
        ok(`${base}/unread returned 200 (${n} unread share(s))`);
      } else if (res.status === 401) {
        problem(`${base}/unread returned 401 — token rejected, re-run /teamshare-setup`);
      } else if (res.status === 400) {
        problem(
          `${base}/unread returned 400 — identity malformed, check git config user.name/user.email`,
        );
      } else {
        problem(`${base}/unread returned ${res.status}`);
      }
    } catch (err) {
      problem(`could not reach ${base}/unread (${(err as Error).message}) — is the server running at that URL?`);
    }
  } else {
    lines.push('[INFO] server checks skipped — no usable config to read a URL/token from');
  }

  // The known split: Claude Code resolves the teamshare MCP server's URL from
  // TEAMSHARE_URL at startup, while the session-start digest reads the URL
  // straight out of ~/.teamshare.json. A team on a non-default URL who never
  // exported TEAMSHARE_URL gets a working digest and silently dead MCP tools
  // — this is the whole reason a teammate would reach for doctor.
  const envUrl = process.env.TEAMSHARE_URL;
  if (envUrl) {
    ok(`TEAMSHARE_URL is set (${envUrl})`);
  } else if (config) {
    if (config.url.replace(/\/+$/, '') !== DEFAULT_URL) {
      problem(
        `TEAMSHARE_URL is not set, but the configured server (${config.url}) is not the default ` +
          `${DEFAULT_URL} — the session-start digest will keep working but the teamshare MCP tools ` +
          `will silently fail to connect. Add to your shell profile: export TEAMSHARE_URL=${config.url}`,
      );
    } else {
      ok('TEAMSHARE_URL is unset — fine, the configured server is the default');
    }
  } else {
    lines.push('[INFO] TEAMSHARE_URL is unset — nothing to compare it against without a usable config');
  }

  return { exitCode: healthy ? 0 : 1, output: lines.join('\n') + '\n' };
}

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  if (args.cmd === 'help') {
    process.stdout.write(HELP);
    return;
  }

  // doctor never touches the database, so it runs before the dbPath directory
  // is created — a diagnostic command shouldn't create real teamshare state.
  if (args.cmd === 'doctor') {
    const { exitCode, output } = await runDoctor();
    process.stdout.write(output);
    process.exitCode = exitCode;
    return;
  }

  mkdirSync(dirname(args.dbPath), { recursive: true });

  if (args.cmd === 'rotate-token') {
    const db = openDb(args.dbPath);
    const token = rotateToken(db);
    db.close();
    process.stdout.write(
      `New team token:\n\n  ${token}\n\nTeammates must re-run /teamshare-setup with this token.\n`,
    );
    return;
  }

  if (args.cmd === 'remove-member') {
    if (!args.email) {
      process.stderr.write('remove-member needs an email\n');
      process.exitCode = 1;
      return;
    }
    const db = openDb(args.dbPath);
    const removed = removeMember(db, args.email);
    db.close();
    if (!removed) {
      process.exitCode = 1;
    }
    process.stdout.write(removed ? `Removed ${args.email}\n` : `No member ${args.email}\n`);
    return;
  }

  const release = acquireLock(args.dbPath);
  const db = openDb(args.dbPath);
  // Captured BEFORE getOrCreateToken, which mints and persists a token on
  // first call — this is the only way to tell "printed before" from "first
  // time" apart (spec §8 / README: printed exactly once per generation).
  const alreadyHadToken = hasToken(db);
  const token = getOrCreateToken(db);
  const app = createApp({ db, expiryDays: args.expiryDays });

  const server = app.listen(args.port, () => {
    process.stdout.write(
      formatServeBanner({ port: args.port, dbPath: args.dbPath, token, alreadyHadToken }),
    );
  });

  const shutdown = () => {
    server.close(() => {
      db.close();
      release();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Run only when invoked as a program, so tests can import this module freely.
// pathToFileURL (not string concatenation) is required: import.meta.url
// percent-encodes characters like spaces, so a naive `file://${argv[1]}`
// comparison silently fails on any path containing one.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2));
}
