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

## Join a team (the most common path)

Every share and read receipt is attributed to your git identity. Set it
once, before installing anything:

```bash
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

Then, depending on your assistant:

**Claude Code:**

```
/plugin marketplace add abdulgeek/teamshare
/plugin install teamshare
```

You'll be prompted for the **Server URL** and **Your personal token** — the
token your team lead sent you privately with `teamshare invite` (see below).
Trust the workspace when asked, then restart Claude Code.

**Everything else (Cursor, Codex, Windsurf, Gemini CLI, ...):**

```bash
curl -fsSL https://raw.githubusercontent.com/abdulgeek/teamshare/main/packages/server/src/teamshare-connect.mjs -o teamshare-connect.mjs
node teamshare-connect.mjs <server-url> <your-personal-token>
```

No clone, no install, no build. Run `node teamshare-connect.mjs --list` to
see which assistants it detects on this machine.

Either way, confirm the connection actually works:

```bash
node packages/server/dist/cli.js doctor
```

Every delivery failure in this system is silent by design — see
[`docs/reference.md`](docs/reference.md#diagnosing-a-silent-connection-teamshare-doctor)
for why `doctor` exists and how to read its output.

## Add someone to your team (the lead)

Once you've created a team (`teamshare-team.mjs create-team`, which prints
an **admin token** — save it, but note it cannot itself join teamshare),
mint each teammate their own personal token and send it to them privately:

```bash
node packages/server/src/teamshare-team.mjs invite <server-url> <email> ["<name>"]
```

This needs the admin token, resolved from `TEAMSHARE_ADMIN_TOKEN` in the
environment (or prompted for on a real terminal — never a command-line
argument; `TEAMSHARE_TEAM_TOKEN` also works, as an older alias). It prints
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

## More

The full reference — every admin command, the trust model, deploy
requirements, `teamshare doctor` internals, and a worked example — lives in
[`docs/reference.md`](docs/reference.md).
