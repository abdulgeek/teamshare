# teamshare

A dev team that all uses AI coding assistants has no shared agent memory.
teamshare fixes that: one engineer tells their agent "share with the team
that the auth refactor lands Friday," and at the start of their next
session, every other teammate's agent tells them who shared what and asks if
they want the details. Answering yes *or* no counts as a read receipt, so
anyone can later ask "who's seen this?" and get a real answer.

It's a small self-hosted MCP server plus thin clients: a Claude Code plugin,
and a dependency-free connect script for every other assistant. Full details
— trust model, deploy notes, admin commands — are in
[`docs/reference.md`](docs/reference.md).

## Install it (once per company)

From a checkout of this repo:

```bash
pnpm install
pnpm -r build
node packages/server/dist/cli.js serve --signup-secret <a-secret-you-choose>
```

Share that secret with your org (Slack, a wiki page) — anyone who has it
(and the server's URL) can create their own team, self-serve. Set it via
`--signup-secret` or the `TEAMSHARE_SIGNUP_SECRET` environment variable;
leave both unset and the server generates one on first boot, recoverable
with `teamshare signup-secret --show`.

`serve` binds to `127.0.0.1` by default. If you're running this for a LAN
team with no reverse proxy in front, pass `--host 0.0.0.0` so teammates on
other machines can reach it.

Prefer AWS to plain `node`? See [`deploy/aws/README.md`](deploy/aws/README.md)
for a Terraform stack with a persistent volume and automatic TLS.

**Already deployed from this checkout?** Don't guess the URL or ask around
for the signup secret — `deploy/aws/terraform.tfstate` has both, if
`terraform apply` has already run here. From `deploy/aws`, `terraform
output` prints the live `url`, plus break-glass SSM commands
(`ssm_show_signup_secret_command`, `ssm_read_team_token_command`) to read
the signup secret or a team's original token straight off the running
instance if either was ever lost — see [`deploy/aws/README.md`
§ Break-glass](deploy/aws/README.md#break-glass-recovering-a-secret-or-token-via-ssm).

## Join a team (the most common path)

Two things below can look like arbitrary bureaucracy if nobody says why.
**Why a server URL:** teamshare isn't a self-contained plugin — a shared
noticeboard has to live somewhere every teammate can reach, and that's your
team's server. It's already running, so you're not standing anything up,
just pointing at the address your lead gives you (standing one up at all is
a separate, once-per-company job — see [Install](#install-it-once-per-company)
above). **Why a personal token:** two concrete reasons. It keeps the
noticeboard private — without it, anyone who installed this plugin and
guessed the address could read your team's shares. And it's how the server
knows *which* teammate you are: every share you publish and every "yes,
I've read that" is attributed by the token, not by a name your client
claims — exactly why your lead mints one per person rather than the team
passing one around, and what makes "who's seen this?" a real answer instead
of a guess. Either way, you don't go hunting for either value: **your lead
sends you both, in one message.**

No separate identity step: paste the token below and you're set.

Depending on your assistant:

**Claude Code:**

```
/plugin marketplace add abdulgeek/teamshare
/plugin install teamshare
```

You'll be prompted for the **Server URL** (this team's is
`https://54.90.22.249.sslip.io`) and **Your personal token** — the token
your team lead sent you privately with `teamshare invite` (see below). Trust
the workspace when asked, then restart Claude Code.

**Everything else (Cursor, Codex, Windsurf, Gemini CLI, ...):**

Same source as above: your lead sends you the server URL and your personal token, minted by
`teamshare invite`, in one ready-to-run message.

```bash
curl -fsSL https://raw.githubusercontent.com/abdulgeek/teamshare/main/packages/server/src/teamshare-connect.mjs -o teamshare-connect.mjs
node teamshare-connect.mjs https://54.90.22.249.sslip.io
```

It prompts for your personal token (hidden as you type) — paste the one your lead sent you.
No clone, no install, no build. Run `node teamshare-connect.mjs --list` to
see which assistants it detects on this machine.

Either way, confirm it worked by starting a session and asking your agent
whether you have any unread team shares. If a teammate has published one, you
will see it; if nothing has been shared yet, you will be told that too — which
is the same answer, and that is the point.

Every delivery failure here is silent by design, so "I see nothing" and "I am
not connected" look identical. If you need a real check, `teamshare doctor`
does one — it needs a checkout of this repo, so see
[`docs/reference.md`](docs/reference.md#diagnosing-a-silent-connection-teamshare-doctor).

## Add someone to your team (the lead)

Once you've created a team (`node teamshare-team.mjs create-team`, which prints
an **admin token** — save it, but note it cannot itself join teamshare),
mint each teammate their own personal token and send it to them privately:

```bash
curl -fsSL https://raw.githubusercontent.com/abdulgeek/teamshare/main/packages/server/src/teamshare-team.mjs -o teamshare-team.mjs
node teamshare-team.mjs invite https://54.90.22.249.sslip.io <email> ["<name>"]
```

It prompts for your admin token rather than taking it as an argument, so the
token stays out of your shell history and out of `ps` output. For scripting,
set `TEAMSHARE_ADMIN_TOKEN` in the environment instead (`TEAMSHARE_TEAM_TOKEN`
is an older alias for the same thing). It prints
that person's token once, plus ready-to-send join instructions — send them
in a DM, never in a shared channel. One message per person is what makes a
share's sender and a receipt's reader real, checked facts instead of an
unverified claim.

Full admin reference — `revoke`, `roster`, rotating a leaked token — is in
[`docs/reference.md`](docs/reference.md#admin).

## Use it

**Publish a share:**

```
/share Auth middleware refactor lands Friday. Don't touch src/auth this week.
```

Claude distills this into a short note, shows it to you to confirm, then
publishes it — reporting the share id and how many teammates will be
notified.

**What a teammate sees:** at the start of their next session, their agent
tells them who shared what and asks if they want the details. Saying yes
shows the full note and records a `viewed` receipt; saying no (or ignoring
it) records `dismissed`. Both count as read.

**Check who's seen it:** ask "who's seen this?" — Claude reports how many
viewed, dismissed, and who's still unseen.

**Retract or mark stale:** the author of a share can retract it (hard delete,
gone everywhere) or mark it stale (stops showing as unread, stays in
history). Shares also age out on their own after 14 days.

## Walkthrough

**Priya** has her org's signup secret and server URL from the operator. No
checkout, no install — she downloads one script and creates her team:

```bash
curl -fsSL https://raw.githubusercontent.com/abdulgeek/teamshare/main/packages/server/src/teamshare-team.mjs -o teamshare-team.mjs
TEAMSHARE_SIGNUP_SECRET=<the-org-secret> node teamshare-team.mjs create-team https://54.90.22.249.sslip.io "Acme Engineering"
```

```
teamshare create-team — success

Team: Acme Engineering (tm_de3b55fed47e)

Team token (shown once — this cannot be recovered later; save it in a password manager now):

  ts_<a long generated value>

Verifying the new token against the live server:

[OK] server reachable at https://54.90.22.249.sslip.io/health
[OK] https://54.90.22.249.sslip.io/members returned 200 (0 known email(s))
...
This is the ADMIN token for this team, not a personal credential — it cannot be used to join
teamshare with. To actually use teamshare yourself, mint your own personal token first: ...
```

She saves the admin token in a password manager, then — because the admin
token can't itself be used to join — mints her own personal token:

```bash
TEAMSHARE_ADMIN_TOKEN=<the-admin-token-above> node teamshare-team.mjs invite https://54.90.22.249.sslip.io priya@example.com "Priya"
```

That prints her personal token (`tsm_...`) plus the same join instructions
below, which she follows herself.

**Inviting Sam.** Priya mints Sam his own token the same way:

```bash
TEAMSHARE_ADMIN_TOKEN=<the-admin-token-above> node teamshare-team.mjs invite https://54.90.22.249.sslip.io sam@example.com "Sam"
```

```
teamshare invite — success

Invited: Sam <sam@example.com>

Personal token for sam@example.com (shown once — this cannot be recovered later; save it in a password manager now):

  tsm_<a long generated value>

Send this token privately to sam@example.com only — never post it in a shared channel...

--- Joining the team in Claude Code ---
1. /plugin marketplace add abdulgeek/teamshare
   /plugin install teamshare
2. Paste the Server URL and Personal token when prompted — that token IS your
   identity; nothing to set up first.
3. Trust the workspace. 4. Requires Claude Code ≥ 2.1.238. 5. Restart Claude Code.

--- Not using Claude Code? ---
curl -fsSL .../teamshare-connect.mjs -o teamshare-connect.mjs
node teamshare-connect.mjs https://54.90.22.249.sslip.io
```

Priya sends that whole block to Sam in a DM, never in the team channel.

**Sam joins — Claude Code.** He runs the two `/plugin` commands above, pastes
the server URL and his personal token when prompted, trusts the workspace,
and restarts. No git config step — his token already is his identity.

**Sam joins — a non-Claude-Code assistant (Cursor, here).** No clone, no
install, no build:

```bash
curl -fsSL https://raw.githubusercontent.com/abdulgeek/teamshare/main/packages/server/src/teamshare-connect.mjs -o teamshare-connect.mjs
node teamshare-connect.mjs https://54.90.22.249.sslip.io
```

It prompts for his personal token (hidden as he types), detects Cursor on
his machine, and writes its MCP config:

```
teamshare connect — result

  [written]       Cursor -> ~/.cursor/mcp.json (backup: ~/.cursor/mcp.json.teamshare-backup-1788096310456)

1 assistant(s) configured automatically.
Restart the affected assistant(s) to pick up the change.
Run `teamshare doctor` next to confirm the connection actually works.
```

He confirms it actually works — every delivery failure here is silent by
design, so this is the one real check:

```bash
node packages/server/dist/cli.js doctor
```

```
[OK] found a teamshare entry in Cursor (~/.cursor/mcp.json)
[INFO] identity this machine would present: Sam <sam@example.com>
[OK] server reachable at https://54.90.22.249.sslip.io/health
[OK] https://54.90.22.249.sslip.io/unread returned 200 (0 unread share(s))
[OK] connected to team: Acme Engineering
```

**Priya publishes a share.** In Claude Code:

```
/share Auth middleware refactor lands Friday. Don't touch src/auth this week.
```

Claude distills it, shows her the result, confirms, then calls the `share`
tool and reports back: published as `blocking`, 1 teammate notified.

**Sam's next session opens with the digest** — his agent calls `unread` for
him automatically and tells him:

> 1 unread team share: Priya says the auth middleware refactor lands Friday
> and not to touch `src/auth` this week — blocking. Want the details?

Sam says yes. Claude calls `read_share`, shows him the full note, and
records a `viewed` receipt.

**Priya checks who's seen it.** She asks "who's seen the auth share?" —
Claude calls `receipts` and reports back exactly this:

```
1 viewed, 0 dismissed. Not yet seen by: nobody.
```

**Priya retracts it** once the refactor has landed: "retract the auth
share." Claude calls `retract`. It's gone from `unread`, history, and
receipts alike — as if it had never been sent.

## Command reference

Grouped by who runs each command. **Needs a checkout + build**: the server
CLI, `node packages/server/dist/cli.js <cmd>` (built package name is
`teamshare`, so `teamshare <cmd>` if installed globally). **Curl-and-run, no
install**: `teamshare-team.mjs` and `teamshare-connect.mjs` — the real
first-time path if nothing is installed yet.

**Secrets are never positional arguments.** Every command below resolves its
secret from an environment variable, or an interactive hidden prompt on a
real terminal:

- `TEAMSHARE_SIGNUP_SECRET` — `create-team` (the standalone script).
- `TEAMSHARE_ADMIN_TOKEN` (or the older alias `TEAMSHARE_TEAM_TOKEN`) —
  `invite`, `revoke`, `roster`, `rotate-team`.
- `TEAMSHARE_URL` / `TEAMSHARE_TOKEN` — `connect` and `doctor` (both, or
  neither; a half-set pair is flagged, not silently ignored).

`teamshare-connect.mjs` is the one exception: it still accepts the personal
token as a second positional argument, but warns that it lands in shell
history — prefer the environment variable or the prompt.

**The operator** — needs a checkout + build. Runs the server, then stays out
of the loop.

- `serve` — start the server.
  ```bash
  node packages/server/dist/cli.js serve --port 8787 --host 127.0.0.1 --db /path/to/teamshare.db --expiry-days 14 --signup-secret <a-secret-you-choose> --open-signup --max-teams 20
  ```
- `signup-secret --show` — recover the signup secret if it was auto-generated or forgotten.
  ```bash
  node packages/server/dist/cli.js signup-secret --show
  ```

**The team lead** — curl-and-run, no checkout. Mint an admin token once, then
invite each teammate.

```bash
curl -fsSL https://raw.githubusercontent.com/abdulgeek/teamshare/main/packages/server/src/teamshare-team.mjs -o teamshare-team.mjs
```

- `create-team <url> "<name>"` — create a team; prints an admin token (shown once).
  ```bash
  TEAMSHARE_SIGNUP_SECRET=<secret> node teamshare-team.mjs create-team https://54.90.22.249.sslip.io "Acme Engineering"
  ```
- `rotate-team <url>` — invalidate the current admin token, mint a new one. No teammate's connection is disturbed.
  ```bash
  TEAMSHARE_ADMIN_TOKEN=<admin-token> node teamshare-team.mjs rotate-team https://54.90.22.249.sslip.io
  ```
- `invite <url> <email> ["<name>"]` — mint one person a personal token (shown once); send it to them privately.
  ```bash
  TEAMSHARE_ADMIN_TOKEN=<admin-token> node teamshare-team.mjs invite https://54.90.22.249.sslip.io sam@example.com "Sam"
  ```
- `revoke <url> <email>` — kill every live token for one email, on every device.
  ```bash
  TEAMSHARE_ADMIN_TOKEN=<admin-token> node teamshare-team.mjs revoke https://54.90.22.249.sslip.io sam@example.com
  ```
- `roster <url>` — list who has a live token and who's still "invited, not yet active."
  ```bash
  TEAMSHARE_ADMIN_TOKEN=<admin-token> node teamshare-team.mjs roster https://54.90.22.249.sslip.io
  ```

**The lead, from a checkout** — same five identity operations as the local
database's own break-glass CLI, needing no admin token at all (filesystem
access to the database already implies that authority). `--team "<name>"` is
required once the server hosts more than one team, optional and inferred
otherwise.

```bash
node packages/server/dist/cli.js create-team "<name>" [--url https://54.90.22.249.sslip.io] [--db <path>]
node packages/server/dist/cli.js invite <email> ["<name>"] [--team "<name>"] [--db <path>]
node packages/server/dist/cli.js revoke <email> [--team "<name>"] [--db <path>]
node packages/server/dist/cli.js roster [--team "<name>"] [--db <path>]
node packages/server/dist/cli.js rotate-token [--team "<name>"] [--db <path>]
node packages/server/dist/cli.js remove-member <email> [--team "<name>"] [--db <path>]
```

`remove-member` deletes a departed engineer from the historical roster;
`revoke` kills their live tokens instead. Removing someone cleanly means
both — `revoke` first, then `remove-member`.

**Diagnosing a connection** — needs a checkout + build. Anyone can run these
against any server, regardless of what's configured on this machine.

- `doctor [<url> <token>]` — the real check for a silent connection: resolves a server URL/token (explicit args, `TEAMSHARE_URL`/`TEAMSHARE_TOKEN`, `~/.teamshare.json`, or a discovered assistant config, in that order) and reports identity, reachability, and unread count.
  ```bash
  TEAMSHARE_URL=https://54.90.22.249.sslip.io TEAMSHARE_TOKEN=<your-token> node packages/server/dist/cli.js doctor
  ```
- `connect <url> <token> [--only cursor,codex] [--dry-run] [--force] [--show-token]` — same connector as the standalone script below, built into the CLI.
  ```bash
  node packages/server/dist/cli.js connect https://54.90.22.249.sslip.io <your-token> --only cursor,codex --dry-run
  ```
- `connect --list` — show which assistants this machine has and their config paths, without writing anything.
  ```bash
  node packages/server/dist/cli.js connect --list
  ```

**The teammate** — curl-and-run, no checkout. For every assistant except
Claude Code.

```bash
curl -fsSL https://raw.githubusercontent.com/abdulgeek/teamshare/main/packages/server/src/teamshare-connect.mjs -o teamshare-connect.mjs
```

- `<url> [token]` — configure every detected assistant on this machine in one run; prompts for the token (hidden) if you don't pass it or set `TEAMSHARE_TOKEN`.
  ```bash
  node teamshare-connect.mjs https://54.90.22.249.sslip.io
  ```
- `--only cursor,codex` — restrict to specific targets: `cursor`, `vscode`, `windsurf`, `gemini`, `cline`, `codex`, `zed`, `continue`.
- `--dry-run` — print what would change, write nothing.
- `--force` — overwrite an unrelated MCP server that happens to already be named `teamshare`.
- `--show-token` — print the real token in a manual snippet (needed for Zed and Continue.dev, which are print-only every time).
- `--list` — detect without writing.
  ```bash
  node teamshare-connect.mjs --list
  ```

**Claude Code slash commands**

- `/share [what you want the team to know]` — distill and publish a share.
  ```
  /share Auth middleware refactor lands Friday. Don't touch src/auth this week.
  ```
- `/teamshare-create-team [team name] [server-url]` — mint a *second*, independent team on a server this machine already talks to. Not the first-time path — that's the team-lead section above.
  ```
  /teamshare-create-team "Platform Team" https://54.90.22.249.sslip.io
  ```
- `/teamshare-setup [server-url] [team-token]` — supply the server URL and token by hand, for `claude --plugin-dir` development or repairing a broken config. Not part of a normal install.
  ```
  /teamshare-setup https://54.90.22.249.sslip.io tsm_...
  ```

**MCP tools your agent calls for you** — you don't type these; ask in plain
language ("what's unread", "who's seen this", "retract the auth share") and
Claude calls the right one.

| Tool | What it does |
|---|---|
| `share` | Publish a note to the whole team. |
| `unread` | Shares this user hasn't viewed or dismissed yet — called at session start. |
| `read_share` | Full body of one share; records a `viewed` receipt. |
| `acknowledge` | Marks a share read (`dismissed`) without showing the detail. |
| `list_shares` | Browse share history, newest first, including expired shares. |
| `receipts` | Who's viewed, dismissed, or not yet seen one share. |
| `retract` | Hard-delete a share you authored, and every receipt for it. |
| `mark_stale` | Soft-retract: stops showing as unread, stays in history. |

## More

Deeper background — the trust model, deploy requirements, and `teamshare
doctor` internals — lives in [`docs/reference.md`](docs/reference.md).
