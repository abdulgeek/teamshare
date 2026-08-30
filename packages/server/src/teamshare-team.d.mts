// Hand-authored type declarations for teamshare-team.mjs — the single
// plain-JS implementation shared by the standalone script and the
// `teamshare` CLI's `create-team` break-glass wiring
// (packages/server/src/team.ts re-exports from here). Kept in sync by hand;
// there is no build step that generates this file.

export const SIGNUP_SECRET_ENV: string;
export const TEAM_TOKEN_ENV: string;
export const ADMIN_TOKEN_ENV: string;
export const SERVER_URL_ENV: string;
/** teamshare's own deployment — the address baked in so nobody has to paste one. */
export const DEFAULT_SERVER_URL: string;
export const ADMIN_STORE_DIRNAME: string;
export const ADMIN_STORE_FILENAME: string;
export const TEAM_COMMANDS: string[];

export function adminTokenFromEnv(env: Record<string, string | undefined>): string | undefined;

/** True only for an explicit http(s) URL — what disambiguates an optional leading server argument. */
export function looksLikeServerUrl(value: string | undefined): boolean;

/** `node teamshare-team.mjs` when run as a file, `teamshare-team` when run from the plugin's bin/. */
export function invocationName(argv1?: string): string;

export interface ClientConfig {
  url?: string;
  token?: string;
  name?: string;
  email?: string;
}

export function readClientConfig(opts?: {
  homeDir?: string;
  readFileSync?: (path: string, encoding: string) => string;
}): ClientConfig | null;

export type ServerUrlSource = 'argument' | 'flag' | 'env' | 'config-file' | 'default';

export function resolveServerUrl(opts?: {
  positional?: string;
  flag?: string;
  env?: Record<string, string | undefined>;
  clientConfig?: ClientConfig | null;
}): { url: string; source: ServerUrlSource };

export interface AdminStoreEntry {
  url: string;
  team_id: string;
  name: string;
  token: string;
  created_at: string;
}

export interface AdminStore {
  version: number;
  teams: AdminStoreEntry[];
}

export function adminStorePath(homeDir?: string): string;
export function readAdminStore(opts?: { homeDir?: string; fs?: typeof import('node:fs') }): AdminStore;
export function adminEntriesFor(store: AdminStore, url: string): AdminStoreEntry[];

export function saveAdminEntry(opts: {
  url: string;
  teamId: string;
  name: string;
  token: string;
  homeDir?: string;
  fs?: typeof import('node:fs');
  now?: string;
}): { ok: true; path: string } | { ok: false; message: string };

export type ResolveAdminTokenResult =
  | { ok: true; token: string; source: 'env' | 'store'; team?: AdminStoreEntry }
  | { ok: false; reason: 'none-saved' }
  | { ok: false; reason: 'ambiguous' | 'no-such-team'; names: string[] };

export function resolveAdminTokenFromStore(opts: {
  url: string;
  env?: Record<string, string | undefined>;
  teamName?: string;
  homeDir?: string;
  fs?: typeof import('node:fs');
}): ResolveAdminTokenResult;

/** The personal (member) token this machine holds — a different credential from the admin token. */
export function resolveMemberToken(opts?: {
  env?: Record<string, string | undefined>;
  clientConfig?: ClientConfig | null;
}): string | undefined;

export function checkMemberToken(opts: {
  url: string;
  token?: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}): Promise<{ ok: boolean; line: string }>;

export interface GitIdentity {
  name: string;
  email: string;
}

export interface ResolveIdentityOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export function resolveGitIdentity(opts?: ResolveIdentityOptions): GitIdentity | null;
export function normalizeServerUrl(url: string): string;

export type SecretSource = 'env' | 'prompt' | 'none';

export function resolveSecretSource(envValue: string | undefined, isTTY: boolean): SecretSource;

export interface PromptStreams {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

export function promptHidden(promptText: string, streams?: PromptStreams): Promise<string | null>;

export interface ResolveSecretOptions {
  envValue: string | undefined;
  isTTY: boolean;
  promptText: string;
  promptFn?: (promptText: string, streams?: PromptStreams) => Promise<string | null>;
  streams?: PromptStreams;
}

export type ResolveSecretResult =
  | { ok: true; value: string; source: 'env' | 'prompt' }
  | { ok: false; reason: string };

export function resolveSecret(opts: ResolveSecretOptions): Promise<ResolveSecretResult>;

export type FetchImpl = typeof fetch;

export interface CreateTeamOverHttpOptions {
  url: string;
  name: string;
  secret: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}

export interface RotateTeamOverHttpOptions {
  url: string;
  token: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}

export type TeamHttpResult =
  | { ok: true; teamId: string; name: string; token: string }
  | { ok: false; status: number; message: string };

export function createTeamOverHttp(opts: CreateTeamOverHttpOptions): Promise<TeamHttpResult>;
export function rotateTeamOverHttp(opts: RotateTeamOverHttpOptions): Promise<TeamHttpResult>;

export interface InviteMemberOverHttpOptions {
  url: string;
  adminToken: string;
  email: string;
  name?: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}

export type InviteHttpResult =
  | { ok: true; email: string; name: string; token: string }
  | { ok: false; status: number; message: string };

export function inviteMemberOverHttp(opts: InviteMemberOverHttpOptions): Promise<InviteHttpResult>;

export interface RevokeMemberOverHttpOptions {
  url: string;
  adminToken: string;
  email: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}

export type RevokeHttpResult =
  | { ok: true; email: string; revoked: number }
  | { ok: false; status: number; message: string };

export function revokeMemberOverHttp(opts: RevokeMemberOverHttpOptions): Promise<RevokeHttpResult>;

export interface RosterEntryOverHttp {
  email: string;
  name: string | null;
  status: 'active' | 'invited, not yet active';
  active_tokens: number;
  first_seen: string | null;
  last_seen: string | null;
}

export interface GetRosterOverHttpOptions {
  url: string;
  adminToken: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}

export type RosterHttpResult =
  | { ok: true; team: string; members: RosterEntryOverHttp[] }
  | { ok: false; status: number; message: string };

export function getRosterOverHttp(opts: GetRosterOverHttpOptions): Promise<RosterHttpResult>;

export interface VerifyTeamOptions {
  url: string;
  token: string;
  // No longer read: verifying an admin token now checks GET /members, which
  // needs no per-user identity. Accepted so existing call sites (which still
  // pass the resolved git identity through) don't need to change.
  identity?: GitIdentity | null;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}

export interface VerifyTeamResult {
  healthy: boolean;
  lines: string[];
}

export function verifyTeam(opts: VerifyTeamOptions): Promise<VerifyTeamResult>;

export interface JoinInstructionsOptions {
  url: string;
  token: string;
}

export function formatJoinInstructions(opts: JoinInstructionsOptions): string;
export function formatTokenOnceWarning(token: string): string;

export interface AdminTokenGuidanceOptions {
  url: string;
}

// Printed next to a fresh or rotated ADMIN token instead of join
// instructions — that token 401s on every data route and the MCP
// connection, so it cannot be used to join. Points the reader at minting
// their own personal token with `invite` instead.
export function formatAdminTokenGuidance(opts: AdminTokenGuidanceOptions): string;

export interface FormatTeamOutputOptions {
  url: string;
  team: { teamId: string; name: string; token: string };
  verify: VerifyTeamResult;
  /** How this file was invoked, so printed suggestions are pasteable. */
  cmdName?: string;
  /** Where the admin token was saved, when it was. */
  savedPath?: string;
  /** Why saving failed, when it did — surfaced rather than swallowed. */
  saveError?: string;
}

export function formatCreateOutput(opts: FormatTeamOutputOptions): string;
export function formatRotateOutput(opts: FormatTeamOutputOptions): string;

export function formatMemberTokenOnceWarning(email: string, token: string): string;

export interface FormatInviteOutputOptions {
  url: string;
  email: string;
  name: string;
  token: string;
}

export function formatInviteOutput(opts: FormatInviteOutputOptions): string;

export interface FormatRevokeOutputOptions {
  email: string;
  revoked: number;
}

export function formatRevokeOutput(opts: FormatRevokeOutputOptions): string;

export interface FormatRosterOutputOptions {
  team: string;
  members: RosterEntryOverHttp[];
  cmdName?: string;
}

export function formatRosterOutput(opts: FormatRosterOutputOptions): string;

export interface FormatWhoamiOutputOptions {
  url: string;
  urlSource: ServerUrlSource;
  adminTeams?: AdminStoreEntry[];
  memberCheck?: { ok: boolean; line: string };
  cmdName?: string;
}

export function formatWhoamiOutput(opts: FormatWhoamiOutputOptions): string;

export interface ParsedTeamArgv {
  cmd?: 'create-team' | 'rotate-team' | 'invite' | 'revoke' | 'roster' | 'whoami' | 'unknown';
  /** Only set when a leading positional actually looked like a URL. */
  url?: string;
  serverFlag?: string;
  teamName?: string;
  name?: string;
  email?: string;
  help: boolean;
  unknown?: string;
  badFlag?: string;
}

export function parseTeamArgv(argv: string[]): ParsedTeamArgv;

export interface RunTeamCliOptions {
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
  fetchImpl?: FetchImpl;
  /** Skip git entirely when provided (including `null` to force the no-identity path). */
  identity?: GitIdentity | null;
  gitIdentityOptions?: ResolveIdentityOptions;
  promptFn?: (promptText: string, streams?: PromptStreams) => Promise<string | null>;
  streams?: PromptStreams;
  /** Override the home directory the admin-token store and ~/.teamshare.json resolve against. */
  homeDir?: string;
  /** Inject a filesystem so tests never touch the real one. */
  fs?: typeof import('node:fs');
  /** Stand-in for process.argv[1], which decides how printed commands are spelled. */
  argv1?: string;
  /** Fixed timestamp for saved store entries, so output is deterministic under test. */
  now?: string;
}

export interface RunTeamCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function runTeamCli(argv: string[], opts?: RunTeamCliOptions): Promise<RunTeamCliResult>;
