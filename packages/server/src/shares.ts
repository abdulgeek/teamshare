import { randomBytes } from 'node:crypto';
import { normalizeEmail, type Db } from './db.js';

export type Priority = 'fyi' | 'heads-up' | 'blocking';
export const PRIORITIES: readonly Priority[] = ['fyi', 'heads-up', 'blocking'];

export const CAPS = { what: 200, why: 300, action: 200, tags: 5, tagLength: 20 } as const;

export interface ShareInput {
  what: string;
  why?: string;
  action?: string;
  tags?: string[];
  priority: Priority;
}

export interface CleanShare {
  what: string;
  why: string | null;
  action: string | null;
  tags: string[];
  priority: Priority;
}

export interface ShareRow {
  id: string;
  sender_email: string;
  what: string;
  why: string | null;
  action: string | null;
  tags: string[];
  priority: Priority;
  created_at: string;
  stale_at: string | null;
}

export type ValidationResult =
  | { ok: true; value: CleanShare }
  | { ok: false; error: string };

export type ShareActionResult = { ok: true } | { ok: false; error: string };

export function validateShare(input: ShareInput): ValidationResult {
  const what = (input.what ?? '').trim();
  if (what.length === 0) return { ok: false, error: 'what is required and cannot be empty' };
  if (what.length > CAPS.what) {
    return { ok: false, error: `what is ${what.length} chars; cap is ${CAPS.what}. Tighten it to one sentence.` };
  }

  const why = input.why?.trim() ? input.why.trim() : null;
  if (why && why.length > CAPS.why) {
    return { ok: false, error: `why is ${why.length} chars; cap is ${CAPS.why}. Tighten it.` };
  }

  const action = input.action?.trim() ? input.action.trim() : null;
  if (action && action.length > CAPS.action) {
    return { ok: false, error: `action is ${action.length} chars; cap is ${CAPS.action}. Tighten it.` };
  }

  const rawTags = input.tags ?? [];
  if (rawTags.length > CAPS.tags) {
    return { ok: false, error: `tags has ${rawTags.length} entries; cap is ${CAPS.tags}.` };
  }
  const tags: string[] = [];
  for (const t of rawTags) {
    const tag = t.trim().toLowerCase();
    if (tag.length === 0) continue;
    if (tag.length > CAPS.tagLength) {
      return { ok: false, error: `tag "${tag}" is ${tag.length} chars; cap is ${CAPS.tagLength}.` };
    }
    tags.push(tag);
  }

  if (!PRIORITIES.includes(input.priority)) {
    return { ok: false, error: `priority must be one of ${PRIORITIES.join(', ')}` };
  }

  return { ok: true, value: { what, why, action, tags, priority: input.priority } };
}

function rowToShare(row: Record<string, unknown>): ShareRow {
  return {
    id: row.id as string,
    sender_email: row.sender_email as string,
    what: row.what as string,
    why: (row.why as string | null) ?? null,
    action: (row.action as string | null) ?? null,
    tags: JSON.parse((row.tags as string) || '[]') as string[],
    priority: row.priority as Priority,
    created_at: row.created_at as string,
    stale_at: (row.stale_at as string | null) ?? null,
  };
}

export function createShare(
  db: Db,
  senderEmail: string,
  input: ShareInput,
  nowIso: string,
): { id: string; notified: number } {
  const result = validateShare(input);
  if (!result.ok) throw new Error(result.error);

  const sender = normalizeEmail(senderEmail);
  const id = `shr_${randomBytes(6).toString('hex')}`;
  const { what, why, action, tags, priority } = result.value;

  db.prepare(
    `INSERT INTO shares (id, sender_email, what, why, action, tags, priority, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, sender, what, why, action, JSON.stringify(tags), priority, nowIso);

  const row = db
    .prepare('SELECT COUNT(*) AS n FROM members WHERE email != ?')
    .get(sender) as { n: number };

  return { id, notified: row.n };
}

export function getShare(db: Db, id: string): ShareRow | undefined {
  const row = db.prepare('SELECT * FROM shares WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToShare(row) : undefined;
}

export function listShares(
  db: Db,
  opts: { tag?: string; sender?: string; limit?: number },
): ShareRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (opts.sender) {
    clauses.push('sender_email = ?');
    params.push(normalizeEmail(opts.sender));
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);

  const rows = db
    .prepare(`SELECT * FROM shares ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...params, limit) as Record<string, unknown>[];

  const shares = rows.map(rowToShare);
  // Tag filtering happens in JS because tags are stored as a JSON array.
  const tag = opts.tag?.trim().toLowerCase();
  return tag ? shares.filter((s) => s.tags.includes(tag)) : shares;
}

// Hard delete, author only. Removes the share AND every receipt for it, so
// it disappears from unread/list_shares/receipts/read_share as if it had
// never been sent — for the case where a share leaked something sensitive
// or was simply wrong, where "hide it" is not good enough.
export function retractShare(db: Db, id: string, callerEmail: string): ShareActionResult {
  const share = getShare(db, id);
  if (!share) return { ok: false, error: `no share with id ${id}` };
  if (share.sender_email !== normalizeEmail(callerEmail)) {
    return { ok: false, error: 'only the author can retract a share' };
  }
  db.prepare('DELETE FROM receipts WHERE share_id = ?').run(id);
  db.prepare('DELETE FROM shares WHERE id = ?').run(id);
  return { ok: true };
}

// Soft, author only. Sets stale_at so the share drops out of `unread` for
// everyone but stays in history via listShares/getShare. Idempotent: marking
// an already-stale share leaves its original stale_at untouched.
export function markStale(
  db: Db,
  id: string,
  callerEmail: string,
  nowIso: string,
): ShareActionResult {
  const share = getShare(db, id);
  if (!share) return { ok: false, error: `no share with id ${id}` };
  if (share.sender_email !== normalizeEmail(callerEmail)) {
    return { ok: false, error: 'only the author can mark a share stale' };
  }
  if (share.stale_at) return { ok: true };
  db.prepare('UPDATE shares SET stale_at = ? WHERE id = ?').run(nowIso, id);
  return { ok: true };
}
