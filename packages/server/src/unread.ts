import { normalizeEmail, type TeamScope } from './db.js';
import type { Priority } from './shares.js';

export const UNREAD_LIMIT = 20;

export interface DigestEntry {
  id: string;
  sender_name: string;
  sender_email: string;
  created_at: string;
  priority: Priority;
  what: string;
}

export interface Digest {
  total: number;
  shares: DigestEntry[];
}

export function expiryCutoff(nowIso: string, expiryDays: number): string {
  return new Date(Date.parse(nowIso) - expiryDays * 86_400_000).toISOString();
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

export function getUnread(
  scope: TeamScope,
  memberEmail: string,
  nowIso: string,
  expiryDays: number,
): Digest {
  const me = normalizeEmail(memberEmail);
  const cutoff = expiryCutoff(nowIso, expiryDays);

  const { n: total } = scope.db
    .prepare(`SELECT COUNT(*) AS n FROM shares s ${WHERE_UNREAD}`)
    .get(scope.teamId, me, cutoff, scope.teamId, me) as { n: number };

  const rows = scope.db
    .prepare(
      `SELECT s.id, s.sender_email, s.priority, s.what, s.created_at,
              COALESCE(m.name, s.sender_email) AS sender_name
         FROM shares s
         LEFT JOIN members m ON m.email = s.sender_email AND m.team_id = s.team_id
         ${WHERE_UNREAD}
         ${ORDER}
         LIMIT ?`,
    )
    .all(scope.teamId, me, cutoff, scope.teamId, me, UNREAD_LIMIT) as Record<string, unknown>[];

  return {
    total,
    shares: rows.map((r) => ({
      id: r.id as string,
      sender_name: r.sender_name as string,
      sender_email: r.sender_email as string,
      created_at: r.created_at as string,
      priority: r.priority as Priority,
      what: r.what as string,
    })),
  };
}
