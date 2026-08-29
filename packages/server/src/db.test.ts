import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDb, getOrCreateToken, rotateToken, upsertMember,
  listMembers, removeMember, normalizeEmail, type Db,
} from './db.js';

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

describe('members', () => {
  it('upserts by normalized email and keeps first_seen while updating last_seen', () => {
    upsertMember(db, 'Adnan@Team.com', 'Adnan', '2026-01-01T00:00:00Z');
    upsertMember(db, 'adnan@team.com', 'Adnan R', '2026-01-02T00:00:00Z');
    const members = listMembers(db);
    expect(members).toHaveLength(1);
    expect(members[0].email).toBe('adnan@team.com');
    expect(members[0].name).toBe('Adnan R');
    expect(members[0].first_seen).toBe('2026-01-01T00:00:00Z');
    expect(members[0].last_seen).toBe('2026-01-02T00:00:00Z');
  });

  it('removes a member and reports whether one was removed', () => {
    upsertMember(db, 'a@t.com', 'A', '2026-01-01T00:00:00Z');
    expect(removeMember(db, 'A@T.com')).toBe(true);
    expect(removeMember(db, 'a@t.com')).toBe(false);
    expect(listMembers(db)).toHaveLength(0);
  });
});

describe('schema migration', () => {
  // Genuinely exercises the PRAGMA table_info(shares) migration path: builds
  // a DB file with the OLD (pre-stale_at) schema, closes it, then reopens it
  // with openDb — the same function a real team's upgrade would call. Do NOT
  // "prove" this by calling openDb twice on a current-schema DB; that never
  // touches the ALTER TABLE branch at all.
  let dir: string;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('adds stale_at to a database created by an earlier version, keeping existing rows and bumping schema_version', () => {
    dir = mkdtempSync(join(tmpdir(), 'teamshare-migration-'));
    const dbPath = join(dir, 'old.db');

    const old = new Database(dbPath);
    old.exec(`
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
    `);
    old
      .prepare(
        `INSERT INTO shares (id, sender_email, what, why, action, tags, priority, created_at)
         VALUES ('shr_old1', 'adnan@team.com', 'pre-migration share', NULL, NULL, '[]', 'fyi', '2026-08-01T00:00:00.000Z')`,
      )
      .run();
    old.prepare(`INSERT INTO config (key, value) VALUES ('schema_version', '1')`).run();
    const oldCols = old.prepare('PRAGMA table_info(shares)').all() as { name: string }[];
    expect(oldCols.some((c) => c.name === 'stale_at')).toBe(false);
    old.close();

    const migrated = openDb(dbPath);
    try {
      const cols = migrated.prepare('PRAGMA table_info(shares)').all() as { name: string }[];
      expect(cols.some((c) => c.name === 'stale_at')).toBe(true);

      const row = migrated.prepare('SELECT * FROM shares WHERE id = ?').get('shr_old1') as
        | Record<string, unknown>
        | undefined;
      expect(row).toBeDefined();
      expect(row?.what).toBe('pre-migration share');
      expect(row?.stale_at).toBeNull();

      // The brief calls this out specifically: a stale version number is a
      // trap for the next migration. openDb must advance it, not just leave
      // whatever the earlier version wrote.
      const versionRow = migrated
        .prepare(`SELECT value FROM config WHERE key = 'schema_version'`)
        .get() as { value: string } | undefined;
      expect(versionRow?.value).toBe('2');
    } finally {
      migrated.close();
    }
  });
});
