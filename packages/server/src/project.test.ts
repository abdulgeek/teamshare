import { describe, it, expect } from 'vitest';
import { normalizeProject } from './project.js';

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
});
