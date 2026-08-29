import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

describe('toolchain', () => {
  it('runs better-sqlite3 without segfaulting on this Node version', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE t (a TEXT)');
    db.prepare('INSERT INTO t (a) VALUES (?)').run('ok');
    const row = db.prepare('SELECT a FROM t').get() as { a: string };
    expect(row.a).toBe('ok');
    db.close();
  });
});
