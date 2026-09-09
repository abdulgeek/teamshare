# teamshare

Your whole team uses AI coding assistants. None of them know what the others
have been told.

teamshare fixes that. One person says *"share with the team that the auth
refactor lands Friday"*. Everyone else's assistant tells them at the start of
their next session, and asks if they want the details. Saying yes **or** no
counts as read — so you can always ask *"who's seen this?"* and get a real
answer.

It also works the other way round. Name a ticket — *"let's pick up
EN-2022"* — and if a teammate has already published something about it,
you're told **before** Claude opens the ticket and starts reading your
codebase. Even if you read that note last week and forgot. And if someone
is stuck behind work you're doing, naming the ticket offers to send them a
status back.

A server is already running. You never need its address. Everything below is
either a slash command or a single copy-paste line.

**Jump to your setup:**

- **[Part 1 — Claude Code](#part-1--claude-code)**
- **[Part 2 — Cursor, Codex, Windsurf, and the rest](#part-2--cursor-codex-windsurf-and-the-rest)**

Every output block on this page is real, captured from a running server.

---



# Part 1 — Claude Code



## Step 1 · Install

```
/plugin marketplace add abdulgeek/teamshare
/plugin install teamshare
```

It asks for **one** thing: your personal token. Then trust the workspace when
prompted, and restart Claude Code.

**Don't have a token yet?** Then you're the first one here — go to Step 2A.
If your team already uses teamshare, ask whoever set it up to run
`/teamshare:invite your@email.com` and send you the result. That's Step 2B.

---



## Step 2A · You're setting up the team

One command — the org name only. Do not paste a signup secret.

```
/teamshare:create-team <org-name>
```

create-team recovers the live signup secret on this machine (local terraform
state, a pin from a previous recover, or `TEAMSHARE_INSTANCE_ID` — never an
id shipped in the plugin). A freshly minted `tss_…` is **not** that secret
and the hosted server will reject it.

`/teamshare:generate-secret` is optional: it prints a copy of the live value
for a password manager. Use `--new` only when you are standing up a server
that does not exist yet.

Run create-team **once** per team name on this machine. A second run with the
same name does not mint another team — it names the one you already have.

```
teamshare create-team — success

Team: Platform (tm_6c772dbd6de4)
Server: https://54.90.22.249.sslip.io

Team token (shown once — this cannot be recovered later; save it in a password manager now):

  ts_fb5bcb7f5bd6c1a04e7d…

Verifying the new token against the live server:

[OK] server reachable at https://54.90.22.249.sslip.io/health
[OK] https://54.90.22.249.sslip.io/members returned 200 (0 known email(s))
```

**Save that token in your password manager.** It's also saved automatically to
`~/.teamshare/admin.json`, so you'll never type it again — but that file dies
with this laptop.

It's an **admin** token. It can invite people, remove them, and list them. It
**cannot** read shares. So it can't log you in — which is why the next step
matters.

### Now invite everyone, starting with yourself

```
/teamshare:invite you@yourcompany.com "Your Name"
```

```
teamshare invite — success

Invited: Sam <sam@acme.com>

Personal token for sam@acme.com (shown once — this cannot be recovered later; save it in a password manager now):

  tsm_2a96b76e46df8c31b0…

Send this token privately to sam@acme.com only — never post it in a shared channel or thread with
others on the team. Whoever holds it can publish shares and record read receipts as this person.
```

It also prints a ready-to-send message. **DM it to that person** — one per
teammate, never a group channel.

### Paste your own personal token

The invite printed a token starting with `tsm_`. That is **not** the admin
`ts_…` token from create-team, and it is the only value that logs you in.

```
/plugin configure teamshare@teamshare
```

Paste the `tsm_…` token. Restart Claude Code (or open a new session). Now
you're on the board too.

---



## Step 2B · You're joining a team

Your lead sends you a token starting with `tsm_`. Paste it into the install
prompt from Step 1. That's it — no address to look up, no file to edit, no git
setup.

Already installed and just need to change the token?
`/plugin configure teamshare@teamshare`.

---



## Step 3 · Use it

Talk normally. You never type a tool name.

**Share something:**

```
/teamshare:share Auth middleware refactor lands Friday. Session validation
moves into middleware/auth.ts. Don't merge anything touching src/auth.
```

Your assistant tightens it up, shows you, and publishes when you confirm:

```json
{ "id": "shr_ddd81b0b4b92", "notified": 5 }
```

Five teammates will see it at their next session start.

Shares are short on purpose. The server rejects anything longer: 200
characters for what changed, 300 for why it matters, 200 for what to do. That
cap is why people keep reading them.

**What your teammates see**, before they type anything:

```
3 unread team share(s) published by teammates.
  - id=shr_75c1350c76bb | BLOCKING | from Ann | 3 hours ago (Tuesday, 08-09-2026)
    Auth refactor lands Friday.
  - id=shr_6e02cc993393 | BLOCKING | from Ann | 10 days ago (Saturday, 29-08-2026) | old
    Ancient blocking note nobody closed.
  - id=shr_b699466a1071 | FYI | from Ann | 2 days ago (Sunday, 06-09-2026) | recent
    Design review moved to Thursday.

  (1 older unread share(s) held back — ask for the backlog if you want them.)
```

Their assistant asks if they want details. Yes shows the full note; no skips
it. Either way it's marked read and won't nag them again.

That's the *arrival* half. The other half fires when someone names a ticket
key later on, long after the note stopped being unread — see
[Before you start on a ticket](#before-you-start-on-a-ticket).

### How old is it, and does it still matter?

Every share carries **when it was published** — as a relative age *and* a
readable date: `3 hours ago (Tuesday, 08-09-2026)`. Your assistant can tell you
when something was shared without guessing, because the server computes both
rather than leaving Claude to do date maths against a clock it can't see.

No ISO timestamps anywhere. `2026-09-08T11:57:15.607Z` is precise, unreadable,
and nobody deciding whether a note still matters wants milliseconds. Dates
render in UTC — the server can't know your timezone, and the relative age
resolves any near-midnight ambiguity.

Each one also carries a **relevance grade**, and it decides what gets pushed at
you:

| Grade | Age | Surfaced unprompted? |
| --- | --- | --- |
| *(none)* | under a day | yes |
| `recent` | 1–3 days | yes |
| `ageing` | 3–7 days | yes |
| `old` | over 7 days | **no** — held back and counted |
| `irrelevant` | author withdrew it | **no** — hidden from the team entirely |
| `expired` | over 14 days | no |

So a session doesn't open with a week-old note about a deadline that has
already passed. Two deliberate exceptions:

- **`blocking` shares keep showing past 7 days.** That label means "you must
  not miss this", and quietly dropping one while it's still unread would break
  the promise it makes. It gets labelled `still blocking, but old` instead.
- **Nothing is ever silently hidden.** The digest says how many it held back,
  and *"show me the older shares"* returns them. `list_shares` never hides
  anything.

The grade shows up in the summary line and in the full detail, so you can skip
something without opening it:

```
Share shr_b699466a1071 from ann@x.com, shared 2 days ago (Sunday, 06-09-2026):
WHAT:   Design review moved to Thursday.
PRIORITY: fyi
SHARED: 2 days ago — Sunday, 06-09-2026
RELEVANCE: recent
```

### Scoping a share to one repository

Most shares are for the whole team. Some aren't — a backend deploy note
shouldn't reach a frontend engineer's session, and a note about one service
shouldn't reach someone working on an unrelated one. Publishing is opt-in:
your assistant sets a project scope only when the note is genuinely about one
repository, never just because you happened to be sitting in it — "I'm out
sick today" published from inside a repo is still team-wide.

The scope key is your git remote (`git remote get-url origin`), folded to one
form regardless of how it's written — `https://github.com/acme/api.git`,
`git@github.com:acme/api.git`, and every other spelling of the same remote
all resolve to `github.com/acme/api`. There's no separate ID to set up or
remember; it's the one thing about a repository that's already the same for
everyone on the team.

Reading is automatic. Each session resolves its own remote the same way and
narrows the digest to that repository's shares plus every team-wide one — you
never ask for it, and there's nothing to configure. **A reader outside any
repository, or in a repository with no remote, sees the entire board** —
narrowing only ever happens for a reader who is themselves inside the
matching repo, so nobody loses shares by working from a scratch directory.

A scoped share says so, right on its line:

```
- id=shr_75c1350c76bb | BLOCKING | from Ann | 3 hours ago (Tuesday, 08-09-2026) | github.com/acme/api
    Auth refactor lands Friday.
```

That's what tells a colleague on a different repository why they never saw
it — not silence, but a project scope that plainly wasn't theirs.

### Addressing a share to specific people

Sometimes a note is for one person, not the whole team or even one
repository — *"can you review PR #482 before EOD?"* doesn't belong in
everyone's digest. Your assistant sets `recipients` only when you actually
name someone; an unqualified "share this" is still team-wide, same as
leaving `project` off. The two combine — a note for one person about one
repo — but most shares use neither.

**Just say their name.** You never need to look up an email. The roster has
carried a name since you invited them, so all of these reach the same
person:

```
tell Sam I'm on EN-2022, doing the middleware refactor first
@Sam I pushed the branch
let Sam Okafor know before you merge
```

Two people called Priya? It refuses and names both, rather than guessing:

```
"Priya" matches 2 people on this team: Priya Raman <priya@acme.com>, Priya
Nair <priyan@acme.com>. Ask which one they mean and pass that address — a
private note sent to the wrong person is silent, so this will not guess.
```

A name that matches nobody is refused too, and never falls back to telling
everyone. That fallback is the one failure worth designing against: a note
meant for one person, broadcast to the team.

**Teach it a nickname** once and it sticks, privately to you:

```
Pri is priyan@acme.com — remember that
```

```
Saved: "pri" means priyan@acme.com.
```

From then on *"tell Pri it's ready for review"* just works, and your name
for someone never affects what your teammates' names resolve to. Ask *"who's
on the team?"* any time to see the roster, saved names, and anyone invited
who hasn't connected yet.

**Someone not on your team can't be reached at all**, by name or by address.
A share is delivered by being readable to that person's token, and a
stranger holds none. Invite them and everything above works.

They narrow differently, though. Scope (above) only ever narrows for a
reader who is themselves inside the matching repo — everyone else still
sees a scoped share. Addressing is stricter: once a share names people, it
reaches **only** them, full stop, regardless of where anyone is working.

Captured from a live server: one team lead (Ana) and three invited
teammates — Priya, Sam, and Maya — each already connected once.

**An unscoped share reaches all three.** Ana shares *"Standup moved to 10am
starting Monday"* with neither `project` nor `recipients` set. Priya's,
Sam's, and Maya's `unread` all show it.

**A share scoped to one repository reaches only a reader in that repo.**
Ana shares *"API auth middleware refactor lands Friday"* scoped to
`github.com/acme/api`. Sam, narrowed to that same repo, sees it:

```
- [shr_ab410596cd6f] HEADS-UP from ana · just now (Tuesday, 08-09-2026) | github.com/acme/api: API auth middleware refactor lands Friday.
```

Maya, narrowed to a different repo (`github.com/acme/web`), doesn't — her
digest has only the team-wide standup note.

**An addressed share reaches only its recipient.** Ana addresses *"Can you
review PR #482 before EOD?"* to Sam alone (`recipients:
["sam@example.com"]`). Sam's digest marks it **to you** — never the
recipient list itself, which is nobody else's business to see:

```
- [shr_ff6f1bd38b9d] HEADS-UP from ana · just now (Tuesday, 08-09-2026) | to you: Can you review PR #482 before EOD?
```

Priya, who wasn't named, doesn't see it at all — her digest still has only
the team-wide and scoped notes. Nor can she reach it any other way: it isn't
in her `list_shares`, and asking for it by id — or asking who it went to —
gets her the same *"no share with id …"* that a completely made-up id gets.
Being addressed isn't a delivery preference, it's who the share belongs to.

**Receipts narrow the same way.** Asking "who's seen the PR share?" reports
only the person it was actually addressed to:

```
0 viewed, 0 dismissed. Not yet seen by: sam@example.com (last seen just now).
```

**Every recipient must already be a connected teammate** — invited *and*
having opened their assistant at least once against this server. An address
that was never invited is refused outright, naming it:

```
not on this team: ghost@nowhere.com. Check the address — a typo here would
address the share to nobody — or invite them (`teamshare invite <email>`)
before addressing a share to them.
```

An address that **was** invited but hasn't connected yet gets a different
answer, because the fix is different — there's nothing to check, they just
need to show up once:

```
invited but not yet connected: newhire@example.com. They need to connect
once (open their assistant so it authenticates against this server) before
you can address a share to them directly — a team-wide share still reaches
them in the meantime.
```

### Before you start on a ticket

The digest answers *"what haven't I seen?"* — so once you've read something,
it's gone from it for good. That's usually right, and occasionally very
wrong:

> Monday afternoon, Ravi shares *"EN-2022 is blocked on my auth refactor,
> done end of day."* You see it, say "not now", and get on with your
> evening.
>
> Tuesday morning you say **"let's pick up EN-2022."** Claude opens the
> ticket, reads the comments, greps the repo, opens six files — and twenty
> thousand tokens later you rediscover what Ravi told you yesterday.

So teamshare also watches for **ticket keys and pull-request references in
what you type**. When you name one, it asks the server whether anybody has
published anything about it — read or unread, recent or not, whatever repo
you're in — before Claude answers you:

```
teamshare: EN-2022 — Ravi is blocked on this (blocking, since yesterday).
He expects to land the auth refactor end of day. Want me to tell him
you've picked it up?

Meanwhile, here's what EN-2022 involves…
```

**It works in the other direction too.** If you're the one doing the work
and a teammate has published that they're stuck behind you, naming the
ticket surfaces that — and offers to publish a status back to them, so they
learn where it stands without asking. It never publishes anything without
you saying yes.

If you've already shared something about that ticket yourself, it says so
and doesn't ask you to do it again. And if nobody has published anything, it
stays completely silent — which is most of the time, and is the point.

**What it triggers on**, deliberately narrowly: ticket keys like `EN-2022`
or `PROJ-14`, and repo references like `acme/api#412`. Not free text. A
warning that fires on every other message is a warning nobody reads, so it
fires on identifiers or not at all. Things shaped like ticket keys but
aren't — `UTF-8`, `SHA-256`, `GPT-4` — are ignored.

**What leaves your machine.** Only the identifiers themselves. The hook
reads your prompt to pull `EN-2022` out of it; the prompt text never goes
anywhere. `"pick up EN-2022, the customer is furious"` sends exactly
`EN-2022`.

Two more things worth knowing. Seeing a warning **doesn't mark anything as
read** — you never chose to read it, so it stays in your digest and its
author still sees you as not having answered. And it's never a blocker:
you may be picking the ticket up deliberately, or taking it over. It tells
you, then gets out of the way.

You can also just ask, any time: *"has anyone said anything about EN-2022?"*

### Taking something back

Two ways, and they differ in what survives:

**"Mark it irrelevant"** withdraws it from the team. It leaves the digest, it
leaves `list_shares`, and anyone who asks for it by id gets the fact of the
withdrawal and nothing else:

```
Share shr_9f6543d277a5 from ann@x.com is marked IRRELEVANT — its author
withdrew it on Tuesday, 08-09-2026. Its contents are no longer shown to the team.
```

You can still see your own, so a mis-click isn't a one-way door. Read receipts
survive too, which is the point of not deleting it.

**"Retract it"** is the hard delete — the share and every receipt for it are
gone, as if it had never been sent. For a share that leaked something.

Only the author can do either.

**And if they're already mid-session**, they don't have to wait until tomorrow.
Anyone with Claude Code open gets told on their next message:

```
teamshare: 1 new share from Priya (blocking)
```

Their assistant mentions it in one line at the top of its reply and then
carries on with whatever they actually asked — it won't hijack what they were
doing. Details on request.

That check is throttled to once a minute, capped at 1.2 seconds, and silent on
failure, so it costs about 25ms on a typical message and never blocks you.
Change the interval with `TEAMSHARE_POLL_SECONDS` (`0` polls every message).

**Everything else is plain English:**


| Say this                     | Get this                                                |
| ---------------------------- | ------------------------------------------------------- |
| "what's unread?"             | Your waiting shares                                     |
| "show me the auth one"       | Full note, marks it read                                |
| "who's seen the auth share?" | `1 viewed, 0 dismissed. Not yet seen by: ada@acme.com…` |
| "retract my auth share"      | Deleted everywhere                                      |
| "mark it stale"              | Stops showing as unread, stays in history               |


Only the author can retract. Shares expire on their own after 14 days.

---



## Step 4 · Managing the team

**Who's actually set up?**

```
/teamshare:roster
```

```
Roster for "Platform" (2 known email(s)):

  - lead@acme.com (Lead) — active, 1 active token(s), never connected
  - sam@acme.com (Sam) — active, 1 active token(s), never connected
```

Watch for **never connected** — that person was invited but never used it.
They're missing every share and don't know it. Chase them.

**Someone left:**

```
/teamshare:revoke sam@acme.com
```

```
Revoked 1 live token(s) for sam@acme.com. Every device using one of them gets a 401 on its
next request and needs a fresh invite to regain access.
```

All their devices, one command. Their old shares stay — this removes access,
not history.

---



## Something not working?

teamshare stays quiet when it breaks, so it never interrupts you. The downside:
"no shares today" and "totally disconnected" look identical. This tells them
apart:

```
/teamshare:status
```

```
teamshare whoami

Server: https://54.90.22.249.sslip.io
        teamshare's default server (built in — nothing to configure)

Your personal token (publishes shares, records receipts, receives the digest):
  working — 0 unread share(s) waiting.

Admin tokens saved on this machine (invite / revoke / roster / rotate-team):
  - Platform (tm_6c772dbd6de4) — saved Sunday, 30-08-2026
```


| It says                   | Do this                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------- |
| `working`                 | Nothing — you're fine. `0 unread` really means nothing new.                             |
| `not set on this machine` | `/plugin configure teamshare@teamshare`                                                 |
| `rejected (401)`          | Your token was revoked, or you pasted the admin token by mistake. Ask for a new invite. |
| `could not reach`         | Server or network issue, at the address shown.                                          |


If the commands themselves are missing, restart Claude Code. If the tools are
missing, check `/mcp` and make sure you trusted the workspace.

Broken config from an old setup? `/teamshare:setup` repairs it. You shouldn't
need it otherwise.

---



# Part 2 — Cursor, Codex, Windsurf, and the rest

Same board. Same shares. Same read receipts. Cursor, Codex, Windsurf, Gemini
CLI, Cline, Zed, VS Code and Continue all speak MCP.

## Step 1 · Connect

Two lines, once:

```bash
curl -fsSL https://raw.githubusercontent.com/abdulgeek/teamshare/main/packages/server/src/teamshare-connect.mjs -o teamshare-connect.mjs
node teamshare-connect.mjs
```

No arguments — it already knows the server. It asks for one thing, hidden as
you type:

```
Personal token (input hidden):
```

```
teamshare connect — result

  [written]       Cursor -> /Users/you/.cursor/mcp.json (backup: /Users/you/.cursor/mcp.json.teamshare-backup-1788099903701)
                  + session digest and mid-session nudge -> /Users/you/.cursor/hooks.json

1 assistant(s) configured automatically.
Restart the affected assistant(s) to pick up the change.
```

Restart whatever it configured. Done.

**That second Cursor line.** MCP lets Cursor *ask* teamshare for shares. It does
not put a teammate's "don't merge src/auth" in front of you when you never
thought to ask — so on Cursor, connect also installs the same two hooks the
Claude Code plugin ships: the unread digest as a session starts, and a one-line
nudge mid-session when a teammate publishes something. They arrive as two files
(`~/.teamshare/hooks/teamshare-hook.mjs` and your token in `~/.teamshare.json`,
owner-only) plus an entry per event in `~/.cursor/hooks.json` — merged into
whatever hooks you already have there, backed up first, and replaced rather than
duplicated if you run connect again.

**Want to see what it'll touch first?**

```bash
node teamshare-connect.mjs --list
```

```
teamshare connect --list — detected assistants

  [detected]      Cursor                       /Users/you/.cursor/mcp.json
  [not installed] VS Code                      /Users/you/Library/Application Support/Code/User/mcp.json
  [not installed] Windsurf                     /Users/you/.codeium/mcp_config.json
  [not installed] Gemini CLI                   /Users/you/.gemini/settings.json
  [not installed] Cline                        /Users/you/Library/Application Support/Code/User/globalStorage/<cline-extension>/settings/cline_mcp_settings.json
  [not installed] Zed (via mcp-remote bridge)  /Users/you/.config/zed/settings.json
  [not installed] Codex CLI                    /Users/you/.codex/config.toml
  [not installed] Continue.dev                 /Users/you/.continue/config.yaml
```

It backs up every file it edits, and leaves an existing teamshare entry alone
unless you add `--force`.

Already in Claude Code and want to set up your other tools? `/teamshare:connect`
does the same thing.

## Step 2 · Use it

No slash commands here — just ask:


| Say this                                                  | Get this                 |
| --------------------------------------------------------- | ------------------------ |
| "what has my team shared?"                                | Your unread shares       |
| "show me shr_ddd81b0b4b92"                                | Full note, marks it read |
| "share with the team that the auth refactor lands Friday" | Publishes it             |
| "who's seen my auth share?"                               | Read receipts            |
| "has anyone said anything about EN-2022?"                  | What the team published about that ticket |
| "retract that share"                                      | Deletes it everywhere    |


**Cursor and Codex get the automatic parts too.** `teamshare connect` installs
the same hooks there, so you get the start-of-session digest, the mid-session
nudge when something new lands, and the ticket warning described in
[Before you start on a ticket](#before-you-start-on-a-ticket). Everywhere else
— VS Code, Windsurf, Zed, Gemini CLI, Continue — you ask for your unread shares
instead of being told, and you can ask about a ticket by name. Publishing,
reading, receipts and retracting work identically everywhere.

**One difference, honestly:** the slash commands (`/teamshare:share` and the
rest) are Claude Code plugin features and exist only there.

## Step 3 · Running a team from here

Same thing, one file, no address needed:

```bash
curl -fsSL https://raw.githubusercontent.com/abdulgeek/teamshare/main/packages/server/src/teamshare-team.mjs -o teamshare-team.mjs
node teamshare-team.mjs create-team "<org-name>"
node teamshare-team.mjs invite sam@acme.com "Sam"
node teamshare-team.mjs roster
node teamshare-team.mjs revoke sam@acme.com
node teamshare-team.mjs whoami
```

It prompts for what it needs and prints exactly what Part 1 shows. The Claude
Code commands are this same file with a nicer front door.

---



# Cheat sheet

**Claude Code**


| Command                             | Does                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------- |
| `/teamshare:share <message>`        | Publish a note to the team                                                 |
| `/teamshare:generate-secret`        | Recover the live signup secret (optional; not required before create-team) |
| `/teamshare:create-team <org-name>` | Create a team, save its admin token                                        |
| `/teamshare:invite <email> [name]`  | One person's token + the message to send them                              |
| `/teamshare:roster`                 | Who's on the team, who never connected                                     |
| `/teamshare:revoke <email>`         | Remove someone completely                                                  |
| `/teamshare:status`                 | Am I actually connected?                                                   |
| `/teamshare:connect`                | Set up your other AI assistants                                            |
| `/teamshare:setup`                  | Repair a broken config (rarely needed)                                     |


**No command needed** — these happen on their own:


| When                                     | What happens                                                       |
| ---------------------------------------- | ------------------------------------------------------------------ |
| A session starts                         | Unread shares, blocking first then newest                          |
| A teammate publishes mid-session         | A one-line nudge before your next message                          |
| You name a ticket key or `owner/repo#N`  | What the team already published about it, plus an offer to reply   |


**Terminal** — `node teamshare-team.mjs <command>` after the `curl` above.
`generate-secret`, `create-team`, `invite`, `revoke`, `roster`, `rotate-team`,
`whoami`. Add `--server <url>` for your own server, or `--team "<name>"` if you
run more than one team.

---



# Two questions everyone asks

**Why do I need a token?**

Because it's how the server knows *which* teammate you are. Every share and
every "read" is attributed by your token, not by a name your app claims. That's
what makes "who's seen this?" trustworthy instead of a guess — and it means one
command removes one person without disturbing anyone else.

There are two kinds, and mixing them up is the most common mistake:


|                        | Can do                        | Cannot do           |
| ---------------------- | ----------------------------- | ------------------- |
| **Personal** (`tsm_…`) | Read and publish shares       | Invite anyone       |
| **Admin** (`ts_…`)     | Invite, revoke, list the team | Read a single share |


`/teamshare:status` will tell you if you've pasted the wrong one.

**Why don't I need a server address?**

Because it's the same for everybody and it never changes. It's built into the
plugin and into both terminal commands. It isn't secret either — every request
without a valid token is refused.

**One thing worth knowing:** `/teamshare:invite` prints a real token into your
Claude Code transcript, because you have to send it to someone. Same for
`/teamshare:generate-secret`. Both are deliberate: the alternative was a tool
you couldn't use without leaving it. Neither value ever touches a command
line, where `ps` would see it. `/teamshare:revoke` invalidates a personal
token in one step, and the signup secret opens no team's data at all.

---



# Running your own server

You don't need to. If you want to:

```bash
pnpm install
pnpm -r build
node packages/server/dist/cli.js serve --signup-secret <pick-one>
```

Point the terminal commands at it with `--server <url>`.

For **Claude Code**, the plugin's address lives in
`[packages/plugin/.mcp.json](packages/plugin/.mcp.json)` as plain JSON. Fork
this repo, change that one line, and `/plugin marketplace add <your-fork>`.
Everything else follows it automatically.

For a real deployment with HTTPS and backups, see
`[deploy/aws/README.md](deploy/aws/README.md)` — that's what the default server
runs on.

More detail — trust model, diagnostics, a full worked example:
`[docs/reference.md](docs/reference.md)`.