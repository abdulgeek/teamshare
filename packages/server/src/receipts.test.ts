import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  openDb, upsertMember, removeMember, createTeam, hashToken, getOrCreateDefaultTeamId, makeTeamScope,
  type Db, type TeamScope,
} from './db.js';
import { createShare, markStale } from './shares.js';
import { recordReceipt, getReceipts } from './receipts.js';

let db: Db;
let scope: TeamScope;
const T0 = '2026-08-20T00:00:00.000Z';
const NOW = '2026-08-29T00:00:00.000Z';

beforeEach(() => {
  db = openDb(':memory:');
  scope = makeTeamScope(db, getOrCreateDefaultTeamId(db));
  upsertMember(scope, 'adnan@team.com', 'Adnan', T0);
  upsertMember(scope, 'priya@team.com', 'Priya', T0);
  upsertMember(scope, 'sam@team.com', 'Sam', T0);
});
afterEach(() => { db.close(); });

describe('recordReceipt', () => {
  it('records viewed and dismissed', () => {
    const { id } = createShare(scope, 'adnan@team.com', { what: 'x', priority: 'fyi' }, T0);
    recordReceipt(scope, id, 'priya@team.com', 'viewed', NOW);
    recordReceipt(scope, id, 'sam@team.com', 'dismissed', NOW);
    const r = getReceipts(scope, id, NOW, 14)!;
    expect(r.viewed).toEqual(['priya@team.com']);
    expect(r.dismissed).toEqual(['sam@team.com']);
    expect(r.unseen).toEqual([]);
  });

  it('is idempotent', () => {
    const { id } = createShare(scope, 'adnan@team.com', { what: 'x', priority: 'fyi' }, T0);
    recordReceipt(scope, id, 'priya@team.com', 'viewed', NOW);
    recordReceipt(scope, id, 'priya@team.com', 'viewed', NOW);
    expect(getReceipts(scope, id, NOW, 14)!.viewed).toEqual(['priya@team.com']);
  });

  it('never downgrades viewed to dismissed, but upgrades dismissed to viewed', () => {
    const { id } = createShare(scope, 'adnan@team.com', { what: 'x', priority: 'fyi' }, T0);
    recordReceipt(scope, id, 'priya@team.com', 'viewed', NOW);
    recordReceipt(scope, id, 'priya@team.com', 'dismissed', NOW);
    expect(getReceipts(scope, id, NOW, 14)!.viewed).toEqual(['priya@team.com']);

    recordReceipt(scope, id, 'sam@team.com', 'dismissed', NOW);
    recordReceipt(scope, id, 'sam@team.com', 'viewed', NOW);
    expect(getReceipts(scope, id, NOW, 14)!.viewed).toContain('sam@team.com');
  });

  it('reports whether a row was actually written', () => {
    const { id } = createShare(scope, 'adnan@team.com', { what: 'x', priority: 'fyi' }, T0);
    expect(recordReceipt(scope, id, 'priya@team.com', 'viewed', NOW)).toBe(true);
    expect(recordReceipt(scope, 'shr_missing', 'priya@team.com', 'viewed', NOW)).toBe(false);
  });
});

describe('getReceipts', () => {
  it('excludes the sender from every bucket', () => {
    const { id } = createShare(scope, 'adnan@team.com', { what: 'x', priority: 'fyi' }, T0);
    const r = getReceipts(scope, id, NOW, 14)!;
    const unseenEmails = r.unseen.map((u) => u.email);
    const all = [...r.viewed, ...r.dismissed, ...unseenEmails];
    expect(all).not.toContain('adnan@team.com');
    expect(unseenEmails.sort()).toEqual(['priya@team.com', 'sam@team.com']);
  });

  it('counts a member who joined later as unseen', () => {
    const { id } = createShare(scope, 'adnan@team.com', { what: 'x', priority: 'fyi' }, T0);
    upsertMember(scope, 'newbie@team.com', 'Newbie', NOW);
    expect(getReceipts(scope, id, NOW, 14)!.unseen.map((u) => u.email)).toContain('newbie@team.com');
  });

  it('drops a removed member from the denominator', () => {
    const { id } = createShare(scope, 'adnan@team.com', { what: 'x', priority: 'fyi' }, T0);
    removeMember(scope, 'sam@team.com');
    expect(getReceipts(scope, id, NOW, 14)!.unseen.map((u) => u.email)).toEqual(['priya@team.com']);
  });

  it("pairs each unseen member with their last_seen, so a quiet member's silence is visible", () => {
    // Distinguishing "hasn't read it yet" from "hasn't connected in two
    // weeks" is the whole point: both would otherwise render identically as
    // just an email in the unseen list.
    const { id } = createShare(scope, 'adnan@team.com', { what: 'x', priority: 'fyi' }, T0);
    // Sam reconnects (touching last_seen) without viewing or dismissing.
    upsertMember(scope, 'sam@team.com', 'Sam', NOW);
    const r = getReceipts(scope, id, NOW, 14)!;
    const sam = r.unseen.find((u) => u.email === 'sam@team.com');
    const priya = r.unseen.find((u) => u.email === 'priya@team.com');
    expect(sam?.last_seen).toBe(NOW);
    expect(priya?.last_seen).toBe(T0); // never reconnected since joining
  });

  it('flags an expired share', () => {
    const { id } = createShare(scope, 'adnan@team.com', { what: 'x', priority: 'fyi' }, '2026-08-01T00:00:00.000Z');
    expect(getReceipts(scope, id, NOW, 14)!.expired).toBe(true);
    const fresh = createShare(scope, 'adnan@team.com', { what: 'y', priority: 'fyi' }, '2026-08-28T00:00:00.000Z');
    expect(getReceipts(scope, fresh.id, NOW, 14)!.expired).toBe(false);
  });

  it('returns undefined for an unknown share', () => {
    expect(getReceipts(scope, 'shr_nope', NOW, 14)).toBeUndefined();
  });

  it('flags a stale share', () => {
    const { id } = createShare(scope, 'adnan@team.com', { what: 'x', priority: 'fyi' }, T0);
    expect(getReceipts(scope, id, NOW, 14)!.stale).toBe(false);
    markStale(scope, id, 'adnan@team.com', NOW);
    expect(getReceipts(scope, id, NOW, 14)!.stale).toBe(true);
  });

  it('flags a share that is both stale and expired as stale (the more informative fact)', () => {
    const { id } = createShare(scope, 'adnan@team.com', { what: 'x', priority: 'fyi' }, '2026-08-01T00:00:00.000Z');
    markStale(scope, id, 'adnan@team.com', NOW);
    const r = getReceipts(scope, id, NOW, 14)!;
    expect(r.stale).toBe(true);
    expect(r.expired).toBe(true);
  });
});

describe('cross-team isolation', () => {
  let otherScope: TeamScope;

  beforeEach(() => {
    const otherTeamId = createTeam(db, 'other team', hashToken('ts_other'), T0);
    otherScope = makeTeamScope(db, otherTeamId);
    upsertMember(otherScope, 'intruder@other.com', 'Intruder', T0);
  });

  it('recordReceipt is rejected for another team\'s share — no row written, and getReceipts still reports it as unknown', () => {
    const { id } = createShare(scope, 'adnan@team.com', { what: 'team A only', priority: 'fyi' }, T0);

    const written = recordReceipt(otherScope, id, 'intruder@other.com', 'viewed', NOW);
    expect(written).toBe(false);

    // Not merely "the other team doesn't see it" — literally no row landed
    // in the receipts table under any team for this attempt.
    const rows = db.prepare('SELECT * FROM receipts WHERE share_id = ?').all(id);
    expect(rows).toHaveLength(0);

    expect(getReceipts(otherScope, id, NOW, 14)).toBeUndefined();
    // The real team's view is unaffected.
    expect(getReceipts(scope, id, NOW, 14)!.unseen.map((u) => u.email)).not.toContain('intruder@other.com');
  });

  it('getReceipts scopes both the receipts read and the member roster', () => {
    const { id } = createShare(scope, 'adnan@team.com', { what: 'x', priority: 'fyi' }, T0);
    recordReceipt(scope, id, 'priya@team.com', 'viewed', NOW);

    const r = getReceipts(scope, id, NOW, 14)!;
    // Only team-scope's own members appear — never the other team's roster.
    const allEmails = [...r.viewed, ...r.dismissed, ...r.unseen.map((u) => u.email)];
    expect(allEmails).not.toContain('intruder@other.com');
  });

  it('rejects a cross-team receipt at the database level via the composite foreign key, even bypassing recordReceipt', () => {
    const { id } = createShare(scope, 'adnan@team.com', { what: 'x', priority: 'fyi' }, T0);

    // Simulate application code that gets team_id wrong: insert directly
    // with the OTHER team's id but the real team's share_id. The receipts
    // table's composite FK — FOREIGN KEY (team_id, share_id) REFERENCES
    // shares(team_id, id) — has no matching row in shares for
    // (otherTeamId, id), so this must fail closed at the database, not
    // merely be prevented by application-level scoping.
    expect(() => {
      db.prepare(
        `INSERT INTO receipts (team_id, share_id, member_email, status, at) VALUES (?, ?, ?, ?, ?)`,
      ).run(otherScope.teamId, id, 'intruder@other.com', 'viewed', NOW);
    }).toThrow(/FOREIGN KEY constraint failed/);
  });
});
