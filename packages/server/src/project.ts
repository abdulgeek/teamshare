// The externally-facing shape of a project key: a lowercase host segment
// that starts with a letter or digit (never `.` or `-`, which is what keeps
// a path-traversal-shaped string like "../../etc" from ever passing as one),
// then a `/`-joined path. Used to VALIDATE a value someone else claims is
// already normalized — the HTTP /unread route's query parameter, and
// validateShare's `project` field — never to derive one; only normalizeProject
// below does that. Exported so both call sites share one definition instead
// of two regexes that could quietly drift apart.
export const PROJECT_KEY_SHAPE = /^[a-z0-9][a-z0-9.-]*\/[a-z0-9._/-]+$/;

/**
 * A project key that is the same for everyone on the team.
 *
 * The git remote is the only candidate: a directory basename collides across
 * orgs (`api`, `web`), and an absolute path differs on every machine. Anything
 * without a remote is deliberately unidentifiable — see the plan.
 */
export function normalizeProject(remoteUrl: string): string | null {
  const raw = String(remoteUrl || '').trim();
  if (!raw) return null;
  let rest: string;
  // SCP syntax (`user@host:path`) has no `://` anywhere in it — that is the
  // one thing that tells it apart from a URL. Checking for a scheme FIRST,
  // rather than trying the SCP pattern unconditionally, is the fix: the SCP
  // regex below is happy to match the `git@github.com:22` prefix of
  // `ssh://git@github.com:22/owner/repo.git`, mistaking an explicit port for
  // the SCP-style host:path separator and folding the same repo to a
  // different key than its HTTPS form. A URL's `:port` is a port, never a
  // path separator, and only a URL can have a scheme.
  if (!raw.includes('://')) {
    // git@host:owner/repo -> host/owner/repo
    const scp = /^[^@\s]+@([^:\s]+):(.+)$/.exec(raw);
    if (!scp) return null;
    rest = `${scp[1]}/${scp[2]}`;
  } else {
    const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/]+)(\/.*)?$/i.exec(raw);
    if (!m) return null;
    // The host may carry an explicit port (`github.com:22`); strip it before
    // folding, so `ssh://git@github.com:22/owner/repo` keys the same as
    // `https://github.com/owner/repo`.
    const host = m[1].replace(/:\d+$/, '');
    rest = host + (m[2] ?? '');
  }
  const key = rest.replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase();
  return /^[a-z0-9.-]+\/.+/.test(key) ? key : null;
}
