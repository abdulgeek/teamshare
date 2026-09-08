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
  // git@host:owner/repo -> host/owner/repo
  const scp = /^[^@\s]+@([^:\s]+):(.+)$/.exec(raw);
  let rest: string;
  if (scp) {
    rest = `${scp[1]}/${scp[2]}`;
  } else {
    const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?(.+)$/i.exec(raw);
    if (!m) return null;
    rest = m[1];
  }
  const key = rest.replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase();
  return /^[a-z0-9.-]+\/.+/.test(key) ? key : null;
}
