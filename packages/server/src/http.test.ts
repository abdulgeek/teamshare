import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Server } from 'node:http';
import type { Request } from 'express';
import {
  openDb, getOrCreateToken, upsertMember, listMembers, getOrCreateDefaultTeamId, makeTeamScope,
  createTeam, hashToken, listTeams,
  type Db, type TeamScope,
} from './db.js';
import { createShare } from './shares.js';
import { createApp, type AppOptions } from './app.js';
import { authenticate } from './http.js';

let db: Db;
let scope: TeamScope;
let server: Server;
let base: string;
let token: string;
const NOW = '2026-08-29T00:00:00.000Z';

beforeEach(async () => {
  db = openDb(':memory:');
  token = getOrCreateToken(db);
  scope = makeTeamScope(db, getOrCreateDefaultTeamId(db));
  upsertMember(scope, 'adnan@team.com', 'Adnan', NOW);
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
    expect(listMembers(scope).map((m) => m.email)).toContain('priya@team.com');
  });

  it('lowercases the identity email', async () => {
    await fetch(`${base}/unread`, { headers: headers({ 'X-Teamshare-Email': 'Priya@Team.COM' }) });
    expect(listMembers(scope).map((m) => m.email)).toContain('priya@team.com');
  });

  it('returns the canonical digest shape', async () => {
    createShare(scope, 'adnan@team.com', { what: 'Auth refactor.', priority: 'blocking' }, NOW);
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

  it('names the caller\'s team in the response, for doctor to report', async () => {
    const res = await fetch(`${base}/unread`, { headers: headers() });
    const body = await res.json();
    expect(body.team).toBe('default');
  });
});

describe('cross-team isolation via HTTP', () => {
  it("a token for team B cannot read team A's shares via /unread, and sees only its own", async () => {
    createShare(scope, 'adnan@team.com', { what: 'Team A confidential plan', priority: 'blocking' }, NOW);

    const tokenB = 'ts_http_teamB_token';
    const teamB = createTeam(db, 'Team B', hashToken(tokenB), NOW);
    const scopeB = makeTeamScope(db, teamB);
    upsertMember(scopeB, 'b@teamb.com', 'B', NOW);
    createShare(scopeB, 'b@teamb.com', { what: "Team B's own note", priority: 'fyi' }, NOW);

    const res = await fetch(`${base}/unread`, {
      headers: {
        Authorization: `Bearer ${tokenB}`,
        'X-Teamshare-Email': 'other@teamb.com',
        'X-Teamshare-Name': 'Other',
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.team).toBe('Team B');
    const text = JSON.stringify(body);
    expect(text).toContain("Team B's own note");
    expect(text).not.toContain('Team A confidential plan');
  });

  it('rejects a token that matches no team with the same 401 shape as any other unknown token', async () => {
    const res = await fetch(`${base}/unread`, {
      headers: headers({ Authorization: 'Bearer ts_totally_unknown_token' }),
    });
    expect(res.status).toBe(401);
    const error = (await res.json()).error;
    expect(error).toContain('/plugin');
    expect(error).toContain('teamshare connect');
  });
});

describe('POST /teams', () => {
  async function startServer(overrides: Partial<AppOptions> = {}) {
    const teamsDb = openDb(':memory:');
    const app = createApp({
      db: teamsDb,
      expiryDays: 14,
      now: () => NOW,
      signupSecret: 'sig_topsecret',
      ...overrides,
    });
    const s = await new Promise<Server>((resolve) => {
      const srv = app.listen(0, () => resolve(srv));
    });
    const addr = s.address();
    const teamsBase = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
    return {
      db: teamsDb,
      base: teamsBase,
      async close() {
        await new Promise<void>((r) => s.close(() => r()));
        teamsDb.close();
      },
    };
  }

  it('creates a team with the right signup secret, and the returned token actually authenticates', async () => {
    const ctx = await startServer();
    try {
      const res = await fetch(`${ctx.base}/teams`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Teamshare-Signup-Secret': 'sig_topsecret' },
        body: JSON.stringify({ name: 'Acme Corp' }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.name).toBe('Acme Corp');
      expect(typeof body.team_id).toBe('string');
      expect(typeof body.token).toBe('string');

      const check = await fetch(`${ctx.base}/unread`, {
        headers: {
          Authorization: `Bearer ${body.token}`,
          'X-Teamshare-Email': 'a@acme.com',
          'X-Teamshare-Name': 'A',
        },
      });
      expect(check.status).toBe(200);
      expect((await check.json()).team).toBe('Acme Corp');
    } finally {
      await ctx.close();
    }
  });

  it('401s on a wrong or missing signup secret, and creates nothing', async () => {
    const ctx = await startServer();
    try {
      const wrong = await fetch(`${ctx.base}/teams`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Teamshare-Signup-Secret': 'nope' },
        body: JSON.stringify({ name: 'Should not exist' }),
      });
      expect(wrong.status).toBe(401);

      const missing = await fetch(`${ctx.base}/teams`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Should not exist either' }),
      });
      expect(missing.status).toBe(401);

      expect(listTeams(ctx.db)).toHaveLength(0);
    } finally {
      await ctx.close();
    }
  });

  it('rejects an empty or missing name with 400', async () => {
    const ctx = await startServer();
    try {
      const res = await fetch(`${ctx.base}/teams`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Teamshare-Signup-Secret': 'sig_topsecret' },
        body: JSON.stringify({ name: '   ' }),
      });
      expect(res.status).toBe(400);
      expect(listTeams(ctx.db)).toHaveLength(0);
    } finally {
      await ctx.close();
    }
  });

  it('fails closed when the gate is not disabled but no secret is configured at all', async () => {
    const ctx = await startServer({ signupSecret: null, openSignup: false });
    try {
      const res = await fetch(`${ctx.base}/teams`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Teamshare-Signup-Secret': '' },
        body: JSON.stringify({ name: 'X' }),
      });
      expect(res.status).toBe(401);
    } finally {
      await ctx.close();
    }
  });

  it('allows signup with no secret at all when open-signup is set', async () => {
    const ctx = await startServer({ signupSecret: null, openSignup: true });
    try {
      const res = await fetch(`${ctx.base}/teams`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Open Team' }),
      });
      expect(res.status).toBe(201);
    } finally {
      await ctx.close();
    }
  });

  it('enforces the per-IP signup rate limit', async () => {
    const ctx = await startServer({ signupRateLimit: { windowMs: 60_000, max: 2 } });
    try {
      const attempt = (name: string) =>
        fetch(`${ctx.base}/teams`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Teamshare-Signup-Secret': 'sig_topsecret' },
          body: JSON.stringify({ name }),
        });
      const first = await attempt('One');
      const second = await attempt('Two');
      const third = await attempt('Three');
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(third.status).toBe(429);
      expect(listTeams(ctx.db)).toHaveLength(2);
    } finally {
      await ctx.close();
    }
  });

  it('enforces --max-teams, refusing once the instance cap is reached', async () => {
    const ctx = await startServer({ maxTeams: 1 });
    try {
      const attempt = (name: string) =>
        fetch(`${ctx.base}/teams`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Teamshare-Signup-Secret': 'sig_topsecret' },
          body: JSON.stringify({ name }),
        });
      const first = await attempt('One');
      const second = await attempt('Two');
      expect(first.status).toBe(201);
      expect(second.status).toBe(403);
      expect(listTeams(ctx.db)).toHaveLength(1);
    } finally {
      await ctx.close();
    }
  });
});

describe('POST /teams/rotate', () => {
  it("rotates the caller's team token: the old token stops working and the new one works", async () => {
    const res = await fetch(`${base}/teams/rotate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.token).toBe('string');
    expect(body.token).not.toBe(token);
    expect(body.name).toBe('default');

    const oldCheck = await fetch(`${base}/unread`, { headers: headers() });
    expect(oldCheck.status).toBe(401);

    const newCheck = await fetch(`${base}/unread`, {
      headers: headers({ Authorization: `Bearer ${body.token}` }),
    });
    expect(newCheck.status).toBe(200);
  });

  it('rejects rotation with an unknown token', async () => {
    const res = await fetch(`${base}/teams/rotate`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ts_not_a_real_token' },
    });
    expect(res.status).toBe(401);
  });

  it("does not affect another team's token", async () => {
    const tokenB = 'ts_http_rotate_teamB';
    createTeam(db, 'Team B', hashToken(tokenB), NOW);

    await fetch(`${base}/teams/rotate`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });

    const stillWorksForB = await fetch(`${base}/unread`, {
      headers: { Authorization: `Bearer ${tokenB}`, 'X-Teamshare-Email': 'b@teamb.com', 'X-Teamshare-Name': 'B' },
    });
    expect(stillWorksForB.status).toBe(200);
  });
});
