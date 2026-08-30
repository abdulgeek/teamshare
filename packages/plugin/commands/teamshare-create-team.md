---
description: Create an additional team on a teamshare server this machine already talks to (not the first-time setup path)
argument-hint: "[team name] [server-url]"
---

# teamshare create-team

**This is not how you bootstrap teamshare for the first time.** Installing
this very plugin prompts for the server URL and a team token — the token
this command exists to create. If teamshare isn't already working on this
machine (no server reachable, `/plugin` has nothing configured, or you're
just not sure), stop here and use the standalone script instead — it needs
nothing installed and can prompt for the signup secret interactively:

```bash
node packages/server/src/teamshare-team.mjs create-team <server-url> "<team name>"
```

(or, with no checkout at all: `curl -fsSL
https://raw.githubusercontent.com/abdulgeek/teamshare/main/packages/server/src/teamshare-team.mjs
-o teamshare-team.mjs && node teamshare-team.mjs create-team <server-url>
"<team name>"`).

Use *this* command only when this machine already has a working teamshare
connection (this plugin is installed and connected, or `~/.teamshare.json` is
set up) and you want to mint a **second, independent team** on the **same
server** — e.g. spinning one up for another group at the org. It does not
touch this machine's own connection at all.

## Why this can't just print the token

The signup secret gates every `POST /teams`, and the freshly minted team
token that comes back must never appear in this session's transcript — a
transcript is stored and can be replayed later, unlike a real terminal, which
is why the standalone script above is allowed to print the token directly and
this command is not. Follow the same pattern as `/teamshare-setup`: secrets
and tokens only ever move through files and environment variables Claude
reads and writes without echoing, never through a command's visible text or
output.

## Steps

1. **Determine the team name.** From `$ARGUMENTS` (the first token) if
   given, otherwise ask. This is not secret — team names show up in
   `teamshare doctor`'s "connected to team: ..." line for anyone with a
   valid token.

2. **Determine the server URL.** From `$ARGUMENTS` (the second token) if
   given. Otherwise check `~/.teamshare.json` — if it exists, use its `url`
   field and confirm it with the user ("this will create a team on
   `<url>` — right server?"). If neither is available, ask for it directly
   (also not secret). Strip any trailing slash or `/mcp` suffix before using
   it.

3. **Check whether the signup secret is available — without asking for it in
   chat.** The instance signup secret must come from the `TEAMSHARE_SIGNUP_SECRET`
   environment variable, already exported in the terminal that launched Claude
   Code — never typed into this conversation, and never passed as this
   command's argument. Both would land it permanently in the transcript, the
   exact thing this command exists to avoid. Check for it with a status-only
   probe:

   ```bash
   node -e 'process.stdout.write(process.env.TEAMSHARE_SIGNUP_SECRET ? "SET" : "UNSET")'
   ```

   If this prints `UNSET`, stop. Tell the user: export `TEAMSHARE_SIGNUP_SECRET`
   in a real terminal and restart Claude Code from there, or — usually
   simpler — just run the standalone script above, which can prompt for the
   secret interactively without it ever touching this session.

4. **Check for a leftover file from a previous run** before writing anything:

   ```bash
   test -f ~/.teamshare-new-team.json && echo EXISTS || echo CLEAR
   ```

   If `EXISTS`, ask the user to confirm before continuing — it may hold a
   token from an earlier run they haven't saved yet. If they confirm, move it
   aside first (e.g. `mv ~/.teamshare-new-team.json
   ~/.teamshare-new-team.json.bak`) rather than silently overwriting it.

5. **Create and verify the team**, with the team name and server URL passed
   as environment variables (not secret, but this keeps every value out of
   the executed command's argument list uniformly) and the signup secret read
   straight out of the environment already checked in step 3 — never
   embedded in the script text:

   ```bash
   TEAMSHARE_NEW_TEAM_NAME="<team name>" TEAMSHARE_NEW_TEAM_URL="<server-url>" node -e '
   const fs = require("node:fs");
   const os = require("node:os");
   const path = require("node:path");

   const name = process.env.TEAMSHARE_NEW_TEAM_NAME;
   const url = String(process.env.TEAMSHARE_NEW_TEAM_URL).replace(/\/+$/, "").replace(/\/mcp$/i, "");
   const secret = process.env.TEAMSHARE_SIGNUP_SECRET;

   (async () => {
     if (!secret) { console.log("RESULT: no-secret"); process.exitCode = 1; return; }

     let res;
     try {
       res = await fetch(url + "/teams", {
         method: "POST",
         headers: { "content-type": "application/json", "X-Teamshare-Signup-Secret": secret },
         body: JSON.stringify({ name }),
       });
     } catch (err) {
       console.log("RESULT: unreachable " + (err && err.message ? err.message : err));
       process.exitCode = 1;
       return;
     }
     const body = await res.json().catch(() => null);
     if (!res.ok) {
       const msg = body && typeof body.error === "string" ? body.error : ("HTTP " + res.status);
       console.log("RESULT: create-failed " + res.status + " " + msg);
       process.exitCode = 1;
       return;
     }

     const outPath = path.join(os.homedir(), ".teamshare-new-team.json");
     fs.writeFileSync(outPath, JSON.stringify({ team_id: body.team_id, name: body.name, token: body.token, url }, null, 2), { mode: 0o600 });
     try { fs.chmodSync(outPath, 0o600); } catch {}

     let healthy = true;
     try {
       const h = await fetch(url + "/health");
       if (!h.ok) healthy = false;
     } catch { healthy = false; }

     // /members, NOT /unread. The token just minted is the team's ADMIN
     // token, and an admin token grants no access to shares, receipts, or
     // the digest — /unread 401s for it by design, so checking there would
     // report every successful creation as unhealthy. /members is the one
     // data-plane-adjacent route an admin token genuinely does authenticate,
     // and it needs no per-user identity headers. This mirrors verifyTeam()
     // in packages/server/src/teamshare-team.mjs.
     try {
       const m = await fetch(url + "/members", {
         headers: { Authorization: "Bearer " + body.token },
       });
       if (m.status !== 200) healthy = false;
     } catch { healthy = false; }

     console.log("RESULT: created " + JSON.stringify(body.name));
     console.log("VERIFY: " + (healthy ? "healthy" : "unhealthy"));
     console.log("SAVED: " + outPath);
   })();
   '
   ```

   The only lines this prints are `RESULT: ...`, `VERIFY: ...`, and
   `SAVED: ...` — never the token or the signup secret. Read only these
   lines back; never `cat` or otherwise open the saved file yourself.

6. **Report to the user** based on the `RESULT:` line, and nothing else from
   the file:
   - `no-secret` — the environment variable disappeared between steps 3 and
     5 (rare). Ask them to re-export it and retry.
   - `unreachable <message>` — report the URL tried and the message; likely
     the wrong URL or the server is down.
   - `create-failed 401 ...` — the signup secret is wrong.
   - `create-failed 403 ...` — this instance has hit its team cap.
   - `create-failed 429 ...` — rate-limited; wait and retry.
   - `create-failed 400 ...` — the team name was rejected (e.g. empty, or an
     unsubstituted placeholder like `${TEAM_NAME}`); ask for a real name and
     retry.
   - `created "<name>"` with `VERIFY: healthy` — success. Tell the user:
     - The team was created and verified end to end.
     - The token was written to `~/.teamshare-new-team.json` and was
       **never shown in this conversation** — open that file yourself,
       outside Claude Code (a text editor, `cat` in your own terminal, or
       Finder), to get the token. Save it in a password manager, then delete
       the file.
     - Re-verify anytime with the env-var form (never paste the token as a
       positional argument): `TEAMSHARE_URL=<url> TEAMSHARE_TOKEN=<token>
       teamshare doctor`.
     - Give the same real join instructions `/teamshare-setup` and the
       standalone script give — `/plugin marketplace add
       abdulgeek/teamshare` then `/plugin install teamshare`, trusting the
       workspace, the Claude Code ≥ 2.1.238 requirement, and the restart —
       with the token filled in from the file, not from this conversation.
       No git identity step: attribution comes from the token itself.
   - `created "<name>"` with `VERIFY: unhealthy` — the team exists but
     something didn't check out (server unreachable on the second call, or
     the new token was rejected). Tell the user the team was created, the
     token is still in the file, and to run `teamshare doctor` themselves
     (env-var form) once they've retrieved it, to see exactly what's wrong.

## Rules

- **Never print the token, or the signup secret, into this conversation** —
  not in a command's argument list, not in its output, not summarized,
  not partially. If a step would require that, stop and tell the user to do
  it themselves in their own terminal instead.
- **Never ask the user to paste the signup secret into chat.** A chat message
  is part of the transcript exactly like a printed token is — that input
  channel is exactly as unsafe as the output channel this command is
  designed to protect.
- The output file (`~/.teamshare-new-team.json`) contains a live credential.
  Don't read it, don't `cat` it, don't summarize its contents — only report
  its path.
- If the user asks you to show them the token anyway, decline and explain
  why (transcripts are stored and can be replayed; this file is the one
  place the token is meant to live until they move it to a password
  manager).
