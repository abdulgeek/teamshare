---
description: Create a new teamshare team and save its admin token on this machine
argument-hint: "[team name]"
---

# Create a team

Creates a team on the teamshare server and saves its admin token here, so
every later admin command works without anyone pasting a credential again.

Run this once per team. To use teamshare yourself afterwards you still need a
personal token — `/teamshare:invite` your own email, which the final step
below tells you to do.

## Steps

1. **Get the team name** from `$ARGUMENTS`. If there is none, ask for one — a
   short group name like `Platform` or `Growth`. It is not secret; it appears
   in `/teamshare:status` for anyone on the team.

2. **Check the signup secret is available**, without ever asking for it in
   chat. It gates team creation on this server and must come from the
   environment of the terminal that launched Claude Code — a value typed into
   chat is in the transcript permanently, and typing it is avoidable here.

   ```bash
   node -e 'process.stdout.write(process.env.TEAMSHARE_SIGNUP_SECRET ? "SET" : "UNSET")'
   ```

   If `UNSET`, stop and tell the user to run this in their own terminal, which
   prompts for the secret without it touching this conversation:

   ```
   teamshare-team create-team "<team name>"
   ```

   Point out that `teamshare-team` is already on their PATH because this
   plugin is installed — there is nothing to download.

3. **Create the team.** The secret is read from the environment by the command
   itself and never appears in the command line:

   ```bash
   teamshare-team create-team "<team name>"
   ```

4. **Relay the output as-is.** It contains the admin token, printed once, plus
   where it was saved and what to do next. Do not summarise it away or hide
   the token — the user asked for it and needs a copy in their password
   manager, because the saved file dies with this machine.

   Then say, in your own words:
   - The admin token is saved at `~/.teamshare/admin.json`, so
     `/teamshare:invite`, `/teamshare:roster` and `/teamshare:revoke` on this
     machine need nothing pasted.
   - It is worth putting a copy in a password manager now.
   - It is an **admin** credential: it invites, revokes, reads the roster and
     rotates itself. It cannot read shares and cannot be used to join.
   - **Next step:** `/teamshare:invite <their own email>` — otherwise they own
     a team they cannot use.

## Failure handling

Read the command's own error text and relay it; it is written to be actionable.
The cases worth naming:

- `command not found` — the plugin is installed but this session started
  before its `bin/` was on PATH. Restart Claude Code.
- `401` — the signup secret is wrong.
- `403` — the server has hit its team cap.
- `429` — rate-limited; wait and retry.
- `400` — the name was rejected (empty, or an unsubstituted placeholder).
  Ask for a real name and retry.
- Anything about not reaching the server — report the URL it tried. Check with
  `/teamshare:status`.

## Rules

- **Never put the signup secret in a command line, and never ask for it in
  chat.** It goes in the environment or the command prompts for it in a real
  terminal.
- The team token this prints is the user's to keep. Print it once, as the
  command emits it, and don't repeat it later in the conversation.
