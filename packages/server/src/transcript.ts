import { normalizeEmail, type TeamScope } from './db.js';
import { visibleToClause, type Priority } from './shares.js';
import { formatDay } from './relevance.js';
import { resolveRecipientTerm, describeResolutionFailure } from './directory.js';

/**
 * Shares, read the way you read a chat.
 *
 * `list_shares` answers "what exists, newest first" — a flat inventory with
 * one line per row, raw addresses, and no sense of a conversation happening
 * between two people over days. That is fine for finding a thing and useless
 * for catching up.
 *
 * This renders the same rows the way the exchange actually went: oldest
 * first, grouped under the day it happened, with "you" on your own side and a
 * name on theirs. Nothing new is stored to make it work; it is entirely a
 * different reading of what is already there.
 *
 * The whole render happens HERE, not in the model. A transcript the assistant
 * paraphrases is not a transcript — the point is to see what was actually
 * said, in order, unedited. The tool hands back finished text and the
 * assistant's only job is to print it.
 */

export const TRANSCRIPT_LIMIT_DEFAULT = 50;
export const TRANSCRIPT_LIMIT_MAX = 200;

export interface TranscriptEntry {
  id: string;
  sender_email: string;
  sender_name: string;
  /** True when the reader wrote it, which is what puts it on their side of the transcript. */
  mine: boolean;
  what: string;
  why: string | null;
  action: string | null;
  priority: Priority;
  created_at: string;
  day: string;
  /** HH:MM, UTC. The header says so once rather than repeating it on every line. */
  time: string;
  /** Everyone it was addressed to, empty for a team-wide note. */
  recipients: string[];
}

export interface Transcript {
  /** "the team" or the other person, already resolved to a display name. */
  title: string;
  /** Oldest first. A conversation reads forwards. */
  entries: TranscriptEntry[];
  /** How many exist in total, so a truncated view can say what it is not showing. */
  total: number;
}

export type TranscriptResult = { ok: true; value: Transcript } | { ok: false; error: string };

function timeOfDay(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '--:--';
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

interface Options {
  /** A name or address. Omitted means the team-wide feed. */
  with?: string;
  limit?: number;
}

export function getTranscript(scope: TeamScope, viewerEmail: string, opts: Options = {}): TranscriptResult {
  const me = normalizeEmail(viewerEmail);
  const limit = Math.min(Math.max(opts.limit ?? TRANSCRIPT_LIMIT_DEFAULT, 1), TRANSCRIPT_LIMIT_MAX);
  const visible = visibleToClause(scope, me);

  let where: string;
  let args: unknown[];
  let title: string;

  if (opts.with && opts.with.trim()) {
    // The same resolver `share` uses, so "show me my chat with Priya" and
    // "tell Priya …" agree about who Priya is — including a name you saved.
    const res = resolveRecipientTerm(scope, me, opts.with);
    if (!res.ok) return { ok: false, error: describeResolutionFailure(res) };
    const other = res.email;
    if (other === me) {
      return { ok: false, error: 'that is you — pass a teammate, or omit `with` for the team feed.' };
    }

    // A conversation is what the two of you addressed TO EACH OTHER. A
    // team-wide note either of you published is not part of it: it went to
    // everybody, and folding it in here would make a broadcast look like it
    // was said to one person. The team feed is where those live.
    where = `
      s.team_id = ?
        AND s.stale_at IS NULL
        AND (
          (s.sender_email = ? AND EXISTS (
            SELECT 1 FROM share_recipients sr
             WHERE sr.team_id = ? AND sr.share_id = s.id AND sr.email = ?
          ))
          OR
          (s.sender_email = ? AND EXISTS (
            SELECT 1 FROM share_recipients sr
             WHERE sr.team_id = ? AND sr.share_id = s.id AND sr.email = ?
          ))
        )
        AND ${visible.sql}
    `;
    args = [scope.teamId, me, scope.teamId, other, other, scope.teamId, me, ...visible.args];

    const named = scope.db
      .prepare('SELECT name FROM members WHERE team_id = ? AND email = ?')
      .get(scope.teamId, other) as { name: string } | undefined;
    title = named?.name ? `${named.name} <${other}>` : other;
  } else {
    // The team feed: notes that went to everybody. Addressed ones are
    // somebody's private conversation and belong in a `with` view, not here —
    // including your own, which would otherwise leak into a view a reader
    // reasonably reads aloud in a standup.
    where = `
      s.team_id = ?
        AND s.stale_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM share_recipients sr WHERE sr.team_id = ? AND sr.share_id = s.id
        )
        AND ${visible.sql}
    `;
    args = [scope.teamId, scope.teamId, ...visible.args];
    title = 'the team';
  }

  const { n: total } = scope.db
    .prepare(`SELECT COUNT(*) AS n FROM shares s WHERE ${where}`)
    .get(...args) as { n: number };

  // Newest N in SQL, then reversed for display: taking the OLDEST N would
  // show a long-running conversation's beginning and hide everything that
  // has happened since, which is the opposite of catching up.
  //
  // The tiebreak is `rowid`, not `id`. Two notes written in the same
  // millisecond are ordered by insertion, which is the order they were
  // actually said in; ids are random hex, so tiebreaking on those would shuffle
  // a rapid back-and-forth into an order nobody spoke it in.
  const rows = scope.db
    .prepare(
      `SELECT s.id, s.sender_email, s.what, s.why, s.action, s.priority, s.created_at,
              COALESCE(m.name, s.sender_email) AS sender_name
         FROM shares s
         LEFT JOIN members m ON m.email = s.sender_email AND m.team_id = s.team_id
        WHERE ${where}
        ORDER BY s.created_at DESC, s.rowid DESC
        LIMIT ?`,
    )
    .all(...args, limit) as Record<string, unknown>[];

  const entries = rows
    .map((r): TranscriptEntry => {
      const created_at = r.created_at as string;
      return {
        id: r.id as string,
        sender_email: r.sender_email as string,
        sender_name: r.sender_name as string,
        mine: (r.sender_email as string) === me,
        what: r.what as string,
        why: (r.why as string | null) ?? null,
        action: (r.action as string | null) ?? null,
        priority: r.priority as Priority,
        created_at,
        day: formatDay(created_at),
        time: timeOfDay(created_at),
        recipients: scope.db
          .prepare('SELECT email FROM share_recipients WHERE team_id = ? AND share_id = ? ORDER BY email')
          .all(scope.teamId, r.id as string)
          .map((x) => (x as { email: string }).email),
      };
    })
    .reverse();

  return { ok: true, value: { title, entries, total } };
}

/**
 * The transcript as text, laid out to be read rather than parsed.
 *
 * Each day gets a heading, each note a time, a speaker and an indented body,
 * so the eye can follow who said what and when without reading every line.
 * Speaker names are padded to a common width for the same reason.
 */
export function renderTranscript(t: Transcript, { withPerson }: { withPerson: boolean }): string {
  if (t.entries.length === 0) {
    return withPerson
      ? `Nothing between you and ${t.title} yet.`
      : 'Nobody has published a team-wide note yet.';
  }

  const shown = t.entries.length;
  const header =
    (withPerson ? `Conversation with ${t.title}` : 'Team feed') +
    ` — ${shown === t.total ? `${t.total} note(s)` : `latest ${shown} of ${t.total}`}, oldest first. Times are UTC.`;

  // One column width for every speaker in this transcript, so the bodies line
  // up and the eye can run down the left edge to see who is talking.
  const width = Math.min(
    Math.max(...t.entries.map((e) => (e.mine ? 3 : e.sender_name.length))),
    16,
  );

  const lines: string[] = [];
  let currentDay = '';
  for (const e of t.entries) {
    if (e.day !== currentDay) {
      if (lines.length > 0) lines.push('');
      lines.push(e.day);
      currentDay = e.day;
    }
    const who = (e.mine ? 'you' : e.sender_name).slice(0, width).padEnd(width);
    // Priority is only worth the ink when it is not the default.
    const flag = e.priority === 'fyi' ? '' : ` [${e.priority}]`;
    // Who else was on it. "to you" is not enough in a group thread, where the
    // reader needs to know the other two people saw it as well.
    const others = e.recipients.filter((r) => r !== e.sender_email);
    const cc = withPerson && others.length > 1 ? ` (also to ${others.length - 1} other(s))` : '';
    // Two leading spaces, "HH:MM", two more, the padded name, two more: the
    // detail lines hang under the message text, not under the speaker.
    const indent = ' '.repeat(2 + 5 + 2 + width + 2);
    lines.push(`  ${e.time}  ${who}  ${e.what}${flag}${cc}`);
    if (e.why) lines.push(`${indent}why: ${e.why}`);
    if (e.action) lines.push(`${indent}do:  ${e.action}`);
  }

  const more =
    shown < t.total
      ? `\n\n${t.total - shown} older note(s) not shown — ask for more with a higher limit.`
      : '';
  return `${header}\n\n${lines.join('\n')}${more}`;
}
