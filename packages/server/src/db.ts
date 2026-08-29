import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';

export type Db = Database.Database;

export interface Member {
  email: string;
  name: string;
  first_seen: string;
  last_seen: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  email      TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shares (
  id           TEXT PRIMARY KEY,
  sender_email TEXT NOT NULL,
  what         TEXT NOT NULL,
  why          TEXT,
  action       TEXT,
  tags         TEXT NOT NULL DEFAULT '[]',
  priority     TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS receipts (
  share_id     TEXT NOT NULL,
  member_email TEXT NOT NULL,
  status       TEXT NOT NULL,
  at           TEXT NOT NULL,
  PRIMARY KEY (share_id, member_email)
);
CREATE INDEX IF NOT EXISTS idx_shares_created ON shares (created_at);
`;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function openDb(path: string): Db {
  const db = new Database(path);
  // WAL keeps concurrent reads safe. Skip for in-memory databases.
  if (path !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  db.prepare(
    `INSERT INTO config (key, value) VALUES ('schema_version', '1')
     ON CONFLICT(key) DO NOTHING`,
  ).run();
  return db;
}

function readConfig(db: Db, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setToken(db: Db, token: string): void {
  db.prepare(
    `INSERT INTO config (key, value) VALUES ('team_token', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(token);
}

export function getOrCreateToken(db: Db): string {
  const existing = readConfig(db, 'team_token');
  if (existing) return existing;
  const token = `ts_${randomBytes(24).toString('hex')}`;
  setToken(db, token);
  return token;
}

export function rotateToken(db: Db): string {
  const token = `ts_${randomBytes(24).toString('hex')}`;
  setToken(db, token);
  return token;
}

export function upsertMember(db: Db, email: string, name: string, nowIso: string): void {
  db.prepare(
    `INSERT INTO members (email, name, first_seen, last_seen) VALUES (?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen`,
  ).run(normalizeEmail(email), name, nowIso, nowIso);
}

export function listMembers(db: Db): Member[] {
  return db.prepare('SELECT * FROM members ORDER BY email').all() as Member[];
}

export function removeMember(db: Db, email: string): boolean {
  const info = db.prepare('DELETE FROM members WHERE email = ?').run(normalizeEmail(email));
  return info.changes > 0;
}
