import { describe, it, expect } from 'vitest';
import { normalizeProject, PROJECT_KEY_SHAPE } from './project.js';

describe('normalizeProject', () => {
  it('folds every way of writing the same remote into one key', () => {
    const want = 'github.com/abdulgeek/teamshare';
    for (const url of [
      'https://github.com/abdulgeek/teamshare.git',
      'https://github.com/abdulgeek/teamshare',
      'git@github.com:abdulgeek/teamshare.git',
      'ssh://git@github.com/abdulgeek/teamshare.git',
      'https://user:token@github.com/abdulgeek/teamshare.git',
      'HTTPS://GitHub.com/AbdulGeek/TeamShare.git',
    ]) {
      expect(normalizeProject(url), url).toBe(want);
    }
  });

  it('never leaks a credential into the key', () => {
    expect(normalizeProject('https://user:s3cret@github.com/a/b.git')).not.toContain('s3cret');
  });

  it('folds an SSH remote with an explicit port to the same key as its HTTPS form', () => {
    // Regression: the SCP-style regex (`user@host:path`) used to match the
    // `git@github.com:22` prefix of this URL too, mistaking the port for the
    // SCP separator and yielding `github.com/22/owner/repo` — a different key
    // than the HTTPS form of the identical repo, which would silently miss a
    // scoped share's readers.
    expect(normalizeProject('ssh://git@github.com:22/owner/repo.git')).toBe(
      normalizeProject('https://github.com/owner/repo.git'),
    );
    expect(normalizeProject('ssh://git@github.com:22/owner/repo.git')).toBe('github.com/owner/repo');
  });

  it('returns null for anything it cannot identify', () => {
    expect(normalizeProject('')).toBeNull();
    expect(normalizeProject('not a url')).toBeNull();
  });

  // The producer and the validator have to agree, or a perfectly ordinary
  // remote becomes a permanent outage for the person who has it: the hook
  // normalizes it happily, sends it as ?project=, and /unread answers 400 to
  // every session that machine will ever start. Nothing about the token is
  // wrong; the reader simply never sees another share. So this is a property,
  // not a list of examples — every key this function mints must be a key
  // PROJECT_KEY_SHAPE accepts.
  it('only ever mints keys that PROJECT_KEY_SHAPE accepts', () => {
    for (const url of [
      'https://github.com/acme/api.git',
      'git@github.com:acme/api.git',
      'ssh://git@github.com:22/owner/repo.git',
      // The three the reviewer verified reachable, each of which used to
      // normalize cleanly here and be rejected by app.ts with a 400.
      'https://gerrit.example.com/a/~sam/tools',
      'https://gitlab.com/acme/caf\u00e9',
      'https://github.com/acme/api?ref=main',
    ]) {
      const key = normalizeProject(url);
      expect(key, url).not.toBeNull();
      expect(PROJECT_KEY_SHAPE.test(key as string), `${url} -> ${key}`).toBe(true);
    }
  });

  it('refuses a remote that would fold into a path-traversal-shaped key', () => {
    // `..` is a perfectly legal host as far as the SCP pattern is concerned,
    // and the old final guard (`[a-z0-9.-]+/.+`) let it through as
    // `../etc/passwd` — a key PROJECT_KEY_SHAPE has always rejected, which is
    // the same producer/validator disagreement seen from the other side. The
    // guard is now the shape itself, so the two cannot drift.
    expect(normalizeProject('git@..:etc/passwd')).toBeNull();
    expect(normalizeProject('https://.hidden/owner/repo')).toBeNull();
  });

  it('never mints a key with whitespace or a control character in it', () => {
    // A key is rendered onto a digest line a human reads. A newline or a bidi
    // override in one is not a scoping bug, it is a rendering attack, and the
    // shape is where that is decided for both the producer and the validator.
    expect(normalizeProject('https://github.com/acme/a b')).toBeNull();
    expect(normalizeProject('https://github.com/acme/a\u202eb')).toBeNull();
  });
});
