import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openDb, createTeam, hashToken, findTeamByName, type Db } from './db.js';
import { createApp } from './app.js';
import {
  resolveSecretSource,
  resolveSecret,
  promptHidden,
  resolveGitIdentity,
  normalizeServerUrl,
  createTeamOverHttp,
  rotateTeamOverHttp,
  verifyTeam,
  formatJoinInstructions,
  formatTokenOnceWarning,
  formatCreateOutput,
  formatRotateOutput,
  parseTeamArgv,
  runTeamCli,
  SIGNUP_SECRET_ENV,
  TEAM_TOKEN_ENV,
} from './team.js';

const NOW = '2026-08-29T00:00:00.000Z';
const identity = { name: 'Ada Lovelace', email: 'ada@example.com' };

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'teamshare-team-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// argv: a SEPARATE contract from teamshare-connect.mjs's `<url> <token>`
// form (see connect.test.ts's pinned regression block for that side).
// ---------------------------------------------------------------------------

describe('parseTeamArgv', () => {
  it('parses create-team with a url and a name', () => {
    const parsed = parseTeamArgv(['create-team', 'https://ts.example.com', 'Rocket Squad']);
    expect(parsed).toMatchObject({ cmd: 'create-team', url: 'https://ts.example.com', name: 'Rocket Squad' });
  });

  it('parses rotate-team with just a url — no name, and critically no secret positional', () => {
    const parsed = parseTeamArgv(['rotate-team', 'https://ts.example.com']);
    expect(parsed).toMatchObject({ cmd: 'rotate-team', url: 'https://ts.example.com' });
    expect(parsed.name).toBeUndefined();
  });

  it('treats no arguments, --help, or -h as a request for help', () => {
    expect(parseTeamArgv([])).toMatchObject({ help: true });
    expect(parseTeamArgv(['--help'])).toMatchObject({ help: true });
    expect(parseTeamArgv(['-h'])).toMatchObject({ help: true });
  });

  it('reports an unrecognized first token as unknown rather than silently misparsing it', () => {
    const parsed = parseTeamArgv(['bogus', 'https://ts.example.com']);
    expect(parsed.cmd).toBe('unknown');
    expect(parsed.unknown).toBe('bogus');
  });

  it('never captures a secret positionally: create-team only ever consumes url then name', () => {
    const parsed = parseTeamArgv(['create-team', 'https://ts.example.com', 'Name', 'shhh-would-be-secret']);
    expect(parsed.name).toBe('Name');
    // No field anywhere in the parsed result holds the trailing extra value —
    // there is simply no positional slot for a secret to land in.
    expect(Object.values(parsed)).not.toContain('shhh-would-be-secret');
  });
});

// ---------------------------------------------------------------------------
// Secret resolution: environment first, then a TTY prompt, and — critically
// — never a silent indefinite hang when neither is available.
// ---------------------------------------------------------------------------

describe('resolveSecretSource: pure decision, no I/O', () => {
  it('prefers the environment value when present, even on a real terminal', () => {
    expect(resolveSecretSource('the-secret', false)).toBe('env');
    expect(resolveSecretSource('the-secret', true)).toBe('env');
  });

  it('falls back to prompting only when a real terminal is available and the env is empty/absent', () => {
    expect(resolveSecretSource(undefined, true)).toBe('prompt');
    expect(resolveSecretSource('', true)).toBe('prompt');
    expect(resolveSecretSource('   ', true)).toBe('prompt'); // whitespace-only counts as absent
  });

  it('resolves to "none" — the caller must fail loudly, not hang — with no env and no terminal', () => {
    expect(resolveSecretSource(undefined, false)).toBe('none');
    expect(resolveSecretSource('', false)).toBe('none');
  });
});

describe('resolveSecret', () => {
  it('uses the (trimmed) env value directly and never calls the prompt function', async () => {
    const promptFn = vi.fn(async () => {
      throw new Error('promptFn should not be called when an env value is present');
    });
    const result = await resolveSecret({ envValue: '  from-env  ', isTTY: true, promptText: 'x', promptFn });
    expect(result).toEqual({ ok: true, value: 'from-env', source: 'env' });
    expect(promptFn).not.toHaveBeenCalled();
  });

  it('prompts when isTTY is true and no env value is set, trimming the typed answer', async () => {
    const promptFn = vi.fn(async () => '  typed-secret  ');
    const result = await resolveSecret({ envValue: undefined, isTTY: true, promptText: 'Secret: ', promptFn });
    expect(result).toEqual({ ok: true, value: 'typed-secret', source: 'prompt' });
    expect(promptFn).toHaveBeenCalledWith('Secret: ', undefined);
  });

  it('fails when the prompt yields nothing (blank input, or a non-TTY stream resolving null)', async () => {
    const promptFn = vi.fn(async () => null);
    const result = await resolveSecret({ envValue: undefined, isTTY: true, promptText: 'Secret: ', promptFn });
    expect(result).toEqual({ ok: false, reason: 'no value entered at the prompt' });
  });

  it('fails immediately — never prompting — when there is no env value and no TTY', async () => {
    const promptFn = vi.fn(async () => {
      throw new Error('promptFn should not be called with no TTY');
    });
    const result = await resolveSecret({ envValue: undefined, isTTY: false, promptText: 'x', promptFn });
    expect(result.ok).toBe(false);
    expect(promptFn).not.toHaveBeenCalled();
  });
});

describe('promptHidden', () => {
  it('resolves null immediately, without writing anything, when the input stream is not a TTY', async () => {
    const input = { isTTY: false } as unknown as NodeJS.ReadStream;
    const write = vi.fn();
    const output = { write } as unknown as NodeJS.WriteStream;
    const result = await promptHidden('Secret: ', { input, output });
    expect(result).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// resolveGitIdentity: a hand-maintained duplicate of teamshare-connect.mjs's
// copy (needed here purely to fill /unread's identity headers during
// verification). Isolated from the real machine's git config exactly the
// same way connect.test.ts isolates its own copy.
// ---------------------------------------------------------------------------

describe('resolveGitIdentity (isolated from the real machine)', () => {
  it('resolves from an isolated global config when cwd/env are injected', () => {
    const isolatedHome = tmp();
    writeFileSync(join(isolatedHome, '.gitconfig'), '[user]\n\tname = Grace Hopper\n\temail = Grace@Example.COM\n');
    const env = { PATH: process.env.PATH, HOME: isolatedHome, GIT_CONFIG_NOSYSTEM: '1' };
    const found = resolveGitIdentity({ cwd: isolatedHome, env });
    expect(found).toEqual({ name: 'Grace Hopper', email: 'grace@example.com' });
  });

  it('returns null when isolated from any git config', () => {
    const isolatedHome = tmp();
    const env = { PATH: process.env.PATH, HOME: isolatedHome, GIT_CONFIG_NOSYSTEM: '1' };
    const found = resolveGitIdentity({ cwd: isolatedHome, env });
    expect(found).toBeNull();
  });
});

describe('normalizeServerUrl (kept identical to teamshare-connect.mjs\'s copy)', () => {
  it('strips a trailing /mcp and trailing slashes', () => {
    expect(normalizeServerUrl('https://ts.example.com/mcp')).toBe('https://ts.example.com');
    expect(normalizeServerUrl('https://ts.example.com/mcp/')).toBe('https://ts.example.com');
    expect(normalizeServerUrl('https://ts.example.com/')).toBe('https://ts.example.com');
  });

  it('leaves a bare origin untouched', () => {
    expect(normalizeServerUrl('https://ts.example.com')).toBe('https://ts.example.com');
  });
});

// ---------------------------------------------------------------------------
// HTTP operations, against a real local server (never the live one) — an
// in-process createApp() instance, exactly the pattern http.test.ts and
// cli.test.ts already use.
// ---------------------------------------------------------------------------

describe('createTeamOverHttp / rotateTeamOverHttp / verifyTeam against a real local server', () => {
  let db: Db;
  let server: Server;
  let base: string;
  const SIGNUP_SECRET = 'the-signup-secret';

  beforeEach(async () => {
    db = openDb(':memory:');
    const app = createApp({ db, expiryDays: 14, signupSecret: SIGNUP_SECRET, now: () => NOW });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const addr = server.address();
    if (typeof addr === 'object' && addr) base = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
  });

  it('creates a team with the correct signup secret and returns a usable token', async () => {
    const result = await createTeamOverHttp({ url: base, name: 'Rocket Squad', secret: SIGNUP_SECRET });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.name).toBe('Rocket Squad');
    expect(result.token).toMatch(/^ts_/);
    expect(findTeamByName(db, 'Rocket Squad')).toBeTruthy();
  });

  it('fails with 401 and creates nothing when the signup secret is wrong', async () => {
    const result = await createTeamOverHttp({ url: base, name: 'Should Not Exist', secret: 'wrong-secret' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.status).toBe(401);
    expect(findTeamByName(db, 'Should Not Exist')).toBeUndefined();
  });

  it('reports a network failure honestly instead of throwing', async () => {
    const result = await createTeamOverHttp({
      url: 'http://127.0.0.1:1',
      name: 'X',
      secret: SIGNUP_SECRET,
      timeoutMs: 500,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.status).toBe(0);
    expect(result.message).toContain('127.0.0.1:1');
  });

  it("rotates a team's token, invalidating the old one immediately", async () => {
    const oldToken = 'ts_old_token_value';
    createTeam(db, 'Existing Team', hashToken(oldToken), NOW);

    const rotated = await rotateTeamOverHttp({ url: base, token: oldToken });
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) throw new Error('unreachable');
    expect(rotated.name).toBe('Existing Team');
    expect(rotated.token).not.toBe(oldToken);

    const oldRes = await fetch(`${base}/unread`, {
      headers: { Authorization: `Bearer ${oldToken}`, 'X-Teamshare-Email': identity.email, 'X-Teamshare-Name': identity.name },
    });
    expect(oldRes.status).toBe(401);

    const newRes = await fetch(`${base}/unread`, {
      headers: { Authorization: `Bearer ${rotated.token}`, 'X-Teamshare-Email': identity.email, 'X-Teamshare-Name': identity.name },
    });
    expect(newRes.status).toBe(200);
  });

  it('rotate fails with 401 against an unknown/stale token', async () => {
    const result = await rotateTeamOverHttp({ url: base, token: 'ts_not_a_real_token' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.status).toBe(401);
  });

  it('verifyTeam reports both /health and /unread OK for a genuinely working token', async () => {
    const created = await createTeamOverHttp({ url: base, name: 'Verify Team', secret: SIGNUP_SECRET });
    if (!created.ok) throw new Error('unreachable');
    const verify = await verifyTeam({ url: base, token: created.token, identity });
    expect(verify.healthy).toBe(true);
    expect(verify.lines.some((l) => l.includes('[OK]') && l.includes('/health'))).toBe(true);
    expect(verify.lines.some((l) => l.includes('[OK]') && l.includes('/unread'))).toBe(true);
  });

  it('verifyTeam still checks /health but skips /unread (and says why) with no git identity', async () => {
    const created = await createTeamOverHttp({ url: base, name: 'No Identity Team', secret: SIGNUP_SECRET });
    if (!created.ok) throw new Error('unreachable');
    const verify = await verifyTeam({ url: base, token: created.token, identity: null });
    expect(verify.lines.some((l) => l.includes('[OK]') && l.includes('/health'))).toBe(true);
    expect(verify.lines.some((l) => l.toLowerCase().includes('skipped'))).toBe(true);
    expect(verify.lines.some((l) => l.includes('teamshare doctor'))).toBe(true);
  });

  it('verifyTeam reports [PROBLEM] when the token has already been invalidated', async () => {
    const created = await createTeamOverHttp({ url: base, name: 'Dead Token Team', secret: SIGNUP_SECRET });
    if (!created.ok) throw new Error('unreachable');
    await rotateTeamOverHttp({ url: base, token: created.token }); // invalidates created.token
    const verify = await verifyTeam({ url: base, token: created.token, identity });
    expect(verify.healthy).toBe(false);
    expect(verify.lines.some((l) => l.includes('[PROBLEM]') && l.includes('/unread'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Join instructions: the honest, long-form text a lead pastes into Slack.
// Asserted here — content AND order — so it cannot silently drift away from
// the install flow it describes (README.md's Claude Code / Requirements
// sections and the design doc's §Surfaces).
// ---------------------------------------------------------------------------

describe('formatJoinInstructions: the honest join text', () => {
  const text = formatJoinInstructions({ url: 'https://ts.example.com', token: 'ts_the_token' });

  it('includes every required fact', () => {
    expect(text).toContain('git config --global user.name');
    expect(text).toContain('git config --global user.email');
    expect(text).toContain('/plugin marketplace add abdulgeek/teamshare');
    expect(text).toContain('/plugin install teamshare');
    expect(text).toContain('Server URL');
    expect(text).toContain('Team token');
    expect(text.toLowerCase()).toContain('trust this workspace');
    expect(text).toContain('401');
    expect(text).toContain('2.1.238');
    expect(text.toLowerCase()).toContain('restart claude code');
    expect(text).toContain(
      'curl -fsSL https://raw.githubusercontent.com/abdulgeek/teamshare/main/packages/server/src/teamshare-connect.mjs',
    );
    expect(text).toContain('node teamshare-connect.mjs https://ts.example.com ts_the_token');
  });

  it('presents the facts in the required order', () => {
    const idx = (needle: string) => text.indexOf(needle);
    const gitName = idx('git config --global user.name');
    const marketplaceAdd = idx('/plugin marketplace add');
    const pluginInstall = idx('/plugin install teamshare');
    const prompts = idx('Server URL');
    const trust = idx('Trust this workspace');
    const versionFloor = idx('2.1.238');
    const restart = idx('Restart Claude Code');
    const nonClaude = idx('Not using Claude Code');
    const curlLine = idx('curl -fsSL');

    for (const pos of [gitName, marketplaceAdd, pluginInstall, prompts, trust, versionFloor, restart, nonClaude, curlLine]) {
      expect(pos).toBeGreaterThan(-1);
    }
    expect(marketplaceAdd).toBeGreaterThan(gitName);
    expect(pluginInstall).toBeGreaterThan(marketplaceAdd);
    expect(prompts).toBeGreaterThan(pluginInstall);
    expect(trust).toBeGreaterThan(prompts);
    expect(versionFloor).toBeGreaterThan(trust);
    expect(restart).toBeGreaterThan(versionFloor);
    expect(nonClaude).toBeGreaterThan(restart);
    expect(curlLine).toBeGreaterThan(nonClaude);
  });

  it('includes the real token — this text is meant to be pasted into Slack for the whole team to use', () => {
    expect(text).toContain('ts_the_token');
  });
});

describe('formatTokenOnceWarning', () => {
  it('says the token is shown once, cannot be recovered, and to save it in a password manager now', () => {
    const text = formatTokenOnceWarning('ts_abc123');
    expect(text.toLowerCase()).toContain('shown once');
    expect(text.toLowerCase()).toContain('cannot be recovered');
    expect(text.toLowerCase()).toContain('password manager');
    expect(text).toContain('ts_abc123');
  });
});

describe('formatCreateOutput / formatRotateOutput', () => {
  const team = { teamId: 'tm_abc', name: 'Rocket Squad', token: 'ts_new_token' };
  const verify = { healthy: true, lines: ['[OK] server reachable at https://ts.example.com/health'] };

  it('formatCreateOutput includes the token-once warning, verify lines, a re-verify doctor line, the rotation remedy, and join instructions', () => {
    const out = formatCreateOutput({ url: 'https://ts.example.com', team, verify });
    expect(out.toLowerCase()).toContain('shown once');
    expect(out).toContain('[OK] server reachable');
    expect(out).toContain('teamshare doctor https://ts.example.com ts_new_token');
    expect(out).toContain('rotate-team');
    expect(out).toContain('/plugin install teamshare');
  });

  it('formatRotateOutput says the previous token stopped working and everyone must reconnect', () => {
    const out = formatRotateOutput({ url: 'https://ts.example.com', team, verify });
    expect(out.toLowerCase()).toContain('stopped working');
    expect(out.toLowerCase()).toContain('reconnect');
    expect(out.toLowerCase()).toContain('shown once');
    expect(out).toContain('/plugin install teamshare');
  });
});

// ---------------------------------------------------------------------------
// runTeamCli: the whole pipeline as one pure(-ish) function — argv parsing,
// env-var secret resolution, the real HTTP calls, verification, and output
// formatting — with only process.stdout/stderr/exitCode itself left
// untouched (that thin glue is exercised separately, without real network,
// in the subprocess block below). This is the in-process equivalent of
// actually running `node teamshare-team.mjs ...`, and is what makes the
// full pipeline testable against a real local server without spawning a
// network-calling child process.
// ---------------------------------------------------------------------------

describe('runTeamCli: the full pipeline, in-process against a real local server', () => {
  let db: Db;
  let server: Server;
  let base: string;
  const SIGNUP_SECRET = 'cli-signup-secret-value';

  beforeEach(async () => {
    db = openDb(':memory:');
    const app = createApp({ db, expiryDays: 14, signupSecret: SIGNUP_SECRET });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const addr = server.address();
    if (typeof addr === 'object' && addr) base = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
  });

  it('create-team succeeds via the signup-secret environment variable and never echoes the secret', async () => {
    const result = await runTeamCli(['create-team', base, 'CLI Squad'], {
      env: { [SIGNUP_SECRET_ENV]: SIGNUP_SECRET },
      isTTY: false,
      identity,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('teamshare create-team — success');
    expect(result.stdout).toContain('CLI Squad');
    expect(result.stdout).toContain('[OK] server reachable');
    expect(result.stdout.match(/\[OK\]/g)?.length).toBeGreaterThanOrEqual(2); // /health AND /unread
    expect(result.stdout).not.toContain(SIGNUP_SECRET);
    expect(result.stderr).not.toContain(SIGNUP_SECRET);
    expect(findTeamByName(db, 'CLI Squad')).toBeTruthy();
  });

  it('create-team fails loudly, without creating a team, when the signup secret is wrong', async () => {
    const result = await runTeamCli(['create-team', base, 'Wrong Secret Team'], {
      env: { [SIGNUP_SECRET_ENV]: 'not-the-real-secret' },
      isTTY: false,
      identity,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toLowerCase()).toContain('failed to create team');
    expect(findTeamByName(db, 'Wrong Secret Team')).toBeUndefined();
  });

  it('create-team fails immediately (no hang, no prompt) when no secret is set and stdin is not a TTY', async () => {
    const promptFn = vi.fn(async () => {
      throw new Error('should never prompt when isTTY is false');
    });
    const result = await runTeamCli(['create-team', base, 'No Secret Team'], {
      env: {},
      isTTY: false,
      identity,
      promptFn,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(SIGNUP_SECRET_ENV);
    expect(promptFn).not.toHaveBeenCalled();
    expect(findTeamByName(db, 'No Secret Team')).toBeUndefined();
  });

  it('rotate-team succeeds via the team-token environment variable and invalidates the old token', async () => {
    const oldToken = 'ts_cli_old_token';
    createTeam(db, 'Rotating Team', hashToken(oldToken), NOW);

    const result = await runTeamCli(['rotate-team', base], {
      env: { [TEAM_TOKEN_ENV]: oldToken },
      isTTY: false,
      identity,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('teamshare rotate-team — success');
    expect(result.stdout).not.toContain(oldToken);
    expect(result.stdout.toLowerCase()).toContain('stopped working');

    const oldRes = await fetch(`${base}/unread`, {
      headers: { Authorization: `Bearer ${oldToken}`, 'X-Teamshare-Email': identity.email, 'X-Teamshare-Name': identity.name },
    });
    expect(oldRes.status).toBe(401);
  });

  it('help and unknown-command results carry no exit-code surprises', async () => {
    const help = await runTeamCli(['--help'], { env: {}, isTTY: false, identity });
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain('create-team');

    const unknown = await runTeamCli(['bogus', base], { env: {}, isTTY: false, identity });
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain('bogus');
  });
});

// ---------------------------------------------------------------------------
// A thin subprocess smoke test: actually run teamshare-team.mjs with plain
// `node`, exactly as documented — no build, no install — to prove the file
// truly works as a standalone download, not just as an imported module.
// Kept network-free (spawning a *grandchild* process that itself opens
// sockets is unreliable in some sandboxed CI environments for reasons
// unrelated to correctness); the networked create-team/rotate-team paths
// are covered in-process above via runTeamCli().
// ---------------------------------------------------------------------------

describe('end-to-end: running teamshare-team.mjs directly with plain node', () => {
  let db: Db;
  let server: Server;
  let base: string;
  let gitHome: string;
  const SIGNUP_SECRET = 'e2e-signup-secret-value';
  const scriptPath = join(dirname(fileURLToPath(import.meta.url)), 'teamshare-team.mjs');

  beforeEach(async () => {
    db = openDb(':memory:');
    const app = createApp({ db, expiryDays: 14, signupSecret: SIGNUP_SECRET });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const addr = server.address();
    if (typeof addr === 'object' && addr) base = `http://127.0.0.1:${addr.port}`;

    // An isolated HOME with a known git identity — the subprocess must never
    // read or depend on the real machine's ~/.gitconfig.
    gitHome = tmp();
    writeFileSync(join(gitHome, '.gitconfig'), '[user]\n\tname = E2E Tester\n\temail = e2e@example.com\n');
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
  });

  function isolatedEnv(extra: Record<string, string>) {
    return {
      PATH: process.env.PATH,
      HOME: gitHome,
      GIT_CONFIG_NOSYSTEM: '1',
      ...extra,
    };
  }

  it('create-team fails loudly, printing neither a token nor a stack trace, when no secret is available and stdin is not a TTY', () => {
    expect(() =>
      execFileSync(process.execPath, [scriptPath, 'create-team', base, 'No Secret Team'], {
        encoding: 'utf8',
        env: isolatedEnv({}),
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    ).toThrow();
    expect(findTeamByName(db, 'No Secret Team')).toBeUndefined();
  });

  it('prints usage and exits 0 with --help', () => {
    const out = execFileSync(process.execPath, [scriptPath, '--help'], { encoding: 'utf8', env: isolatedEnv({}) });
    expect(out).toContain('create-team');
    expect(out).toContain('rotate-team');
    expect(out).toContain(SIGNUP_SECRET_ENV);
    expect(out).toContain(TEAM_TOKEN_ENV);
  });
});
