// How old a share is, and whether it is still worth interrupting someone with.
//
// Every surface used to print a raw ISO timestamp and nothing else, which put
// two jobs on the reader: work out how long ago that was, and decide whether it
// still matters. Claude did the first badly (date arithmetic against "now" it
// cannot see) and nobody did the second at all — so a note saying "don't merge
// src/auth this week" was surfaced with exactly the same weight three weeks
// later as on the morning it was written.
//
// This computes both, once, on the server, so every surface agrees and no
// client has to do date maths.
import type { Priority } from './shares.js';

// Past this, an unread share stops being surfaced unprompted. It is still
// there — every surface that hides one says how many it hid, and `list_shares`
// never hides anything — it just stops being pushed at you.
export const RELEVANCE_WINDOW_DAYS = 7;

export type Relevance =
  // Ordered by decreasing claim on the reader's attention.
  | 'new' // under a day old
  | 'recent' // under three days
  | 'ageing' // still inside the relevance window
  | 'old' // past the window; not surfaced unprompted
  | 'stale' // the author said it no longer applies
  | 'expired'; // past the instance's hard expiry

export interface Freshness {
  /** Milliseconds since it was published. Negative clocks are clamped to 0. */
  ageMs: number;
  /** Human phrasing of ageMs — "3 hours ago", "2 days ago". */
  age: string;
  /** "Monday, 08-09-2026" — the calendar day, for anyone who wants the actual date. */
  day: string;
  relevance: Relevance;
  /** Whether this should still be pushed at a reader who has not asked. */
  relevant: boolean;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * "Monday, 08-09-2026".
 *
 * An ISO instant — 2026-09-08T11:57:15.607Z — is precise and unreadable, and
 * nobody deciding whether a note still matters cares about the milliseconds.
 * The weekday is the part people actually navigate by ("that was the Friday
 * thing"), and day-first numbers match how the team writes dates.
 *
 * Rendered in UTC, deliberately: the server has no idea what timezone the
 * reader is in, and quietly using the server's own would be wrong for
 * everybody except whoever deployed it. At day granularity the only cost is a
 * share published within a few hours of midnight UTC, and the relative age
 * beside it ("3 hours ago") resolves that anyway.
 */
export function formatDay(iso: string): string {
  const ms = Date.parse(iso);
  // Never throw mid-render over one bad row; show the raw value instead.
  if (!Number.isFinite(ms)) return iso;
  const d = new Date(ms);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${WEEKDAYS[d.getUTCDay()]}, ${dd}-${mm}-${d.getUTCFullYear()}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Deliberately coarse, and always rounded down. "2 days ago" for anything from
 * 48 to 71 hours is the right resolution for deciding whether a note still
 * matters; "1.7 days ago" is not, and a rounded-up "3 days ago" for something
 * published 50 hours back reads as a mistake to anyone who remembers writing
 * it.
 */
export function describeAge(ageMs: number): string {
  const ms = Math.max(0, ageMs);
  if (ms < MINUTE) return 'just now';
  if (ms < HOUR) {
    const n = Math.floor(ms / MINUTE);
    return `${n} minute${n === 1 ? '' : 's'} ago`;
  }
  if (ms < DAY) {
    const n = Math.floor(ms / HOUR);
    return `${n} hour${n === 1 ? '' : 's'} ago`;
  }
  const days = Math.floor(ms / DAY);
  if (days < 14) return `${days} day${days === 1 ? '' : 's'} ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
}

export interface ClassifyInput {
  createdAt: string;
  staleAt?: string | null;
  priority: Priority;
  nowIso: string;
  expiryDays: number;
  relevanceWindowDays?: number;
}

/**
 * A share's age and standing.
 *
 * `blocking` is the one priority that keeps its claim on attention for the full
 * expiry window rather than the shorter relevance one. The whole point of that
 * label is "you must not miss this", and quietly dropping such a note out of
 * the digest on day eight — while it is still unread — would break the promise
 * the label makes. An fyi from last week is a different thing entirely.
 *
 * An author's own `mark_stale` beats every age rule: they know it no longer
 * applies, and that is better information than any threshold.
 */
export function classifyRelevance(input: ClassifyInput): Freshness {
  const { createdAt, staleAt, priority, nowIso, expiryDays } = input;
  const windowDays = input.relevanceWindowDays ?? RELEVANCE_WINDOW_DAYS;

  const created = Date.parse(createdAt);
  const now = Date.parse(nowIso);
  // An unparseable timestamp must not throw in the middle of rendering a
  // digest; treat it as ageless and let it through rather than hiding it.
  const ageMs = Number.isFinite(created) && Number.isFinite(now) ? Math.max(0, now - created) : 0;
  const age = describeAge(ageMs);
  const day = formatDay(createdAt);

  if (staleAt) return { ageMs, age, day, relevance: 'stale', relevant: false };
  if (ageMs >= expiryDays * DAY) return { ageMs, age, day, relevance: 'expired', relevant: false };

  // The window is checked BEFORE the new/recent/ageing grades, not after. With
  // it the other way round, a caller who narrows the window to a day still got
  // "recent" for a two-day-old share, because the fixed 3-day threshold fired
  // first — the custom window silently did nothing.
  if (ageMs >= windowDays * DAY) {
    return { ageMs, age, day, relevance: 'old', relevant: priority === 'blocking' };
  }

  if (ageMs < DAY) return { ageMs, age, day, relevance: 'new', relevant: true };
  if (ageMs < 3 * DAY) return { ageMs, age, day, relevance: 'recent', relevant: true };
  return { ageMs, age, day, relevance: 'ageing', relevant: true };
}

/**
 * The one-word tag shown beside a share. `new` is deliberately not shown: it is
 * the common case, and labelling everything makes the labels invisible.
 */
export function relevanceLabel(f: Freshness): string | null {
  if (f.relevance === 'new') return null;
  if (f.relevance === 'old') return f.relevant ? 'still blocking, but old' : 'old';
  if (f.relevance === 'stale') return 'irrelevant';
  return f.relevance;
}
