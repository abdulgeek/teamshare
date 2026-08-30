---
description: Set up teamshare in your other AI assistants (Cursor, Codex, Windsurf, and more)
argument-hint: "[--dry-run] [--only cursor,codex]"
---

# Connect your other assistants

teamshare is not Claude-only. The same board, the same shares and the same
read receipts work from Cursor, Codex, Windsurf, Gemini CLI, Cline, Zed and
VS Code — they all speak MCP. This writes the config for whichever of them are
installed on this machine.

Use it when the user says something like "set this up in Cursor too".

## Steps

1. **Show what would change first.** This writes to other tools' config files,
   so never go straight to writing:

   ```bash
   teamshare-connect --list
   ```

   Relay which assistants it found. Anything marked not installed is skipped.

2. **Get their token.** The connector needs the user's own personal token, and
   it must not go on the command line — a command line lands in shell history
   and in this transcript. Ask them to paste it into `TEAMSHARE_TOKEN` in
   their own terminal, or better, tell them to run this themselves:

   ```
   teamshare-connect
   ```

   It prompts for the token with hidden input, takes no other arguments, and
   already knows the server address. That is the recommended path and it is
   one word.

3. **If they would rather you ran it**, and the token is already in this
   session's environment, confirm the target list first and then run:

   ```bash
   teamshare-connect --dry-run
   ```

   Relay the plan, get a yes, then run it without `--dry-run`. Pass
   `--only cursor,codex` to narrow it. Existing `teamshare` entries are left
   alone unless `--force` is given, and every file it touches is backed up
   first — say so.

4. **Tell them to restart** the assistants it configured. Nothing picks up new
   MCP config in a running process.

## What the other assistants get, and do not get

Be accurate about this: they get the teamshare **tools** — publishing a share,
reading unread ones, receipts, retracting. They do **not** get the automatic
session-start digest or `/share`; those are Claude Code plugin features. In
another assistant the user asks for their unread shares in plain language
instead.

## Rules

- Never put the token in a command line, in either tooling or a suggestion.
- Never run this without showing the user what it will touch first.
