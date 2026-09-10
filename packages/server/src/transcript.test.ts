import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  openDb, upsertMember, getOrCreateDefaultTeamId, makeTeamScope,
  type Db, type TeamScope,
} from './db.js';
import { createShare, markStale } from './shares.js';
import { rememberAlias } from './directory.js';
import { getTranscript, renderTranscript, TRANSCRIPT_LIMIT_MAX } from './transcript.js';

let db: Db;
let scope: TeamScope;
const T0 = '2026-09-01T00:00:00.000Z';

beforeEach(() => {
  db = openDb(':memory:');
  scope = makeTeamScope(db, getOrCreateDefaultTeamId(db));
  upsertMember(scope, 'abdul@acme.com', 'Abdul Sagheer', T0);
  upsertMember(scope, 'priya@acme.com', 'Priya Nair', T0);
  upsertMember(scope, 'sam@acme.com', 'Sam Okafor', T0);
});
afterEach(() => { db.close(); });

const say = (from: string, at: string, opts: Record<string, unknown>) =>
  createShare(scope, from, { priority: 'fyi', ...opts } as never, at);

const get = (viewer: string, opts: Parameters<typeof getTranscript>[2] = {}) => {
  const r = getTranscript(scope, viewer, opts);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const text = (viewer: string, opts: Parameters<typeof getTranscript>[2] = {}) =>
  renderTranscript(get(viewer, opts), { withPerson: Boolean(opts.with) });

describe('a conversation with one person', () => {
  beforeEach(() => {
    say('abdul@acme.com', '2026-09-08T09:14:00.000Z', { what: 'starting EN-2022', recipients: ['Priya Nair'] });
    say('priya@acme.com', '2026-09-08T14:02:00.000Z', { what: 'holding off then', recipients: ['Abdul'] });
    say('priya@acme.com', '2026-09-09T10:31:00.000Z', { what: 'any ETA?', recipients: ['Abdul'], priority: 'blocking' });
  });

  it('reads forwards, because that is how a conversation happened', () => {
    expect(get('abdul@acme.com', { with: 'Priya' }).entries.map((e) => e.what)).toEqual([
      'starting EN-2022', 'holding off then', 'any ETA?',
    ]);
  });

  it('puts each reader on their own side', () => {
    expect(text('abdul@acme.com', { with: 'Priya' })).toMatch(/09:14\s+you\s+starting EN-2022/);
    expect(text('priya@acme.com', { with: 'Abdul' })).toMatch(/09:14\s+Abdul Sagheer\s+starting EN-2022/);
    expect(text('priya@acme.com', { with: 'Abdul' })).toMatch(/14:02\s+you\s+holding off then/);
  });

  it('groups by day, once per day, in order', () => {
    const out = text('abdul@acme.com', { with: 'Priya' });
    expect(out.match(/Tuesday, 08-09-2026/g)).toHaveLength(1);
    expect(out.indexOf('Tuesday, 08-09-2026')).toBeLessThan(out.indexOf('Wednesday, 09-09-2026'));
  });

  it('carries why and action, indented under the message', () => {
    say('abdul@acme.com', '2026-09-10T08:05:00.000Z', {
      what: 'landed it', why: 'middleware is on main', action: 'rebase first', recipients: ['Priya'],
    });
    const out = text('abdul@acme.com', { with: 'Priya' });
    expect(out).toContain('why: middleware is on main');
    expect(out).toContain('do:  rebase first');
  });

  it('marks a priority that is not the default, and stays quiet about fyi', () => {
    const out = text('abdul@acme.com', { with: 'Priya' });
    expect(out).toContain('[blocking]');
    expect(out).not.toContain('[fyi]');
  });

  it('resolves the other person by name, nickname or address', () => {
    rememberAlias(scope, 'abdul@acme.com', 'Pri', 'priya@acme.com', T0);
    for (const term of ['Priya', '@Priya', 'priya@acme.com', 'Pri']) {
      expect(get('abdul@acme.com', { with: term }).entries, term).toHaveLength(3);
    }
  });

  it('refuses an ambiguous name instead of picking one', () => {
    upsertMember(scope, 'priya.r@acme.com', 'Priya Raman', T0);
    const r = getTranscript(scope, 'abdul@acme.com', { with: 'Priya' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('matches 2 people');
  });

  it('refuses the reader themselves', () => {
    const r = getTranscript(scope, 'abdul@acme.com', { with: 'Abdul' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('that is you');
  });

  it('says so plainly when there is nothing between them', () => {
    expect(text('abdul@acme.com', { with: 'Sam' })).toBe('Nothing between you and Sam Okafor <sam@acme.com> yet.');
  });

  // A broadcast is not something you said to one person, and showing it in a
  // one-to-one thread would misrepresent who heard it.
  it('leaves team-wide notes out of a one-to-one thread', () => {
    say('priya@acme.com', '2026-09-08T12:00:00.000Z', { what: 'standup moved' });
    expect(get('abdul@acme.com', { with: 'Priya' }).entries.map((e) => e.what)).not.toContain('standup moved');
  });
});

describe('the team feed', () => {
  it('shows only what went to everybody', () => {
    say('sam@acme.com', '2026-09-08T11:00:00.000Z', { what: 'standup moved to 10am' });
    say('abdul@acme.com', '2026-09-09T09:00:00.000Z', { what: 'a private word', recipients: ['Priya'] });
    const feed = get('abdul@acme.com').entries.map((e) => e.what);
    expect(feed).toEqual(['standup moved to 10am']);
  });

  it('says so plainly when the team has published nothing', () => {
    expect(text('abdul@acme.com')).toBe('Nobody has published a team-wide note yet.');
  });
});

describe('what a transcript must never show', () => {
  it('hides a thread the reader is not part of', () => {
    say('priya@acme.com', '2026-09-08T09:00:00.000Z', { what: 'between us two', recipients: ['Sam'] });
    expect(get('abdul@acme.com', { with: 'Priya' }).entries).toEqual([]);
    expect(get('abdul@acme.com', { with: 'Sam' }).entries).toEqual([]);
    // The two who were actually on it still see it.
    expect(get('sam@acme.com', { with: 'Priya' }).entries).toHaveLength(1);
  });

  it('hides a withdrawn note from both sides', () => {
    const s = say('abdul@acme.com', '2026-09-08T09:00:00.000Z', { what: 'never mind', recipients: ['Priya'] });
    markStale(scope, s.id, 'abdul@acme.com', '2026-09-08T10:00:00.000Z');
    expect(get('abdul@acme.com', { with: 'Priya' }).entries).toEqual([]);
    expect(get('priya@acme.com', { with: 'Abdul' }).entries).toEqual([]);
  });

  it('never reaches another team', () => {
    say('abdul@acme.com', '2026-09-08T09:00:00.000Z', { what: 'ours', recipients: ['Priya'] });
    const alien = makeTeamScope(db, 'other-team');
    const r = getTranscript(alien, 'abdul@acme.com', {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.entries).toEqual([]);
  });
});

describe('length', () => {
  beforeEach(() => {
    for (let i = 0; i < 12; i++) {
      say('abdul@acme.com', `2026-09-08T${String(8 + i).padStart(2, '0')}:00:00.000Z`, {
        what: `note ${i}`, recipients: ['Priya'],
      });
    }
  });

  // Taking the oldest N would show a long thread's beginning and hide
  // everything since, which is the opposite of catching up.
  it('keeps the most recent notes, still in forward order', () => {
    const e = get('abdul@acme.com', { with: 'Priya', limit: 3 }).entries;
    expect(e.map((x) => x.what)).toEqual(['note 9', 'note 10', 'note 11']);
  });

  it('says how many it is not showing', () => {
    expect(text('abdul@acme.com', { with: 'Priya', limit: 3 })).toContain('latest 3 of 12');
    expect(text('abdul@acme.com', { with: 'Priya', limit: 3 })).toContain('9 older note(s) not shown');
  });

  it('does not mention truncation when there is none', () => {
    expect(text('abdul@acme.com', { with: 'Priya' })).not.toContain('not shown');
  });

  it('clamps an absurd limit rather than failing', () => {
    expect(get('abdul@acme.com', { with: 'Priya', limit: TRANSCRIPT_LIMIT_MAX + 5000 }).entries).toHaveLength(12);
    expect(get('abdul@acme.com', { with: 'Priya', limit: 0 }).entries).toHaveLength(1);
  });
});

// Two notes in the same millisecond used to tiebreak on a random hex id,
// which shuffled a rapid back-and-forth into an order nobody spoke it in.
describe('notes written in the same instant', () => {
  it('keeps the order they were actually written in', () => {
    const SAME = '2026-09-08T09:00:00.000Z';
    for (const what of ['first', 'second', 'third', 'fourth'])
      say('abdul@acme.com', SAME, { what, recipients: ['Priya'] });
    expect(get('abdul@acme.com', { with: 'Priya' }).entries.map((e) => e.what))
      .toEqual(['first', 'second', 'third', 'fourth']);
  });
});
