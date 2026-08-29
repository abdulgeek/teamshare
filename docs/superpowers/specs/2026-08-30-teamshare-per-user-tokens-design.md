# teamshare — per-user tokens

**Date:** 2026-08-30
**Status:** REJECTED at review. Do not implement as written. See §Review outcome.
**Supersedes:** the shared-token trust model in `2026-08-29-teamshare-design.md` §8

## The problem

Within a team, teamshare's trust model is currently: one shared token, and
identity asserted by the client in `X-Teamshare-Name` / `X-Teamshare-Email`
headers. The README says so honestly, but the consequences are worse than
"advisory receipts":

- **No revocation.** Someone leaves the company and the only remedy is
  rotating the team token, which forces every remaining member to reconnect.
  In practice nobody does this, so ex-employees keep read access to the team's
  shared context indefinitely.
- **Impersonation is trivial.** Any token-holder can publish a share as a
  colleague — including a `blocking` one telling the team to do something.
- **Receipts are fiction.** Any token-holder can record a `viewed` receipt as
  anyone else, which *suppresses delivery of that share to that person
  permanently*. That is a silent denial of the product's core promise, and the
  victim never sees the share they were supposed to.

The token is also the invite, so it travels through Slack and lives in chat
history forever.

## The fix, without adding friction

Each member gets their **own** token, and identity is derived from the token
instead of being asserted alongside it.

The credential the team lead distributes becomes a **join token** — an invite,
not an access credential. It can create a membership and nothing else: it
cannot read a share, publish one, or record a receipt.

The redemption is invisible to the user. They paste the join token exactly as
they do today; the setup tooling detects it is a join token, redeems it for a
personal token, and stores that instead. **No extra step, no extra command.**
The number of things a teammate does is unchanged; what changes is that the
credential sitting on their disk is theirs alone and can be revoked
individually.

## Data model

```
member_tokens (team_id, email, token_hash UNIQUE, name,
               created_at, last_used_at, revoked_at NULL,
               PRIMARY KEY (team_id, email))
```

`teams.token_hash` stays, and becomes the **join** token exclusively.

Auth resolution order on every request:

1. SHA-256 the presented token.
2. Look it up in `member_tokens` where `revoked_at IS NULL`. A hit yields
   `{teamId, email, name}` — **the caller's identity, from the database.**
3. Otherwise look it up in `teams.token_hash`. A hit means this is a join
   token: permitted **only** on `POST /join`. On any other route it is a 401
   whose message says to run setup to exchange it — actionable, and it does
   not reveal whether the token is valid.
4. Otherwise 401.

`X-Teamshare-Email` / `X-Teamshare-Name` are **ignored for authentication**
once a personal token is presented. They remain accepted on `POST /join`,
where they supply the new member's identity, and are otherwise inert. The
server must never again derive who you are from a header you control.

## Joining

`POST /join`, authenticated by the join token, with the identity headers →
mints and returns a personal token, once.

Re-joining with the same email returns a **new** personal token and revokes
the previous one, so a lost laptop is handled by re-running setup rather than
by an admin. It also means the flow is idempotent from the user's point of
view.

Redemption is automatic in `teamshare connect`, in the standalone connector,
and in `/teamshare-setup`: present the token, and if the server says it is a
join token, redeem and store the personal one. The user never learns the
difference unless they look.

## Revocation

- `teamshare revoke-member <email> [--team <name>]` sets `revoked_at`. The
  next request from that person is a 401. This is what `remove-member` should
  always have been; keep `remove-member` as an alias that also revokes, since
  removing someone from the roster while leaving their credential live is a
  trap.
- Rotating the **join** token no longer disturbs existing members at all —
  their personal tokens are unaffected. That removes the reason nobody rotates
  it today.

## Roster

`GET /members` (authenticated by any member token of that team) returns who
has joined and when they were last seen. This is now meaningful — a name in
that list corresponds to someone who actually redeemed a token — and it
answers the lead's real question, "which of my eight teammates aren't set up
yet". Surface it via `teamshare doctor --roster`.

## Migration

Existing members authenticate with the team token today. After this change
that token is join-only, so **every existing install gets one 401 and must
re-run setup** — which redeems automatically, so it is one command, not a
re-onboarding.

This is a deliberate, one-time break rather than a grace period in which the
old shared token still grants data access. A grace period would mean shipping
the vulnerability and hoping people migrate; there is no version of "keep the
shared token working" that also fixes the problem.

It is cheap **now**, while the live instance has essentially no real users. It
would be expensive after the team onboards. That timing is the reason to do it
immediately rather than later.

The 401 body must say exactly what to run. A test asserts that message.

## What this fixes, and what it does not

Fixed: revocation per person; impersonation within a team; receipts becoming
evidence rather than decoration; and rotating the invite no longer punishing
everyone.

**Not fixed, and the README must keep saying so:** whoever holds the join
token can mint a membership claiming any name and email, because identity at
*mint* time is still self-asserted. Per-user tokens make identity durable and
revocable after the fact; they do not authenticate the initial claim. Closing
that needs an identity provider, which is out of scope. Mitigations that are
in scope: the roster makes an unexpected member visible, and the join token is
now rotatable at no cost to existing members.

## What must stay true

- Cross-team isolation is unchanged and must not regress.
- Tokens are stored hashed; plaintext is returned once and never recoverable.
- No credential is logged, echoed twice, or placed on a command line.
- Fail closed: an unknown, revoked, or wrong-kind token leaks nothing about
  what exists.
- Share text stays untrusted data behind the unpredictable fence.
- The teammate's step count does not increase. If the implementation adds a
  step, the design has failed.


## Review outcome — this design was rejected

Three reviewers attacked it against the real code. It failed on two
independent grounds, either of which is fatal.

**1. The premise is impossible on the primary client.** The whole design rests
on "the setup tooling detects a join token, redeems it, and stores the personal
one instead". On Claude Code the token lives in Claude Code's own `userConfig`,
prompted at install and read by `headersHelper`. **Nothing in the plugin can
write back to `userConfig`.** There is nowhere to put the redeemed token that
the MCP connection would read. Worse, `session-start.mjs` resolves
`CLAUDE_PLUGIN_OPTION_TEAMSHARE_TOKEN || fileCfg?.token`, so the join token
from plugin config would always win over any stored personal one — producing a
permanent 401 loop with no user action that could fix it.

**2. It would not have delivered the property it claimed.** The join token is,
by construction, held by every member and broadcast through Slack. Anyone
holding it can `POST /join` with a colleague's email, receive a token the
*server itself* binds to that email, and then publish shares, retract shares,
and record receipts as that person — now indistinguishable from genuine,
because the identity came from the database. Per-user tokens raise the bar only
against someone who never had the invite. The claim "receipts become evidence"
was false.

Additional blockers, each confirmed against the code: re-join-revokes makes
membership a single slot any invite-holder can steal, giving a one-request
permanent lockout of any named teammate and breaking the ordinary two-device
case; `/join` authenticated through the shared resolver would let any *member*
token mint credentials for any email; and `touchMember` would keep writing
roster rows from client headers after auth stopped trusting them, allowing
phantom members and `last_seen` forgery on the very surface receipts depend on.

## What actually fixes it

Identity must be bound **at mint time**, by someone other than the person
claiming it. The reviewers named the viable options:

- **Per-email invites.** The lead mints a token *for* `alice@corp.com`. The
  email comes from the lead, never from the joiner. No redemption step exists,
  so the client needs no change at all — the token a teammate pastes simply is
  their personal token. This is both the simplest and the strongest option.
- **Lead-approved joins.** Keep one shared invite; joins land as pending and
  the lead approves them. Distribution stays easy; the joiner waits.
- **An identity provider.** Correct, and far out of scope here.

The per-email-invite shape is recommended: it removes the redemption machinery
that made this design impossible, and it is the only option where the client
code does not change.
