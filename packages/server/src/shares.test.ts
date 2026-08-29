import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  openDb, upsertMember, createTeam, hashToken, getOrCreateDefaultTeamId, makeTeamScope,
  type Db, type TeamScope,
} from './db.js';
import { validateShare, createShare, getShare, listShares, retractShare, markStale } from './shares.js';

let db: Db;
let scope: TeamScope;
const NOW = '2026-08-29T10:00:00.000Z';

beforeEach(() => {
  db = openDb(':memory:');
  scope = makeTeamScope(db, getOrCreateDefaultTeamId(db));
  upsertMember(scope, 'adnan@team.com', 'Adnan', NOW);
  upsertMember(scope, 'priya@team.com', 'Priya', NOW);
  upsertMember(scope, 'sam@team.com', 'Sam', NOW);
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
      scope, 'Adnan@Team.com',
      { what: 'Auth refactor lands Friday.', priority: 'blocking', tags: ['Auth'] },
      NOW,
    );
    expect(notified).toBe(2); // priya + sam, not adnan
    const row = getShare(scope, id);
    expect(row?.sender_email).toBe('adnan@team.com');
    expect(row?.tags).toEqual(['auth']);
    expect(row?.priority).toBe('blocking');
    expect(row?.created_at).toBe(NOW);
  });

  it('throws on invalid input so callers must validate first', () => {
    expect(() => createShare(scope, 'adnan@team.com', { what: '', priority: 'fyi' }, NOW)).toThrow();
  });
});

describe('listShares', () => {
  it('returns newest first and filters by tag and sender', () => {
    createShare(scope, 'adnan@team.com', { what: 'first', priority: 'fyi', tags: ['auth'] }, '2026-08-01T00:00:00.000Z');
    createShare(scope, 'priya@team.com', { what: 'second', priority: 'fyi', tags: ['ui'] }, '2026-08-02T00:00:00.000Z');
    expect(listShares(scope, {}).map(s => s.what)).toEqual(['second', 'first']);
    expect(listShares(scope, { tag: 'auth' }).map(s => s.what)).toEqual(['first']);
    expect(listShares(scope, { sender: 'Priya@Team.com' }).map(s => s.what)).toEqual(['second']);
    expect(listShares(scope, { limit: 1 }).map(s => s.what)).toEqual(['second']);
  });

  it('a fresh share has a null stale_at', () => {
    const { id } = createShare(scope, 'adnan@team.com', { what: 'x', priority: 'fyi' }, NOW);
    expect(getShare(scope, id)?.stale_at).toBeNull();
  });
});

describe('retractShare', () => {
  it('hard-deletes the share and its receipts (via ON DELETE CASCADE) when the author retracts', () => {
    const { id } = createShare(scope, 'adnan@team.com', { what: 'secret leak', priority: 'fyi' }, NOW);
    db.prepare(
      `INSERT INTO receipts (team_id, share_id, member_email, status, at) VALUES (?, ?, ?, ?, ?)`,
    ).run(scope.teamId, id, 'priya@team.com', 'viewed', NOW);

    const result = retractShare(scope, id, 'adnan@team.com');
    expect(result.ok).toBe(true);

    expect(getShare(scope, id)).toBeUndefined();
    expect(listShares(scope, {}).map((s) => s.id)).not.toContain(id);
    const receipts = db.prepare('SELECT * FROM receipts WHERE team_id = ? AND share_id = ?').all(scope.teamId, id);
    expect(receipts).toHaveLength(0);
  });

  it('rejects retraction by anyone other than the author, and leaves the share intact', () => {
    const { id } = createShare(scope, 'adnan@team.com', { what: 'x', priority: 'fyi' }, NOW);
    const result = retractShare(scope, id, 'priya@team.com');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('only the author can retract a share');
    expect(getShare(scope, id)).toBeDefined();
  });

  it('is case-insensitive when comparing the caller to the author', () => {
    const { id } = createShare(scope, 'adnan@team.com', { what: 'x', priority: 'fyi' }, NOW);
    const result = retractShare(scope, id, 'Adnan@Team.com');
    expect(result.ok).toBe(true);
    expect(getShare(scope, id)).toBeUndefined();
  });

  it('reports an unknown id as an error rather than throwing', () => {
    const result = retractShare(scope, 'shr_missing', 'adnan@team.com');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('shr_missing');
  });
});

describe('markStale', () => {
  it('sets stale_at when the author marks their own share stale', () => {
    const { id } = createShare(scope, 'adnan@team.com', { what: 'x', priority: 'fyi' }, NOW);
    const result = markStale(scope, id, 'adnan@team.com', '2026-08-30T00:00:00.000Z');
    expect(result.ok).toBe(true);
    expect(getShare(scope, id)?.stale_at).toBe('2026-08-30T00:00:00.000Z');
  });

  it('rejects mark_stale by anyone other than the author', () => {
    const { id } = createShare(scope, 'adnan@team.com', { what: 'x', priority: 'fyi' }, NOW);
    const result = markStale(scope, id, 'priya@team.com', '2026-08-30T00:00:00.000Z');
    expect(result.ok).toBe(false);
    expect(getShare(scope, id)?.stale_at).toBeNull();
  });

  it('is idempotent: marking an already-stale share does not change stale_at', () => {
    const { id } = createShare(scope, 'adnan@team.com', { what: 'x', priority: 'fyi' }, NOW);
    markStale(scope, id, 'adnan@team.com', '2026-08-30T00:00:00.000Z');
    const second = markStale(scope, id, 'adnan@team.com', '2026-09-15T00:00:00.000Z');
    expect(second.ok).toBe(true);
    expect(getShare(scope, id)?.stale_at).toBe('2026-08-30T00:00:00.000Z');
  });

  it('reports an unknown id as an error rather than throwing', () => {
    const result = markStale(scope, 'shr_missing', 'adnan@team.com', NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('shr_missing');
  });

  it('still appears in listShares after being marked stale', () => {
    const { id } = createShare(scope, 'adnan@team.com', { what: 'x', priority: 'fyi' }, NOW);
    markStale(scope, id, 'adnan@team.com', '2026-08-30T00:00:00.000Z');
    expect(listShares(scope, {}).map((s) => s.id)).toContain(id);
  });
});

// Cross-team isolation. All of these live in the SAME database (as real
// multi-tenant data would), with two independent teams.
describe('cross-team isolation', () => {
  let otherScope: TeamScope;

  beforeEach(() => {
    const otherTeamId = createTeam(db, 'other team', hashToken('ts_other'), NOW);
    otherScope = makeTeamScope(db, otherTeamId);
    upsertMember(otherScope, 'intruder@other.com', 'Intruder', NOW);
  });

  it('listShares scopes even when called with an empty options object — never a clause-free scan of every team', () => {
    createShare(scope, 'adnan@team.com', { what: 'team A only', priority: 'fyi' }, NOW);
    createShare(otherScope, 'intruder@other.com', { what: 'team B only', priority: 'fyi' }, NOW);

    expect(listShares(scope, {}).map((s) => s.what)).toEqual(['team A only']);
    expect(listShares(otherScope, {}).map((s) => s.what)).toEqual(['team B only']);
  });

  it('getShare is scoped in SQL: another team cannot fetch a share by id', () => {
    const { id } = createShare(scope, 'adnan@team.com', { what: 'private to team A', priority: 'fyi' }, NOW);
    expect(getShare(otherScope, id)).toBeUndefined();
    expect(getShare(scope, id)).toBeDefined();
  });

  it('no existence oracle: a foreign-team id and a truly nonexistent id produce the identical "no share" message, never the author-mismatch message', () => {
    const { id } = createShare(scope, 'adnan@team.com', { what: 'team A secret', priority: 'fyi' }, NOW);

    const foreignAttempt = retractShare(otherScope, id, 'intruder@other.com');
    expect(foreignAttempt).toEqual({ ok: false, error: `no share with id ${id}` });

    const missingId = 'shr_definitely_missing_000000';
    const nonexistentAttempt = retractShare(otherScope, missingId, 'intruder@other.com');
    expect(nonexistentAttempt).toEqual({ ok: false, error: `no share with id ${missingId}` });

    // The author-mismatch message would confirm the id exists somewhere on
    // the instance — it must never be reachable for another team's share.
    expect((foreignAttempt as { ok: false; error: string }).error).not.toContain('only the author');

    // And the original share must be untouched by the foreign attempt.
    expect(getShare(scope, id)).toBeDefined();
  });

  it('markStale is likewise unreachable for another team\'s share', () => {
    const { id } = createShare(scope, 'adnan@team.com', { what: 'team A plan', priority: 'fyi' }, NOW);
    const result = markStale(otherScope, id, 'intruder@other.com', NOW);
    expect(result).toEqual({ ok: false, error: `no share with id ${id}` });
    expect(getShare(scope, id)?.stale_at).toBeNull();
  });

  it('createShare\'s notified count only counts the calling team\'s members', () => {
    upsertMember(otherScope, 'second@other.com', 'Second', NOW);
    const { notified } = createShare(otherScope, 'intruder@other.com', { what: 'x', priority: 'fyi' }, NOW);
    expect(notified).toBe(1); // second@other.com only — never team A's 3 members
  });
});
