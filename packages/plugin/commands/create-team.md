---
description: Create a new teamshare team and save its admin token on this machine
argument-hint: "<org-name>"
---

# Create a team

Creates a team on the teamshare server and saves its admin token here, so every
later admin command works without anyone pasting a credential again.

Run this once per team. To use teamshare yourself afterwards you still need a
personal token — `/teamshare:invite` your own email, which the last step below
tells you to do.

## Steps

1. **Get the org name** from `$ARGUMENTS`. If there is none, ask for one — a
   short name like `acme` or `Platform`. It is not secret; it shows up in
   `/teamshare:status` for anyone on the team. Never leave the literal
   `<org-name>` placeholder in the command.

2. **Create the team. Name only.** Do not run `/teamshare:generate-secret`
   first. Do not pass a `tss_…` value from this conversation or from a
   previous generate-secret. create-team recovers the live signup secret on
   this machine (terraform state, a local instance pin, or
   `TEAMSHARE_INSTANCE_ID`) and the hosted server will reject a freshly
   minted secret with 401.

   ```bash
   teamshare-team create-team "<org-name>"
   ```

   If create-team fails for want of a secret this machine cannot recover,
   they need the org-wide value from whoever deployed the server. Write it
   to a private file — never a command line, and never an instance id from
   this conversation:

   ```bash
   umask 077 && printf '%s' '<the secret>' > "$TMPDIR/ts-signup" && \
     teamshare-team create-team "<org-name>" --signup-secret-file "$TMPDIR/ts-signup"; \
     rc=$?; rm -f "$TMPDIR/ts-signup"; exit $rc
   ```

   Delete the file even when the command fails.

   **Never** put a generate-secret mint that said "not yet on any server"
   into that file. That value is not the hosted server's secret.

3. **Relay the output as-is.** It contains the admin token, printed once, plus
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

## Failure handling

Read the command's own error text and relay it; it is written to be actionable.

- `command not found` — this session started before the plugin's `bin/` was on
  PATH. Restart Claude Code.
- `401` — the signup secret this machine offered is not this server's. Do not
  guess again, and do **not** retry with a `tss_…` that generate-secret
  printed as "not yet on any server". On an operator machine, create-team
  recovers the live value from local terraform state, `~/.teamshare/instance.json`,
  or `TEAMSHARE_INSTANCE_ID`. Do not invent an instance id. If recover is not
  available, they need the org-wide secret from whoever runs the server — it
  is not the team name, an admin token (`ts_…`) or a personal token (`tsm_…`).
- `403` — the server has hit its team cap.
- `429` — rate-limited; wait and retry.
- `400` — the name was rejected (empty, or an unsubstituted placeholder). Ask
  for a real name and retry.
- Anything about not reaching the server — report the address it tried, and
  check `/teamshare:status`.

## Rules

- **The secret never goes in a command line or an environment assignment on
  one.** It moves through AWS recover, the remembered store, or a file you
  create and delete.
- Print the admin token once, as the command emits it, and don't repeat it
  later in the conversation.
