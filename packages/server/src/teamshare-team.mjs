#!/usr/bin/env node
// teamshare-team.mjs — creates a new team on a shared teamshare server, or
// rotates an existing team's token — without any AWS/Terraform/SSM access.
// This is the fix for the actual complaint that started this work: getting a
// token used to mean AWS credentials, Terraform state, and
// `aws ssm send-command`. Now it's this one file.
//
// This is the ONE implementation of both operations — plain ESM, zero
// imports outside Node builtins, no build step. It is both:
//   1. A standalone script: from a checkout of this repo, run
//      `node packages/server/src/teamshare-team.mjs create-team <server-url> "<name>"`
//      (or `cd packages/server/src && node teamshare-team.mjs ...`). It also
//      works as a single downloaded file on its own — it has no relative
//      imports of its own — with no `pnpm install`, no `pnpm -r build`, and
//      no native module compilation. This is the real first-time path: it
//      has to work for someone who has installed nothing at all, which rules
//      out putting team creation behind the MCP connection (the plugin
//      cannot connect without the token this script exists to obtain).
//   2. The module `./team.ts` re-exports from, so the `teamshare` CLI's
//      `create-team`/break-glass wiring and this exact code never fork into
//      two implementations. See teamshare-team.d.mts for the type surface.
//
// Deliberately a SEPARATE file from teamshare-connect.mjs, not a subcommand
// grafted onto it: that file's argv contract is `<url> <token>`, it is
// documented (README.md) as curl-and-run, and adding a leading subcommand
// would silently break that documented positional parsing for anyone who
// still calls it the old way. A pinned regression test lives in
// connect.test.ts for exactly that reason.
//
// Two operations, both gated by a secret that must never be a positional
// argument (shell history, `ps` output): the instance's signup secret (for
// create-team) and the team's own current token (for rotate-team). Both are
// read from the environment or prompted for interactively on a real
// terminal — never accepted as argv.
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

/**
 * @typedef {{ name: string, email: string }} GitIdentity
 */

export const SIGNUP_SECRET_ENV = 'TEAMSHARE_SIGNUP_SECRET';
export const TEAM_TOKEN_ENV = 'TEAMSHARE_TEAM_TOKEN';

// ---------------------------------------------------------------------------
// Identity (needed only to verify the freshly-minted token against /unread,
// which requires identity headers the same way every other authenticated
// call does).
//
// This is a fifth hand-maintained copy of the same git-identity resolution
// as packages/plugin/headers.sh, packages/plugin/hooks/session-start.mjs,
// cli.ts's own gitIdentity(), and teamshare-connect.mjs's
// resolveGitIdentity() — teamshare-connect.mjs's own copy already notes
// nothing enforces those staying in sync; this file adds one more that the
// same caveat applies to. Kept identical on purpose: cwd defaults to the
// *home* directory (never this process's cwd), --global is tried before
// plain --get, and both cwd/env are injectable so tests never touch the
// real machine's git config.
/**
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {GitIdentity | null}
 */
export function resolveGitIdentity(opts = {}) {
  const cwd = opts.cwd ?? homedir();
  const env = opts.env ?? process.env;

  const run = (args) => {
    try {
      return execFileSync('git', args, {
        cwd,
        env,
        timeout: 1500,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString('utf8')
        .trim();
    } catch {
      return '';
    }
  };

  let name = run(['config', '--global', '--get', 'user.name']);
  let email = run(['config', '--global', '--get', 'user.email']);
  if (!name) name = run(['config', '--get', 'user.name']);
  if (!email) email = run(['config', '--get', 'user.email']);

  if (!name || !email) return null;
  return { name, email: email.toLowerCase() };
}

// Identical rule to teamshare-connect.mjs's copy — kept byte-for-byte so a
// URL pasted with a trailing "/mcp" (the single most common paste mistake,
// since that's the literal MCP endpoint) still resolves to the right origin
// for /teams, /teams/rotate, /health, and /unread.
export function normalizeServerUrl(url) {
  let u = String(url).trim();
  for (;;) {
    const stripped = u.replace(/\/+$/, '');
    if (/\/mcp$/i.test(stripped)) {
      u = stripped.slice(0, -4);
      continue;
    }
    u = stripped;
    break;
  }
  return u;
}

// ---------------------------------------------------------------------------
// Secrets: never a positional argument. Read from the environment, or
// prompt on a real terminal — and if neither is available, fail loudly
// rather than hang forever waiting for input that will never come (e.g. a
// CI job, or stdin piped from /dev/null).
// ---------------------------------------------------------------------------

// Pure decision, deliberately separated from any I/O so it is exhaustively
// testable without a real terminal: given what's in the environment and
// whether stdin is a TTY, where should the value come from?
export function resolveSecretSource(envValue, isTTY) {
  const trimmed = (envValue ?? '').trim();
  if (trimmed) return 'env';
  return isTTY ? 'prompt' : 'none';
}

// Prompts on the given (or real) terminal for a value without echoing
// keystrokes. Resolves `null` immediately, without printing anything or
// waiting for input, when the input stream isn't a TTY — this is what keeps
// a non-interactive run (CI, piped stdin) from hanging forever instead of
// failing loudly.
export function promptHidden(promptText, streams = {}) {
  const input = streams.input ?? process.stdin;
  const output = streams.output ?? process.stdout;
  if (!input.isTTY) return Promise.resolve(null);

  return new Promise((resolve) => {
    const rl = createInterface({ input, output, terminal: true, historySize: 0 });
    output.write(promptText);

    // Standard Node idiom for a masked prompt: readline still processes
    // editing keystrokes normally, but nothing it would otherwise echo
    // (including the '' prompt passed to .question() below) reaches the
    // terminal while _writeToOutput is muted.
    const rlAny = /** @type {any} */ (rl);
    const original = rlAny._writeToOutput;
    rlAny._writeToOutput = () => {};

    rl.question('', (answer) => {
      rlAny._writeToOutput = original;
      rl.close();
      output.write('\n');
      resolve(answer);
    });
  });
}

/**
 * @param {{
 *   envValue: string | undefined,
 *   isTTY: boolean,
 *   promptText: string,
 *   promptFn?: (promptText: string, streams?: object) => Promise<string | null>,
 *   streams?: object,
 * }} opts
 */
export async function resolveSecret(opts) {
  const source = resolveSecretSource(opts.envValue, opts.isTTY);
  if (source === 'env') {
    return { ok: true, value: opts.envValue.trim(), source: 'env' };
  }
  if (source === 'prompt') {
    const promptFn = opts.promptFn ?? promptHidden;
    const answer = await promptFn(opts.promptText, opts.streams);
    const trimmed = (answer ?? '').trim();
    if (!trimmed) return { ok: false, reason: 'no value entered at the prompt' };
    return { ok: true, value: trimmed, source: 'prompt' };
  }
  return { ok: false, reason: 'not running on a terminal and no environment variable is set' };
}

// ---------------------------------------------------------------------------
// HTTP operations
// ---------------------------------------------------------------------------

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;

// POST /teams, gated by the instance signup secret (X-Teamshare-Signup-Secret).
export async function createTeamOverHttp(opts) {
  const { url, name, secret, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  const base = normalizeServerUrl(url);
  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      `${base}/teams`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Teamshare-Signup-Secret': secret },
        body: JSON.stringify({ name }),
      },
      timeoutMs,
    );
    const body = await res.json().catch(() => null);
    if (res.ok) {
      return { ok: true, teamId: body && body.team_id, name: body && body.name, token: body && body.token };
    }
    const message = (body && typeof body.error === 'string' && body.error) || `server responded ${res.status}`;
    return { ok: false, status: res.status, message };
  } catch (err) {
    return { ok: false, status: 0, message: `could not reach ${base} (${err && err.message ? err.message : err})` };
  }
}

// POST /teams/rotate, authenticated by the team's *current* token — no
// operator, no signup secret, self-serve.
export async function rotateTeamOverHttp(opts) {
  const { url, token, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  const base = normalizeServerUrl(url);
  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      `${base}/teams/rotate`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      timeoutMs,
    );
    const body = await res.json().catch(() => null);
    if (res.ok) {
      return { ok: true, teamId: body && body.team_id, name: body && body.name, token: body && body.token };
    }
    const message = (body && typeof body.error === 'string' && body.error) || `server responded ${res.status}`;
    return { ok: false, status: res.status, message };
  } catch (err) {
    return { ok: false, status: 0, message: `could not reach ${base} (${err && err.message ? err.message : err})` };
  }
}

// Every surface in this system ends by verifying: call /health and /unread
// with the new token and report the outcome. Every delivery failure here is
// silent by design, so a lead who creates a team and distributes a token
// otherwise has no evidence anything works. When no git identity resolves
// on this machine, the /unread leg (which needs identity headers) is
// skipped rather than sent malformed — the caller still gets the /health
// result and an explicit note of what wasn't checked.
export async function verifyTeam(opts) {
  const { url, token, identity, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  const base = normalizeServerUrl(url);
  const lines = [];
  let healthy = true;

  try {
    const res = await fetchWithTimeout(fetchImpl, `${base}/health`, {}, timeoutMs);
    if (res.ok) lines.push(`[OK] server reachable at ${base}/health`);
    else {
      healthy = false;
      lines.push(`[PROBLEM] ${base}/health responded ${res.status}`);
    }
  } catch (err) {
    healthy = false;
    lines.push(`[PROBLEM] could not reach ${base}/health (${err && err.message ? err.message : err})`);
  }

  if (!identity) {
    lines.push(
      '[INFO] skipped the /unread check — no git identity resolved on this machine. Set it, then run: ' +
        // Env-var form, never positional: `token` here is a real, freshly
        // minted credential, and doctor now accepts TEAMSHARE_URL/
        // TEAMSHARE_TOKEN precisely so this suggestion doesn't put it into
        // shell history or `ps` output the moment someone follows it.
        `TEAMSHARE_URL=${url} TEAMSHARE_TOKEN=${token} teamshare doctor`,
    );
    return { healthy, lines };
  }

  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      `${base}/unread`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Teamshare-Email': identity.email.trim().toLowerCase(),
          'X-Teamshare-Name': identity.name.trim(),
        },
      },
      timeoutMs,
    );
    if (res.status === 200) {
      const body = await res.json().catch(() => null);
      const n = body && typeof body.total === 'number' ? body.total : 'an unknown number of';
      lines.push(`[OK] ${base}/unread returned 200 (${n} unread share(s))`);
    } else {
      healthy = false;
      lines.push(`[PROBLEM] ${base}/unread returned ${res.status} — the new token does not work yet`);
    }
  } catch (err) {
    healthy = false;
    lines.push(`[PROBLEM] could not reach ${base}/unread (${err && err.message ? err.message : err})`);
  }

  return { healthy, lines };
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

// The real join instructions — deliberately the honest, long version, not a
// flattering summary. This is what a lead pastes into Slack; if it
// understates reality (skips workspace trust, the version floor, or the
// restart), teammates hit silent 401s and the lead fields questions all
// afternoon instead. Order matters and is asserted by a test: git identity,
// then the two /plugin commands, then what they'll be prompted for, then
// workspace trust, then the version floor, then the restart, then the
// non-Claude-Code path.
export function formatJoinInstructions(opts) {
  const { url, token } = opts;
  const lines = [
    'Paste this into Slack for your team:',
    '',
    '--- Joining the team in Claude Code ---',
    '',
    '0. Set your global git identity first, if you have not already — nothing works without it,',
    '   because the server rejects every request with a 400 until it is set:',
    '',
    '     git config --global user.name "Your Name"',
    '     git config --global user.email "you@example.com"',
    '',
    '1. In Claude Code, run:',
    '',
    '     /plugin marketplace add abdulgeek/teamshare',
    '     /plugin install teamshare',
    '',
    '2. It will prompt you for two values:',
    `     Server URL:  ${url}`,
    `     Team token:  ${token}`,
    '',
    '3. Trust this workspace when Claude Code asks (accept the trust dialog once). If the workspace',
    '   is not trusted, the headers helper that authenticates the MCP connection is skipped entirely',
    '   and every call fails with 401 — not a bug, just an unmet prerequisite.',
    '',
    '4. Requires Claude Code 2.1.238 or newer (needed for headersHelper support in a plugin\'s',
    '   .mcp.json — the mechanism that supplies those auth headers without a bridge process).',
    '',
    '5. Restart Claude Code (or start a new session) so the plugin install and MCP registration load.',
    '',
    '--- Not using Claude Code? ---',
    '',
    'No clone, no install, no build — grab the one connector file and run it:',
    '',
    '  curl -fsSL https://raw.githubusercontent.com/abdulgeek/teamshare/main/packages/server/src/teamshare-connect.mjs -o teamshare-connect.mjs',
    `  node teamshare-connect.mjs ${url} ${token}`,
  ];
  return lines.join('\n') + '\n';
}

// The plain-language warning every surface must give, verbatim in spirit
// wherever a fresh token is printed: shown once, gone if lost, rotation is
// the only remedy.
export function formatTokenOnceWarning(token) {
  return [
    'Team token (shown once — this cannot be recovered later; save it in a password manager now):',
    '',
    `  ${token}`,
  ].join('\n');
}

export function formatCreateOutput(opts) {
  const { url, team, verify } = opts;
  const lines = [
    'teamshare create-team — success',
    '',
    `Team: ${team.name} (${team.teamId})`,
    '',
    formatTokenOnceWarning(team.token),
    '',
    'Verifying the new token against the live server:',
    '',
    ...verify.lines,
    '',
    // Env-var form, never positional — see the comment in verifyTeam() above,
    // where this same fix was made for the identical suggestion.
    `Re-verify anytime with: TEAMSHARE_URL=${url} TEAMSHARE_TOKEN=${team.token} teamshare doctor`,
    '',
    'If this token is ever lost or leaked, the only remedy is rotation — it invalidates the old',
    `token immediately: node teamshare-team.mjs rotate-team ${url}`,
    '',
    formatJoinInstructions({ url, token: team.token }),
  ];
  return lines.join('\n') + '\n';
}

export function formatRotateOutput(opts) {
  const { url, team, verify } = opts;
  const lines = [
    'teamshare rotate-team — success',
    '',
    `Team: ${team.name} (${team.teamId})`,
    '',
    'The previous token for this team stopped working the instant this ran — every teammate must',
    'reconnect with the new one below.',
    '',
    formatTokenOnceWarning(team.token),
    '',
    'Verifying the new token against the live server:',
    '',
    ...verify.lines,
    '',
    // Env-var form, never positional — see the comment in verifyTeam() above,
    // where this same fix was made for the identical suggestion.
    `Re-verify anytime with: TEAMSHARE_URL=${url} TEAMSHARE_TOKEN=${team.token} teamshare doctor`,
    '',
    formatJoinInstructions({ url, token: team.token }),
  ];
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Argv parsing — a SEPARATE contract from teamshare-connect.mjs's
// parseConnectArgv. Two subcommands (create-team, rotate-team), never a
// secret positional.
// ---------------------------------------------------------------------------

export function parseTeamArgv(argv) {
  const rest = [...argv];
  const parsed = { cmd: undefined, url: undefined, name: undefined, help: false, unknown: undefined };

  if (rest.length === 0 || rest[0] === '--help' || rest[0] === '-h') {
    parsed.help = true;
    return parsed;
  }

  const first = rest.shift();
  if (first === 'create-team') {
    parsed.cmd = 'create-team';
    if (rest[0] !== undefined && !rest[0].startsWith('-')) parsed.url = rest.shift();
    if (rest[0] !== undefined && !rest[0].startsWith('-')) parsed.name = rest.shift();
  } else if (first === 'rotate-team') {
    parsed.cmd = 'rotate-team';
    if (rest[0] !== undefined && !rest[0].startsWith('-')) parsed.url = rest.shift();
  } else {
    parsed.cmd = 'unknown';
    parsed.unknown = first;
  }

  return parsed;
}

const USAGE = `teamshare-team — create a team, or rotate a team's token, on a shared teamshare server

Standalone, dependency-free — no clone, no pnpm install, no build required.
This is the real first-time path: it works before anything else is installed.

Usage:
  node teamshare-team.mjs create-team <server-url> "<team name>"
  node teamshare-team.mjs rotate-team <server-url>

The signup secret (create-team) and the team's current token (rotate-team) are never accepted as
arguments — they would land in shell history and \`ps\` output. Set ${SIGNUP_SECRET_ENV} /
${TEAM_TOKEN_ENV}, or leave it unset and you will be prompted for it on a real terminal (the
value is not echoed back).
`;

function isMainModule() {
  return typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;
}

// The whole CLI, as one pure(-ish) function: argv in, a { exitCode, stdout,
// stderr } result out — never touching process.stdout/stderr/exitCode
// itself. This is what makes the whole pipeline (argv parsing, env-var
// secret resolution, the HTTP calls, verification, and output formatting)
// testable in-process, with an injected fetchImpl pointed at a local test
// server and an injected identity/env/isTTY — the same shape as
// teamshare-connect.mjs's runConnect(). The isMainModule() block below is
// the only place that touches the real process.
/**
 * @param {string[]} argv
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   isTTY?: boolean,
 *   fetchImpl?: typeof fetch,
 *   identity?: GitIdentity | null,
 *   gitIdentityOptions?: { cwd?: string, env?: NodeJS.ProcessEnv },
 *   promptFn?: (promptText: string, streams?: object) => Promise<string | null>,
 *   streams?: object,
 * }} [opts]
 */
export async function runTeamCli(argv, opts = {}) {
  const env = opts.env ?? process.env;
  const isTTY = opts.isTTY ?? Boolean(process.stdin.isTTY);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const identity =
    opts.identity !== undefined ? opts.identity : resolveGitIdentity(opts.gitIdentityOptions);

  const parsed = parseTeamArgv(argv);

  if (parsed.help) {
    return { exitCode: 0, stdout: USAGE, stderr: '' };
  }

  if (parsed.cmd === 'unknown') {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `unknown command "${parsed.unknown}" — expected create-team or rotate-team\n\n${USAGE}`,
    };
  }

  if (parsed.cmd === 'create-team') {
    if (!parsed.url || !parsed.name) {
      return { exitCode: 1, stdout: '', stderr: 'usage: node teamshare-team.mjs create-team <server-url> "<team name>"\n' };
    }

    const secretResult = await resolveSecret({
      envValue: env[SIGNUP_SECRET_ENV],
      isTTY,
      promptText: 'Signup secret (input hidden): ',
      promptFn: opts.promptFn,
      streams: opts.streams,
    });
    if (!secretResult.ok) {
      return {
        exitCode: 1,
        stdout: '',
        stderr:
          `could not resolve the signup secret (${secretResult.reason}). Set ${SIGNUP_SECRET_ENV}, or run ` +
          'this on an interactive terminal so it can prompt you.\n',
      };
    }

    const created = await createTeamOverHttp({
      url: parsed.url,
      name: parsed.name,
      secret: secretResult.value,
      fetchImpl,
    });
    if (!created.ok) {
      return { exitCode: 1, stdout: '', stderr: `failed to create team: ${created.message}\n` };
    }

    const verify = await verifyTeam({ url: parsed.url, token: created.token, identity, fetchImpl });
    return {
      exitCode: verify.healthy ? 0 : 1,
      stdout: formatCreateOutput({ url: parsed.url, team: created, verify }),
      stderr: '',
    };
  }

  if (parsed.cmd === 'rotate-team') {
    if (!parsed.url) {
      return { exitCode: 1, stdout: '', stderr: 'usage: node teamshare-team.mjs rotate-team <server-url>\n' };
    }

    const tokenResult = await resolveSecret({
      envValue: env[TEAM_TOKEN_ENV],
      isTTY,
      promptText: 'Current team token (input hidden): ',
      promptFn: opts.promptFn,
      streams: opts.streams,
    });
    if (!tokenResult.ok) {
      return {
        exitCode: 1,
        stdout: '',
        stderr:
          `could not resolve the current team token (${tokenResult.reason}). Set ${TEAM_TOKEN_ENV}, or run ` +
          'this on an interactive terminal so it can prompt you.\n',
      };
    }

    const rotated = await rotateTeamOverHttp({ url: parsed.url, token: tokenResult.value, fetchImpl });
    if (!rotated.ok) {
      return { exitCode: 1, stdout: '', stderr: `failed to rotate token: ${rotated.message}\n` };
    }

    const verify = await verifyTeam({ url: parsed.url, token: rotated.token, identity, fetchImpl });
    return {
      exitCode: verify.healthy ? 0 : 1,
      stdout: formatRotateOutput({ url: parsed.url, team: rotated, verify }),
      stderr: '',
    };
  }

  // parseTeamArgv only ever returns help / unknown / create-team / rotate-team.
  return { exitCode: 1, stdout: '', stderr: USAGE };
}

if (isMainModule()) {
  runTeamCli(process.argv.slice(2))
    .then(({ exitCode, stdout, stderr }) => {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      process.exitCode = exitCode;
    })
    .catch((err) => {
      process.stderr.write(`teamshare-team: unexpected error: ${err && err.message ? err.message : err}\n`);
      process.exitCode = 1;
    });
}
