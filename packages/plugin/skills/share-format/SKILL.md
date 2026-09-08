---
name: share-format
description: Use when publishing a note to the team with teamshare — distills a message into the strict, capped team-share format with no filler.
---

# Writing a team share

A team share is read by every engineer's agent at their next session start. It
must carry signal and nothing else.

## Format

| Field | Cap | Content |
|---|---|---|
| `what` | 200 chars | **Required.** One sentence: what changed or is happening. |
| `why` | 300 chars | Optional. Why teammates should care. |
| `action` | 200 chars | Optional. What they should do. Omit for pure FYI. |
| `tags` | 5 × 20 chars | Optional, lowercase. |
| `priority` | — | `fyi`, `heads-up`, or `blocking`. **Required.** |
| `project` | — | Optional. Scopes the note to ONE repository instead of the whole team. |
| `recipients` | 20 addresses | Optional. Addresses this note to specific people instead of the whole team. |

Pick `blocking` only when a teammate doing normal work would break something or
waste real time without knowing. Otherwise `heads-up`, or `fyi` for context
that needs no action.

## Register

Write like a commit message, not an email.

- No greetings, sign-offs, or "just wanted to let everyone know."
- No hedging: "might possibly want to consider maybe" → say the thing.
- No restating the request back to the user.
- Concrete names: files, branches, dates, commands — not "the recent changes."
- Present tense, active voice.

## References

When the thing being shared has a concrete identifier — a Jira key like
`PROJ-123`, a PR or issue URL, a commit SHA, a branch name — put it in the
share text. A bare reference is what lets a teammate's agent look it up
later, using tools that teammate already has.

## Scope

Most shares are for the whole team — leave `project` off. Set it only when
the note is genuinely about ONE repository, not merely written from inside
one ("I'm out sick today" is not about the repo you happen to be sitting in).
Pass whatever git remote you have (the output of `git remote get-url origin`
works, in any form) — the server normalizes it, so it doesn't need to match
any particular format by hand. A reader outside a repo, or in a different
one, still sees every team-wide share; scoping only ever narrows, and only
for readers who are themselves inside the matching repo.

## Recipients

Both `project` and `recipients` stay off by default — a share with neither
is team-wide, which is the common case and should be your default reading of
an unqualified "share this with the team."

Set `recipients` when the user names a specific person or a small group by
name: "tell Sam the migration is done," "let Priya and Sam know before you
merge." List their email address(es) as given on the roster — if you don't
already know an address from context, ask rather than guess one. Do not set
`recipients` for "let the backend team know" or similar group phrasing
unless the user actually names the individuals; a named team is not a list
of addresses, and the safe default there is still a team-wide (or
project-scoped) share.

Every address must belong to someone who has already connected at least
once — the tool will refuse an address it has never seen, or one that was
invited but hasn't connected yet, and it names which case and what to do
about it. If it refuses, relay that message rather than silently dropping
the recipient and broadcasting instead: a share addressed to the wrong
audience is worse than a failed one.

`project` and `recipients` can combine (a note for one person about one
repo), but most shares use neither.

## Examples

**Good:**
```
what:     Auth middleware refactor lands Friday.
why:      Session validation moves out of the API routes into middleware/auth.ts.
action:   Don't merge anything touching src/auth this week.
tags:     auth, refactor
priority: blocking
```

**Bad** — filler, hedging, no specifics:
```
what:     Hey team! Just a quick heads up that we might be making some changes
          to the auth stuff soon, so please be aware of that going forward!
```

## Procedure

1. Distill the user's message into the fields above.
2. Show the formatted share and ask the user to confirm or edit.
3. On confirmation, call the teamshare `share` tool.
4. Report the result: the share id and how many teammates will be notified —
   named, if it was addressed to specific people.
5. If the tool rejects the share for a cap, tighten that field and retry — do
   not pad other fields to compensate. If it rejects a recipient, tell the
   user which address and why (never on the team vs. invited but not yet
   connected read very differently) rather than retrying without it.
