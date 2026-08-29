import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Server } from 'node:http';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  openDb, getOrCreateToken, hasToken, rotateToken, upsertMember,
  listMembers, removeMember, normalizeEmail, migrateSchema, hashToken,
  createTeam, getOrCreateDefaultTeamId, makeTeamScope, type Db, type TeamScope,
} from './db.js';
import { createShare, getShare, listShares, retractShare } from './shares.js';
import { recordReceipt, getReceipts } from './receipts.js';
import { createApp } from './app.js';

let db: Db;
beforeEach(() => { db = openDb(':memory:'); });
afterEach(() => { db.close(); });

describe('normalizeEmail', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmail('  Adnan@Team.COM ')).toBe('adnan@team.com');
  });
});

describe('token', () => {
  it('creates a token once and returns the same one after', () => {
    const a = getOrCreateToken(db);
    const b = getOrCreateToken(db);
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });

  it('rotates to a different token', () => {
    const a = getOrCreateToken(db);
    const b = rotateToken(db);
    expect(b).not.toBe(a);
    expect(getOrCreateToken(db)).toBe(b);
  });
});

describe('hasToken', () => {
  // Lets a caller (the `serve` CLI path) distinguish "first ever run" from
  // "already configured" BEFORE calling getOrCreateToken, which would
  // otherwise mint one and erase that distinction — this is what makes the
  // "print the token exactly once" behavior possible.
  it('is false before any token exists and true once one has been created', () => {
    expect(hasToken(db)).toBe(false);
    getOrCreateToken(db);
    expect(hasToken(db)).toBe(true);
  });

  it('stays true across rotation', () => {
    getOrCreateToken(db);
    rotateToken(db);
    expect(hasToken(db)).toBe(true);
  });
});

describe('teams', () => {
  it('getOrCreateDefaultTeamId bootstraps exactly one team, lazily and idempotently', () => {
    const a = getOrCreateDefaultTeamId(db);
    const b = getOrCreateDefaultTeamId(db);
    expect(a).toBe(b);
    const count = db.prepare('SELECT COUNT(*) AS n FROM teams').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('reuses the token already present rather than minting a second, disagreeing one', () => {
    const token = getOrCreateToken(db);
    const teamId = getOrCreateDefaultTeamId(db);
    const row = db.prepare('SELECT token_hash FROM teams WHERE id = ?').get(teamId) as { token_hash: string };
    expect(row.token_hash).toBe(hashToken(token));
    expect(getOrCreateToken(db)).toBe(token); // unchanged, not re-minted
  });

  it('createTeam adds an additional, independent team', () => {
    const first = getOrCreateDefaultTeamId(db);
    const second = createTeam(db, 'second team', hashToken('ts_second'), '2026-08-29T00:00:00.000Z');
    expect(second).not.toBe(first);
    const count = db.prepare('SELECT COUNT(*) AS n FROM teams').get() as { n: number };
    expect(count.n).toBe(2);
  });
});

describe('members', () => {
  let scope: TeamScope;
  beforeEach(() => {
    scope = makeTeamScope(db, getOrCreateDefaultTeamId(db));
  });

  it('upserts by normalized email and keeps first_seen while updating last_seen', () => {
    upsertMember(scope, 'Adnan@Team.com', 'Adnan', '2026-01-01T00:00:00Z');
    upsertMember(scope, 'adnan@team.com', 'Adnan R', '2026-01-02T00:00:00Z');
    const members = listMembers(scope);
    expect(members).toHaveLength(1);
    expect(members[0].email).toBe('adnan@team.com');
    expect(members[0].name).toBe('Adnan R');
    expect(members[0].first_seen).toBe('2026-01-01T00:00:00Z');
    expect(members[0].last_seen).toBe('2026-01-02T00:00:00Z');
  });

  it('removes a member and reports whether one was removed', () => {
    upsertMember(scope, 'a@t.com', 'A', '2026-01-01T00:00:00Z');
    expect(removeMember(scope, 'A@T.com')).toBe(true);
    expect(removeMember(scope, 'a@t.com')).toBe(false);
    expect(listMembers(scope)).toHaveLength(0);
  });

  it('a member in one team is invisible to another team, even with the same email', () => {
    const otherTeamId = createTeam(db, 'other', hashToken('ts_other'), '2026-01-01T00:00:00Z');
    const other = makeTeamScope(db, otherTeamId);
    upsertMember(scope, 'shared@x.com', 'Mine', '2026-01-01T00:00:00Z');
    upsertMember(other, 'shared@x.com', 'Theirs', '2026-01-01T00:00:00Z');
    expect(listMembers(scope).map((m) => m.name)).toEqual(['Mine']);
    expect(listMembers(other).map((m) => m.name)).toEqual(['Theirs']);
    expect(removeMember(other, 'shared@x.com')).toBe(true);
    expect(listMembers(scope)).toHaveLength(1); // untouched by the other team's removal
  });
});

// ---------------------------------------------------------------------------
// Schema migration
//
// The naive test ("build a v2 db, open it, assert rows survived") passes
// against nearly every broken variant of this migration. What follows
// implements the seven properties the design doc requires instead.
// ---------------------------------------------------------------------------

const T0 = '2026-08-01T00:00:00.000Z';

// A v1-shaped database: no stale_at, no team_id anywhere, matching the very
// first teamshare schema before the stale_at patch existed.
function createV1Db(dbPath: string): Database.Database {
  const raw = new Database(dbPath);
  raw.exec(`
    CREATE TABLE config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE members (
      email      TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      first_seen TEXT NOT NULL,
      last_seen  TEXT NOT NULL
    );
    CREATE TABLE shares (
      id           TEXT PRIMARY KEY,
      sender_email TEXT NOT NULL,
      what         TEXT NOT NULL,
      why          TEXT,
      action       TEXT,
      tags         TEXT NOT NULL DEFAULT '[]',
      priority     TEXT NOT NULL,
      created_at   TEXT NOT NULL
    );
    CREATE TABLE receipts (
      share_id     TEXT NOT NULL,
      member_email TEXT NOT NULL,
      status       TEXT NOT NULL,
      at           TEXT NOT NULL,
      PRIMARY KEY (share_id, member_email)
    );
    CREATE INDEX idx_shares_created ON shares (created_at);
  `);
  return raw;
}

// A v2-shaped database: today's real production shape (stale_at present,
// schema_version recorded, still single-team).
function createV2Db(dbPath: string): Database.Database {
  const raw = createV1Db(dbPath);
  raw.exec('ALTER TABLE shares ADD COLUMN stale_at TEXT');
  raw.prepare(`INSERT INTO config (key, value) VALUES ('schema_version', '2')`).run();
  return raw;
}

function seedToken(raw: Database.Database, token: string): void {
  raw.prepare(`INSERT INTO config (key, value) VALUES ('team_token', ?)`).run(token);
}

// The exact production shape named in the design doc: 6 members, 0 shares.
function seedProductionShape(raw: Database.Database, token: string): void {
  seedToken(raw, token);
  for (let i = 0; i < 6; i++) {
    raw
      .prepare(`INSERT INTO members (email, name, first_seen, last_seen) VALUES (?, ?, ?, ?)`)
      .run(`member${i}@team.com`, `Member ${i}`, T0, T0);
  }
}

// A "fat" fixture: shares, receipts, and a stale share on top of members —
// empty and populated fixtures fail differently, so both need coverage.
function seedFatShape(raw: Database.Database, token: string): void {
  seedProductionShape(raw, token);
  raw
    .prepare(
      `INSERT INTO shares (id, sender_email, what, why, action, tags, priority, created_at, stale_at)
       VALUES (?, ?, ?, NULL, NULL, '[]', 'fyi', ?, NULL)`,
    )
    .run('shr_fat_a', 'member0@team.com', 'fat fixture share a', T0);
  raw
    .prepare(
      `INSERT INTO shares (id, sender_email, what, why, action, tags, priority, created_at, stale_at)
       VALUES (?, ?, ?, NULL, NULL, '[]', 'fyi', ?, ?)`,
    )
    .run('shr_fat_stale', 'member1@team.com', 'fat fixture stale share', T0, T0);
  raw
    .prepare(`INSERT INTO receipts (share_id, member_email, status, at) VALUES (?, ?, ?, ?)`)
    .run('shr_fat_a', 'member2@team.com', 'viewed', T0);
}

describe('schema migration', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'teamshare-migration-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // Property 5 (fixture coverage) is exercised across this describe block via
  // both seedProductionShape (this test) and seedFatShape (used below).

  // Property 1: open three times; team count, member count, and version must
  // be stable — catches non-idempotency and version downgrade.
  it('is idempotent across repeated opens: stable team count, member count, and version', () => {
    const dbPath = join(dir, 'prod.db');
    const raw = createV2Db(dbPath);
    seedProductionShape(raw, 'ts_repeatopen');
    raw.close();

    for (let i = 0; i < 3; i++) {
      const opened = openDb(dbPath);
      try {
        const version = opened.prepare(`SELECT value FROM config WHERE key = 'schema_version'`).get() as
          | { value: string }
          | undefined;
        const teams = opened.prepare('SELECT COUNT(*) AS n FROM teams').get() as { n: number };
        const members = opened.prepare('SELECT COUNT(*) AS n FROM members').get() as { n: number };
        expect(version?.value).toBe('3');
        expect(teams.n).toBe(1);
        expect(members.n).toBe(6);
      } finally {
        opened.close();
      }
    }
  });

  // Property 2: fault injection. Throwing after each individual sub-step of
  // the 2->3 migration must roll back the WHOLE step, leaving the file at
  // exactly v2 — the only assertion that actually proves atomicity — and a
  // clean reopen must then complete normally.
  describe('fault injection: the 2->3 migration is atomic', () => {
    const subSteps = [
      '2->3:teams-table',
      '2->3:default-team',
      '2->3:members',
      '2->3:shares',
      '2->3:receipts',
      '2->3:indexes',
      '2->3:version',
    ];

    for (const label of subSteps) {
      it(`rolls back completely when the migration throws at "${label}"`, () => {
        const dbPath = join(dir, `fault-${label.replace(/[^a-z0-9]/gi, '_')}.db`);
        const raw = createV2Db(dbPath);
        seedFatShape(raw, 'ts_faultinject');
        raw.close();

        const probeDb = new Database(dbPath);
        probeDb.pragma('foreign_keys = ON');
        expect(() => {
          migrateSchema(probeDb, '2026-08-29T00:00:00.000Z', (l) => {
            if (l === label) throw new Error(`injected fault at ${label}`);
          });
        }).toThrow(`injected fault at ${label}`);

        const version = probeDb.prepare(`SELECT value FROM config WHERE key = 'schema_version'`).get() as
          | { value: string }
          | undefined;
        expect(version?.value).toBe('2');
        // The old-shaped tables must be completely untouched — not partially
        // rebuilt, not missing rows.
        const memberCount = probeDb.prepare('SELECT COUNT(*) AS n FROM members').get() as { n: number };
        expect(memberCount.n).toBe(6);
        const shareCount = probeDb.prepare('SELECT COUNT(*) AS n FROM shares').get() as { n: number };
        expect(shareCount.n).toBe(2);
        const teamsExist = probeDb
          .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='teams'`)
          .all();
        // teams may or may not exist depending on which sub-step failed, but
        // if it does, it must be empty — never a half-populated team.
        if (teamsExist.length > 0) {
          const teamCount = probeDb.prepare('SELECT COUNT(*) AS n FROM teams').get() as { n: number };
          expect(teamCount.n).toBe(0);
        }
        probeDb.close();

        // A clean reopen must complete the migration normally.
        const recovered = openDb(dbPath);
        try {
          const recoveredVersion = recovered
            .prepare(`SELECT value FROM config WHERE key = 'schema_version'`)
            .get() as { value: string };
          expect(recoveredVersion.value).toBe('3');
          const teams = recovered.prepare('SELECT COUNT(*) AS n FROM teams').get() as { n: number };
          expect(teams.n).toBe(1);
          const members = recovered.prepare('SELECT COUNT(*) AS n FROM members').get() as { n: number };
          expect(members.n).toBe(6);
        } finally {
          recovered.close();
        }
      });
    }
  });

  // Property 3: structural schema equality between a migrated database and a
  // fresh install, compared via PRAGMA introspection — not SQL text, which
  // differs by whitespace and by the quoting RENAME leaves.
  it('produces a structurally identical schema to a fresh install', () => {
    const dbPath = join(dir, 'structural.db');
    const raw = createV2Db(dbPath);
    seedProductionShape(raw, 'ts_structural');
    raw.close();

    const migrated = openDb(dbPath);
    const fresh = openDb(':memory:');
    try {
      for (const table of ['teams', 'members', 'shares', 'receipts', 'config']) {
        expect(migrated.prepare(`PRAGMA table_info(${table})`).all()).toEqual(
          fresh.prepare(`PRAGMA table_info(${table})`).all(),
        );

        // Compare index shape, not generated names (an autoindex name can
        // differ from a table's creation history without the schema itself
        // differing).
        const shape = (idx: unknown[]) =>
          (idx as { unique: number; origin: string; partial: number }[]).map((i) => ({
            unique: i.unique,
            origin: i.origin,
            partial: i.partial,
          }));
        expect(shape(migrated.prepare(`PRAGMA index_list(${table})`).all())).toEqual(
          shape(fresh.prepare(`PRAGMA index_list(${table})`).all()),
        );

        expect(migrated.prepare(`PRAGMA foreign_key_list(${table})`).all()).toEqual(
          fresh.prepare(`PRAGMA foreign_key_list(${table})`).all(),
        );
      }
    } finally {
      migrated.close();
      fresh.close();
    }
  });

  // Property 4: drive the real app after migrating, rather than asserting on
  // raw SELECTs — so a broken upsertMember ON CONFLICT, or a broken route,
  // cannot slip through.
  it('serves the real app after migrating: authenticated GET /unread, then create/read/receipt/retract', async () => {
    const dbPath = join(dir, 'live.db');
    const TOKEN = 'ts_liveappmigrationtoken';
    const raw = createV2Db(dbPath);
    seedProductionShape(raw, TOKEN);
    raw.close();

    const liveDb = openDb(dbPath);
    const NOW = '2026-08-29T00:00:00.000Z';
    const app = createApp({ db: liveDb, expiryDays: 14, now: () => NOW });
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const addr = server.address();
    const base = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';

    const headers = (email: string, name: string) => ({
      Authorization: `Bearer ${TOKEN}`,
      'X-Teamshare-Email': email,
      'X-Teamshare-Name': name,
    });

    try {
      const unreadRes = await fetch(`${base}/unread`, { headers: headers('member0@team.com', 'Member 0') });
      expect(unreadRes.status).toBe(200);
      expect((await unreadRes.json()).total).toBe(0);

      async function connect(email: string, name: string) {
        const client = new Client({ name: 'migration-test', version: '1.0.0' });
        const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
          requestInit: { headers: headers(email, name) },
        });
        await client.connect(transport);
        return client;
      }
      function textOf(result: { content: unknown }): string {
        return (result.content as { type: string; text: string }[])
          .filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join('\n');
      }

      const author = await connect('member0@team.com', 'Member 0');
      const created = await author.callTool({
        name: 'share',
        arguments: { what: 'post-migration share', priority: 'blocking' },
      });
      const id = JSON.parse(textOf(created)).id as string;
      await author.close();

      const reader = await connect('member1@team.com', 'Member 1');
      const digest = textOf(await reader.callTool({ name: 'unread', arguments: {} }));
      expect(digest).toContain('post-migration share');
      const readBack = textOf(await reader.callTool({ name: 'read_share', arguments: { id } }));
      expect(readBack).toContain('post-migration share');
      await reader.close();

      const author2 = await connect('member0@team.com', 'Member 0');
      const receiptsSummary = textOf(await author2.callTool({ name: 'receipts', arguments: { id } }));
      expect(receiptsSummary).toContain('viewed');
      const retracted = await author2.callTool({ name: 'retract', arguments: { id } });
      expect(retracted.isError).toBeFalsy();
      await author2.close();

      const verifier = await connect('member2@team.com', 'Member 2');
      const afterRetract = await verifier.callTool({ name: 'read_share', arguments: { id } });
      expect(afterRetract.isError).toBe(true);
      await verifier.close();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      liveDb.close();
    }
  });

  // Property 6: ugly fixtures.

  it('ugly fixture: aborts with a clear message when a populated v2 database has no team_token', () => {
    const dbPath = join(dir, 'no-token.db');
    const raw = createV2Db(dbPath);
    raw.prepare(`INSERT INTO members (email, name, first_seen, last_seen) VALUES (?, ?, ?, ?)`).run(
      'a@b.com', 'A', T0, T0,
    );
    raw.close();

    expect(() => openDb(dbPath)).toThrow(/team_token|create-team/i);
  });

  it('ugly fixture: an empty v2 database with no token is just a fresh install, not an abort', () => {
    const dbPath = join(dir, 'empty-no-token.db');
    createV2Db(dbPath).close();

    const opened = openDb(dbPath);
    try {
      const version = opened.prepare(`SELECT value FROM config WHERE key = 'schema_version'`).get() as {
        value: string;
      };
      expect(version.value).toBe('3');
      const teams = opened.prepare('SELECT COUNT(*) AS n FROM teams').get() as { n: number };
      expect(teams.n).toBe(0);
    } finally {
      opened.close();
    }
  });

  it('ugly fixture: a v1 database (pre-dating stale_at) hops directly to v3 without failing on "no such column: stale_at"', () => {
    const dbPath = join(dir, 'v1-direct.db');
    const raw = createV1Db(dbPath);
    seedToken(raw, 'ts_v1directtoken');
    raw.prepare(`INSERT INTO config (key, value) VALUES ('schema_version', '1')`).run();
    raw.prepare(`INSERT INTO members (email, name, first_seen, last_seen) VALUES (?, ?, ?, ?)`).run(
      'adnan@team.com', 'Adnan', T0, T0,
    );
    raw
      .prepare(
        `INSERT INTO shares (id, sender_email, what, why, action, tags, priority, created_at)
         VALUES (?, ?, ?, NULL, NULL, '[]', 'fyi', ?)`,
      )
      .run('shr_v1direct', 'adnan@team.com', 'v1 share surviving a direct hop', T0);
    raw.close();

    const opened = openDb(dbPath);
    try {
      const version = opened.prepare(`SELECT value FROM config WHERE key = 'schema_version'`).get() as {
        value: string;
      };
      expect(version.value).toBe('3');
      const cols = opened.prepare('PRAGMA table_info(shares)').all() as { name: string }[];
      expect(cols.some((c) => c.name === 'stale_at')).toBe(true);
      expect(cols.some((c) => c.name === 'team_id')).toBe(true);
      const share = opened.prepare('SELECT * FROM shares WHERE id = ?').get('shr_v1direct') as
        | Record<string, unknown>
        | undefined;
      expect(share?.what).toBe('v1 share surviving a direct hop');
      expect(share?.team_id).toBeTruthy();
    } finally {
      opened.close();
    }
  });

  it('ugly fixture: a share whose sender is absent from members migrates without crashing or losing data', () => {
    const dbPath = join(dir, 'orphan-sender.db');
    const raw = createV2Db(dbPath);
    seedToken(raw, 'ts_orphansender');
    raw
      .prepare(
        `INSERT INTO shares (id, sender_email, what, why, action, tags, priority, created_at, stale_at)
         VALUES (?, ?, ?, NULL, NULL, '[]', 'fyi', ?, NULL)`,
      )
      .run('shr_orphan', 'ghost@team.com', 'sender not in members', T0);
    raw.close();

    const opened = openDb(dbPath);
    try {
      const share = opened.prepare('SELECT * FROM shares WHERE id = ?').get('shr_orphan') as
        | Record<string, unknown>
        | undefined;
      expect(share).toBeDefined();
      expect(share?.what).toBe('sender not in members');
      expect(share?.team_id).toBeTruthy();
    } finally {
      opened.close();
    }
  });

  // Property 7: post-migration isolation, plus a clean bill of health.
  it('post-migration: a second team cannot see, read, retract, or receipt the migrated team\'s share; DB passes integrity checks', () => {
    const dbPath = join(dir, 'post-migration-isolation.db');
    const raw = createV2Db(dbPath);
    seedFatShape(raw, 'ts_postmigrationiso');
    raw.close();

    const opened = openDb(dbPath);
    try {
      const migratedTeamId = (opened.prepare('SELECT id FROM teams LIMIT 1').get() as { id: string }).id;
      const migratedScope = makeTeamScope(opened, migratedTeamId);

      const secondTeamId = createTeam(opened, 'second', hashToken('ts_second_intruder'), T0);
      const secondScope = makeTeamScope(opened, secondTeamId);
      upsertMember(secondScope, 'intruder@other.com', 'Intruder', T0);

      const migratedShare = getShare(migratedScope, 'shr_fat_a');
      expect(migratedShare).toBeDefined();

      expect(getShare(secondScope, 'shr_fat_a')).toBeUndefined();
      expect(listShares(secondScope, {}).map((s) => s.id)).not.toContain('shr_fat_a');

      const retractAttempt = retractShare(secondScope, 'shr_fat_a', 'intruder@other.com');
      expect(retractAttempt).toEqual({ ok: false, error: 'no share with id shr_fat_a' });

      const receiptWritten = recordReceipt(secondScope, 'shr_fat_a', 'intruder@other.com', 'viewed', T0);
      expect(receiptWritten).toBe(false);
      expect(getReceipts(secondScope, 'shr_fat_a', T0, 14)).toBeUndefined();

      // The migrated team's share must be untouched by all of the above.
      expect(getShare(migratedScope, 'shr_fat_a')).toBeDefined();

      const fkCheck = opened.prepare('PRAGMA foreign_key_check').all();
      expect(fkCheck).toEqual([]);
      const integrity = opened.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      expect(integrity.integrity_check).toBe('ok');
    } finally {
      opened.close();
    }
  });
});
