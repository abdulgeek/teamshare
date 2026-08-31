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

2. **Try it with no secret at all first.** The secret is remembered per server
   after the first successful create-team on this machine, and it may already
   be in the environment. Either way this succeeds with nothing supplied:

   ```bash
   teamshare-team create-team "<team name>"
   ```

   If that works, skip to step 4. Most runs after the very first end here.

3. **Only if that failed for want of a secret**, get one and pass it. The
   signup secret is what the server uses to gate team creation — one value,
   shared across the organisation. In order of preference:

   - **In `$ARGUMENTS`?** Anything after the team name is the secret. Use it,
     and mention once — briefly, not as a lecture — that it is now in this
     conversation's transcript, that it only permits creating teams (no
     shares, receipts or roster), and that it will not be needed again here.

   - **Otherwise ask for it**, telling them where to look:
     - Whoever runs the server has it; it is one value for the whole org.
     - If they run the server themselves and deployed from this repo,
       `deploy/aws/signup-secret.sh` prints it and nothing else.
     - If they are standing up a brand-new server and choosing the value,
       `teamshare signup-secret --generate` prints a correctly-formed one
       (`tss_` and 48 hex characters). The server does not require that shape —
       any string it was configured with works — but this saves inventing one.

   Then run it, with the secret in a private file rather than on the command
   line, because argv is visible in `ps` and in the tool-call display:

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
- `401` — that value is not this server's signup secret. **Do not guess
  again, and do not retry with a different argument from the same message.**
  Tell the user where the real one comes from:
  - Whoever runs the server has it. It is a single value shared across the
    organisation, not something per-person and not something you can derive.
  - If they run the server themselves and deployed it from this repo, it is
    one command — `deploy/aws/signup-secret.sh` (needs AWS credentials for
    that account) prints the value and nothing else.
  - It is **not** the team name, an admin token (`ts_…`) or a personal token
    (`tsm_…`). Those are different credentials and none of them work here.

  If what they passed looks like a placeholder rather than a real secret —
  `12345`, `secret`, `xxx` — say so plainly; they were probably filling in the
  shape of the command rather than supplying a value.
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
