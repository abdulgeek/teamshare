// Hand-authored type declarations for teamshare-connect.mjs — the single
// plain-JS implementation shared by the standalone script and
// `teamshare connect` (packages/server/src/connect.ts re-exports from here).
// Kept in sync by hand; there is no build step that generates this file.

export type TargetId =
  | 'cursor'
  | 'vscode'
  | 'windsurf'
  | 'gemini'
  | 'cline'
  | 'codex'
  | 'zed'
  | 'continue';

export const ALL_TARGET_IDS: TargetId[];

// Environment variables the standalone CLI entry point falls back to when
// the server URL / personal token aren't given positionally — same names
// `teamshare doctor` already accepts.
export const TEAMSHARE_URL_ENV: string;
export const TEAMSHARE_TOKEN_ENV: string;

export interface GitIdentity {
  name: string;
  email: string;
}

export type TargetStatus = 'written' | 'would-write' | 'skipped' | 'not-installed' | 'print-only';

export interface TargetResult {
  id: TargetId;
  label: string;
  status: TargetStatus;
  path: string;
  backupPath?: string;
  reason?: string;
  snippet?: string;
}

export interface DetectedTarget {
  id: TargetId;
  label: string;
  path: string;
  installed: boolean;
}

export interface AbortInfo {
  reason: string;
  remedy: string;
}

export interface ConnectRunResult {
  aborted?: AbortInfo;
  identity?: GitIdentity;
  results: TargetResult[];
  showToken?: boolean;
}

export interface ResolveIdentityOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ConnectOptions {
  /** Defaults to os.homedir() in production; tests always pass a temp dir. */
  home?: string;
  /** Defaults to process.platform; tests pass 'darwin' | 'linux' | 'win32' to exercise all three deterministically. */
  platform?: string;
  dryRun?: boolean;
  force?: boolean;
  only?: TargetId[];
  /** Skip git entirely when provided (including `null` to force the missing-identity path). */
  identity?: GitIdentity | null;
  /** Forwarded to resolveGitIdentity() when `identity` isn't given. */
  gitIdentityOptions?: ResolveIdentityOptions;
  /** Defaults to Date.now; tests pin this so backup filenames are deterministic. */
  now?: () => number;
  /** Print the real token in manual-setup snippets instead of the <team-token> placeholder. Defaults to false. */
  showToken?: boolean;
}

export interface DiscoveredCredentials {
  id: TargetId;
  label: string;
  path: string;
  url: string;
  token: string;
}

export function resolveGitIdentity(opts?: ResolveIdentityOptions): GitIdentity | null;
export function normalizeServerUrl(url: string): string;
export function listTargets(home?: string, platform?: string): DetectedTarget[];
export function discoverConnectedTargets(home?: string, platform?: string): DiscoveredCredentials[];
export function runConnect(url: string, token: string, options?: ConnectOptions): ConnectRunResult;
export function formatListOutput(detected: DetectedTarget[]): string;
export function formatConnectOutput(run: ConnectRunResult): string;

export interface ParsedConnectArgv {
  url?: string;
  token?: string;
  only?: TargetId[];
  dryRun: boolean;
  force: boolean;
  list: boolean;
  showToken: boolean;
  help: boolean;
}

export function parseConnectArgv(argv: string[]): ParsedConnectArgv;

// Credential resolution for the standalone CLI entry point: positional argv
// (from parseConnectArgv) first, then TEAMSHARE_URL/TEAMSHARE_TOKEN in the
// environment, then — only on a real terminal — an interactive prompt.
// Mirrors teamshare-team.d.mts's SecretSource/resolveSecret/promptHidden
// shape, with an added 'argv' tier.

export type ValueSource = 'env' | 'prompt' | 'none';

export function resolveValueSource(envValue: string | undefined, isTTY: boolean): ValueSource;

export interface PromptStreams {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

export function promptHidden(promptText: string, streams?: PromptStreams): Promise<string | null>;
export function promptVisible(promptText: string, streams?: PromptStreams): Promise<string | null>;

export interface ResolveConnectValueOptions {
  argvValue?: string;
  envValue: string | undefined;
  isTTY: boolean;
  promptText: string;
  promptFn: (promptText: string, streams?: PromptStreams) => Promise<string | null>;
  streams?: PromptStreams;
}

export type ResolveConnectValueResult =
  | { ok: true; value: string; source: 'argv' | 'env' | 'prompt' }
  | { ok: false; reason: string };

export function resolveConnectValue(opts: ResolveConnectValueOptions): Promise<ResolveConnectValueResult>;

export interface ParsedConnectCredentials {
  url?: string;
  token?: string;
}

export interface ResolveConnectCredentialsOptions {
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
  urlPromptFn?: (promptText: string, streams?: PromptStreams) => Promise<string | null>;
  tokenPromptFn?: (promptText: string, streams?: PromptStreams) => Promise<string | null>;
  streams?: PromptStreams;
}

export type ResolveConnectCredentialsResult =
  | {
      ok: true;
      url: string;
      token: string;
      urlSource: 'argv' | 'env' | 'prompt';
      tokenSource: 'argv' | 'env' | 'prompt';
    }
  | { ok: false; reason: string };

export function resolveConnectCredentials(
  parsed: ParsedConnectCredentials,
  opts?: ResolveConnectCredentialsOptions,
): Promise<ResolveConnectCredentialsResult>;

export function formatArgvTokenWarning(): string;
