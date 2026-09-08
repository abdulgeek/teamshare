import { describe, it, expect } from 'vitest';
import {
  describeAge,
  classifyRelevance,
  relevanceLabel,
  RELEVANCE_WINDOW_DAYS,
} from './relevance.js';

const NOW = '2026-09-08T12:00:00.000Z';
const ago = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('describeAge', () => {
  it('reads the way a person would say it', () => {
    expect(describeAge(0)).toBe('just now');
    expect(describeAge(30_000)).toBe('just now');
    expect(describeAge(MIN)).toBe('1 minute ago');
    expect(describeAge(5 * MIN)).toBe('5 minutes ago');
    expect(describeAge(HOUR)).toBe('1 hour ago');
    expect(describeAge(3 * HOUR)).toBe('3 hours ago');
    expect(describeAge(DAY)).toBe('1 day ago');
    expect(describeAge(2 * DAY)).toBe('2 days ago');
    expect(describeAge(13 * DAY)).toBe('13 days ago');
    expect(describeAge(14 * DAY)).toBe('2 weeks ago');
    expect(describeAge(30 * DAY)).toBe('4 weeks ago');
  });

  it('always rounds down, so nothing reads as older than it is', () => {
    // 50 hours is "2 days ago", never "3 days ago" — the person who wrote it
    // two days back would read a round-up as simply wrong.
    expect(describeAge(50 * HOUR)).toBe('2 days ago');
    expect(describeAge(59 * MIN)).toBe('59 minutes ago');
    expect(describeAge(23 * HOUR + 59 * MIN)).toBe('23 hours ago');
  });

  it('clamps a future timestamp rather than saying "-3 hours ago"', () => {
    // Clock skew between a teammate's machine and this one is ordinary; it
    // must not produce nonsense.
    expect(describeAge(-5 * HOUR)).toBe('just now');
  });
});

describe('classifyRelevance', () => {
  const base = { priority: 'fyi' as const, nowIso: NOW, expiryDays: 14 };

  it('grades a share by how long ago it was published', () => {
    expect(classifyRelevance({ ...base, createdAt: ago(2 * HOUR) }).relevance).toBe('new');
    expect(classifyRelevance({ ...base, createdAt: ago(2 * DAY) }).relevance).toBe('recent');
    expect(classifyRelevance({ ...base, createdAt: ago(5 * DAY) }).relevance).toBe('ageing');
    expect(classifyRelevance({ ...base, createdAt: ago(9 * DAY) }).relevance).toBe('old');
  });

  it('stops surfacing an ordinary share once it is past the window', () => {
    expect(classifyRelevance({ ...base, createdAt: ago(6 * DAY) }).relevant).toBe(true);
    expect(classifyRelevance({ ...base, createdAt: ago((RELEVANCE_WINDOW_DAYS + 1) * DAY) }).relevant).toBe(false);
  });

  it('keeps a blocking share surfaced past the window, because that is what the label promises', () => {
    // "You must not miss this" cannot quietly stop being shown on day eight
    // while it is still unread. An fyi from last week is a different thing.
    const old = { ...base, createdAt: ago(9 * DAY) };
    expect(classifyRelevance({ ...old, priority: 'blocking' }).relevant).toBe(true);
    expect(classifyRelevance({ ...old, priority: 'blocking' }).relevance).toBe('old');
    expect(classifyRelevance({ ...old, priority: 'fyi' }).relevant).toBe(false);
    expect(classifyRelevance({ ...old, priority: 'heads-up' }).relevant).toBe(false);
  });

  it('lets the author overrule every age rule', () => {
    // They know it no longer applies. That beats any threshold, at any age,
    // for any priority.
    const f = classifyRelevance({
      ...base,
      priority: 'blocking',
      createdAt: ago(1 * HOUR),
      staleAt: NOW,
    });
    expect(f.relevance).toBe('stale');
    expect(f.relevant).toBe(false);
  });

  it('marks anything past the hard expiry expired, blocking included', () => {
    const f = classifyRelevance({ ...base, priority: 'blocking', createdAt: ago(20 * DAY) });
    expect(f.relevance).toBe('expired');
    expect(f.relevant).toBe(false);
  });

  it('honours a caller-supplied window', () => {
    const twoDaysOld = { ...base, createdAt: ago(2 * DAY) };
    expect(classifyRelevance({ ...twoDaysOld, relevanceWindowDays: 1 }).relevance).toBe('old');
    expect(classifyRelevance({ ...twoDaysOld, relevanceWindowDays: 30 }).relevance).toBe('recent');
  });

  it('carries the human age alongside the grade', () => {
    expect(classifyRelevance({ ...base, createdAt: ago(3 * HOUR) }).age).toBe('3 hours ago');
  });

  it('never throws on an unparseable timestamp, and does not hide the share', () => {
    // Rendering a digest must not fail over one bad row, and erring toward
    // showing it is the safe direction.
    const f = classifyRelevance({ ...base, createdAt: 'not a date' });
    expect(f.ageMs).toBe(0);
    expect(f.relevant).toBe(true);
  });
});

describe('relevanceLabel', () => {
  const at = (createdAt: string, priority: 'fyi' | 'blocking' = 'fyi') =>
    classifyRelevance({ createdAt, priority, nowIso: NOW, expiryDays: 14 });

  it('says nothing for the common case, so the labels that do appear are noticed', () => {
    expect(relevanceLabel(at(ago(1 * HOUR)))).toBeNull();
  });

  it('labels everything else in plain words', () => {
    expect(relevanceLabel(at(ago(2 * DAY)))).toBe('recent');
    expect(relevanceLabel(at(ago(5 * DAY)))).toBe('ageing');
    expect(relevanceLabel(at(ago(9 * DAY)))).toBe('old');
    expect(relevanceLabel(at(ago(9 * DAY), 'blocking'))).toBe('still blocking, but old');
    expect(relevanceLabel(at(ago(20 * DAY)))).toBe('expired');
    expect(relevanceLabel({ ...at(ago(HOUR)), relevance: 'stale', relevant: false })).toBe('no longer relevant');
  });
});
