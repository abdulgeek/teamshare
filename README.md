# teamshare

Your whole team uses AI coding assistants. None of them know what the others
have been told.

teamshare fixes that. One person says _"share with the team that the auth
refactor lands Friday"_. Everyone else's assistant tells them at the start of
their next session, and asks if they want the details. Saying yes **or** no
counts as read — so you can always ask _"who's seen this?"_ and get a real
answer.

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

Two commands, in this order. The secret first — create-team needs it.

```
/teamshare:generate-secret
/teamshare:create-team <org-name>
```

`generate-secret` mints a signup secret (or recovers the live one if this
machine already knows the instance via local terraform state or
`TEAMSHARE_INSTANCE_ID` — never an id shipped in the plugin). Save what it
prints. Then create-team uses it and remembers it, so every later team is
just a name.

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

Take your own token from that output and paste it into
`/plugin configure teamshare@teamshare`. Now you're on the board too.

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
2 unread team share(s) published by teammates.
  - id=shr_f7d71cb96ec3 | BLOCKING | from Dev | 2026-08-30T17:36:48.220Z
    Database migration 0042 is irreversible.
  - id=shr_ddd81b0b4b92 | BLOCKING | from Priya | 2026-08-30T17:36:48.202Z
    Auth middleware refactor lands Friday.
```

Their assistant asks if they want details. Yes shows the full note; no skips
it. Either way it's marked read and won't nag them again.

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
  - Platform (tm_6c772dbd6de4) — saved 2026-08-30T17:28:32.033Z
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

1 assistant(s) configured automatically.
Restart the affected assistant(s) to pick up the change.
```

Restart whatever it configured. Done.

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
| "retract that share"                                      | Deletes it everywhere    |

**One difference, honestly:** Claude Code gets the automatic start-of-session
digest and `/teamshare:share`. Those are plugin features. Everywhere else you
ask for your unread shares instead of being told. Publishing, reading, receipts
and retracting all work identically.

## Step 3 · Running a team from here

Same thing, one file, no address needed:

```bash
curl -fsSL https://raw.githubusercontent.com/abdulgeek/teamshare/main/packages/server/src/teamshare-team.mjs -o teamshare-team.mjs
node teamshare-team.mjs generate-secret
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

| Command                             | Does                                                  |
| ----------------------------------- | ----------------------------------------------------- |
| `/teamshare:share <message>`        | Publish a note to the team                            |
| `/teamshare:generate-secret`        | Mint a signup secret (first — create-team needs this) |
| `/teamshare:create-team <org-name>` | Create a team, save its admin token                   |
| `/teamshare:invite <email> [name]`  | One person's token + the message to send them         |
| `/teamshare:roster`                 | Who's on the team, who never connected                |
| `/teamshare:revoke <email>`         | Remove someone completely                             |
| `/teamshare:status`                 | Am I actually connected?                              |
| `/teamshare:connect`                | Set up your other AI assistants                       |
| `/teamshare:setup`                  | Repair a broken config (rarely needed)                |

**Terminal** — `node teamshare-team.mjs <command>` after the `curl` above.
`generate-secret`, `create-team`, `invite`, `revoke`, `roster`, `rotate-team`,
`whoami`. Add `--server <url>` for your own server, or `--team "<name>"` if you
run more than one team.

---

# Two questions everyone asks

**Why do I need a token?**

Because it's how the server knows _which_ teammate you are. Every share and
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
[`packages/plugin/.mcp.json`](packages/plugin/.mcp.json) as plain JSON. Fork
this repo, change that one line, and `/plugin marketplace add <your-fork>`.
Everything else follows it automatically.

For a real deployment with HTTPS and backups, see
[`deploy/aws/README.md`](deploy/aws/README.md) — that's what the default server
runs on.

More detail — trust model, diagnostics, a full worked example:
[`docs/reference.md`](docs/reference.md).
