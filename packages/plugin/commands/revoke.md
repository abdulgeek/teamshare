---
description: Revoke every teamshare token held by one person
argument-hint: "<email>"
---

# Revoke a teammate

Kills every live token issued to one email, on every device. This is the
one-command remedy when somebody leaves, or when a token has leaked.

## Steps

1. **Get the email** from `$ARGUMENTS`. If there is none, ask — and consider
   running `/teamshare:roster` first so the user picks from real addresses
   rather than a remembered one.

2. **Confirm before running.** This is not reversible: the person is locked
   out on their next request and needs a fresh invite to come back. Say whose
   access is about to end and wait for a yes.

3. Run it:

   ```bash
   teamshare-team revoke <email>
   ```

   Add `--team "<name>"` if this machine holds admin tokens for more than one
   team on the server.

4. **Relay the count.** `0` revoked means that email had no live tokens —
   usually a typo, or somebody already revoked. Check the spelling against
   `/teamshare:roster` rather than assuming it worked.

   Their past shares stay: revoking removes access, it does not erase what
   they published. Only the author can retract a share.

## Failure handling

- `no admin token` — this machine never created a team; see
  `/teamshare:create-team`.
- `401` — the saved admin token was rotated or revoked elsewhere.
- `command not found` — restart Claude Code so the plugin's `bin/` is on PATH.
