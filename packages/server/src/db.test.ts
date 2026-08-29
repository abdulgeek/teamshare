import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
