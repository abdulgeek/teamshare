import type { Request } from 'express';
import { getOrCreateToken, normalizeEmail, upsertMember, type Db } from './db.js';

export interface Identity {
  email: string;
  name: string;
}

export type AuthResult =
  | { ok: true; identity: Identity }
  | { ok: false; status: 401 | 400; message: string };

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

export function authenticate(db: Db, req: Request): AuthResult {
  const auth = headerValue(req, 'authorization');
  const expected = `Bearer ${getOrCreateToken(db)}`;
  if (!auth || auth !== expected) {
    return { ok: false, status: 401, message: 'invalid team token — run /teamshare-setup' };
  }

  const email = headerValue(req, 'x-teamshare-email');
  const name = headerValue(req, 'x-teamshare-name');
  if (
    !email ||
    !name ||
    PLACEHOLDER.test(email) ||
    PLACEHOLDER.test(name) ||
    !EMAIL.test(email) ||
    name.length > MAX_NAME ||
    hasControlChar(name)
  ) {
    return {
      ok: false,
      status: 400,
      message:
        'missing or malformed identity headers — run /teamshare-setup and check git config user.name/user.email',
    };
  }

  return { ok: true, identity: { email: normalizeEmail(email), name } };
}

export function touchMember(db: Db, identity: Identity, nowIso: string): void {
  upsertMember(db, identity.email, identity.name, nowIso);
}
