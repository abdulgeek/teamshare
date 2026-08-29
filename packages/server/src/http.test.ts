import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Server } from 'node:http';
import type { Request } from 'express';
import { openDb, getOrCreateToken, upsertMember, listMembers, type Db } from './db.js';
import { createShare } from './shares.js';
import { createApp } from './app.js';
import { authenticate } from './http.js';

let db: Db;
let server: Server;
let base: string;
let token: string;
const NOW = '2026-08-29T00:00:00.000Z';

beforeEach(async () => {
  db = openDb(':memory:');
  token = getOrCreateToken(db);
  upsertMember(db, 'adnan@team.com', 'Adnan', NOW);
  const app = createApp({ db, expiryDays: 14, now: () => NOW });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address();
  if (typeof addr === 'object' && addr) base = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  db.close();
});

function headers(extra: Record<string, string> = {}) {
  return {
    Authorization: `Bearer ${token}`,
    'X-Teamshare-Email': 'priya@team.com',
    'X-Teamshare-Name': 'Priya',
    ...extra,
  };
}

describe('auth', () => {
  it('rejects a missing token with 401', async () => {
    const res = await fetch(`${base}/unread`, {
      headers: { 'X-Teamshare-Email': 'p@t.com', 'X-Teamshare-Name': 'P' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects a wrong token with 401 and a reconnect hint', async () => {
    const res = await fetch(`${base}/unread`, { headers: headers({ Authorization: 'Bearer nope' }) });
    expect(res.status).toBe(401);
    const error = (await res.json()).error;
    expect(error).toContain('/plugin');
    expect(error).toContain('teamshare connect');
  });

  it('rejects missing identity headers with 400', async () => {
    const res = await fetch(`${base}/unread`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(400);
  });

  it('rejects a malformed email with 400', async () => {
    const res = await fetch(`${base}/unread`, {
      headers: headers({ 'X-Teamshare-Email': 'not-an-email' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a control character in the email with 400, same as it would for the name', () => {
    // The EMAIL regex's \s class already blocks newlines, but other control
    // characters (e.g. a bare SOH) are neither \s nor excluded by [^\s@], so
    // without an explicit check they would sail through where an equivalent
    // character in the name is already rejected — an accidental asymmetry.
    // Tested against authenticate() directly: fetch/undici (and Node's own
    // HTTP parser) already refuse to transmit a raw control character in a
    // header value at all, so a real end-to-end request can never exercise
    // this path — the check still belongs in authenticate() as defense in
    // depth against any caller that hands it headers a browser wouldn't.
    const req = {
      headers: {
        authorization: `Bearer ${token}`,
        'x-teamshare-email': 'p\x01@t.com',
        'x-teamshare-name': 'Priya',
      },
    } as unknown as Request;
    const result = authenticate(db, req);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.status).toBe(400);
  });

  it('rejects an unsubstituted ${user_config...} placeholder with 400', async () => {
    // Claude Code sends the literal placeholder when a variable is unset.
    const res = await fetch(`${base}/unread`, {
      headers: headers({ 'X-Teamshare-Email': '${user_config.TEAMSHARE_EMAIL}' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /unread', () => {
  it('registers the caller as a member on first contact', async () => {
    await fetch(`${base}/unread`, { headers: headers() });
    expect(listMembers(db).map((m) => m.email)).toContain('priya@team.com');
  });

  it('lowercases the identity email', async () => {
    await fetch(`${base}/unread`, { headers: headers({ 'X-Teamshare-Email': 'Priya@Team.COM' }) });
    expect(listMembers(db).map((m) => m.email)).toContain('priya@team.com');
  });

  it('returns the canonical digest shape', async () => {
    createShare(db, 'adnan@team.com', { what: 'Auth refactor.', priority: 'blocking' }, NOW);
    const res = await fetch(`${base}/unread`, { headers: headers() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.shares[0]).toMatchObject({
      sender_name: 'Adnan',
      sender_email: 'adnan@team.com',
      priority: 'blocking',
      what: 'Auth refactor.',
      created_at: NOW,
    });
    expect(typeof body.shares[0].id).toBe('string');
  });
});
