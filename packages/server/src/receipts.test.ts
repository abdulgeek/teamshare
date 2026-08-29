import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, upsertMember, removeMember, type Db } from './db.js';
import { createShare, markStale } from './shares.js';
import { recordReceipt, getReceipts } from './receipts.js';

let db: Db;
const T0 = '2026-08-20T00:00:00.000Z';
const NOW = '2026-08-29T00:00:00.000Z';

beforeEach(() => {
  db = openDb(':memory:');
  upsertMember(db, 'adnan@team.com', 'Adnan', T0);
  upsertMember(db, 'priya@team.com', 'Priya', T0);
  upsertMember(db, 'sam@team.com', 'Sam', T0);
});
afterEach(() => { db.close(); });

describe('recordReceipt', () => {
  it('records viewed and dismissed', () => {
    const { id } = createShare(db, 'adnan@team.com', { what: 'x', priority: 'fyi' }, T0);
    recordReceipt(db, id, 'priya@team.com', 'viewed', NOW);
    recordReceipt(db, id, 'sam@team.com', 'dismissed', NOW);
    const r = getReceipts(db, id, NOW, 14)!;
    expect(r.viewed).toEqual(['priya@team.com']);
    expect(r.dismissed).toEqual(['sam@team.com']);
    expect(r.unseen).toEqual([]);
  });

  it('is idempotent', () => {
    const { id } = createShare(db, 'adnan@team.com', { what: 'x', priority: 'fyi' }, T0);
    recordReceipt(db, id, 'priya@team.com', 'viewed', NOW);
    recordReceipt(db, id, 'priya@team.com', 'viewed', NOW);
    expect(getReceipts(db, id, NOW, 14)!.viewed).toEqual(['priya@team.com']);
  });

  it('never downgrades viewed to dismissed, but upgrades dismissed to viewed', () => {
    const { id } = createShare(db, 'adnan@team.com', { what: 'x', priority: 'fyi' }, T0);
    recordReceipt(db, id, 'priya@team.com', 'viewed', NOW);
    recordReceipt(db, id, 'priya@team.com', 'dismissed', NOW);
    expect(getReceipts(db, id, NOW, 14)!.viewed).toEqual(['priya@team.com']);

    recordReceipt(db, id, 'sam@team.com', 'dismissed', NOW);
    recordReceipt(db, id, 'sam@team.com', 'viewed', NOW);
    expect(getReceipts(db, id, NOW, 14)!.viewed).toContain('sam@team.com');
  });
});

describe('getReceipts', () => {
  it('excludes the sender from every bucket', () => {
    const { id } = createShare(db, 'adnan@team.com', { what: 'x', priority: 'fyi' }, T0);
    const r = getReceipts(db, id, NOW, 14)!;
    const unseenEmails = r.unseen.map((u) => u.email);
    const all = [...r.viewed, ...r.dismissed, ...unseenEmails];
    expect(all).not.toContain('adnan@team.com');
    expect(unseenEmails.sort()).toEqual(['priya@team.com', 'sam@team.com']);
  });

  it('counts a member who joined later as unseen', () => {
    const { id } = createShare(db, 'adnan@team.com', { what: 'x', priority: 'fyi' }, T0);
    upsertMember(db, 'newbie@team.com', 'Newbie', NOW);
    expect(getReceipts(db, id, NOW, 14)!.unseen.map((u) => u.email)).toContain('newbie@team.com');
  });

  it('drops a removed member from the denominator', () => {
    const { id } = createShare(db, 'adnan@team.com', { what: 'x', priority: 'fyi' }, T0);
    removeMember(db, 'sam@team.com');
    expect(getReceipts(db, id, NOW, 14)!.unseen.map((u) => u.email)).toEqual(['priya@team.com']);
  });

  it("pairs each unseen member with their last_seen, so a quiet member's silence is visible", () => {
    // Distinguishing "hasn't read it yet" from "hasn't connected in two
    // weeks" is the whole point: both would otherwise render identically as
    // just an email in the unseen list.
    const { id } = createShare(db, 'adnan@team.com', { what: 'x', priority: 'fyi' }, T0);
    // Sam reconnects (touching last_seen) without viewing or dismissing.
    upsertMember(db, 'sam@team.com', 'Sam', NOW);
    const r = getReceipts(db, id, NOW, 14)!;
    const sam = r.unseen.find((u) => u.email === 'sam@team.com');
    const priya = r.unseen.find((u) => u.email === 'priya@team.com');
    expect(sam?.last_seen).toBe(NOW);
    expect(priya?.last_seen).toBe(T0); // never reconnected since joining
  });

  it('flags an expired share', () => {
    const { id } = createShare(db, 'adnan@team.com', { what: 'x', priority: 'fyi' }, '2026-08-01T00:00:00.000Z');
    expect(getReceipts(db, id, NOW, 14)!.expired).toBe(true);
    const fresh = createShare(db, 'adnan@team.com', { what: 'y', priority: 'fyi' }, '2026-08-28T00:00:00.000Z');
    expect(getReceipts(db, fresh.id, NOW, 14)!.expired).toBe(false);
  });

  it('returns undefined for an unknown share', () => {
    expect(getReceipts(db, 'shr_nope', NOW, 14)).toBeUndefined();
  });

  it('flags a stale share', () => {
    const { id } = createShare(db, 'adnan@team.com', { what: 'x', priority: 'fyi' }, T0);
    expect(getReceipts(db, id, NOW, 14)!.stale).toBe(false);
    markStale(db, id, 'adnan@team.com', NOW);
    expect(getReceipts(db, id, NOW, 14)!.stale).toBe(true);
  });

  it('flags a share that is both stale and expired as stale (the more informative fact)', () => {
    const { id } = createShare(db, 'adnan@team.com', { what: 'x', priority: 'fyi' }, '2026-08-01T00:00:00.000Z');
    markStale(db, id, 'adnan@team.com', NOW);
    const r = getReceipts(db, id, NOW, 14)!;
    expect(r.stale).toBe(true);
    expect(r.expired).toBe(true);
  });
});
