// Hand-authored type declarations for teamshare-team.mjs — the single
// plain-JS implementation shared by the standalone script and the
// `teamshare` CLI's `create-team` break-glass wiring
// (packages/server/src/team.ts re-exports from here). Kept in sync by hand;
// there is no build step that generates this file.

export const SIGNUP_SECRET_ENV: string;
export const TEAM_TOKEN_ENV: string;
export const ADMIN_TOKEN_ENV: string;

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

export interface FormatTeamOutputOptions {
  url: string;
  team: { teamId: string; name: string; token: string };
  verify: VerifyTeamResult;
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
}

export function formatRosterOutput(opts: FormatRosterOutputOptions): string;

export interface ParsedTeamArgv {
  cmd?: 'create-team' | 'rotate-team' | 'invite' | 'revoke' | 'roster' | 'unknown';
  url?: string;
  name?: string;
  email?: string;
  help: boolean;
  unknown?: string;
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
}

export interface RunTeamCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function runTeamCli(argv: string[], opts?: RunTeamCliOptions): Promise<RunTeamCliResult>;
