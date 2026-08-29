import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, upsertMember, type Db } from './db.js';
import { validateShare, createShare, getShare, listShares, retractShare, markStale } from './shares.js';

let db: Db;
const NOW = '2026-08-29T10:00:00.000Z';

beforeEach(() => {
  db = openDb(':memory:');
  upsertMember(db, 'adnan@team.com', 'Adnan', NOW);
  upsertMember(db, 'priya@team.com', 'Priya', NOW);
  upsertMember(db, 'sam@team.com', 'Sam', NOW);
});
afterEach(() => { db.close(); });

describe('validateShare', () => {
  it('accepts a minimal valid share', () => {
    const r = validateShare({ what: 'Auth refactor lands Friday.', priority: 'heads-up' });
    expect(r.ok).toBe(true);
  });

  it('rejects an empty what', () => {
    const r = validateShare({ what: '   ', priority: 'fyi' });
    expect(r).toEqual({ ok: false, error: expect.stringContaining('what') });
  });

  it('rejects what over 200 chars and names the field and cap', () => {
    const r = validateShare({ what: 'x'.repeat(201), priority: 'fyi' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('what');
      expect(r.error).toContain('200');
    }
  });

  it('rejects why over 300 and action over 200', () => {
    expect(validateShare({ what: 'ok', priority: 'fyi', why: 'y'.repeat(301) }).ok).toBe(false);
    expect(validateShare({ what: 'ok', priority: 'fyi', action: 'a'.repeat(201) }).ok).toBe(false);
  });

  it('rejects more than 5 tags or a tag over 20 chars', () => {
    expect(validateShare({ what: 'ok', priority: 'fyi', tags: ['a','b','c','d','e','f'] }).ok).toBe(false);
    expect(validateShare({ what: 'ok', priority: 'fyi', tags: ['x'.repeat(21)] }).ok).toBe(false);
  });

  it('rejects an unknown priority', () => {
    // deliberately bypass the type to simulate a bad client
    const r = validateShare({ what: 'ok', priority: 'URGENT' as never });
    expect(r.ok).toBe(false);
  });

  it('lowercases tags rather than rejecting them, and trims text', () => {
    const r = validateShare({ what: '  spaced  ', priority: 'fyi', tags: ['AUTH', 'Refactor'] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.tags).toEqual(['auth', 'refactor']);
      expect(r.value.what).toBe('spaced');
    }
  });

  it('treats omitted why/action as null', () => {
    const r = validateShare({ what: 'ok', priority: 'fyi' });
    if (r.ok) {
      expect(r.value.why).toBeNull();
      expect(r.value.action).toBeNull();
    }
  });
});

describe('createShare', () => {
  it('stores the share and reports members notified, excluding the sender', () => {
    const { id, notified } = createShare(
      db, 'Adnan@Team.com',
      { what: 'Auth refactor lands Friday.', priority: 'blocking', tags: ['Auth'] },
      NOW,
    );
    expect(notified).toBe(2); // priya + sam, not adnan
    const row = getShare(db, id);
    expect(row?.sender_email).toBe('adnan@team.com');
    expect(row?.tags).toEqual(['auth']);
    expect(row?.priority).toBe('blocking');
    expect(row?.created_at).toBe(NOW);
  });

  it('throws on invalid input so callers must validate first', () => {
    expect(() => createShare(db, 'adnan@team.com', { what: '', priority: 'fyi' }, NOW)).toThrow();
  });
});

describe('listShares', () => {
  it('returns newest first and filters by tag and sender', () => {
    createShare(db, 'adnan@team.com', { what: 'first', priority: 'fyi', tags: ['auth'] }, '2026-08-01T00:00:00.000Z');
    createShare(db, 'priya@team.com', { what: 'second', priority: 'fyi', tags: ['ui'] }, '2026-08-02T00:00:00.000Z');
    expect(listShares(db, {}).map(s => s.what)).toEqual(['second', 'first']);
    expect(listShares(db, { tag: 'auth' }).map(s => s.what)).toEqual(['first']);
    expect(listShares(db, { sender: 'Priya@Team.com' }).map(s => s.what)).toEqual(['second']);
    expect(listShares(db, { limit: 1 }).map(s => s.what)).toEqual(['second']);
  });

  it('a fresh share has a null stale_at', () => {
    const { id } = createShare(db, 'adnan@team.com', { what: 'x', priority: 'fyi' }, NOW);
    expect(getShare(db, id)?.stale_at).toBeNull();
  });
});

describe('retractShare', () => {
  it('hard-deletes the share and its receipts when the author retracts', () => {
    const { id } = createShare(db, 'adnan@team.com', { what: 'secret leak', priority: 'fyi' }, NOW);
    db.prepare(
      `INSERT INTO receipts (share_id, member_email, status, at) VALUES (?, ?, ?, ?)`,
    ).run(id, 'priya@team.com', 'viewed', NOW);

    const result = retractShare(db, id, 'adnan@team.com');
    expect(result.ok).toBe(true);

    expect(getShare(db, id)).toBeUndefined();
    expect(listShares(db, {}).map((s) => s.id)).not.toContain(id);
    const receipts = db.prepare('SELECT * FROM receipts WHERE share_id = ?').all(id);
    expect(receipts).toHaveLength(0);
  });

  it('rejects retraction by anyone other than the author, and leaves the share intact', () => {
    const { id } = createShare(db, 'adnan@team.com', { what: 'x', priority: 'fyi' }, NOW);
    const result = retractShare(db, id, 'priya@team.com');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('only the author can retract a share');
    expect(getShare(db, id)).toBeDefined();
  });

  it('is case-insensitive when comparing the caller to the author', () => {
    const { id } = createShare(db, 'adnan@team.com', { what: 'x', priority: 'fyi' }, NOW);
    const result = retractShare(db, id, 'Adnan@Team.com');
    expect(result.ok).toBe(true);
    expect(getShare(db, id)).toBeUndefined();
  });

  it('reports an unknown id as an error rather than throwing', () => {
    const result = retractShare(db, 'shr_missing', 'adnan@team.com');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('shr_missing');
  });
});

describe('markStale', () => {
  it('sets stale_at when the author marks their own share stale', () => {
    const { id } = createShare(db, 'adnan@team.com', { what: 'x', priority: 'fyi' }, NOW);
    const result = markStale(db, id, 'adnan@team.com', '2026-08-30T00:00:00.000Z');
    expect(result.ok).toBe(true);
    expect(getShare(db, id)?.stale_at).toBe('2026-08-30T00:00:00.000Z');
  });

  it('rejects mark_stale by anyone other than the author', () => {
    const { id } = createShare(db, 'adnan@team.com', { what: 'x', priority: 'fyi' }, NOW);
    const result = markStale(db, id, 'priya@team.com', '2026-08-30T00:00:00.000Z');
    expect(result.ok).toBe(false);
    expect(getShare(db, id)?.stale_at).toBeNull();
  });

  it('is idempotent: marking an already-stale share does not change stale_at', () => {
    const { id } = createShare(db, 'adnan@team.com', { what: 'x', priority: 'fyi' }, NOW);
    markStale(db, id, 'adnan@team.com', '2026-08-30T00:00:00.000Z');
    const second = markStale(db, id, 'adnan@team.com', '2026-09-15T00:00:00.000Z');
    expect(second.ok).toBe(true);
    expect(getShare(db, id)?.stale_at).toBe('2026-08-30T00:00:00.000Z');
  });

  it('reports an unknown id as an error rather than throwing', () => {
    const result = markStale(db, 'shr_missing', 'adnan@team.com', NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('shr_missing');
  });

  it('still appears in listShares after being marked stale', () => {
    const { id } = createShare(db, 'adnan@team.com', { what: 'x', priority: 'fyi' }, NOW);
    markStale(db, id, 'adnan@team.com', '2026-08-30T00:00:00.000Z');
    expect(listShares(db, {}).map((s) => s.id)).toContain(id);
  });
});
