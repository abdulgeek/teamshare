import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, upsertMember, type Db } from './db.js';
import { createShare, markStale } from './shares.js';
import { getUnread, UNREAD_LIMIT } from './unread.js';

let db: Db;
const T0 = '2026-08-01T00:00:00.000Z';
const NOW = '2026-08-29T00:00:00.000Z';

beforeEach(() => {
  db = openDb(':memory:');
  upsertMember(db, 'adnan@team.com', 'Adnan', T0);
  upsertMember(db, 'priya@team.com', 'Priya', T0);
});
afterEach(() => { db.close(); });

function ack(shareId: string, email: string, status: 'viewed' | 'dismissed') {
  db.prepare(
    `INSERT INTO receipts (share_id, member_email, status, at) VALUES (?, ?, ?, ?)`,
  ).run(shareId, email, status, NOW);
}

describe('getUnread', () => {
  it('shows a teammate share to the recipient', () => {
    createShare(db, 'adnan@team.com', { what: 'hello', priority: 'fyi' }, NOW);
    const d = getUnread(db, 'priya@team.com', NOW, 14);
    expect(d.total).toBe(1);
    expect(d.shares[0].what).toBe('hello');
    expect(d.shares[0].sender_name).toBe('Adnan');
    expect(d.shares[0].sender_email).toBe('adnan@team.com');
  });

  it('never shows a member their own share', () => {
    createShare(db, 'adnan@team.com', { what: 'mine', priority: 'fyi' }, NOW);
    expect(getUnread(db, 'Adnan@Team.com', NOW, 14).total).toBe(0);
  });

  it('hides shares once viewed or dismissed', () => {
    const a = createShare(db, 'adnan@team.com', { what: 'a', priority: 'fyi' }, NOW);
    const b = createShare(db, 'adnan@team.com', { what: 'b', priority: 'fyi' }, NOW);
    ack(a.id, 'priya@team.com', 'viewed');
    ack(b.id, 'priya@team.com', 'dismissed');
    expect(getUnread(db, 'priya@team.com', NOW, 14).total).toBe(0);
  });

  it('excludes shares older than the expiry window', () => {
    createShare(db, 'adnan@team.com', { what: 'old', priority: 'blocking' }, '2026-08-01T00:00:00.000Z');
    createShare(db, 'adnan@team.com', { what: 'fresh', priority: 'fyi' }, '2026-08-28T00:00:00.000Z');
    const d = getUnread(db, 'priya@team.com', NOW, 14);
    expect(d.shares.map(s => s.what)).toEqual(['fresh']);
  });

  it('orders blocking first, then newest', () => {
    createShare(db, 'adnan@team.com', { what: 'old-fyi', priority: 'fyi' }, '2026-08-20T00:00:00.000Z');
    createShare(db, 'adnan@team.com', { what: 'new-fyi', priority: 'fyi' }, '2026-08-27T00:00:00.000Z');
    createShare(db, 'adnan@team.com', { what: 'blocker', priority: 'blocking' }, '2026-08-21T00:00:00.000Z');
    const d = getUnread(db, 'priya@team.com', NOW, 14);
    expect(d.shares.map(s => s.what)).toEqual(['blocker', 'new-fyi', 'old-fyi']);
  });

  it('caps the list at UNREAD_LIMIT but reports the true total', () => {
    for (let i = 0; i < UNREAD_LIMIT + 5; i++) {
      createShare(db, 'adnan@team.com', { what: `s${i}`, priority: 'fyi' }, '2026-08-27T00:00:00.000Z');
    }
    const d = getUnread(db, 'priya@team.com', NOW, 14);
    expect(d.total).toBe(UNREAD_LIMIT + 5);
    expect(d.shares).toHaveLength(UNREAD_LIMIT);
  });

  it('shows a share to a member who joined after it was created', () => {
    createShare(db, 'adnan@team.com', { what: 'before-join', priority: 'fyi' }, '2026-08-27T00:00:00.000Z');
    upsertMember(db, 'newbie@team.com', 'Newbie', NOW);
    expect(getUnread(db, 'newbie@team.com', NOW, 14).total).toBe(1);
  });

  it('excludes a share marked stale, from both total and the list', () => {
    const a = createShare(db, 'adnan@team.com', { what: 'still fresh', priority: 'fyi' }, NOW);
    const b = createShare(db, 'adnan@team.com', { what: 'gone stale', priority: 'fyi' }, NOW);
    markStale(db, b.id, 'adnan@team.com', NOW);
    const d = getUnread(db, 'priya@team.com', NOW, 14);
    expect(d.total).toBe(1);
    expect(d.shares.map((s) => s.id)).toEqual([a.id]);
  });
});
