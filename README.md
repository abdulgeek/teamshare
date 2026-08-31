# teamshare

Your team all uses AI coding assistants, and none of them know what the others
have been told. teamshare is a shared noticeboard for them: one engineer says
*"share with the team that the auth refactor lands Friday"*, and at the start
of everyone else's next session their assistant tells them who shared what and
asks if they want the details. Answering yes **or** no counts as read, so
anyone can later ask *"who's seen this?"* and get a real answer.

There is nothing to run and no address to look up. A server is already live,
its address is built into the plugin, and everything below is a slash command.

Every block on this page is real output.

**Two complete walkthroughs:**

- [Claude Code, start to finish](#claude-code-start-to-finish) — the plugin,
  every command
- [Cursor, Codex and everything else](#cursor-codex-and-everything-else) — one
  command, same board

---

## Claude Code, start to finish

### Install

```
/plugin marketplace add abdulgeek/teamshare
/plugin install teamshare
```

It asks for **one** value — your personal token, the `tsm_…` string your lead
sent you:

```
Your personal token:  tsm_2a96b76e46df8c31b0…
```

That's the whole install. Trust the workspace when asked, restart Claude Code,
and you're on the board. No server address, no config file, no git setup.

> **No token yet?** You don't need one to read this page — skip to
> [Starting a team](#starting-a-team-lead) and make one. If your team already
> has a lead, ask them for `/teamshare:invite <your-email>`.

### Starting a team (lead)

```
/teamshare:create-team Platform <your-org-signup-secret>
```

The signup secret is what your server uses to gate team creation — your
organisation has one, and whoever runs the server can give it to you. It is the
only time you ever supply it.

```
teamshare create-team — success

Team: Platform (tm_6c772dbd6de4)
Server: https://54.90.22.249.sslip.io

Team token (shown once — this cannot be recovered later; save it in a password manager now):

  ts_fb5bcb7f5bd6c1a04e7d…

Verifying the new token against the live server:

[OK] server reachable at https://54.90.22.249.sslip.io/health
[OK] https://54.90.22.249.sslip.io/members returned 200 (0 known email(s))

Check this machine's setup any time with: teamshare-team whoami

Next: invite yourself, then everyone else. Each invite prints a personal token and the exact
message to send that person.

  teamshare-team invite <your-own-email> ["Your Name"]
```

The token is printed **and saved** — to `~/.teamshare/admin.json`, owner-only.
Every command below reads it from there, so this is the last time you handle
it. Put a copy in a password manager anyway: that file dies with this machine.

This is an **admin** token. It invites, revokes, reads the roster and rotates
itself, and it can read nothing — not shares, not receipts, not the digest.
You cannot log in with it, which is why the next step matters.

**About typing the secret here.** It lands in this conversation's transcript.
That is a smaller thing than it sounds: the signup secret only permits creating
teams — it opens no team's shares, receipts or roster — and it is meant to be
distributed across your org anyway. It never reaches a command line either: the
command writes it to a private file, passes the path, and deletes it.

If you would still rather it were not recorded, set it in the environment
instead and leave it out of the command:

```bash
TEAMSHARE_SIGNUP_SECRET=<your-org-secret> claude
```

Or stay out of Claude Code entirely — this prompts for the secret with hidden
input. (`teamshare-team` is a bare command only *inside* Claude Code, which
puts the plugin's `bin/` on the PATH of commands it runs; a terminal you open
yourself needs the file.)

```bash
node packages/server/src/teamshare-team.mjs create-team "Platform"
```

**Don't know the secret?** Whoever runs the server has it. If that is you and
you deployed from this repo, `deploy/aws/signup-secret.sh` reads it back over
SSM and prints nothing else, so it composes into one command that never shows
the value:

```bash
TEAMSHARE_SIGNUP_SECRET=$(deploy/aws/signup-secret.sh) node packages/server/src/teamshare-team.mjs create-team "Platform"
```

### Inviting people

```
/teamshare:invite sam@acme.com Sam
```

```
teamshare invite — success

Invited: Sam <sam@acme.com>

Personal token for sam@acme.com (shown once — this cannot be recovered later; save it in a password manager now):

  tsm_2a96b76e46df8c31b0…

Send this token privately to sam@acme.com only — never post it in a shared channel or thread with
others on the team. Whoever holds it can publish shares and record read receipts as this person.
```

It then prints the exact message to send Sam — install commands, the token,
and the three things people get wrong (trusting the workspace, the version
floor, restarting). Copy it into a DM.

**Invite yourself first.** The admin token can't read anything, so a lead who
skips this owns a team they can't use.

One invite per person is the point, not bureaucracy. The server binds each
token to the email *you* typed, so a share says "from Priya" because Priya's
token published it — not because her client claimed the name. That's what
makes read receipts evidence instead of decoration.

### Everyday use

You talk to your assistant in plain language. You never type a tool name.

**Publish something:**

```
/teamshare:share Auth middleware refactor lands Friday. Session validation moves into
middleware/auth.ts. Don't merge anything touching src/auth this week.
```

Your assistant distils it into the strict format, shows you the result, and
publishes once you confirm:

```json
{"id":"shr_ddd81b0b4b92","notified":5}
```

`notified` is how many teammates will see it at their next session start.

Shares are capped — `what` ≤200 characters, `why` ≤300, `action` ≤200 — and the
server rejects anything longer. That cap is why the board stays worth reading.

**What a teammate sees**, before they type anything, at the start of their next
session:

```
2 unread team share(s) published by teammates.
  - id=shr_f7d71cb96ec3 | BLOCKING | from Dev | 2026-08-30T17:36:48.220Z
    Database migration 0042 is irreversible.
  - id=shr_ddd81b0b4b92 | BLOCKING | from Priya | 2026-08-30T17:36:48.202Z
    Auth middleware refactor lands Friday.
```

(Elided above: the digest wraps those lines in a fence tagged with a random
value, and tells the assistant to treat everything inside as data. A share is
written by a teammate, so it is never allowed to act as instructions.)

Their assistant asks whether they want the details. **Yes** shows the full note
and records a `viewed` receipt; **no** records `dismissed`. Both count as read,
so it won't nag them again.

Saying yes:

```
Share shr_086458d94155 from ann@acme.com at 2026-08-30T17:37:06.306Z:
WHAT:   Auth middleware refactor lands Friday.
WHY:    Session validation moves into middleware/auth.ts.
ACTION: Do not merge anything touching src/auth this week.
TAGS:   auth
PRIORITY: blocking
```

**Ask anything else in plain language:**

| You say | What happens |
| --- | --- |
| "what's unread?" | Lists shares waiting for you |
| "show me the auth one" | Full note, records that you read it |
| "who's seen the auth share?" | `1 viewed, 0 dismissed. Not yet seen by: ada@acme.com…` |
| "retract my auth share" | Gone everywhere — unread, history, receipts |
| "mark it stale" | Stops showing as unread, stays in history |

Only the author can retract or mark stale. Shares also expire on their own
after 14 days.

### Running the team

```
/teamshare:roster
```

```
Roster for "Platform" (2 known email(s)):

  - lead@acme.com (Lead) — active, 1 active token(s), never connected
  - sam@acme.com (Sam) — active, 1 active token(s), never connected
```

**never connected** is the line to read. That person was invited and never
used it — they aren't getting shares, and they don't know it.

Several active tokens for one person is normal: a laptop, a desktop, CI.

**Someone left:**

```
/teamshare:revoke sam@acme.com
```

```
Revoked 1 live token(s) for sam@acme.com. Every device using one of them gets a 401 on its
next request and needs a fresh invite to regain access.
```

Every device at once, in one command. Their past shares stay — revoking removes
access, it doesn't erase what they wrote.

### When something looks wrong

teamshare fails **silently** on purpose, so a broken connection never
interrupts your work. The cost is that "nothing new today" and "not connected
at all" look identical. This tells them apart:

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

Stored at /Users/you/.teamshare/admin.json — owner-only, never committed, never sent anywhere.
```

| It says | Meaning |
| --- | --- |
| `working` | Connected. `0 unread` really does mean nothing new. |
| `not set on this machine` | Installed but never given a token — `/plugin configure teamshare@teamshare` |
| `rejected (401)` | Revoked, or you pasted the admin token instead of a personal one |
| `could not reach` | Server or network problem, at the address shown |

---

## Cursor, Codex and everything else

Same board, same shares, same receipts. Cursor, Codex, Windsurf, Gemini CLI,
Cline, Zed, VS Code and Continue all speak MCP, and one command configures
whichever of them you have.

### Connect

```bash
curl -fsSL https://raw.githubusercontent.com/abdulgeek/teamshare/main/packages/server/src/teamshare-connect.mjs -o teamshare-connect.mjs
node teamshare-connect.mjs
```

No arguments. It knows the server; it asks for one thing, with the input
hidden:

```
Personal token (input hidden):
```

```
teamshare connect — result

  [written]       Cursor -> /Users/you/.cursor/mcp.json (backup: /Users/you/.cursor/mcp.json.teamshare-backup-1788099903701)

1 assistant(s) configured automatically.
Restart the affected assistant(s) to pick up the change.
```

Already in Claude Code? Skip the download — `/teamshare:connect` does the same
thing, and the connector is already on your PATH as `teamshare-connect`.

**Look before it writes:**

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

Nothing was written. Run: node teamshare-connect.mjs
It prompts for your personal token; the server address is already built in.
```

Every file it touches is backed up first, and an existing `teamshare` entry is
left alone unless you pass `--force`.

### Everyday use

There are no slash commands outside Claude Code, so you ask in plain language
and your assistant calls the tools:

| You say | What happens |
| --- | --- |
| "what has my team shared?" | Lists unread shares |
| "show me shr_4e9098cb6693" | Full note, records that you read it |
| "share with the team that the auth refactor lands Friday" | Publishes it |
| "who's seen my auth share?" | Read receipts |
| "retract that share" | Removes it everywhere |

**One honest difference.** Claude Code gets the automatic session-start digest
and `/teamshare:share`; those are plugin features. Everywhere else you ask for your
unread shares rather than being told. Publishing, reading, receipts and
retraction are identical.

### Running a team from another assistant

Team administration is the same one file, and it takes no server address
either:

```bash
curl -fsSL https://raw.githubusercontent.com/abdulgeek/teamshare/main/packages/server/src/teamshare-team.mjs -o teamshare-team.mjs
node teamshare-team.mjs create-team "Platform"
node teamshare-team.mjs invite sam@acme.com "Sam"
node teamshare-team.mjs roster
node teamshare-team.mjs revoke sam@acme.com
```

It prompts for what it needs, saves the admin token exactly as the plugin does,
and prints the same output shown above. The Claude Code commands are this file
with a nicer front door — not a separate implementation.

---

## Command reference

**In Claude Code** — nothing to install beyond the plugin, nothing to paste
after the first token.

| Command | Does |
| --- | --- |
| `/teamshare:share <message>` | Publish a note to the team |
| `/teamshare:create-team <name> [secret]` | Create a team; saves its admin token here |
| `/teamshare:invite <email> [name]` | Mint one person's token + the message to send them |
| `/teamshare:roster` | Who's on the team, who never connected |
| `/teamshare:revoke <email>` | Kill every token that person holds |
| `/teamshare:status` | Is this machine actually connected? |
| `/teamshare:connect` | Set teamshare up in your other assistants |
| `/teamshare:setup` | Repair or dev-configure credentials (rarely needed) |

**Anywhere** — the same two commands, outside the slash-command wrapper.

Claude Code puts the plugin's `bin/` on the PATH of the commands *it* runs, so
inside Claude Code these are bare names. A terminal you open yourself has no
such entry: run them from a checkout as
`node packages/server/src/teamshare-team.mjs …`, or `curl` the single file.

| Command | Does | Credential from |
| --- | --- | --- |
| `teamshare-team create-team "<name>"` | New team + admin token | `TEAMSHARE_SIGNUP_SECRET`, `--signup-secret-file`, or prompt |
| `teamshare-team invite <email> ["<name>"]` | One person's personal token | saved store |
| `teamshare-team revoke <email>` | Kill all of that person's tokens | saved store |
| `teamshare-team roster` | Who's joined, who hasn't | saved store |
| `teamshare-team rotate-team` | New admin token; members unaffected | saved store |
| `teamshare-team whoami` | What this machine is connected to | — |
| `teamshare-connect` | Configure this machine's assistants | prompt |
| `teamshare-connect --list` | Show what it detects, write nothing | — |

Shared options: `--server <url>` for your own server, `--team "<name>"` when
one machine administers several teams. `create-team` also takes
`--signup-secret-file <path>`, for callers with no terminal to be prompted on —
that is how the slash command supplies the secret without putting it in `ps`.
Connector flags: `--dry-run`, `--only cursor,codex`, `--force`.

**Tools your assistant calls for you** — ask in plain language, never type
these: `share`, `unread`, `read_share`, `acknowledge`, `list_shares`,
`receipts`, `retract`, `mark_stale`.

---

## Why a token, and why no URL

The **address** is the same for everyone, so nobody should have to know it. It
is compiled into the plugin and into both standalone commands. It isn't a
secret either — every route on it refuses an unauthenticated request, and
creating a team additionally needs your organisation's signup secret.

The **token** is per person, and that's the load-bearing part. Every share you
publish and every "yes, I've read that" is attributed by your token, not by a
name your client asserts. That's why your lead mints one per person instead of
the team passing one around, and it's what makes "who's seen this?" an answer
rather than a guess. It also means one command removes one person, without
disturbing anyone else.

Two credentials, deliberately kept apart: an **admin** token invites, revokes,
reads the roster and rotates itself, and can read nothing; a **personal** token
reads and publishes, and can invite nobody. Pasting one where the other belongs
gets a 401 — `/teamshare:status` names that mistake specifically, because it
looks exactly like a bad token otherwise.

**Worth knowing:** `/teamshare:invite` prints a live token into your Claude
Code transcript, because you have to send it to someone — and
`/teamshare:create-team` records the signup secret if you pass it there. Both
are deliberate: the alternative was a tool you could not use without leaving
it. Neither value ever reaches a command line, where `ps` would see it.

If that matters for your threat model, run either command in a terminal
instead — same code, same output, no transcript — and note that
`/teamshare:revoke` invalidates a personal token in one step, while the signup
secret opens no team's data at all.

---

## Running your own server

You don't need to. If you want to anyway:

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

Point the commands at it with `--server <url>` or `TEAMSHARE_URL`.

For **Claude Code**, the plugin's server address lives in
[`packages/plugin/.mcp.json`](packages/plugin/.mcp.json) as static JSON, and
nothing in a plugin can rewrite it per-install. So fork this repo, change that
one line, and `/plugin marketplace add <your-fork>`. The session-start digest
and the bundled commands read the address back out of that same file, so they
follow automatically — no second place to configure, and no way to end up
publishing to one server while reading from another.

For a real deployment with TLS, a persistent volume and backups, see
[`deploy/aws/README.md`](deploy/aws/README.md) — that's what the default
server runs on.

---

## More

[`docs/reference.md`](docs/reference.md) — trust model, deployment
requirements, diagnostics internals, and a full worked example.
