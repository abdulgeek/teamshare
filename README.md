# teamshare

Your whole team uses AI coding assistants. None of them know what the others
have been told.

teamshare fixes that. One person says *"share with the team that the auth
refactor lands Friday"*. Everyone else's assistant tells them the whole note
at the start of their next session, before they type anything. Once they
answer it counts as read, so you can ask *"who's seen this?"* and get a real
answer.

It works the other way round too. Name a ticket — *"let's pick up EN-2022"* —
and if a teammate already published something about it, you're told **before**
Claude opens the ticket and starts reading your codebase. Even if you read
that note last week and forgot.

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

### Keeping it up to date

teamshare does **not** update itself. New commands and hook behaviour arrive
only when you pull them:

```bash
claude plugin marketplace update teamshare && claude plugin update teamshare
```

Then restart Claude Code. `claude plugin list` shows the version you're on.

You can also do it from `/plugin` inside a session, which is where the
per-marketplace auto-update toggle lives if you'd rather not think about it
again.

**Server-side changes need none of this.** Anything the server does — how a
digest is built, what a tool returns — reaches everyone the moment it deploys.
Only the slash commands and the hooks ship inside the plugin.

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
    Auth middleware refactor lands Friday.
    why: Session validation moves into middleware/auth.ts
    do:  Don't merge anything touching src/auth
  - id=shr_6e02cc993393 | BLOCKING | from Ann | 10 days ago (Saturday, 29-08-2026) | old
    Ancient blocking note nobody closed.
  - id=shr_b699466a1071 | FYI | from Ann | 2 days ago (Sunday, 06-09-2026) | recent
    Design review moved to Thursday.

  (1 older unread share(s) held back — ask for the backlog if you want them.)
```

**That's the whole note, not a headline.** The why and the do-this lines are
right there, so nobody has to ask a follow-up question and spend another round
trip to find out what a share actually means. "Don't merge src/auth" is not
useful without "the refactor lands Friday" beside it.

Once they answer — "ok", "noted", "not now" — it's marked read and won't nag
them again. Anything they ignore stays unread and comes back next session.

That's the *arrival* half. The other half fires when someone names a ticket
key later on, long after the note stopped being unread.

### Three things worth learning first

Everything above is the team-wide case. These three are what you'll reach for
day to day. Type the left-hand thing, see the right-hand thing.

#### 1. Say something to one person

Just name them. You never look up an email address.

```
tell Sam I'm on EN-2022, doing the middleware refactor first,
so don't start the auth work until I land it
```

`notified: 1` is the tell — a team-wide note would name however many
teammates you have. Sam sees it marked `to you`:

```
- [shr_3f850f4feac7] HEADS-UP from Abdul Sagheer · just now (Wednesday, 10-09-2026) | to you: On EN-2022, middleware refactor first
    do:  Don't start the auth work until I land it
```

**Nobody else does.** Not in their digest, and not by asking for that id
either — they get the same *"no share with id …"* a made-up id gets.

`Sam`, `@Sam`, `Sam Okafor` and `sam@acme.com` all work. Two people match and
it asks rather than guessing:

```
"Priya" matches 2 people on this team: Priya Raman <priya@acme.com>, Priya
Nair <priyan@acme.com>. Ask which one they mean and pass that address.
```

Teach it your own name for someone once — *"Pri is priyan@acme.com, remember
that"* — and it sticks. That's kept on the server against your account, so it
follows you to your other machines, and it's private to you: your "Pri" never
changes who a teammate's "Pri" means. Ask *"who's on the team?"* to see
everyone's names.

More detail, including who can and can't be addressed:
[Recipients](docs/reference.md#recipients).

#### 2. Get warned before you start on a ticket

Name a ticket and you're told what the team already said about it, **before**
Claude opens the ticket or reads any code:

```
let's pick up EN-2022
```

```
teamshare: EN-2022 — Ravi is blocked on this (blocking, 2 hours ago).
He expects to land the auth refactor end of day. Want me to tell him
you've picked it up?
```

That works even for a note you read last week and forgot, which is the whole
point — your digest gave up on it long ago. It's a heads-up, never a block:
you may be taking the ticket over on purpose.

It runs the other way too. If **you're** the one doing the work and a
teammate has published that they're stuck behind you, naming the ticket
surfaces that and offers to send them a status. It never publishes anything
without you saying yes.

Only ticket keys (`EN-2022`) and repo references (`acme/api#412`) trigger it.
Not free text, and not lookalikes such as `UTF-8` or `GPT-4`.

More detail, including what leaves your machine:
[Mentions](docs/reference.md#mentions-retrieval-not-arrival).

#### 3. Read it back like a chat

Shares are notes, but a run of them between two people is a conversation, and
`/teamshare:history` reads it as one:

```bash
/teamshare:history Priya
```

```
Conversation with Priya Nair <priya@acme.com> — 4 note(s), oldest first. Times are UTC.

Tuesday, 08-09-2026
  09:14  you         Starting EN-2022, middleware refactor first [heads-up]
                     why: Auth work depends on it landing
  14:02  Priya Nair  Got it, holding off on the auth work

Wednesday, 09-09-2026
  10:31  Priya Nair  Any ETA? I am blocked behind this now [blocking]

Thursday, 10-09-2026
  08:05  you         Landed it this morning, you are unblocked [heads-up]
                     do:  Rebase onto main before you start
```

Oldest first, grouped by day, and each of you sees yourself as **you** — Priya
running the same command sees her own lines that way instead.

Leave the name off for everything that went to the whole team:

```bash
/teamshare:history
```

Team-wide notes and private threads never mix. The team feed shows only what
went to everybody, and a one-to-one thread shows only what the two of you sent
each other, so a broadcast never looks like something said just to you. You
can also just ask, without the command: *"show me my chat with Priya"*.

It reads the most recent notes and says how many older ones it left out. Ask
for more and it fetches further back.

#### When does it reach them?

You don't have to tell anyone to restart anything.

| They are... | They see it |
| --- | --- |
| Mid-session, Claude open all morning | At their next message, once the once-a-minute check comes round |
| Starting a fresh session | Immediately, before they type anything |

It won't say the same thing twice — if the session-start digest just showed
it, the mid-session check stays quiet.

### The details, when you need them

The three things above are what you use daily. Everything else has a fuller
write-up in **[docs/reference.md](docs/reference.md)**, so this page stays a
guide rather than a manual:

| If you want to know | See |
| --- | --- |
| Exactly who can be addressed, and every error you might hit | [Recipients](docs/reference.md#recipients) |
| What triggers a ticket warning, and what leaves your machine | [Mentions](docs/reference.md#mentions-retrieval-not-arrival) |
| Scoping a note to one repository, and how a git remote becomes a key | [Schema and scoping rules](docs/reference.md#schema-and-scoping-rules) |
| Ageing, relevance, and when a note stops being surfaced | [How old is it](docs/reference.md#how-old-is-it-and-does-it-still-matter) |
| Retracting a note, or marking it no longer relevant | [Taking something back](docs/reference.md#taking-something-back-retract-and-mark-irrelevant) |
| Who can see what, and why | [Trust model](docs/reference.md#trust-model) |

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

### "Couldn't start sign in for teamshare"

You tried to connect it from the connectors or plugins page on claude.ai.
That page authenticates a server by starting a sign-in flow, and **teamshare
has no sign-in** — it authenticates on a personal token you paste, and nothing
else. So the flow fails before it begins. Nothing is misconfigured.

Set it up locally instead, which is the flow in [Step 1](#step-1--install):

```bash
/plugin marketplace add abdulgeek/teamshare
```

```bash
/plugin install teamshare
```

It asks for your token and you paste it. That prompt is the step the claude.ai
page has no way to show you, which is the whole difference.

No token on that machine? Whoever set the team up runs
`/teamshare:invite your@email.com` and sends you the result.

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
| "tell Sam I'm on EN-2022"                                  | A note only Sam sees     |
| "who's on the team?"                                       | Names and addresses      |
| "Pri is priyan@acme.com, remember that"                    | Saves your name for them |
| "show me my chat with Priya"                               | The thread, as a conversation |
| "catch me up on the team"                                  | The team feed, oldest first |
| "retract that share"                                      | Deletes it everywhere    |


**Cursor and Codex get the automatic parts too.** `teamshare connect` installs
the same hooks there, so you get the start-of-session digest, the mid-session
nudge when something new lands, and the ticket warning described above.
Everywhere else
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
| `/teamshare:history [person]`       | Read the notes as a conversation, or one person's thread                   |
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
| You name a teammate in a share           | It goes only to them, resolved from the roster or a name you saved |


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