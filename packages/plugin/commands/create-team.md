---
description: Create a new teamshare team and save its admin token on this machine
argument-hint: "<team name> [signup secret]"
---

# Create a team

Creates a team on the teamshare server and saves its admin token here, so every
later admin command works without anyone pasting a credential again.

Run this once per team. To use teamshare yourself afterwards you still need a
personal token — `/teamshare:invite` your own email, which the last step below
tells you to do.

## Steps

1. **Get the team name** from `$ARGUMENTS`. If there is none, ask for one — a
   short group name like `Platform` or `Growth`. It is not secret; it shows up
   in `/teamshare:status` for anyone on the team.

2. **Get the signup secret.** It gates team creation on this server. In order:

   - **Already in the environment?** Check without printing it:

     ```bash
     node -e 'process.stdout.write(process.env.TEAMSHARE_SIGNUP_SECRET ? "SET" : "UNSET")'
     ```

     If `SET`, use it and skip the rest of this step.

   - **Given in `$ARGUMENTS`?** Anything after the team name is the secret.
     Use it, and warn the user once — briefly, not as a lecture — that it is
     now in this conversation's transcript. Say what that does and does not
     mean: the signup secret only permits creating teams. It grants no access
     to any team's shares, receipts or roster, and it is meant to be shared
     across the org anyway. If they would rather it were not recorded, the
     alternative is one terminal command, in step 4's fallback.

   - **Neither?** Ask them to type it as an argument:
     `/teamshare:create-team <team name> <signup secret>` — with the same
     one-line note about the transcript. Whoever runs the server has the
     value; if they deployed from this repo and the server generated it on
     first boot, `deploy/aws/signup-secret.sh` reads it back.

3. **Create the team.** The secret must never appear in the command line —
   argv shows up in `ps` and in the tool-call display. Write it to a private
   file first, pass the path, and delete the file immediately afterwards:

   ```bash
   umask 077 && printf '%s' '<the secret>' > "$TMPDIR/ts-signup" && \
     teamshare-team create-team "<team name>" --signup-secret-file "$TMPDIR/ts-signup"; \
     rc=$?; rm -f "$TMPDIR/ts-signup"; exit $rc
   ```

   Delete the file even when the command fails — hence the `rm` outside the
   success path.

4. **Relay the output as-is.** It contains the admin token, printed once, plus
   where it was saved and what to do next. Do not summarise it away or hide the
   token: the user needs a copy in their password manager, because the saved
   file dies with this machine.

   Then say, in your own words:
   - The admin token is saved to `~/.teamshare/admin.json`, so
     `/teamshare:invite`, `/teamshare:roster` and `/teamshare:revoke` on this
     machine need nothing pasted.
   - It is an **admin** credential: it invites, revokes, reads the roster and
     rotates itself. It cannot read shares and cannot be used to join.
   - **Next:** `/teamshare:invite <their own email>` — otherwise they own a
     team they cannot use.

   **Fallback, if they would rather no secret touched this conversation:** the
   same command in their own terminal prompts for it with hidden input.
   `teamshare-team` is on PATH only inside Claude Code, so give them a form
   that works in a plain terminal — from a checkout,
   `node packages/server/src/teamshare-team.mjs create-team "<name>"`, or with
   no checkout, `curl -fsSL https://raw.githubusercontent.com/abdulgeek/teamshare/main/packages/server/src/teamshare-team.mjs -o teamshare-team.mjs && node teamshare-team.mjs create-team "<name>"`.

## Failure handling

Read the command's own error text and relay it; it is written to be actionable.

- `command not found` — this session started before the plugin's `bin/` was on
  PATH. Restart Claude Code.
- `401` — the signup secret is wrong.
- `403` — the server has hit its team cap.
- `429` — rate-limited; wait and retry.
- `400` — the name was rejected (empty, or an unsubstituted placeholder). Ask
  for a real name and retry.
- Anything about not reaching the server — report the address it tried, and
  check `/teamshare:status`.

## Rules

- **The secret never goes in a command line or an environment assignment on
  one.** It moves through a file you create and delete, and nothing else.
- Print the admin token once, as the command emits it, and don't repeat it
  later in the conversation.
