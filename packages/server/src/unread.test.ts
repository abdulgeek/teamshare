import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  openDb, upsertMember, createTeam, hashToken, getOrCreateDefaultTeamId, makeTeamScope,
  type Db, type TeamScope,
} from './db.js';
import { createShare, markStale } from './shares.js';
import { getUnread, UNREAD_LIMIT } from './unread.js';

let db: Db;
let scope: TeamScope;
const T0 = '2026-08-01T00:00:00.000Z';
const NOW = '2026-08-29T00:00:00.000Z';

beforeEach(() => {
  db = openDb(':memory:');
  scope = makeTeamScope(db, getOrCreateDefaultTeamId(db));
  upsertMember(scope, 'adnan@team.com', 'Adnan', T0);
  upsertMember(scope, 'priya@team.com', 'Priya', T0);
});
afterEach(() => { db.close(); });

function ack(shareId: string, email: string, status: 'viewed' | 'dismissed') {
  db.prepare(
    `INSERT INTO receipts (team_id, share_id, member_email, status, at) VALUES (?, ?, ?, ?, ?)`,
  ).run(scope.teamId, shareId, email, status, NOW);
}

describe('getUnread', () => {
  it('shows a teammate share to the recipient', () => {
    createShare(scope, 'adnan@team.com', { what: 'hello', priority: 'fyi' }, NOW);
    const d = getUnread(scope, 'priya@team.com', NOW, 14);
    expect(d.total).toBe(1);
    expect(d.shares[0].what).toBe('hello');
    expect(d.shares[0].sender_name).toBe('Adnan');
    expect(d.shares[0].sender_email).toBe('adnan@team.com');
  });

  it('never shows a member their own share', () => {
    createShare(scope, 'adnan@team.com', { what: 'mine', priority: 'fyi' }, NOW);
    expect(getUnread(scope, 'Adnan@Team.com', NOW, 14).total).toBe(0);
  });

  it('hides shares once viewed or dismissed', () => {
    const a = createShare(scope, 'adnan@team.com', { what: 'a', priority: 'fyi' }, NOW);
    const b = createShare(scope, 'adnan@team.com', { what: 'b', priority: 'fyi' }, NOW);
    ack(a.id, 'priya@team.com', 'viewed');
    ack(b.id, 'priya@team.com', 'dismissed');
    expect(getUnread(scope, 'priya@team.com', NOW, 14).total).toBe(0);
  });

  it('excludes shares older than the expiry window', () => {
    createShare(scope, 'adnan@team.com', { what: 'old', priority: 'blocking' }, '2026-08-01T00:00:00.000Z');
    createShare(scope, 'adnan@team.com', { what: 'fresh', priority: 'fyi' }, '2026-08-28T00:00:00.000Z');
    const d = getUnread(scope, 'priya@team.com', NOW, 14);
    expect(d.shares.map(s => s.what)).toEqual(['fresh']);
  });

  it('orders blocking first, then newest', () => {
    createShare(scope, 'adnan@team.com', { what: 'older-fyi', priority: 'fyi' }, '2026-08-26T00:00:00.000Z');
    createShare(scope, 'adnan@team.com', { what: 'new-fyi', priority: 'fyi' }, '2026-08-27T00:00:00.000Z');
    createShare(scope, 'adnan@team.com', { what: 'blocker', priority: 'blocking' }, '2026-08-21T00:00:00.000Z');
    const d = getUnread(scope, 'priya@team.com', NOW, 14);
    expect(d.shares.map((s) => s.what)).toEqual(['blocker', 'new-fyi', 'older-fyi']);
  });

  it('caps the list at UNREAD_LIMIT but reports the true total', () => {
    for (let i = 0; i < UNREAD_LIMIT + 5; i++) {
      createShare(scope, 'adnan@team.com', { what: `s${i}`, priority: 'fyi' }, '2026-08-27T00:00:00.000Z');
    }
    const d = getUnread(scope, 'priya@team.com', NOW, 14);
    expect(d.total).toBe(UNREAD_LIMIT + 5);
    expect(d.shares).toHaveLength(UNREAD_LIMIT);
  });

  it('shows a share to a member who joined after it was created', () => {
    createShare(scope, 'adnan@team.com', { what: 'before-join', priority: 'fyi' }, '2026-08-27T00:00:00.000Z');
    upsertMember(scope, 'newbie@team.com', 'Newbie', NOW);
    expect(getUnread(scope, 'newbie@team.com', NOW, 14).total).toBe(1);
  });

  it('excludes a share marked stale, from both total and the list', () => {
    const a = createShare(scope, 'adnan@team.com', { what: 'still fresh', priority: 'fyi' }, NOW);
    const b = createShare(scope, 'adnan@team.com', { what: 'gone stale', priority: 'fyi' }, NOW);
    markStale(scope, b.id, 'adnan@team.com', NOW);
    const d = getUnread(scope, 'priya@team.com', NOW, 14);
    expect(d.total).toBe(1);
    expect(d.shares.map((s) => s.id)).toEqual([a.id]);
  });
});

describe('cross-team isolation', () => {
  let teamA: TeamScope;
  let teamB: TeamScope;

  beforeEach(() => {
    // scope/db from the outer beforeEach already gives us one team (teamA);
    // add a second team in the SAME database, as real multi-tenant data
    // would be laid out.
    teamA = scope;
    const teamBId = createTeam(db, 'Team B', hashToken('ts_teamB'), T0);
    teamB = makeTeamScope(db, teamBId);

    // Both teams have a member at the SAME email address, with DIFFERENT
    // display names — a fixture a single-email test cannot catch: if the
    // members join in getUnread isn't scoped by team_id, it can fan out
    // (one row per matching email across teams) or resolve the wrong
    // team's display name for a shared address.
    upsertMember(teamA, 'shared@company.com', 'Alice (Team A)', T0);
    upsertMember(teamB, 'shared@company.com', 'Alice (Team B)', T0);
    upsertMember(teamB, 'reader@company.com', 'Reader B', T0);
  });

  it('shows only the calling team\'s shares, with that team\'s own display name for the shared email', () => {
    createShare(teamA, 'shared@company.com', { what: 'Team A secret plan', priority: 'blocking' }, NOW);
    createShare(teamB, 'shared@company.com', { what: 'Team B secret plan', priority: 'blocking' }, NOW);

    const digestA = getUnread(teamA, 'priya@team.com', NOW, 14);
    expect(digestA.total).toBe(1);
    expect(digestA.shares).toHaveLength(1); // no fan-out from the shared-email join
    expect(digestA.shares[0].what).toBe('Team A secret plan');
    expect(digestA.shares[0].sender_name).toBe('Alice (Team A)');

    const digestB = getUnread(teamB, 'reader@company.com', NOW, 14);
    expect(digestB.total).toBe(1);
    expect(digestB.shares).toHaveLength(1);
    expect(digestB.shares[0].what).toBe('Team B secret plan');
    expect(digestB.shares[0].sender_name).toBe('Alice (Team B)');
  });

  it('a receipt recorded in one team never suppresses the other team\'s otherwise-identical share', () => {
    const a = createShare(teamA, 'shared@company.com', { what: 'shared subject line', priority: 'fyi' }, NOW);
    const b = createShare(teamB, 'shared@company.com', { what: 'shared subject line', priority: 'fyi' }, NOW);
    // Acknowledge team A's copy only.
    db.prepare(
      `INSERT INTO receipts (team_id, share_id, member_email, status, at) VALUES (?, ?, ?, ?, ?)`,
    ).run(teamA.teamId, a.id, 'priya@team.com', 'viewed', NOW);

    expect(getUnread(teamA, 'priya@team.com', NOW, 14).total).toBe(0);
    expect(getUnread(teamB, 'reader@company.com', NOW, 14).total).toBe(1);
    expect(getUnread(teamB, 'reader@company.com', NOW, 14).shares[0].id).toBe(b.id);
  });
});


// ---------------------------------------------------------------------------
// Relevance: the digest exists to be read, so it stops pushing things nobody
// is going to act on — while never pretending they are not there.
// ---------------------------------------------------------------------------

describe('getUnread: relevance', () => {
  // Uses this file's shared beforeEach: a default-team scope with Adnan and
  // Priya already members.
  const daysAgo = (n: number) => new Date(Date.parse(NOW) - n * 86_400_000).toISOString();

  it('holds back an ordinary share past the window, and counts it instead', () => {
    createShare(scope, 'adnan@team.com', { what: 'fresh', priority: 'fyi' }, daysAgo(1));
    createShare(scope, 'adnan@team.com', { what: 'ancient', priority: 'fyi' }, daysAgo(10));

    const d = getUnread(scope, 'priya@team.com', NOW, 14);
    expect(d.shares.map((s) => s.what)).toEqual(['fresh']);
    expect(d.total).toBe(1);
    // Not silently dropped: the caller can say "and 1 older".
    expect(d.older).toBe(1);
  });

  it('still surfaces an old blocking share, because that is what blocking means', () => {
    createShare(scope, 'adnan@team.com', { what: 'do not merge', priority: 'blocking' }, daysAgo(10));
    const d = getUnread(scope, 'priya@team.com', NOW, 14);
    expect(d.shares.map((s) => s.what)).toEqual(['do not merge']);
    expect(d.older).toBe(0);
  });

  it('returns them all when the caller explicitly asks for the old ones', () => {
    createShare(scope, 'adnan@team.com', { what: 'fresh', priority: 'fyi' }, daysAgo(1));
    createShare(scope, 'adnan@team.com', { what: 'ancient', priority: 'fyi' }, daysAgo(10));

    const d = getUnread(scope, 'priya@team.com', NOW, 14, { includeOld: true });
    expect(d.shares.map((s) => s.what).sort()).toEqual(['ancient', 'fresh']);
    expect(d.total).toBe(2);
    expect(d.older).toBe(0);
  });

  it('carries a human age and a grade on every entry', () => {
    createShare(scope, 'adnan@team.com', { what: 'x', priority: 'fyi' }, daysAgo(2));
    const [entry] = getUnread(scope, 'priya@team.com', NOW, 14).shares;
    expect(entry.age).toBe('2 days ago');
    expect(entry.relevance).toBe('recent');
    // The exact instant is still there for anyone who wants it.
    expect(entry.created_at).toBe(daysAgo(2));
  });

  it('spends the row limit on shares it will actually show', () => {
    // The relevance filter lives in SQL for this reason: applied to fetched
    // rows instead, 25 old shares would consume the whole LIMIT and starve the
    // recent ones the digest exists to surface.
    for (let i = 0; i < 25; i++) {
      createShare(scope, 'adnan@team.com', { what: `old${i}`, priority: 'fyi' }, daysAgo(9));
    }
    createShare(scope, 'adnan@team.com', { what: 'today', priority: 'fyi' }, daysAgo(0));

    const d = getUnread(scope, 'priya@team.com', NOW, 14);
    expect(d.shares.map((s) => s.what)).toEqual(['today']);
    expect(d.older).toBe(25);
  });

  it('counts only genuinely hidden shares as older — never stale or expired ones', () => {
    // Those are excluded from unread altogether, so counting them would
    // promise the reader something `includeOld` would not deliver.
    const stale = createShare(scope, 'adnan@team.com', { what: 'stale', priority: 'fyi' }, daysAgo(1));
    markStale(scope, stale.id, 'adnan@team.com', NOW);
    createShare(scope, 'adnan@team.com', { what: 'expired', priority: 'fyi' }, daysAgo(30));

    const d = getUnread(scope, 'priya@team.com', NOW, 14);
    expect(d.total).toBe(0);
    expect(d.older).toBe(0);
    expect(getUnread(scope, 'priya@team.com', NOW, 14, { includeOld: true }).total).toBe(0);
  });

  it('respects a narrower window on both the list and the count', () => {
    createShare(scope, 'adnan@team.com', { what: 'two-days', priority: 'fyi' }, daysAgo(2));
    const d = getUnread(scope, 'priya@team.com', NOW, 14, { relevanceWindowDays: 1 });
    expect(d.shares).toHaveLength(0);
    expect(d.older).toBe(1);
  });
});
