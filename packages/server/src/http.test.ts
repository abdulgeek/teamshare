import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Server } from 'node:http';
import type { Request } from 'express';
import {
  openDb, getOrCreateToken, upsertMember, listMembers, getOrCreateDefaultTeamId, makeTeamScope,
  createTeam, hashToken, listTeams, createMemberToken, revokeMemberTokens, listRoster,
  type Db, type TeamScope,
} from './db.js';
import { createShare } from './shares.js';
import { createApp, type AppOptions } from './app.js';
import { authenticate } from './http.js';

let db: Db;
let scope: TeamScope;
let server: Server;
let base: string;
// The team's ADMIN token (formerly "the" team token) — mints/revokes member
// tokens and reads the roster, but grants no access to shares, receipts, or
// the digest.
let adminToken: string;
// Priya's own personal MEMBER token — this is what /unread and /mcp accept.
let token: string;
const NOW = '2026-08-29T00:00:00.000Z';

beforeEach(async () => {
  db = openDb(':memory:');
  adminToken = getOrCreateToken(db);
  scope = makeTeamScope(db, getOrCreateDefaultTeamId(db));
  // Adnan is a pre-existing (pre-invites) roster row with no token of his
  // own yet — exactly the post-migration shape the design doc describes.
  upsertMember(scope, 'adnan@team.com', 'Adnan', NOW);
  token = createMemberToken(scope, 'priya@team.com', 'Priya', NOW);
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

// Headers are accepted-and-ignored everywhere now — kept here only to prove
// old clients that still send them keep working, never because anything
// reads them for identity.
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

  it('rejects a wrong member token with 401 and a reconnect hint', async () => {
    const res = await fetch(`${base}/unread`, { headers: headers({ Authorization: 'Bearer nope' }) });
    expect(res.status).toBe(401);
    const error = (await res.json()).error;
    expect(error).toContain('/plugin');
    expect(error).toContain('teamshare connect');
  });

  // §Migration cutover: the OLD shared team token is now the ADMIN
  // credential exclusively. Every existing install presenting it on a data
  // route must 401 with a remedy that says exactly what changed and what to
  // run — this is the one deliberate, permanent break the design doc calls
  // for, not a bug.
  it('rejects the admin (formerly-shared) team token on /unread, with the exact remedy text', async () => {
    const res = await fetch(`${base}/unread`, {
      headers: { Authorization: `Bearer ${adminToken}`, 'X-Teamshare-Email': 'adnan@team.com', 'X-Teamshare-Name': 'Adnan' },
    });
    expect(res.status).toBe(401);
    const error = (await res.json()).error;
    expect(error.toLowerCase()).toContain('personal token');
    expect(error).toContain('teamshare invite');
    expect(error).toContain('/plugin');
    expect(error).toContain('teamshare connect');
  });

  // Headers are accepted and silently ignored now — identity comes from the
  // token alone. A missing, malformed, or malicious identity header must
  // never 400 or change who the request is attributed to.
  it('ignores a missing X-Teamshare-Email/-Name entirely and still succeeds using the token\'s identity', async () => {
    const res = await fetch(`${base}/unread`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
  });

  it('ignores a malformed email header — identity still resolves from the token, not the header', async () => {
    const res = await fetch(`${base}/unread`, {
      headers: headers({ 'X-Teamshare-Email': 'not-an-email' }),
    });
    expect(res.status).toBe(200);
    // The malformed header value never lands anywhere — the touched member
    // row is Priya's real, token-derived email.
    expect(listMembers(scope).map((m) => m.email)).toContain('priya@team.com');
  });

  it('ignores an unsubstituted ${user_config...} placeholder header — never a 400, since nothing reads it', async () => {
    const res = await fetch(`${base}/unread`, {
      headers: headers({ 'X-Teamshare-Email': '${user_config.TEAMSHARE_EMAIL}' }),
    });
    expect(res.status).toBe(200);
  });

  it('a control character in the identity header changes nothing — authenticate() never reads it', () => {
    const req = {
      headers: {
        authorization: `Bearer ${token}`,
        'x-teamshare-email': 'p\x01@t.com',
        'x-teamshare-name': 'Priya',
      },
    } as unknown as Request;
    const result = authenticate(db, req);
    expect(result.ok).toBe(true);
    expect(result.ok && result.identity.email).toBe('priya@team.com');
  });

  // The forgery property at the resolver level: authenticate() as one
  // member while the request claims to be someone else entirely — identity
  // must come from the token, full stop.
  it("authenticate() ignores X-Teamshare-Email claiming a DIFFERENT real member — identity is always the token holder's", () => {
    const req = {
      headers: {
        authorization: `Bearer ${token}`, // Priya's own token
        'x-teamshare-email': 'adnan@team.com', // claims to be Adnan
        'x-teamshare-name': 'Adnan',
      },
    } as unknown as Request;
    const result = authenticate(db, req);
    expect(result.ok).toBe(true);
    expect(result.ok && result.identity).toEqual({ email: 'priya@team.com', name: 'Priya' });
  });
});

describe('GET /unread', () => {
  it('registers the caller as a member on first contact, using the token\'s identity', async () => {
    await fetch(`${base}/unread`, { headers: headers() });
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
  it("a member token for team B cannot read team A's shares via /unread, and sees only its own", async () => {
    createShare(scope, 'adnan@team.com', { what: 'Team A confidential plan', priority: 'blocking' }, NOW);

    const teamB = createTeam(db, 'Team B', hashToken('ts_http_teamB_admin'), NOW);
    const scopeB = makeTeamScope(db, teamB);
    const tokenB = createMemberToken(scopeB, 'other@teamb.com', 'Other', NOW);
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

  it('rejects a token that matches no member with the same 401 shape as any other unknown token', async () => {
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

  it('creates a team with the right signup secret, and the returned token authenticates as an admin (not on /unread)', async () => {
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

      // The freshly minted token is an ADMIN token: it works on /members...
      const members = await fetch(`${ctx.base}/members`, {
        headers: { Authorization: `Bearer ${body.token}` },
      });
      expect(members.status).toBe(200);
      expect((await members.json()).team).toBe('Acme Corp');

      // ...but grants no data access at all.
      const unread = await fetch(`${ctx.base}/unread`, {
        headers: {
          Authorization: `Bearer ${body.token}`,
          'X-Teamshare-Email': 'a@acme.com',
          'X-Teamshare-Name': 'A',
        },
      });
      expect(unread.status).toBe(401);
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
  it("rotates the caller's admin token: the old token stops working and the new one works on /members", async () => {
    const res = await fetch(`${base}/teams/rotate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.token).toBe('string');
    expect(body.token).not.toBe(adminToken);
    expect(body.name).toBe('default');

    const oldCheck = await fetch(`${base}/teams/rotate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(oldCheck.status).toBe(401);

    const newCheck = await fetch(`${base}/members`, {
      headers: { Authorization: `Bearer ${body.token}` },
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

  it('rotating the admin token never disturbs a member\'s personal token', async () => {
    await fetch(`${base}/teams/rotate`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` } });

    const stillWorks = await fetch(`${base}/unread`, { headers: headers() });
    expect(stillWorks.status).toBe(200);
  });

  it("does not affect another team's admin token", async () => {
    const adminTokenB = 'ts_http_rotate_teamB';
    createTeam(db, 'Team B', hashToken(adminTokenB), NOW);

    await fetch(`${base}/teams/rotate`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` } });

    const stillWorksForB = await fetch(`${base}/members`, {
      headers: { Authorization: `Bearer ${adminTokenB}` },
    });
    expect(stillWorksForB.status).toBe(200);
  });
});

describe('POST /invites (admin-only: mints a personal token for one named email)', () => {
  it('mints a working member token, returned once', async () => {
    const res = await fetch(`${base}/invites`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'sam@team.com', name: 'Sam' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.email).toBe('sam@team.com');
    expect(body.name).toBe('Sam');
    expect(typeof body.token).toBe('string');

    const check = await fetch(`${base}/unread`, {
      headers: { Authorization: `Bearer ${body.token}` },
    });
    expect(check.status).toBe(200);
  });

  it('defaults the name to the email when omitted', async () => {
    const res = await fetch(`${base}/invites`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'noname@team.com' }),
    });
    const body = await res.json();
    expect(body.name).toBe('noname@team.com');
  });

  it('a member token is rejected — a member cannot mint credentials for anyone, including themselves', async () => {
    const res = await fetch(`${base}/invites`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'sam@team.com' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects a malformed email with 400 and mints nothing', async () => {
    const res = await fetch(`${base}/invites`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email' }),
    });
    expect(res.status).toBe(400);
  });

  it('two separate invites for the same email mint two independent, both-live tokens (the multi-device case)', async () => {
    const first = await (
      await fetch(`${base}/invites`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'sam@team.com', name: 'Sam' }),
      })
    ).json();
    const second = await (
      await fetch(`${base}/invites`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'sam@team.com', name: 'Sam (laptop)' }),
      })
    ).json();
    expect(first.token).not.toBe(second.token);

    const laptop = await fetch(`${base}/unread`, { headers: { Authorization: `Bearer ${first.token}` } });
    const desktop = await fetch(`${base}/unread`, { headers: { Authorization: `Bearer ${second.token}` } });
    expect(laptop.status).toBe(200);
    expect(desktop.status).toBe(200);
  });
});

describe('POST /revoke (admin-only: kills every live token for one email)', () => {
  it('revokes all live tokens for an email; the person 401s and a different email is untouched', async () => {
    const sam1 = createMemberToken(scope, 'sam@team.com', 'Sam', NOW);
    const sam2 = createMemberToken(scope, 'sam@team.com', 'Sam (desktop)', NOW);

    const res = await fetch(`${base}/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'sam@team.com' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).revoked).toBe(2);

    const check1 = await fetch(`${base}/unread`, { headers: { Authorization: `Bearer ${sam1}` } });
    const check2 = await fetch(`${base}/unread`, { headers: { Authorization: `Bearer ${sam2}` } });
    expect(check1.status).toBe(401);
    expect(check2.status).toBe(401);

    // Priya, untouched.
    const priyaCheck = await fetch(`${base}/unread`, { headers: headers() });
    expect(priyaCheck.status).toBe(200);
  });

  it('reports 0 and changes nothing for an email with no live tokens', async () => {
    const res = await fetch(`${base}/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@team.com' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).revoked).toBe(0);
  });

  it('a member token is rejected on /revoke', async () => {
    const res = await fetch(`${base}/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'priya@team.com' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('GET /members (admin or member)', () => {
  it('an admin token sees the roster, including a pre-migration member with no live token as "invited, not yet active"', async () => {
    const res = await fetch(`${base}/members`, { headers: { Authorization: `Bearer ${adminToken}` } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.team).toBe('default');
    const adnan = body.members.find((m: { email: string }) => m.email === 'adnan@team.com');
    const priya = body.members.find((m: { email: string }) => m.email === 'priya@team.com');
    expect(adnan.status).toBe('invited, not yet active');
    expect(priya.status).toBe('active');
  });

  it('a member token also sees the roster (scoped to its own team)', async () => {
    const res = await fetch(`${base}/members`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect((await res.json()).team).toBe('default');
  });

  it('an unknown token is rejected the same way as any other unauthenticated request', async () => {
    const res = await fetch(`${base}/members`, { headers: { Authorization: 'Bearer ts_totally_unknown' } });
    expect(res.status).toBe(401);
  });

  it("a member of team B cannot see team A's roster", async () => {
    const teamB = createTeam(db, 'Team B', hashToken('ts_members_teamB_admin'), NOW);
    const scopeB = makeTeamScope(db, teamB);
    const tokenB = createMemberToken(scopeB, 'b@teamb.com', 'B', NOW);

    const res = await fetch(`${base}/members`, { headers: { Authorization: `Bearer ${tokenB}` } });
    const body = await res.json();
    expect(body.team).toBe('Team B');
    expect(body.members.map((m: { email: string }) => m.email)).not.toContain('priya@team.com');
  });
});

describe('listRoster (data layer)', () => {
  it('reflects revocation immediately', () => {
    createMemberToken(scope, 'sam@team.com', 'Sam', NOW);
    expect(listRoster(scope).find((m) => m.email === 'sam@team.com')?.status).toBe('active');
    revokeMemberTokens(scope, 'sam@team.com', NOW);
    expect(listRoster(scope).find((m) => m.email === 'sam@team.com')?.status).toBe('invited, not yet active');
  });
});
