import express, { type Request } from 'express';
import {
  countTeams,
  createMemberToken,
  createTeam,
  generateTeamToken,
  hashToken,
  listRoster,
  revokeMemberTokens,
  rotateTeamToken,
  type Db,
} from './db.js';
import {
  authenticate,
  authenticateAdmin,
  touchMember,
  validateInviteEmail,
  validateInviteName,
  validateTeamName,
  verifySignupSecret,
} from './http.js';
import { getUnread } from './unread.js';
import { registerMcpRoute } from './mcp.js';

export interface SignupRateLimitOptions {
  windowMs: number;
  max: number;
}

export interface AppOptions {
  db: Db;
  expiryDays: number;
  now?: () => string;
  // §Creating a team: gates POST /teams. `null`/`undefined` together with
  // `openSignup: false` means the gate can never be satisfied — fail
  // closed rather than accidentally open when misconfigured. Plaintext by
  // design (see the design doc): it gates creation only, never grants
  // access to any team's data.
  signupSecret?: string | null;
  // Disables the signup-secret gate entirely. cli.ts is responsible for
  // logging the loud startup warning this implies; this flag alone carries
  // no such warning.
  openSignup?: boolean;
  // Instance-wide cap on total teams. undefined = unlimited.
  maxTeams?: number;
  signupRateLimit?: SignupRateLimitOptions;
}

// A few lines, in-process, per the design doc: bounds how many team-creation
// attempts one source IP can make in a window, so a leaked or brute-forced
// signup secret cannot be used to mint unlimited teams. Keyed off the app's
// own now() clock (not wall time) so tests never need a real timer.
const DEFAULT_SIGNUP_RATE_LIMIT: SignupRateLimitOptions = { windowMs: 10 * 60_000, max: 5 };

function createSignupRateLimiter(opts: SignupRateLimitOptions) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return function allow(key: string, nowMs: number): boolean {
    const entry = hits.get(key);
    if (!entry || nowMs >= entry.resetAt) {
      hits.set(key, { count: 1, resetAt: nowMs + opts.windowMs });
      return true;
    }
    if (entry.count >= opts.max) return false;
    entry.count += 1;
    return true;
  };
}

function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

export function createApp(opts: AppOptions): express.Express {
  const { db, expiryDays } = opts;
  const now = opts.now ?? (() => new Date().toISOString());
  const openSignup = Boolean(opts.openSignup);
  const signupSecret = opts.signupSecret ?? null;
  const maxTeams = opts.maxTeams;
  const allowSignupAttempt = createSignupRateLimiter(opts.signupRateLimit ?? DEFAULT_SIGNUP_RATE_LIMIT);

  const app = express();
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Fast door for the SessionStart hook: same auth and identity as /mcp, but
  // no MCP handshake so the hook stays a dependency-free script.
  app.get('/unread', (req, res) => {
    const nowIso = now();
    const auth = authenticate(db, req, nowIso);
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.message });
      return;
    }
    touchMember(auth.scope, auth.identity, nowIso);
    // `team` rides along on this response (not a new endpoint) so `doctor`,
    // which already calls /unread, can report which team a token belongs to
    // without an extra round trip.
    res.json({ ...getUnread(auth.scope, auth.identity.email, nowIso, expiryDays), team: auth.teamName });
  });

  // §Creating a team. Gated by the instance signup secret in
  // X-Teamshare-Signup-Secret, unless openSignup disables the gate (the
  // operator's explicit, loudly-warned choice — see cli.ts). The rate limit
  // and maxTeams cap apply either way: the secret leaking eventually is the
  // assumption, not a possibility, per the design doc.
  app.post('/teams', (req, res) => {
    const ip = clientIp(req);
    if (!allowSignupAttempt(ip, Date.parse(now()))) {
      res.status(429).json({ error: 'too many team-creation attempts from this address — try again later' });
      return;
    }

    if (!openSignup) {
      const provided = (req.get('x-teamshare-signup-secret') ?? '').trim();
      if (!signupSecret || !provided || !verifySignupSecret(signupSecret, provided)) {
        res.status(401).json({ error: 'invalid or missing signup secret' });
        return;
      }
    }

    const nameCheck = validateTeamName((req.body as Record<string, unknown> | undefined)?.name);
    if (!nameCheck.ok) {
      res.status(400).json({ error: nameCheck.error });
      return;
    }

    if (maxTeams !== undefined && countTeams(db) >= maxTeams) {
      res.status(403).json({ error: `this instance has reached its team limit (${maxTeams})` });
      return;
    }

    const token = generateTeamToken();
    const teamId = createTeam(db, nameCheck.value, hashToken(token), now());
    // Returned once, here, and never again — the plaintext is not stored or
    // recoverable after this response.
    res.status(201).json({ team_id: teamId, name: nameCheck.value, token });
  });

  // §Rotation. Authenticated by the team's *current* (admin) token — not the
  // signup secret — self-serve, no operator involvement, and the required
  // remedy for a leaked admin token. cli.ts's `rotate-token --team` is the
  // equivalent break-glass path for an operator with filesystem access to
  // the database. Rotating this token never disturbs any member's personal
  // token — the two credential kinds are now completely independent.
  app.post('/teams/rotate', (req, res) => {
    const auth = authenticateAdmin(db, req);
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.message });
      return;
    }
    const token = rotateTeamToken(db, auth.scope.teamId);
    res.json({ team_id: auth.scope.teamId, name: auth.teamName, token });
  });

  // §Identity comes from the token. Admin-only: mints a personal credential
  // for one named email, never asserted by the joiner. Rate-limited with the
  // exact same per-IP limiter POST /teams uses (deliberately shared, not a
  // second independent bucket) — an admin token leaking should not let an
  // attacker mint unlimited member credentials any more than a leaked
  // signup secret should mint unlimited teams.
  app.post('/invites', (req, res) => {
    const ip = clientIp(req);
    if (!allowSignupAttempt(ip, Date.parse(now()))) {
      res.status(429).json({ error: 'too many invite attempts from this address — try again later' });
      return;
    }

    const auth = authenticateAdmin(db, req);
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.message });
      return;
    }

    const body = req.body as Record<string, unknown> | undefined;
    const emailCheck = validateInviteEmail(body?.email);
    if (!emailCheck.ok) {
      res.status(400).json({ error: emailCheck.error });
      return;
    }
    const nameCheck = validateInviteName(body?.name);
    if (!nameCheck.ok) {
      res.status(400).json({ error: nameCheck.error });
      return;
    }
    const name = nameCheck.value ?? emailCheck.value;

    const token = createMemberToken(auth.scope, emailCheck.value, name, now());
    // Returned once, here, and never again — same "shown once, hashed at
    // rest" contract as every other credential this server mints.
    res.status(201).json({ email: emailCheck.value, name, token });
  });

  // Admin-only: revokes every LIVE token for one email, across every device
  // that email was ever given one — this is the one-command remedy for an
  // ex-employee the design doc exists to provide. Not scoped to a single
  // token, deliberately: a partial revoke would leave a forgotten laptop
  // token live.
  app.post('/revoke', (req, res) => {
    const auth = authenticateAdmin(db, req);
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.message });
      return;
    }

    const body = req.body as Record<string, unknown> | undefined;
    const emailCheck = validateInviteEmail(body?.email);
    if (!emailCheck.ok) {
      res.status(400).json({ error: emailCheck.error });
      return;
    }

    const revoked = revokeMemberTokens(auth.scope, emailCheck.value, now());
    res.json({ email: emailCheck.value, revoked });
  });

  // Admin OR member — deliberately tried as two independent, self-contained
  // resolvers in sequence, never a merged "auth that accepts either kind"
  // function: each one either fully grants access on its own terms or
  // fully refuses, so there is no shared code path a future route could
  // misread. Scoped through TeamScope like every other route, so this can
  // never become a cross-team oracle.
  app.get('/members', (req, res) => {
    const adminAuth = authenticateAdmin(db, req);
    if (adminAuth.ok) {
      res.json({ team: adminAuth.teamName, members: listRoster(adminAuth.scope) });
      return;
    }
    const memberAuth = authenticate(db, req, now());
    if (!memberAuth.ok) {
      res.status(memberAuth.status).json({ error: memberAuth.message });
      return;
    }
    res.json({ team: memberAuth.teamName, members: listRoster(memberAuth.scope) });
  });

  registerMcpRoute(app, opts);

  return app;
}
