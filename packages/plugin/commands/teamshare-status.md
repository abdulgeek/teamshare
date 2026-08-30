---
description: Check whether this machine is actually connected to teamshare
---

# teamshare status

teamshare fails **silently** on purpose — a broken connection never interrupts
a session — which means "no shares today" and "not connected at all" look
identical from the inside. This is the command that tells them apart.

## Steps

1. Run it:

   ```bash
   teamshare-team whoami
   ```

2. Relay the output, then interpret it:

   - **personal token working** — connected. `0 unread` genuinely means nobody
     has shared anything new, not that something is broken.
   - **not set on this machine** — the plugin is installed but was never given
     a token. Fix with `/plugin configure teamshare@teamshare`, or ask the
     lead for an invite if they have no token at all.
   - **rejected (401)** — the token was revoked, or it is an admin token
     rather than a personal one. Those are different credentials: an admin
     token invites and revokes, and can read nothing. Ask the lead for
     `/teamshare-invite <your-email>`.
   - **could not reach** — the server is down or the network is blocking it.
     Report the address it tried.

3. The `Server:` line also says *where the address came from*. If it says
   anything other than the plugin's own `.mcp.json` or the built-in default,
   something is overriding it (`TEAMSHARE_URL`, or a `~/.teamshare.json` left
   behind by an old setup) — and that is the usual cause of a machine that
   publishes to one server while reading from another.

4. If the MCP tools themselves are missing rather than failing, that is a
   different problem from anything this reports: check `/mcp`, and make sure
   the workspace was trusted and Claude Code restarted after install.

## Failure handling

`command not found` means this session started before the plugin's `bin/` was
on PATH. Restart Claude Code.
