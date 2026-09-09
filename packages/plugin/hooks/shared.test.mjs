import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { normalizeProjectKey, resolveProject, fetchUnread } from './shared.mjs';

describe('normalizeProjectKey', () => {
  it('folds every way of writing the same remote into one key, same as the server\'s normalizeProject', () => {
    const want = 'github.com/abdulgeek/teamshare';
    for (const url of [
      'https://github.com/abdulgeek/teamshare.git',
      'https://github.com/abdulgeek/teamshare',
      'git@github.com:abdulgeek/teamshare.git',
      'ssh://git@github.com/abdulgeek/teamshare.git',
      'https://user:token@github.com/abdulgeek/teamshare.git',
      'HTTPS://GitHub.com/AbdulGeek/TeamShare.git',
    ]) {
      expect(normalizeProjectKey(url), url).toBe(want);
    }
  });

  it('folds an SSH remote with an explicit port to the same key as its HTTPS form', () => {
    // Same regression the server-side fix guards: the SCP-style pattern
    // (`user@host:path`) used to match the `git@github.com:22` prefix of this
    // URL too, mistaking the port for the SCP separator.
    expect(normalizeProjectKey('ssh://git@github.com:22/owner/repo.git')).toBe(
      normalizeProjectKey('https://github.com/owner/repo.git'),
    );
  });

  it('never leaks a credential into the key', () => {
    expect(normalizeProjectKey('https://user:s3cret@github.com/a/b.git')).not.toContain('s3cret');
  });

  it('returns null for anything it cannot identify', () => {
    expect(normalizeProjectKey('')).toBeNull();
    expect(normalizeProjectKey('not a url')).toBeNull();
  });
});

describe('resolveProject', () => {
  let dir;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('returns undefined without touching git when cwd is missing', () => {
    expect(resolveProject(undefined)).toBeUndefined();
    expect(resolveProject('')).toBeUndefined();
  });

  it('returns undefined for a directory that is not a git repo, without throwing', () => {
    dir = mkdtempSync(join(tmpdir(), 'ts-noproject-'));
    expect(resolveProject(dir)).toBeUndefined();
  });

  it('returns undefined for a directory that does not exist at all', () => {
    expect(resolveProject(join(tmpdir(), 'ts-does-not-exist-xyz'))).toBeUndefined();
  });

  it('returns undefined for a real repo with no remote configured', () => {
    dir = mkdtempSync(join(tmpdir(), 'ts-norigin-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    expect(resolveProject(dir)).toBeUndefined();
  });

  it('returns the normalized project key for a repo with an origin remote', () => {
    dir = mkdtempSync(join(tmpdir(), 'ts-withorigin-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/api.git'], { cwd: dir });
    expect(resolveProject(dir)).toBe('github.com/acme/api');
  });
});

describe('fetchUnread', () => {
  let server;
  let origin;
  let lastUrl;

  beforeEach(async () => {
    lastUrl = null;
    server = http.createServer((req, res) => {
      lastUrl = req.url;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ total: 0, shares: [] }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('appends ?project= to the request when a project is given', async () => {
    await fetchUnread({ url: origin, token: 'tok' }, 1000, 'github.com/acme/api');
    expect(lastUrl).toBe('/unread?project=github.com%2Facme%2Fapi');
  });

  it('omits the project query parameter entirely when none is given', async () => {
    await fetchUnread({ url: origin, token: 'tok' }, 1000);
    expect(lastUrl).toBe('/unread');
  });
});
