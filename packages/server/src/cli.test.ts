import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, cpSync, symlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseArgs, acquireLock, formatServeBanner, runDoctor, main } from './cli.js';
import { openDb, hasToken, getOrCreateToken } from './db.js';

const dirs: string[] = [];
function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'teamshare-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('parseArgs', () => {
  it('defaults to serve on 8787 with a 14 day expiry', () => {
    const a = parseArgs([]);
    expect(a.cmd).toBe('serve');
    expect(a.port).toBe(8787);
    expect(a.expiryDays).toBe(14);
  });

  it('reads --port, --db, and --expiry-days', () => {
    const a = parseArgs(['serve', '--port', '9000', '--db', '/tmp/x.db', '--expiry-days', '30']);
    expect(a).toMatchObject({ cmd: 'serve', port: 9000, dbPath: '/tmp/x.db', expiryDays: 30 });
  });

  it('parses rotate-token and remove-member', () => {
    expect(parseArgs(['rotate-token']).cmd).toBe('rotate-token');
    expect(parseArgs(['remove-member', 'a@b.com'])).toMatchObject({
      cmd: 'remove-member',
      email: 'a@b.com',
    });
  });

  it('parses doctor', () => {
    expect(parseArgs(['doctor']).cmd).toBe('doctor');
  });

  it('parses connect with a url and token', () => {
    const a = parseArgs(['connect', 'https://ts.example.com', 'ts_abc123']);
    expect(a).toMatchObject({ cmd: 'connect', connectUrl: 'https://ts.example.com', connectToken: 'ts_abc123' });
  });

  it('parses connect --list without requiring a url/token', () => {
    const a = parseArgs(['connect', '--list']);
    expect(a).toMatchObject({ cmd: 'connect', connectList: true });
    expect(a.connectUrl).toBeUndefined();
    expect(a.connectToken).toBeUndefined();
  });

  it('parses connect --only, --dry-run, and --force', () => {
    const a = parseArgs(['connect', 'https://ts.example.com', 'ts_abc123', '--only', 'cursor,codex', '--dry-run', '--force']);
    expect(a.connectOnly).toEqual(['cursor', 'codex']);
    expect(a.connectDryRun).toBe(true);
    expect(a.connectForce).toBe(true);
  });
});

describe('help text', () => {
  it('documents doctor as a subcommand', async () => {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    // @ts-expect-error -- test-only stdout capture
    process.stdout.write = (chunk: string) => { chunks.push(String(chunk)); return true; };
    try {
      await main(['help']);
    } finally {
      process.stdout.write = original;
    }
    expect(chunks.join('')).toContain('doctor');
  });

  it('documents connect as a subcommand', async () => {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    // @ts-expect-error -- test-only stdout capture
    process.stdout.write = (chunk: string) => { chunks.push(String(chunk)); return true; };
    try {
      await main(['help']);
    } finally {
      process.stdout.write = original;
    }
    const out = chunks.join('');
    expect(out).toContain('connect');
    expect(out).toContain('--list');
  });
});

describe('connect wiring in main()', () => {
  it('errors and exits 1 when connect is called without a url/token or --list', async () => {
    const chunks: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    // @ts-expect-error -- test-only stderr capture
    process.stderr.write = (chunk: string) => { chunks.push(String(chunk)); return true; };
    try {
      await main(['connect']);
    } finally {
      process.stderr.write = original;
    }
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(chunks.join('')).toContain('--list');
  });
});

describe('formatServeBanner (spec §8 / README: token printed exactly once per generation)', () => {
  it('prints the token when it did not previously exist', () => {
    const out = formatServeBanner({
      port: 8787,
      dbPath: '/tmp/x.db',
      token: 'ts_abc123token',
      alreadyHadToken: false,
    });
    expect(out).toContain('ts_abc123token');
    expect(out).toContain('Team token');
  });

  it('omits the token and points to rotate-token when one already existed', () => {
    const out = formatServeBanner({
      port: 8787,
      dbPath: '/tmp/x.db',
      token: 'ts_abc123token',
      alreadyHadToken: true,
    });
    expect(out).not.toContain('ts_abc123token');
    expect(out).toContain('rotate-token');
    expect(out.toLowerCase()).toContain('already configured');
  });

  it('a first serve-path call prints the token; a second, against the same database, does not', () => {
    // Exercises the exact sequence main()'s serve path runs: check hasToken
    // BEFORE getOrCreateToken (which would otherwise mint one and erase the
    // distinction), then format the banner from that captured boolean.
    const db = openDb(':memory:');
    try {
      const beforeFirstServe = hasToken(db);
      expect(beforeFirstServe).toBe(false);
      const token = getOrCreateToken(db);
      const firstBanner = formatServeBanner({
        port: 8787, dbPath: ':memory:', token, alreadyHadToken: beforeFirstServe,
      });
      expect(firstBanner).toContain(token);

      // A second `serve` against the same (now-persisted) database.
      const beforeSecondServe = hasToken(db);
      expect(beforeSecondServe).toBe(true);
      const secondBanner = formatServeBanner({
        port: 8787, dbPath: ':memory:', token, alreadyHadToken: beforeSecondServe,
      });
      expect(secondBanner).not.toContain(token);
    } finally {
      db.close();
    }
  });
});

describe('doctor', () => {
  const originalHome = process.env.HOME;
  const originalTeamshareUrl = process.env.TEAMSHARE_URL;
  let home: string;
  let server: http.Server;
  let port: number;
  let respondHealth: (res: http.ServerResponse) => void;
  let respondUnread: (res: http.ServerResponse) => void;

  beforeEach(async () => {
    home = tmp();
    process.env.HOME = home;
    delete process.env.TEAMSHARE_URL;
    respondHealth = (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    };
    respondUnread = (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ total: 0, shares: [] }));
    };
    server = http.createServer((req, res) => {
      if (req.url === '/health') respondHealth(res);
      else if (req.url === '/unread') respondUnread(res);
      else { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    if (originalTeamshareUrl === undefined) delete process.env.TEAMSHARE_URL;
    else process.env.TEAMSHARE_URL = originalTeamshareUrl;
  });

  function writeConfig(extra: Record<string, string> = {}) {
    writeFileSync(
      join(home, '.teamshare.json'),
      JSON.stringify({
        url: `http://127.0.0.1:${port}`,
        token: 'tok_secret_value',
        name: 'Priya',
        email: 'priya@team.com',
        ...extra,
      }),
    );
  }

  it('fails with a remedy when ~/.teamshare.json is missing', async () => {
    const { exitCode, output } = await runDoctor();
    expect(exitCode).toBe(1);
    expect(output).toContain('.teamshare.json');
    expect(output).toContain('/teamshare-setup');
  });

  it('fails when the config is missing a required key', async () => {
    writeFileSync(join(home, '.teamshare.json'), JSON.stringify({ url: 'http://x', token: 't', name: 'A' }));
    const { exitCode, output } = await runDoctor();
    expect(exitCode).toBe(1);
    expect(output).toContain('/teamshare-setup');
  });

  it('passes end-to-end against a reachable, correctly-configured server, and never prints the token', async () => {
    writeConfig();
    process.env.TEAMSHARE_URL = `http://127.0.0.1:${port}`;
    const { exitCode, output } = await runDoctor();
    expect(exitCode).toBe(0);
    expect(output).not.toContain('tok_secret_value');
    expect(output).toContain('priya@team.com');
    expect(output).toContain('/health');
    expect(output).toMatch(/0 unread/);
  });

  it('flags a 401 on /unread and points to /teamshare-setup', async () => {
    writeConfig();
    respondUnread = (res) => { res.writeHead(401); res.end('{}'); };
    const { exitCode, output } = await runDoctor();
    expect(exitCode).toBe(1);
    expect(output).toContain('401');
    expect(output).toContain('/teamshare-setup');
  });

  it('flags a 400 on /unread and points to git config', async () => {
    writeConfig();
    respondUnread = (res) => { res.writeHead(400); res.end('{}'); };
    const { exitCode, output } = await runDoctor();
    expect(exitCode).toBe(1);
    expect(output).toContain('400');
    expect(output.toLowerCase()).toContain('git config');
  });

  it('reports an unexpected status code verbatim rather than mislabeling it', async () => {
    writeConfig();
    respondUnread = (res) => { res.writeHead(503); res.end('{}'); };
    const { exitCode, output } = await runDoctor();
    expect(exitCode).toBe(1);
    expect(output).toContain('503');
  });

  it('reports the URL tried when the server is unreachable', async () => {
    writeConfig({ url: 'http://127.0.0.1:1' });
    const { exitCode, output } = await runDoctor();
    expect(exitCode).toBe(1);
    expect(output).toContain('http://127.0.0.1:1');
  });

  it('warns when TEAMSHARE_URL is unset and the configured server is not the localhost default', async () => {
    // The known split: the session-start digest reads the URL straight out
    // of the config file and keeps working, but Claude Code resolves the MCP
    // server's URL from TEAMSHARE_URL at startup — so the tools silently
    // fail to connect. This is the whole reason doctor exists.
    writeConfig();
    const { exitCode, output } = await runDoctor();
    expect(exitCode).toBe(1);
    expect(output).toContain('TEAMSHARE_URL');
  });

  it('is satisfied when TEAMSHARE_URL is set, regardless of value', async () => {
    writeConfig();
    process.env.TEAMSHARE_URL = `http://127.0.0.1:${port}`;
    const { output } = await runDoctor();
    expect(output).toContain('TEAMSHARE_URL is set');
  });
});

describe('acquireLock', () => {
  it('allows one holder and refuses a second', () => {
    const dbPath = join(tmp(), 'teamshare.db');
    const release = acquireLock(dbPath);
    expect(() => acquireLock(dbPath)).toThrow(/already running/i);
    release();
    expect(() => acquireLock(dbPath)).not.toThrow();
  });

  it('reclaims a stale lock left by a crashed process', () => {
    const dbPath = join(tmp(), 'teamshare.db');
    mkdirSync(dirname(dbPath), { recursive: true });
    writeFileSync(`${dbPath}.lock`, '');            // truncated: pid parses as 0
    expect(() => acquireLock(dbPath)).not.toThrow();
  });

  it('reclaims a lock whose pid is no longer running', () => {
    const dbPath = join(tmp(), 'teamshare.db');
    mkdirSync(dirname(dbPath), { recursive: true });
    writeFileSync(`${dbPath}.lock`, '2147483646');  // implausibly high, not running
    expect(() => acquireLock(dbPath)).not.toThrow();
  });
});

describe('cli entry point', () => {
  it('runs main() when invoked as a program from a path containing spaces', () => {
    // Regression: import.meta.url percent-encodes spaces, so a naive
    // `file://${process.argv[1]}` guard silently no-ops on such paths.
    //
    // realpathSync here is unrelated to that bug: on macOS, os.tmpdir()
    // returns a path through a symlink (/var -> /private/var), and Node's
    // ESM loader resolves that symlink when computing import.meta.url while
    // process.argv[1] keeps the string as given. Resolving the real path
    // up front keeps this test isolated to the space-encoding regression
    // instead of also tripping over that unrelated symlink difference.
    const dir = realpathSync(tmp());
    const spaced = join(dir, 'a space dir');
    mkdirSync(spaced, { recursive: true });

    const serverRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

    // cli.js imports sibling compiled modules ('./app.js', './db.js', ...),
    // so the whole dist/ output must be copied alongside it, not just cli.js.
    cpSync(join(serverRoot, 'dist'), spaced, { recursive: true });

    // Node's node_modules resolution walks up from the spawned file's own
    // directory. A symlink here lets it find this package's real
    // dependencies (express, better-sqlite3, ...) without copying them.
    symlinkSync(join(serverRoot, 'node_modules'), join(spaced, 'node_modules'), 'dir');

    const cliJs = join(spaced, 'cli.js');
    const out = execFileSync('node', [cliJs, 'help'], { encoding: 'utf8' });
    expect(out).toContain('teamshare');
  });
});
