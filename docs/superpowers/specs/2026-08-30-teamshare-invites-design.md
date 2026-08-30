# teamshare — per-email invites

**Date:** 2026-08-30
**Status:** Approved design (chosen after `2026-08-30-teamshare-per-user-tokens-design.md` was rejected at review)
**Supersedes:** the shared-token trust model in `2026-08-29-teamshare-design.md` §8

## Why the previous design was rejected

The rejected design had the lead distribute one *join* token that each teammate
silently redeemed for a personal one. It failed twice: the Claude Code plugin
cannot write back to `userConfig`, so a redeemed token had nowhere to live; and
because the join token was held by everyone, any holder could mint a credential
the server itself bound to a colleague's email — making forged receipts
**indistinguishable from genuine**, which is worse than today's honest
"advisory".

The lesson: identity must be bound by **someone other than the person claiming
it**. Once you accept that, the redemption machinery disappears entirely.

## The model

The lead mints a token **for** a specific person. That token *is* their
personal credential — there is nothing to redeem.

```
member_tokens (token_hash TEXT PRIMARY KEY,
               team_id, email, name,
               created_at, last_used_at, revoked_at)
INDEX (team_id, email)
```

`token_hash` is the primary key, **not** `(team_id, email)`. That is
deliberate: it lets one person hold several live tokens (laptop, desktop, CI)
and it makes revocation an explicit act rather than a side effect. The rejected
design's `(team_id, email)` key made membership a single slot, which produced a
one-request permanent lockout of any named teammate and made the ordinary
two-device case ping-pong forever.

## Two kinds of credential, two resolvers

- **Team token** (`teams.token_hash`) is now an **admin** credential: mint
  invites, revoke, read the roster, rotate. It grants **no** access to shares,
  receipts, or the digest.
- **Member token** grants data access and carries the holder's identity.

These are resolved by **separate functions** — `authenticateAdmin()` consults
only `teams`, `authenticate()` consults only `member_tokens`. Not one resolver
returning a `kind` field: with a shared resolver, the next route someone adds
is safe only if they remember to check the kind, and eventually one won't. Two
functions make the wrong thing unwritable, mirroring the existing
`authenticate` / `authenticateTeamOnly` split.

## Identity comes from the token, never the header

`authenticate()` returns `{ teamId, email, name }` read from `member_tokens`.

`X-Teamshare-Email` / `X-Teamshare-Name` are **ignored everywhere**. This
matters beyond auth: `touchMember` currently writes a `members` row from those
headers on **every request**. Left alone, a valid member could inject a phantom
member that appears in every share's unseen list forever, or refresh a
colleague's `last_seen` and destroy the "hasn't read it" versus "hasn't
connected in two weeks" signal that `receipts` exists to provide. After this
change `touchMember` takes its email and name from the token.

The headers stay accepted-and-ignored so existing clients keep working
unchanged; nothing reads them.

## Endpoints

- `POST /invites` `{email, name?}`, admin-authenticated → `{token}`, returned
  once. Rate-limited per IP, reusing the limiter already applied to
  `POST /teams`.
- `POST /revoke` `{email}`, admin-authenticated → revokes **every** live token
  for that email.
- `GET /members`, authenticated by an admin **or** member token of that team →
  the roster: who holds a live token, when they were last seen, how many
  devices. Scoped through `TeamScope` like every other route so it cannot
  become a cross-team oracle.

CLI and standalone equivalents: `teamshare invite <email> [name]`,
`teamshare revoke <email>`, `teamshare roster`, plus the same three in
`teamshare-team.mjs` so a lead needs no AWS access.

## The client does not change

This is the design's main practical advantage. The token a teammate pastes at
install is already their personal token, so `plugin.json`, `.mcp.json`,
`headers.sh`, `session-start.mjs` and `teamshare-connect.mjs` are all
untouched. No redemption, no new storage, no extra step for the teammate.

**"Untouched" here means no behavioural change.** It is not a claim that every
string in those files was already correct. `plugin.json`'s install prompt, for
one, still called this value the "Team token" — display text that this design
made wrong and that was corrected separately afterwards. Read this section as
scoping the code change, not as blessing the wording.

The lead's workflow changes: one `invite` per teammate, delivered individually,
instead of one token posted once. That is the cost of the property, and it is
paid by one person rather than by everyone.

## Migration (schema 4)

Nothing needs a table rebuild — `member_tokens` is new, and the existing tables
keep their shape. Add it as a fourth step in the existing versioned chain,
triggered on `schema_version` and never on table existence, inside the existing
per-step transaction. Do **not** add it to the frozen v1 `SCHEMA` constant.

**Migration mints nothing.** There is no channel to deliver a token: printing
tokens for the six existing members would write live credentials into the
systemd journal and CloudWatch, violating the no-credential-logging rule, and
would issue one to whichever rows are stale — precisely the ex-employee this
change exists to remove.

Consequence: at cutover every existing install 401s and needs an invite from
the lead. The 401 body must say exactly that. This is a deliberate one-time
break; a grace period accepting the old token for data access would just be
shipping the vulnerability with an end date, and any forged receipt written
during that window is permanent.

It is cheap now — the live instance has one real user — and expensive later.

The existing `members` rows stay as the historical roster, so `GET /members`
should render them as "invited, not yet active" until a token is used, making
the roster the migration's own progress bar.

## Tests

Beyond the schema-migration properties the existing suite already enforces
(fault injection per sub-step, structural equality against a fresh database,
ugly fixtures, `foreign_key_check` and `integrity_check`), the ones that prove
*this* change:

- The old team token gets 401 on `/unread` and `/mcp`, with the exact remedy
  text.
- A member token is rejected on `POST /invites` — a member cannot mint
  credentials.
- An admin token is rejected on `/unread` and `/mcp` — the invite credential
  cannot read data.
- **The forgery test:** authenticate with member A's token while sending
  member B's `X-Teamshare-Email`, and assert every effect — the published
  share's sender, the recorded receipt, and `touchMember`'s roster write — is
  attributed to A. This is the vulnerability; it needs a test that fails
  against today's code.
- Revoking an email kills all of that person's tokens and leaves others
  working.
- Two live tokens for one person both work (the multi-device case the previous
  design broke).
- Cross-team isolation does not regress.

## What this fixes, and what it does not

**Fixed:** impersonation within a team; receipts genuinely attributable;
per-person revocation without disturbing anyone else; and an ex-employee can be
removed in one command.

**Not fixed, and the README must say so:** the lead sees each token at mint
time and could act as that person. The lead is the trust anchor — this design
makes them explicitly so rather than pretending no anchor exists. Beyond that,
a token is still a bearer credential: whoever holds the file can act as its
owner, which is why revocation matters.
