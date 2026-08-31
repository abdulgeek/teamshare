import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openDb, createTeam, hashToken, findTeamByName, makeTeamScope, createMemberToken, type Db } from './db.js';
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
  inviteMemberOverHttp,
  revokeMemberOverHttp,
  getRosterOverHttp,
  formatJoinInstructions,
  formatTokenOnceWarning,
  formatAdminTokenGuidance,
  formatCreateOutput,
  formatRotateOutput,
  formatMemberTokenOnceWarning,
  formatInviteOutput,
  formatRevokeOutput,
  formatRosterOutput,
  parseTeamArgv,
  runTeamCli,
  SIGNUP_SECRET_ENV,
  TEAM_TOKEN_ENV,
  ADMIN_TOKEN_ENV,
  SERVER_URL_ENV,
  DEFAULT_SERVER_URL,
  adminTokenFromEnv,
  looksLikeServerUrl,
  invocationName,
  resolveServerUrl,
  readAdminStore,
  readBundledMcpUrl,
  readSignupSecretFile,
  adminEntriesFor,
  adminStorePath,
  saveAdminEntry,
  resolveAdminTokenFromStore,
  resolveMemberToken,
  formatWhoamiOutput,
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

  it('parses invite with a url, email, and optional name — never a secret positional', () => {
    const withName = parseTeamArgv(['invite', 'https://ts.example.com', 'sam@team.com', 'Sam']);
    expect(withName).toMatchObject({ cmd: 'invite', url: 'https://ts.example.com', email: 'sam@team.com', name: 'Sam' });

    const withoutName = parseTeamArgv(['invite', 'https://ts.example.com', 'sam@team.com']);
    expect(withoutName).toMatchObject({ cmd: 'invite', url: 'https://ts.example.com', email: 'sam@team.com' });
    expect(withoutName.name).toBeUndefined();
  });

  it('parses revoke with a url and email', () => {
    const parsed = parseTeamArgv(['revoke', 'https://ts.example.com', 'sam@team.com']);
    expect(parsed).toMatchObject({ cmd: 'revoke', url: 'https://ts.example.com', email: 'sam@team.com' });
  });

  it('parses roster with just a url', () => {
    const parsed = parseTeamArgv(['roster', 'https://ts.example.com']);
    expect(parsed).toMatchObject({ cmd: 'roster', url: 'https://ts.example.com' });
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

    // The old ADMIN token must genuinely stop working on another
    // admin-authenticated route (POST /teams/rotate again), not merely
    // "never worked on /unread" — an admin token never grants /unread
    // access at all, with or without rotation, so that route can't prove
    // anything about rotation specifically.
    const oldRes = await fetch(`${base}/teams/rotate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${oldToken}` },
    });
    expect(oldRes.status).toBe(401);

    const newRes = await fetch(`${base}/members`, {
      headers: { Authorization: `Bearer ${rotated.token}` },
    });
    expect(newRes.status).toBe(200);
  });

  it('rotate fails with 401 against an unknown/stale token', async () => {
    const result = await rotateTeamOverHttp({ url: base, token: 'ts_not_a_real_token' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.status).toBe(401);
  });

  it('verifyTeam reports both /health and /members OK for a genuinely working admin token', async () => {
    const created = await createTeamOverHttp({ url: base, name: 'Verify Team', secret: SIGNUP_SECRET });
    if (!created.ok) throw new Error('unreachable');
    const verify = await verifyTeam({ url: base, token: created.token, identity });
    expect(verify.healthy).toBe(true);
    expect(verify.lines.some((l) => l.includes('[OK]') && l.includes('/health'))).toBe(true);
    expect(verify.lines.some((l) => l.includes('[OK]') && l.includes('/members'))).toBe(true);
  });

  it('verifyTeam checks /health and /members the same way with no git identity — neither leg needs one', async () => {
    // Unlike the pre-invites /unread check, verifying an ADMIN token needs no
    // per-user identity at all, so there is no "skip this leg" branch left —
    // this is now the same check whether or not a git identity resolves.
    const created = await createTeamOverHttp({ url: base, name: 'No Identity Team', secret: SIGNUP_SECRET });
    if (!created.ok) throw new Error('unreachable');
    const verify = await verifyTeam({ url: base, token: created.token, identity: null });
    expect(verify.healthy).toBe(true);
    expect(verify.lines.some((l) => l.includes('[OK]') && l.includes('/health'))).toBe(true);
    expect(verify.lines.some((l) => l.includes('[OK]') && l.includes('/members'))).toBe(true);
  });

  it('verifyTeam reports [PROBLEM] when the token has already been invalidated', async () => {
    const created = await createTeamOverHttp({ url: base, name: 'Dead Token Team', secret: SIGNUP_SECRET });
    if (!created.ok) throw new Error('unreachable');
    await rotateTeamOverHttp({ url: base, token: created.token }); // invalidates created.token
    const verify = await verifyTeam({ url: base, token: created.token, identity });
    expect(verify.healthy).toBe(false);
    expect(verify.lines.some((l) => l.includes('[PROBLEM]') && l.includes('/members'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// inviteMemberOverHttp / revokeMemberOverHttp / getRosterOverHttp: the
// standalone-script equivalents of POST /invites, POST /revoke, GET
// /members — the day-to-day admin operations a lead can run with only the
// admin token, no AWS/SSH access to the server box.
// ---------------------------------------------------------------------------

describe('inviteMemberOverHttp / revokeMemberOverHttp / getRosterOverHttp against a real local server', () => {
  let db: Db;
  let server: Server;
  let base: string;
  let adminToken: string;

  beforeEach(async () => {
    db = openDb(':memory:');
    adminToken = 'ts_team_http_admin';
    createTeam(db, 'HTTP Ops Team', hashToken(adminToken), NOW);
    const app = createApp({ db, expiryDays: 14, now: () => NOW });
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

  it('invites a member, and the returned token genuinely works', async () => {
    const invited = await inviteMemberOverHttp({ url: base, adminToken, email: 'sam@team.com', name: 'Sam' });
    expect(invited.ok).toBe(true);
    if (!invited.ok) throw new Error('unreachable');
    expect(invited.email).toBe('sam@team.com');
    expect(invited.name).toBe('Sam');

    const check = await fetch(`${base}/unread`, { headers: { Authorization: `Bearer ${invited.token}` } });
    expect(check.status).toBe(200);
  });

  it('fails with 401 and mints nothing when the admin token is wrong', async () => {
    const result = await inviteMemberOverHttp({ url: base, adminToken: 'ts_wrong', email: 'sam@team.com' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    // Assert the message too, not just the code. /invites can only answer 401,
    // 400, 429 or 201 — so a 403 here (seen once) did not come from this
    // server at all, and a bare status mismatch gives no hint of that. The
    // message makes a wrong-server response name itself.
    expect(result.message, `unexpected ${result.status} from ${base}`).toMatch(/token|auth/i);
    expect(result.status).toBe(401);
  });

  it('revokes every live token for an email', async () => {
    const invited = await inviteMemberOverHttp({ url: base, adminToken, email: 'sam@team.com' });
    if (!invited.ok) throw new Error('unreachable');

    const revoked = await revokeMemberOverHttp({ url: base, adminToken, email: 'sam@team.com' });
    expect(revoked.ok).toBe(true);
    if (!revoked.ok) throw new Error('unreachable');
    expect(revoked.revoked).toBe(1);

    const check = await fetch(`${base}/unread`, { headers: { Authorization: `Bearer ${invited.token}` } });
    expect(check.status).toBe(401);
  });

  it('fetches the roster, reflecting an invited member as active', async () => {
    const invited = await inviteMemberOverHttp({ url: base, adminToken, email: 'sam@team.com', name: 'Sam' });
    if (!invited.ok) throw new Error('unreachable');
    await fetch(`${base}/unread`, { headers: { Authorization: `Bearer ${invited.token}` } }); // "connects" once

    const roster = await getRosterOverHttp({ url: base, adminToken });
    expect(roster.ok).toBe(true);
    if (!roster.ok) throw new Error('unreachable');
    expect(roster.team).toBe('HTTP Ops Team');
    const sam = roster.members.find((m) => m.email === 'sam@team.com');
    expect(sam?.status).toBe('active');
  });

  it('reports a network failure honestly instead of throwing, for all three operations', async () => {
    const badUrl = 'http://127.0.0.1:1';
    const invited = await inviteMemberOverHttp({ url: badUrl, adminToken, email: 'x@y.com', timeoutMs: 500 });
    const revoked = await revokeMemberOverHttp({ url: badUrl, adminToken, email: 'x@y.com', timeoutMs: 500 });
    const roster = await getRosterOverHttp({ url: badUrl, adminToken, timeoutMs: 500 });
    for (const result of [invited, revoked, roster]) {
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.status).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Output formatting for invite/revoke/roster.
// ---------------------------------------------------------------------------

describe('formatMemberTokenOnceWarning / formatInviteOutput / formatRevokeOutput / formatRosterOutput', () => {
  it('formatMemberTokenOnceWarning names the email, says shown once, and includes the token', () => {
    const text = formatMemberTokenOnceWarning('sam@team.com', 'tsm_abc123');
    expect(text).toContain('sam@team.com');
    expect(text.toLowerCase()).toContain('shown once');
    expect(text).toContain('tsm_abc123');
  });

  it('formatInviteOutput tells the lead to send the token privately, and includes join instructions', () => {
    const out = formatInviteOutput({ url: DEFAULT_SERVER_URL, email: 'sam@team.com', name: 'Sam', token: 'tsm_the_token' });
    expect(out.toLowerCase()).toContain('send this token privately');
    expect(out).toContain('sam@team.com');
    expect(out).toContain('tsm_the_token');
    expect(out).toContain('/plugin install teamshare');
  });

  it('formatInviteOutput routes a self-hosted team to the connector instead of the plugin', () => {
    const out = formatInviteOutput({ url: 'https://ts.example.com', email: 'sam@team.com', name: 'Sam', token: 'tsm_the_token' });
    expect(out).toContain('node teamshare-connect.mjs https://ts.example.com');
    expect(out).not.toContain('/plugin install teamshare');
  });

  it('formatRevokeOutput reports a positive count as revoked, and zero as nothing to revoke', () => {
    const some = formatRevokeOutput({ email: 'sam@team.com', revoked: 2 });
    expect(some).toContain('Revoked 2 live token(s)');
    expect(some).toContain('sam@team.com');

    const none = formatRevokeOutput({ email: 'nobody@team.com', revoked: 0 });
    expect(none.toLowerCase()).toContain('nothing to revoke');
  });

  it('formatRosterOutput lists each member with their status, active token count, and last-seen', () => {
    const out = formatRosterOutput({
      team: 'Rocket Squad',
      members: [
        { email: 'sam@team.com', name: 'Sam', status: 'active', active_tokens: 1, first_seen: NOW, last_seen: NOW },
        { email: 'legacy@team.com', name: null, status: 'invited, not yet active', active_tokens: 0, first_seen: null, last_seen: null },
      ],
    });
    expect(out).toContain('Rocket Squad');
    expect(out).toContain('sam@team.com');
    expect(out).toContain('active');
    expect(out).toContain('legacy@team.com');
    expect(out).toContain('invited, not yet active');
    expect(out).toContain('never connected');
  });

  it('formatRosterOutput handles an empty roster without crashing', () => {
    const out = formatRosterOutput({ team: 'Empty Team', members: [] });
    expect(out).toContain('Empty Team');
  });
});

// ---------------------------------------------------------------------------
// Join instructions: the honest, long-form text a lead pastes into Slack.
// Asserted here — content AND order — so it cannot silently drift away from
// the install flow it describes (README.md's Claude Code / Requirements
// sections and the design doc's §Surfaces).
// ---------------------------------------------------------------------------

describe('formatJoinInstructions: the honest join text', () => {
  // The DEFAULT server, deliberately: this is the path essentially every
  // teammate takes, and it is the one where the Claude Code plugin works,
  // because the plugin has that address compiled into its .mcp.json. The
  // self-hosted branch is a separate describe below.
  const text = formatJoinInstructions({ url: DEFAULT_SERVER_URL, token: 'ts_the_token' });

  it('includes every required fact', () => {
    // Per-email invites (docs/superpowers/specs/2026-08-30-teamshare-invites-design.md)
    // moved identity into the personal token itself, so there is no longer a
    // git-config prerequisite step here — pinning its absence so it cannot
    // silently creep back in as a required first step.
    expect(text).not.toContain('git config --global user.name');
    expect(text).not.toContain('git config --global user.email');
    expect(text.toLowerCase()).toContain('who you are comes');
    expect(text.toLowerCase()).toContain('attribution trustworthy');
    expect(text).toContain('/plugin marketplace add abdulgeek/teamshare');
    expect(text).toContain('/plugin install teamshare');
    // The server address is compiled into the plugin's .mcp.json, so install
    // prompts for exactly one value. Pinning the absence of a "Server URL"
    // field stops the second prompt creeping back into the instructions and
    // sending teammates hunting for a value nobody needs to hand out.
    expect(text).not.toContain('Server URL');
    expect(text.toLowerCase()).toContain('asks for one value');
    // The label pinned here is "Personal token", not "Team token" — this
    // value is minted for one named person (create-team/rotate-team's admin
    // token or invite's member token) and must never be posted somewhere the
    // whole team can see it.
    //
    // These instructions used to carry a caveat that the Claude Code prompt
    // itself was still titled "Team token" and should be ignored. That label
    // has since been corrected in plugin.json to "Your personal token", so
    // the caveat became a lie in the opposite direction — telling the reader
    // to disregard a field that now says exactly the right thing. The second
    // assertion pins its absence so it cannot be reintroduced.
    expect(text).toContain('Personal token');
    expect(text).not.toContain('still labeled "Team token"');
    expect(text.toLowerCase()).toContain('personal to you');
    expect(text.toLowerCase()).toContain('must not be shared');
    expect(text.toLowerCase()).toContain('trust this workspace');
    expect(text).toContain('401');
    expect(text).toContain('2.1.238');
    expect(text.toLowerCase()).toContain('restart claude code');
    expect(text).toContain(
      'curl -fsSL https://raw.githubusercontent.com/abdulgeek/teamshare/main/packages/server/src/teamshare-connect.mjs',
    );
    // The ready-to-run line must NOT carry the token positionally — that
    // would put a teammate's personal credential in their shell history the
    // moment they paste it, the one thing every other secret in this project
    // (signup secret, admin token) is deliberately kept out of. It prompts
    // for the token instead; this line stays copy-paste-runnable with just
    // the url.
    // The connector takes no arguments on the default server either — same
    // reason. And the token is never passed positionally: that would put a
    // teammate's personal credential into their shell history the moment they
    // paste it, the one thing every other secret here is kept out of.
    expect(text).toContain('node teamshare-connect.mjs\n');
    expect(text).not.toContain('node teamshare-connect.mjs ts_the_token');
    expect(text.toLowerCase()).toContain('prompt for your personal token');
  });

  it('presents the facts in the required order', () => {
    const idx = (needle: string) => text.indexOf(needle);
    const marketplaceAdd = idx('/plugin marketplace add');
    const pluginInstall = idx('/plugin install teamshare');
    const prompts = idx('Personal token:');
    const trust = idx('Trust this workspace');
    const versionFloor = idx('2.1.238');
    const restart = idx('Restart Claude Code');
    const nonClaude = idx('Not using Claude Code');
    const curlLine = idx('curl -fsSL');

    for (const pos of [marketplaceAdd, pluginInstall, prompts, trust, versionFloor, restart, nonClaude, curlLine]) {
      expect(pos).toBeGreaterThan(-1);
    }
    expect(pluginInstall).toBeGreaterThan(marketplaceAdd);
    expect(prompts).toBeGreaterThan(pluginInstall);
    expect(trust).toBeGreaterThan(prompts);
    expect(versionFloor).toBeGreaterThan(trust);
    expect(restart).toBeGreaterThan(versionFloor);
    expect(nonClaude).toBeGreaterThan(restart);
    expect(curlLine).toBeGreaterThan(nonClaude);
  });

  it('includes the real token — this text is meant to be pasted (or sent privately) to one specific recipient', () => {
    expect(text).toContain('ts_the_token');
  });
});

describe('formatJoinInstructions: a team on its own server', () => {
  // The Claude Code plugin's .mcp.json carries the default address as static
  // JSON, and nothing in a plugin can rewrite it per-install. So a self-hosted
  // team told to "install the plugin" would end up with a client permanently
  // pointed at the wrong server, failing with a 401 indistinguishable from a
  // bad token. This text must route them to the connector instead.
  const text = formatJoinInstructions({ url: 'https://ts.example.com', token: 'ts_the_token' });

  it('sends them to the connector, not the plugin', () => {
    expect(text).toContain('node teamshare-connect.mjs https://ts.example.com');
    expect(text).not.toContain('/plugin install teamshare');
    expect(text).not.toContain('/plugin marketplace add');
  });

  it('still states the facts that hold on every path', () => {
    expect(text).toContain('ts_the_token');
    expect(text.toLowerCase()).toContain('who you are comes');
    expect(text.toLowerCase()).toContain('attribution trustworthy');
    expect(text.toLowerCase()).toContain('personal to you');
    expect(text.toLowerCase()).toContain('must not be shared');
  });

  it('never passes the token positionally', () => {
    expect(text).not.toContain('teamshare-connect.mjs https://ts.example.com ts_the_token');
  });

  it('never claims the connector configures Claude Code, because it does not', () => {
    // The connector writes MCP config for Cursor, VS Code, Windsurf, Gemini
    // CLI, Cline, Codex, Zed and Continue. Claude Code's teamshare config
    // lives in the plugin's own .mcp.json and the connector never touches it,
    // so telling a Claude Code user to run it sends them through a command
    // that changes nothing they use. This text got that wrong once.
    expect(text).not.toMatch(/connector[^.]*Claude Code/i);
    expect(text).not.toMatch(/configures Claude Code/i);
    // It must still tell a Claude Code user what to actually do.
    expect(text).toContain('fork');
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

  it('formatCreateOutput includes the token-once warning, verify lines, a re-verify doctor line, and the rotation remedy — but never join instructions for the admin token', () => {
    const out = formatCreateOutput({ url: 'https://ts.example.com', team, verify });
    expect(out.toLowerCase()).toContain('shown once');
    expect(out).toContain('[OK] server reachable');
    // The re-verify suggestion used to be a `teamshare doctor` line carrying
    // TEAMSHARE_URL and the live token inline. `whoami` replaces it: it reads
    // the saved store, so the command names no credential at all — and unlike
    // doctor it needs no checkout of this repo to run.
    expect(out).toContain('teamshare-team whoami');
    expect(out).not.toContain('TEAMSHARE_TOKEN=ts_new_token');
    expect(out).not.toContain('teamshare doctor https://ts.example.com ts_new_token');
    expect(out).toContain('rotate-team');
    // This mints the ADMIN token — authenticate() never accepts it, so it
    // 401s on every data route and on the MCP connection. It cannot be used
    // to join, so this output must never say "here's how to join" next to
    // it (regression test for the defect: both create-team and rotate-team
    // used to append the real join instructions with this very token).
    expect(out).not.toContain('/plugin marketplace add');
    expect(out).not.toContain('/plugin install teamshare');
    expect(out.toLowerCase()).toContain('admin token');
    expect(out.toLowerCase()).toContain('cannot be used');
    expect(out).toContain('teamshare-team invite <your-own-email>');
  });

  it('formatRotateOutput says the admin token was rotated, the old one stopped working immediately, and every teammate keeps working unaffected', () => {
    const out = formatRotateOutput({ url: 'https://ts.example.com', team, verify });
    // Rotation only ever touches teams.token_hash — member_tokens is a
    // completely separate table (rotateTeamToken in db.ts) — so teammates
    // must never be told to reconnect, and the operation should read as
    // cheap and safe, since the old wording discouraged exactly the
    // rotation it should encourage.
    expect(out.toLowerCase()).toContain('admin token');
    expect(out.toLowerCase()).toContain('stopped working');
    expect(out.toLowerCase()).toContain("nobody needs to reconnect");
    expect(out.toLowerCase()).toContain('cheap');
    expect(out.toLowerCase()).toContain('safe');
    expect(out).not.toMatch(/every teammate must (reconnect|reconnect with)/i);
    expect(out.toLowerCase()).toContain('shown once');
    // Same regression test as formatCreateOutput above: the admin token
    // this mints cannot be used to join, so no join instructions for it.
    expect(out).not.toContain('/plugin marketplace add');
    expect(out).not.toContain('/plugin install teamshare');
    expect(out).toContain('teamshare-team invite <your-own-email>');
    // Same as formatCreateOutput: no credential-bearing re-verify line at all
    // any more, because the token is read from the saved store instead.
    expect(out).not.toContain('TEAMSHARE_TOKEN=ts_new_token');
    expect(out).not.toContain('teamshare doctor https://ts.example.com ts_new_token');
  });

  it('formatAdminTokenGuidance never mentions join instructions and points at inviting yourself', () => {
    const out = formatAdminTokenGuidance({ url: 'https://ts.example.com' });
    expect(out).not.toContain('/plugin marketplace add');
    expect(out).not.toContain('/plugin install teamshare');
    expect(out.toLowerCase()).toContain('admin token');
    expect(out).toContain('teamshare-team invite <your-own-email>');
  });

  it('reports where the admin token was saved, and still says to keep a copy', () => {
    const out = formatAdminTokenGuidance({ url: 'https://ts.example.com', savedPath: '/home/lead/.teamshare/admin.json' });
    expect(out).toContain('/home/lead/.teamshare/admin.json');
    expect(out.toLowerCase()).toContain('never have to paste it again');
    // Saving is a convenience, not a backup: the file dies with the machine,
    // so the password-manager instruction must survive the convenience.
    expect(out.toLowerCase()).toContain('password manager');
  });

  it('surfaces a failure to save rather than silently leaving the lead without a working token', () => {
    const out = formatCreateOutput({
      url: 'https://ts.example.com',
      team,
      verify,
      saveError: 'EACCES: permission denied',
    });
    expect(out).toContain('EACCES: permission denied');
    expect(out).toContain(ADMIN_TOKEN_ENV);
    // The team really was created — saying otherwise would send the lead off
    // to create a duplicate.
    expect(out).toContain('create-team — success');
  });

  it('spells suggested commands the way this file was actually invoked', () => {
    const asPluginBin = formatCreateOutput({ url: 'https://ts.example.com', team, verify, cmdName: 'teamshare-team' });
    const asScript = formatCreateOutput({ url: 'https://ts.example.com', team, verify, cmdName: 'node teamshare-team.mjs' });
    expect(asPluginBin).toContain('teamshare-team invite <your-own-email>');
    expect(asScript).toContain('node teamshare-team.mjs invite <your-own-email>');
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
  let home: string;
  const SIGNUP_SECRET = 'cli-signup-secret-value';

  // create-team and rotate-team now PERSIST the admin token, so every call
  // here must be pointed at a throwaway home. Without this the suite writes
  // live-looking credentials into the developer's own ~/.teamshare/admin.json,
  // one dead entry per run, pointing at ephemeral ports that no longer exist —
  // which is exactly what happened the first time this landed.
  const run: typeof runTeamCli = (argv, opts = {}) =>
    runTeamCli(argv, { homeDir: home, ...opts });

  beforeEach(async () => {
    db = openDb(':memory:');
    home = mkdtempSync(join(tmpdir(), 'teamshare-home-'));
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
    rmSync(home, { recursive: true, force: true });
  });

  it('create-team succeeds via the signup-secret environment variable and never echoes the secret', async () => {
    const result = await run(['create-team', base, 'CLI Squad'], {
      env: { [SIGNUP_SECRET_ENV]: SIGNUP_SECRET },
      isTTY: false,
      identity,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('teamshare create-team — success');
    expect(result.stdout).toContain('CLI Squad');
    expect(result.stdout).toContain('[OK] server reachable');
    expect(result.stdout.match(/\[OK\]/g)?.length).toBeGreaterThanOrEqual(2); // /health AND /members
    expect(result.stdout).not.toContain(SIGNUP_SECRET);
    expect(result.stderr).not.toContain(SIGNUP_SECRET);
    // This mints the ADMIN token — it cannot be used to join teamshare, so
    // this output must never print join instructions next to it.
    expect(result.stdout).not.toContain('/plugin marketplace add');
    expect(result.stdout).not.toContain('/plugin install teamshare');
    expect(findTeamByName(db, 'CLI Squad')).toBeTruthy();
  });

  it('create-team fails loudly, without creating a team, when the signup secret is wrong', async () => {
    const result = await run(['create-team', base, 'Wrong Secret Team'], {
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
    const result = await run(['create-team', base, 'No Secret Team'], {
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

    const result = await run(['rotate-team', base], {
      env: { [TEAM_TOKEN_ENV]: oldToken },
      isTTY: false,
      identity,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('teamshare rotate-team — success');
    expect(result.stdout).not.toContain(oldToken);
    expect(result.stdout.toLowerCase()).toContain('stopped working');
    expect(result.stdout.toLowerCase()).toContain('nobody needs to reconnect');
    // This mints the ADMIN token — it cannot be used to join teamshare, so
    // this output must never print join instructions next to it.
    expect(result.stdout).not.toContain('/plugin marketplace add');
    expect(result.stdout).not.toContain('/plugin install teamshare');

    // The old admin token must genuinely stop working on another
    // admin-authenticated route — see the identical reasoning in the
    // rotateTeamOverHttp test above for why /teams/rotate, not /unread, is
    // the honest thing to check here.
    const oldRes = await fetch(`${base}/teams/rotate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${oldToken}` },
    });
    expect(oldRes.status).toBe(401);
  });

  it('help and unknown-command results carry no exit-code surprises', async () => {
    const help = await run(['--help'], { env: {}, isTTY: false, identity });
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain('create-team');

    const unknown = await run(['bogus', base], { env: {}, isTTY: false, identity });
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain('bogus');
  });

  describe('invite / revoke / roster, via the ADMIN_TOKEN environment variable', () => {
    let adminToken: string;

    beforeEach(() => {
      adminToken = 'ts_cli_admin_token';
      createTeam(db, 'Admin Ops Team', hashToken(adminToken), NOW);
    });

    it('invite succeeds and the printed token genuinely works', async () => {
      const result = await run(['invite', base, 'sam@team.com', 'Sam'], {
        env: { [ADMIN_TOKEN_ENV]: adminToken },
        isTTY: false,
        identity,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('teamshare invite — success');
      expect(result.stdout).toContain('sam@team.com');
      expect(result.stdout).not.toContain(adminToken);

      const match = result.stdout.match(/Personal token for[^:]*:\s*\n\s*\n\s*(\S+)/);
      expect(match).toBeTruthy();
      const memberToken = match![1];
      const check = await fetch(`${base}/unread`, { headers: { Authorization: `Bearer ${memberToken}` } });
      expect(check.status).toBe(200);
    });

    it('invite fails loudly when the admin token is wrong, minting nothing', async () => {
      const result = await run(['invite', base, 'sam@team.com'], {
        env: { [ADMIN_TOKEN_ENV]: 'ts_wrong' },
        isTTY: false,
        identity,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toLowerCase()).toContain('failed to invite');
    });

    it('revoke kills a live token, and the holder 401s afterward', async () => {
      const scope = makeTeamScope(db, findTeamByName(db, 'Admin Ops Team')!.id);
      const memberToken = createMemberToken(scope, 'sam@team.com', 'Sam', NOW);

      const result = await run(['revoke', base, 'sam@team.com'], {
        env: { [ADMIN_TOKEN_ENV]: adminToken },
        isTTY: false,
        identity,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Revoked 1 live token(s)');

      const check = await fetch(`${base}/unread`, { headers: { Authorization: `Bearer ${memberToken}` } });
      expect(check.status).toBe(401);
    });

    it('roster lists a known member', async () => {
      const scope = makeTeamScope(db, findTeamByName(db, 'Admin Ops Team')!.id);
      createMemberToken(scope, 'sam@team.com', 'Sam', NOW);

      const result = await run(['roster', base], {
        env: { [ADMIN_TOKEN_ENV]: adminToken },
        isTTY: false,
        identity,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Admin Ops Team');
      expect(result.stdout).toContain('sam@team.com');
      expect(result.stdout).toContain('active');
    });

    it('invite/revoke/roster fail immediately (no hang, no prompt) with no admin token and a non-TTY stdin', async () => {
      const promptFn = vi.fn(async () => {
        throw new Error('should never prompt when isTTY is false');
      });
      const result = await run(['roster', base], { env: {}, isTTY: false, identity, promptFn });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(ADMIN_TOKEN_ENV);
      expect(promptFn).not.toHaveBeenCalled();
    });
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

describe('admin token env aliasing', () => {
  // Regression: `invite`/`revoke`/`roster` read TEAMSHARE_ADMIN_TOKEN while
  // `rotate-team` read TEAMSHARE_TEAM_TOKEN. They are the SAME credential, so
  // a lead who set one and then ran the other command got "could not resolve
  // the ... token" for a variable they had definitely set.
  it('accepts either variable name for the same credential', () => {
    expect(adminTokenFromEnv({ [ADMIN_TOKEN_ENV]: 'ts_a' })).toBe('ts_a');
    expect(adminTokenFromEnv({ [TEAM_TOKEN_ENV]: 'ts_b' })).toBe('ts_b');
  });

  it('prefers the canonical ADMIN name when both are set', () => {
    expect(
      adminTokenFromEnv({ [ADMIN_TOKEN_ENV]: 'ts_admin', [TEAM_TOKEN_ENV]: 'ts_team' }),
    ).toBe('ts_admin');
  });

  it('resolves to undefined when neither is set, so the caller can prompt', () => {
    expect(adminTokenFromEnv({})).toBeUndefined();
  });
});


// ---------------------------------------------------------------------------
// The server address stops being something a human types.
//
// teamshare's deployment sits behind an Elastic IP (deploy/aws/eip.tf), so its
// address is permanent — and asking every teammate and every admin command to
// paste it was ceremony, not configuration. These pin the override order that
// keeps self-hosting possible while the default costs nobody anything.
// ---------------------------------------------------------------------------

describe('looksLikeServerUrl', () => {
  it('accepts only an explicit http(s) URL', () => {
    expect(looksLikeServerUrl('https://teamshare.example.com')).toBe(true);
    expect(looksLikeServerUrl('http://127.0.0.1:8787')).toBe(true);
    expect(looksLikeServerUrl('  https://ts.example.com  ')).toBe(true);
  });

  it('rejects the things that share the same argument position', () => {
    // This predicate is the ONLY thing separating `create-team "Platform"`
    // from the older `create-team <url> "Platform"`, so a team name or an
    // email must never be mistaken for a server.
    expect(looksLikeServerUrl('Platform')).toBe(false);
    expect(looksLikeServerUrl('sam@acme.com')).toBe(false);
    expect(looksLikeServerUrl('teamshare.example.com')).toBe(false);
    expect(looksLikeServerUrl('')).toBe(false);
    expect(looksLikeServerUrl(undefined)).toBe(false);
  });
});

describe('resolveServerUrl', () => {
  it('falls all the way through to the built-in default when nothing is configured', () => {
    const r = resolveServerUrl({ env: {}, clientConfig: null });
    expect(r.url).toBe(DEFAULT_SERVER_URL);
    expect(r.source).toBe('default');
  });

  it('honours the override order: flag, then positional, then env, then config file', () => {
    const env = { [SERVER_URL_ENV]: 'https://from-env.example' };
    const clientConfig = { url: 'https://from-file.example' };

    expect(resolveServerUrl({ flag: 'https://from-flag.example', positional: 'https://from-arg.example', env, clientConfig }))
      .toMatchObject({ url: 'https://from-flag.example', source: 'flag' });
    expect(resolveServerUrl({ positional: 'https://from-arg.example', env, clientConfig }))
      .toMatchObject({ url: 'https://from-arg.example', source: 'argument' });
    expect(resolveServerUrl({ env, clientConfig }))
      .toMatchObject({ url: 'https://from-env.example', source: 'env' });
    expect(resolveServerUrl({ env: {}, clientConfig }))
      .toMatchObject({ url: 'https://from-file.example', source: 'config-file' });
  });

  it('normalises whatever it resolves, so a pasted /mcp suffix still works', () => {
    expect(resolveServerUrl({ flag: 'https://ts.example.com/mcp' }).url).toBe('https://ts.example.com');
    expect(resolveServerUrl({ env: { [SERVER_URL_ENV]: 'https://ts.example.com/' } }).url).toBe('https://ts.example.com');
  });

  it('ignores blank values rather than resolving to an empty server', () => {
    expect(resolveServerUrl({ flag: '   ', env: { [SERVER_URL_ENV]: '  ' }, clientConfig: { url: '' } }).source).toBe('default');
  });
});

describe('parseTeamArgv: the server argument is now optional', () => {
  it('reads the command arguments directly when no URL is given', () => {
    expect(parseTeamArgv(['create-team', 'Platform'])).toMatchObject({ cmd: 'create-team', name: 'Platform', url: undefined });
    expect(parseTeamArgv(['invite', 'sam@acme.com', 'Sam'])).toMatchObject({ cmd: 'invite', email: 'sam@acme.com', name: 'Sam' });
    expect(parseTeamArgv(['revoke', 'sam@acme.com'])).toMatchObject({ cmd: 'revoke', email: 'sam@acme.com' });
    expect(parseTeamArgv(['roster'])).toMatchObject({ cmd: 'roster', url: undefined });
    expect(parseTeamArgv(['whoami'])).toMatchObject({ cmd: 'whoami' });
  });

  it('still accepts the older leading-URL form, so nothing documented before this change breaks', () => {
    expect(parseTeamArgv(['create-team', 'https://ts.example.com', 'Platform'])).toMatchObject({
      cmd: 'create-team',
      url: 'https://ts.example.com',
      name: 'Platform',
    });
    expect(parseTeamArgv(['invite', 'https://ts.example.com', 'sam@acme.com', 'Sam'])).toMatchObject({
      cmd: 'invite',
      url: 'https://ts.example.com',
      email: 'sam@acme.com',
      name: 'Sam',
    });
  });

  it('never mistakes a team name or an email for a server', () => {
    expect(parseTeamArgv(['create-team', 'Platform']).url).toBeUndefined();
    expect(parseTeamArgv(['invite', 'sam@acme.com']).url).toBeUndefined();
    expect(parseTeamArgv(['invite', 'sam@acme.com']).email).toBe('sam@acme.com');
  });

  it('supports --server and --team, in both spellings, anywhere in the line', () => {
    expect(parseTeamArgv(['invite', '--server', 'https://ts.example.com', 'sam@acme.com'])).toMatchObject({
      cmd: 'invite',
      serverFlag: 'https://ts.example.com',
      email: 'sam@acme.com',
    });
    expect(parseTeamArgv(['roster', '--team=Platform'])).toMatchObject({ cmd: 'roster', teamName: 'Platform' });
    expect(parseTeamArgv(['roster', '--server=https://ts.example.com'])).toMatchObject({
      cmd: 'roster',
      serverFlag: 'https://ts.example.com',
    });
  });

  it('reports a flag with no value instead of silently swallowing the next argument', () => {
    expect(parseTeamArgv(['invite', 'sam@acme.com', '--server']).badFlag).toContain('--server');
    expect(parseTeamArgv(['roster', '--team']).badFlag).toContain('--team');
  });

  it('rejects an unknown option rather than treating it as a positional', () => {
    expect(parseTeamArgv(['roster', '--wat']).badFlag).toContain('--wat');
  });

  it('treats an unknown subcommand as unknown, and bare/-h as help', () => {
    expect(parseTeamArgv(['frobnicate'])).toMatchObject({ cmd: 'unknown', unknown: 'frobnicate' });
    expect(parseTeamArgv([]).help).toBe(true);
    expect(parseTeamArgv(['-h']).help).toBe(true);
    expect(parseTeamArgv(['invite', '--help']).help).toBe(true);
  });
});

describe('invocationName: the same bytes ship as a script and as a PATH command', () => {
  it('spells a .mjs file as something you run with node', () => {
    expect(invocationName('/somewhere/teamshare-team.mjs')).toBe('node teamshare-team.mjs');
  });

  it('spells an extensionless bin as a bare command', () => {
    expect(invocationName('/Users/x/.claude/plugins/cache/teamshare/teamshare/0.1.0/bin/teamshare-team')).toBe(
      'teamshare-team',
    );
  });

  it('falls back to the script name when argv[1] is missing', () => {
    expect(invocationName(undefined)).toBe('node teamshare-team.mjs');
    expect(invocationName('')).toBe('node teamshare-team.mjs');
  });
});

// ---------------------------------------------------------------------------
// The admin token stops being something a human re-pastes. A slash command has
// no TTY to prompt on, so without this store the whole plugin-native admin
// surface is impossible.
// ---------------------------------------------------------------------------

describe('the admin token store', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'teamshare-store-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('round-trips a saved token, owner-readable only', () => {
    const saved = saveAdminEntry({
      url: 'https://ts.example.com',
      teamId: 'tm_1',
      name: 'Platform',
      token: 'ts_secret',
      homeDir: home,
      now: NOW,
    });
    expect(saved.ok).toBe(true);

    const path = adminStorePath(home);
    expect(existsSync(path)).toBe(true);
    // A credential on disk that any other account can read is not a store,
    // it's a leak. The mode argument alone is masked by umask, so this pins
    // the explicit chmod that follows the write.
    expect(statSync(path).mode & 0o777).toBe(0o600);

    const entries = adminEntriesFor(readAdminStore({ homeDir: home }), 'https://ts.example.com');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ team_id: 'tm_1', name: 'Platform', token: 'ts_secret', created_at: NOW });
  });

  it('replaces the entry for the same team rather than accumulating a dead credential', () => {
    const common = { url: 'https://ts.example.com', teamId: 'tm_1', name: 'Platform', homeDir: home };
    saveAdminEntry({ ...common, token: 'ts_old', now: NOW });
    saveAdminEntry({ ...common, token: 'ts_new', now: NOW });

    const entries = adminEntriesFor(readAdminStore({ homeDir: home }), 'https://ts.example.com');
    expect(entries).toHaveLength(1);
    expect(entries[0].token).toBe('ts_new');
  });

  it('keeps teams on different servers, and different teams on one server, apart', () => {
    saveAdminEntry({ url: 'https://a.example', teamId: 'tm_a', name: 'A', token: 'ts_a', homeDir: home, now: NOW });
    saveAdminEntry({ url: 'https://b.example', teamId: 'tm_b', name: 'B', token: 'ts_b', homeDir: home, now: NOW });
    saveAdminEntry({ url: 'https://a.example', teamId: 'tm_a2', name: 'A2', token: 'ts_a2', homeDir: home, now: NOW });

    expect(adminEntriesFor(readAdminStore({ homeDir: home }), 'https://a.example').map((t) => t.name).sort()).toEqual(['A', 'A2']);
    expect(adminEntriesFor(readAdminStore({ homeDir: home }), 'https://b.example').map((t) => t.name)).toEqual(['B']);
  });

  it('matches servers after normalisation, so a trailing slash or /mcp still finds the token', () => {
    saveAdminEntry({ url: 'https://ts.example.com', teamId: 'tm_1', name: 'Platform', token: 'ts_x', homeDir: home, now: NOW });
    expect(adminEntriesFor(readAdminStore({ homeDir: home }), 'https://ts.example.com/')).toHaveLength(1);
    expect(adminEntriesFor(readAdminStore({ homeDir: home }), 'https://ts.example.com/mcp')).toHaveLength(1);
  });

  it('treats a missing, malformed or hand-edited store as simply empty', () => {
    expect(readAdminStore({ homeDir: home }).teams).toEqual([]);
    mkdirSync(join(home, '.teamshare'), { recursive: true });
    writeFileSync(adminStorePath(home), 'not json at all');
    expect(readAdminStore({ homeDir: home }).teams).toEqual([]);
    writeFileSync(adminStorePath(home), JSON.stringify({ version: 1, teams: 'nope' }));
    expect(readAdminStore({ homeDir: home }).teams).toEqual([]);
    // An entry missing the only two fields that make it usable is dropped
    // rather than handed to a caller that would send `Bearer undefined`.
    writeFileSync(adminStorePath(home), JSON.stringify({ version: 1, teams: [{ name: 'no token' }] }));
    expect(readAdminStore({ homeDir: home }).teams).toEqual([]);
  });

  it('reports a save failure instead of pretending it worked', () => {
    const result = saveAdminEntry({
      url: 'https://ts.example.com',
      teamId: 'tm_1',
      name: 'Platform',
      token: 'ts_x',
      homeDir: home,
      now: NOW,
      fs: {
        readFileSync: () => {
          throw new Error('ENOENT');
        },
        mkdirSync: () => {
          throw new Error('EACCES: permission denied');
        },
      } as unknown as typeof import('node:fs'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('EACCES');
  });
});

describe('resolveAdminTokenFromStore', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'teamshare-store-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const save = (name: string, token: string, url = 'https://ts.example.com', teamId = name) =>
    saveAdminEntry({ url, teamId, name, token, homeDir: home, now: NOW });

  it('lets an environment variable override the store, so a one-off always wins', () => {
    save('Platform', 'ts_stored');
    const r = resolveAdminTokenFromStore({ url: 'https://ts.example.com', env: { [ADMIN_TOKEN_ENV]: 'ts_env' }, homeDir: home });
    expect(r).toMatchObject({ ok: true, token: 'ts_env', source: 'env' });
  });

  it('honours the older TEAMSHARE_TEAM_TOKEN spelling too', () => {
    const r = resolveAdminTokenFromStore({ url: 'https://ts.example.com', env: { [TEAM_TOKEN_ENV]: 'ts_legacy' }, homeDir: home });
    expect(r).toMatchObject({ ok: true, token: 'ts_legacy' });
  });

  it('uses the saved token when exactly one team is stored for that server', () => {
    save('Platform', 'ts_stored');
    const r = resolveAdminTokenFromStore({ url: 'https://ts.example.com', env: {}, homeDir: home });
    expect(r).toMatchObject({ ok: true, token: 'ts_stored', source: 'store' });
  });

  it('refuses to guess between several teams — guessing would revoke someone from the wrong one', () => {
    save('Platform', 'ts_a', 'https://ts.example.com', 'tm_a');
    save('Infra', 'ts_b', 'https://ts.example.com', 'tm_b');
    const r = resolveAdminTokenFromStore({ url: 'https://ts.example.com', env: {}, homeDir: home });
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === 'ambiguous') expect(r.names.sort()).toEqual(['Infra', 'Platform']);
  });

  it('picks the named team when --team disambiguates, case-insensitively', () => {
    save('Platform', 'ts_a', 'https://ts.example.com', 'tm_a');
    save('Infra', 'ts_b', 'https://ts.example.com', 'tm_b');
    expect(resolveAdminTokenFromStore({ url: 'https://ts.example.com', env: {}, teamName: 'infra', homeDir: home }))
      .toMatchObject({ ok: true, token: 'ts_b' });
  });

  it('says which teams it does have when --team names one it does not', () => {
    save('Platform', 'ts_a');
    const r = resolveAdminTokenFromStore({ url: 'https://ts.example.com', env: {}, teamName: 'Nope', homeDir: home });
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === 'no-such-team') expect(r.names).toEqual(['Platform']);
  });

  it('reports nothing saved for a server it has never seen', () => {
    save('Platform', 'ts_a', 'https://other.example');
    expect(resolveAdminTokenFromStore({ url: 'https://ts.example.com', env: {}, homeDir: home }))
      .toMatchObject({ ok: false, reason: 'none-saved' });
  });
});

describe('resolveMemberToken: a different credential, from a different place', () => {
  it('prefers the plugin option, then the plain env var, then the config file', () => {
    expect(
      resolveMemberToken({
        env: { CLAUDE_PLUGIN_OPTION_TEAMSHARE_TOKEN: 'tsm_plugin', TEAMSHARE_TOKEN: 'tsm_env' },
        clientConfig: { token: 'tsm_file' },
      }),
    ).toBe('tsm_plugin');
    expect(resolveMemberToken({ env: { TEAMSHARE_TOKEN: 'tsm_env' }, clientConfig: { token: 'tsm_file' } })).toBe('tsm_env');
    expect(resolveMemberToken({ env: {}, clientConfig: { token: 'tsm_file' } })).toBe('tsm_file');
    expect(resolveMemberToken({ env: {}, clientConfig: null })).toBeUndefined();
  });
});


// ---------------------------------------------------------------------------
// The point of the whole change, end to end: a lead creates a team and then
// runs invite / roster / revoke / rotate with NO token supplied and NO TTY to
// be prompted on — which is exactly the situation a Claude Code slash command
// runs in. Before the store, every one of these would have failed.
// ---------------------------------------------------------------------------

describe('runTeamCli: admin commands with nothing pasted and no terminal', () => {
  let db: Db;
  let server: Server;
  let base: string;
  let home: string;
  const SIGNUP_SECRET = 'store-signup-secret';

  // isTTY false and a promptFn that throws: if any command reaches for a
  // prompt, the test fails loudly instead of hanging or quietly passing.
  const neverPrompt = () => {
    throw new Error('should never prompt: the token must come from the saved store');
  };
  const run = (argv: string[], extra: Record<string, unknown> = {}) =>
    runTeamCli(argv, { homeDir: home, env: {}, isTTY: false, identity, promptFn: neverPrompt as never, ...extra });

  beforeEach(async () => {
    db = openDb(':memory:');
    home = mkdtempSync(join(tmpdir(), 'teamshare-e2e-'));
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
    rmSync(home, { recursive: true, force: true });
  });

  const createTeamHere = () =>
    run(['create-team', base, 'Platform'], { env: { [SIGNUP_SECRET_ENV]: SIGNUP_SECRET } });

  it('create-team saves the admin token and says where it went', async () => {
    const created = await createTeamHere();
    expect(created.exitCode).toBe(0);
    expect(created.stdout).toContain(adminStorePath(home));

    const entries = adminEntriesFor(readAdminStore({ homeDir: home }), base);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('Platform');
    // The saved token is the real one — the same value the output printed for
    // the lead's password manager.
    expect(created.stdout).toContain(entries[0].token);
  });

  it('invite, roster and revoke all work afterwards with no credential in the environment', async () => {
    await createTeamHere();

    const invited = await run(['invite', base, 'sam@acme.com', 'Sam']);
    expect(invited.exitCode).toBe(0);
    expect(invited.stdout).toContain('teamshare invite — success');
    expect(invited.stdout).toContain('sam@acme.com');

    const roster = await run(['roster', base]);
    expect(roster.exitCode).toBe(0);
    expect(roster.stdout).toContain('sam@acme.com');
    expect(roster.stdout).toContain('Platform');

    const revoked = await run(['revoke', base, 'sam@acme.com']);
    expect(revoked.exitCode).toBe(0);
    expect(revoked.stdout).toContain('Revoked 1 live token(s)');
  });

  it('the personal token an invite mints actually authenticates, and the admin token still does not', async () => {
    await createTeamHere();
    const invited = await run(['invite', base, 'sam@acme.com', 'Sam']);
    const memberToken = /tsm_[A-Za-z0-9]+/.exec(invited.stdout)?.[0];
    expect(memberToken).toBeTruthy();

    const asMember = await fetch(`${base}/unread`, { headers: { Authorization: `Bearer ${memberToken}` } });
    expect(asMember.status).toBe(200);

    // The credential split this design rests on: the admin token invites
    // people and reads nothing.
    const adminToken = adminEntriesFor(readAdminStore({ homeDir: home }), base)[0].token;
    const asAdmin = await fetch(`${base}/unread`, { headers: { Authorization: `Bearer ${adminToken}` } });
    expect(asAdmin.status).toBe(401);
  });

  it('rotate-team replaces the saved token, so the very next command keeps working', async () => {
    await createTeamHere();
    const before = adminEntriesFor(readAdminStore({ homeDir: home }), base)[0].token;

    const rotated = await run(['rotate-team', base]);
    expect(rotated.exitCode).toBe(0);

    const after = adminEntriesFor(readAdminStore({ homeDir: home }), base)[0].token;
    expect(after).not.toBe(before);
    expect(adminEntriesFor(readAdminStore({ homeDir: home }), base)).toHaveLength(1);

    // The real regression this guards: a rotate that printed a new token but
    // left the old one on disk would break every later admin command with a
    // 401 and no clue why.
    const roster = await run(['roster', base]);
    expect(roster.exitCode).toBe(0);
  });

  it('explains what to do, rather than hanging or leaking, when no token is saved for that server', async () => {
    const result = await run(['roster', base]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no admin token');
    expect(result.stderr).toContain('create-team');
    // Someone who is not the lead does not need an admin token at all, and
    // the message has to say so or they will go looking for one.
    expect(result.stderr).toContain('invite <your-email>');
  });

  it('asks which team instead of guessing when this machine holds two on one server', async () => {
    await createTeamHere();
    await run(['create-team', base, 'Infra'], { env: { [SIGNUP_SECRET_ENV]: SIGNUP_SECRET } });

    const ambiguous = await run(['roster', base]);
    expect(ambiguous.exitCode).toBe(1);
    expect(ambiguous.stderr).toContain('--team');
    expect(ambiguous.stderr).toContain('Platform');
    expect(ambiguous.stderr).toContain('Infra');

    const named = await run(['roster', base, '--team', 'Infra']);
    expect(named.exitCode).toBe(0);
    expect(named.stdout).toContain('Infra');
  });

  it('whoami distinguishes "not connected" from "nothing to read", which is otherwise invisible', async () => {
    const created = await createTeamHere();
    expect(created.exitCode).toBe(0);

    // A lead who created a team but never invited themselves: admin token
    // present, personal token absent. This is the exact state that silently
    // produced an empty digest forever.
    const before = await run(['whoami', base]);
    expect(before.exitCode).toBe(0);
    expect(before.stdout).toContain('Platform');
    expect(before.stdout.toLowerCase()).toContain('not set on this machine');

    const invited = await run(['invite', base, 'lead@acme.com', 'Lead']);
    const memberToken = /tsm_[A-Za-z0-9]+/.exec(invited.stdout)?.[0] as string;

    const after = await run(['whoami', base], { env: { TEAMSHARE_TOKEN: memberToken } });
    expect(after.stdout.toLowerCase()).toContain('working');
    expect(after.stdout).toContain('0 unread');
  });

  it('whoami names an admin token presented as a personal one, the mistake that looks like a bad token', async () => {
    await createTeamHere();
    const adminToken = adminEntriesFor(readAdminStore({ homeDir: home }), base)[0].token;
    const result = await run(['whoami', base], { env: { TEAMSHARE_TOKEN: adminToken } });
    expect(result.stdout).toContain('401');
    expect(result.stdout.toLowerCase()).toContain('admin token');
  });

  it('whoami says the address is built in when nothing chose it', async () => {
    const result = await runTeamCli(['whoami'], {
      homeDir: home,
      env: {},
      isTTY: false,
      identity,
      // No server anywhere: it must resolve to the default and say so, rather
      // than reporting an empty address or asking for one.
      fetchImpl: (async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(DEFAULT_SERVER_URL);
    expect(result.stdout.toLowerCase()).toContain('built in');
  });

  it('never writes outside the home it was given', async () => {
    await createTeamHere();
    // Pins the isolation the rest of this file depends on: an escape here
    // means the suite is quietly writing credentials into the developer's own
    // ~/.teamshare/admin.json, which is exactly what happened once already.
    expect(existsSync(adminStorePath(home))).toBe(true);
    expect(readFileSync(adminStorePath(home), 'utf8')).toContain('Platform');
  });
});


describe('readBundledMcpUrl: self-hosting is one edited line', () => {
  // A self-hoster forks this repo and changes .mcp.json's url. Every other
  // surface has to follow that automatically, or the MCP connection talks to
  // their server while the admin commands talk to teamshare's — shares
  // published to one place and read from another, silently.
  const manifest = (url: unknown) => () => JSON.stringify({ mcpServers: { teamshare: { url } } });

  it('reads the address out of the manifest sitting beside the bin directory', () => {
    expect(
      readBundledMcpUrl({
        scriptPath: '/plugins/teamshare/bin/teamshare-team',
        readFileSync: manifest('https://self-hosted.example/mcp') as never,
      }),
    ).toBe('https://self-hosted.example');
  });

  it('ignores an unresolved placeholder rather than treating it as an address', () => {
    expect(
      readBundledMcpUrl({
        scriptPath: '/plugins/teamshare/bin/teamshare-team',
        readFileSync: manifest('${user_config.TEAMSHARE_URL}/mcp') as never,
      }),
    ).toBeUndefined();
  });

  it('yields nothing when there is no manifest — a curl\'d copy, or the in-repo path', () => {
    expect(
      readBundledMcpUrl({
        scriptPath: '/tmp/teamshare-team.mjs',
        readFileSync: (() => {
          throw new Error('ENOENT');
        }) as never,
      }),
    ).toBeUndefined();
    expect(readBundledMcpUrl({ scriptPath: '', readFileSync: manifest('https://x.example') as never })).toBeUndefined();
  });

  it('yields nothing for a malformed or empty manifest instead of throwing mid-command', () => {
    expect(
      readBundledMcpUrl({ scriptPath: '/p/bin/t', readFileSync: (() => 'not json') as never }),
    ).toBeUndefined();
    expect(readBundledMcpUrl({ scriptPath: '/p/bin/t', readFileSync: manifest(undefined) as never })).toBeUndefined();
    expect(readBundledMcpUrl({ scriptPath: '/p/bin/t', readFileSync: manifest('   ') as never })).toBeUndefined();
  });

  it('sits below every explicit source, and above the built-in default', () => {
    const bundledUrl = 'https://self-hosted.example';
    expect(resolveServerUrl({ env: {}, clientConfig: null, bundledUrl }))
      .toMatchObject({ url: bundledUrl, source: 'bundled' });
    expect(resolveServerUrl({ env: { [SERVER_URL_ENV]: 'https://env.example' }, clientConfig: null, bundledUrl }))
      .toMatchObject({ url: 'https://env.example', source: 'env' });
    expect(resolveServerUrl({ env: {}, clientConfig: { url: 'https://file.example' }, bundledUrl }))
      .toMatchObject({ url: 'https://file.example', source: 'config-file' });
    expect(resolveServerUrl({ env: {}, clientConfig: null, bundledUrl: '' }))
      .toMatchObject({ url: DEFAULT_SERVER_URL, source: 'default' });
  });
});


// ---------------------------------------------------------------------------
// A slash command has no terminal to be prompted on, so create-team needed a
// third way to receive the signup secret — without putting it in argv, which
// is visible in `ps` and in the tool-call display.
// ---------------------------------------------------------------------------

describe('the signup secret can arrive by file', () => {
  let home: string;
  let db: Db;
  let server: Server;
  let base: string;
  const SECRET = 'file-signup-secret';

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'teamshare-secret-'));
    db = openDb(':memory:');
    const app = createApp({ db, expiryDays: 14, signupSecret: SECRET });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const addr = server.address();
    if (typeof addr === 'object' && addr) base = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  const secretFile = (contents: string) => {
    const p = join(home, 'secret');
    writeFileSync(p, contents, { mode: 0o600 });
    return p;
  };

  it('parses --signup-secret-file, in both spellings', () => {
    expect(parseTeamArgv(['create-team', 'Platform', '--signup-secret-file', '/tmp/s'])).toMatchObject({
      cmd: 'create-team',
      name: 'Platform',
      signupSecretFile: '/tmp/s',
    });
    expect(parseTeamArgv(['create-team', 'Platform', '--signup-secret-file=/tmp/s']).signupSecretFile).toBe('/tmp/s');
    expect(parseTeamArgv(['create-team', 'Platform', '--signup-secret-file']).badFlag).toContain('--signup-secret-file');
  });

  it('reads the secret, tolerating the trailing newline a shell would add', () => {
    expect(readSignupSecretFile({ path: secretFile('abc123\n') })).toMatchObject({ ok: true, value: 'abc123' });
    expect(readSignupSecretFile({ path: secretFile('  abc123  ') })).toMatchObject({ ok: true, value: 'abc123' });
  });

  it('reports an empty or missing file rather than sending an empty secret', () => {
    expect(readSignupSecretFile({ path: secretFile('   ') })).toMatchObject({ ok: false });
    expect(readSignupSecretFile({ path: join(home, 'nope') })).toMatchObject({ ok: false });
  });

  it('creates a team from the file with no environment and no terminal', async () => {
    const promptFn = () => {
      throw new Error('must not prompt: the secret came from a file');
    };
    const result = await runTeamCli(
      ['create-team', base, 'Platform', '--signup-secret-file', secretFile(SECRET)],
      { homeDir: home, env: {}, isTTY: false, identity, promptFn: promptFn as never },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('create-team — success');
    expect(findTeamByName(db, 'Platform')).toBeTruthy();
    // The secret must not be echoed anywhere, on either stream.
    expect(result.stdout).not.toContain(SECRET);
    expect(result.stderr).not.toContain(SECRET);
  });

  it('lets the environment win over the file, so an explicit export still overrides', async () => {
    const result = await runTeamCli(
      ['create-team', base, 'Env Wins', '--signup-secret-file', secretFile('the-wrong-secret')],
      { homeDir: home, env: { [SIGNUP_SECRET_ENV]: SECRET }, isTTY: false, identity },
    );
    expect(result.exitCode).toBe(0);
    expect(findTeamByName(db, 'Env Wins')).toBeTruthy();
  });

  it('fails with an actionable message, naming all three ways in, when the file is unreadable', async () => {
    const result = await runTeamCli(
      ['create-team', base, 'No Secret', '--signup-secret-file', join(home, 'missing')],
      { homeDir: home, env: {}, isTTY: false, identity },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(SIGNUP_SECRET_ENV);
    expect(result.stderr).toContain('--signup-secret-file');
    expect(result.stderr).toContain('interactive terminal');
    expect(findTeamByName(db, 'No Secret')).toBeUndefined();
  });

  it('still rejects a wrong secret supplied this way', async () => {
    const result = await runTeamCli(
      ['create-team', base, 'Wrong', '--signup-secret-file', secretFile('not-the-secret')],
      { homeDir: home, env: {}, isTTY: false, identity },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toLowerCase()).toContain('failed to create team');
    expect(findTeamByName(db, 'Wrong')).toBeUndefined();
  });

  it('never accepts the secret as a bare positional, which would put it in ps and shell history', () => {
    // `create-team <name> <secret>` must read the second positional as nothing
    // at all — not as the secret. The file is the only non-interactive way in.
    const parsed = parseTeamArgv(['create-team', 'Platform', 'my-secret-value']);
    expect(parsed.name).toBe('Platform');
    expect(parsed.signupSecretFile).toBeUndefined();
    expect(JSON.stringify(parsed)).not.toContain('my-secret-value');
  });
});
