---
description: Repair or dev-configure this machine's teamshare credentials (not needed for a normal install)
argument-hint: "[server-url]"
---

# teamshare setup

**This is not part of a normal install.** `/plugin install teamshare` asks for
your personal token and stores it; the server address is built into the plugin.
Nothing else is required, and no file needs writing.

Two cases still need this command:

- **Development via `claude --plugin-dir`**, where there is no install step to
  prompt for a token, so `~/.teamshare.json` is the only way to supply one.
- **Pointing this machine at a different server**, which the plugin's own
  `.mcp.json` cannot do — see the caveat at the bottom before using it for
  that.

Reach for `/teamshare-status` first. It usually names the actual problem, and
most of what people used to run this command for is now a
`/plugin configure teamshare@teamshare` away.

## Steps

1. **Determine the values.**
   - The **token** is the user's personal token, starting with `tsm_`, sent to
     them by their lead. Ask for it if it is not already known. Never accept it
     as a command argument.
   - The **server URL** is optional and almost always wrong to set. Take it
     from `$ARGUMENTS` only if the user explicitly named one. Otherwise leave
     it out entirely and the plugin's own address is used.

2. **Verify before writing anything real.** Write the candidate config to a
   *temporary* file, `~/.teamshare.json.new` — never `~/.teamshare.json`
   itself yet — so a bad credential can never be left behind. Include `url`
   only if the user named one:

   ```json
   {
     "token": "tsm_..."
   }
   ```

   Then check it. This reads the token out of the file, so it never appears in
   a command Claude runs — which matters because that string shows up in the
   tool-call UI and stays in the transcript:

   ```bash
   node -e '
   const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
   const p=path.join(os.homedir(),".teamshare.json.new");
   const c=JSON.parse(fs.readFileSync(p,"utf8"));
   const base=String(c.url||process.env.TEAMSHARE_URL||"https://54.90.22.249.sslip.io").replace(/[/]+$/,"");
   fetch(base+"/unread",{headers:{Authorization:"Bearer "+c.token}})
     .then(r=>console.log("STATUS "+r.status))
     .catch(e=>console.log("UNREACHABLE "+e.message));
   '
   ```

   Branch on the output exactly:
   - `STATUS 200` — good. Move `~/.teamshare.json.new` to `~/.teamshare.json`.
   - `STATUS 401` — wrong token, or an admin token rather than a personal one.
     Delete the temp file, ask again, and do not promote it.
   - `UNREACHABLE ...` — nothing answered at all. Delete the temp file and
     report the address tried.
   - any other `STATUS <code>` — the server answered, just not as expected (a
     proxy, a 5xx, the wrong path). Don't call that "unreachable": delete the
     temp file and report the real code.

3. **Confirm** what will change and when: the session-start digest picks this
   up on the **next** session, and under `--plugin-dir` so does the MCP
   connection.

## The caveat about setting a URL here

`~/.teamshare.json`'s `url` overrides the digest and the bundled commands — but
it **cannot** change the plugin's MCP connection, which is compiled into
`.mcp.json`. Setting one therefore splits this machine in two: shares publish
to the plugin's server while the digest reads from yours, and neither says so.

If the goal is a self-hosted server, fork the repo, change that one line in
`packages/plugin/.mcp.json`, and install the plugin from your fork. Everything
follows automatically. Only set a `url` here if you know you want exactly the
split above.

## Rules

- Never print the token back, and never put it in a command Claude executes.
  It lives only in `~/.teamshare.json.new` or `~/.teamshare.json`.
- `~/.teamshare.json` is only ever created after a `STATUS 200`. The temp file
  is deleted on every other branch, so no half-verified config survives.
- If `~/.teamshare.json` already exists, show what it points at and confirm
  before overwriting.
