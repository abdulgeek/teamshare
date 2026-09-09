import { normalizeEmail, listMembers, listRoster, type TeamScope } from './db.js';
import { validateEmailAddress } from './http.js';

/**
 * Turning "tell Adnan" into an address.
 *
 * `recipients` used to accept an email and nothing else, which meant every
 * private note started with the assistant asking the user to type an address
 * it had no way to look up. The roster has carried a name since `invite`
 * first took one; this is the missing half of that.
 *
 * Three rules shape all of it:
 *
 *   1. **Never guess.** Two people called Adnan is a question for the user,
 *      not a coin flip. A private note delivered to the wrong person is the
 *      worst thing this feature can do, and it is silent when it happens.
 *   2. **Never widen.** A term that resolves to nobody is an error. It is
 *      never a quiet fallback to the whole team, which would turn "tell Adnan
 *      I'm on EN-2022" into telling everyone.
 *   3. **An email always works**, unchanged, with no lookup at all. Names are
 *      an addition to that path, never a replacement for it.
 */

/**
 * `Adnan <adnan@acme.com>` — the form `teammates` prints and every failure
 * message here quotes. A model that copies one of those lines straight back
 * into `recipients` must be right, not wrong, so the address is lifted out of
 * the angle brackets rather than the whole string being read as a name.
 */
export function extractAngleAddress(term: string): string | null {
  const m = /^[^<>]*<([^<>\s]+@[^<>\s]+)>$/.exec(term.trim());
  return m ? m[1] : null;
}

/** The one place a written term is judged to be an address rather than a name. */
export function looksLikeEmail(term: string): boolean {
  const trimmed = term.trim();
  if (extractAngleAddress(trimmed)) return true;
  return trimmed.includes('@') && !trimmed.startsWith('@');
}

/**
 * An unsubstituted template placeholder is a bug in whatever built the call,
 * never something a person is called. Caught on the NAME path too, because
 * moving the address check downstream would otherwise have let `${TEAMMATE}`
 * through as a plausible name and reported it as an unknown teammate — which
 * hides the actual fault.
 */
export const TERM_PLACEHOLDER = /\$\{|\{\{|<[A-Za-z0-9_.-]+>|\bYOUR[_ -]?(?:EMAIL|NAME)\b/i;

export const MAX_ALIAS_LENGTH = 60;

export interface Candidate {
  email: string;
  name: string | null;
  /** False for someone invited who has never authenticated — they cannot be addressed yet. */
  connected: boolean;
}

export type Resolution =
  | { ok: true; email: string }
  | { ok: false; kind: 'ambiguous'; term: string; candidates: Candidate[] }
  | { ok: false; kind: 'unknown'; term: string; candidates: Candidate[] };

function foldTerm(term: string): string {
  // A leading "@" is how people write a mention, and it is never part of the
  // name itself. Stripped before anything else looks at the term.
  return term.trim().replace(/^@+/, '').trim().toLowerCase();
}

/** The roster, as candidates, with "has this person ever connected" already decided. */
export function teamDirectory(scope: TeamScope): Candidate[] {
  const connected = new Set(listMembers(scope).map((m) => m.email));
  return listRoster(scope).map((r) => ({
    email: r.email,
    name: r.name ?? null,
    connected: connected.has(r.email),
  }));
}

// ---------------------------------------------------------------------------
// The personal address book
//
// Per owner, deliberately: what YOU call someone is not what your teammates
// call them, and one shared namespace would mean the first person to save
// "Adnan" decides who that means for everybody.
// ---------------------------------------------------------------------------

export interface AliasRow {
  alias: string;
  target_email: string;
}

export function listAliases(scope: TeamScope, ownerEmail: string): AliasRow[] {
  return scope.db
    .prepare(
      `SELECT alias, target_email FROM member_aliases
        WHERE team_id = ? AND owner_email = ?
        ORDER BY alias`,
    )
    .all(scope.teamId, normalizeEmail(ownerEmail)) as AliasRow[];
}

export type AliasResult = { ok: true; alias: string; email: string; connected: boolean } | { ok: false; error: string };

/**
 * Saves "call this address Adnan" for one person.
 *
 * An address that is not on the team is STORED, not refused — the user is
 * recording who they mean, and being told "invite them first" at save time is
 * more useful than a rejection that loses what they typed. `connected` on the
 * result is what lets the caller say so.
 */
export function rememberAlias(
  scope: TeamScope,
  ownerEmail: string,
  rawAlias: string,
  rawEmail: string,
  nowIso: string,
): AliasResult {
  const alias = foldTerm(rawAlias);
  if (alias.length === 0) return { ok: false, error: 'the name cannot be empty' };
  if (alias.length > MAX_ALIAS_LENGTH) {
    return { ok: false, error: `the name is ${alias.length} chars; cap is ${MAX_ALIAS_LENGTH}` };
  }
  // A name that is itself an address would shadow the address path and mean
  // "adnan@acme.com" could be pointed at somebody else entirely.
  if (looksLikeEmail(alias)) {
    return { ok: false, error: `"${rawAlias}" is an address, not a name — a name is what you want to type instead of one` };
  }
  const check = validateEmailAddress(rawEmail, `address for "${rawAlias.trim().slice(0, 40)}"`);
  if (!check.ok) return { ok: false, error: check.error };

  const owner = normalizeEmail(ownerEmail);
  if (check.value === owner) {
    return { ok: false, error: 'that is your own address — a share never notifies its own author' };
  }

  scope.db
    .prepare(
      `INSERT INTO member_aliases (team_id, owner_email, alias, target_email, created_at)
            VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (team_id, owner_email, alias)
         DO UPDATE SET target_email = excluded.target_email, created_at = excluded.created_at`,
    )
    .run(scope.teamId, owner, alias, check.value, nowIso);

  const connected = teamDirectory(scope).some((c) => c.email === check.value && c.connected);
  return { ok: true, alias, email: check.value, connected };
}

export function forgetAlias(scope: TeamScope, ownerEmail: string, rawAlias: string): boolean {
  const info = scope.db
    .prepare('DELETE FROM member_aliases WHERE team_id = ? AND owner_email = ? AND alias = ?')
    .run(scope.teamId, normalizeEmail(ownerEmail), foldTerm(rawAlias));
  return info.changes > 0;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Everyone whose name could reasonably be what the writer typed. */
function matchesByName(directory: Candidate[], term: string): Candidate[] {
  const named = directory.filter((c) => c.name && c.name.trim().length > 0);

  const full = (c: Candidate) => c.name!.trim().toLowerCase();
  const words = (c: Candidate) => full(c).split(/\s+/);

  // Two tiers, and the first that matches ANYTHING wins outright. What
  // separates them is how people actually refer to each other, not string
  // length: a whole name and a first name are both how you would name
  // somebody out loud, so they are ONE tier and compete with each other.
  //
  // Splitting them was a real mis-delivery bug. With a teammate whose name is
  // literally "Priya" and another called "Priya Nair", "tell Priya" matched
  // the first on an exact whole-name tier and never even considered the
  // second — resolving silently to one of two people who are both called
  // Priya. They are genuinely ambiguous and the user has to be asked.
  //
  // A surname or a prefix is weaker. Those only get a look when nothing in
  // the strong tier matched at all, which is what keeps an exact "Sam" from
  // being dragged into ambiguity by a "Samantha" who merely starts the same.
  const tiers: ((c: Candidate) => boolean)[] = [
    (c) => full(c) === term || words(c)[0] === term,
    // A surname or middle name, then a prefix for "Adn".
    (c) => words(c).includes(term) || full(c).startsWith(term),
  ];

  for (const tier of tiers) {
    const hits = named.filter(tier);
    if (hits.length > 0) return hits;
  }
  return [];
}

/**
 * One written term to one address.
 *
 * The order matters and is not arbitrary: an address is taken literally, then
 * YOUR OWN saved name for someone beats the roster, because you chose it and
 * the roster's spelling of their name is somebody else's decision.
 */
export function resolveRecipientTerm(scope: TeamScope, ownerEmail: string, rawTerm: string): Resolution {
  const raw = String(rawTerm ?? '').trim();
  const directory = teamDirectory(scope);

  // 1. An address is an address. No lookup, no change in behaviour from
  //    before names existed — the shape check still happens, and the
  //    membership check still happens downstream in resolveRecipients.
  if (looksLikeEmail(raw)) {
    const check = validateEmailAddress(extractAngleAddress(raw) ?? raw, `recipient "${raw.slice(0, 60)}"`);
    if (!check.ok) return { ok: false, kind: 'unknown', term: raw, candidates: [] };
    return { ok: true, email: check.value };
  }

  const term = foldTerm(raw);
  if (term.length === 0) return { ok: false, kind: 'unknown', term: raw, candidates: [] };

  // 2. Your own address book wins over the roster.
  const alias = scope.db
    .prepare('SELECT target_email FROM member_aliases WHERE team_id = ? AND owner_email = ? AND alias = ?')
    .get(scope.teamId, normalizeEmail(ownerEmail), term) as { target_email: string } | undefined;
  if (alias) return { ok: true, email: alias.target_email };

  // 3. The roster's own names.
  const hits = matchesByName(directory, term);
  if (hits.length === 1) return { ok: true, email: hits[0].email };
  if (hits.length > 1) return { ok: false, kind: 'ambiguous', term: raw, candidates: hits };

  // Nothing matched. Hand back the connected roster so the caller can say who
  // there IS, rather than only that this person is not among them.
  return { ok: false, kind: 'unknown', term: raw, candidates: directory.filter((c) => c.connected) };
}

/** The error text for a term that did not resolve, written to be acted on rather than just read. */
export function describeResolutionFailure(res: Extract<Resolution, { ok: false }>): string {
  const label = (c: Candidate) => (c.name ? `${c.name} <${c.email}>` : c.email);
  if (res.kind === 'ambiguous') {
    return (
      `"${res.term}" matches ${res.candidates.length} people on this team: ` +
      `${res.candidates.map(label).join(', ')}. ` +
      'Ask which one they mean and pass that address — a private note sent to the wrong person is silent, ' +
      'so this will not guess.'
    );
  }
  const known = res.candidates.length
    ? ` On this team: ${res.candidates.map(label).join(', ')}.`
    : '';
  return (
    `nobody on this team is called "${res.term}", and it is not an address.${known} ` +
    'Pass their email, or save the name first with `remember_name` if you will use it again.'
  );
}
