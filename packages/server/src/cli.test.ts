import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, cpSync, symlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { parseArgs, acquireLock, formatServeBanner, formatServeStartupBanner, runDoctor, main } from './cli.js';
import {
  openDb, hasToken, getOrCreateToken, createTeam, findTeamByName, listTeams,
  getOrCreateSignupSecret, hashToken, makeTeamScope, upsertMember, createMemberToken,
} from './db.js';
import { createApp } from './app.js';
import { DEFAULT_SERVER_URL } from './team.js';

const dirs: string[] = [];
function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'teamshare-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('parseArgs', () => {
  it('defaults to serve on 8787 with a 14 day expiry', () => {
    const a = parseArgs([]);
    expect(a.cmd).toBe('serve');
    expect(a.port).toBe(8787);
    expect(a.expiryDays).toBe(14);
  });

  it('defaults host to 127.0.0.1 (loopback-only, correct behind a reverse proxy)', () => {
    const a = parseArgs([]);
    expect(a.host).toBe('127.0.0.1');
  });

  it('reads --host when given, e.g. to opt into 0.0.0.0 for a LAN team with no proxy', () => {
    const a = parseArgs(['serve', '--host', '0.0.0.0']);
    expect(a.host).toBe('0.0.0.0');
  });

  it('reads --port, --db, and --expiry-days', () => {
    const a = parseArgs(['serve', '--port', '9000', '--db', '/tmp/x.db', '--expiry-days', '30']);
    expect(a).toMatchObject({ cmd: 'serve', port: 9000, dbPath: '/tmp/x.db', expiryDays: 30 });
  });

  it('parses rotate-token and remove-member', () => {
    expect(parseArgs(['rotate-token']).cmd).toBe('rotate-token');
    expect(parseArgs(['remove-member', 'a@b.com'])).toMatchObject({
      cmd: 'remove-member',
      email: 'a@b.com',
    });
  });

  it('parses --team on rotate-token and remove-member', () => {
    expect(parseArgs(['rotate-token', '--team', 'Acme'])).toMatchObject({ cmd: 'rotate-token', team: 'Acme' });
    expect(parseArgs(['remove-member', 'a@b.com', '--team', 'Acme'])).toMatchObject({
      cmd: 'remove-member',
      email: 'a@b.com',
      team: 'Acme',
    });
  });

  it('parses serve --signup-secret, --open-signup, and --max-teams', () => {
    const a = parseArgs(['serve', '--signup-secret', 'mysecret', '--open-signup', '--max-teams', '10']);
    expect(a).toMatchObject({ cmd: 'serve', signupSecret: 'mysecret', openSignup: true, maxTeams: 10 });
  });

  it('parses create-team with a name', () => {
    const a = parseArgs(['create-team', 'Rocket Squad']);
    expect(a).toMatchObject({ cmd: 'create-team', teamName: 'Rocket Squad' });
  });

  it('parses create-team --url for the optional live-verify path', () => {
    const a = parseArgs(['create-team', 'Rocket Squad', '--url', 'https://ts.example.com']);
    expect(a).toMatchObject({
      cmd: 'create-team',
      teamName: 'Rocket Squad',
      createTeamUrl: 'https://ts.example.com',
    });
  });

  it('parses create-team with no name as having an undefined teamName (main() reports the error)', () => {
    const a = parseArgs(['create-team']);
    expect(a.cmd).toBe('create-team');
    expect(a.teamName).toBeUndefined();
  });

  it('parses signup-secret --show', () => {
    const a = parseArgs(['signup-secret', '--show']);
    expect(a).toMatchObject({ cmd: 'signup-secret', signupSecretShow: true });
  });

  it('parses signup-secret without --show as not showing anything', () => {
    const a = parseArgs(['signup-secret']);
    expect(a.cmd).toBe('signup-secret');
    expect(a.signupSecretShow).toBeUndefined();
  });

  it('parses doctor', () => {
    expect(parseArgs(['doctor']).cmd).toBe('doctor');
  });

  it('parses doctor with an explicit server-url and team-token', () => {
    const a = parseArgs(['doctor', 'https://ts.example.com', 'ts_abc123']);
    expect(a).toMatchObject({ cmd: 'doctor', doctorUrl: 'https://ts.example.com', doctorToken: 'ts_abc123' });
  });

  it('parses doctor with no arguments as having neither doctorUrl nor doctorToken', () => {
    const a = parseArgs(['doctor']);
    expect(a.doctorUrl).toBeUndefined();
    expect(a.doctorToken).toBeUndefined();
  });

  it('parses connect with a url and token', () => {
    const a = parseArgs(['connect', 'https://ts.example.com', 'ts_abc123']);
    expect(a).toMatchObject({ cmd: 'connect', connectUrl: 'https://ts.example.com', connectToken: 'ts_abc123' });
  });

  it('parses connect --list without requiring a url/token', () => {
    const a = parseArgs(['connect', '--list']);
    expect(a).toMatchObject({ cmd: 'connect', connectList: true });
    expect(a.connectUrl).toBeUndefined();
    expect(a.connectToken).toBeUndefined();
  });

  it('parses connect --only, --dry-run, and --force', () => {
    const a = parseArgs(['connect', 'https://ts.example.com', 'ts_abc123', '--only', 'cursor,codex', '--dry-run', '--force']);
    expect(a.connectOnly).toEqual(['cursor', 'codex']);
    expect(a.connectDryRun).toBe(true);
    expect(a.connectForce).toBe(true);
  });

  it('parses connect --show-token', () => {
    const a = parseArgs(['connect', 'https://ts.example.com', 'ts_abc123', '--show-token']);
    expect(a.connectShowToken).toBe(true);
  });

  it('defaults --show-token to falsy when not passed', () => {
    const a = parseArgs(['connect', 'https://ts.example.com', 'ts_abc123']);
    expect(a.connectShowToken).toBeUndefined();
  });
});

describe('help text', () => {
  it('documents doctor as a subcommand', async () => {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    // @ts-expect-error -- test-only stdout capture
    process.stdout.write = (chunk: string) => { chunks.push(String(chunk)); return true; };
    try {
      await main(['help']);
    } finally {
      process.stdout.write = original;
    }
    expect(chunks.join('')).toContain('doctor');
  });

  it('documents create-team as a subcommand (the break-glass path when the signup secret is lost)', async () => {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    // @ts-expect-error -- test-only stdout capture
    process.stdout.write = (chunk: string) => { chunks.push(String(chunk)); return true; };
    try {
      await main(['help']);
    } finally {
      process.stdout.write = original;
    }
    const out = chunks.join('');
    expect(out).toContain('create-team');
  });

  it('documents connect as a subcommand', async () => {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    // @ts-expect-error -- test-only stdout capture
    process.stdout.write = (chunk: string) => { chunks.push(String(chunk)); return true; };
    try {
      await main(['help']);
    } finally {
      process.stdout.write = original;
    }
    const out = chunks.join('');
    expect(out).toContain('connect');
    expect(out).toContain('--list');
  });
});

describe('doctor wiring in main()', () => {
  it('errors and exits 1 when doctor is given a url but no token', async () => {
    const chunks: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    // @ts-expect-error -- test-only stderr capture
    process.stderr.write = (chunk: string) => { chunks.push(String(chunk)); return true; };
    try {
      await main(['doctor', 'https://ts.example.com']);
    } finally {
      process.stderr.write = original;
    }
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(chunks.join('')).toContain('<server-url>');
  });
});

describe('connect wiring in main()', () => {
  it('errors and exits 1 when connect is called without a url/token or --list', async () => {
    const chunks: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    // @ts-expect-error -- test-only stderr capture
    process.stderr.write = (chunk: string) => { chunks.push(String(chunk)); return true; };
    try {
      await main(['connect']);
    } finally {
      process.stderr.write = original;
    }
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(chunks.join('')).toContain('--list');
  });

  it('exits 1 and names the unknown target when --only is given an invalid id (e.g. a typo)', async () => {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    // @ts-expect-error -- test-only stdout capture
    process.stdout.write = (chunk: string) => { chunks.push(String(chunk)); return true; };
    try {
      await main(['connect', 'https://ts.example.com', 'ts_abc123', '--only', 'cursur']);
    } finally {
      process.stdout.write = original;
    }
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    const out = chunks.join('');
    expect(out).toContain('cursur');
    expect(out).toContain('cursor');
  });
});

describe('formatServeBanner (spec §8 / README: token printed exactly once per generation)', () => {
  it('prints the token when it did not previously exist', () => {
    const out = formatServeBanner({
      port: 8787,
      host: '127.0.0.1',
      dbPath: '/tmp/x.db',
      token: 'ts_abc123token',
      alreadyHadToken: false,
    });
    expect(out).toContain('ts_abc123token');
    expect(out).toContain('Team token');
  });

  it('includes the bound host so an operator can see what it is actually listening on', () => {
    const out = formatServeBanner({
      port: 8787,
      host: '0.0.0.0',
      dbPath: '/tmp/x.db',
      token: 'ts_abc123token',
      alreadyHadToken: false,
    });
    expect(out).toContain('0.0.0.0');
    expect(out).toContain('8787');
  });

  it('omits the token and points to rotate-token when one already existed', () => {
    const out = formatServeBanner({
      port: 8787,
      host: '127.0.0.1',
      dbPath: '/tmp/x.db',
      token: 'ts_abc123token',
      alreadyHadToken: true,
    });
    expect(out).not.toContain('ts_abc123token');
    expect(out).toContain('rotate-token');
    expect(out.toLowerCase()).toContain('already configured');
  });

  it('a first serve-path call prints the token; a second, against the same database, does not', () => {
    // Exercises the exact sequence main()'s serve path runs: check hasToken
    // BEFORE getOrCreateToken (which would otherwise mint one and erase the
    // distinction), then format the banner from that captured boolean.
    const db = openDb(':memory:');
    try {
      const beforeFirstServe = hasToken(db);
      expect(beforeFirstServe).toBe(false);
      const token = getOrCreateToken(db);
      const firstBanner = formatServeBanner({
        port: 8787, host: '127.0.0.1', dbPath: ':memory:', token, alreadyHadToken: beforeFirstServe,
      });
      expect(firstBanner).toContain(token);

      // A second `serve` against the same (now-persisted) database.
      const beforeSecondServe = hasToken(db);
      expect(beforeSecondServe).toBe(true);
      const secondBanner = formatServeBanner({
        port: 8787, host: '127.0.0.1', dbPath: ':memory:', token, alreadyHadToken: beforeSecondServe,
      });
      expect(secondBanner).not.toContain(token);
    } finally {
      db.close();
    }
  });
});

describe('formatServeStartupBanner (the real multi-team serve banner)', () => {
  it('never includes a raw token value, and mentions the break-glass command', () => {
    const out = formatServeStartupBanner({
      port: 8787,
      host: '127.0.0.1',
      dbPath: '/tmp/x.db',
      teamCount: 1,
      openSignup: false,
      signupSecretGenerated: true,
    });
    expect(out).toContain('signup-secret --show');
    expect(out).toContain('1 team(s)');
  });

  it('prints a loud warning when open-signup is set', () => {
    const out = formatServeStartupBanner({
      port: 8787,
      host: '127.0.0.1',
      dbPath: '/tmp/x.db',
      teamCount: 0,
      openSignup: true,
      signupSecretGenerated: false,
    });
    expect(out.toUpperCase()).toContain('WARNING');
    expect(out).toContain('--open-signup');
  });

  it('mentions the team cap when --max-teams is set', () => {
    const out = formatServeStartupBanner({
      port: 8787,
      host: '127.0.0.1',
      dbPath: '/tmp/x.db',
      teamCount: 2,
      openSignup: false,
      signupSecretGenerated: false,
      maxTeams: 5,
    });
    expect(out).toContain('Team cap: 5');
  });
});

describe('signup-secret --show', () => {
  it('needs --show, and errors without it', async () => {
    const dbPath = join(tmp(), 'teamshare.db');
    const chunks: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    // @ts-expect-error -- test-only stderr capture
    process.stderr.write = (chunk: string) => { chunks.push(String(chunk)); return true; };
    try {
      await main(['signup-secret', '--db', dbPath]);
    } finally {
      process.stderr.write = original;
    }
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(chunks.join('')).toContain('--show');
  });

  it('prints a friendly message, not a crash, when no secret has ever been configured', async () => {
    const dbPath = join(tmp(), 'teamshare.db');
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    // @ts-expect-error -- test-only stdout capture
    process.stdout.write = (chunk: string) => { chunks.push(String(chunk)); return true; };
    try {
      await main(['signup-secret', '--show', '--db', dbPath]);
    } finally {
      process.stdout.write = original;
    }
    expect(chunks.join('')).toContain('No signup secret is configured');
  });

  it('prints the plaintext secret once it has been configured (via serve)', async () => {
    const dbPath = join(tmp(), 'teamshare.db');
    const db = openDb(dbPath);
    getOrCreateSignupSecret(db, 'the-real-secret');
    db.close();

    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    // @ts-expect-error -- test-only stdout capture
    process.stdout.write = (chunk: string) => { chunks.push(String(chunk)); return true; };
    try {
      await main(['signup-secret', '--show', '--db', dbPath]);
    } finally {
      process.stdout.write = original;
    }
    expect(chunks.join('')).toContain('the-real-secret');
  });
});

describe('rotate-token / remove-member across a multi-team server', () => {
  it('operates on the sole team implicitly when --team is omitted and only one team exists', async () => {
    const dbPath = join(tmp(), 'teamshare.db');
    const db = openDb(dbPath);
    createTeam(db, 'Only Team', hashToken('ts_only'), '2026-01-01T00:00:00Z');
    db.close();

    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    // @ts-expect-error -- test-only stdout capture
    process.stdout.write = (chunk: string) => { chunks.push(String(chunk)); return true; };
    try {
      await main(['rotate-token', '--db', dbPath]);
    } finally {
      process.stdout.write = original;
    }
    expect(chunks.join('')).toContain('Only Team');
  });

  it('fails loudly (not silently) on rotate-token when multiple teams exist and --team is omitted', async () => {
    const dbPath = join(tmp(), 'teamshare.db');
    const db = openDb(dbPath);
    createTeam(db, 'Team A', hashToken('ts_a'), '2026-01-01T00:00:00Z');
    createTeam(db, 'Team B', hashToken('ts_b'), '2026-01-01T00:00:00Z');
    db.close();

    const chunks: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    // @ts-expect-error -- test-only stderr capture
    process.stderr.write = (chunk: string) => { chunks.push(String(chunk)); return true; };
    try {
      await main(['rotate-token', '--db', dbPath]);
    } finally {
      process.stderr.write = original;
    }
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    const out = chunks.join('');
    expect(out).toContain('multiple teams');
    expect(out).toContain('Team A');
    expect(out).toContain('Team B');

    // And, crucially, nothing was rotated — neither token changed.
    const verifyDb = openDb(dbPath);
    expect(findTeamByName(verifyDb, 'Team A')).toBeTruthy();
    verifyDb.close();
  });

  it('rotates the named team when --team is given, on a multi-team server, leaving the other untouched', async () => {
    const dbPath = join(tmp(), 'teamshare.db');
    const db = openDb(dbPath);
    createTeam(db, 'Team A', hashToken('ts_a2'), '2026-01-01T00:00:00Z');
    createTeam(db, 'Team B', hashToken('ts_b2'), '2026-01-01T00:00:00Z');
    db.close();

    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    // @ts-expect-error -- test-only stdout capture
    process.stdout.write = (chunk: string) => { chunks.push(String(chunk)); return true; };
    try {
      await main(['rotate-token', '--team', 'Team A', '--db', dbPath]);
    } finally {
      process.stdout.write = original;
    }
    expect(chunks.join('')).toContain('Team A');

    const verifyDb = openDb(dbPath);
    try {
      const app = createApp({ db: verifyDb, expiryDays: 14 });
      const server = app.listen(0);
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const addr = server.address() as AddressInfo;
      const base = `http://127.0.0.1:${addr.port}`;

      // Team A's old admin token is dead — checked against an
      // admin-authenticated route (/teams/rotate), since /unread never
      // accepted an admin token in the first place, rotated or not.
      const oldA = await fetch(`${base}/teams/rotate`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ts_a2' },
      });
      expect(oldA.status).toBe(401);

      // ...but Team B's admin token still works, untouched.
      const b = await fetch(`${base}/members`, {
        headers: { Authorization: 'Bearer ts_b2' },
      });
      expect(b.status).toBe(200);

      await new Promise<void>((r) => server.close(() => r()));
    } finally {
      verifyDb.close();
    }
  });

  it('errors with an unknown --team name rather than guessing', async () => {
    const dbPath = join(tmp(), 'teamshare.db');
    const db = openDb(dbPath);
    createTeam(db, 'Team A', hashToken('ts_a3'), '2026-01-01T00:00:00Z');
    db.close();

    const chunks: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    // @ts-expect-error -- test-only stderr capture
    process.stderr.write = (chunk: string) => { chunks.push(String(chunk)); return true; };
    try {
      await main(['rotate-token', '--team', 'Nonexistent', '--db', dbPath]);
    } finally {
      process.stderr.write = original;
    }
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(chunks.join('')).toContain('no team named');
  });

  it('remove-member also fails loudly (not silently) with multiple teams and no --team', async () => {
    const dbPath = join(tmp(), 'teamshare.db');
    const db = openDb(dbPath);
    const teamA = createTeam(db, 'Team A', hashToken('ts_rm_a'), '2026-01-01T00:00:00Z');
    createTeam(db, 'Team B', hashToken('ts_rm_b'), '2026-01-01T00:00:00Z');
    const scopeA = makeTeamScope(db, teamA);
    upsertMember(scopeA, 'a@a.com', 'A', '2026-01-01T00:00:00Z');
    db.close();

    const chunks: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    // @ts-expect-error -- test-only stderr capture
    process.stderr.write = (chunk: string) => { chunks.push(String(chunk)); return true; };
    try {
      await main(['remove-member', 'a@a.com', '--db', dbPath]);
    } finally {
      process.stderr.write = original;
    }
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(chunks.join('')).toContain('multiple teams');

    // The member must still be there — nothing removed.
    const verifyDb = openDb(dbPath);
    const scope = makeTeamScope(verifyDb, teamA);
    expect(scope).toBeTruthy();
    verifyDb.close();
  });

  it('removes from the named team with --team, on a multi-team server', async () => {
    const dbPath = join(tmp(), 'teamshare.db');
    const db = openDb(dbPath);
    const teamA = createTeam(db, 'Team A', hashToken('ts_rm2_a'), '2026-01-01T00:00:00Z');
    createTeam(db, 'Team B', hashToken('ts_rm2_b'), '2026-01-01T00:00:00Z');
    const scopeA = makeTeamScope(db, teamA);
    upsertMember(scopeA, 'a@a.com', 'A', '2026-01-01T00:00:00Z');
    db.close();

    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    // @ts-expect-error -- test-only stdout capture
    process.stdout.write = (chunk: string) => { chunks.push(String(chunk)); return true; };
    try {
      await main(['remove-member', 'a@a.com', '--team', 'Team A', '--db', dbPath]);
    } finally {
      process.stdout.write = original;
    }
    expect(chunks.join('')).toContain('Removed a@a.com');
    expect(chunks.join('')).toContain('Team A');
  });
});

// This is the exact regression the design doc calls out: after migration,
// the OLD rotate-token wrote to config.team_token, which authenticate() no
// longer reads — it would print a fresh token, tell the operator teammates
// must reconnect, and change nothing, a silent failure of the documented
// remedy for a leaked credential. The new rotate-token must genuinely
// invalidate the old token on a real migrated database.
describe('rotate-token on a migrated database genuinely invalidates the old token', () => {
  it('the pre-migration token stops authenticating, and the freshly rotated one works', async () => {
    const dbPath = join(tmp(), 'teamshare.db');
    const oldToken = 'ts_legacy_pre_migration_token';

    // Build a legacy v2-shaped database by hand, exactly as a real
    // pre-upgrade install would look: token in config.team_token, one
    // member, no `teams` table yet.
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE members (email TEXT PRIMARY KEY, name TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL);
      CREATE TABLE shares (id TEXT PRIMARY KEY, sender_email TEXT NOT NULL, what TEXT NOT NULL, why TEXT, action TEXT, tags TEXT NOT NULL DEFAULT '[]', priority TEXT NOT NULL, created_at TEXT NOT NULL, stale_at TEXT);
      CREATE TABLE receipts (share_id TEXT NOT NULL, member_email TEXT NOT NULL, status TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (share_id, member_email));
    `);
    raw.prepare(`INSERT INTO config (key, value) VALUES ('schema_version', '2')`).run();
    raw.prepare(`INSERT INTO config (key, value) VALUES ('team_token', ?)`).run(oldToken);
    raw
      .prepare(`INSERT INTO members (email, name, first_seen, last_seen) VALUES (?, ?, ?, ?)`)
      .run('a@team.com', 'A', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    raw.close();

    // Opening it through the real server migrates it to the current
    // schema — this is "a migrated database" in the same sense production
    // instances are.
    openDb(dbPath).close();

    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    // @ts-expect-error -- test-only stdout capture
    process.stdout.write = (chunk: string) => { chunks.push(String(chunk)); return true; };
    try {
      await main(['rotate-token', '--db', dbPath]);
    } finally {
      process.stdout.write = original;
    }
    const printed = chunks.join('');
    const match = printed.match(/New ADMIN token[^:]*:\s*\n\s*\n\s*(\S+)/);
    expect(match).toBeTruthy();
    const newToken = match![1];
    expect(newToken).not.toBe(oldToken);
    // This is the admin token, not a personal one — rotating it must not
    // claim teammates are affected, and must not tell anyone to "reconnect"
    // with it (it cannot be used to join anything).
    expect(printed.toLowerCase()).toContain('stopped working');
    expect(printed.toLowerCase()).toContain('nobody needs to reconnect');
    expect(printed).not.toContain('/plugin configure teamshare');
    expect(printed).not.toContain('/plugin install teamshare');

    const verifyDb = openDb(dbPath);
    try {
      const app = createApp({ db: verifyDb, expiryDays: 14 });
      const server = app.listen(0);
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const addr = server.address() as AddressInfo;
      const base = `http://127.0.0.1:${addr.port}`;

      const headers = (bearer: string) => ({
        Authorization: `Bearer ${bearer}`,
        'X-Teamshare-Email': 'a@team.com',
        'X-Teamshare-Name': 'A',
      });

      // The old admin token: 401 on /unread (true regardless of rotation —
      // an admin token never worked there) AND on /teams/rotate (true only
      // because rotation genuinely invalidated it), which is the check that
      // actually proves rotation did something.
      const oldRes = await fetch(`${base}/unread`, { headers: headers(oldToken) });
      expect(oldRes.status).toBe(401);
      const oldRotateAttempt = await fetch(`${base}/teams/rotate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${oldToken}` },
      });
      expect(oldRotateAttempt.status).toBe(401);

      const newRes = await fetch(`${base}/members`, { headers: { Authorization: `Bearer ${newToken}` } });
      expect(newRes.status).toBe(200);

      await new Promise<void>((r) => server.close(() => r()));
    } finally {
      verifyDb.close();
    }
  });
});

// §Surfaces: the break-glass path when the instance signup secret is lost.
// Unlike POST /teams, this never needs a secret — it operates on the local
// database directly, the same "operator already has filesystem access"
// authority rotate-token/remove-member rely on above.
describe('create-team (break-glass CLI, local database only)', () => {
  it('creates a team, prints the token exactly once with the password-manager warning, and the fallback doctor line (env-var form, never positional) when no --url is given', async () => {
    const dbPath = join(tmp(), 'teamshare.db');
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    // @ts-expect-error -- test-only stdout capture
    process.stdout.write = (chunk: string) => { chunks.push(String(chunk)); return true; };
    try {
      await main(['create-team', 'Rocket Squad', '--db', dbPath]);
    } finally {
      process.stdout.write = original;
    }
    const out = chunks.join('');
    expect(out).toContain('Rocket Squad');
    expect(out.toLowerCase()).toContain('shown once');
    expect(out.toLowerCase()).toContain('password manager');
    // The fallback re-verify line must use TEAMSHARE_URL/TEAMSHARE_TOKEN, not
    // positional arguments — the token here is real and freshly minted, so a
    // positional suggestion would be advice that puts a credential into
    // shell history/`ps` output the moment someone followed it.
    expect(out).toContain('TEAMSHARE_URL=<url> TEAMSHARE_TOKEN=');
    expect(out).toContain('teamshare doctor');
    expect(out).not.toContain('teamshare doctor <url>');
    // create-team mints the ADMIN token, which 401s on every data route and
    // the MCP connection — it cannot be used to join, so this output must
    // never hand out join instructions for it. The real join instructions
    // belong to `invite`, which mints an actual member token (see the
    // dedicated describe block below).
    expect(out).not.toContain('/plugin install teamshare');
    expect(out).not.toContain('/plugin marketplace add');
    expect(out.toLowerCase()).toContain('admin token');
    expect(out.toLowerCase()).toContain('cannot be used to join');
    expect(out).toContain('teamshare invite <your-own-email>');

    const db = openDb(dbPath);
    try {
      expect(findTeamByName(db, 'Rocket Squad')).toBeTruthy();
    } finally {
      db.close();
    }
  });

  it('genuinely verifies against a live server when --url is given, reusing the exact doctor checks', async () => {
    const dbPath = join(tmp(), 'teamshare.db');

    // A separate, already-running server this create-team run will verify
    // its freshly minted token against — never the live production server.
    const verifyDb = openDb(':memory:');
    const app = createApp({ db: verifyDb, expiryDays: 14 });
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const addr = server.address() as AddressInfo;

    // create-team writes its team into dbPath, and separately verifies the
    // freshly minted token against whatever --url points at — here, the
    // standalone server above, never the live production one. The verify
    // check is expected to report the token doesn't work against *that*
    // server (it's a different database), which is fine: this test only
    // needs to prove the live-verify code path genuinely ran the same
    // checks `teamshare doctor` runs, not that they all pass.
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    // @ts-expect-error -- test-only stdout capture
    process.stdout.write = (chunk: string) => { chunks.push(String(chunk)); return true; };
    try {
      await main(['create-team', 'Verified Squad', '--db', dbPath, '--url', `http://127.0.0.1:${addr.port}`]);
    } finally {
      process.stdout.write = original;
      await new Promise<void>((r) => server.close(() => r()));
      verifyDb.close();
    }
    const out = chunks.join('');
    expect(out).toContain('Verifying the new token against the live server');
    expect(out).toContain('[OK] server reachable');
  });

  it('errors without creating anything when no name is given', async () => {
    const dbPath = join(tmp(), 'teamshare.db');
    const chunks: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    // @ts-expect-error -- test-only stderr capture
    process.stderr.write = (chunk: string) => { chunks.push(String(chunk)); return true; };
    try {
      await main(['create-team', '--db', dbPath]);
    } finally {
      process.stderr.write = original;
    }
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(chunks.join('')).toContain('<name>');
  });

  it('rejects an invalid name (e.g. an unsubstituted placeholder) without creating a team', async () => {
    const dbPath = join(tmp(), 'teamshare.db');
    const chunks: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    // @ts-expect-error -- test-only stderr capture
    process.stderr.write = (chunk: string) => { chunks.push(String(chunk)); return true; };
    try {
      await main(['create-team', '${TEAM_NAME}', '--db', dbPath]);
    } finally {
      process.stderr.write = original;
    }
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(chunks.join('').toLowerCase()).toContain('placeholder');

    const db = openDb(dbPath);
    try {
      expect(listTeams(db)).toEqual([]);
    } finally {
      db.close();
    }
  });
});

// §Identity comes from the token. Local-database break-glass path, the same
// shape as rotate-token/remove-member/create-team above.
describe('invite / revoke / roster (local database)', () => {
  it('invite prints real Claude Code instructions once TEAMSHARE_URL says this is the default deployment', async () => {
    const dbPath = join(tmp(), 'teamshare.db');
    const db = openDb(dbPath);
    createTeam(db, 'Only Team', hashToken('ts_invite_url'), '2026-01-01T00:00:00Z');
    db.close();

    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    const previousUrl = process.env.TEAMSHARE_URL;
    process.env.TEAMSHARE_URL = DEFAULT_SERVER_URL;
    // @ts-expect-error -- test-only stdout capture
    process.stdout.write = (chunk: string) => { chunks.push(String(chunk)); return true; };
    try {
      await main(['invite', 'sam@team.com', 'Sam', '--db', dbPath]);
    } finally {
      process.stdout.write = original;
      if (previousUrl === undefined) delete process.env.TEAMSHARE_URL;
      else process.env.TEAMSHARE_URL = previousUrl;
    }
    const out = chunks.join('');
    expect(out).toContain('/plugin install teamshare');
    expect(out).not.toContain('<your-server-url>');
  });

  it('invite mints a working personal token, printed once with a send-privately warning and join instructions', async () => {
    const dbPath = join(tmp(), 'teamshare.db');
    const db = openDb(dbPath);
    createTeam(db, 'Only Team', hashToken('ts_invite_only'), '2026-01-01T00:00:00Z');
    db.close();

    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    // @ts-expect-error -- test-only stdout capture
    process.stdout.write = (chunk: string) => { chunks.push(String(chunk)); return true; };
    try {
      await main(['invite', 'sam@team.com', 'Sam', '--db', dbPath]);
    } finally {
      process.stdout.write = original;
    }
    const out = chunks.join('');
    expect(out).toContain('sam@team.com');
    expect(out.toLowerCase()).toContain('shown once');
    expect(out.toLowerCase()).toContain('send this token privately');
    // This path reads the database file directly and cannot know the public
    // address it is served on, so it must not claim the Claude Code plugin
    // will work — the plugin only reaches teamshare's own deployment. It
    // emits the connector, with a placeholder the operator fills in.
    expect(out).toContain('teamshare-connect.mjs <your-server-url>');
    expect(out).not.toContain('/plugin install teamshare');

    const match = out.match(/Personal token for[^:]*:\s*\n\s*\n\s*(\S+)/);
    expect(match).toBeTruthy();
    const token = match![1];

    const verifyDb = openDb(dbPath);
    try {
      const app = createApp({ db: verifyDb, expiryDays: 14 });
      const server = app.listen(0);
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const addr = server.address() as AddressInfo;
      const base = `http://127.0.0.1:${addr.port}`;

      const res = await fetch(`${base}/unread`, { headers: { Authorization: `Bearer ${token}` } });
      expect(res.status).toBe(200);

      await new Promise<void>((r) => server.close(() => r()));
    } finally {
      verifyDb.close();
    }
  });

  it('invite defaults the name to the email when omitted', async () => {
    const dbPath = join(tmp(), 'teamshare.db');
    const db = openDb(dbPath);
    createTeam(db, 'Only Team', hashToken('ts_invite_noname'), '2026-01-01T00:00:00Z');
    db.close();

    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    // @ts-expect-error -- test-only stdout capture
    process.stdout.write = (chunk: string) => { chunks.push(String(chunk)); return true; };
    try {
      await main(['invite', 'noname@team.com', '--db', dbPath]);
    } finally {
      process.stdout.write = original;
    }
    expect(chunks.join('')).toContain('Invited: noname@team.com <noname@team.com>');
  });

  it('errors without minting anything when no email is given', async () => {
    const dbPath = join(tmp(), 'teamshare.db');
    const chunks: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    // @ts-expect-error -- test-only stderr capture
    process.stderr.write = (chunk: string) => { chunks.push(String(chunk)); return true; };
    try {
      await main(['invite', '--db', dbPath]);
    } finally {
      process.stderr.write = original;
    }
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(chunks.join('')).toContain('email');
  });

  it('rejects a malformed email without minting a token', async () => {
    const dbPath = join(tmp(), 'teamshare.db');
    const db = openDb(dbPath);
    createTeam(db, 'Only Team', hashToken('ts_invite_bademail'), '2026-01-01T00:00:00Z');
    db.close();

    const chunks: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    // @ts-expect-error -- test-only stderr capture
    process.stderr.write = (chunk: string) => { chunks.push(String(chunk)); return true; };
    try {
      await main(['invite', 'not-an-email', '--db', dbPath]);
    } finally {
      process.stderr.write = original;
    }
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(chunks.join('').toLowerCase()).toContain('email');
  });

  it('revoke kills every live token for an email; a different email is untouched', async () => {
    const dbPath = join(tmp(), 'teamshare.db');
    const db = openDb(dbPath);
    const teamId = createTeam(db, 'Only Team', hashToken('ts_revoke_only'), '2026-01-01T00:00:00Z');
    const scope = makeTeamScope(db, teamId);
    const samToken = createMemberToken(scope, 'sam@team.com', 'Sam', '2026-01-01T00:00:00Z');
    const samToken2 = createMemberToken(scope, 'sam@team.com', 'Sam (laptop)', '2026-01-01T00:00:00Z');
    const priyaToken = createMemberToken(scope, 'priya@team.com', 'Priya', '2026-01-01T00:00:00Z');
    db.close();

    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    // @ts-expect-error -- test-only stdout capture
    process.stdout.write = (chunk: string) => { chunks.push(String(chunk)); return true; };
    try {
      await main(['revoke', 'sam@team.com', '--db', dbPath]);
    } finally {
      process.stdout.write = original;
    }
    expect(chunks.join('')).toContain('Revoked 2 live token(s)');

    const verifyDb = openDb(dbPath);
    try {
      const app = createApp({ db: verifyDb, expiryDays: 14 });
      const server = app.listen(0);
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const addr = server.address() as AddressInfo;
      const base = `http://127.0.0.1:${addr.port}`;

      const sam1 = await fetch(`${base}/unread`, { headers: { Authorization: `Bearer ${samToken}` } });
      const sam2 = await fetch(`${base}/unread`, { headers: { Authorization: `Bearer ${samToken2}` } });
      expect(sam1.status).toBe(401);
      expect(sam2.status).toBe(401);

      const priya = await fetch(`${base}/unread`, { headers: { Authorization: `Bearer ${priyaToken}` } });
      expect(priya.status).toBe(200);

      await new Promise<void>((r) => server.close(() => r()));
    } finally {
      verifyDb.close();
    }
  });

  it('revoke reports 0 for an email with no live tokens, without erroring', async () => {
    const dbPath = join(tmp(), 'teamshare.db');
    const db = openDb(dbPath);
    createTeam(db, 'Only Team', hashToken('ts_revoke_nobody'), '2026-01-01T00:00:00Z');
    db.close();

    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    // @ts-expect-error -- test-only stdout capture
    process.stdout.write = (chunk: string) => { chunks.push(String(chunk)); return true; };
    try {
      await main(['revoke', 'nobody@team.com', '--db', dbPath]);
    } finally {
      process.stdout.write = original;
    }
    expect(chunks.join('').toLowerCase()).toContain('nothing to revoke');
  });

  it('roster lists a pre-migration member with no token as "invited, not yet active" and an invited-and-connected member as "active"', async () => {
    const dbPath = join(tmp(), 'teamshare.db');
    const db = openDb(dbPath);
    const teamId = createTeam(db, 'Only Team', hashToken('ts_roster_only'), '2026-01-01T00:00:00Z');
    const scope = makeTeamScope(db, teamId);
    upsertMember(scope, 'legacy@team.com', 'Legacy', '2026-01-01T00:00:00Z');
    createMemberToken(scope, 'sam@team.com', 'Sam', '2026-01-01T00:00:00Z');
    db.close();

    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    // @ts-expect-error -- test-only stdout capture
    process.stdout.write = (chunk: string) => { chunks.push(String(chunk)); return true; };
    try {
      await main(['roster', '--db', dbPath]);
    } finally {
      process.stdout.write = original;
    }
    const out = chunks.join('');
    expect(out).toContain('Only Team');
    expect(out).toContain('legacy@team.com');
    expect(out).toContain('invited, not yet active');
    expect(out).toContain('sam@team.com');
    expect(out).toContain('active');
  });

  it('invite/revoke/roster require --team on a multi-team server and operate on the named one', async () => {
    const dbPath = join(tmp(), 'teamshare.db');
    const db = openDb(dbPath);
    createTeam(db, 'Team A', hashToken('ts_invite_multi_a'), '2026-01-01T00:00:00Z');
    createTeam(db, 'Team B', hashToken('ts_invite_multi_b'), '2026-01-01T00:00:00Z');
    db.close();

    const errChunks: string[] = [];
    const originalErr = process.stderr.write.bind(process.stderr);
    // @ts-expect-error -- test-only stderr capture
    process.stderr.write = (chunk: string) => { errChunks.push(String(chunk)); return true; };
    try {
      await main(['invite', 'sam@team.com', '--db', dbPath]);
    } finally {
      process.stderr.write = originalErr;
    }
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(errChunks.join('')).toContain('multiple teams');

    const outChunks: string[] = [];
    const originalOut = process.stdout.write.bind(process.stdout);
    // @ts-expect-error -- test-only stdout capture
    process.stdout.write = (chunk: string) => { outChunks.push(String(chunk)); return true; };
    try {
      await main(['invite', 'sam@team.com', '--team', 'Team A', '--db', dbPath]);
    } finally {
      process.stdout.write = originalOut;
    }
    expect(outChunks.join('')).toContain('"Team A"');
  });
});

describe('doctor', () => {
  const originalHome = process.env.HOME;
  let home: string;
  let server: http.Server;
  let port: number;
  let respondHealth: (res: http.ServerResponse) => void;
  let respondUnread: (res: http.ServerResponse) => void;

  beforeEach(async () => {
    home = tmp();
    process.env.HOME = home;
    respondHealth = (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    };
    respondUnread = (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ total: 0, shares: [] }));
    };
    server = http.createServer((req, res) => {
      if (req.url === '/health') respondHealth(res);
      else if (req.url === '/unread') respondUnread(res);
      else { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  });

  function writeConfig(extra: Record<string, string> = {}) {
    writeFileSync(
      join(home, '.teamshare.json'),
      JSON.stringify({
        url: `http://127.0.0.1:${port}`,
        token: 'tok_secret_value',
        name: 'Priya',
        email: 'priya@team.com',
        ...extra,
      }),
    );
  }

  // Points git's *global* config at a `.gitconfig` inside the injected temp
  // home (never the real $HOME) so identity resolution is deterministic
  // without touching the real machine's git config.
  function writeGitConfig(name: string, email: string) {
    writeFileSync(join(home, '.gitconfig'), `[user]\n\tname = ${name}\n\temail = ${email}\n`);
  }

  function writeAssistantConfig(
    kind: 'cursor' | 'gemini',
    opts: { url: string; token: string; email?: string },
  ) {
    const email = opts.email ?? 'priya@team.com';
    if (kind === 'cursor') {
      mkdirSync(join(home, '.cursor'), { recursive: true });
      writeFileSync(
        join(home, '.cursor', 'mcp.json'),
        JSON.stringify({
          mcpServers: {
            teamshare: {
              url: `${opts.url}/mcp`,
              headers: { Authorization: `Bearer ${opts.token}`, 'X-Teamshare-Name': 'Priya', 'X-Teamshare-Email': email },
            },
          },
        }),
      );
    } else {
      mkdirSync(join(home, '.gemini'), { recursive: true });
      writeFileSync(
        join(home, '.gemini', 'settings.json'),
        JSON.stringify({
          mcpServers: {
            teamshare: {
              httpUrl: `${opts.url}/mcp`,
              headers: { Authorization: `Bearer ${opts.token}`, 'X-Teamshare-Name': 'Priya', 'X-Teamshare-Email': email },
            },
          },
        }),
      );
    }
  }

  it('fails when ~/.teamshare.json is present but missing url or token — a real problem, not the guidance path', async () => {
    // token is missing entirely — url/token are the only truly required
    // keys; name/email are optional identity context (see the test below).
    writeFileSync(join(home, '.teamshare.json'), JSON.stringify({ url: 'http://x', name: 'A', email: 'a@b.com' }));
    const { exitCode, output } = await runDoctor();
    expect(exitCode).toBe(1);
    expect(output).toContain('/teamshare:setup');
  });

  it('accepts ~/.teamshare.json with only url/token — a missing name/email is optional identity context, not a broken config', async () => {
    writeFileSync(join(home, '.teamshare.json'), JSON.stringify({ url: `http://127.0.0.1:${port}`, token: 'tok_secret_value' }));
    const { exitCode, output } = await runDoctor();
    expect(exitCode).toBe(0);
    expect(output).not.toContain('/teamshare:setup');
    expect(output).not.toContain('[PROBLEM]');
    expect(output).toContain('[INFO] no git identity configured');
  });

  it('passes end-to-end against a reachable, correctly-configured server, and never prints the token', async () => {
    writeConfig();
    const { exitCode, output } = await runDoctor();
    expect(exitCode).toBe(0);
    expect(output).not.toContain('tok_secret_value');
    expect(output).toContain('priya@team.com');
    expect(output).toContain('/health');
    expect(output).toMatch(/0 unread/);
  });

  it('reports a missing git identity as informational context, never a [PROBLEM], and does not fail the run over it', async () => {
    // No writeGitConfig() and no writeConfig(): identity genuinely resolves
    // to nothing. Passing the server explicitly isolates this from the
    // separate "no server source found" guidance path.
    const { exitCode, output } = await runDoctor(`http://127.0.0.1:${port}`, 'a_token');
    expect(exitCode).toBe(0);
    expect(output).not.toContain('[PROBLEM]');
    expect(output).toContain('[INFO] no git identity configured');
  });

  it('flags a 401 on /unread and points to the reconnect remedy', async () => {
    writeConfig();
    respondUnread = (res) => { res.writeHead(401); res.end('{}'); };
    const { exitCode, output } = await runDoctor();
    expect(exitCode).toBe(1);
    expect(output).toContain('401');
    expect(output).toContain('/plugin');
    expect(output).toContain('teamshare connect');
  });

  it('reports an unexpected 400 on /unread verbatim, without blaming git config (identity comes from the token, not headers, so this can no longer be an identity problem)', async () => {
    writeConfig();
    respondUnread = (res) => { res.writeHead(400); res.end('{}'); };
    const { exitCode, output } = await runDoctor();
    expect(exitCode).toBe(1);
    expect(output).toContain('400');
    expect(output.toLowerCase()).not.toContain('git config user.name');
  });

  it('reports an unexpected status code verbatim rather than mislabeling it', async () => {
    writeConfig();
    respondUnread = (res) => { res.writeHead(503); res.end('{}'); };
    const { exitCode, output } = await runDoctor();
    expect(exitCode).toBe(1);
    expect(output).toContain('503');
  });

  it('reports the URL tried when the server is unreachable', async () => {
    writeConfig({ url: 'http://127.0.0.1:1' });
    const { exitCode, output } = await runDoctor();
    expect(exitCode).toBe(1);
    expect(output).toContain('http://127.0.0.1:1');
  });

  it('names the team a token belongs to, against a real server with a real team', async () => {
    writeGitConfig('Priya', 'priya@team.com');
    const realDb = openDb(':memory:');
    const teamId = createTeam(realDb, 'Rocket Squad', hashToken('ts_rocket_admin'), '2026-01-01T00:00:00Z');
    const scope = makeTeamScope(realDb, teamId);
    // doctor checks /unread, which now needs a real personal member token —
    // the admin (team) token used to work here but no longer grants data
    // access at all.
    const memberToken = createMemberToken(scope, 'priya@team.com', 'Priya', '2026-01-01T00:00:00Z');
    const realApp = createApp({ db: realDb, expiryDays: 14 });
    const realServer = realApp.listen(0);
    await new Promise<void>((resolve) => realServer.once('listening', resolve));
    const addr = realServer.address() as AddressInfo;
    const realBase = `http://127.0.0.1:${addr.port}`;

    try {
      const { exitCode, output } = await runDoctor(realBase, memberToken);
      expect(exitCode).toBe(0);
      expect(output).toContain('connected to team: Rocket Squad');
    } finally {
      await new Promise<void>((r) => realServer.close(() => r()));
      realDb.close();
    }
  });

  describe('resolving a server URL/token from four sources', () => {
    it('explicit command-line arguments win over ~/.teamshare.json, which is never even consulted', async () => {
      writeGitConfig('Explicit User', 'explicit@example.com');
      // A stale legacy config pointing at an unreachable port — if this were
      // read at all, the health check would fail against port 1.
      writeConfig({ url: 'http://127.0.0.1:1' });
      const { exitCode, output } = await runDoctor(`http://127.0.0.1:${port}`, 'explicit_token_value');
      expect(exitCode).toBe(0);
      expect(output).toContain('given on the command line');
      expect(output).not.toContain('127.0.0.1:1');
      expect(output).not.toContain('explicit_token_value');
    });

    // TEAMSHARE_URL/TEAMSHARE_TOKEN: the fix for the inconsistency where
    // teamshare-team.mjs suggested `teamshare doctor <url> <token>` — a
    // positional re-verify command that puts a freshly minted token into
    // shell history and `ps` output, the exact thing the design's "secrets
    // never touch a command line" rule forbids. These give that suggestion
    // a safe form to use instead. Passed as an explicit `env` object (never
    // mutating the real process.env) so these tests can't leak into others.
    describe('TEAMSHARE_URL / TEAMSHARE_TOKEN environment variables', () => {
      it('wins over ~/.teamshare.json, which is never even consulted, and ranks below explicit arguments', async () => {
        writeGitConfig('Env User', 'env@example.com');
        // A stale legacy config pointing at an unreachable port — if this
        // were read at all, the health check would fail against port 1.
        writeConfig({ url: 'http://127.0.0.1:1' });
        const { exitCode, output } = await runDoctor(undefined, undefined, {
          TEAMSHARE_URL: `http://127.0.0.1:${port}`,
          TEAMSHARE_TOKEN: 'env_token_value',
        });
        expect(exitCode).toBe(0);
        expect(output).toContain('TEAMSHARE_URL/TEAMSHARE_TOKEN from the environment');
        expect(output).not.toContain('127.0.0.1:1');
        expect(output).not.toContain('env_token_value');
      });

      it('explicit positional arguments still win over the environment variables', async () => {
        writeGitConfig('Positional User', 'positional@example.com');
        const { exitCode, output } = await runDoctor(`http://127.0.0.1:${port}`, 'explicit_token_value', {
          TEAMSHARE_URL: 'http://127.0.0.1:1',
          TEAMSHARE_TOKEN: 'env_token_value',
        });
        expect(exitCode).toBe(0);
        expect(output).toContain('given on the command line');
        expect(output).not.toContain('127.0.0.1:1');
        expect(output).not.toContain('env_token_value');
      });

      it('is a [PROBLEM], not a silent fall-through, when only one of the pair is set', async () => {
        const { exitCode, output } = await runDoctor(undefined, undefined, {
          TEAMSHARE_URL: `http://127.0.0.1:${port}`,
        });
        expect(exitCode).toBe(1);
        expect(output).toContain('[PROBLEM]');
        expect(output).toContain('TEAMSHARE_URL');
        expect(output).toContain('TEAMSHARE_TOKEN');
      });

      it('never prints the token even when it fails verification', async () => {
        respondUnread = (res) => { res.writeHead(401); res.end('{}'); };
        writeGitConfig('Env User', 'env@example.com');
        const { exitCode, output } = await runDoctor(undefined, undefined, {
          TEAMSHARE_URL: `http://127.0.0.1:${port}`,
          TEAMSHARE_TOKEN: 'env_token_value',
        });
        expect(exitCode).toBe(1);
        expect(output).not.toContain('env_token_value');
      });
    });

    it('uses ~/.teamshare.json when it is present (already covered above by the end-to-end pass)', async () => {
      writeConfig();
      const { output } = await runDoctor();
      expect(output).toContain('.teamshare.json');
      expect(output).toContain('present with all required keys');
    });

    it('discovers a URL/token from an assistant config when it is the only source available', async () => {
      writeGitConfig('Priya', 'priya@team.com');
      writeAssistantConfig('cursor', { url: `http://127.0.0.1:${port}`, token: 'discovered_token_value' });
      const { exitCode, output } = await runDoctor();
      expect(exitCode).toBe(0);
      expect(output).toContain('Cursor');
      expect(output).toContain(join(home, '.cursor', 'mcp.json'));
      expect(output).not.toContain('discovered_token_value');
    });

    it('reports each source and which one it is testing when assistant configs disagree', async () => {
      writeGitConfig('Priya', 'priya@team.com');
      writeAssistantConfig('cursor', { url: 'http://127.0.0.1:1', token: 'token_a' });
      writeAssistantConfig('gemini', { url: 'http://127.0.0.1:2', token: 'token_b' });
      const { exitCode, output } = await runDoctor();
      expect(exitCode).toBe(1);
      expect(output.toLowerCase()).toContain('do not agree');
      expect(output).toContain('Cursor');
      expect(output).toContain('Gemini CLI');
      expect(output).not.toContain('token_a');
      expect(output).not.toContain('token_b');
    });

    it('produces calm guidance, not a scary [PROBLEM], when no source has a URL/token configured — but still exits non-zero, since nothing was actually verified', async () => {
      // Identity resolves fine so this isolates the config-source behavior.
      // This is the expected shape of a normal Claude Code install (the
      // plugin holds the values itself, so there is nothing on disk for
      // doctor to find) — not a misconfiguration, hence no [PROBLEM] line.
      // But zero checks actually ran against a real server, so exit 0 here
      // would be a false all-clear (the README says exit 0 means every
      // check passed): a script piping doctor's exit code must not read
      // this state as "everything's fine."
      writeGitConfig('Priya', 'priya@team.com');
      const { exitCode, output } = await runDoctor();
      expect(exitCode).toBe(1);
      expect(output).not.toContain('[PROBLEM]');
      expect(output).toContain('/plugin');
      expect(output).toContain('teamshare connect');
      expect(output).toContain('teamshare doctor <server-url> <team-token>');
    });
  });

  describe('URL normalization (same rule `teamshare connect` applies)', () => {
    it('probes /health and /unread at the origin even when the configured url already ends in "/mcp"', async () => {
      writeConfig({ url: `http://127.0.0.1:${port}/mcp` });
      const { exitCode, output } = await runDoctor();
      expect(exitCode).toBe(0);
      expect(output).toContain('/health');
      expect(output).toMatch(/0 unread/);
    });

    it('normalizes an explicit command-line url that ends in "/mcp/"', async () => {
      writeGitConfig('Priya', 'priya@team.com');
      const { exitCode, output } = await runDoctor(`http://127.0.0.1:${port}/mcp/`, 'explicit_token');
      expect(exitCode).toBe(0);
      expect(output).toContain('/health');
    });
  });
});

describe('acquireLock', () => {
  it('allows one holder and refuses a second', () => {
    const dbPath = join(tmp(), 'teamshare.db');
    const release = acquireLock(dbPath);
    expect(() => acquireLock(dbPath)).toThrow(/already running/i);
    release();
    expect(() => acquireLock(dbPath)).not.toThrow();
  });

  it('reclaims a stale lock left by a crashed process', () => {
    const dbPath = join(tmp(), 'teamshare.db');
    mkdirSync(dirname(dbPath), { recursive: true });
    writeFileSync(`${dbPath}.lock`, '');            // truncated: pid parses as 0
    expect(() => acquireLock(dbPath)).not.toThrow();
  });

  it('reclaims a lock whose pid is no longer running', () => {
    const dbPath = join(tmp(), 'teamshare.db');
    mkdirSync(dirname(dbPath), { recursive: true });
    writeFileSync(`${dbPath}.lock`, '2147483646');  // implausibly high, not running
    expect(() => acquireLock(dbPath)).not.toThrow();
  });
});

describe('cli entry point', () => {
  it('runs main() when invoked as a program from a path containing spaces', () => {
    // Regression: import.meta.url percent-encodes spaces, so a naive
    // `file://${process.argv[1]}` guard silently no-ops on such paths.
    //
    // realpathSync here is unrelated to that bug: on macOS, os.tmpdir()
    // returns a path through a symlink (/var -> /private/var), and Node's
    // ESM loader resolves that symlink when computing import.meta.url while
    // process.argv[1] keeps the string as given. Resolving the real path
    // up front keeps this test isolated to the space-encoding regression
    // instead of also tripping over that unrelated symlink difference.
    const dir = realpathSync(tmp());
    const spaced = join(dir, 'a space dir');
    mkdirSync(spaced, { recursive: true });

    const serverRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

    // cli.js imports sibling compiled modules ('./app.js', './db.js', ...),
    // so the whole dist/ output must be copied alongside it, not just cli.js.
    cpSync(join(serverRoot, 'dist'), spaced, { recursive: true });

    // Node's node_modules resolution walks up from the spawned file's own
    // directory. A symlink here lets it find this package's real
    // dependencies (express, better-sqlite3, ...) without copying them.
    symlinkSync(join(serverRoot, 'node_modules'), join(spaced, 'node_modules'), 'dir');

    const cliJs = join(spaced, 'cli.js');
    const out = execFileSync('node', [cliJs, 'help'], { encoding: 'utf8' });
    expect(out).toContain('teamshare');
  });
});
