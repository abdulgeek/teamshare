// The shape of a project key: a lowercase host segment that starts with a
// letter or digit (never `.` or `-`, which is what keeps a path-traversal
// -shaped string like "../../etc" from ever passing as one), then a `/`-joined
// path of anything that is neither whitespace nor a control/format character.
//
// It is BOTH definitions, deliberately. It validates a value someone else
// claims is already normalized — the HTTP /unread route's query parameter, and
// validateShare's `project` field — and it is also the final guard
// normalizeProject returns through, so producer and validator cannot disagree
// about a single string. They used to: the path half was `[a-z0-9._/-]+` while
// normalizeProject accepted `.+` after the host, and an ordinary remote that
// landed in the gap (a Gerrit per-user path `.../a/~sam/tools`, a non-ASCII
// repo name, a URL with a query string) normalized fine on the hook side and
// came back 400 from /unread — costing that reader every share they would ever
// have received, with a token that was never wrong.
//
// Widened rather than narrowed, in that repair: a key is an opaque token,
// compared only for equality as a bound SQL parameter and printed on a digest
// line. Nothing reads it as a path or a URL, so the characters worth excluding
// are the ones that would make it lie on the line it is printed on
// (whitespace, control and bidi-format characters) — not every character git
// hosting happens to allow. Narrowing normalizeProject instead would have left
// those teams permanently unable to scope a share at all, which is the same
// silent loss wearing different clothes.
export const PROJECT_KEY_SHAPE = /^[a-z0-9][a-z0-9.-]*\/[^\s\p{Cc}\p{Cf}]+$/u;

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
  // The validator IS the guard, rather than a second regex that says roughly
  // the same thing: whatever comes back from here is by construction a key
  // /unread and validateShare will accept. That also closes the gap in the
  // other direction — the old guard's `[a-z0-9.-]+` host let `git@..:etc`
  // fold to `../etc`, the one shape a project key must never take.
  return PROJECT_KEY_SHAPE.test(key) ? key : null;
}
