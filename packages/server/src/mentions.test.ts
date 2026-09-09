import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  openDb, upsertMember, getOrCreateDefaultTeamId, makeTeamScope,
  type Db, type TeamScope,
} from './db.js';
import { createShare, markStale } from './shares.js';
import { getReceipts } from './receipts.js';
import { findMentions, keyMatcher, normalizeKeys, MENTION_KEY_SHAPE, MAX_KEYS } from './mentions.js';

let db: Db;
let scope: TeamScope;
const T0 = '2026-08-01T00:00:00.000Z';
const NOW = '2026-08-29T00:00:00.000Z';
// Inside the 14-day expiry window but well outside the 7-day relevance window,
// which is the whole point: the digest would have stopped showing this.
const OLD = '2026-08-20T00:00:00.000Z';

beforeEach(() => {
  db = openDb(':memory:');
  scope = makeTeamScope(db, getOrCreateDefaultTeamId(db));
  upsertMember(scope, 'adnan@team.com', 'Adnan', T0);
  upsertMember(scope, 'priya@team.com', 'Priya', T0);
  upsertMember(scope, 'sam@team.com', 'Sam', T0);
});
afterEach(() => { db.close(); });

const find = (viewer: string, keys: string[]) => findMentions(scope, viewer, keys, NOW, 14);

describe('normalizeKeys', () => {
  it('upper-cases ticket keys and lower-cases repo references', () => {
    expect(normalizeKeys(['en-2022', 'ACME/API#412'])).toEqual(['EN-2022', 'acme/api#412']);
  });

  it('drops anything that is not an identifier, rather than widening the search', () => {
    expect(normalizeKeys(['auth refactor', '', 'src/index.ts', 'EN'])).toEqual([]);
  });

  it('deduplicates and caps', () => {
    expect(normalizeKeys(['EN-1', 'en-1'])).toEqual(['EN-1']);
    expect(normalizeKeys(['AA-1', 'BB-2', 'CC-3', 'DD-4', 'EE-5', 'FF-6'])).toHaveLength(MAX_KEYS);
  });

  it('accepts exactly what MENTION_KEY_SHAPE accepts', () => {
    for (const good of ['EN-2022', 'PROJ-14', 'AB-1', 'acme/api#412', 'a.b-c/d_e#1']) {
      expect(MENTION_KEY_SHAPE.test(good)).toBe(true);
    }
    for (const bad of ['E-1', 'EN2022', 'EN-', '-2022', 'EN-12345678', 'ACME/API#412']) {
      expect(MENTION_KEY_SHAPE.test(bad)).toBe(false);
    }
  });
});

describe('keyMatcher', () => {
  it('will not match a key embedded in a longer identifier', () => {
    const re = keyMatcher('EN-2022');
    expect(re.test('blocked on EN-2022 today')).toBe(true);
    expect(re.test('EN-2022.')).toBe(true);
    expect(re.test('see GEN-2022')).toBe(false);
    expect(re.test('see EN-20221')).toBe(false);
  });

  it('will not match a repo reference under a longer owner', () => {
    const re = keyMatcher('acme/api#412');
    expect(re.test('landed acme/api#412')).toBe(true);
    expect(re.test('landed myacme/api#412')).toBe(false);
    expect(re.test('landed acme/api#4120')).toBe(false);
  });
});

describe('findMentions', () => {
  it('finds a share that names the key, and says which key it named', () => {
    createShare(scope, 'adnan@team.com', { what: 'EN-2022 is blocked on the auth refactor', priority: 'blocking' }, NOW);
    const [m] = find('priya@team.com', ['EN-2022']);
    expect(m.what).toContain('EN-2022');
    expect(m.sender_name).toBe('Adnan');
    expect(m.keys).toEqual(['EN-2022']);
    expect(m.mine).toBe(false);
  });

  it('matches the key in why, action and tags, not just what', () => {
    createShare(scope, 'adnan@team.com', { what: 'auth refactor underway', why: 'it blocks EN-2022', priority: 'fyi' }, NOW);
    createShare(scope, 'adnan@team.com', { what: 'middleware moved', action: 'rebase EN-3003 onto main', priority: 'fyi' }, NOW);
    createShare(scope, 'adnan@team.com', { what: 'tagged one', tags: ['en-4004'], priority: 'fyi' }, NOW);
    expect(find('priya@team.com', ['EN-2022'])).toHaveLength(1);
    expect(find('priya@team.com', ['EN-3003'])).toHaveLength(1);
    expect(find('priya@team.com', ['EN-4004'])).toHaveLength(1);
  });

  // The reason this feature exists. Every one of these is invisible to the digest.
  it('returns a share the reader has already read', () => {
    const s = createShare(scope, 'adnan@team.com', { what: 'EN-2022 is blocked', priority: 'blocking' }, NOW);
    db.prepare(`INSERT INTO receipts (team_id, share_id, member_email, status, at) VALUES (?, ?, ?, ?, ?)`)
      .run(scope.teamId, s.id, 'priya@team.com', 'viewed', NOW);
    expect(find('priya@team.com', ['EN-2022'])).toHaveLength(1);
  });

  it('returns a share older than the relevance window', () => {
    createShare(scope, 'adnan@team.com', { what: 'EN-2022 is blocked', priority: 'fyi' }, OLD);
    const [m] = find('priya@team.com', ['EN-2022']);
    expect(m.relevance).not.toBe('new');
  });

  it('returns a share scoped to a different repo', () => {
    createShare(scope, 'adnan@team.com', { what: 'EN-2022 is blocked', priority: 'fyi', project: 'github.com/acme/other' }, NOW);
    expect(find('priya@team.com', ['EN-2022'])).toHaveLength(1);
  });

  it('never matches a key that is only part of a longer identifier', () => {
    createShare(scope, 'adnan@team.com', { what: 'GEN-2022 and EN-20221 both moved', priority: 'fyi' }, NOW);
    expect(find('priya@team.com', ['EN-2022'])).toHaveLength(0);
    expect(find('priya@team.com', ['GEN-2022'])).toHaveLength(1);
  });

  it('treats _ in a repo reference as a literal, not a LIKE wildcard', () => {
    createShare(scope, 'adnan@team.com', { what: 'landed acmeXapi#7', priority: 'fyi' }, NOW);
    expect(find('priya@team.com', ['acme_api#7'])).toHaveLength(0);
  });

  it('returns nothing for a key nobody has published about', () => {
    createShare(scope, 'adnan@team.com', { what: 'unrelated', priority: 'fyi' }, NOW);
    expect(find('priya@team.com', ['EN-9999'])).toEqual([]);
  });

  it('rejects a free-text query instead of doing a substring search', () => {
    createShare(scope, 'adnan@team.com', { what: 'the auth refactor', priority: 'fyi' }, NOW);
    expect(find('priya@team.com', ['auth'])).toEqual([]);
  });

  describe('what it must never surface', () => {
    it('hides a share addressed to somebody else', () => {
      createShare(
        scope, 'adnan@team.com',
        { what: 'EN-2022 is blocked', priority: 'blocking', recipients: ['sam@team.com'] },
        NOW,
      );
      expect(find('priya@team.com', ['EN-2022'])).toEqual([]);
      expect(find('sam@team.com', ['EN-2022'])).toHaveLength(1);
    });

    it('hides a withdrawn share, so nobody is sent after a block that was lifted', () => {
      const s = createShare(scope, 'adnan@team.com', { what: 'EN-2022 is blocked', priority: 'blocking' }, NOW);
      markStale(scope, s.id, 'adnan@team.com', NOW);
      expect(find('priya@team.com', ['EN-2022'])).toEqual([]);
      expect(find('adnan@team.com', ['EN-2022'])).toEqual([]);
    });

    it('hides an expired share', () => {
      createShare(scope, 'adnan@team.com', { what: 'EN-2022 is blocked', priority: 'blocking' }, '2026-07-01T00:00:00.000Z');
      expect(find('priya@team.com', ['EN-2022'])).toEqual([]);
    });

    it('never reaches another team', () => {
      const other = makeTeamScope(db, getOrCreateDefaultTeamId(db));
      createShare(scope, 'adnan@team.com', { what: 'EN-2022 is blocked', priority: 'blocking' }, NOW);
      const alien = makeTeamScope(db, 'some-other-team');
      expect(findMentions(alien, 'priya@team.com', ['EN-2022'], NOW, 14)).toEqual([]);
      expect(findMentions(other, 'priya@team.com', ['EN-2022'], NOW, 14)).toHaveLength(1);
    });
  });

  describe('the author side of the loop', () => {
    it("flags the reader's own share as theirs, so nothing nags them to publish it again", () => {
      createShare(scope, 'adnan@team.com', { what: 'picked up EN-2022', priority: 'fyi' }, NOW);
      const [m] = find('adnan@team.com', ['EN-2022']);
      expect(m.mine).toBe(true);
    });

    it('flags a share addressed to the reader, which is a teammate speaking to them directly', () => {
      createShare(
        scope, 'priya@team.com',
        { what: 'waiting on EN-2022', priority: 'blocking', recipients: ['adnan@team.com'] },
        NOW,
      );
      const [m] = find('adnan@team.com', ['EN-2022']);
      expect(m.to_me).toBe(true);
      expect(m.mine).toBe(false);
    });

    it("does not mistake an unaddressed share for one addressed to the reader", () => {
      createShare(scope, 'priya@team.com', { what: 'EN-2022 is blocked', priority: 'blocking' }, NOW);
      expect(find('adnan@team.com', ['EN-2022'])[0].to_me).toBe(false);
    });

    it('puts a blocking share first', () => {
      createShare(scope, 'priya@team.com', { what: 'EN-2022 notes', priority: 'fyi' }, NOW);
      createShare(scope, 'sam@team.com', { what: 'EN-2022 is blocked', priority: 'blocking' }, NOW);
      expect(find('adnan@team.com', ['EN-2022'])[0].priority).toBe('blocking');
    });
  });

  // A mention is not a read: the reader never chose to see this, so counting it
  // would silently suppress the share from their own digest and lie to the
  // author about who has seen it.
  it('records no receipt', () => {
    const s = createShare(scope, 'adnan@team.com', { what: 'EN-2022 is blocked', priority: 'blocking' }, NOW);
    find('priya@team.com', ['EN-2022']);
    const summary = getReceipts(scope, s.id, 'adnan@team.com', NOW, 14)!;
    expect(summary.viewed).toEqual([]);
    expect(summary.dismissed).toEqual([]);
    expect(summary.unseen.map((u) => u.email)).toContain('priya@team.com');
  });
});
