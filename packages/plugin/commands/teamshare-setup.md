---
description: Repair or dev-configure this machine's teamshare identity (not needed for a normal install)
argument-hint: "[server-url] [team-token]"
---

# teamshare setup

**This is not part of a normal install.** Running `/plugin install teamshare`
already prompts for the server URL and team token and stores them for you —
the MCP connection and the session-start digest both pick those up
automatically, with no file and no command required.

Use this command only for two cases:

- **Development via `claude --plugin-dir`**, where there is no plugin install
  step to prompt you, so `~/.teamshare.json` is the only way to supply
  config.
- **Repairing a machine** whose stored values are wrong — e.g. the digest
  reports "server rejected this machine" and re-running `/plugin configure
  teamshare` isn't available or didn't fix it.

In either case, this command connects the machine by writing
`~/.teamshare.json`, which both `headers.sh` and the session-start hook treat
as a fallback whenever `CLAUDE_PLUGIN_OPTION_*` env vars aren't present.

## Steps

1. Determine the **server URL** and **team token**:
   - If the user passed them as arguments, use those: split `$ARGUMENTS` on
     whitespace, the first token is the URL and the second is the token. If
     only one token is present, treat it as the URL. If there are none, ask
     for both.
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

3. Verify the server accepts these credentials before the real config file
   ever exists. The token must never appear in a command Claude runs — not
   even inside a `curl -H` argument — because that string shows up in the
   tool-call UI and stays in the session transcript. So write the candidate
   config first, to a **temporary** file, `~/.teamshare.json.new` — not
   `~/.teamshare.json` itself yet — with exactly these four keys, the email
   lowercased and the URL with no trailing slash:

   ```json
   {
     "url": "http://localhost:8787",
     "token": "ts_...",
     "name": "Adnan",
     "email": "adnan@team.com"
   }
   ```

   Then verify by running this Node one-liner. It reads the token out of the
   temp file itself and only ever prints a status word — the token itself
   never appears on the command line:

   ```bash
   node -e '
   const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
   const p=path.join(os.homedir(),".teamshare.json.new");
   const c=JSON.parse(fs.readFileSync(p,"utf8"));
   const base=String(c.url).replace(/[/]+$/,"");
   fetch(base+"/unread",{headers:{Authorization:"Bearer "+c.token,"X-Teamshare-Email":String(c.email).trim().toLowerCase(),"X-Teamshare-Name":String(c.name).trim()}})
     .then(r=>{console.log("STATUS "+r.status);})
     .catch(e=>{console.log("UNREACHABLE "+e.message);});
   '
   ```

   Read the output and branch on it exactly:
   - `STATUS 200` → good. Promote the file: move `~/.teamshare.json.new` to
     `~/.teamshare.json`, then continue to the confirmation step.
   - `STATUS 401` → the token is wrong. Delete `~/.teamshare.json.new`, ask
     for the token again, and do not promote.
   - `STATUS 400` → identity headers are malformed. Delete
     `~/.teamshare.json.new` and re-check the git identity.
   - `UNREACHABLE ...` → a genuine network failure — nothing answered at all.
     Delete `~/.teamshare.json.new` and report the URL tried.
   - any other `STATUS <code>` → the server is there and answered, just not
     the way expected — the wrong URL path, a proxy in front of it, a 5xx.
     Don't call this "unreachable": delete `~/.teamshare.json.new` and report
     the actual code to the user.

4. Confirm to the user: the URL, the identity that will appear on their
   shares, and that both the session-start digest and (for a `--plugin-dir`
   dev setup) the MCP connection pick this up on the **next** session.

## Rules

- Never print the token back to the user or into the transcript — that
  includes never putting it into a command Claude executes; it may only ever
  live inside `~/.teamshare.json.new` or `~/.teamshare.json`.
- `~/.teamshare.json.new` may be written before verification — it's disposable
  scratch. But `~/.teamshare.json` itself is only ever created or overwritten
  after a `STATUS 200`, and `~/.teamshare.json.new` is always deleted on every
  other branch, so no half-verified config is ever left behind.
- If `~/.teamshare.json` already exists, show the current URL and identity and
  confirm before overwriting.
