import { randomBytes } from 'node:crypto';
import { normalizeEmail, type TeamScope } from './db.js';
import { validateEmailAddress } from './http.js';
import { PROJECT_KEY_SHAPE } from './project.js';

export type Priority = 'fyi' | 'heads-up' | 'blocking';
export const PRIORITIES: readonly Priority[] = ['fyi', 'heads-up', 'blocking'];

export const CAPS = {
  what: 200,
  why: 300,
  action: 200,
  tags: 5,
  tagLength: 20,
  project: 200,
  recipients: 20,
} as const;

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
  /**
   * The people this share is addressed to. OMITTED or `[]` means the whole
   * team — see unread.ts's AND_RECIPIENT clause and ShareRow.recipients below
   * for why no recipient rows must be read as "everyone", not "nobody".
   *
   * A list the author actually wrote is different: it is validated like every
   * other field (validateShare below — shape, cap, no blanks) and resolved
   * against the team roster before anything is written. A non-empty list that
   * would resolve to nobody — all blanks, only the sender, or an address
   * nobody on the team holds — is an ERROR, never a silent broadcast to the
   * whole team. Addresses are normalised the same way every other email in
   * this codebase is (normalizeEmail) and deduplicated; the sender is always
   * dropped, since a share never notifies its own author.
   */
  recipients?: string[];
}

export interface CleanShare {
  what: string;
  why: string | null;
  action: string | null;
  tags: string[];
  priority: Priority;
  project: string | null;
  /**
   * Normalised, deduplicated, in the order the author wrote them. Empty means
   * the author named nobody (omitted or `[]`) — the whole team. It never means
   * "the author named people and none of them survived validation": that is an
   * error, returned as one, never a value here.
   */
  recipients: string[];
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
  /** Empty means the whole team. See ShareInput.recipients. */
  recipients: string[];
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

  // Recipients are validated HERE, with every other field, rather than being
  // waved through into createShare — an addressed share is a privacy control,
  // and unvalidated input is exactly what let a list the author wrote collapse
  // to nothing and broadcast to the whole team. Three rules:
  //
  //   1. a count cap, like tags;
  //   2. every entry is a real address — the same check invites go through
  //      (http.ts's validateEmailAddress), never a second hand-rolled regex;
  //   3. a blank entry is rejected outright rather than filtered away, because
  //      filtering is what silently turns ['   '] into "the whole team".
  //
  // An omitted list and `[]` both arrive here as an empty array and leave as
  // one: that IS the team-wide case, and the only one.
  const rawRecipients = input.recipients ?? [];
  if (!Array.isArray(rawRecipients)) {
    return { ok: false, error: 'recipients must be a list of email addresses' };
  }
  if (rawRecipients.length > CAPS.recipients) {
    return { ok: false, error: `recipients has ${rawRecipients.length} entries; cap is ${CAPS.recipients}.` };
  }
  const recipients: string[] = [];
  for (const raw of rawRecipients) {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      return {
        ok: false,
        error:
          `recipients contains an empty entry (${JSON.stringify(raw) ?? String(raw)}). ` +
          'Name a real address, or omit recipients entirely to reach the whole team.',
      };
    }
    // The label carries the offending address into the message, so an error
    // says which entry is wrong rather than that "one of them" is.
    const check = validateEmailAddress(raw, `recipient "${raw.trim().slice(0, 60)}"`);
    if (!check.ok) return { ok: false, error: check.error };
    if (!recipients.includes(check.value)) recipients.push(check.value);
  }

  return {
    ok: true,
    value: { what, why, action, tags, priority: input.priority, project, recipients },
  };
}

/** A SQL fragment paired with exactly the positional params it consumes. */
export interface SqlClause {
  sql: string;
  args: unknown[];
}

/**
 * "May this person see this share at all?" — the ONE definition of that
 * question, expressed in SQL so that every read path inherits it instead of
 * re-deriving it.
 *
 * Three ways to qualify, and only three:
 *   1. you wrote it (an author can always see their own share);
 *   2. it has no share_recipients rows — unaddressed, i.e. the whole team.
 *      This arm is what keeps every team-wide share (and every share created
 *      before that table existed) visible to everyone;
 *   3. you are one of the people it was addressed to.
 *
 * Anything else and the share does not exist as far as you are concerned:
 * getShare returns undefined, so `read_share`/`receipts` answer with the very
 * same "no share with id X" a foreign team's share already gets, and
 * listShares simply omits it. That is deliberate and is NOT a third state —
 * "you are not allowed to read this share" would confirm the share exists,
 * which is most of what an addressed share is trying not to say.
 *
 * Why here and not in mcp.ts: unread.ts's AND_RECIPIENT was a DELIVERY filter
 * on one surface, and every other surface simply forgot to apply anything.
 * A gate that lives in the accessor cannot be forgotten by the next tool that
 * reads a share — it has to pass a viewer to get a row at all.
 *
 * team_id is bound explicitly on both recipient legs, like every other query
 * in this codebase, rather than being inherited via the outer row's team_id.
 */
export function visibleToClause(scope: TeamScope, viewerEmail: string, alias = 's'): SqlClause {
  const me = normalizeEmail(viewerEmail);
  return {
    sql: `(
      ${alias}.sender_email = ?
      OR NOT EXISTS (
        SELECT 1 FROM share_recipients sr WHERE sr.team_id = ? AND sr.share_id = ${alias}.id
      )
      OR EXISTS (
        SELECT 1 FROM share_recipients sr
         WHERE sr.team_id = ? AND sr.share_id = ${alias}.id AND sr.email = ?
      )
    )`,
    args: [me, scope.teamId, scope.teamId, me],
  };
}

function rowToShare(row: Record<string, unknown>, recipients: string[]): ShareRow {
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
    recipients,
  };
}

// Scoped on both legs, like every other query in this file — a share_id is
// globally unique, but team_id is still bound so a foreign team's identically
// -shaped row could never be pulled in even if that stopped being true.
function getRecipientEmails(scope: TeamScope, shareId: string): string[] {
  const rows = scope.db
    .prepare('SELECT email FROM share_recipients WHERE team_id = ? AND share_id = ? ORDER BY email')
    .all(scope.teamId, shareId) as { email: string }[];
  return rows.map((r) => r.email);
}

// The recipients a share will actually be written with: the validated
// addresses minus the sender, resolved against this team's roster. Every way
// this can fail throws HERE — before createShare writes anything — because a
// failure between the share row and its recipient rows leaves a share with no
// recipients, and "no recipient rows" means the whole team (unread.ts's
// AND_RECIPIENT). Failing open in that direction is a privacy bug, not a
// glitch, so the only shape allowed is: resolve everything, then write.
//
// A recipient who is not a current member is an ERROR, not a silently dropped
// entry. Two reasons. First, it keeps one invariant true in the database:
// every share_recipients row names someone the roster knows, so `notified`
// (counted here) and getReceipts' expected-reader set (counted from `members`)
// can never disagree — the two cannot drift apart because neither has to
// remember to intersect. Second, the alternative is silent: a typo'd address
// would publish a share addressed to nobody, the author would be told it was
// delivered, and no one would ever read it. An error naming the address is
// recoverable; a share into the void is not.
function resolveRecipients(scope: TeamScope, sender: string, addressed: string[]): string[] {
  // Omitted or `[]` — the author named nobody, so this is a team-wide share.
  // The ONLY path to zero recipient rows.
  if (addressed.length === 0) return [];

  const withoutSender = addressed.filter((email) => email !== sender);
  if (withoutSender.length === 0) {
    throw new Error(
      'recipients names only you, and a share never notifies its own author — so this would ' +
        'reach nobody. Name a teammate, or omit recipients entirely to reach the whole team.',
    );
  }

  // Scoped on team_id like every other members read in this codebase: an
  // address that is on some other team is not on this one.
  const placeholders = withoutSender.map(() => '?').join(', ');
  const known = new Set(
    (
      scope.db
        .prepare(`SELECT email FROM members WHERE team_id = ? AND email IN (${placeholders})`)
        .all(scope.teamId, ...withoutSender) as { email: string }[]
    ).map((r) => r.email),
  );

  const unknown = withoutSender.filter((email) => !known.has(email));
  if (unknown.length > 0) {
    // "Not a members row" lumps together two different situations, and the
    // controller ruling is that the error must not: an address nobody ever
    // invited (a typo, or genuinely not on this team) needs "check it or
    // invite them"; an address someone DID invite — a live member_tokens row,
    // the same table listRoster (db.ts) reads to report "invited, not yet
    // active" — but who has never actually authenticated needs "they need to
    // connect once", which is a completely different, and completely
    // actionable, next step. Split on membership in member_tokens (any row,
    // not just an unrevoked one — being invited at all is what distinguishes
    // "unknown" from "known but not yet connected") to tell them apart.
    const invitedPlaceholders = unknown.map(() => '?').join(', ');
    const invited = new Set(
      (
        scope.db
          .prepare(`SELECT DISTINCT email FROM member_tokens WHERE team_id = ? AND email IN (${invitedPlaceholders})`)
          .all(scope.teamId, ...unknown) as { email: string }[]
      ).map((r) => r.email),
    );
    const neverInvited = unknown.filter((email) => !invited.has(email));
    const notYetConnected = unknown.filter((email) => invited.has(email));

    const parts: string[] = [];
    if (neverInvited.length > 0) {
      parts.push(
        `not on this team: ${neverInvited.join(', ')}. Check the address — a typo here would ` +
          'address the share to nobody — or invite them (`teamshare invite <email>`) before ' +
          'addressing a share to them.',
      );
    }
    if (notYetConnected.length > 0) {
      parts.push(
        `invited but not yet connected: ${notYetConnected.join(', ')}. They need to connect once ` +
          '(open their assistant so it authenticates against this server) before you can address a ' +
          'share to them directly — a team-wide share still reaches them in the meantime.',
      );
    }
    throw new Error(parts.join(' '));
  }
  return withoutSender;
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
  const { what, why, action, tags, priority, project, recipients: addressed } = result.value;

  // Resolved BEFORE the first write, so nothing this can throw about is able
  // to leave a committed share behind. See resolveRecipients.
  const recipients = resolveRecipients(scope, sender, addressed);

  const insertShare = scope.db.prepare(
    `INSERT INTO shares (id, team_id, sender_email, what, why, action, tags, priority, created_at, project)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertRecipient = scope.db.prepare(
    `INSERT INTO share_recipients (team_id, share_id, email) VALUES (?, ?, ?)`,
  );

  // ONE transaction over the share and its recipient rows. A share that
  // committed while its recipient rows did not is a share addressed to one
  // person that the whole team can read; there is no partial state of this
  // write that is safe to leave behind, so there is none.
  const write = scope.db.transaction(() => {
    insertShare.run(id, scope.teamId, sender, what, why, action, JSON.stringify(tags), priority, nowIso, project);
    for (const email of recipients) insertRecipient.run(scope.teamId, id, email);
  });
  write();

  // "notified" means "the people this reaches". For an addressed share that
  // is the recipient list, which resolveRecipients has already proved to be
  // sender-free and entirely made of current members — so this is the same
  // set getReceipts will report on, not a raw count of what the caller typed.
  // For an unaddressed share it is the whole team minus the sender, exactly
  // as before.
  const notified =
    recipients.length > 0
      ? recipients.length
      : (
          scope.db
            .prepare('SELECT COUNT(*) AS n FROM members WHERE team_id = ? AND email != ?')
            .get(scope.teamId, sender) as { n: number }
        ).n;

  return { id, notified };
}

/**
 * `viewerEmail` is REQUIRED, and has no default. A default here would mean
 * "no filtering", and an accessor that silently returns everything when a
 * caller forgets an argument is precisely how an addressed share ended up
 * readable by the whole team. A caller that genuinely has no viewer has no
 * business reading a share.
 *
 * Returns undefined both for a share that does not exist (or belongs to
 * another team) and for one addressed to other people — same answer, no
 * existence oracle. See visibleToClause.
 */
export function getShare(scope: TeamScope, id: string, viewerEmail: string): ShareRow | undefined {
  const visible = visibleToClause(scope, viewerEmail);
  const row = scope.db
    .prepare(`SELECT s.* FROM shares s WHERE s.team_id = ? AND s.id = ? AND ${visible.sql}`)
    .get(scope.teamId, id, ...visible.args) as Record<string, unknown> | undefined;
  return row ? rowToShare(row, getRecipientEmails(scope, id)) : undefined;
}

/** `viewerEmail` is required and undefaulted, for the reason getShare's is. */
export function listShares(
  scope: TeamScope,
  viewerEmail: string,
  opts: { tag?: string; sender?: string; limit?: number; includeIrrelevant?: boolean },
): ShareRow[] {
  // team_id is seeded into the WHERE clause itself, never appended to the
  // optional predicate list — so a caller passing no filters at all still
  // gets `WHERE team_id = ?`, never a clause-free scan of every team's shares.
  const clauses: string[] = ['s.team_id = ?'];
  const params: unknown[] = [scope.teamId];

  // Seeded with team_id, and now with visibility too — both before any
  // optional predicate, so no combination of caller-supplied filters can
  // produce a query missing either one. A share addressed to other people is
  // not "hidden from the listing": it is not this reader's share to browse.
  const visible = visibleToClause(scope, viewerEmail);
  clauses.push(visible.sql);
  params.push(...visible.args);

  // A share its author marked irrelevant leaves the history too, not just the
  // digest. "No longer relevant" that still turns up in every browse is not a
  // useful state — it just moves the noise. The author can still find their
  // own with includeIrrelevant, which is what makes the mark reversible in
  // practice rather than a one-way door.
  if (!opts.includeIrrelevant) clauses.push('s.stale_at IS NULL');

  if (opts.sender) {
    clauses.push('s.sender_email = ?');
    params.push(normalizeEmail(opts.sender));
  }
  const where = `WHERE ${clauses.join(' AND ')}`;
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);

  const rows = scope.db
    .prepare(`SELECT s.* FROM shares s ${where} ORDER BY s.created_at DESC, s.id DESC LIMIT ?`)
    .all(...params, limit) as Record<string, unknown>[];

  // One extra query per row for its recipients. Lists here are capped at 200
  // (see `limit` above), so this stays a handful of indexed point lookups,
  // not an unbounded fan-out.
  const shares = rows.map((row) => rowToShare(row, getRecipientEmails(scope, row.id as string)));
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
  // The caller is the viewer: an author can always see their own share, so
  // passing the caller here costs a legitimate retract nothing, and a share
  // addressed to other people is `undefined` to everyone else — which is the
  // answer they were going to get from the author check anyway, one step
  // earlier and without confirming the id exists.
  const share = getShare(scope, id, callerEmail);
  // getShare is scoped in SQL, so a foreign team's share id, a genuinely
  // nonexistent one, and one addressed to other people all land here as
  // `undefined` — same message every time. The author-mismatch message below
  // is therefore unreachable for any of them (it would otherwise confirm the
  // id exists somewhere).
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
  const share = getShare(scope, id, callerEmail);
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
