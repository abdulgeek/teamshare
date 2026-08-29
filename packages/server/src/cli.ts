#!/usr/bin/env node
import { existsSync, mkdirSync, openSync, closeSync, unlinkSync, writeSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createApp } from './app.js';
import { getOrCreateToken, openDb, removeMember, rotateToken } from './db.js';

export interface Args {
  cmd: 'serve' | 'rotate-token' | 'remove-member' | 'help';
  port: number;
  dbPath: string;
  expiryDays: number;
  email?: string;
}

const DEFAULT_DB = join(homedir(), '.teamshare', 'teamshare.db');

export function parseArgs(argv: string[]): Args {
  const args: Args = { cmd: 'serve', port: 8787, dbPath: DEFAULT_DB, expiryDays: 14 };
  const rest = [...argv];

  const first = rest[0];
  if (first && !first.startsWith('-')) {
    if (first === 'serve' || first === 'rotate-token' || first === 'remove-member' || first === 'help') {
      args.cmd = first;
      rest.shift();
      if (args.cmd === 'remove-member' && rest[0] && !rest[0].startsWith('-')) {
        args.email = rest.shift();
      }
    } else {
      args.cmd = 'help';
    }
  }

  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (flag === '--port' && value) { args.port = Number(value); i++; }
    else if (flag === '--db' && value) { args.dbPath = value; i++; }
    else if (flag === '--expiry-days' && value) { args.expiryDays = Number(value); i++; }
  }

  return args;
}

// One server per database file. WAL is safe for concurrent readers but this
// process owns the file, and two servers on one DB is always a misconfiguration.
export function acquireLock(dbPath: string): () => void {
  const lockPath = `${dbPath}.lock`;
  mkdirSync(dirname(dbPath), { recursive: true });

  if (existsSync(lockPath)) {
    const pid = Number(readFileSync(lockPath, 'utf8').trim());
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (alive) {
      throw new Error(`a teamshare server is already running for ${dbPath} (pid ${pid})`);
    }
    unlinkSync(lockPath); // stale lock from a crashed process
  }

  const fd = openSync(lockPath, 'w');
  writeSync(fd, String(process.pid));
  closeSync(fd);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { unlinkSync(lockPath); } catch { /* already gone */ }
  };
}

const HELP = `teamshare — shared context for coding agents

Usage:
  teamshare serve [--port 8787] [--db <path>] [--expiry-days 14]
  teamshare rotate-token [--db <path>]
  teamshare remove-member <email> [--db <path>]
`;

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  if (args.cmd === 'help') {
    process.stdout.write(HELP);
    return;
  }

  mkdirSync(dirname(args.dbPath), { recursive: true });

  if (args.cmd === 'rotate-token') {
    const db = openDb(args.dbPath);
    const token = rotateToken(db);
    db.close();
    process.stdout.write(
      `New team token:\n\n  ${token}\n\nTeammates must re-run /teamshare-setup with this token.\n`,
    );
    return;
  }

  if (args.cmd === 'remove-member') {
    if (!args.email) {
      process.stderr.write('remove-member needs an email\n');
      process.exitCode = 1;
      return;
    }
    const db = openDb(args.dbPath);
    const removed = removeMember(db, args.email);
    db.close();
    process.stdout.write(removed ? `Removed ${args.email}\n` : `No member ${args.email}\n`);
    return;
  }

  const release = acquireLock(args.dbPath);
  const db = openDb(args.dbPath);
  const token = getOrCreateToken(db);
  const app = createApp({ db, expiryDays: args.expiryDays });

  const server = app.listen(args.port, () => {
    process.stdout.write(
      [
        `teamshare server listening on port ${args.port}`,
        `database: ${args.dbPath}`,
        '',
        'Team token (share with teammates, they run /teamshare-setup):',
        '',
        `  ${token}`,
        '',
        'WARNING: serve plain HTTP only on a trusted network. Put TLS in front for anything else.',
        '',
      ].join('\n'),
    );
  });

  const shutdown = () => {
    server.close(() => {
      db.close();
      release();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Run only when invoked as a program, so tests can import this module freely.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void main(process.argv.slice(2));
}
