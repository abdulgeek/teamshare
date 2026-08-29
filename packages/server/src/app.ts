import express from 'express';
import { getOrCreateDefaultTeamId, makeTeamScope, type Db } from './db.js';
import { authenticate, touchMember } from './http.js';
import { getUnread } from './unread.js';
import { registerMcpRoute } from './mcp.js';

export interface AppOptions {
  db: Db;
  expiryDays: number;
  now?: () => string;
}

export function createApp(opts: AppOptions): express.Express {
  const { db, expiryDays } = opts;
  const now = opts.now ?? (() => new Date().toISOString());

  const app = express();
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Fast door for the SessionStart hook: same auth and identity as /mcp, but
  // no MCP handshake so the hook stays a dependency-free script.
  app.get('/unread', (req, res) => {
    const auth = authenticate(db, req);
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.message });
      return;
    }
    const nowIso = now();
    // Stage-1 compatibility: this server still models exactly one team, so
    // every request scopes to that sole team. Real per-team resolution from
    // auth is the next stage; see db.ts's getOrCreateDefaultTeamId.
    const scope = makeTeamScope(db, getOrCreateDefaultTeamId(db));
    touchMember(scope, auth.identity, nowIso);
    res.json(getUnread(scope, auth.identity.email, nowIso, expiryDays));
  });

  registerMcpRoute(app, opts);

  return app;
}
