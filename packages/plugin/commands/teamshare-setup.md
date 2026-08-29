---
description: Connect this machine to your team's teamshare server
argument-hint: "[server-url] [team-token]"
---

# teamshare setup

Connect this machine to the team's teamshare server by writing `~/.teamshare.json`.

## Steps

1. Determine the **server URL** and **team token**:
   - If the user passed them as arguments, use those.
   - Otherwise ask for both. The admin who ran `teamshare serve` has them.
   - The URL is an origin with no path — `http://localhost:8787` or
     `https://teamshare.internal`. Strip any trailing `/mcp` or slash.

2. Read the user's git identity:

   ```bash
   git config --get user.name; git config --get user.email
   ```

   If either is empty, stop and tell the user to set them:

   ```bash
   git config --global user.name "Your Name"
   git config --global user.email "you@example.com"
   ```

3. Verify the server accepts these credentials before writing anything:

   ```bash
   curl -s -o /dev/null -w '%{http_code}' \
     -H "Authorization: Bearer <TOKEN>" \
     -H "X-Teamshare-Email: <EMAIL>" \
     -H "X-Teamshare-Name: <NAME>" \
     "<URL>/unread"
   ```

   - `200` → good, continue.
   - `401` → the token is wrong. Ask for it again; do not write the file.
   - `400` → identity headers are malformed. Re-check the git identity.
   - anything else / no response → the server is unreachable. Report the URL
     tried and stop.

4. Write `~/.teamshare.json` with exactly these four keys — the email
   lowercased, and the URL with no trailing slash:

   ```json
   {
     "url": "http://localhost:8787",
     "token": "ts_...",
     "name": "Adnan",
     "email": "adnan@team.com"
   }
   ```

5. Confirm to the user: the URL, the identity that will appear on their shares,
   and that the MCP connection picks this up on the **next** session (the
   current session's connection was configured at startup).

   If the URL is anything other than the default `http://localhost:8787`, there's
   one more thing to tell the user. The MCP connection and the session-start
   digest resolve the server address in two different ways — the digest reads
   `~/.teamshare.json` directly, but Claude Code itself resolves the teamshare
   MCP server's URL from the environment at startup, and the two can't be
   unified today. So the user also needs to export `TEAMSHARE_URL` in their
   shell profile, or the digest will keep working while the teamshare tools
   silently fail to connect:

   ```bash
   export TEAMSHARE_URL=<their-url>
   ```

## Rules

- Never print the token back to the user or into the transcript.
- Never write the file before the `200` check passes.
- If `~/.teamshare.json` already exists, show the current URL and identity and
  confirm before overwriting.
