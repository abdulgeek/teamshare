# teamshare — warn before the work starts

**Date:** 2026-09-09
**Status:** Implemented on `feat/reach-and-precision` (plugin 0.11.0)
**Depends on:** the `feat/reach-and-precision` branch (PR #3) — specifically `visibleToClause` in `packages/server/src/shares.ts` and the `UserPromptSubmit` hook in `packages/plugin/hooks/prompt-submit.mjs`

## The problem, from the case that prompted it

X publishes: *"EN-2022 is blocked on my auth refactor, done by end of day."* Y's assistant surfaces it that afternoon; Y says "not now", and it is marked read.

Next morning Y says **"pick up EN-2022"**. Claude opens the Jira ticket, reads the description and comments, greps the repo, opens six files, builds a mental model — tens of thousands of tokens and several minutes — and only then does Y discover the thing X told them yesterday.

The information existed. It reached Y. It was even acknowledged. It just was not *present at the moment it mattered*.

## Why today's mechanisms do not cover it

teamshare surfaces shares on two triggers, and both are about **arrival**:

- **Session start** — everything unread, once.
- **Mid-session** — anything that arrives while you work.

Neither is about **retrieval**. Nothing connects "the user just named EN-2022" to "somebody said something about EN-2022". Concretely, the case above fails four ways:

1. **The share is read.** Read shares leave the digest permanently. This is the common case, not the edge case: a warning is most needed *after* you have forgotten it.
2. **The digest renders only `what`.** A key that lives in `why` or `action` never reaches the reader's context at all.
3. **It ages out.** Past the seven-day relevance window an ordinary share stops being surfaced.
4. **Nothing can be asked.** `list_shares` filters by tag and sender. There is no text search, so even a Claude that wanted to check has no tool to check with.

Underneath all four: nothing *triggers* on the identifier. In the one case that does work — an unread share whose `what` contains the key — it works because Claude happens to notice a correspondence in its context, not because anything looked it up.

## The mechanism

The `UserPromptSubmit` hook already fires before every message and already injects context; that is what the mid-session nudge does. Its payload carries `prompt` — the user's actual words — and the hook currently discards that text entirely.

So: **extract identifiers from the prompt, ask the server whether anything was said about them, and inject the answer before the model reads the prompt.**

The timing is the whole point. The hook runs *before* the turn, so the warning lands before the Jira call, before the first `grep`, before any file is opened.

```
Y types:  "pick up EN-2022"
             │
   hook sees the prompt, extracts EN-2022
             │
   GET /mentions?keys=EN-2022     ← ~40ms, one round trip
             │
   injects:  X shared 4 hours ago — EN-2022 is blocked on their auth
             refactor, expected done end of day.
             │
   Claude answers, having read that first
```

Roughly fifty tokens against the tens of thousands the exploration would have cost, and against the far larger cost of Y duplicating work X is already doing.

## What counts as an identifier

Narrow and confident, deliberately. A fuzzy text search over prompts would fire constantly and the feature would be turned off within a week.

| Kind | Pattern | Example |
| --- | --- | --- |
| Ticket key | `\b[A-Z][A-Z0-9]{1,9}-\d+\b` | `EN-2022`, `PROJ-14` |
| Qualified PR/issue | `\b[\w.-]+/[\w.-]+#\d+\b` | `acme/api#412` |
| Bare PR/issue | `#\d{1,6}` — **only** when the prompt also names a repo, else too noisy | `#412` |

Not in v1: commit SHAs (they rarely appear in a share's prose), file paths (far too noisy), free text.

Cap at **5 keys per prompt**; a prompt naming more is a paste, not a question.

## The retrieval rule — where this differs from the digest

`GET /mentions` returns shares **regardless of read state, age, or project scope**. That inversion is the feature: the digest is about what you have not seen, this is about what was said. A share Y read and forgot is exactly the one that must come back.

Three things it still respects, and these are not negotiable:

- **`visibleToClause`.** A share addressed to somebody else must never surface through a key lookup. The `feat/reach-and-precision` branch put that gate in the accessors precisely so a new reader like this one inherits it. Reuse it; do not write a second rule.
- **Withdrawn shares stay withdrawn.** `stale_at IS NOT NULL` means the author said it no longer applies. Surfacing it would be worse than silence — it would send Y after a block that was lifted.
- **Never the reader's own share.** Y mentioning a key from Y's own note is not news.

Expired shares (past the instance's hard expiry) are excluded too — at that age the block has resolved or the ticket has moved on.

## No receipt is recorded

A mention is not a read. Y did not choose to read the share; the hook surfaced it unbidden. Recording a `viewed` receipt would let a warning Y never consciously registered suppress the share from Y's digest forever, and would corrupt X's answer to "who has seen this?".

This matters enough to be a test.

## Not repeating itself

The existing poll state (`~/.teamshare/poll.json`) already tracks announced share ids per server per session. Extend it with a `mentioned` map of `key -> [share ids]`, so a given (key, share) pair is announced at most once per session. Y saying "EN-2022" five times in an afternoon gets one warning.

Cap it the way `seenIds` is capped, and let a new session start fresh — a warning is worth repeating tomorrow.

## The loop runs both ways

The first framing was one-directional: warn Y before Y burns tokens. But the same lookup answers the other person's question too, because *"what has the team said about EN-2022?"* is a single question. What differs is what the reader should do with the answer.

- **Y is about to start.** A match means somebody already knows something. Warn, then get out of the way.
- **X is already working, and Y is waiting on them.** A match from someone *stuck* means X owes them a status line. Offer to publish it.
- **Nobody has said anything.** Silence.

We do not try to infer which side the reader is on from their prompt — that is unknowable and guessing it would be worse than useless. The **matched shares carry the signal instead**:

| What came back | What it means | What the assistant offers |
| --- | --- | --- |
| A share addressed to the reader (`to_me`) | A teammate spoke to them directly about this | Relay it, then offer to reply |
| A `blocking` share from someone else | That person is stuck on this | Relay it, then offer to publish a status back |
| The reader's **own** share | They already told the team | Say so. Do not offer to publish again |
| Nothing | Nobody has said anything | Say nothing at all |

So X, mid-work on EN-2022, types something that names it and sees:

```
teamshare: EN-2022 — Ravi is blocked on this (blocking, 2 hours ago).
Want me to tell them you are already on it and expect to land it today?
```

Saying yes publishes an ordinary share, addressed to Ravi via `recipients`. **Every hop is an explicit publish the user agreed to.** Nothing observes who looked up what, and no interest is recorded behind anyone's back — which is the alternative design, and it is worse: it makes the tool something that watches you rather than something you talk through.

That is what makes this a loop rather than a warning. X publishes a block; Y hits it and is warned; Y replies that they are waiting; X sees that on their next mention of the ticket and answers with a status. Four hops, each one a deliberate publish, all driven by the same key match.

### Why the lookup returns the reader's own shares

Flagged `mine`, and for one reason: so the assistant knows the reader has already published about this ticket and does not ask them to do it again. A nudge that fires after you have already done the thing is how a good prompt becomes an ignored one.

### What is deliberately not in v1

**The claim nudge** — *"nobody has said anything about EN-2022, want to tell the team you are on it?"* — fires on the empty result, which is the overwhelming majority of prompts naming a ticket key. Every passing mention of a ticket would become a request to publish. The loop above does not need it: it starts when the first person to be actually blocked publishes, and that person already has the motive.

If it is ever built, it belongs on the session-end hook rather than this one, where the assistant knows whether real work happened on that ticket instead of guessing from a single sentence.

## Cost and failure

- **One extra request per prompt containing a key**, not per prompt. Most prompts contain none and cost nothing beyond the regex.
- **Same 1.2s ceiling and silent failure as the existing poll.** A teamshare outage must stay invisible; a slow lookup must never delay a turn.
- **Fold into the existing request where possible.** The hook may already be making its poll call this prompt; when the poll fires and keys are present, send both in one round trip rather than two.
- The mention lookup is **not** subject to the 60-second poll throttle. Throttling it would mean the one prompt that names a ticket is the one that gets nothing.

## Surfaces

- **`GET /mentions?keys=EN-2022,PROJ-14`** — authenticated as the reader, scoped to their team, gated by `visibleToClause`. Returns matching shares with the same fields the digest carries (`id`, `sender_name`, `what`, `age`, `day`, `priority`, `project`), plus `to_me` and `mine` — the two flags the reciprocal offer above turns on.
- **A `mentions` MCP tool**, same semantics, so a reader in Cursor or Codex can ask directly — *"has anyone said anything about EN-2022?"* — and so Claude can check on its own initiative mid-task.
- **The hook**, which is the automatic path and the reason this exists.

Matching happens **on the server**. The client sends keys, not a query, and never downloads the corpus. Keys are matched case-insensitively against `what`, `why`, `action` and `tags`.

`LIKE '%EN-2022%'` over a team's shares is entirely adequate — the corpus is hundreds of rows, each field capped at a few hundred characters, and the alternative (FTS5) buys nothing at this size while adding a virtual table to the migration chain.

## What the reader sees

```
teamshare: EN-2022 — Ann shared 4 hours ago (Tuesday, 08-09-2026)
  Auth middleware refactor lands Friday; EN-2022 is blocked on it.
```

Injected as untrusted teammate data behind the same unpredictable per-render fence as every other share text, with the same instruction: mention it in one line, then answer what was actually asked. **It is a notice, never a block.** Y may be picking the ticket up deliberately, or taking it over from X. Refusing to proceed would be worse than the problem.

## Risks, and what I would watch

**False positives.** `EN-2022` is a plausible substring elsewhere. Word-boundary matching handles most of it; the residue is one extra line, which is cheap. If it proves noisy, the next lever is requiring the key to appear in `what` rather than any field.

**A quiet dependency on prompt text.** The hook starts reading what the user types, which it did not before. It must never send prompt text anywhere — only extracted, pattern-matched keys. Worth stating in the README, because "the plugin reads my prompts" deserves an honest answer, and the honest answer is "it extracts ticket keys and sends only those."

**Scope creep toward search.** The temptation will be to loosen the pattern until it is a general search. That turns a precise, trusted signal into background noise. The narrow trigger is the design.

## Out of scope

Any push notification or out-of-band alert: X learns Y is waiting the next time X names the ticket, not by being interrupted. Auto-linking teamshare to Jira. Any blocking or gating of anyone's work. The claim nudge, for the reason given above.

## What was built

- `packages/server/src/mentions.ts` — `findMentions`, the key shape, and the precise word-boundary matcher that `LIKE` cannot express.
- `GET /mentions?keys=…` in `app.ts`, and a `mentions` MCP tool in `mcp.ts` with the reciprocal guidance.
- `extractKeys` in the hooks' `shared.mjs`; the lookup, per-session memory and rendering in `prompt-submit.mjs`.
- 81 tests across four files, including the ones that matter most: an addressed share cannot leak through a key lookup, and a mention records no receipt.

Four things the build changed from this design, each because writing it exposed a problem the design did not see:

1. **A failed lookup still records the attempt.** Otherwise a teamshare outage costs a 1.2s timeout on every prompt naming a ticket, which is the one thing the hook may never do.
2. **The overflow past the display cap is not recorded as announced.** Recording it would drop the fourth share for a key silently and permanently; leaving it unrecorded lets the next lookup show it.
3. **The mention request is dispatched before the poll.** The poll opens with a synchronous `git remote get-url`, and anything after it in the same `Promise.all` would not have its request in flight until that returned.
4. **The reader's own shares come back flagged `mine`.** Needed for the reciprocal side: it is how the assistant knows not to ask someone to publish what they have already published.
