import { listMembers, normalizeEmail, type TeamScope } from './db.js';
import { getShare, visibleToClause } from './shares.js';
import { expiryCutoff } from './unread.js';

export type ReceiptStatus = 'viewed' | 'dismissed';

// A member who has never opened or dismissed a share, paired with when they
// were last seen at all — the fact that distinguishes "hasn't read it yet"
// from "hasn't connected in two weeks". members.last_seen is maintained on
// every authenticated request (see http.ts touchMember), so this is always
// current as of this member's last contact with the server.
export interface UnseenMember {
  email: string;
  last_seen: string;
}

export interface ReceiptSummary {
  share_id: string;
  expired: boolean;
  stale: boolean;
  viewed: string[];
  dismissed: string[];
  unseen: UnseenMember[];
}

// Ownership AND visibility are checked in the same statement as the write —
// the INSERT's source rows are gated by `WHERE EXISTS (... shares WHERE
// team_id = ? AND id = ? AND <visible to this member>)` — rather than
// trusting a separate, earlier check by the caller. If the share belongs to
// another team, doesn't exist at all, or is addressed to people this member
// is not among, the SELECT contributes zero rows, nothing is written, and
// this reports false; a caller that forgot to check `getShare` first still
// cannot record a cross-team OR a can't-see-it receipt.
//
// The visibility half is not decoration. `read_share` used to record a
// `viewed` receipt for anyone who asked, so a non-recipient reading an
// addressed share both learned its contents and wrote a row into the
// author's receipt data for a share that person was never sent. No receipt
// may exist for someone who cannot see the share, and the cheapest place to
// make that true for every present and future caller is inside the write
// itself.
export function recordReceipt(
  scope: TeamScope,
  shareId: string,
  memberEmail: string,
  status: ReceiptStatus,
  nowIso: string,
): boolean {
  const email = normalizeEmail(memberEmail);
  const visible = visibleToClause(scope, email);
  // 'viewed' outranks 'dismissed': a later dismissal must not erase that the
  // member actually read the share.
  const info = scope.db
    .prepare(
      `INSERT INTO receipts (team_id, share_id, member_email, status, at)
       SELECT ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM shares s WHERE s.team_id = ? AND s.id = ? AND ${visible.sql}
       )
       ON CONFLICT(team_id, share_id, member_email) DO UPDATE SET
         status = CASE WHEN receipts.status = 'viewed' THEN 'viewed' ELSE excluded.status END,
         at     = excluded.at`,
    )
    .run(scope.teamId, shareId, email, status, nowIso, scope.teamId, shareId, ...visible.args);
  return info.changes > 0;
}

// `viewerEmail` is required and has no default, exactly like getShare's: the
// caller must be the author or one of the recipients. For an unaddressed
// (team-wide) share every member qualifies, so this is unchanged for the
// common case. For an addressed one, a bystander gets `undefined` — the same
// answer a nonexistent id gets — rather than the recipient list, which
// `receipts` used to print to anyone who asked ("Not yet seen by:
// sam@team.com" told the whole team who a confidential share went to, and
// list_shares handed them the id to ask about).
export function getReceipts(
  scope: TeamScope,
  shareId: string,
  viewerEmail: string,
  nowIso: string,
  expiryDays: number,
): ReceiptSummary | undefined {
  const share = getShare(scope, shareId, viewerEmail);
  if (!share) return undefined;

  const rows = scope.db
    .prepare('SELECT member_email, status FROM receipts WHERE team_id = ? AND share_id = ?')
    .all(scope.teamId, shareId) as { member_email: string; status: ReceiptStatus }[];
  const byEmail = new Map(rows.map((r) => [r.member_email, r.status]));

  const viewed: string[] = [];
  const dismissed: string[] = [];
  const unseen: UnseenMember[] = [];

  // An addressed share's "expected reader" set is the people it was sent
  // to, not the whole team — reporting every other member as "not yet seen
  // by" would be wrong for a share only Sam was ever meant to read. An
  // unaddressed (team-wide) share keeps the original denominator: every
  // current member, same as before Task 7.
  //
  // This set is also what createShare counts as `notified`, and the two
  // cannot disagree: createShare refuses to address a share to anyone who is
  // not a member (see resolveRecipients), so every share_recipients row names
  // someone the roster knew at publish time. The one way this set can later
  // be smaller is a member who has since been REMOVED from the team — which
  // is the honest answer, not a drift: they are not going to read it.
  const recipientSet = share.recipients.length > 0 ? new Set(share.recipients) : null;
  const expectedReaders = recipientSet
    ? listMembers(scope).filter((m) => recipientSet.has(m.email))
    : listMembers(scope);

  for (const member of expectedReaders) {
    if (member.email === share.sender_email) continue; // sender never appears
    const status = byEmail.get(member.email);
    if (status === 'viewed') viewed.push(member.email);
    else if (status === 'dismissed') dismissed.push(member.email);
    else unseen.push({ email: member.email, last_seen: member.last_seen });
  }

  return {
    share_id: shareId,
    expired: share.created_at < expiryCutoff(nowIso, expiryDays),
    stale: Boolean(share.stale_at),
    viewed,
    dismissed,
    unseen,
  };
}
