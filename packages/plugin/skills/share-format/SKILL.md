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
4. Report the result: the share id and how many teammates will be notified.
5. If the tool rejects the share for a cap, tighten that field and retry — do
   not pad other fields to compensate.
