import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import {
  findTeamByTokenHash,
  hashToken,
  makeTeamScope,
  normalizeEmail,
  upsertMember,
  type Db,
  type TeamScope,
} from './db.js';

export interface Identity {
  email: string;
  name: string;
}

// The TeamScope is constructed here — inside authenticate()/authenticateTeamOnly()
// — and nowhere else in a request path. Every caller (app.ts, mcp.ts) takes the
// scope from this result rather than resolving a team id and building one of
// its own; that is what makes "pass the wrong team's scope" impossible to
// write by accident on the authenticated surfaces.
export type AuthResult =
  | { ok: true; identity: Identity; scope: TeamScope; teamName: string }
  | { ok: false; status: 401 | 400; message: string };

export type TeamAuthResult =
  | { ok: true; scope: TeamScope; teamName: string }
  | { ok: false; status: 401; message: string };

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
// whether any team/token exists at all (no existence oracle).
const INVALID_TOKEN_MESSAGE =
  'invalid team token — reconnect: /plugin (Claude Code) or `teamshare connect` (other assistants)';

function bearerToken(req: Request): string | undefined {
  const raw = headerValue(req, 'authorization');
  if (!raw.startsWith('Bearer ')) return undefined;
  const token = raw.slice('Bearer '.length);
  return token.length > 0 ? token : undefined;
}

// The one place a bearer token is resolved to a team: SHA-256 it and look it
// up against teams.token_hash. Shared by authenticate() and
// authenticateTeamOnly() so both surfaces fail the exact same way on an
// unknown token.
function resolveTeam(
  db: Db,
  req: Request,
): { ok: true; team: { id: string; name: string } } | { ok: false; status: 401; message: string } {
  const token = bearerToken(req);
  const team = token ? findTeamByTokenHash(db, hashToken(token)) : undefined;
  if (!team) return { ok: false, status: 401, message: INVALID_TOKEN_MESSAGE };
  return { ok: true, team };
}

// Token-only auth: resolves a team but requires no per-member identity
// headers. Used by POST /teams/rotate, which is a maintenance action on the
// team itself, not an action attributed to one of its members.
export function authenticateTeamOnly(db: Db, req: Request): TeamAuthResult {
  const resolved = resolveTeam(db, req);
  if (!resolved.ok) return resolved;
  return { ok: true, scope: makeTeamScope(db, resolved.team.id), teamName: resolved.team.name };
}

export function authenticate(db: Db, req: Request): AuthResult {
  const resolved = resolveTeam(db, req);
  if (!resolved.ok) return resolved;

  const email = headerValue(req, 'x-teamshare-email');
  const name = headerValue(req, 'x-teamshare-name');
  if (
    !email ||
    !name ||
    PLACEHOLDER.test(email) ||
    PLACEHOLDER.test(name) ||
    !EMAIL.test(email) ||
    name.length > MAX_NAME ||
    hasControlChar(name) ||
    hasControlChar(email)
  ) {
    return {
      ok: false,
      status: 400,
      message:
        'missing or malformed identity headers — check git config user.name/user.email, then reconnect: ' +
        '/plugin (Claude Code) or `teamshare connect` (other assistants)',
    };
  }

  return {
    ok: true,
    identity: { email: normalizeEmail(email), name },
    scope: makeTeamScope(db, resolved.team.id),
    teamName: resolved.team.name,
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
