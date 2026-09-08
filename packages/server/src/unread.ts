import { normalizeEmail, type TeamScope } from './db.js';
import type { Priority } from './shares.js';
import { classifyRelevance, RELEVANCE_WINDOW_DAYS, type Relevance } from './relevance.js';

export const UNREAD_LIMIT = 20;

export interface DigestEntry {
  id: string;
  sender_name: string;
  sender_email: string;
  created_at: string;
  priority: Priority;
  what: string;
  /** "3 hours ago" — computed here so no client does date maths against a clock it cannot see. */
  age: string;
  /** "Monday, 08-09-2026" — the calendar day, for readers who want the date rather than the gap. */
  day: string;
  relevance: Relevance;
  /**
   * The repo this share is scoped to, or null for a team-wide share. Carried
   * through so a reader can tell WHY a colleague never saw something —
   * "it was scoped to a different repo" reads very differently from silence.
   */
  project: string | null;
  /**
   * Task 8: true when this share has share_recipients rows at all — which,
   * since AND_RECIPIENT (below) never returns a row addressed to someone
   * else, means it is true exactly when it was addressed to THIS reader.
   * Every renderer (mcp.ts's renderDigest, both hooks) uses this to print
   * "to you" instead of the recipient list: the other names on an addressed
   * share are other people's business and tell this reader nothing.
   */
  to_me: boolean;
}

export interface Digest {
  /** Unread AND still worth surfacing. This is what every caller counts. */
  total: number;
  shares: DigestEntry[];
  /**
   * Unread, not stale, not expired — but past the relevance window, so not
   * pushed at the reader. Reported rather than silently dropped: "you have 4
   * older unread shares" is information; hiding them entirely is a lie of
   * omission, and this is the count that lets every surface say so.
   */
  older: number;
}

export function expiryCutoff(nowIso: string, expiryDays: number): string {
  return new Date(Date.parse(nowIso) - expiryDays * 86_400_000).toISOString();
}

export function relevanceCutoff(nowIso: string, windowDays = RELEVANCE_WINDOW_DAYS): string {
  return new Date(Date.parse(nowIso) - windowDays * 86_400_000).toISOString();
}

// Blocking first, then newest. CASE gives blocking the smallest sort key.
const ORDER = `ORDER BY CASE s.priority WHEN 'blocking' THEN 0 ELSE 1 END, s.created_at DESC, s.id DESC`;

// Scoped on every leg: the outer share, the receipts anti-join, and the
// members join below all filter on team_id, so a team with no matching
// `WHERE` here would otherwise pull every other team's shares into this
// digest — the exact leak the design doc's Revision note calls out.
const WHERE_UNREAD = `
  WHERE s.team_id = ?
    AND s.sender_email != ?
    AND s.created_at >= ?
    AND s.stale_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM receipts r WHERE r.team_id = ? AND r.share_id = s.id AND r.member_email = ?
    )
`;

// The relevance rule, in SQL rather than applied to fetched rows, because the
// LIMIT below would otherwise be spent on old shares and starve the recent ones
// it exists to show. `blocking` keeps its claim for the whole expiry window —
// see classifyRelevance for why.
const AND_RELEVANT = `AND (s.priority = 'blocking' OR s.created_at >= ?)`;

// A share with no project is unscoped and visible to everyone; a reader with
// no project of their own (not sitting in any repo) is not narrowed at all —
// this clause is omitted entirely for them, never bound with an empty string.
// See project.ts / the design doc for why "no remote, no scope" on both ends.
const AND_PROJECT = `AND (s.project IS NULL OR s.project = ?)`;

// Task 7 (address a share to specific people): a share with no
// share_recipients rows is unaddressed and team-wide — the first EXISTS arm
// is what makes that true; drop it and every share ever created before this
// table existed (and every future team-wide share) would vanish for
// everyone. A share WITH rows is visible only to the people named in them —
// never to the sender, who WHERE_UNREAD already excludes regardless. Unlike
// AND_PROJECT this clause is never omitted: eligibility to see a share at
// all isn't optional the way narrowing-by-repo is.
const AND_RECIPIENT = `
  AND (
    NOT EXISTS (SELECT 1 FROM share_recipients sr WHERE sr.team_id = ? AND sr.share_id = s.id)
    OR EXISTS (SELECT 1 FROM share_recipients sr WHERE sr.team_id = ? AND sr.share_id = s.id AND sr.email = ?)
  )
`;

export interface UnreadOptions {
  /** Include shares past the relevance window. `list_shares` and an explicit ask do; the digest does not. */
  includeOld?: boolean;
  relevanceWindowDays?: number;
  /** The reader's own repo (normalizeProject'd). Omitted -> no narrowing at all. */
  project?: string;
}

// A SQL fragment paired with the exact positional params it consumes, so a
// clause can never end up in the SQL string while its argument lands at the
// wrong position in some other clause's slot (or vice versa) — which is
// exactly how two independent optional clauses sharing one flat `?` list
// tend to go quietly wrong. Each query below assembles its own list of
// active clauses and flattens both halves together in the same step.
interface Clause {
  sql: string;
  args: unknown[];
}

function composeClauses(...clauses: (Clause | null)[]): Clause {
  const active = clauses.filter((c): c is Clause => c !== null);
  return {
    sql: active.map((c) => c.sql).join(' '),
    args: active.flatMap((c) => c.args),
  };
}

export function getUnread(
  scope: TeamScope,
  memberEmail: string,
  nowIso: string,
  expiryDays: number,
  options: UnreadOptions = {},
): Digest {
  const me = normalizeEmail(memberEmail);
  const cutoff = expiryCutoff(nowIso, expiryDays);
  const windowDays = options.relevanceWindowDays ?? RELEVANCE_WINDOW_DAYS;
  const relevantFrom = relevanceCutoff(nowIso, windowDays);
  const includeOld = Boolean(options.includeOld);

  const base: Clause = { sql: WHERE_UNREAD, args: [scope.teamId, me, cutoff, scope.teamId, me] };
  // Each conditional clause is built right where its own bound value is
  // decided, and travels everywhere paired with that value — never as a
  // second, separately-tracked array that a query has to remember to zip
  // back in in the right order.
  const relevance: Clause | null = includeOld ? null : { sql: AND_RELEVANT, args: [relevantFrom] };
  const project: Clause | null = options.project ? { sql: AND_PROJECT, args: [options.project] } : null;
  // Not optional like `project` — always active, so never a `Clause | null`.
  // A share addressed to someone else was never unread for this reader at
  // all, exactly like a share scoped to a repo they're not in.
  const recipient: Clause = { sql: AND_RECIPIENT, args: [scope.teamId, scope.teamId, me] };

  const { sql: extraSql, args: extraArgs } = composeClauses(relevance, project, recipient);

  const { n: total } = scope.db
    .prepare(`SELECT COUNT(*) AS n FROM shares s ${base.sql} ${extraSql}`)
    .get(...base.args, ...extraArgs) as { n: number };

  // Counted separately rather than inferred from `total`, so a caller can say
  // exactly how many it is not showing without a second round trip. This is
  // relevance's own count (shares hidden ONLY by the window), so it composes
  // with `project` and `recipient` — a share outside the reader's repo, or
  // not addressed to them, was never unread for them at all, and must not
  // inflate "older" — but never with `relevance` itself, which is what
  // "older" is counting the absence of.
  const { sql: olderExtraSql, args: olderExtraArgs } = composeClauses(project, recipient);
  const { n: older } = includeOld
    ? { n: 0 }
    : (scope.db
        .prepare(
          `SELECT COUNT(*) AS n FROM shares s ${base.sql}
             AND s.priority != 'blocking' AND s.created_at < ?
             ${olderExtraSql}`,
        )
        .get(...base.args, relevantFrom, ...olderExtraArgs) as { n: number });

  const rows = scope.db
    .prepare(
      `SELECT s.id, s.sender_email, s.priority, s.what, s.created_at, s.stale_at, s.project,
              COALESCE(m.name, s.sender_email) AS sender_name,
              EXISTS (
                SELECT 1 FROM share_recipients sr WHERE sr.team_id = s.team_id AND sr.share_id = s.id
              ) AS to_me
         FROM shares s
         LEFT JOIN members m ON m.email = s.sender_email AND m.team_id = s.team_id
         ${base.sql}
         ${extraSql}
         ${ORDER}
         LIMIT ?`,
    )
    .all(...base.args, ...extraArgs, UNREAD_LIMIT) as Record<string, unknown>[];

  return {
    total,
    older,
    shares: rows.map((r) => {
      const priority = r.priority as Priority;
      const created_at = r.created_at as string;
      const freshness = classifyRelevance({
        createdAt: created_at,
        staleAt: (r.stale_at as string | null) ?? null,
        priority,
        nowIso,
        expiryDays,
        relevanceWindowDays: windowDays,
      });
      return {
        id: r.id as string,
        sender_name: r.sender_name as string,
        sender_email: r.sender_email as string,
        created_at,
        priority,
        what: r.what as string,
        age: freshness.age,
        day: freshness.day,
        relevance: freshness.relevance,
        project: (r.project as string | null) ?? null,
        to_me: Boolean(r.to_me),
      };
    }),
  };
}
