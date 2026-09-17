import type { Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import {
  findMemberByTokenHash,
  findTeamById,
  findTeamByTokenHash,
  hashToken,
  makeTeamScope,
  normalizeEmail,
  touchMemberTokenUsage,
  upsertMember,
  type Db,
  type TeamScope,
} from './db.js';

export interface Identity {
  email: string;
  name: string;
}

// The TeamScope is constructed here — inside authenticate()/authenticateAdmin()
// — and nowhere else in a request path. Every caller (app.ts, mcp.ts) takes the
// scope from this result rather than resolving a team id and building one of
// its own; that is what makes "pass the wrong team's scope" impossible to
// write by accident on the authenticated surfaces.
// ---------------------------------------------------------------------------
// The 401 challenge
//
// A 401 with no WWW-Authenticate header does not say HOW to authenticate, and
// an MCP client that cannot tell is entitled to assume the modern default:
// OAuth. It then goes looking for authorization-server metadata, finds
// nothing here (this server has no OAuth and never has), and reports the
// failure as "couldn't start sign in" — a message about a mechanism teamshare
// does not implement, shown to someone whose actual problem is that they have
// no token. That is what this header fixes: it names the scheme, so the
// client's complaint matches the truth.
//
// Shapes per RFC 6750 §3.1. A request that sent NO credential gets a bare
// challenge: nothing went wrong yet, the client simply has to present one.
// A request that sent one and was refused gets `error="invalid_token"`, which
// is what tells a client to stop retrying the same value.
//
// This distinction leaks nothing. It reflects only what the CALLER sent,
// which the caller already knows — unlike the message bodies below, which
// deliberately give one answer for "no such team", "wrong token" and
// "revoked", so that none of them is an existence oracle.
// ---------------------------------------------------------------------------

export const BEARER_REALM = 'teamshare';

// No `"` and no control characters: this is interpolated into a header value,
// and a quoted-string cannot carry either.
const NO_OAUTH_HINT =
  'Pass a personal teamshare token as a bearer credential. This server has no OAuth sign-in flow.';

export function bearerChallenge(credentialSent: boolean): string {
  return credentialSent
    ? `Bearer realm="${BEARER_REALM}", error="invalid_token", error_description="${NO_OAUTH_HINT}"`
    : `Bearer realm="${BEARER_REALM}", error_description="${NO_OAUTH_HINT}"`;
}

export interface AuthFailure {
  ok: false;
  status: 401;
  message: string;
  /** The exact WWW-Authenticate value this refusal must be sent with. */
  challenge: string;
}

/**
 * The ONE way a bearer 401 leaves this server. Routes call this instead of
 * `res.status(...).json(...)` so that no future route can emit a 401 that
 * forgets the challenge header — the same reasoning as visibleToClause living
 * in the accessor rather than in each caller.
 */
export function sendAuthFailure(res: Response, failure: AuthFailure): void {
  res.setHeader('WWW-Authenticate', failure.challenge);
  res.status(failure.status).json({ error: failure.message });
}

/** True when the caller sent an Authorization header at all, malformed or not. */
function sentCredential(req: Request): boolean {
  return headerValue(req, 'authorization').length > 0;
}

export type AuthResult =
  | { ok: true; identity: Identity; scope: TeamScope; teamName: string }
  | AuthFailure;

export type TeamAuthResult =
  | { ok: true; scope: TeamScope; teamName: string }
  | AuthFailure;

// Claude Code sends the literal "${VAR}" text when a variable is unset, so a
// placeholder must be rejected rather than stored as a member.
const PLACEHOLDER = /\$\{/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_NAME = 100;

// Control characters (newlines included) would let a name forge a fence line.
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function headerValue(req: Request, name: string): string {
  const v = req.headers[name.toLowerCase()];
  return (Array.isArray(v) ? v[0] : v ?? '').trim();
}

// Byte-identical regardless of *why* the token was rejected — missing
// header, malformed header, or a well-formed-but-unknown token all produce
// this same 401. No branch below may leak which of those happened, or
// whether any team/token/member exists at all (no existence oracle).
const INVALID_ADMIN_TOKEN_MESSAGE =
  'invalid team token — reconnect: /plugin (Claude Code) or `teamshare connect` (other assistants)';

// The 401 an old (pre-invites) team token, or any unknown/revoked bearer
// token, now gets on every data route. Deliberately explains the remedy in
// full: this is the ONE place a real, one-time cutover break is expected
// (see the design doc's Migration section) — every existing install 401s
// here and needs an invite from its lead, and the body must say exactly
// that, not just "unauthorized".
const INVALID_MEMBER_TOKEN_MESSAGE =
  'invalid, missing, or revoked personal token — this server now requires a personal token per ' +
  'person (the old shared team token no longer grants data access). Ask your team lead to run ' +
  '`teamshare invite <your-email>` (or `node teamshare-team.mjs invite <server-url> <your-email>`) ' +
  'and reconnect with the token they send you: /plugin (Claude Code) or `teamshare connect` (other assistants)';

function bearerToken(req: Request): string | undefined {
  const raw = headerValue(req, 'authorization');
  if (!raw.startsWith('Bearer ')) return undefined;
  const token = raw.slice('Bearer '.length);
  return token.length > 0 ? token : undefined;
}

// The ADMIN resolver: consults ONLY teams.token_hash, never member_tokens.
// Used by POST /teams/rotate, POST /invites, POST /revoke, and (alongside
// authenticate() below) GET /members — every maintenance action on the team
// itself, never one attributed to an individual member. Deliberately a
// separate function from authenticate(), not one resolver returning a
// `kind`: a shared resolver is safe only as long as every future route
// remembers to check the kind it returns, and eventually one won't. Two
// functions make "a member token grants admin access" or "an admin token
// reads data" impossible to write by accident, rather than a convention a
// reviewer has to remember — the same reasoning as TeamScope's structural
// branding in db.ts.
export function authenticateAdmin(db: Db, req: Request): TeamAuthResult {
  const token = bearerToken(req);
  const team = token ? findTeamByTokenHash(db, hashToken(token)) : undefined;
  if (!team) {
    return { ok: false, status: 401, message: INVALID_ADMIN_TOKEN_MESSAGE, challenge: bearerChallenge(sentCredential(req)) };
  }
  return { ok: true, scope: makeTeamScope(db, team.id), teamName: team.name };
}

// The MEMBER resolver: consults ONLY member_tokens where revoked_at IS
// NULL, never teams.token_hash. Identity comes entirely from the token —
// X-Teamshare-Email/-Name are never read here (they stay accepted and
// silently ignored so old clients that still send them keep working
// unchanged; see the design doc's "Identity comes from the token, never the
// header"). This is the sole source of `identity` for touchMember, and
// therefore for every share, receipt, and roster write this request makes —
// the fix for the forgery this whole change exists to close.
export function authenticate(db: Db, req: Request, nowIso: string = new Date().toISOString()): AuthResult {
  const token = bearerToken(req);
  const tokenHash = token ? hashToken(token) : undefined;
  const member = tokenHash ? findMemberByTokenHash(db, tokenHash) : undefined;
  if (!member || !tokenHash) {
    return { ok: false, status: 401, message: INVALID_MEMBER_TOKEN_MESSAGE, challenge: bearerChallenge(sentCredential(req)) };
  }

  const team = findTeamById(db, member.teamId);
  // A member token whose team has since vanished should never happen (teams
  // are never deleted today), but fail the same closed 401 rather than throw
  // if it ever does — no different information leaked either way.
  if (!team) {
    return { ok: false, status: 401, message: INVALID_MEMBER_TOKEN_MESSAGE, challenge: bearerChallenge(sentCredential(req)) };
  }

  touchMemberTokenUsage(db, tokenHash, nowIso);

  return {
    ok: true,
    identity: { email: member.email, name: member.name },
    scope: makeTeamScope(db, member.teamId),
    teamName: team.name,
  };
}

export function touchMember(scope: TeamScope, identity: Identity, nowIso: string): void {
  upsertMember(scope, identity.email, identity.name, nowIso);
}

// Constant-time comparison for the instance signup secret. The length check
// runs first because node:crypto's timingSafeEqual throws (rather than
// returning false) on buffers of different length; the secret's length
// isn't the sensitive part (it's a shared operator string or a generated
// value, not something an attacker profits from narrowing down one byte at
// a time via a timing side-channel here), so guarding on length and then
// comparing in constant time is the standard safe shape for this check.
export function verifySignupSecret(configured: string, provided: string): boolean {
  const a = Buffer.from(configured, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export type TeamNameResult = { ok: true; value: string } | { ok: false; error: string };

export function validateTeamName(input: unknown): TeamNameResult {
  if (typeof input !== 'string') return { ok: false, error: 'name is required and must be a string' };
  const value = input.trim();
  if (value.length === 0) return { ok: false, error: 'name is required and cannot be empty' };
  if (value.length > MAX_NAME) return { ok: false, error: `name is ${value.length} chars; cap is ${MAX_NAME}` };
  if (PLACEHOLDER.test(value)) return { ok: false, error: 'name contains an unsubstituted placeholder' };
  if (hasControlChar(value)) return { ok: false, error: 'name contains a control character' };
  return { ok: true, value };
}

export type InviteEmailResult = { ok: true; value: string } | { ok: false; error: string };
export type EmailResult = InviteEmailResult;

/** Longest address any surface will accept. */
export const MAX_EMAIL = 254;

// THE email check for this codebase — shape, placeholder, control chars,
// length — returning the normalised address. `label` names the thing being
// checked so one implementation can serve every caller's error prose
// (`email ...` for an invite, `recipient "sam@team.com" ...` for a share's
// recipient list) without anyone hand-rolling a second regex. shares.ts
// calls this for every addressed recipient; see validateShare there.
export function validateEmailAddress(input: unknown, label = 'email'): EmailResult {
  if (typeof input !== 'string') return { ok: false, error: `${label} is required and must be a string` };
  const value = input.trim();
  if (value.length === 0) return { ok: false, error: `${label} is required and cannot be empty` };
  if (value.length > MAX_EMAIL) {
    return { ok: false, error: `${label} is ${value.length} chars; cap is ${MAX_EMAIL}` };
  }
  if (PLACEHOLDER.test(value)) return { ok: false, error: `${label} contains an unsubstituted placeholder` };
  if (hasControlChar(value)) return { ok: false, error: `${label} contains a control character` };
  if (!EMAIL.test(value)) return { ok: false, error: `${label} is not a valid address` };
  return { ok: true, value: normalizeEmail(value) };
}

// The email an admin gives POST /invites — this is the identity source the
// design doc requires: bound by the lead, at mint time, never by the person
// claiming it. Same shape of checks as the identity headers used to get,
// applied here instead since this is now the one place an email enters the
// system as someone's asserted identity.
export function validateInviteEmail(input: unknown): InviteEmailResult {
  return validateEmailAddress(input, 'email');
}

export type InviteNameResult = { ok: true; value: string | null } | { ok: false; error: string };

// The invitee's display name is optional on POST /invites — omitted, it
// falls back to the email itself (the same fallback unread.ts's digest
// query already uses for a sender with no member row: COALESCE(name,
// email)). Given, it is validated with the exact same rules as a team name.
export function validateInviteName(input: unknown): InviteNameResult {
  if (input === undefined || input === null) return { ok: true, value: null };
  const check = validateTeamName(input);
  if (!check.ok) return check;
  return { ok: true, value: check.value };
}
