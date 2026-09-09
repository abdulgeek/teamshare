import { normalizeEmail, type TeamScope } from './db.js';
import { visibleToClause, type Priority } from './shares.js';
import { classifyRelevance, type Relevance } from './relevance.js';
import { expiryCutoff } from './unread.js';

/**
 * "Has anyone said anything about EN-2022?" — asked automatically, before the
 * reader spends a token on it.
 *
 * This is the one read path in teamshare that is about RETRIEVAL rather than
 * ARRIVAL. `unread` answers "what have I not seen"; a share the reader read
 * yesterday and forgot is gone from it forever, and that is exactly the share
 * this has to bring back. So the three narrowings the digest applies —
 * read state, the relevance window, and the reader's current repo — are all
 * deliberately absent here. See
 * docs/superpowers/specs/2026-09-09-teamshare-mentions-design.md.
 *
 * What is NOT absent, and must never become so:
 *   - visibleToClause. A share addressed to other people must not become
 *     discoverable just because the reader guessed a ticket key. Guessing keys
 *     is easy; that is the whole point of this feature.
 *   - `stale_at IS NULL`. A withdrawn share is the author saying it no longer
 *     applies, and surfacing one here would be worse than saying nothing —
 *     it would send the reader chasing a block that was already lifted.
 *   - the hard expiry cutoff, so this cannot resurrect notes every other
 *     surface has already retired.
 */

/** Deliberately small. A prompt naming more identifiers than this is a paste, not a question. */
export const MAX_KEYS = 5;

/**
 * A generous ceiling on rows pulled per key before the precise match below
 * runs. The SQL `LIKE` is only a coarse prefilter, so this must be larger
 * than what any caller will show.
 */
const SQL_CANDIDATE_LIMIT = 50;

/** What a caller may send. Anything else is a 400, never a silent broadened search. */
export const MENTION_KEY_SHAPE =
  /^(?:[A-Z][A-Z0-9]{1,9}-\d{1,6}|[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*#\d{1,6})$/;

/**
 * The two identifier kinds, kept apart because they need different boundary
 * rules below. A ticket key is bounded by alphanumerics on both sides; a repo
 * reference also has to reject a longer owner name on the left, which its
 * `/` and `#` would otherwise let through.
 */
function isRepoRef(key: string): boolean {
  return key.includes('#');
}

/**
 * `LIKE` cannot express "not part of a longer token", and that gap is not
 * cosmetic: `%EN-2022%` matches `GEN-2022` and `EN-20221`, either of which
 * would produce a warning about a ticket nobody mentioned. So SQL filters
 * coarsely and this filters exactly — the same split `listShares` uses for
 * tags, for the same reason.
 */
export function keyMatcher(key: string): RegExp {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Left guard: `/` and the separators are part of a repo ref, so a repo ref
  // must additionally reject `myacme/api#412` when asked for `acme/api#412`.
  const left = isRepoRef(key) ? '(?<![A-Za-z0-9._/-])' : '(?<![A-Za-z0-9])';
  // Right guard is alphanumerics only, so a key at the end of a sentence
  // ("blocked on EN-2022.") still matches while `EN-20221` does not.
  return new RegExp(`${left}${escaped}(?![A-Za-z0-9])`, 'i');
}

/**
 * Normalises what a caller sent into the one canonical form matching uses:
 * ticket keys upper-case, repo references lower-case. Returns the accepted
 * keys, deduplicated and capped; anything not shaped like an identifier is
 * dropped by the caller's validation, not silently widened here.
 */
export function normalizeKeys(raw: readonly string[]): string[] {
  const out: string[] = [];
  for (const entry of raw) {
    const trimmed = String(entry ?? '').trim();
    if (!trimmed) continue;
    const key = trimmed.includes('#') ? trimmed.toLowerCase() : trimmed.toUpperCase();
    if (!MENTION_KEY_SHAPE.test(key)) continue;
    if (!out.includes(key)) out.push(key);
    if (out.length >= MAX_KEYS) break;
  }
  return out;
}

export interface MentionMatch {
  id: string;
  sender_name: string;
  sender_email: string;
  what: string;
  why: string | null;
  action: string | null;
  priority: Priority;
  created_at: string;
  age: string;
  day: string;
  relevance: Relevance;
  project: string | null;
  /** True when this share names the reader in share_recipients — they were spoken to directly. */
  to_me: boolean;
  /**
   * True when the reader wrote it. Included ON PURPOSE, unlike every other
   * read path, so a caller can tell "nobody knows about this ticket" from
   * "you already told the team on Tuesday" — and stop offering to publish
   * something the reader has already published.
   */
  mine: boolean;
  /** Which of the requested keys this share actually names. Never empty. */
  keys: string[];
}

/**
 * Escapes a value for use inside a `LIKE` pattern. Repo references contain
 * `_`, which is a single-character wildcard in `LIKE` — without this,
 * `acme/api_v2#7` would also match `acme/apiXv2#7`.
 */
function likeEscape(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

export function findMentions(
  scope: TeamScope,
  viewerEmail: string,
  keys: readonly string[],
  nowIso: string,
  expiryDays: number,
): MentionMatch[] {
  const wanted = normalizeKeys(keys);
  if (wanted.length === 0) return [];

  const me = normalizeEmail(viewerEmail);
  const cutoff = expiryCutoff(nowIso, expiryDays);
  const visible = visibleToClause(scope, me);

  // One OR-ed `LIKE` per key per searchable column. `tags` is stored as a JSON
  // array of lower-cased strings, so it is matched as text like the rest and
  // then re-checked precisely below with everything else.
  const columns = ['s.what', 's.why', 's.action', 's.tags'];
  const likeSql = wanted
    .map(() => `(${columns.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`)
    .join(' OR ');
  const likeArgs = wanted.flatMap((key) => columns.map(() => `%${likeEscape(key)}%`));

  const rows = scope.db
    .prepare(
      `SELECT s.id, s.sender_email, s.priority, s.what, s.why, s.action, s.tags,
              s.created_at, s.stale_at, s.project,
              COALESCE(m.name, s.sender_email) AS sender_name,
              EXISTS (
                SELECT 1 FROM share_recipients sr
                 WHERE sr.team_id = ? AND sr.share_id = s.id AND sr.email = ?
              ) AS to_me
         FROM shares s
         LEFT JOIN members m ON m.email = s.sender_email AND m.team_id = s.team_id
        WHERE s.team_id = ?
          AND s.stale_at IS NULL
          AND s.created_at >= ?
          AND ${visible.sql}
          AND (${likeSql})
        ORDER BY CASE s.priority WHEN 'blocking' THEN 0 ELSE 1 END,
                 s.created_at DESC, s.id DESC
        LIMIT ?`,
    )
    .all(
      scope.teamId,
      me,
      scope.teamId,
      cutoff,
      ...visible.args,
      ...likeArgs,
      SQL_CANDIDATE_LIMIT,
    ) as Record<string, unknown>[];

  const matchers = wanted.map((key) => ({ key, re: keyMatcher(key) }));

  const matches: MentionMatch[] = [];
  for (const r of rows) {
    // Every field the SQL searched is re-checked here, joined so a key
    // spanning none of them individually cannot slip through on the coarse
    // pass alone.
    const haystack = [r.what, r.why, r.action, r.tags].filter(Boolean).join('\n');
    const hit = matchers.filter((m) => m.re.test(haystack)).map((m) => m.key);
    if (hit.length === 0) continue;

    const created_at = r.created_at as string;
    const priority = r.priority as Priority;
    const freshness = classifyRelevance({
      createdAt: created_at,
      staleAt: null,
      priority,
      nowIso,
      expiryDays,
    });
    matches.push({
      id: r.id as string,
      sender_name: r.sender_name as string,
      sender_email: r.sender_email as string,
      what: r.what as string,
      why: (r.why as string | null) ?? null,
      action: (r.action as string | null) ?? null,
      priority,
      created_at,
      age: freshness.age,
      day: freshness.day,
      relevance: freshness.relevance,
      project: (r.project as string | null) ?? null,
      to_me: Boolean(r.to_me),
      mine: (r.sender_email as string) === me,
      keys: hit,
    });
  }
  return matches;
}
