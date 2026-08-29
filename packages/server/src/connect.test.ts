import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  runConnect,
  listTargets,
  resolveGitIdentity,
  formatConnectOutput,
  formatListOutput,
  normalizeServerUrl,
  type GitIdentity,
} from './connect.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'teamshare-connect-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const identity: GitIdentity = { name: 'Ada Lovelace', email: 'Ada@Example.com' };
const token = 'ts_test_token_123';
const url = 'https://teamshare.example.com';
const FIXED_NOW = () => 1735689600000; // fixed epoch so backup paths are deterministic in assertions

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('detection: not installed cleanly when nothing exists', () => {
  it('reports every target as not installed against an empty home', () => {
    const home = tmp();
    const detected = listTargets(home);
    expect(detected.length).toBeGreaterThan(0);
    for (const d of detected) {
      expect(d.installed).toBe(false);
    }
    // does not create anything
    expect(readdirSync(home)).toEqual([]);
  });

  it('--list-equivalent detection never writes anything', () => {
    const home = tmp();
    mkdirSync(join(home, '.cursor'), { recursive: true });
    listTargets(home);
    expect(existsSync(join(home, '.cursor', 'mcp.json'))).toBe(false);
  });
});

describe('JSON targets: creates missing file, merges preserving unrelated content', () => {
  it('Cursor: creates ~/.cursor/mcp.json when absent, using the url key', () => {
    const home = tmp();
    mkdirSync(join(home, '.cursor'), { recursive: true }); // installed, but no mcp.json yet
    const run = runConnect(url, token, { home, identity, only: ['cursor'], now: FIXED_NOW });
    expect(run.aborted).toBeUndefined();
    const cursor = run.results.find((r) => r.id === 'cursor')!;
    expect(cursor.status).toBe('written');
    const written = readJson(join(home, '.cursor', 'mcp.json')) as any;
    expect(written.mcpServers.teamshare.url).toBe('https://teamshare.example.com/mcp');
    expect(written.mcpServers.teamshare.headers.Authorization).toBe(`Bearer ${token}`);
    expect(written.mcpServers.teamshare.headers['X-Teamshare-Name']).toBe('Ada Lovelace');
    expect(written.mcpServers.teamshare.headers['X-Teamshare-Email']).toBe('ada@example.com');
  });

  it('Cursor: merges into an existing file, preserving unrelated servers and top-level keys', () => {
    const home = tmp();
    const path = join(home, '.cursor', 'mcp.json');
    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ someTopLevelSetting: true, mcpServers: { other: { url: 'https://other.example.com' } } }, null, 2),
    );
    const run = runConnect(url, token, { home, identity, only: ['cursor'], now: FIXED_NOW });
    const written = readJson(path) as any;
    expect(written.someTopLevelSetting).toBe(true);
    expect(written.mcpServers.other).toEqual({ url: 'https://other.example.com' });
    expect(written.mcpServers.teamshare.url).toBe('https://teamshare.example.com/mcp');
  });

  it('VS Code: writes servers key with type "http" and the url field', () => {
    const home = tmp();
    mkdirSync(join(home, 'Library', 'Application Support', 'Code'), { recursive: true });
    const run = runConnect(url, token, { home, identity, only: ['vscode'], now: FIXED_NOW });
    expect(run.results[0].status).toBe('written');
    const path = join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
    const written = readJson(path) as any;
    expect(written.servers.teamshare.type).toBe('http');
    expect(written.servers.teamshare.url).toBe('https://teamshare.example.com/mcp');
    expect(written.servers.teamshare.headers.Authorization).toBe(`Bearer ${token}`);
  });

  it('Cline: detects via globalStorage glob (*claude-dev*) and writes url + type "streamableHttp"', () => {
    const home = tmp();
    const extDir = join(
      home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev',
    );
    mkdirSync(extDir, { recursive: true });
    const detected = listTargets(home).find((d) => d.id === 'cline')!;
    expect(detected.installed).toBe(true);

    const run = runConnect(url, token, { home, identity, only: ['cline'], now: FIXED_NOW });
    const result = run.results.find((r) => r.id === 'cline')!;
    expect(result.status).toBe('written');
    const path = join(extDir, 'settings', 'cline_mcp_settings.json');
    const written = readJson(path) as any;
    expect(written.mcpServers.teamshare.url).toBe('https://teamshare.example.com/mcp');
    expect(written.mcpServers.teamshare.type).toBe('streamableHttp');
  });

  it('Cline: matches via *cline* glob too, independent of *claude-dev*', () => {
    const home = tmp();
    const extDir = join(
      home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'some.publisher.cline-fork',
    );
    mkdirSync(extDir, { recursive: true });
    const detected = listTargets(home).find((d) => d.id === 'cline')!;
    expect(detected.installed).toBe(true);
  });

  it('Cline: not installed when globalStorage has no matching extension directory', () => {
    const home = tmp();
    mkdirSync(join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'someone.unrelated-ext'), {
      recursive: true,
    });
    const detected = listTargets(home).find((d) => d.id === 'cline')!;
    expect(detected.installed).toBe(false);
    const run = runConnect(url, token, { home, identity, only: ['cline'], now: FIXED_NOW });
    expect(run.results[0].status).toBe('not-installed');
  });
});

describe('correct URL key per assistant (the easiest thing to get wrong)', () => {
  it('Windsurf gets serverUrl, not url', () => {
    const home = tmp();
    mkdirSync(join(home, '.codeium'), { recursive: true });
    runConnect(url, token, { home, identity, only: ['windsurf'], now: FIXED_NOW });
    const written = readJson(join(home, '.codeium', 'mcp_config.json')) as any;
    expect(written.mcpServers.teamshare.serverUrl).toBe('https://teamshare.example.com/mcp');
    expect(written.mcpServers.teamshare.url).toBeUndefined();
  });

  it('Gemini CLI gets httpUrl, not url', () => {
    const home = tmp();
    mkdirSync(join(home, '.gemini'), { recursive: true });
    runConnect(url, token, { home, identity, only: ['gemini'], now: FIXED_NOW });
    const written = readJson(join(home, '.gemini', 'settings.json')) as any;
    expect(written.mcpServers.teamshare.httpUrl).toBe('https://teamshare.example.com/mcp');
    expect(written.mcpServers.teamshare.url).toBeUndefined();
  });

  it('Cursor gets url, not serverUrl or httpUrl', () => {
    const home = tmp();
    mkdirSync(join(home, '.cursor'), { recursive: true });
    runConnect(url, token, { home, identity, only: ['cursor'], now: FIXED_NOW });
    const written = readJson(join(home, '.cursor', 'mcp.json')) as any;
    expect(written.mcpServers.teamshare.url).toBe('https://teamshare.example.com/mcp');
    expect(written.mcpServers.teamshare.serverUrl).toBeUndefined();
    expect(written.mcpServers.teamshare.httpUrl).toBeUndefined();
  });

  it('headers key is "headers" for all JSON targets except Continue.dev', () => {
    const home = tmp();
    mkdirSync(join(home, '.codeium'), { recursive: true });
    mkdirSync(join(home, '.gemini'), { recursive: true });
    runConnect(url, token, { home, identity, only: ['windsurf', 'gemini'], now: FIXED_NOW });
    const windsurf = readJson(join(home, '.codeium', 'mcp_config.json')) as any;
    const gemini = readJson(join(home, '.gemini', 'settings.json')) as any;
    expect(windsurf.mcpServers.teamshare.headers.Authorization).toBe(`Bearer ${token}`);
    expect(gemini.mcpServers.teamshare.headers.Authorization).toBe(`Bearer ${token}`);
  });
});

describe('Zed: bridge form, and refuses non-strict-JSON settings', () => {
  it('writes the mcp-remote bridge command under context_servers when settings.json is strict JSON', () => {
    const home = tmp();
    mkdirSync(join(home, '.config', 'zed'), { recursive: true });
    const run = runConnect(url, token, { home, identity, only: ['zed'], now: FIXED_NOW });
    expect(run.results[0].status).toBe('written');
    const written = readJson(join(home, '.config', 'zed', 'settings.json')) as any;
    const entry = written.context_servers.teamshare;
    expect(entry.command).toBe('npx');
    expect(entry.args).toContain('mcp-remote');
    expect(entry.args).toContain('https://teamshare.example.com/mcp');
    expect(entry.args.join(' ')).toContain('Authorization:Bearer ' + token);
    expect(entry.args.join(' ')).toContain('X-Teamshare-Email:ada@example.com');
  });

  it('skips (does not write) when settings.json contains // comments and is not strict JSON', () => {
    const home = tmp();
    const dir = join(home, '.config', 'zed');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'settings.json');
    const original = '{\n  // a comment Zed allows but JSON.parse rejects\n  "theme": "one-dark"\n}\n';
    writeFileSync(path, original);
    const run = runConnect(url, token, { home, identity, only: ['zed'], now: FIXED_NOW });
    const result = run.results[0];
    expect(result.status).toBe('skipped');
    expect(result.snippet).toBeTruthy();
    expect(readFileSync(path, 'utf8')).toBe(original); // untouched
    expect(existsSync(`${path}.teamshare-backup-${FIXED_NOW()}`)).toBe(false);
  });
});

describe('Continue.dev: print-only, never auto-written, list-shaped snippet with requestOptions.headers', () => {
  it('is detected but always print-only, and never creates or modifies config.yaml', () => {
    const home = tmp();
    mkdirSync(join(home, '.continue'), { recursive: true });
    const run = runConnect(url, token, { home, identity, only: ['continue'], now: FIXED_NOW });
    const result = run.results[0];
    expect(result.status).toBe('print-only');
    expect(existsSync(join(home, '.continue', 'config.yaml'))).toBe(false);
  });

  it('prints a snippet with mcpServers as a list and headers nested under requestOptions', () => {
    const home = tmp();
    mkdirSync(join(home, '.continue'), { recursive: true });
    // showToken: true here — this test is about the snippet's *shape*
    // (YAML list, requestOptions.headers nesting), not about redaction,
    // which has its own dedicated tests below.
    const run = runConnect(url, token, { home, identity, only: ['continue'], now: FIXED_NOW, showToken: true });
    const snippet = run.results[0].snippet!;
    expect(snippet).toContain('mcpServers:');
    expect(snippet).toContain('- name: teamshare');
    expect(snippet).toContain('requestOptions:');
    expect(snippet).toContain('headers:');
    expect(snippet).toContain(`Authorization: Bearer ${token}`);
    expect(snippet).toContain('X-Teamshare-Email: ada@example.com');
    // requestOptions.headers must be nested under the server entry, not top-level
    const nestedIdx = snippet.indexOf('requestOptions:');
    const headersIdx = snippet.indexOf('headers:');
    const authIdx = snippet.indexOf('Authorization:');
    expect(nestedIdx).toBeGreaterThan(-1);
    expect(headersIdx).toBeGreaterThan(nestedIdx);
    expect(authIdx).toBeGreaterThan(headersIdx);
  });

  it('does not write even when installed and --dry-run is not set and --force is passed', () => {
    const home = tmp();
    mkdirSync(join(home, '.continue'), { recursive: true });
    runConnect(url, token, { home, identity, only: ['continue'], now: FIXED_NOW, force: true });
    expect(existsSync(join(home, '.continue', 'config.yaml'))).toBe(false);
  });
});

describe('Codex CLI (config.toml): append-only, never reserialized', () => {
  it('appends the block when [mcp_servers.teamshare] is absent, preceded by a blank line and a comment', () => {
    const home = tmp();
    const dir = join(home, '.codex');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'config.toml');
    const original = '[some_other_table]\nfoo = "bar"\n';
    writeFileSync(path, original);

    const run = runConnect(url, token, { home, identity, only: ['codex'], now: FIXED_NOW });
    const result = run.results[0];
    expect(result.status).toBe('written');
    expect(result.backupPath).toBeTruthy();

    const after = readFileSync(path, 'utf8');
    // content above the appended block is byte-identical afterward
    expect(after.startsWith(original)).toBe(true);
    expect(after).toContain('\n\n# added by teamshare connect\n[mcp_servers.teamshare]');
    expect(after).toContain('url = "https://teamshare.example.com/mcp"');
    expect(after).toContain('[mcp_servers.teamshare.http_headers]');
    expect(after).toContain(`Authorization = "Bearer ${token}"`);
    expect(after).toContain('X-Teamshare-Name = "Ada Lovelace"');
    expect(after).toContain('X-Teamshare-Email = "ada@example.com"');
  });

  it('creates config.toml when the file is absent but ~/.codex exists', () => {
    const home = tmp();
    mkdirSync(join(home, '.codex'), { recursive: true });
    const run = runConnect(url, token, { home, identity, only: ['codex'], now: FIXED_NOW });
    expect(run.results[0].status).toBe('written');
    const path = join(home, '.codex', 'config.toml');
    expect(readFileSync(path, 'utf8')).toContain('[mcp_servers.teamshare]');
  });

  it('skips and prints a snippet when [mcp_servers.teamshare] is already present, and never rewrites the file', () => {
    const home = tmp();
    const dir = join(home, '.codex');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'config.toml');
    const original = '[mcp_servers.teamshare]\nurl = "https://old.example.com/mcp"\n';
    writeFileSync(path, original);

    const run = runConnect(url, token, { home, identity, only: ['codex'], now: FIXED_NOW });
    const result = run.results[0];
    expect(result.status).toBe('skipped');
    expect(result.snippet).toBeTruthy();
    expect(readFileSync(path, 'utf8')).toBe(original); // byte-for-byte untouched
    expect(existsSync(`${path}.teamshare-backup-${FIXED_NOW()}`)).toBe(false);
  });

  it('does not clobber an existing [mcp_servers.teamshare] table even with --force (append-only by design)', () => {
    const home = tmp();
    const dir = join(home, '.codex');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'config.toml');
    const original = '[mcp_servers.teamshare]\nurl = "https://old.example.com/mcp"\n';
    writeFileSync(path, original);

    const run = runConnect(url, token, { home, identity, only: ['codex'], now: FIXED_NOW, force: true });
    expect(run.results[0].status).toBe('skipped');
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it('escapes special characters in the identity so a quote or backslash cannot break the TOML', () => {
    const home = tmp();
    mkdirSync(join(home, '.codex'), { recursive: true });
    const trickyIdentity: GitIdentity = { name: 'O"Brien\\Team', email: 'weird@example.com' };
    runConnect(url, token, { home, identity: trickyIdentity, only: ['codex'], now: FIXED_NOW });
    const content = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
    expect(content).toContain('X-Teamshare-Name = "O\\"Brien\\\\Team"');
  });
});

describe('malformed JSON is skipped, not overwritten', () => {
  it('leaves an unparseable ~/.cursor/mcp.json untouched and reports skipped', () => {
    const home = tmp();
    const dir = join(home, '.cursor');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'mcp.json');
    const original = '{ this is not valid json,,, ';
    writeFileSync(path, original);

    const run = runConnect(url, token, { home, identity, only: ['cursor'], now: FIXED_NOW });
    const result = run.results[0];
    expect(result.status).toBe('skipped');
    expect(result.snippet).toBeTruthy();
    expect(readFileSync(path, 'utf8')).toBe(original);
    expect(existsSync(`${path}.teamshare-backup-${FIXED_NOW()}`)).toBe(false);
  });
});

describe('an existing different teamshare entry is skipped without --force', () => {
  it('skips when a foreign "teamshare" server entry already exists', () => {
    const home = tmp();
    const dir = join(home, '.cursor');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'mcp.json');
    const original = JSON.stringify({ mcpServers: { teamshare: { command: 'some-other-tool', args: [] } } }, null, 2);
    writeFileSync(path, original);

    const run = runConnect(url, token, { home, identity, only: ['cursor'], now: FIXED_NOW });
    expect(run.results[0].status).toBe('skipped');
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it('overwrites the foreign entry when --force is passed', () => {
    const home = tmp();
    const dir = join(home, '.cursor');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'mcp.json');
    writeFileSync(path, JSON.stringify({ mcpServers: { teamshare: { command: 'some-other-tool', args: [] } } }));

    const run = runConnect(url, token, { home, identity, only: ['cursor'], now: FIXED_NOW, force: true });
    expect(run.results[0].status).toBe('written');
    const written = readJson(path) as any;
    expect(written.mcpServers.teamshare.url).toBe('https://teamshare.example.com/mcp');
  });

  it('refreshes its own previously-written entry again without needing --force', () => {
    const home = tmp();
    const dir = join(home, '.cursor');
    mkdirSync(dir, { recursive: true });
    // First connect.
    runConnect(url, token, { home, identity, only: ['cursor'], now: FIXED_NOW });
    // Second connect with a rotated token — should update cleanly, no --force needed.
    const run = runConnect(url, 'ts_rotated_token', { home, identity, only: ['cursor'], now: FIXED_NOW });
    expect(run.results[0].status).toBe('written');
    const written = readJson(join(dir, 'mcp.json')) as any;
    expect(written.mcpServers.teamshare.headers.Authorization).toBe('Bearer ts_rotated_token');
  });
});

describe('--dry-run writes nothing', () => {
  it('reports would-write and leaves the filesystem untouched for a fresh install', () => {
    const home = tmp();
    mkdirSync(join(home, '.cursor'), { recursive: true });
    const run = runConnect(url, token, { home, identity, only: ['cursor'], dryRun: true, now: FIXED_NOW });
    expect(run.results[0].status).toBe('would-write');
    expect(existsSync(join(home, '.cursor', 'mcp.json'))).toBe(false);
  });

  it('leaves an existing file byte-for-byte untouched and creates no backup', () => {
    const home = tmp();
    const dir = join(home, '.cursor');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'mcp.json');
    const original = JSON.stringify({ mcpServers: { other: { url: 'https://x' } } }, null, 2);
    writeFileSync(path, original);

    runConnect(url, token, { home, identity, only: ['cursor'], dryRun: true, now: FIXED_NOW });
    expect(readFileSync(path, 'utf8')).toBe(original);
    expect(existsSync(`${path}.teamshare-backup-${FIXED_NOW()}`)).toBe(false);
  });

  it('still reports skipped (not would-write) when a conflicting foreign entry exists', () => {
    const home = tmp();
    const dir = join(home, '.cursor');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'mcp.json');
    writeFileSync(path, JSON.stringify({ mcpServers: { teamshare: { command: 'other' } } }));
    const run = runConnect(url, token, { home, identity, only: ['cursor'], dryRun: true, now: FIXED_NOW });
    expect(run.results[0].status).toBe('skipped');
  });

  it('dry-run for Codex appends nothing to config.toml', () => {
    const home = tmp();
    const dir = join(home, '.codex');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'config.toml');
    writeFileSync(path, '[x]\ny = 1\n');
    const run = runConnect(url, token, { home, identity, only: ['codex'], dryRun: true, now: FIXED_NOW });
    expect(run.results[0].status).toBe('would-write');
    expect(readFileSync(path, 'utf8')).toBe('[x]\ny = 1\n');
  });
});

describe('a backup is created before each write', () => {
  it('backs up the pre-write content of an existing file at a deterministic epoch-suffixed path', () => {
    const home = tmp();
    const dir = join(home, '.cursor');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'mcp.json');
    const original = JSON.stringify({ mcpServers: {} }, null, 2);
    writeFileSync(path, original);

    const run = runConnect(url, token, { home, identity, only: ['cursor'], now: FIXED_NOW });
    const backupPath = `${path}.teamshare-backup-${FIXED_NOW()}`;
    expect(run.results[0].backupPath).toBe(backupPath);
    expect(existsSync(backupPath)).toBe(true);
    expect(readFileSync(backupPath, 'utf8')).toBe(original);
  });

  it('does not create a backup when the file did not previously exist', () => {
    const home = tmp();
    mkdirSync(join(home, '.cursor'), { recursive: true });
    const run = runConnect(url, token, { home, identity, only: ['cursor'], now: FIXED_NOW });
    expect(run.results[0].backupPath).toBeUndefined();
    const entries = readdirSync(join(home, '.cursor'));
    expect(entries.filter((e) => e.includes('teamshare-backup'))).toHaveLength(0);
  });
});

describe('missing git identity aborts before any file is touched', () => {
  it('runConnect aborts and touches nothing when neither identity nor a resolvable git config is available', () => {
    const home = tmp();
    mkdirSync(join(home, '.cursor'), { recursive: true }); // would otherwise be written to

    const isolatedCwd = tmp(); // not a git repo
    const isolatedHome = tmp(); // guaranteed empty — no real ~/.gitconfig can leak in
    const isolatedEnv = {
      PATH: process.env.PATH,
      HOME: isolatedHome,
      XDG_CONFIG_HOME: isolatedHome,
      GIT_CONFIG_NOSYSTEM: '1',
    };

    const run = runConnect(url, token, {
      home,
      now: FIXED_NOW,
      gitIdentityOptions: { cwd: isolatedCwd, env: isolatedEnv },
    });

    expect(run.aborted).toBeDefined();
    expect(run.aborted!.remedy).toContain('git config --global user.name');
    expect(run.aborted!.remedy).toContain('git config --global user.email');
    expect(run.results).toEqual([]);
    expect(existsSync(join(home, '.cursor', 'mcp.json'))).toBe(false);
  });

  it('aborts when an explicit identity object has an empty name or email', () => {
    const home = tmp();
    mkdirSync(join(home, '.cursor'), { recursive: true });
    const run = runConnect(url, token, { home, identity: { name: '', email: 'x@y.com' }, now: FIXED_NOW });
    expect(run.aborted).toBeDefined();
    expect(existsSync(join(home, '.cursor', 'mcp.json'))).toBe(false);
  });
});

describe('resolveGitIdentity', () => {
  it('falls back to the local repo config (at cwd) when isolated from any global config', () => {
    // resolveGitIdentity tries --global first (matching doctor's gitIdentity()),
    // so the real machine's global config must be isolated out here too —
    // otherwise this test's pass/fail would depend on whatever happens to be
    // in this developer's actual ~/.gitconfig, which is exactly what these
    // tests must never depend on.
    const repo = tmp();
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Grace Hopper'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'Grace@Example.COM'], { cwd: repo });

    const isolatedHome = tmp();
    const env = {
      PATH: process.env.PATH,
      HOME: isolatedHome,
      XDG_CONFIG_HOME: isolatedHome,
      GIT_CONFIG_NOSYSTEM: '1',
    };

    const found = resolveGitIdentity({ cwd: repo, env });
    expect(found).toEqual({ name: 'Grace Hopper', email: 'grace@example.com' });
  });

  it('returns null when isolated from any git config (no local repo, no global fallback)', () => {
    const cwd = tmp();
    const isolatedHome = tmp();
    const env = {
      PATH: process.env.PATH,
      HOME: isolatedHome,
      XDG_CONFIG_HOME: isolatedHome,
      GIT_CONFIG_NOSYSTEM: '1',
    };
    const found = resolveGitIdentity({ cwd, env });
    expect(found).toBeNull();
  });
});

describe('--only restricts targets processed', () => {
  it('only touches the requested targets and reports nothing for the rest', () => {
    const home = tmp();
    mkdirSync(join(home, '.cursor'), { recursive: true });
    mkdirSync(join(home, '.codex'), { recursive: true });
    mkdirSync(join(home, '.gemini'), { recursive: true });
    const run = runConnect(url, token, { home, identity, only: ['cursor', 'codex'], now: FIXED_NOW });
    const ids = run.results.map((r) => r.id).sort();
    expect(ids).toEqual(['codex', 'cursor']);
    expect(existsSync(join(home, '.gemini', 'settings.json'))).toBe(false);
  });
});

describe('formatting: formatConnectOutput / formatListOutput', () => {
  it('formatListOutput lists every target with a detected/not-installed marker and writes nothing itself', () => {
    const home = tmp();
    mkdirSync(join(home, '.cursor'), { recursive: true });
    const out = formatListOutput(listTargets(home));
    expect(out).toContain('Cursor');
    expect(out).toContain('Codex');
    expect(out.toLowerCase()).toContain('not installed');
  });

  it('formatConnectOutput reports the abort reason and remedy plainly', () => {
    const out = formatConnectOutput({
      aborted: { reason: 'git identity is not fully configured', remedy: 'git config --global user.name "You"' },
      results: [],
    });
    expect(out).toContain('git identity is not fully configured');
    expect(out).toContain('git config --global user.name');
  });

  it('formatConnectOutput counts configured assistants and reminds about restart and doctor', () => {
    const home = tmp();
    mkdirSync(join(home, '.cursor'), { recursive: true });
    mkdirSync(join(home, '.continue'), { recursive: true });
    const run = runConnect(url, token, { home, identity, only: ['cursor', 'continue'], now: FIXED_NOW });
    const out = formatConnectOutput(run);
    expect(out).toContain('1 assistant(s) configured');
    expect(out.toLowerCase()).toContain('restart');
    expect(out).toContain('teamshare doctor');
    expect(out).toContain('Continue.dev');
    expect(out).toContain('requestOptions');
  });

  it('never prints the token or headers in the per-target status lines, only in explicit snippets', () => {
    const home = tmp();
    const dir = join(home, '.cursor');
    mkdirSync(dir, { recursive: true });
    const run = runConnect(url, token, { home, identity, only: ['cursor'], now: FIXED_NOW });
    const out = formatConnectOutput(run);
    const statusLine = out.split('\n').find((l) => l.includes('[written]'))!;
    expect(statusLine).not.toContain(token);
  });
});

describe('normalizeServerUrl / mcpUrl: a URL that already has "/mcp" is not doubled up', () => {
  it('normalizeServerUrl strips a trailing "/mcp" and trailing slashes', () => {
    expect(normalizeServerUrl('https://teamshare.example.com/mcp')).toBe('https://teamshare.example.com');
    expect(normalizeServerUrl('https://teamshare.example.com/mcp/')).toBe('https://teamshare.example.com');
    expect(normalizeServerUrl('https://teamshare.example.com/mcp/mcp')).toBe('https://teamshare.example.com');
    expect(normalizeServerUrl('https://teamshare.example.com/')).toBe('https://teamshare.example.com');
    expect(normalizeServerUrl('https://teamshare.example.com')).toBe('https://teamshare.example.com');
  });

  it('runConnect writes a single "/mcp" suffix even when the given url already ends in "/mcp"', () => {
    const home = tmp();
    mkdirSync(join(home, '.cursor'), { recursive: true });
    const run = runConnect('https://teamshare.example.com/mcp', token, {
      home,
      identity,
      only: ['cursor'],
      now: FIXED_NOW,
    });
    const written = readJson(join(home, '.cursor', 'mcp.json')) as any;
    expect(written.mcpServers.teamshare.url).toBe('https://teamshare.example.com/mcp');
  });

  it('Codex CLI also gets a single "/mcp" suffix when given a url that already ends in "/mcp/"', () => {
    const home = tmp();
    mkdirSync(join(home, '.codex'), { recursive: true });
    runConnect('https://teamshare.example.com/mcp/', token, { home, identity, only: ['codex'], now: FIXED_NOW });
    const content = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
    expect(content).toContain('url = "https://teamshare.example.com/mcp"');
    expect(content).not.toContain('/mcp/mcp');
  });
});

describe('--only validation: an unknown target id aborts instead of silently configuring nothing', () => {
  it('aborts, names the unknown id, and lists the valid ones', () => {
    const home = tmp();
    mkdirSync(join(home, '.cursor'), { recursive: true });
    const run = runConnect(url, token, { home, identity, only: ['cursur'] as any, now: FIXED_NOW });
    expect(run.aborted).toBeDefined();
    expect(run.aborted!.reason).toContain('cursur');
    expect(run.aborted!.remedy).toContain('cursor');
    expect(run.aborted!.remedy).toContain('codex');
    expect(run.results).toEqual([]);
    expect(existsSync(join(home, '.cursor', 'mcp.json'))).toBe(false);
  });

  it('aborts when --only is an empty list (matches nothing)', () => {
    const home = tmp();
    const run = runConnect(url, token, { home, identity, only: [], now: FIXED_NOW });
    expect(run.aborted).toBeDefined();
    expect(run.aborted!.reason.toLowerCase()).toContain('no targets');
  });

  it('formatConnectOutput reports the --only abort with a non-zero-worthy message (exit code is cli.ts\'s job)', () => {
    const out = formatConnectOutput({
      aborted: { reason: '--only named an unknown target: cursur', remedy: 'Valid targets: cursor, vscode' },
      results: [],
    });
    expect(out).toContain('cursur');
    expect(out).toContain('Valid targets');
  });
});

describe('token redaction: snippets hide the real token by default', () => {
  it('redacts the token in a skipped-target snippet (Zed with a JSONC config) unless --show-token is passed', () => {
    const home = tmp();
    const dir = join(home, '.config', 'zed');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'settings.json');
    writeFileSync(path, '{\n  // a comment Zed allows but JSON.parse rejects\n  "theme": "one-dark"\n}\n');

    const redacted = runConnect(url, token, { home, identity, only: ['zed'], now: FIXED_NOW });
    expect(redacted.results[0].status).toBe('skipped');
    expect(redacted.results[0].snippet).not.toContain(token);
    expect(redacted.results[0].snippet).toContain('<team-token>');
    expect(formatConnectOutput(redacted)).not.toContain(token);

    const shown = runConnect(url, token, { home, identity, only: ['zed'], now: FIXED_NOW, showToken: true });
    expect(shown.results[0].snippet).toContain(token);
    expect(formatConnectOutput(shown)).toContain(token);
  });

  it('redacts the token in a print-only snippet (Continue.dev) unless --show-token is passed', () => {
    const home = tmp();
    mkdirSync(join(home, '.continue'), { recursive: true });
    const redacted = runConnect(url, token, { home, identity, only: ['continue'], now: FIXED_NOW });
    expect(redacted.results[0].snippet).not.toContain(token);
    expect(redacted.results[0].snippet).toContain('<team-token>');
  });

  it('--dry-run does not bypass redaction: a skipped target under --dry-run still hides the token by default', () => {
    // Regression: the reported bug was specifically that --dry-run, sold as
    // the safe preview, still printed the real token whenever a target was
    // skipped (e.g. Zed's JSONC config failing to parse) — dry-run never
    // affected that code path at all.
    const home = tmp();
    const dir = join(home, '.config', 'zed');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'settings.json');
    writeFileSync(path, '{\n  // comment\n  "theme": "one-dark"\n}\n');
    const run = runConnect(url, token, { home, identity, only: ['zed'], now: FIXED_NOW, dryRun: true });
    expect(run.results[0].status).toBe('skipped');
    expect(run.results[0].snippet).not.toContain(token);
  });
});

describe('platform-specific paths: VS Code and Cline are detected on Linux and Windows too', () => {
  it('defaults to the macOS path when no platform is given (darwin)', () => {
    const home = tmp();
    mkdirSync(join(home, 'Library', 'Application Support', 'Code'), { recursive: true });
    const detected = listTargets(home, 'darwin').find((d) => d.id === 'vscode')!;
    expect(detected.path).toBe(join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json'));
    expect(detected.installed).toBe(true);
  });

  it('VS Code: resolves the Linux path (~/.config/Code/User/mcp.json) and writes there', () => {
    const home = tmp();
    mkdirSync(join(home, '.config', 'Code'), { recursive: true });
    const detected = listTargets(home, 'linux').find((d) => d.id === 'vscode')!;
    const expectedPath = join(home, '.config', 'Code', 'User', 'mcp.json');
    expect(detected.path).toBe(expectedPath);
    expect(detected.installed).toBe(true);

    const run = runConnect(url, token, { home, identity, only: ['vscode'], now: FIXED_NOW, platform: 'linux' });
    expect(run.results[0].status).toBe('written');
    const written = readJson(expectedPath) as any;
    expect(written.servers.teamshare.url).toBe('https://teamshare.example.com/mcp');
  });

  it('VS Code: resolves the Windows path (AppData/Roaming/Code/User/mcp.json) and writes there', () => {
    const home = tmp();
    mkdirSync(join(home, 'AppData', 'Roaming', 'Code'), { recursive: true });
    const detected = listTargets(home, 'win32').find((d) => d.id === 'vscode')!;
    const expectedPath = join(home, 'AppData', 'Roaming', 'Code', 'User', 'mcp.json');
    expect(detected.path).toBe(expectedPath);
    expect(detected.installed).toBe(true);

    const run = runConnect(url, token, { home, identity, only: ['vscode'], now: FIXED_NOW, platform: 'win32' });
    expect(run.results[0].status).toBe('written');
    const written = readJson(expectedPath) as any;
    expect(written.servers.teamshare.url).toBe('https://teamshare.example.com/mcp');
  });

  it('Cline: detects via the Linux globalStorage location', () => {
    const home = tmp();
    const extDir = join(home, '.config', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev');
    mkdirSync(extDir, { recursive: true });
    const detected = listTargets(home, 'linux').find((d) => d.id === 'cline')!;
    expect(detected.installed).toBe(true);

    const run = runConnect(url, token, { home, identity, only: ['cline'], now: FIXED_NOW, platform: 'linux' });
    expect(run.results[0].status).toBe('written');
    const written = readJson(join(extDir, 'settings', 'cline_mcp_settings.json')) as any;
    expect(written.mcpServers.teamshare.url).toBe('https://teamshare.example.com/mcp');
  });

  it('Cline: detects via the Windows globalStorage location', () => {
    const home = tmp();
    const extDir = join(home, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev');
    mkdirSync(extDir, { recursive: true });
    const detected = listTargets(home, 'win32').find((d) => d.id === 'cline')!;
    expect(detected.installed).toBe(true);
  });

  it('VS Code: does not report "installed" on Linux just because the macOS directory happens to exist under home', () => {
    const home = tmp();
    // Only the macOS-shaped directory exists; on a simulated Linux machine
    // this must not count.
    mkdirSync(join(home, 'Library', 'Application Support', 'Code'), { recursive: true });
    const detected = listTargets(home, 'linux').find((d) => d.id === 'vscode')!;
    expect(detected.installed).toBe(false);
  });
});
