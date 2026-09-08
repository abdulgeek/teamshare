import { randomBytes } from 'node:crypto';
import { normalizeEmail, type TeamScope } from './db.js';
import { PROJECT_KEY_SHAPE } from './project.js';

export type Priority = 'fyi' | 'heads-up' | 'blocking';
export const PRIORITIES: readonly Priority[] = ['fyi', 'heads-up', 'blocking'];

export const CAPS = { what: 200, why: 300, action: 200, tags: 5, tagLength: 20, project: 200 } as const;

export interface ShareInput {
  what: string;
  why?: string;
  action?: string;
  tags?: string[];
  priority: Priority;
  /**
   * A normalised git remote (see project.ts's normalizeProject), naming the
   * one repository this share is about. Opt-in only — never inferred from
   * the publisher's cwd here; see the design doc's reasoning ("I'm out sick
   * today" published from inside a repo is not about that repo).
   */
  project?: string;
}

export interface CleanShare {
  what: string;
  why: string | null;
  action: string | null;
  tags: string[];
  priority: Priority;
  project: string | null;
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
  project: string | null;
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

  // Not re-normalised here: the caller is expected to have already run the
  // remote through normalizeProject (project.ts). This DOES still validate
  // the shape and cap the length, though — trusting a caller to have
  // pre-normalized was harmless while nothing could set this field, and
  // became a real gap the moment a client (the `share` tool) could put
  // arbitrary text here. A value that does not look like normalizeProject's
  // output is rejected outright rather than stored as a scope nothing will
  // ever match.
  const projectRaw = input.project?.trim() ? input.project.trim() : null;
  let project: string | null = null;
  if (projectRaw) {
    if (projectRaw.length > CAPS.project) {
      return { ok: false, error: `project is ${projectRaw.length} chars; cap is ${CAPS.project}.` };
    }
    if (!PROJECT_KEY_SHAPE.test(projectRaw)) {
      return {
        ok: false,
        error:
          `project "${projectRaw}" does not look like a normalized git remote ` +
          '(expected host/owner/repo, e.g. "github.com/acme/api").',
      };
    }
    project = projectRaw;
  }

  return { ok: true, value: { what, why, action, tags, priority: input.priority, project } };
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
    project: (row.project as string | null) ?? null,
  };
}

export function createShare(
  scope: TeamScope,
  senderEmail: string,
  input: ShareInput,
  nowIso: string,
): { id: string; notified: number } {
  const result = validateShare(input);
  if (!result.ok) throw new Error(result.error);

  const sender = normalizeEmail(senderEmail);
  const id = `shr_${randomBytes(6).toString('hex')}`;
  const { what, why, action, tags, priority, project } = result.value;

  scope.db
    .prepare(
      `INSERT INTO shares (id, team_id, sender_email, what, why, action, tags, priority, created_at, project)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, scope.teamId, sender, what, why, action, JSON.stringify(tags), priority, nowIso, project);

  const row = scope.db
    .prepare('SELECT COUNT(*) AS n FROM members WHERE team_id = ? AND email != ?')
    .get(scope.teamId, sender) as { n: number };

  return { id, notified: row.n };
}

export function getShare(scope: TeamScope, id: string): ShareRow | undefined {
  const row = scope.db
    .prepare('SELECT * FROM shares WHERE team_id = ? AND id = ?')
    .get(scope.teamId, id) as Record<string, unknown> | undefined;
  return row ? rowToShare(row) : undefined;
}

export function listShares(
  scope: TeamScope,
  opts: { tag?: string; sender?: string; limit?: number; includeIrrelevant?: boolean },
): ShareRow[] {
  // team_id is seeded into the WHERE clause itself, never appended to the
  // optional predicate list — so a caller passing no filters at all still
  // gets `WHERE team_id = ?`, never a clause-free scan of every team's shares.
  const clauses: string[] = ['team_id = ?'];
  const params: unknown[] = [scope.teamId];

  // A share its author marked irrelevant leaves the history too, not just the
  // digest. "No longer relevant" that still turns up in every browse is not a
  // useful state — it just moves the noise. The author can still find their
  // own with includeIrrelevant, which is what makes the mark reversible in
  // practice rather than a one-way door.
  if (!opts.includeIrrelevant) clauses.push('stale_at IS NULL');

  if (opts.sender) {
    clauses.push('sender_email = ?');
    params.push(normalizeEmail(opts.sender));
  }
  const where = `WHERE ${clauses.join(' AND ')}`;
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);

  const rows = scope.db
    .prepare(`SELECT * FROM shares ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...params, limit) as Record<string, unknown>[];

  const shares = rows.map(rowToShare);
  // Tag filtering happens in JS because tags are stored as a JSON array.
  const tag = opts.tag?.trim().toLowerCase();
  return tag ? shares.filter((s) => s.tags.includes(tag)) : shares;
}

// Hard delete, author only. Removes the share; the receipts FK's
// ON DELETE CASCADE removes every receipt for it, so it disappears from
// unread/list_shares/receipts/read_share as if it had never been sent — for
// the case where a share leaked something sensitive or was simply wrong,
// where "hide it" is not good enough.
export function retractShare(scope: TeamScope, id: string, callerEmail: string): ShareActionResult {
  const share = getShare(scope, id);
  // getShare is scoped in SQL, so a foreign team's share id and a genuinely
  // nonexistent one both land here as `undefined` — same message either way.
  // The author-mismatch message below is therefore unreachable for another
  // team's share (it would otherwise confirm the id exists somewhere).
  if (!share) return { ok: false, error: `no share with id ${id}` };
  if (share.sender_email !== normalizeEmail(callerEmail)) {
    return { ok: false, error: 'only the author can retract a share' };
  }
  scope.db.prepare('DELETE FROM shares WHERE team_id = ? AND id = ?').run(scope.teamId, id);
  return { ok: true };
}

// Soft, author only. Sets stale_at, which withdraws the share from the team
// entirely: it leaves `unread`, it leaves `list_shares`, and `read_share`
// stops returning its body to anyone but the author. The row survives, so the
// author can still see what they withdrew and the receipts stay auditable —
// that is the whole difference from `retract`, which deletes.
//
// Idempotent: marking an already-stale share leaves its original stale_at
// untouched.
export function markStale(
  scope: TeamScope,
  id: string,
  callerEmail: string,
  nowIso: string,
): ShareActionResult {
  const share = getShare(scope, id);
  if (!share) return { ok: false, error: `no share with id ${id}` };
  if (share.sender_email !== normalizeEmail(callerEmail)) {
    return { ok: false, error: 'only the author can mark a share stale' };
  }
  if (share.stale_at) return { ok: true };
  scope.db
    .prepare('UPDATE shares SET stale_at = ? WHERE team_id = ? AND id = ?')
    .run(nowIso, scope.teamId, id);
  return { ok: true };
}
