import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'session-start.mjs');

let home;
let server;
let port;
let respond;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'ts-home-'));
  respond = (res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ total: 0, shares: [] }));
  };
  server = http.createServer((req, res) => respond(res));
  await new Promise((r) => server.listen(0, r));
  port = server.address().port;
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
  rmSync(home, { recursive: true, force: true });
});

function writeConfig(extra = {}) {
  writeFileSync(
    join(home, '.teamshare.json'),
    JSON.stringify({
      url: `http://127.0.0.1:${port}`,
      token: 'tok_test',
      name: 'Priya',
      email: 'priya@team.com',
      ...extra,
    }),
  );
}

// NOTE: deliberately async (spawn), not execFileSync. The mock HTTP server
// above lives in this same process/event loop. execFileSync blocks that
// event loop until the child exits, so the server could never accept or
// respond to the child's request — a hard deadlock, broken only by the
// hook's own 1.5s abort firing (verified hands-on: with execFileSync, the
// "digest"/"401"/"capped" cases always time out and empty-output cases only
// pass by coincidence). spawn() keeps the loop free so the server can reply.
function runHook(payload = { hook_event_name: 'SessionStart', source: 'startup' }) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [HOOK], { env: { ...process.env, HOME: home } });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('error', reject);
    child.on('close', () => resolve(stdout));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

describe('session-start hook', () => {
  it('prints nothing when there is no config', async () => {
    expect((await runHook()).trim()).toBe('');
  });

  it('prints nothing when there are no unread shares', async () => {
    writeConfig();
    expect((await runHook()).trim()).toBe('');
  });

  it('prints a digest with ids, sender, and untrusted-data markers', async () => {
    writeConfig();
    respond = (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        total: 1,
        shares: [{
          id: 'shr_abc123',
          sender_name: 'Adnan',
          sender_email: 'adnan@team.com',
          created_at: '2026-08-29T09:00:00.000Z',
          priority: 'blocking',
          what: 'Auth refactor lands Friday.',
        }],
      }));
    };
    const out = await runHook();
    expect(out).toContain('shr_abc123');
    expect(out).toContain('Adnan');
    expect(out).toContain('Auth refactor lands Friday.');
    expect(out).toContain('BEGIN UNTRUSTED');
    expect(out).toContain('read_share');
    expect(out).toContain('acknowledge');
    expect(out).toContain('only for shares the user explicitly answered');
  });

  it('reports "and N more" when the digest is capped', async () => {
    writeConfig();
    respond = (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        total: 25,
        shares: [{
          id: 'shr_1', sender_name: 'A', sender_email: 'a@t.com',
          created_at: '2026-08-29T09:00:00.000Z', priority: 'fyi', what: 'one',
        }],
      }));
    };
    expect(await runHook()).toContain('24 more');
  });

  it('prints a visible notice on 401 rather than failing silently', async () => {
    writeConfig();
    respond = (res) => { res.writeHead(401); res.end('{"error":"bad token"}'); };
    expect(await runHook()).toContain('/teamshare-setup');
  });

  it('exits 0 and prints nothing when the server is unreachable', async () => {
    writeConfig({ url: 'http://127.0.0.1:1' });
    expect((await runHook()).trim()).toBe('');
  });

  it('prints nothing on a compact session, even if invoked', async () => {
    writeConfig();
    respond = (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        total: 1,
        shares: [{
          id: 'shr_x', sender_name: 'A', sender_email: 'a@t.com',
          created_at: '2026-08-29T09:00:00.000Z', priority: 'fyi', what: 'x',
        }],
      }));
    };
    const out = await runHook({ hook_event_name: 'SessionStart', source: 'compact' });
    expect(out.trim()).toBe('');
  });
});
