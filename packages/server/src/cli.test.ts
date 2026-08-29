import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, cpSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseArgs, acquireLock } from './cli.js';

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
});

describe('acquireLock', () => {
  it('allows one holder and refuses a second', () => {
    const dbPath = join(tmp(), 'teamshare.db');
    const release = acquireLock(dbPath);
    expect(() => acquireLock(dbPath)).toThrow(/already running/i);
    release();
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
