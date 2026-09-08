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
  relevance: Relevance;
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

export interface UnreadOptions {
  /** Include shares past the relevance window. `list_shares` and an explicit ask do; the digest does not. */
  includeOld?: boolean;
  relevanceWindowDays?: number;
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

  const baseArgs = [scope.teamId, me, cutoff, scope.teamId, me];
  const relevanceArgs = includeOld ? [] : [relevantFrom];

  const { n: total } = scope.db
    .prepare(`SELECT COUNT(*) AS n FROM shares s ${WHERE_UNREAD} ${includeOld ? '' : AND_RELEVANT}`)
    .get(...baseArgs, ...relevanceArgs) as { n: number };

  // Counted separately rather than inferred from `total`, so a caller can say
  // exactly how many it is not showing without a second round trip.
  const { n: older } = includeOld
    ? { n: 0 }
    : (scope.db
        .prepare(
          `SELECT COUNT(*) AS n FROM shares s ${WHERE_UNREAD} AND s.priority != 'blocking' AND s.created_at < ?`,
        )
        .get(...baseArgs, relevantFrom) as { n: number });

  const rows = scope.db
    .prepare(
      `SELECT s.id, s.sender_email, s.priority, s.what, s.created_at, s.stale_at,
              COALESCE(m.name, s.sender_email) AS sender_name
         FROM shares s
         LEFT JOIN members m ON m.email = s.sender_email AND m.team_id = s.team_id
         ${WHERE_UNREAD}
         ${includeOld ? '' : AND_RELEVANT}
         ${ORDER}
         LIMIT ?`,
    )
    .all(...baseArgs, ...relevanceArgs, UNREAD_LIMIT) as Record<string, unknown>[];

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
        relevance: freshness.relevance,
      };
    }),
  };
}
