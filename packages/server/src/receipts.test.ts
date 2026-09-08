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
    const r = getReceipts(scope, id, 'adnan@team.com', NOW, 14)!;
    expect(r.viewed).toEqual(['priya@team.com']);
    expect(r.dismissed).toEqual(['sam@team.com']);
    expect(r.unseen).toEqual([]);
  });

  it('is idempotent', () => {
    const { id } = createShare(scope, 'adnan@team.com', { what: 'x', priority: 'fyi' }, T0);
    recordReceipt(scope, id, 'priya@team.com', 'viewed', NOW);
    recordReceipt(scope, id, 'priya@team.com', 'viewed', NOW);
    expect(getReceipts(scope, id, 'adnan@team.com', NOW, 14)!.viewed).toEqual(['priya@team.com']);
  });

  it('never downgrades viewed to dismissed, but upgrades dismissed to viewed', () => {
    const { id } = createShare(scope, 'adnan@team.com', { what: 'x', priority: 'fyi' }, T0);
    recordReceipt(scope, id, 'priya@team.com', 'viewed', NOW);
    recordReceipt(scope, id, 'priya@team.com', 'dismissed', NOW);
    expect(getReceipts(scope, id, 'adnan@team.com', NOW, 14)!.viewed).toEqual(['priya@team.com']);

    recordReceipt(scope, id, 'sam@team.com', 'dismissed', NOW);
    recordReceipt(scope, id, 'sam@team.com', 'viewed', NOW);
    expect(getReceipts(scope, id, 'adnan@team.com', NOW, 14)!.viewed).toContain('sam@team.com');
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
    const r = getReceipts(scope, id, 'adnan@team.com', NOW, 14)!;
    const unseenEmails = r.unseen.map((u) => u.email);
    const all = [...r.viewed, ...r.dismissed, ...unseenEmails];
    expect(all).not.toContain('adnan@team.com');
    expect(unseenEmails.sort()).toEqual(['priya@team.com', 'sam@team.com']);
  });

  it('counts a member who joined later as unseen', () => {
    const { id } = createShare(scope, 'adnan@team.com', { what: 'x', priority: 'fyi' }, T0);
    upsertMember(scope, 'newbie@team.com', 'Newbie', NOW);
    expect(getReceipts(scope, id, 'adnan@team.com', NOW, 14)!.unseen.map((u) => u.email)).toContain('newbie@team.com');
  });

  it('drops a removed member from the denominator', () => {
    const { id } = createShare(scope, 'adnan@team.com', { what: 'x', priority: 'fyi' }, T0);
    removeMember(scope, 'sam@team.com');
    expect(getReceipts(scope, id, 'adnan@team.com', NOW, 14)!.unseen.map((u) => u.email)).toEqual(['priya@team.com']);
  });

  it("pairs each unseen member with their last_seen, so a quiet member's silence is visible", () => {
    // Distinguishing "hasn't read it yet" from "hasn't connected in two
    // weeks" is the whole point: both would otherwise render identically as
    // just an email in the unseen list.
    const { id } = createShare(scope, 'adnan@team.com', { what: 'x', priority: 'fyi' }, T0);
    // Sam reconnects (touching last_seen) without viewing or dismissing.
    upsertMember(scope, 'sam@team.com', 'Sam', NOW);
    const r = getReceipts(scope, id, 'adnan@team.com', NOW, 14)!;
    const sam = r.unseen.find((u) => u.email === 'sam@team.com');
    const priya = r.unseen.find((u) => u.email === 'priya@team.com');
    expect(sam?.last_seen).toBe(NOW);
    expect(priya?.last_seen).toBe(T0); // never reconnected since joining
  });

  it('flags an expired share', () => {
    const { id } = createShare(scope, 'adnan@team.com', { what: 'x', priority: 'fyi' }, '2026-08-01T00:00:00.000Z');
    expect(getReceipts(scope, id, 'adnan@team.com', NOW, 14)!.expired).toBe(true);
    const fresh = createShare(scope, 'adnan@team.com', { what: 'y', priority: 'fyi' }, '2026-08-28T00:00:00.000Z');
    expect(getReceipts(scope, fresh.id, 'adnan@team.com', NOW, 14)!.expired).toBe(false);
  });

  it('returns undefined for an unknown share', () => {
    expect(getReceipts(scope, 'shr_nope', 'adnan@team.com', NOW, 14)).toBeUndefined();
  });

  it('flags a stale share', () => {
    const { id } = createShare(scope, 'adnan@team.com', { what: 'x', priority: 'fyi' }, T0);
    expect(getReceipts(scope, id, 'adnan@team.com', NOW, 14)!.stale).toBe(false);
    markStale(scope, id, 'adnan@team.com', NOW);
    expect(getReceipts(scope, id, 'adnan@team.com', NOW, 14)!.stale).toBe(true);
  });

  it('flags a share that is both stale and expired as stale (the more informative fact)', () => {
    const { id } = createShare(scope, 'adnan@team.com', { what: 'x', priority: 'fyi' }, '2026-08-01T00:00:00.000Z');
    markStale(scope, id, 'adnan@team.com', NOW);
    const r = getReceipts(scope, id, 'adnan@team.com', NOW, 14)!;
    expect(r.stale).toBe(true);
    expect(r.expired).toBe(true);
  });
});

// getReceipts on an addressed share (Task 7): "not yet seen by" every team
// member is wrong once a share was only ever meant for specific people —
// the expected-reader set narrows to the recipients themselves.
describe('getReceipts: addressed shares', () => {
  it('lists only the people it was addressed to, never the rest of the team', () => {
    const { id } = createShare(
      scope, 'adnan@team.com',
      { what: 'for sam only', priority: 'fyi', recipients: ['sam@team.com'] }, T0,
    );
    const r = getReceipts(scope, id, 'adnan@team.com', NOW, 14)!;
    expect(r.unseen.map((u) => u.email)).toEqual(['sam@team.com']);
    expect(r.viewed).toEqual([]);
    expect(r.dismissed).toEqual([]);
    // Priya was never addressed, so she must not appear in any bucket.
    const all = [...r.viewed, ...r.dismissed, ...r.unseen.map((u) => u.email)];
    expect(all).not.toContain('priya@team.com');
  });

  it('moves an addressed recipient to viewed/dismissed the same way an unaddressed one would', () => {
    const { id } = createShare(
      scope, 'adnan@team.com',
      { what: 'for sam and priya', priority: 'fyi', recipients: ['sam@team.com', 'priya@team.com'] }, T0,
    );
    recordReceipt(scope, id, 'sam@team.com', 'viewed', NOW);
    const r = getReceipts(scope, id, 'adnan@team.com', NOW, 14)!;
    expect(r.viewed).toEqual(['sam@team.com']);
    expect(r.unseen.map((u) => u.email)).toEqual(['priya@team.com']);
  });

  // Finding 3 of the Task 7 review: createShare's `notified` and this
  // function's expected-reader set were counted from different things — the
  // raw list the caller typed, versus real `members` rows — so a typo'd
  // address reported "notified: 1" for a share with zero expected readers.
  // They now come from one resolved set, and the mismatch is unconstructible.
  it('accounts for exactly as many people as createShare reported notified', () => {
    const { id, notified } = createShare(
      scope, 'adnan@team.com',
      { what: 'for sam and priya', priority: 'fyi', recipients: ['sam@team.com', 'priya@team.com'] }, T0,
    );
    recordReceipt(scope, id, 'sam@team.com', 'viewed', NOW);
    const r = getReceipts(scope, id, 'adnan@team.com', NOW, 14)!;
    expect(r.viewed.length + r.dismissed.length + r.unseen.length).toBe(notified);

    // And the way the two used to disagree cannot happen at all any more: an
    // address no member holds is refused at publish time rather than counted
    // as notified and then reported to nobody.
    expect(() =>
      createShare(scope, 'adnan@team.com', { what: 'typo', priority: 'fyi', recipients: ['sma@team.com'] }, T0),
    ).toThrow(/sma@team\.com/);
  });

  it('keeps reporting the whole team when a share names no recipients', () => {
    const { id } = createShare(scope, 'adnan@team.com', { what: 'everyone', priority: 'fyi' }, T0);
    const r = getReceipts(scope, id, 'adnan@team.com', NOW, 14)!;
    expect(r.unseen.map((u) => u.email).sort()).toEqual(['priya@team.com', 'sam@team.com']);
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

    expect(getReceipts(otherScope, id, 'adnan@team.com', NOW, 14)).toBeUndefined();
    // The real team's view is unaffected.
    expect(getReceipts(scope, id, 'adnan@team.com', NOW, 14)!.unseen.map((u) => u.email)).not.toContain('intruder@other.com');
  });

  it('getReceipts scopes both the receipts read and the member roster', () => {
    const { id } = createShare(scope, 'adnan@team.com', { what: 'x', priority: 'fyi' }, T0);
    recordReceipt(scope, id, 'priya@team.com', 'viewed', NOW);

    const r = getReceipts(scope, id, 'adnan@team.com', NOW, 14)!;
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

// ---------------------------------------------------------------------------
// Fix round 1: no receipt may exist for someone who cannot see the share, and
// the receipt summary is for the author and the recipients only. `read_share`
// used to record a `viewed` receipt for any team member who asked for an
// addressed share — leaking the body AND writing a row into the author's
// receipt data for someone the share was never sent to.
// ---------------------------------------------------------------------------
describe('receipts on an addressed share are author/recipient only', () => {
  function addressedToSam(): string {
    return createShare(
      scope, 'adnan@team.com',
      { what: 'for sam only', priority: 'fyi', recipients: ['sam@team.com'] }, T0,
    ).id;
  }

  it('recordReceipt refuses to write for a non-recipient, and writes no row at all', () => {
    const id = addressedToSam();
    expect(recordReceipt(scope, id, 'priya@team.com', 'viewed', NOW)).toBe(false);
    const rows = db.prepare('SELECT * FROM receipts WHERE share_id = ?').all(id);
    expect(rows).toHaveLength(0);
  });

  it('recordReceipt still writes for the recipient', () => {
    const id = addressedToSam();
    expect(recordReceipt(scope, id, 'sam@team.com', 'viewed', NOW)).toBe(true);
    expect(getReceipts(scope, id, 'adnan@team.com', NOW, 14)!.viewed).toEqual(['sam@team.com']);
  });

  it('getReceipts hides the recipient list from a non-recipient', () => {
    const id = addressedToSam();
    expect(getReceipts(scope, id, 'priya@team.com', NOW, 14)).toBeUndefined();
  });

  it('getReceipts still answers the author and the recipient', () => {
    const id = addressedToSam();
    expect(getReceipts(scope, id, 'adnan@team.com', NOW, 14)!.unseen.map((u) => u.email)).toEqual(['sam@team.com']);
    expect(getReceipts(scope, id, 'sam@team.com', NOW, 14)).toBeDefined();
  });

  it('an unaddressed share is unchanged: every member may record and read receipts', () => {
    const { id } = createShare(scope, 'adnan@team.com', { what: 'everyone', priority: 'fyi' }, T0);
    expect(recordReceipt(scope, id, 'priya@team.com', 'viewed', NOW)).toBe(true);
    expect(getReceipts(scope, id, 'priya@team.com', NOW, 14)!.viewed).toEqual(['priya@team.com']);
  });
});
