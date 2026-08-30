---
description: Show who is on your teamshare team and who has actually connected
---

# Team roster

Answers the question a lead actually has: which of my teammates are set up,
and which are still sitting on an invite they never used.

## Steps

1. Run it. The admin token comes from `~/.teamshare/admin.json`:

   ```bash
   teamshare-team roster
   ```

   Add `--team "<name>"` if this machine holds admin tokens for more than one
   team on the server; the command lists them when it needs you to choose.

2. Relay the list, then read it for the user rather than restating it:
   - **never connected** means invited but never used — that person is not
     receiving shares at all, and does not know it. Worth chasing.
   - **last seen** is when their client last spoke to the server, which is a
     better signal than whether they replied to anything.
   - Several active tokens for one person is normal — a laptop, a desktop, CI.
     It is not a duplicate to clean up.

3. If somebody has left, `/teamshare-revoke <email>` kills every token they
   hold in one command.

## Failure handling

- `no admin token` — this machine never created a team; see
  `/teamshare-create-team`, or set `TEAMSHARE_ADMIN_TOKEN` for a team owned
  elsewhere.
- `401` — the saved admin token was rotated or revoked elsewhere.
- `command not found` — restart Claude Code so the plugin's `bin/` is on PATH.
