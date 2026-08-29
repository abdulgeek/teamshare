#!/usr/bin/env node
import { existsSync, mkdirSync, openSync, closeSync, unlinkSync, writeSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createApp } from './app.js';
import {
  findTeamByName,
  getOrCreateSignupSecret,
  getSignupSecret,
  listTeams,
  makeTeamScope,
  openDb,
  removeMember,
  rotateTeamToken,
  type Db,
} from './db.js';
import {
  runConnect,
  listTargets,
  discoverConnectedTargets,
  formatConnectOutput,
  formatListOutput,
  normalizeServerUrl,
  type TargetId,
} from './connect.js';

export interface Args {
  cmd: 'serve' | 'rotate-token' | 'remove-member' | 'doctor' | 'connect' | 'signup-secret' | 'help';
  port: number;
  host: string;
  dbPath: string;
  expiryDays: number;
  email?: string;
  // Selects which team rotate-token/remove-member act on. Required whenever
  // the server hosts more than one team — see resolveTeamForCli.
  team?: string;
  // serve only. Resolved as flag ?? TEAMSHARE_SIGNUP_SECRET env var ?? (a
  // freshly generated one, first boot only). Never a positional argument —
  // see the design doc's "secrets never touch a command line".
  signupSecret?: string;
  openSignup?: boolean;
  maxTeams?: number;
  // signup-secret subcommand only: the one supported flag, so revealing the
  // plaintext is always an explicit ask, never a bare-command accident.
  signupSecretShow?: boolean;
  connectUrl?: string;
  connectToken?: string;
  connectOnly?: TargetId[];
  connectDryRun?: boolean;
  connectForce?: boolean;
  connectList?: boolean;
  connectShowToken?: boolean;
  doctorUrl?: string;
  doctorToken?: string;
}

const DEFAULT_DB = join(homedir(), '.teamshare', 'teamshare.db');

// Loopback-only by default: correct behind the Caddy/TLS reverse-proxy setup
// this is meant for (deploy/aws), since the Node process then never needs to
// be reachable directly. A LAN team running this with no proxy in front must
// pass --host 0.0.0.0 explicitly to accept connections from other machines —
// see the WARNING in formatServeBanner and the README's server-install section.
const DEFAULT_HOST = '127.0.0.1';

export function parseArgs(argv: string[]): Args {
  const args: Args = { cmd: 'serve', port: 8787, host: DEFAULT_HOST, dbPath: DEFAULT_DB, expiryDays: 14 };
  const rest = [...argv];

  const first = rest[0];
  if (first && !first.startsWith('-')) {
    if (
      first === 'serve' ||
      first === 'rotate-token' ||
      first === 'remove-member' ||
      first === 'doctor' ||
      first === 'connect' ||
      first === 'signup-secret' ||
      first === 'help'
    ) {
      args.cmd = first;
      rest.shift();
      if (args.cmd === 'remove-member' && rest[0] && !rest[0].startsWith('-')) {
        args.email = rest.shift();
      }
      if (args.cmd === 'connect') {
        if (rest[0] && !rest[0].startsWith('-')) args.connectUrl = rest.shift();
        if (rest[0] && !rest[0].startsWith('-')) args.connectToken = rest.shift();
      }
      if (args.cmd === 'doctor') {
        // `teamshare doctor <server-url> <team-token>` always works, needing
        // nothing installed — this is the highest-priority resolution
        // source, ahead of ~/.teamshare.json and any assistant config.
        if (rest[0] && !rest[0].startsWith('-')) args.doctorUrl = rest.shift();
        if (rest[0] && !rest[0].startsWith('-')) args.doctorToken = rest.shift();
      }
    } else {
      args.cmd = 'help';
    }
  }

  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (flag === '--port' && value) { args.port = Number(value); i++; }
    else if (flag === '--host' && value) { args.host = value; i++; }
    else if (flag === '--db' && value) { args.dbPath = value; i++; }
    else if (flag === '--expiry-days' && value) { args.expiryDays = Number(value); i++; }
    else if (flag === '--only' && value) {
      args.connectOnly = value.split(',').map((s) => s.trim()).filter(Boolean) as TargetId[];
      i++;
    }
    else if (flag === '--dry-run') { args.connectDryRun = true; }
    else if (flag === '--force') { args.connectForce = true; }
    else if (flag === '--list') { args.connectList = true; }
    else if (flag === '--show-token') { args.connectShowToken = true; }
    else if (flag === '--team' && value) { args.team = value; i++; }
    else if (flag === '--signup-secret' && value) { args.signupSecret = value; i++; }
    else if (flag === '--max-teams' && value) { args.maxTeams = Number(value); i++; }
    else if (flag === '--open-signup') { args.openSignup = true; }
    else if (flag === '--show') { args.signupSecretShow = true; }
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
  teamshare serve [--port 8787] [--host 127.0.0.1] [--db <path>] [--expiry-days 14]
                  [--signup-secret <secret>] [--open-signup] [--max-teams <n>]
  teamshare signup-secret --show [--db <path>]
  teamshare rotate-token [--team <name>] [--db <path>]
  teamshare remove-member <email> [--team <name>] [--db <path>]
  teamshare doctor [<server-url> <team-token>]
  teamshare connect <server-url> <team-token> [--only cursor,codex,...] [--dry-run] [--force] [--show-token]
  teamshare connect --list

This server hosts multiple teams. A team is created by POSTing to /teams
(gated by the instance signup secret) — see the design doc for the
standalone/plugin surfaces that wrap that call; teamshare signup-secret
--show is the break-glass path when that secret is lost. --team <name> is
required for rotate-token/remove-member whenever more than one team exists;
it is optional (and inferred) when there is exactly one.

The signup secret is read from --signup-secret or the TEAMSHARE_SIGNUP_SECRET
environment variable, never a positional argument (so it never ends up in
shell history or a process list), and is generated automatically on first
boot if neither is given. --open-signup disables the gate entirely (a loud
startup warning is printed) and --max-teams caps how many teams this
instance will ever host.

serve binds to 127.0.0.1 (loopback) by default — correct when a reverse
proxy (e.g. Caddy) terminates TLS and forwards to it locally, since the
Node process then never needs to be reachable directly. Running this for a
LAN team with no proxy in front? Pass --host 0.0.0.0 explicitly to accept
connections from other machines.

connect targets: cursor, vscode, windsurf, gemini, cline, codex, zed, continue

Non-Claude-Code assistants can also connect with zero install: download
teamshare-connect.mjs and run \`node teamshare-connect.mjs <server-url> <team-token>\`
directly — no clone, no pnpm install, no build. Same implementation as above.
`;

// The exact text `serve` prints on stdout, kept as a pure function so the
// print-once behavior (spec §8, README) can be asserted without binding a
// port: main()'s serve path calls this with the token and whether it existed
// before this call, and this is the only place that formats that banner.
export function formatServeBanner(opts: {
  port: number;
  host: string;
  dbPath: string;
  token: string;
  alreadyHadToken: boolean;
}): string {
  const { port, host, dbPath, token, alreadyHadToken } = opts;
  const lines = [`teamshare server listening on ${host}:${port}`, `database: ${dbPath}`, ''];

  if (alreadyHadToken) {
    lines.push(
      'A team token is already configured for this database (not shown again).',
      'To issue a new one, run: teamshare rotate-token',
      '',
    );
  } else {
    lines.push(
      'Team token (share with teammates — for Claude Code they install the plugin and are',
      'prompted for it; for other assistants, run `teamshare connect`):',
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

// The real `serve` startup banner in the multi-team world: there is no
// longer a single "the" team token to print (formatServeBanner above is kept
// only for its own direct tests — this server now hosts N teams, each with
// its own token, minted via POST /teams). Never prints the signup secret's
// value: it is stored plaintext precisely so it stays recoverable, but this
// banner still must not be a second place it gets echoed — `signup-secret
// --show` is the one deliberate, on-demand way to see it.
export function formatServeStartupBanner(opts: {
  port: number;
  host: string;
  dbPath: string;
  teamCount: number;
  openSignup: boolean;
  signupSecretGenerated: boolean;
  maxTeams?: number;
}): string {
  const { port, host, dbPath, teamCount, openSignup, signupSecretGenerated, maxTeams } = opts;
  const lines = [
    `teamshare server listening on ${host}:${port}`,
    `database: ${dbPath}`,
    '',
    `${teamCount} team(s) currently on this instance.`,
  ];

  if (openSignup) {
    lines.push(
      '',
      'WARNING: --open-signup is set — POST /teams requires no secret at all. Only run this on a',
      'fully trusted network, and turn it off once every team that needs one has been created.',
    );
  } else if (signupSecretGenerated) {
    lines.push(
      '',
      'A signup secret was generated for this instance on first boot (not shown here — it is never',
      'printed to a log). To view it: teamshare signup-secret --show',
    );
  } else {
    lines.push('', 'Signup secret: configured. To view it: teamshare signup-secret --show');
  }

  if (maxTeams !== undefined) {
    lines.push(`Team cap: ${maxTeams} (POST /teams refuses once this instance reaches it).`);
  }

  lines.push(
    '',
    'WARNING: serve plain HTTP only on a trusted network. Put TLS in front for anything else.',
    '',
  );
  return lines.join('\n');
}

// Resolves which team rotate-token/remove-member act on. Fixing these two
// commands is the point of this stage: after migration, the old
// config.team_token-based rotate-token wrote to a column nothing reads any
// more, so it would print a fresh token, claim teammates must reconnect, and
// change nothing — a silent no-op standing in for the documented remedy for
// a leaked credential. Every path below now resolves an actual team row and
// either operates on it or fails loudly; none can silently do nothing.
function resolveTeamForCli(db: Db, teamName?: string): { id: string; name: string } | { error: string } {
  if (teamName) {
    const team = findTeamByName(db, teamName);
    if (!team) return { error: `no team named "${teamName}" on this server` };
    return team;
  }
  const teams = listTeams(db);
  if (teams.length === 0) {
    return { error: 'no teams exist on this server yet' };
  }
  if (teams.length === 1) return teams[0];
  return {
    error:
      `this server hosts multiple teams (${teams.length}) — specify --team <name>. Known teams: ` +
      teams.map((t) => t.name).join(', '),
  };
}

interface TeamshareConfig {
  url: string;
  token: string;
  name: string;
  email: string;
}

const CONFIG_KEYS: (keyof TeamshareConfig)[] = ['url', 'token', 'name', 'email'];

// homedir() is called here (not hoisted to a module constant) so a test can
// override HOME before invoking doctor and have it take effect, the same
// contract the SessionStart hook relies on.
function teamshareConfigPath(): string {
  return join(homedir(), '.teamshare.json');
}

// `exists` is reported separately from `config` so callers can tell "this
// install method never creates the file" (normal — try the next source)
// apart from "the file is there but broken" (a real, actionable problem).
function readTeamshareConfig(): { config: TeamshareConfig | null; path: string; exists: boolean } {
  const path = teamshareConfigPath();
  if (!existsSync(path)) return { config: null, path, exists: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { config: null, path, exists: true };
  }
  const obj = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  const hasAllKeys = CONFIG_KEYS.every((k) => typeof obj[k] === 'string' && (obj[k] as string).length > 0);
  if (!hasAllKeys) return { config: null, path, exists: true };
  return {
    config: {
      url: obj.url as string,
      token: obj.token as string,
      name: obj.name as string,
      email: obj.email as string,
    },
    path,
    exists: true,
  };
}

// Identity must be deterministic per machine, not per directory — the same
// rule as headers.sh / session-start.mjs's gitIdentity() in the plugin
// package (a deliberate, hand-maintained duplicate; nothing enforces the
// three staying in sync, so update the others by hand if this changes).
// Resolving from the *current* cwd let a repo-local git identity diverge
// from the global one the plugin's helper resolves, which silently
// misattributed receipts in live testing. So:
//   1. Prefer `git config --global --get user.name` / `user.email`.
//   2. Run git with cwd forced to the home directory — never doctor's own
//      cwd — so a repo-local config can never influence the result,
//      including in the plain-`--get` fallback below (which otherwise reads
//      local scope too).
//   3. If the global value is empty, fall back to plain `git config --get`,
//      still executed from the home directory, so all three call sites agree.
function gitIdentity(): { name: string; email: string } | null {
  const home = homedir();
  const run = (args: string[]): string => {
    try {
      return execFileSync('git', args, {
        cwd: home,
        timeout: 1500,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString('utf8')
        .trim();
    } catch {
      // No git binary, no repo at `home`, or the key isn't set: treat as empty.
      return '';
    }
  };

  let name = run(['config', '--global', '--get', 'user.name']);
  let email = run(['config', '--global', '--get', 'user.email']);
  if (!name) name = run(['config', '--get', 'user.name']);
  if (!email) email = run(['config', '--get', 'user.email']);

  if (name && email) return { name, email };
  return null;
}

// Same fallback shape as the plugin: prefer the resolved git identity, and
// fall back to ~/.teamshare.json's name/email only when git yields nothing.
function resolveIdentity(config: TeamshareConfig | null): { name: string; email: string } | null {
  return gitIdentity() || (config ? { name: config.name, email: config.email } : null);
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

interface ResolvedServer {
  url: string;
  token: string;
}

interface ServerResolution {
  server: ResolvedServer | null;
  // Only ever the *legacy* ~/.teamshare.json config — the one source that
  // also carries a name/email fallback for identity resolution. Explicit
  // args and discovered assistant configs never feed identity fallback;
  // git config remains the only real source of truth there.
  legacyConfig: TeamshareConfig | null;
  lines: string[];
  problem: boolean;
}

// Resolves a server URL/token from the three sources doctor supports, tried
// in this order, and explains which one it used (or why none worked):
//   1. Explicit `teamshare doctor <server-url> <team-token>` arguments.
//   2. ~/.teamshare.json, if the file is present (dev / --plugin-dir /
//      legacy installs).
//   3. Any assistant config `teamshare connect` knows about that already has
//      a teamshare entry (Claude Code's plugin install writes neither of the
//      above — its values live in Claude Code's own settings, which this
//      process cannot read — so this is how doctor still finds *something*
//      to test on the most common setup today).
// Never treats "nothing found" as a broken install — see the guidance text
// below, which is the whole point of this rewrite.
function resolveServer(explicitUrl?: string, explicitToken?: string): ServerResolution {
  const lines: string[] = [];

  if (explicitUrl && explicitToken) {
    lines.push('[OK] using the server URL and token given on the command line');
    return { server: { url: explicitUrl, token: explicitToken }, legacyConfig: null, lines, problem: false };
  }

  const { config: legacyConfig, path: legacyPath, exists: legacyExists } = readTeamshareConfig();
  if (legacyExists && !legacyConfig) {
    // The file is there but broken — unlike "the file doesn't exist at all"
    // (normal under the plugin-managed install), this is an actual problem:
    // something wrote it and got it wrong, or it wants a `/teamshare-setup`
    // re-run.
    lines.push(`[PROBLEM] ${legacyPath} exists but is missing one of url/token/name/email — run /teamshare-setup`);
    return { server: null, legacyConfig: null, lines, problem: true };
  }
  if (legacyConfig) {
    lines.push(`[OK] ${legacyPath} present with all required keys`);
    return { server: { url: legacyConfig.url, token: legacyConfig.token }, legacyConfig, lines, problem: false };
  }

  const discovered = discoverConnectedTargets();
  if (discovered.length === 0) {
    lines.push(
      '[INFO] no server URL/token found from any source:',
      `  - ${legacyPath} does not exist`,
      '  - no assistant config known to `teamshare connect` (Cursor, VS Code, Windsurf, Gemini CLI,',
      '    Cline, Zed, Codex) has a teamshare entry either',
      '',
      'This is expected for the two normal setups, not a sign the install is broken:',
      '  - Claude Code: the plugin stores the server URL and team token itself and never writes',
      '    ~/.teamshare.json. Run `/plugin` in Claude Code to see the values it has stored.',
      '  - Any other assistant: run `teamshare connect <server-url> <team-token>` to configure it.',
      '',
      'To test a specific server directly, regardless of what is installed on this machine:',
      '  teamshare doctor <server-url> <team-token>',
    );
    // This is the expected shape of a normal install, not a misconfiguration
    // — so the lines above stay [INFO], not [PROBLEM]. But no check actually
    // ran: exiting 0 here would be a false all-clear (the README says exit 0
    // means every check passed), so this alone still makes the overall run
    // exit non-zero.
    return { server: null, legacyConfig: null, lines, problem: true };
  }

  const uniquePairs = new Set(discovered.map((d) => `${d.url} ${d.token}`));
  if (uniquePairs.size > 1) {
    lines.push(
      `[PROBLEM] found a teamshare entry in ${discovered.length} assistant configs that do not agree ` +
        'on the server URL/token:',
    );
    for (const d of discovered) lines.push(`  - ${d.label} (${d.path}) -> ${d.url}`);
    lines.push(
      `Testing the first one found (${discovered[0].label}). Disagreeing configs mean at least one ` +
        'assistant is pointed at the wrong server or an old token — re-run `teamshare connect` for ' +
        'whichever ones are wrong.',
    );
    return { server: { url: discovered[0].url, token: discovered[0].token }, legacyConfig: null, lines, problem: true };
  }

  if (discovered.length > 1) {
    lines.push(
      `[OK] found a matching teamshare entry in ${discovered.length} assistant configs: ` +
        discovered.map((d) => d.label).join(', '),
    );
  } else {
    lines.push(`[OK] found a teamshare entry in ${discovered[0].label} (${discovered[0].path})`);
  }
  return { server: { url: discovered[0].url, token: discovered[0].token }, legacyConfig: null, lines, problem: false };
}

export async function runDoctor(
  explicitUrl?: string,
  explicitToken?: string,
): Promise<{ exitCode: number; output: string }> {
  const lines: string[] = [];
  let healthy = true;
  const problem = (msg: string) => {
    healthy = false;
    lines.push(`[PROBLEM] ${msg}`);
  };
  const ok = (msg: string) => lines.push(`[OK] ${msg}`);

  const resolution = resolveServer(explicitUrl, explicitToken);
  lines.push(...resolution.lines);
  if (resolution.problem) healthy = false;
  const server = resolution.server;

  const identity = resolveIdentity(resolution.legacyConfig);
  if (identity) {
    lines.push(
      `[INFO] identity this machine would present: ${identity.name.trim()} <${identity.email.trim().toLowerCase()}>`,
    );
  } else {
    problem(
      'identity unresolved — no git user.name/user.email and no usable ~/.teamshare.json. Run:\n' +
        '  git config --global user.name "Your Name"\n' +
        '  git config --global user.email "you@example.com"',
    );
  }

  if (server) {
    // Normalize the same way `teamshare connect` does: a URL that already
    // ends in "/mcp" (a common paste mistake — that's the literal endpoint
    // this tool prints in some contexts) must probe the plain origin's
    // /health and /unread, not "<url>/mcp/health".
    const base = normalizeServerUrl(server.url);

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
          Authorization: `Bearer ${server.token}`,
          'X-Teamshare-Email': (identity?.email ?? '').trim().toLowerCase(),
          'X-Teamshare-Name': (identity?.name ?? '').trim(),
        },
      });
      if (res.status === 200) {
        const body = (await res.json().catch(() => null)) as { total?: number; team?: string } | null;
        const n = body && typeof body.total === 'number' ? body.total : 'an unknown number of';
        ok(`${base}/unread returned 200 (${n} unread share(s))`);
        // The first question anyone asks when a share doesn't appear is
        // "which team am I even connected to" — /unread already resolves
        // the team from the token, so surface it here at near-zero cost.
        if (body && typeof body.team === 'string' && body.team.length > 0) {
          ok(`connected to team: ${body.team}`);
        }
      } else if (res.status === 401) {
        problem(
          `${base}/unread returned 401 — token rejected. Reconnect: /plugin (Claude Code) or ` +
            '`teamshare connect` (other assistants)',
        );
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
    lines.push('[INFO] server checks skipped — no server URL/token available (see above)');
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
    if ((args.doctorUrl && !args.doctorToken) || (!args.doctorUrl && args.doctorToken)) {
      process.stderr.write('doctor needs both <server-url> and <team-token>, or neither\n');
      process.exitCode = 1;
      return;
    }
    const { exitCode, output } = await runDoctor(args.doctorUrl, args.doctorToken);
    process.stdout.write(output);
    process.exitCode = exitCode;
    return;
  }

  // connect never touches the teamshare database either — it edits *other*
  // tools' config files, using the real machine's home directory (tests
  // exercise connect.ts's exported functions directly with an injected
  // `home`, never through main()).
  if (args.cmd === 'connect') {
    if (args.connectList) {
      process.stdout.write(formatListOutput(listTargets()));
      return;
    }
    if (!args.connectUrl || !args.connectToken) {
      process.stderr.write('connect needs a <server-url> and <team-token> (or pass --list)\n');
      process.exitCode = 1;
      return;
    }
    const run = runConnect(args.connectUrl, args.connectToken, {
      dryRun: args.connectDryRun,
      force: args.connectForce,
      only: args.connectOnly,
      showToken: args.connectShowToken,
    });
    process.stdout.write(formatConnectOutput(run));
    if (run.aborted) process.exitCode = 1;
    return;
  }

  mkdirSync(dirname(args.dbPath), { recursive: true });

  if (args.cmd === 'signup-secret') {
    if (!args.signupSecretShow) {
      process.stderr.write('signup-secret needs --show (the only supported flag) to print the current value\n');
      process.exitCode = 1;
      return;
    }
    const db = openDb(args.dbPath);
    const secret = getSignupSecret(db);
    db.close();
    if (!secret) {
      process.stdout.write(
        'No signup secret is configured yet. One is generated automatically the first time `serve`\n' +
          'runs without --signup-secret/TEAMSHARE_SIGNUP_SECRET, or immediately if you pass one:\n' +
          '  teamshare serve --signup-secret <your-secret>\n',
      );
      return;
    }
    process.stdout.write(`${secret}\n`);
    return;
  }

  if (args.cmd === 'rotate-token') {
    const db = openDb(args.dbPath);
    const resolved = resolveTeamForCli(db, args.team);
    if ('error' in resolved) {
      db.close();
      process.stderr.write(resolved.error + '\n');
      process.exitCode = 1;
      return;
    }
    const token = rotateTeamToken(db, resolved.id);
    db.close();
    process.stdout.write(
      `New team token for "${resolved.name}":\n\n  ${token}\n\n` +
        'Teammates must reconnect with this token: `/plugin configure teamshare` for Claude Code, ' +
        'or `teamshare connect` again for everyone else.\n',
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
    const resolved = resolveTeamForCli(db, args.team);
    if ('error' in resolved) {
      db.close();
      process.stderr.write(resolved.error + '\n');
      process.exitCode = 1;
      return;
    }
    const scope = makeTeamScope(db, resolved.id);
    const removed = removeMember(scope, args.email);
    db.close();
    if (!removed) {
      process.exitCode = 1;
    }
    process.stdout.write(
      removed
        ? `Removed ${args.email} from "${resolved.name}"\n`
        : `No member ${args.email} in "${resolved.name}"\n`,
    );
    return;
  }

  const release = acquireLock(args.dbPath);
  const db = openDb(args.dbPath);

  // §Creating a team: the signup secret is operator-settable via --signup-secret
  // or TEAMSHARE_SIGNUP_SECRET, and only generated on first boot if neither is
  // given — never minted into a log line the operator would need SSM/Terraform
  // access to read back. --open-signup skips resolving one entirely and
  // disables the gate, with a loud warning printed below.
  let signupSecret: string | null = null;
  let signupSecretGenerated = false;
  if (!args.openSignup) {
    const explicit = args.signupSecret ?? process.env.TEAMSHARE_SIGNUP_SECRET;
    const resolved = getOrCreateSignupSecret(db, explicit);
    signupSecret = resolved.secret;
    signupSecretGenerated = resolved.generated;
  }

  const app = createApp({
    db,
    expiryDays: args.expiryDays,
    signupSecret,
    openSignup: args.openSignup,
    maxTeams: args.maxTeams,
  });

  const server = app.listen(args.port, args.host, () => {
    process.stdout.write(
      formatServeStartupBanner({
        port: args.port,
        host: args.host,
        dbPath: args.dbPath,
        teamCount: listTeams(db).length,
        openSignup: Boolean(args.openSignup),
        signupSecretGenerated,
        maxTeams: args.maxTeams,
      }),
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
