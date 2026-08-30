---
description: Invite someone to your teamshare team and get their personal token
argument-hint: "<email> [their name]"
---

# Invite a teammate

Mints a personal token for one named person and prints the exact message to
send them. Their identity is bound to that token by you, not claimed by their
client — which is what makes "who has seen this?" a real answer rather than a
guess.

## Steps

1. **Get the email** from `$ARGUMENTS` (first token) and optionally their
   display name (the rest). If there is no email, ask for one. One person per
   invite — that is the whole point; a token shared by two people attributes
   both to one name.

2. **Mint it.** The admin token comes from `~/.teamshare/admin.json`, saved by
   `/teamshare-create-team`, so nothing is pasted:

   ```bash
   teamshare-team invite <email> "<name>"
   ```

   If this machine holds admin tokens for more than one team on the server,
   the command says so and lists them. Ask which, then add `--team "<name>"`.

3. **Relay the output as-is**, including the personal token and the
   ready-to-send joining message. The lead has to transmit that token to reach
   this person; hiding it would leave the command useless.

   Then tell them plainly:
   - Send it to that person **directly** — a DM or a password manager — never
     a shared channel. Whoever holds it can publish shares and record receipts
     as that person.
   - This token is in this conversation's transcript now. If that matters,
     `/teamshare-revoke <email>` invalidates it and a fresh invite replaces it.
   - The token is shown once and is not recoverable; re-inviting mints a new
     one rather than recovering the old.

4. **If the lead is inviting themselves**, point out that this is the token
   they paste into their own `/plugin install teamshare` prompt — the admin
   token cannot be used for that.

## Failure handling

- `no admin token` — this machine never created a team. If they own one
  elsewhere, they can set `TEAMSHARE_ADMIN_TOKEN`; if someone else owns it,
  they should ask that person to invite them instead.
- `401` — the saved admin token was rotated or revoked elsewhere. Rotate again
  from the machine that has a working one.
- `400` — the email was rejected; check it is a real address.
- `command not found` — restart Claude Code so the plugin's `bin/` is on PATH.
