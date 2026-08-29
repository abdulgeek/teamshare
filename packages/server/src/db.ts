import Database from 'better-sqlite3';
import { randomBytes, createHash } from 'node:crypto';

export type Db = Database.Database;

export interface Member {
  email: string;
  name: string;
  first_seen: string;
  last_seen: string;
}

// A TeamScope is the only thing every data function in shares.ts, unread.ts,
// receipts.ts, and every member function below, will accept. It is
// structurally unforgeable: the brand key is a module-private symbol, so no
// file outside this module can write an object literal that satisfies this
// interface — the only way to produce one is to call makeTeamScope below.
// That makes "pass an unscoped db" a type error everywhere it matters, not a
// convention a reviewer has to remember (see the design doc's Revision note:
// a first draft relied on exactly that convention and leaked cross-team data
// as a result).
const SCOPE_BRAND = Symbol('teamshare.TeamScope');

export interface TeamScope {
  readonly db: Db;
  readonly teamId: string;
  readonly [SCOPE_BRAND]: true;
}

export function makeTeamScope(db: Db, teamId: string): TeamScope {
  return { db, teamId, [SCOPE_BRAND]: true };
}

// The v1 baseline shape. CREATE TABLE IF NOT EXISTS means this is a no-op
// against any database that already has these tables (v1, v2, or a
// migrated v3) — it only ever creates them fresh, at the OLDEST shape, for a
// database that has never been opened before. The versioned migration chain
// below is what carries every database — fresh or legacy — up to the current
// (v3) shape. Do not "upgrade" the shapes declared here: that would make the
// existence check the (forbidden) migration trigger instead of schema_version.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  email      TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shares (
  id           TEXT PRIMARY KEY,
  sender_email TEXT NOT NULL,
  what         TEXT NOT NULL,
  why          TEXT,
  action       TEXT,
  tags         TEXT NOT NULL DEFAULT '[]',
  priority     TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS receipts (
  share_id     TEXT NOT NULL,
  member_email TEXT NOT NULL,
  status       TEXT NOT NULL,
  at           TEXT NOT NULL,
  PRIMARY KEY (share_id, member_email)
);
CREATE INDEX IF NOT EXISTS idx_shares_created ON shares (created_at);
`;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function readConfig(db: Db, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

function setConfig(db: Db, key: string, value: string): void {
  db.prepare(
    `INSERT INTO config (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

function count(db: Db, table: 'members' | 'shares' | 'receipts' | 'teams'): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

// Test-only hook: called immediately after each meaningful DDL sub-step of a
// migration, still inside that step's transaction. A test that makes this
// throw proves the step is atomic — the transaction rolls back everything
// done so far in THAT step, leaving the file at the previous schema_version.
export type MigrationProbe = (label: string) => void;

const NOOP_PROBE: MigrationProbe = () => {};

interface Migration {
  to: number;
  run: (db: Db, nowIso: string, probe: MigrationProbe) => void;
}

// Folds in the patch that used to be applied unconditionally (via a
// PRAGMA table_info existence check) on every openDb call. Nullable column,
// no FK — a plain ALTER TABLE is fine here; SQLite only refuses this for a
// NOT NULL or foreign-key column added to a populated table, which is why
// the 2->3 step below has to rebuild instead.
function migrateAddStaleAt(db: Db, _nowIso: string, probe: MigrationProbe): void {
  db.exec('ALTER TABLE shares ADD COLUMN stale_at TEXT');
  probe('1->2:stale_at');
  setConfig(db, 'schema_version', '2');
  probe('1->2:version');
}

// The multi-team rebuild. members (primary key change) and shares/receipts
// (new NOT NULL column that is conceptually a foreign key) cannot be ALTERed
// in place, so each is rebuilt create-new/copy/drop/rename. Order matters:
// teams first (shares/receipts/members reference its ids), shares before
// receipts (receipts' FK targets shares(team_id, id)), indexes last (a
// rebuild drops them silently along with the table).
function migrateAddMultiTeam(db: Db, nowIso: string, probe: MigrationProbe): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS teams (
      id               TEXT PRIMARY KEY,
      name             TEXT NOT NULL,
      token_hash       TEXT NOT NULL UNIQUE,
      signup_note      TEXT,
      created_at       TEXT NOT NULL,
      created_by_email TEXT
    );
  `);
  probe('2->3:teams-table');

  const token = readConfig(db, 'team_token');
  const hasExistingData = count(db, 'members') > 0 || count(db, 'shares') > 0 || count(db, 'receipts') > 0;

  let defaultTeamId: string | null = null;
  if (token) {
    defaultTeamId = `tm_${randomBytes(6).toString('hex')}`;
    db.prepare(
      `INSERT INTO teams (id, name, token_hash, signup_note, created_at, created_by_email)
       VALUES (?, 'default', ?, NULL, ?, NULL)`,
    ).run(defaultTeamId, hashToken(token), nowIso);
  } else if (hasExistingData) {
    // Minting a team nobody can authenticate into would silently strand a
    // real team's data. Fail loudly instead — the operator's remedy is to
    // restore the token or run `teamshare create-team`.
    throw new Error(
      'cannot migrate: this database has existing members, shares, or receipts but no ' +
        'config.team_token, so a new team would be unreachable. Restore the token, or run ' +
        '`teamshare create-team` after upgrading.',
    );
  }
  // else: no token and no rows — a fresh install. Leave `teams` empty; the
  // first authenticated request bootstraps a team lazily (getOrCreateDefaultTeamId).
  probe('2->3:default-team');

  db.exec(`
    CREATE TABLE members_new (
      team_id    TEXT NOT NULL,
      email      TEXT NOT NULL,
      name       TEXT NOT NULL,
      first_seen TEXT NOT NULL,
      last_seen  TEXT NOT NULL,
      PRIMARY KEY (team_id, email)
    );
  `);
  if (defaultTeamId) {
    db.prepare(
      `INSERT INTO members_new (team_id, email, name, first_seen, last_seen)
       SELECT ?, email, name, first_seen, last_seen FROM members`,
    ).run(defaultTeamId);
  }
  db.exec('DROP TABLE members;');
  db.exec('ALTER TABLE members_new RENAME TO members;');
  probe('2->3:members');

  db.exec(`
    CREATE TABLE shares_new (
      id           TEXT NOT NULL,
      team_id      TEXT NOT NULL,
      sender_email TEXT NOT NULL,
      what         TEXT NOT NULL,
      why          TEXT,
      action       TEXT,
      tags         TEXT NOT NULL DEFAULT '[]',
      priority     TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      stale_at     TEXT,
      PRIMARY KEY (id),
      UNIQUE (team_id, id)
    );
  `);
  if (defaultTeamId) {
    db.prepare(
      `INSERT INTO shares_new (id, team_id, sender_email, what, why, action, tags, priority, created_at, stale_at)
       SELECT id, ?, sender_email, what, why, action, tags, priority, created_at, stale_at FROM shares`,
    ).run(defaultTeamId);
  }
  db.exec('DROP TABLE shares;');
  db.exec('ALTER TABLE shares_new RENAME TO shares;');
  probe('2->3:shares');

  db.exec(`
    CREATE TABLE receipts_new (
      team_id      TEXT NOT NULL,
      share_id     TEXT NOT NULL,
      member_email TEXT NOT NULL,
      status       TEXT NOT NULL,
      at           TEXT NOT NULL,
      PRIMARY KEY (team_id, share_id, member_email),
      FOREIGN KEY (team_id, share_id) REFERENCES shares (team_id, id) ON DELETE CASCADE
    );
  `);
  if (defaultTeamId) {
    db.prepare(
      `INSERT INTO receipts_new (team_id, share_id, member_email, status, at)
       SELECT ?, share_id, member_email, status, at FROM receipts`,
    ).run(defaultTeamId);
  }
  db.exec('DROP TABLE receipts;');
  db.exec('ALTER TABLE receipts_new RENAME TO receipts;');
  probe('2->3:receipts');

  // A rebuild (create-new/drop/rename) drops the old table's indexes along
  // with it. Recreate them explicitly, on the new team-scoped shape, or a
  // migrated instance silently runs unindexed while a fresh one is fine.
  db.exec('DROP INDEX IF EXISTS idx_shares_created;');
  db.exec('CREATE INDEX IF NOT EXISTS idx_shares_team_created ON shares (team_id, created_at);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_receipts_team_share ON receipts (team_id, share_id);');
  probe('2->3:indexes');

  setConfig(db, 'schema_version', '3');
  probe('2->3:version');
}

// The per-user-token rebuild (see docs/superpowers/specs/2026-08-30-teamshare-invites-design.md).
// A brand-new table — no existing table changes shape, so this is a plain
// CREATE, not a rebuild. Deliberately NOT folded into the frozen v1 SCHEMA
// constant: that constant only ever describes the oldest possible shape, and
// this table doesn't exist there even on a fresh install — the migration
// chain is what carries every database, fresh or legacy, up to v4.
//
// token_hash is the PRIMARY KEY, not (team_id, email): one person can hold
// several live tokens (laptop, desktop, CI) and revocation is an explicit,
// targeted act rather than a side effect of a single-slot key. See the
// rejected per-user-tokens design's Review outcome for why (team_id, email)
// as a key produced a one-request permanent lockout of any named teammate.
//
// Mints nothing: this step creates an empty table. There is no channel to
// deliver a token to the six-ish existing members of a live install, so
// every one of them 401s on their next request until the lead invites them —
// a deliberate, one-time break (see http.ts's INVALID_MEMBER_TOKEN_MESSAGE).
function migrateAddMemberTokens(db: Db, _nowIso: string, probe: MigrationProbe): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS member_tokens (
      token_hash   TEXT PRIMARY KEY,
      team_id      TEXT NOT NULL,
      email        TEXT NOT NULL,
      name         TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at   TEXT
    );
  `);
  probe('3->4:member_tokens-table');

  db.exec('CREATE INDEX IF NOT EXISTS idx_member_tokens_team_email ON member_tokens (team_id, email);');
  probe('3->4:index');

  setConfig(db, 'schema_version', '4');
  probe('3->4:version');
}

const MIGRATIONS: Migration[] = [
  { to: 2, run: migrateAddStaleAt },
  { to: 3, run: migrateAddMultiTeam },
  { to: 4, run: migrateAddMemberTokens },
];

export const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].to;

// Exported so tests can fault-inject: build a legacy-shaped database file by
// hand (as a real pre-upgrade install would look), then call this directly
// with a probe that throws at a specific point, and assert the file is
// still at its pre-migration version. openDb calls this with a no-op probe.
export function migrateSchema(db: Db, nowIso: string, probe: MigrationProbe = NOOP_PROBE): void {
  // SCHEMA always creates the v1-baseline shape for tables that don't exist
  // yet — a genuinely fresh database — and is a no-op for anything already
  // on disk (v1, v2, or v3), which is why the trigger below must be the
  // recorded version number, never a table-existence check: by this point
  // every table already exists either way.
  db.exec(SCHEMA);

  // Absent key means either a genuinely fresh database (SCHEMA just created
  // the v1-baseline shape above, so version 1 is accurate) or a real v1
  // install that predates this column ever being written. Both cases are
  // correctly described by defaulting to 1.
  let current = Number(readConfig(db, 'schema_version') ?? 1);

  for (const migration of MIGRATIONS) {
    if (migration.to <= current) continue;
    const step = db.transaction(() => migration.run(db, nowIso, probe));
    step();
    current = migration.to;
  }
}

export function openDb(path: string): Db {
  const db = new Database(path);
  // WAL keeps concurrent reads safe. Skip for in-memory databases.
  if (path !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  try {
    migrateSchema(db, new Date().toISOString());
  } catch (err) {
    db.close(); // don't leak an open handle on a database we're refusing to serve
    throw err;
  }
  return db;
}

function setToken(db: Db, token: string): void {
  setConfig(db, 'team_token', token);
}

// Lets a caller (the `serve` CLI path) tell whether a token already existed
// BEFORE calling getOrCreateToken, which would otherwise mint one and erase
// that distinction — the print-once behavior depends on checking this first.
export function hasToken(db: Db): boolean {
  return readConfig(db, 'team_token') !== undefined;
}

export function getOrCreateToken(db: Db): string {
  const existing = readConfig(db, 'team_token');
  if (existing) return existing;
  const token = `ts_${randomBytes(24).toString('hex')}`;
  setToken(db, token);
  return token;
}

export function rotateToken(db: Db): string {
  const token = `ts_${randomBytes(24).toString('hex')}`;
  setToken(db, token);
  return token;
}

// Was the Stage-1 compatibility bridge for a production request path that no
// longer exists: real per-team auth (http.ts's authenticate()) now resolves
// a request's team from its bearer token via findTeamByTokenHash, so
// app.ts/mcp.ts/cli.ts no longer call this. It remains as a test-fixture
// convenience — "give me a single team, lazily and idempotently" is still a
// useful shape for tests that don't care which team they get, one just like
// a migrated production database already has (created during the 2->3
// migration from its existing config.team_token).
export function getOrCreateDefaultTeamId(db: Db): string {
  const existing = db.prepare('SELECT id FROM teams LIMIT 1').get() as { id: string } | undefined;
  if (existing) return existing.id;
  const token = getOrCreateToken(db);
  const id = `tm_${randomBytes(6).toString('hex')}`;
  db.prepare(
    `INSERT INTO teams (id, name, token_hash, signup_note, created_at, created_by_email)
     VALUES (?, 'default', ?, NULL, ?, NULL)`,
  ).run(id, hashToken(token), new Date().toISOString());
  return id;
}

// Data-layer primitive for creating an additional team — this is the honest
// mechanism underneath the signup-gated POST /teams surface (http.ts/app.ts),
// and is also used directly by tests that need a genuine two-team fixture.
export function createTeam(
  db: Db,
  name: string,
  tokenHash: string,
  nowIso: string,
  createdByEmail: string | null = null,
): string {
  const id = `tm_${randomBytes(6).toString('hex')}`;
  db.prepare(
    `INSERT INTO teams (id, name, token_hash, signup_note, created_at, created_by_email)
     VALUES (?, ?, ?, NULL, ?, ?)`,
  ).run(id, name, tokenHash, nowIso, createdByEmail);
  return id;
}

export interface TeamRow {
  id: string;
  name: string;
}

// The auth-path lookup: SHA-256 of a presented bearer token -> the team it
// belongs to, or undefined. `teams.token_hash` is UNIQUE and indexed, so this
// is the single query authenticate() needs to resolve a request to a team.
export function findTeamByTokenHash(db: Db, tokenHash: string): TeamRow | undefined {
  return db.prepare('SELECT id, name FROM teams WHERE token_hash = ?').get(tokenHash) as
    | TeamRow
    | undefined;
}

// Used by the CLI (rotate-token/remove-member --team <name>) to resolve an
// operator-named team. Not part of the HTTP auth path, so "team not found"
// can be reported honestly here — the operator already has filesystem
// access to the database, so there is no cross-tenant oracle to protect
// against the way there is on the authenticated HTTP/MCP surface.
export function findTeamByName(db: Db, name: string): TeamRow | undefined {
  return db.prepare('SELECT id, name FROM teams WHERE name = ?').get(name) as TeamRow | undefined;
}

// Resolves a team by id — used by authenticate() (http.ts) to recover a
// team's display name after a member token has already resolved teamId, and
// by anything else that only has an id in hand (never the auth path's first
// lookup; that's findTeamByTokenHash/findMemberByTokenHash).
export function findTeamById(db: Db, id: string): TeamRow | undefined {
  return db.prepare('SELECT id, name FROM teams WHERE id = ?').get(id) as TeamRow | undefined;
}

export function listTeams(db: Db): TeamRow[] {
  return db.prepare('SELECT id, name FROM teams ORDER BY name').all() as TeamRow[];
}

export function countTeams(db: Db): number {
  return count(db, 'teams');
}

export function generateTeamToken(): string {
  return `ts_${randomBytes(24).toString('hex')}`;
}

// §Rotation: replaces one team's token_hash, authenticated by its current
// token (see http.ts's authenticateTeamOnly / POST /teams/rotate), or driven
// directly by the CLI's rotate-token --team path. Returns the new plaintext
// token once; it is not recoverable afterwards.
export function rotateTeamToken(db: Db, teamId: string): string {
  const token = generateTeamToken();
  db.prepare('UPDATE teams SET token_hash = ? WHERE id = ?').run(hashToken(token), teamId);
  return token;
}

// §Creating a team: the instance-wide signup secret that gates POST /teams.
// Stored plaintext in `config` (same table/pattern as the legacy team_token)
// deliberately — see the design doc: it gates creation only, never grants
// access to any team's data, and recoverability (an operator can retrieve it
// with `teamshare signup-secret --show`) matters more than hashing it would.
export function getSignupSecret(db: Db): string | undefined {
  return readConfig(db, 'signup_secret');
}

// `explicit`, when given, comes from --signup-secret or TEAMSHARE_SIGNUP_SECRET
// (cli.ts resolves precedence) and is persisted so it survives even if the
// flag/env var is absent on a later boot — the whole point being that the
// operator never has to run an SSM-style ritual to recover it. Absent an
// explicit value, this reuses whatever secret already exists, and mints one
// only the very first time, exactly like getOrCreateToken.
export function getOrCreateSignupSecret(db: Db, explicit?: string): { secret: string; generated: boolean } {
  if (explicit) {
    setConfig(db, 'signup_secret', explicit);
    return { secret: explicit, generated: false };
  }
  const existing = readConfig(db, 'signup_secret');
  if (existing) return { secret: existing, generated: false };
  const secret = `tss_${randomBytes(24).toString('hex')}`;
  setConfig(db, 'signup_secret', secret);
  return { secret, generated: true };
}

export function upsertMember(scope: TeamScope, email: string, name: string, nowIso: string): void {
  scope.db
    .prepare(
      `INSERT INTO members (team_id, email, name, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(team_id, email) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen`,
    )
    .run(scope.teamId, normalizeEmail(email), name, nowIso, nowIso);
}

export function listMembers(scope: TeamScope): Member[] {
  return scope.db
    .prepare('SELECT email, name, first_seen, last_seen FROM members WHERE team_id = ? ORDER BY email')
    .all(scope.teamId) as Member[];
}

export function removeMember(scope: TeamScope, email: string): boolean {
  const info = scope.db
    .prepare('DELETE FROM members WHERE team_id = ? AND email = ?')
    .run(scope.teamId, normalizeEmail(email));
  return info.changes > 0;
}

// ---------------------------------------------------------------------------
// Member tokens (§Identity comes from the token). See
// docs/superpowers/specs/2026-08-30-teamshare-invites-design.md.
//
// A member token IS its holder's credential — there is no join/redemption
// step. `teams.token_hash` (above) is now the ADMIN credential exclusively:
// it mints/revokes member tokens and reads the roster, but grants no access
// to shares, receipts, or the digest. These two credential kinds are
// resolved by separate functions in http.ts (authenticateAdmin/
// authenticate), never a single resolver returning a `kind` — see that
// file's comment for why a shared resolver is the wrong shape here.
// ---------------------------------------------------------------------------

export function generateMemberToken(): string {
  return `tsm_${randomBytes(24).toString('hex')}`;
}

// Mints a brand-new, independent credential for (team, email) — never
// updates or replaces an existing one. A person can hold several of these at
// once (laptop, desktop, CI); each is revoked individually, not as a side
// effect of minting another. Returned once, in plaintext; only the hash is
// stored.
export function createMemberToken(scope: TeamScope, email: string, name: string, nowIso: string): string {
  const token = generateMemberToken();
  scope.db
    .prepare(
      `INSERT INTO member_tokens (token_hash, team_id, email, name, created_at, last_used_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
    )
    .run(hashToken(token), scope.teamId, normalizeEmail(email), name, nowIso);
  return token;
}

export interface MemberIdentity {
  teamId: string;
  email: string;
  name: string;
}

// The member-auth-path lookup: SHA-256 of a presented bearer token -> the
// identity it belongs to, or undefined — mirroring findTeamByTokenHash's
// shape exactly, but against member_tokens and filtered to revoked_at IS
// NULL, so a revoked credential is indistinguishable from one that never
// existed (no oracle either way).
export function findMemberByTokenHash(db: Db, tokenHash: string): MemberIdentity | undefined {
  const row = db
    .prepare(`SELECT team_id, email, name FROM member_tokens WHERE token_hash = ? AND revoked_at IS NULL`)
    .get(tokenHash) as { team_id: string; email: string; name: string } | undefined;
  return row ? { teamId: row.team_id, email: row.email, name: row.name } : undefined;
}

// Called on every successful member authentication (see http.ts's
// authenticate()) so the roster can eventually report per-token recency,
// distinct from members.last_seen (which is per-person, not per-credential).
export function touchMemberTokenUsage(db: Db, tokenHash: string, nowIso: string): void {
  db.prepare('UPDATE member_tokens SET last_used_at = ? WHERE token_hash = ?').run(nowIso, tokenHash);
}

// Revokes every LIVE token for one email within one team — this is what
// makes removing an ex-employee a single command rather than a per-device
// hunt. Returns how many were actually revoked (0 means nothing was live,
// not an error). Idempotent: revoking twice is a no-op the second time.
export function revokeMemberTokens(scope: TeamScope, email: string, nowIso: string): number {
  const info = scope.db
    .prepare(
      `UPDATE member_tokens SET revoked_at = ? WHERE team_id = ? AND email = ? AND revoked_at IS NULL`,
    )
    .run(nowIso, scope.teamId, normalizeEmail(email));
  return info.changes;
}

export interface RosterEntry {
  email: string;
  name: string | null;
  first_seen: string | null;
  last_seen: string | null;
  active_tokens: number;
  status: 'active' | 'invited, not yet active';
}

// The roster GET /members renders: a union of everyone who has ever
// authenticated (the `members` table — the historical roster, unaffected by
// this change) and everyone who has ever been minted a token (member_tokens,
// grouped by email). A pre-migration member with no live token yet reads as
// "invited, not yet active" — this is deliberate: it makes the roster the
// migration's own progress bar, per the design doc, rather than a second
// place that needs its own "is this real" logic.
export function listRoster(scope: TeamScope): RosterEntry[] {
  const membersByEmail = new Map(listMembers(scope).map((m) => [m.email, m]));

  const tokenRows = scope.db
    .prepare(
      `SELECT email,
              SUM(CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END) AS active_tokens,
              MAX(CASE WHEN revoked_at IS NULL THEN name END) AS live_name,
              MAX(name) AS any_name
         FROM member_tokens
        WHERE team_id = ?
        GROUP BY email`,
    )
    .all(scope.teamId) as { email: string; active_tokens: number; live_name: string | null; any_name: string }[];
  const tokensByEmail = new Map(tokenRows.map((r) => [r.email, r]));

  const emails = new Set<string>([...membersByEmail.keys(), ...tokensByEmail.keys()]);
  const roster: RosterEntry[] = [];
  for (const email of emails) {
    const member = membersByEmail.get(email);
    const tokenInfo = tokensByEmail.get(email);
    const activeTokens = tokenInfo?.active_tokens ?? 0;
    roster.push({
      email,
      name: member?.name ?? tokenInfo?.live_name ?? tokenInfo?.any_name ?? null,
      first_seen: member?.first_seen ?? null,
      last_seen: member?.last_seen ?? null,
      active_tokens: activeTokens,
      status: activeTokens > 0 ? 'active' : 'invited, not yet active',
    });
  }
  return roster.sort((a, b) => a.email.localeCompare(b.email));
}
