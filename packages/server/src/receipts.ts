import { listMembers, normalizeEmail, type Db } from './db.js';
import { getShare } from './shares.js';
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

export function recordReceipt(
  db: Db,
  shareId: string,
  memberEmail: string,
  status: ReceiptStatus,
  nowIso: string,
): void {
  const email = normalizeEmail(memberEmail);
  // 'viewed' outranks 'dismissed': a later dismissal must not erase that the
  // member actually read the share.
  db.prepare(
    `INSERT INTO receipts (share_id, member_email, status, at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(share_id, member_email) DO UPDATE SET
       status = CASE WHEN receipts.status = 'viewed' THEN 'viewed' ELSE excluded.status END,
       at     = excluded.at`,
  ).run(shareId, email, status, nowIso);
}

export function getReceipts(
  db: Db,
  shareId: string,
  nowIso: string,
  expiryDays: number,
): ReceiptSummary | undefined {
  const share = getShare(db, shareId);
  if (!share) return undefined;

  const rows = db
    .prepare('SELECT member_email, status FROM receipts WHERE share_id = ?')
    .all(shareId) as { member_email: string; status: ReceiptStatus }[];
  const byEmail = new Map(rows.map((r) => [r.member_email, r.status]));

  const viewed: string[] = [];
  const dismissed: string[] = [];
  const unseen: UnseenMember[] = [];

  for (const member of listMembers(db)) {
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
