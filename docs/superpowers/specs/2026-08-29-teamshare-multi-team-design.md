# teamshare — self-serve teams

**Date:** 2026-08-29
**Status:** Design, revised after adversarial review
**Supersedes:** the single-token model in `2026-08-29-teamshare-design.md` §3.1

## The problem

A teamshare server *is* one team today. The token is minted on first boot into
`config.team_token` and readable only by someone with AWS access running
`aws ssm send-command`. So only whoever owns the infrastructure can hand out a
token, a second team cannot use the server at all, and onboarding needs
Terraform and SSM — tools the people who want to *use* teamshare neither have
nor should need.

Any team should create their own team and get their own token without touching
AWS.

## Revision note

A first draft of this design was reviewed adversarially and failed. It is
recorded here because the failures are the reason for several rules below that
would otherwise look like over-engineering:

- Adding a `team_id` column while leaving existing queries alone would have put
  **team B's shares into team A's session-start digest automatically** — no
  attacker action required, because the hook calls `GET /unread` on every
  session.
- `list_shares` takes only optional arguments, so with no filters its SQL
  degraded to no `WHERE` clause at all: every tenant's newest shares, including
  the share **ids** that are the input to `read_share`, `retract`, `mark_stale`
  and `receipts`.
- `getShare(db, id)` is the sole existence check behind five tools, so one
  unscoped lookup exposed all five.
- `listMembers` is unscoped, so `receipts` on your *own* share returned every
  member of every team on the box — cross-tenant PII on the happy path.
- The migration trigger ("if `teams` does not exist") could never fire, because
  the schema is applied with `CREATE TABLE IF NOT EXISTS` before any migration
  logic runs.

The lesson driving §Isolation below: **a convention that every query "should"
filter by team is not a control.** It has to be impossible to write the
unscoped call.

## Data model

```
teams    (id PK, name, token_hash UNIQUE, signup_note, created_at,
          created_by_email)
members  (team_id, email, name, first_seen, last_seen,
          PRIMARY KEY (team_id, email))
shares   (id, team_id, sender_email, what, why, action, tags, priority,
          created_at, stale_at,
          PRIMARY KEY (id),
          UNIQUE (team_id, id))
receipts (team_id, share_id, member_email, status, at,
          PRIMARY KEY (team_id, share_id, member_email),
          FOREIGN KEY (team_id, share_id) REFERENCES shares(team_id, id)
            ON DELETE CASCADE)
```

`receipts` keys on `team_id` deliberately: without it, `ON CONFLICT(share_id,
member_email)` would overwrite another team's receipt row. The composite
foreign key means a cross-team receipt is rejected **by the database**, so a
missed `WHERE` clause in application code still fails closed — and the
`ON DELETE CASCADE` replaces `retractShare`'s manual receipt cleanup.

Indexes: `shares (team_id, created_at)` and `receipts (team_id, share_id)`.
`teams.token_hash UNIQUE` is the auth-path index — do not "tidy" it away, or
every authenticated request becomes a table scan.

## Isolation — structural, not conventional

Scoping is enforced by types, not by reviewers remembering.

- `authenticate()` returns `{ teamId, identity }`.
- A `TeamScope = { db: Db; teamId: string }` is constructible **only** inside
  the auth path.
- Every function in `shares.ts`, `unread.ts`, `receipts.ts`, and every member
  function in `db.ts` takes `scope: TeamScope` as its first parameter instead
  of `db: Db`.
- `mcp.ts` does not import `Db` at all, so a tool added later has no unscoped
  handle to misuse.

Specific queries that must change (each was a confirmed leak):

| Location | Fix |
|---|---|
| `unread.ts` `WHERE_UNREAD` | add `s.team_id = ?` to **both** the COUNT and SELECT bind lists; add `AND r.team_id = ?` inside the `NOT EXISTS`; scope the members join as `ON m.email = s.sender_email AND m.team_id = s.team_id` |
| `shares.ts` `listShares` | seed the statement as `WHERE team_id = ?` and append optional predicates to that non-empty base — `team_id` must never live in the optional clause array |
| `shares.ts` `getShare` | `WHERE team_id = ? AND id = ?` **in SQL**, never an unscoped fetch plus a JS comparison |
| `shares.ts` `createShare` notified count | scope the member count |
| `db.ts` `listMembers` | `WHERE team_id = ?` |
| `receipts.ts` `recordReceipt` | take a scope; make ownership part of the same statement via `INSERT ... SELECT ... WHERE EXISTS (SELECT 1 FROM shares WHERE team_id = ? AND id = ?)`, and report whether a row was written |
| `receipts.ts` `getReceipts` | scope both the receipts read and the roster |

**No existence oracle.** A foreign share id and a nonexistent one must produce
the byte-identical message `no share with id ${id}`. In particular
`retract`'s `only the author can retract a share` must never be reachable for
another team's share, because that message would confirm the id exists
somewhere on the instance.

## Authentication

`Authorization: Bearer <token>` → SHA-256 → look up `teams.token_hash`. A miss
is 401. Tokens are 192-bit random values, so a fast hash is right: these are
high-entropy secrets, not user-chosen passwords, and a slow KDF would add
latency to every request while buying nothing. Compare hashes, never raw
tokens. The plaintext is returned once at creation and is not recoverable.

## Creating a team

`POST /teams` `{"name": "..."}` → `{"team_id", "name", "token"}`.

Gated by an instance **signup secret** in `X-Teamshare-Signup-Secret`.

**The secret is operator-settable** via `--signup-secret` or
`TEAMSHARE_SIGNUP_SECRET`, and only generated on first boot if neither is
supplied. This matters: the first draft had it minted into a log line
readable only through SSM, which would have forced the operator through the
exact Terraform-and-SSM ritual this whole change exists to remove — to
bootstrap the feature that removes it. Setting it in the systemd unit makes it
recoverable and makes rotation a redeploy.

It is stored **plaintext**, compared with `timingSafeEqual`. It gates creation
only and never grants access to any team's data; recoverability is worth more
than hashing, and hashing would turn "lost the wiki page" into "redeploy the
server". `teamshare signup-secret --show` is the break-glass path.

`serve --open-signup` disables the gate for a trusted network and must log a
loud startup warning.

Because a shared secret leaks eventually, it is paired with controls that
still bound the damage afterwards: a per-IP rate limit on `POST /teams`, and a
`--max-teams` instance cap. Both are a few lines and hold when the secret does
not.

## Rotation — required, not deferred

Today `rotate-token` is documented as *the* remedy for a leaked token.
Shipping multi-team without per-team rotation would be a straight capability
regression: a team that lost its token could not recover it, could not rotate
it, and could not delete the dead team — their only move would be creating a
second team, abandoning every share and receipt and leaving an undeletable
orphan.

`POST /teams/rotate`, authenticated by the team's **current** token, so a team
self-serves without the operator. It is one `UPDATE` of `token_hash`.

The existing CLI commands must not silently no-op after migration:
`rotate-token` and `remove-member` either take `--team <name>` or fail loudly
telling the operator the server now hosts multiple teams. A test asserts
`rotate-token` on a migrated database genuinely invalidates the old token.

## Secrets never touch a command line

The existing `/teamshare-setup` command goes to real lengths to keep the token
out of argv and out of the session transcript. The first draft broke that
invariant by putting the signup secret in a slash-command argument and printing
the returned team token into the transcript.

- The signup secret is read from the environment or prompted for — never a
  positional argument.
- The standalone script may print the new token once, to a terminal.
- The plugin command must **not** print the token into the transcript; it
  writes it to the config store via a Node one-liner that never places the
  value in an executed command string, and reports only the team name and a
  status word.

## Migration

The live instance is on schema_version 2 with 6 members and a token in
`config.team_token`. Getting this wrong loses a team's memory or its access.

- **Versioned chain, not a one-shot branch.** `migrations = [{to: 2, fn}, {to: 3, fn}]`
  applied in order from whatever version the file reports. The existing
  `stale_at` patch folds in as the 1→2 step, so it too becomes atomic. A v1
  database must survive a direct hop to v3 — today it would fail on `no such
  column: stale_at`.
- **The trigger is `schema_version`, never "does table X exist".** The schema
  is applied with `CREATE TABLE IF NOT EXISTS` before any migration logic, so
  `teams` always exists by then and an existence check can never fire.
- **Rebuild, do not ALTER.** SQLite cannot add a `NOT NULL` foreign-key column
  to a populated table, and cannot change a primary key. `members` (PK change)
  and `shares`/`receipts` (new NOT NULL FK column) all require create-new,
  copy, drop, rename. Recreate the indexes explicitly afterwards — a rebuild
  drops them silently, leaving a migrated instance unindexed while a fresh one
  is fine.
- **Each step in a transaction**, so an interrupted migration leaves the file
  exactly at its previous version.
- **The existing token keeps working**: create one team named `default` with
  `token_hash` = SHA-256 of `config.team_token`, and stamp every existing row
  with its id.
- **No token present**: do not silently mint an unreachable team. Abort with a
  message telling the operator to run `teamshare create-team`. A database with
  no token *and* no rows is just a fresh install.
- `config.team_token` is left in place but never read again; note it vestigial.

### The migration test must not be the naive one

"Build a v2 database, open it, assert rows survived" passes against nearly
every broken variant above. Required instead:

1. Open **three times**; assert team count, member count and version are stable
   (catches non-idempotency and version downgrade).
2. **Fault injection**: throw after each step and assert the file is still
   exactly v2 — that is the only assertion that proves atomicity — then reopen
   and assert it completes.
3. **Structural** schema equality between a migrated and a fresh database,
   compared via `PRAGMA table_info` / `index_list` / `foreign_key_list`, not
   SQL text (text differs by whitespace and by the quoting `RENAME` leaves).
4. Drive the **real app** after migrating — an authenticated `GET /unread`,
   then create/read/receipt/retract — rather than asserting on raw `SELECT`s,
   so a broken `upsertMember` `ON CONFLICT` cannot slip through.
5. Fixtures: the exact production shape (6 members, 0 shares) **and** a fat one
   with shares, receipts and a stale share; empty and populated fail
   differently.
6. Ugly fixtures: v2 with rows but no token; v1 → v3 directly; a share whose
   sender is absent from `members`.
7. Post-migration isolation: a second team cannot see, read, retract or receipt
   the migrated team's share by id; finish with `PRAGMA foreign_key_check`
   empty and `PRAGMA integrity_check` = `ok`.

## Surfaces

Creation must work for someone who has installed nothing, which rules out
putting it behind the MCP connection — the plugin cannot connect without the
token the user is trying to obtain.

1. **Standalone, and this is the real first-time path** — a dependency-free
   file run with plain `node`. It must be a **separate entry point** from
   `teamshare-connect.mjs`: that file's argv contract is `<url> <token>`,
   it is documented as curl-and-run, and grafting a subcommand onto its
   positional parsing would silently break the documented path. A test pins
   the existing form.
2. **Plugin command** — scoped honestly to "create an additional team from a
   machine that already has the plugin working". It is not the bootstrap path,
   because installing the plugin prompts for the very token being created.
3. **Server CLI** — the break-glass path when the signup secret is lost.

Every surface ends by verifying: call `GET /health` and `GET /unread` with the
new token and report the result, or at minimum print the literal
`teamshare doctor <url> <token>` line. Every delivery failure in this system is
silent by design, so a lead who creates a team and distributes a token
otherwise has no evidence anything works.

Every surface also prints the **real** join instructions — including the
`git config --global` prerequisite, workspace trust, the Claude Code version
floor, and the restart — not a shortened version. That text is what a lead
pastes into Slack; if it understates reality they field questions all
afternoon.

## What must stay true

- **Cross-team isolation is absolute**, enforced by the type system and by
  database constraints, so a single missed `WHERE` clause cannot breach it.
- Identity remains client-asserted **within** a team; `created_by_email` is a
  self-reported hint, not evidence, and must be described that way.
- Share text stays untrusted data behind the unpredictable fence.
- No credential is logged, echoed twice, or placed on a command line.
- Fail closed: a missing or unknown team leaks nothing.

## Out of scope, named honestly

Per-user tokens, roles, team deletion, moving members between teams, any UI.

The biggest remaining friction after this ships is **not** team creation — it
is onboarding each teammate, which this change does not touch. The token is
the invite, it is a long-lived shared secret travelling through Slack, and
there is no roster view, so a lead's blocker moves from "I can't get a token"
to "I can't tell which two of my eight teammates aren't set up". An
authenticated roster (`GET /members`, surfaced via `doctor --roster`) is the
cheapest real dent and is the next thing worth building.
