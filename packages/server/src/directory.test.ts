import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  openDb, upsertMember, getOrCreateDefaultTeamId, makeTeamScope, createMemberToken,
  type Db, type TeamScope,
} from './db.js';
import { createShare, getShare } from './shares.js';
import {
  extractAngleAddress, forgetAlias, listAliases, looksLikeEmail, rememberAlias,
  resolveRecipientTerm, teamDirectory,
} from './directory.js';

let db: Db;
let scope: TeamScope;
const NOW = '2026-09-09T00:00:00.000Z';

beforeEach(() => {
  db = openDb(':memory:');
  scope = makeTeamScope(db, getOrCreateDefaultTeamId(db));
  upsertMember(scope, 'adnan@acme.com', 'Adnan Sagheer', NOW);
  upsertMember(scope, 'priya@acme.com', 'Priya Raman', NOW);
  upsertMember(scope, 'sam@acme.com', 'Sam Okafor', NOW);
});
afterEach(() => { db.close(); });

const resolve = (term: string, owner = 'priya@acme.com') => resolveRecipientTerm(scope, owner, term);

describe('looksLikeEmail', () => {
  it('treats a leading @ as a mention, not an address', () => {
    expect(looksLikeEmail('@Adnan')).toBe(false);
    expect(looksLikeEmail('adnan@acme.com')).toBe(true);
    expect(looksLikeEmail('Adnan')).toBe(false);
  });

  // teammates and every failure message print this form, so a model echoing
  // one back must be right rather than wrong.
  it('recognises the "Name <email>" form', () => {
    expect(extractAngleAddress('Adnan Sagheer <adnan@acme.com>')).toBe('adnan@acme.com');
    expect(extractAngleAddress('<adnan@acme.com>')).toBe('adnan@acme.com');
    expect(extractAngleAddress('Adnan')).toBeNull();
  });
});

describe('resolveRecipientTerm', () => {
  it('takes an address literally, with no lookup at all', () => {
    expect(resolve('adnan@acme.com')).toEqual({ ok: true, email: 'adnan@acme.com' });
    expect(resolve('ADNAN@Acme.com')).toEqual({ ok: true, email: 'adnan@acme.com' });
  });

  it('resolves a first name, a full name, a surname and a mention', () => {
    for (const term of ['Adnan', 'adnan', 'Adnan Sagheer', 'Sagheer', '@Adnan', '  @adnan  ']) {
      expect(resolve(term), term).toEqual({ ok: true, email: 'adnan@acme.com' });
    }
  });

  it('resolves a prefix when nothing better matches', () => {
    expect(resolve('Adn')).toEqual({ ok: true, email: 'adnan@acme.com' });
  });

  // A private note delivered to the wrong person is silent, so this must ask.
  it('refuses to guess between two people with the same first name', () => {
    upsertMember(scope, 'adnan.k@acme.com', 'Adnan Khan', NOW);
    const res = resolve('Adnan');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe('ambiguous');
      expect(res.candidates.map((c) => c.email).sort()).toEqual(['adnan.k@acme.com', 'adnan@acme.com']);
    }
  });

  // The bug the MCP tests caught: someone whose whole name is "Priya" used to
  // win outright over "Priya Nair", silently, on an exact-whole-name tier.
  // Both are called Priya. That is a question, not a winner.
  it('asks when a whole name and another person\'s first name are the same word', () => {
    upsertMember(scope, 'priya.n@acme.com', 'Priya', NOW);
    const res = resolve('Priya', 'adnan@acme.com');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe('ambiguous');
  });

  it('lets an exact full name win over another exact-first-name teammate', () => {
    upsertMember(scope, 'adnan.k@acme.com', 'Adnan Khan', NOW);
    expect(resolve('Adnan Khan')).toEqual({ ok: true, email: 'adnan.k@acme.com' });
  });

  // Otherwise "Sam" would be dragged into ambiguity by a Samantha who only
  // matches on prefix, and the obvious answer would need a follow-up question.
  it('does not let a weaker prefix match dilute an exact one', () => {
    upsertMember(scope, 'samantha@acme.com', 'Samantha Cole', NOW);
    expect(resolve('Sam')).toEqual({ ok: true, email: 'sam@acme.com' });
  });

  it('reports an unknown name rather than resolving to nobody', () => {
    const res = resolve('Gandalf');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe('unknown');
  });
});

describe('the personal address book', () => {
  it('saves a name and resolves it afterwards', () => {
    expect(resolve('Boss').ok).toBe(false);
    const saved = rememberAlias(scope, 'priya@acme.com', 'Boss', 'adnan@acme.com', NOW);
    expect(saved).toMatchObject({ ok: true, alias: 'boss', email: 'adnan@acme.com', connected: true });
    expect(resolve('Boss')).toEqual({ ok: true, email: 'adnan@acme.com' });
    expect(resolve('@boss')).toEqual({ ok: true, email: 'adnan@acme.com' });
  });

  // What you call someone is yours. One shared namespace would mean whoever
  // saved "Boss" first decided who that meant for the whole team.
  it('is private to the person who saved it', () => {
    rememberAlias(scope, 'priya@acme.com', 'Boss', 'adnan@acme.com', NOW);
    expect(resolve('Boss', 'sam@acme.com').ok).toBe(false);
    expect(listAliases(scope, 'sam@acme.com')).toEqual([]);
  });

  it('lets a saved name override the roster spelling', () => {
    rememberAlias(scope, 'priya@acme.com', 'Sam', 'adnan@acme.com', NOW);
    expect(resolve('Sam')).toEqual({ ok: true, email: 'adnan@acme.com' });
    // ...for that person only.
    expect(resolve('Sam', 'adnan@acme.com')).toEqual({ ok: true, email: 'sam@acme.com' });
  });

  it('is idempotent and repointable', () => {
    rememberAlias(scope, 'priya@acme.com', 'Boss', 'adnan@acme.com', NOW);
    rememberAlias(scope, 'priya@acme.com', 'boss', 'sam@acme.com', NOW);
    expect(listAliases(scope, 'priya@acme.com')).toEqual([{ alias: 'boss', target_email: 'sam@acme.com' }]);
  });

  it('forgets one, and says so when there was nothing to forget', () => {
    rememberAlias(scope, 'priya@acme.com', 'Boss', 'adnan@acme.com', NOW);
    expect(forgetAlias(scope, 'priya@acme.com', 'Boss')).toBe(true);
    expect(forgetAlias(scope, 'priya@acme.com', 'Boss')).toBe(false);
  });

  it('refuses a name that is itself an address, or the user\'s own address', () => {
    expect(rememberAlias(scope, 'priya@acme.com', 'x@y.com', 'adnan@acme.com', NOW).ok).toBe(false);
    expect(rememberAlias(scope, 'priya@acme.com', 'Me', 'priya@acme.com', NOW).ok).toBe(false);
  });

  // Saved, not refused: the user is recording who they mean, and losing what
  // they typed is worse than telling them what is still needed.
  it('saves a name for someone not yet on the team, and says they are not reachable', () => {
    const saved = rememberAlias(scope, 'priya@acme.com', 'Ravi', 'ravi@other.com', NOW);
    expect(saved).toMatchObject({ ok: true, connected: false });
  });
});

describe('addressing a share by name, end to end', () => {
  it('reaches exactly the named person', () => {
    const { id, notified } = createShare(
      scope, 'priya@acme.com',
      { what: 'reviewing EN-2022 now', priority: 'fyi', recipients: ['Adnan'] },
      NOW,
    );
    expect(notified).toBe(1);
    expect(getShare(scope, id, 'adnan@acme.com')).toBeDefined();
    expect(getShare(scope, id, 'sam@acme.com')).toBeUndefined();
  });

  it('accepts names and addresses in the same list, deduplicating the same person', () => {
    const { notified } = createShare(
      scope, 'priya@acme.com',
      { what: 'ok', priority: 'fyi', recipients: ['Adnan', 'adnan@acme.com', 'Sam Okafor'] },
      NOW,
    );
    expect(notified).toBe(2);
  });

  it('resolves a saved name', () => {
    rememberAlias(scope, 'priya@acme.com', 'Boss', 'adnan@acme.com', NOW);
    const { id } = createShare(
      scope, 'priya@acme.com',
      { what: 'ok', priority: 'fyi', recipients: ['Boss'] },
      NOW,
    );
    expect(getShare(scope, id, 'adnan@acme.com')).toBeDefined();
  });

  // The failure that matters. Dropping the name would turn "tell Adnan I'm on
  // EN-2022" into telling the entire team.
  it('throws rather than broadcasting when a name does not resolve', () => {
    const before = (db.prepare('SELECT COUNT(*) AS n FROM shares').get() as { n: number }).n;
    expect(() =>
      createShare(scope, 'priya@acme.com', { what: 'ok', priority: 'fyi', recipients: ['Gandalf'] }, NOW),
    ).toThrow(/nobody on this team is called "Gandalf"/);
    expect((db.prepare('SELECT COUNT(*) AS n FROM shares').get() as { n: number }).n).toBe(before);
  });

  it('names both candidates when a name is ambiguous, so the caller can ask', () => {
    upsertMember(scope, 'adnan.k@acme.com', 'Adnan Khan', NOW);
    expect(() =>
      createShare(scope, 'priya@acme.com', { what: 'ok', priority: 'fyi', recipients: ['Adnan'] }, NOW),
    ).toThrow(/matches 2 people[\s\S]*adnan/i);
  });

  it('still refuses an invited teammate who has never connected', () => {
    createMemberToken(scope, 'newhire@acme.com', 'New Hire', NOW);
    expect(() =>
      createShare(scope, 'priya@acme.com', { what: 'ok', priority: 'fyi', recipients: ['New Hire'] }, NOW),
    ).toThrow(/not yet connected/);
  });

  it('never reaches another team, even by a name that team knows', () => {
    const alien = makeTeamScope(db, 'other-team');
    expect(() =>
      createShare(alien, 'ghost@other.com', { what: 'ok', priority: 'fyi', recipients: ['Adnan'] }, NOW),
    ).toThrow(/nobody on this team is called/);
  });
});

describe('teamDirectory', () => {
  it('separates connected members from invited-but-never-connected ones', () => {
    createMemberToken(scope, 'newhire@acme.com', 'New Hire', NOW);
    const byEmail = new Map(teamDirectory(scope).map((c) => [c.email, c]));
    expect(byEmail.get('adnan@acme.com')).toMatchObject({ name: 'Adnan Sagheer', connected: true });
    expect(byEmail.get('newhire@acme.com')).toMatchObject({ connected: false });
  });
});
