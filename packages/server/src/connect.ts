// `teamshare connect <url> <token>` — writes the MCP server config for every
// AI coding assistant it can detect on this machine, so joining the team's
// shared context is one command instead of a per-tool manual edit.
//
// These are real developers' config files. They hold unrelated settings and
// sometimes secrets. Six rules are non-negotiable and apply to every target
// below:
//   1. Back up before every write (`<file>.teamshare-backup-<epoch>`).
//   2. Read-merge-write — never regenerate a file from scratch.
//   3. Never clobber a different server that happens to be named `teamshare`
//      unless --force is passed.
//   4. --dry-run prints what would change and writes nothing.
//   5. Refuse rather than guess: unparseable or unexpected shape -> skip and
//      print the manual snippet instead.
//   6. Never print file contents — only paths and the names of servers being
//      added. (The one exception is the manual snippet itself: it necessarily
//      contains the token/headers the user just supplied, because the whole
//      point of printing it is so they can paste it somewhere by hand.)
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  readdirSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

export type TargetId =
  | 'cursor'
  | 'vscode'
  | 'windsurf'
  | 'gemini'
  | 'cline'
  | 'codex'
  | 'zed'
  | 'continue';

export const ALL_TARGET_IDS: TargetId[] = [
  'cursor',
  'vscode',
  'windsurf',
  'gemini',
  'cline',
  'codex',
  'zed',
  'continue',
];

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
}

export interface ResolveIdentityOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ConnectOptions {
  /** Defaults to os.homedir() in production; tests always pass a temp dir. */
  home?: string;
  dryRun?: boolean;
  force?: boolean;
  only?: TargetId[];
  /** Skip git entirely when provided (including `null` to force the missing-identity path). */
  identity?: GitIdentity | null;
  /** Forwarded to resolveGitIdentity() when `identity` isn't given. */
  gitIdentityOptions?: ResolveIdentityOptions;
  /** Defaults to Date.now; tests pin this so backup filenames are deterministic. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

// This is a fourth hand-maintained copy of the same git-identity resolution
// as packages/plugin/headers.sh, packages/plugin/hooks/session-start.mjs, and
// cli.ts's own gitIdentity() (used by `doctor`) — nothing enforces the four
// staying in sync, so update the others by hand if this changes.
//
// Deliberately mirrors doctor's gitIdentity(), not headers.sh's simpler
// version: cwd defaults to the *home* directory, never the caller's cwd, and
// --global is tried before plain --get. `connect` bakes a static identity
// into other tools' user-scope configs, so it must resolve the same
// machine-wide identity doctor checks and headers.sh normally sends —
// resolving from whatever directory the user happened to be in when they
// typed `teamshare connect` let a repo-local git identity silently diverge
// from that, which is exactly the kind of mismatch this tool exists to avoid.
//
// cwd/env are still injectable so tests can prove both the "found" and
// "genuinely absent" paths without ever touching the real machine's git
// config: a temp cwd (a fresh repo, or not a repo at all) plus an env
// pointing HOME/XDG_CONFIG_HOME at an empty temp dir with
// GIT_CONFIG_NOSYSTEM=1 fully isolates the lookup from the real machine.
export function resolveGitIdentity(opts: ResolveIdentityOptions = {}): GitIdentity | null {
  const cwd = opts.cwd ?? homedir();
  const env = opts.env ?? process.env;

  const run = (args: string[]): string => {
    try {
      return execFileSync('git', args, {
        cwd,
        env,
        timeout: 1500,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString('utf8')
        .trim();
    } catch {
      return '';
    }
  };

  let name = run(['config', '--global', '--get', 'user.name']);
  let email = run(['config', '--global', '--get', 'user.email']);
  if (!name) name = run(['config', '--get', 'user.name']);
  if (!email) email = run(['config', '--get', 'user.email']);

  if (!name || !email) return null;
  return { name, email: email.toLowerCase() };
}

interface Headers {
  Authorization: string;
  'X-Teamshare-Name': string;
  'X-Teamshare-Email': string;
}

function headersObj(ctx: TargetContext): Headers {
  return {
    Authorization: `Bearer ${ctx.token}`,
    'X-Teamshare-Name': ctx.identity.name.trim(),
    'X-Teamshare-Email': ctx.identity.email.trim().toLowerCase(),
  };
}

function mcpUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/mcp`;
}

// ---------------------------------------------------------------------------
// Generic JSON target support (Cursor, VS Code, Windsurf, Gemini CLI, Cline, Zed)
// ---------------------------------------------------------------------------

interface TargetContext {
  url: string;
  token: string;
  identity: GitIdentity;
  dryRun: boolean;
  force: boolean;
  now: () => number;
}

interface TargetApplyResult {
  status: Exclude<TargetStatus, 'not-installed'>;
  reason?: string;
  backupPath?: string;
  snippet?: string;
}

interface TargetDef {
  id: TargetId;
  label: string;
  configPath: string;
  installed: boolean;
  apply: (ctx: TargetContext) => TargetApplyResult;
}

function readJsonFileOrEmpty(
  filePath: string,
): { ok: true; data: Record<string, unknown> } | { ok: false } {
  if (!existsSync(filePath)) return { ok: true, data: {} };
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return { ok: false };
  }
  if (raw.trim().length === 0) return { ok: true, data: {} };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false };
    return { ok: true, data: parsed as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

interface WriteJsonServerParams {
  filePath: string;
  serversKey: string;
  entryKey: string;
  buildEntry: () => unknown;
  dryRun: boolean;
  force: boolean;
  now: () => number;
}

interface WriteJsonServerResult {
  status: 'written' | 'would-write' | 'skipped';
  reason?: string;
  backupPath?: string;
}

// A previously-written teamshare entry always carries our identity header as
// a telltale marker (present as a JSON key for most targets, and as a
// "X-Teamshare-Email:..." arg string for Zed's bridge form) — so a rerun can
// refresh its own entry (e.g. after `rotate-token`) without needing --force,
// while a genuinely different server that happens to be named "teamshare" is
// left alone unless the caller explicitly overrides.
function looksLikeOurEntry(entry: unknown): boolean {
  try {
    return JSON.stringify(entry).includes('X-Teamshare-Email');
  } catch {
    return false;
  }
}

function writeJsonServerConfig(p: WriteJsonServerParams): WriteJsonServerResult {
  const parsed = readJsonFileOrEmpty(p.filePath);
  if (!parsed.ok) {
    return {
      status: 'skipped',
      reason: `${p.filePath} exists but does not parse as JSON — leaving it untouched`,
    };
  }

  const data = parsed.data;
  const serversRaw = data[p.serversKey];
  if (serversRaw !== undefined && (typeof serversRaw !== 'object' || serversRaw === null || Array.isArray(serversRaw))) {
    return {
      status: 'skipped',
      reason: `${p.filePath}'s "${p.serversKey}" key is not an object — leaving it untouched`,
    };
  }
  const servers: Record<string, unknown> = serversRaw
    ? { ...(serversRaw as Record<string, unknown>) }
    : {};

  const existingEntry = servers[p.entryKey];
  if (existingEntry !== undefined && !p.force && !looksLikeOurEntry(existingEntry)) {
    return {
      status: 'skipped',
      reason:
        `${p.filePath} already has a "${p.entryKey}" entry under "${p.serversKey}" that doesn't ` +
        'look like teamshare\'s — pass --force to overwrite it',
    };
  }

  servers[p.entryKey] = p.buildEntry();
  const nextData: Record<string, unknown> = { ...data, [p.serversKey]: servers };

  if (p.dryRun) return { status: 'would-write' };

  mkdirSync(dirname(p.filePath), { recursive: true });
  let backupPath: string | undefined;
  if (existsSync(p.filePath)) {
    backupPath = `${p.filePath}.teamshare-backup-${p.now()}`;
    copyFileSync(p.filePath, backupPath);
  }
  writeFileSync(p.filePath, JSON.stringify(nextData, null, 2) + '\n', 'utf8');
  return { status: 'written', backupPath };
}

function jsonEntrySnippet(serversKey: string, path: string, entry: unknown): string {
  const body = JSON.stringify({ [serversKey]: { teamshare: entry } }, null, 2);
  return `Add this into "${serversKey}" in ${path}:\n${body}\n`;
}

function makeJsonTarget(opts: {
  id: TargetId;
  label: string;
  path: string;
  appDir: string;
  serversKey: string;
  buildEntry: (ctx: TargetContext) => unknown;
}): TargetDef {
  const installed = existsSync(opts.path) || existsSync(opts.appDir);
  return {
    id: opts.id,
    label: opts.label,
    configPath: opts.path,
    installed,
    apply: (ctx) => {
      const entry = opts.buildEntry(ctx);
      const result = writeJsonServerConfig({
        filePath: opts.path,
        serversKey: opts.serversKey,
        entryKey: 'teamshare',
        buildEntry: () => entry,
        dryRun: ctx.dryRun,
        force: ctx.force,
        now: ctx.now,
      });
      if (result.status === 'skipped') {
        return { ...result, snippet: jsonEntrySnippet(opts.serversKey, opts.path, entry) };
      }
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Cline: extension id is not stable, so detection globs globalStorage rather
// than hardcoding a path.
// ---------------------------------------------------------------------------

function resolveClineDir(home: string): { globalStorage: string; matchDir: string | null } {
  const globalStorage = join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage');
  if (!existsSync(globalStorage)) return { globalStorage, matchDir: null };
  let entries: string[] = [];
  try {
    entries = readdirSync(globalStorage);
  } catch {
    return { globalStorage, matchDir: null };
  }
  const match = entries.find((e) => /claude-dev/i.test(e) || /cline/i.test(e));
  return { globalStorage, matchDir: match ? join(globalStorage, match) : null };
}

// ---------------------------------------------------------------------------
// Codex CLI: config.toml is a single shared file for MCP servers, plugin
// registrations, trust levels, and shell policy, and the Codex app itself has
// been reported to rewrite it. We deliberately never parse-and-reserialize —
// only ever append a new table at the end (TOML permits tables anywhere), and
// only when the literal table header isn't already present. This also means
// --force cannot make Codex overwrite an existing block: doing that safely
// would require a real TOML parser, which is explicitly out of scope.
// ---------------------------------------------------------------------------

const CODEX_TABLE_HEADER = '[mcp_servers.teamshare]';

// TOML basic strings share JSON's escaping rules for the characters we might
// ever emit here (", \, control chars), so JSON.stringify produces a valid
// TOML basic string without hand-rolling an escaper.
function tomlString(value: string): string {
  return JSON.stringify(value);
}

function buildCodexBlock(ctx: TargetContext): string {
  const lines = [
    '# added by teamshare connect',
    CODEX_TABLE_HEADER,
    `url = ${tomlString(mcpUrl(ctx.url))}`,
    '',
    '[mcp_servers.teamshare.http_headers]',
    `Authorization = ${tomlString(`Bearer ${ctx.token}`)}`,
    `X-Teamshare-Name = ${tomlString(ctx.identity.name.trim())}`,
    `X-Teamshare-Email = ${tomlString(ctx.identity.email.trim().toLowerCase())}`,
  ];
  return lines.join('\n') + '\n';
}

function appendCodexBlock(existing: string, block: string): string {
  if (existing.length === 0) return block;
  const sep = existing.endsWith('\n') ? '\n' : '\n\n';
  return existing + sep + block;
}

function buildCodexSnippet(ctx: TargetContext): string {
  return `Append this to the end of ~/.codex/config.toml:\n\n${buildCodexBlock(ctx)}`;
}

function applyCodex(path: string, ctx: TargetContext): TargetApplyResult {
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (existing.includes(CODEX_TABLE_HEADER)) {
    return {
      status: 'skipped',
      reason: `${path} already has ${CODEX_TABLE_HEADER} — edit or remove it by hand, then re-run`,
      snippet: buildCodexSnippet(ctx),
    };
  }

  if (ctx.dryRun) return { status: 'would-write' };

  const block = buildCodexBlock(ctx);
  const next = appendCodexBlock(existing, block);

  mkdirSync(dirname(path), { recursive: true });
  let backupPath: string | undefined;
  if (existsSync(path)) {
    backupPath = `${path}.teamshare-backup-${ctx.now()}`;
    copyFileSync(path, backupPath);
  }
  writeFileSync(path, next, 'utf8');
  return { status: 'written', backupPath };
}

// ---------------------------------------------------------------------------
// Continue.dev: mcpServers is a YAML list (not a map) and this shape was not
// verifiable against a real install, so this version never writes it — only
// detects it and prints the snippet, with requestOptions.headers nesting.
// ---------------------------------------------------------------------------

function buildContinueSnippet(ctx: TargetContext): string {
  const lines = [
    'Continue.dev support is print-only in this version. Add this to ~/.continue/config.yaml by hand:',
    '',
    'mcpServers:',
    '  - name: teamshare',
    `    url: ${mcpUrl(ctx.url)}`,
    '    requestOptions:',
    '      headers:',
    `        Authorization: Bearer ${ctx.token}`,
    `        X-Teamshare-Name: ${ctx.identity.name.trim()}`,
    `        X-Teamshare-Email: ${ctx.identity.email.trim().toLowerCase()}`,
  ];
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Target list
// ---------------------------------------------------------------------------

function buildTargets(home: string): TargetDef[] {
  const targets: TargetDef[] = [];

  targets.push(
    makeJsonTarget({
      id: 'cursor',
      label: 'Cursor',
      path: join(home, '.cursor', 'mcp.json'),
      appDir: join(home, '.cursor'),
      serversKey: 'mcpServers',
      buildEntry: (ctx) => ({ url: mcpUrl(ctx.url), headers: headersObj(ctx) }),
    }),
  );

  targets.push(
    makeJsonTarget({
      id: 'vscode',
      label: 'VS Code',
      path: join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json'),
      appDir: join(home, 'Library', 'Application Support', 'Code'),
      serversKey: 'servers',
      buildEntry: (ctx) => ({ type: 'http', url: mcpUrl(ctx.url), headers: headersObj(ctx) }),
    }),
  );

  targets.push(
    makeJsonTarget({
      id: 'windsurf',
      label: 'Windsurf',
      path: join(home, '.codeium', 'mcp_config.json'),
      appDir: join(home, '.codeium'),
      serversKey: 'mcpServers',
      buildEntry: (ctx) => ({ serverUrl: mcpUrl(ctx.url), headers: headersObj(ctx) }),
    }),
  );

  targets.push(
    makeJsonTarget({
      id: 'gemini',
      label: 'Gemini CLI',
      path: join(home, '.gemini', 'settings.json'),
      appDir: join(home, '.gemini'),
      serversKey: 'mcpServers',
      buildEntry: (ctx) => ({ httpUrl: mcpUrl(ctx.url), headers: headersObj(ctx) }),
    }),
  );

  const { globalStorage, matchDir } = resolveClineDir(home);
  const clinePath = matchDir
    ? join(matchDir, 'settings', 'cline_mcp_settings.json')
    : join(globalStorage, '<cline-extension>', 'settings', 'cline_mcp_settings.json');
  targets.push({
    id: 'cline',
    label: 'Cline',
    configPath: clinePath,
    installed: matchDir !== null,
    apply: (ctx) => {
      const entry = { url: mcpUrl(ctx.url), type: 'streamableHttp', headers: headersObj(ctx) };
      const result = writeJsonServerConfig({
        filePath: clinePath,
        serversKey: 'mcpServers',
        entryKey: 'teamshare',
        buildEntry: () => entry,
        dryRun: ctx.dryRun,
        force: ctx.force,
        now: ctx.now,
      });
      if (result.status === 'skipped') {
        return { ...result, snippet: jsonEntrySnippet('mcpServers', clinePath, entry) };
      }
      return result;
    },
  });

  targets.push(
    makeJsonTarget({
      id: 'zed',
      label: 'Zed (via mcp-remote bridge)',
      path: join(home, '.config', 'zed', 'settings.json'),
      appDir: join(home, '.config', 'zed'),
      serversKey: 'context_servers',
      // Zed's native remote-HTTP auth has an open upstream bug where the auth
      // flow doesn't trigger, so this goes through the mcp-remote stdio
      // bridge instead of a direct url+headers entry.
      buildEntry: (ctx) => ({
        command: 'npx',
        args: [
          '-y',
          'mcp-remote',
          mcpUrl(ctx.url),
          '--header',
          `Authorization:Bearer ${ctx.token}`,
          '--header',
          `X-Teamshare-Name:${ctx.identity.name.trim()}`,
          '--header',
          `X-Teamshare-Email:${ctx.identity.email.trim().toLowerCase()}`,
        ],
      }),
    }),
  );

  const codexPath = join(home, '.codex', 'config.toml');
  const codexAppDir = join(home, '.codex');
  targets.push({
    id: 'codex',
    label: 'Codex CLI',
    configPath: codexPath,
    installed: existsSync(codexPath) || existsSync(codexAppDir),
    apply: (ctx) => applyCodex(codexPath, ctx),
  });

  const continuePath = join(home, '.continue', 'config.yaml');
  const continueAppDir = join(home, '.continue');
  targets.push({
    id: 'continue',
    label: 'Continue.dev',
    configPath: continuePath,
    installed: existsSync(continuePath) || existsSync(continueAppDir),
    apply: (ctx) => ({ status: 'print-only', snippet: buildContinueSnippet(ctx) }),
  });

  return targets;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function listTargets(home: string = homedir()): DetectedTarget[] {
  return buildTargets(home).map((t) => ({
    id: t.id,
    label: t.label,
    path: t.configPath,
    installed: t.installed,
  }));
}

function missingIdentityAbort(): AbortInfo {
  return {
    reason: 'git identity (user.name and/or user.email) is not fully configured',
    remedy: [
      'A config written without an identity would fail every call with a confusing 400.',
      'Set your git identity, then re-run teamshare connect:',
      '',
      '  git config --global user.name "Your Name"',
      '  git config --global user.email "you@example.com"',
    ].join('\n'),
  };
}

export function runConnect(url: string, token: string, options: ConnectOptions = {}): ConnectRunResult {
  const home = options.home ?? homedir();
  const now = options.now ?? Date.now;
  const dryRun = options.dryRun ?? false;
  const force = options.force ?? false;

  // Default the git-identity cwd to the *effective* home (the injected test
  // home, or the real one in production) rather than letting
  // resolveGitIdentity() fall back to its own os.homedir() default — a test
  // that injects `home` but forgets to also pass an identity or
  // gitIdentityOptions must never fall through to reading the real machine's
  // global git config.
  const identity =
    options.identity !== undefined
      ? options.identity
      : resolveGitIdentity(options.gitIdentityOptions ?? { cwd: home });

  if (!identity || !identity.name.trim() || !identity.email.trim()) {
    return { aborted: missingIdentityAbort(), results: [] };
  }

  const allTargets = buildTargets(home);
  const selected = options.only ? allTargets.filter((t) => options.only!.includes(t.id)) : allTargets;

  const results: TargetResult[] = selected.map((target) => {
    if (!target.installed) {
      return { id: target.id, label: target.label, status: 'not-installed', path: target.configPath };
    }
    const applied = target.apply({ url, token, identity, dryRun, force, now });
    return { id: target.id, label: target.label, path: target.configPath, ...applied };
  });

  return { identity, results };
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

export function formatListOutput(detected: DetectedTarget[]): string {
  const lines = ['teamshare connect --list — detected assistants', ''];
  for (const d of detected) {
    const marker = d.installed ? '[detected]    ' : '[not installed]';
    lines.push(`  ${marker} ${d.label.padEnd(28)} ${d.path}`);
  }
  lines.push('');
  lines.push('Nothing was written. Run: teamshare connect <server-url> <team-token>');
  return lines.join('\n') + '\n';
}

export function formatConnectOutput(run: ConnectRunResult): string {
  if (run.aborted) {
    return (
      [
        'teamshare connect: aborted before touching any file',
        '',
        run.aborted.reason,
        '',
        run.aborted.remedy,
        '',
      ].join('\n') + '\n'
    );
  }

  const lines = ['teamshare connect — result', ''];
  let writtenCount = 0;
  const snippets: { label: string; snippet: string }[] = [];

  for (const r of run.results) {
    switch (r.status) {
      case 'written':
        writtenCount++;
        lines.push(
          `  [written]       ${r.label} -> ${r.path}` +
            (r.backupPath ? ` (backup: ${r.backupPath})` : ''),
        );
        break;
      case 'would-write':
        lines.push(`  [would write]   ${r.label} -> ${r.path} (--dry-run, nothing written)`);
        break;
      case 'skipped':
        lines.push(`  [skipped]       ${r.label} -> ${r.path}` + (r.reason ? ` — ${r.reason}` : ''));
        if (r.snippet) snippets.push({ label: r.label, snippet: r.snippet });
        break;
      case 'print-only':
        lines.push(`  [manual only]   ${r.label} -> ${r.path}`);
        if (r.snippet) snippets.push({ label: r.label, snippet: r.snippet });
        break;
      case 'not-installed':
        lines.push(`  [not installed] ${r.label}`);
        break;
    }
  }

  lines.push('');
  lines.push(`${writtenCount} assistant(s) configured automatically.`);
  lines.push('Restart the affected assistant(s) to pick up the change.');
  lines.push('Run `teamshare doctor` next to confirm the connection actually works.');

  if (snippets.length > 0) {
    lines.push('');
    lines.push('Manual setup needed for the rest:');
    for (const s of snippets) {
      lines.push('');
      lines.push(`-- ${s.label} --`);
      lines.push(s.snippet.trimEnd());
    }
  }

  return lines.join('\n') + '\n';
}
