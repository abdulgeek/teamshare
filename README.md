# teamshare

Your team all uses AI coding assistants, and none of them know what the others
have been told. teamshare is a shared noticeboard for them: one engineer says
*"share with the team that the auth refactor lands Friday"*, and at the start
of everyone else's next session their assistant tells them who shared what and
asks if they want the details. Answering yes **or** no counts as read, so
anyone can later ask *"who's seen this?"* and get a real answer.

Every block below is real output, captured from a running server.

**Which are you?**

| | |
|---|---|
| Joining a team someone already made | [Join a team](#2-join-a-team) — two commands |
| Setting up a team for others | [Create a team](#3-create-a-team-lead) → [Invite people](#4-invite-a-teammate-lead) |
| Standing up the server itself | [Run the server](#1-run-the-server-once-per-company) — once, ever |

---

## Why do I need a URL and a token?

A noticeboard has to live somewhere everyone can reach — that's the **server
URL** — and the board is private to your team, which is what the **token** is
for.

The token does a second job that matters more: it's how the server knows
*which* teammate you are. Every share you publish and every "yes, I've read
that" is attributed by your token, not by a name your assistant claims. That's
why your lead mints one **per person** rather than the team passing one
around, and it's what makes "who's seen this?" trustworthy instead of a guess.

**You don't go hunting for either value — your lead sends you both in one
message.** If you're the lead, the steps below produce them.

---

## 1. Run the server (once per company)

One person does this once; everyone else skips it.

```bash
pnpm install
pnpm -r build
node packages/server/dist/cli.js serve --signup-secret <a-secret-you-choose>
```

```
teamshare server listening on 127.0.0.1:8787
database: /Users/you/.teamshare/teamshare.db

0 team(s) currently on this instance.

Signup secret: configured. To view it: teamshare signup-secret --show

WARNING: serve plain HTTP only on a trusted network. Put TLS in front for anything else.
```

Share that signup secret with your org once. Anyone who has it can create
their own team without coming back to you — that's its whole purpose.

`serve` binds to `127.0.0.1`. For a LAN team with no proxy in front, add
`--host 0.0.0.0`. For a real deployment with TLS, a persistent volume and
backups, use [`deploy/aws/README.md`](deploy/aws/README.md) instead of running
this by hand.

---

## 2. Join a team

Your lead sends you a **server URL** and **your personal token**. That's all
you need — no clone, no build, no git config.

### Claude Code

```
/plugin marketplace add abdulgeek/teamshare
/plugin install teamshare
```

It prompts for two values. Paste what your lead sent:

```
Server URL:           https://54.90.22.249.sslip.io
Your personal token:  tsm_2a96b76e46df…
```

Trust the workspace when asked, then restart Claude Code. That's it.

### Cursor, Codex, Windsurf, Gemini CLI, Cline, Zed

```bash
curl -fsSL https://raw.githubusercontent.com/abdulgeek/teamshare/main/packages/server/src/teamshare-connect.mjs -o teamshare-connect.mjs
node teamshare-connect.mjs https://54.90.22.249.sslip.io
```

It asks for your token with hidden input — paste the one your lead sent.

```
teamshare connect — result

  [written]       Cursor -> /Users/you/.cursor/mcp.json (backup: /Users/you/.cursor/mcp.json.teamshare-backup-1788099903701)

1 assistant(s) configured automatically.
Restart the affected assistant(s) to pick up the change.
```

To see what it would touch before it writes anything:

```bash
node teamshare-connect.mjs --list
```

```
teamshare connect --list — detected assistants

  [detected]     Cursor                       /Users/you/.cursor/mcp.json
  [not installed] VS Code                      /Users/you/Library/Application Support/Code/User/mcp.json
  [not installed] Windsurf                     /Users/you/.codeium/mcp_config.json
  [not installed] Gemini CLI                   /Users/you/.gemini/settings.json
```

---

## 3. Create a team (lead)

You need the signup secret from step 1. No clone required.

```bash
curl -fsSL https://raw.githubusercontent.com/abdulgeek/teamshare/main/packages/server/src/teamshare-team.mjs -o teamshare-team.mjs
node teamshare-team.mjs create-team https://54.90.22.249.sslip.io "Platform"
```

It asks for the signup secret (hidden), then:

```
teamshare create-team — success

Team: Platform (tm_6c772dbd6de4)

Team token (shown once — this cannot be recovered later; save it in a password manager now):

  ts_fb5bcb7f5bd6…

Verifying the new token against the live server:

[OK] server reachable at https://54.90.22.249.sslip.io/health
[OK] https://54.90.22.249.sslip.io/members returned 200 (0 known email(s))
```

**Save that token now.** It's your **admin** token: it invites people, revokes
them, reads the roster, and rotates itself — nothing else. It cannot read
shares, and you cannot join teamshare with it.

**Invite yourself too**, in the next step, or you'll own a team you can't use.

---

## 4. Invite a teammate (lead)

```bash
node teamshare-team.mjs invite https://54.90.22.249.sslip.io sam@acme.com "Sam"
```

It asks for your admin token (hidden), then:

```
teamshare invite — success

Invited: Sam <sam@acme.com>

Personal token for sam@acme.com (shown once — this cannot be recovered later; save it in a password manager now):

  tsm_2a96b76e46df…

Send this token privately to sam@acme.com only — never post it in a shared channel or thread with
others on the team. Whoever holds it can publish shares and record read receipts as this person.
```

It then prints a ready-to-send joining message. DM that to Sam. One message
per person is exactly what makes attribution real.

**See who's actually set up:**

```bash
node teamshare-team.mjs roster https://54.90.22.249.sslip.io
```

```
Roster for "Platform" (1 known email(s)):

  - sam@acme.com (Sam) — active, 1 active token(s), never connected
```

**Someone left?** One command kills every device they had:

```bash
node teamshare-team.mjs revoke https://54.90.22.249.sslip.io sam@acme.com
```

```
Revoked 1 live token(s) for sam@acme.com. Every device using one of them gets a 401 on its
next request and needs a fresh invite to regain access.
```

---

## 5. Use it

You talk to your assistant in plain language; it calls the tools for you. You
never type tool names.

### Publish a share

You type:

```
/share Auth middleware refactor lands Friday. Session validation moves into
middleware/auth.ts. Don't merge anything touching src/auth this week.
```

Your assistant distils it, shows you the result to confirm, then publishes.
The server returns:

```json
{"id":"shr_9a657ec1219e","notified":4}
```

`notified` is how many teammates will see it at their next session start.

Shares are deliberately small — `what` ≤200 characters, `why` ≤300, `action`
≤200 — and the server **rejects** anything longer. That cap is why the board
stays worth reading.

### What a teammate sees

At the start of Sam's next session, before he types anything:

```
1 unread team share(s):
- [shr_9a657ec1219e] BLOCKING from Priya (2026-08-30T14:24:40.722Z): Auth middleware refactor lands Friday.
```

His assistant asks if he wants the details. **Yes** shows the full note and
records a `viewed` receipt; **no** records `dismissed`. Both count as read, so
it won't nag him again.

Sam says yes:

```
Share shr_9a657ec1219e from priya@acme.com at 2026-08-30T14:24:40.722Z:
WHAT:   Auth middleware refactor lands Friday.
WHY:    Session validation moves into middleware/auth.ts.
ACTION: Do not merge anything touching src/auth this week.
TAGS:   auth
PRIORITY: blocking
```

### Check who's seen it

You ask: *"who's seen the auth share?"*

```
1 viewed, 0 dismissed. Not yet seen by: nobody.
```

### Take it back

Ask your assistant to retract a share you published and it's gone everywhere —
unread, history, receipts:

```
retracted shr_9a657ec1219e
```

Or mark it stale to stop it showing as unread while keeping it in history.
Shares also age out on their own after 14 days.

---

## 6. Something's wrong

teamshare fails **silently** on purpose — a broken connection never interrupts
your session, which means "I see no shares" and "I'm not connected" look
identical. `doctor` tells them apart:

```bash
TEAMSHARE_URL=https://54.90.22.249.sslip.io TEAMSHARE_TOKEN=<your-token> node packages/server/dist/cli.js doctor
```

```
[OK] using TEAMSHARE_URL/TEAMSHARE_TOKEN from the environment
[OK] server reachable at https://54.90.22.249.sslip.io/health
[OK] https://54.90.22.249.sslip.io/unread returned 200 (0 unread share(s))
[OK] connected to team: Platform
```

`doctor` needs a checkout of this repo; nothing else above does.

---

## Command reference

Secrets are **never** command-line arguments — every command prompts, or reads
an environment variable. `teamshare-team.mjs` and `teamshare-connect.mjs` are
single files you `curl` and run; the `teamshare` CLI needs a checkout + build.

**Lead** — `node teamshare-team.mjs <cmd> <server-url> …`

| Command | Does | Secret from |
|---|---|---|
| `create-team "<name>"` | New team + admin token | `TEAMSHARE_SIGNUP_SECRET` |
| `invite <email> ["<name>"]` | Personal token for one person | `TEAMSHARE_ADMIN_TOKEN` |
| `revoke <email>` | Kill all of that person's tokens | `TEAMSHARE_ADMIN_TOKEN` |
| `roster` | Who's joined, who hasn't | `TEAMSHARE_ADMIN_TOKEN` |
| `rotate-team` | New admin token; members unaffected | `TEAMSHARE_TEAM_TOKEN` |

**Teammate** — `node teamshare-connect.mjs <server-url>`

| Flag | Does |
|---|---|
| *(none)* | Configure every assistant it finds |
| `--list` | Show what it detects, write nothing |
| `--dry-run` | Show what it would write |
| `--only cursor,codex` | Restrict to named assistants |
| `--force` | Overwrite an existing `teamshare` entry |

**Operator** — `node packages/server/dist/cli.js <cmd>`

| Command | Does |
|---|---|
| `serve [--port --host --db --expiry-days --signup-secret --open-signup --max-teams]` | Run the server |
| `signup-secret --show` | Recover the signup secret |
| `doctor [<url> <token>]` | Diagnose a connection |
| `connect <url> <token>` | Same as the standalone script |
| `create-team` · `invite` · `revoke` · `roster` · `rotate-token` · `remove-member` | Local-database equivalents, for when the signup secret is lost |

**In Claude Code:** `/share` publishes. `/teamshare-create-team` makes an
additional team. `/teamshare-setup` repairs a broken config.

**Tools your assistant calls for you** — ask in plain language, don't type
these: `share`, `unread`, `read_share`, `acknowledge`, `list_shares`,
`receipts`, `retract`, `mark_stale`.

---

## More

[`docs/reference.md`](docs/reference.md) — trust model, deploy requirements,
`doctor` internals, and a full worked example.
