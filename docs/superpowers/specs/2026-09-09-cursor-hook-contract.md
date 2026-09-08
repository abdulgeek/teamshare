# Cursor hook contract — verified

**Date:** 2026-09-09
**Cursor.app version:** 3.19.10 (`/Applications/Cursor.app/Contents/Resources/app/package.json`)
**cursor-agent (headless CLI) version:** 2026.01.23-916f423 (`~/.local/bin/cursor-agent`)
**Verification method:** static trace of the shipped, deobfuscated-by-reading
`workbench.desktop.main.js` bundle — from hook invocation, through response
validation, through to where the field is actually read by the composer and
packed into the outgoing model request. **Not** a live GUI observation — see
§7 for why, and what's left for a human to do.

## 1. Bottom line

**Both `sessionStart` and `beforeSubmitPrompt` inject `additional_context`
into what the model sees, in Cursor 3.19.10.** This directly contradicts
Cursor's published docs (cursor.com/docs/hooks), which say `beforeSubmitPrompt`
cannot inject context.

This is not "a validator accepts the field" (the weak claim the brief warned
against). It is a traced call chain, in the actual chat-submission code path,
showing the value is read off the hook's response and physically appended to
the request sent to the model:

- `beforeSubmitPrompt`: `additional_context` is merged with another local
  instructions string, wrapped in `<system_reminder>…</system_reminder>`, and
  the result becomes part of `ol` — passed into the same request-building
  code that assembles the outgoing chat turn. A `continue:false` response
  also visibly blocks the submission with a shown `user_message`, so this
  code path definitely executes on real submissions, not just as dead
  validation.
- `sessionStart`: `additional_context` is stored as
  `composerHandle.data.hooksAdditionalContext`, which is read at
  request-build time and placed directly on the `requestContext` protobuf
  (`hooksAdditionalContext: g`) sent with the turn. Because this lives on the
  composer's persistent data, **it is not "first message only" — it rides
  along on every subsequent turn of that same chat** until something
  overwrites it. That's a materially different (stronger, and stickier)
  injection semantic than "sessionStart context only affects turn one," and
  downstream tasks should design for it.

Confidence: high for "does the code path exist and get executed on every
prompt submission." Not yet confirmed: an actual end-to-end run where a human
watched Cursor's chat answer the probe's marker word. See §7.

## 2. What we tried headlessly, and why it stopped short of a live run

Per the brief, `cursor-agent -p` was tried first, before anything interactive.

```
cursor-agent -p "say hi" --mode ask
→ Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.
```

This reproduced with and without `--resume <chatId>`, with `create-chat`
first, and with different `--mode` values. `cursor-agent status` /
`cursor-agent whoami` both report `Logged in (unable to fetch user details)`
— so the CLI's own status check and its `-p` execution path use **two
different auth mechanisms**, and only the first one is satisfied on this
machine. No `CURSOR_API_KEY` is set, and none was found in shell rc files.

**This is a distinct, prior blocker — not the "empty log file" case the brief
anticipated.** The brief says an empty probe log after a run is evidence the
CLI doesn't execute hooks. That's not what happened here: `cursor-agent -p`
never got far enough to attempt a turn at all, so the probe log staying empty
proves nothing about whether headless `cursor-agent` runs hooks. **That
question remains genuinely open**, not resolved either way.

We did not attempt `cursor-agent login` or set a fabricated `CURSOR_API_KEY`.
Both require an OAuth/credential step that needs the user's own action, and
per this task's own operating constraints that requires the user's explicit
say-so in chat, not a judgment call by the executing agent — especially for
an unattended verification task. We also did not drive the Cursor GUI app via
computer-use/UI automation to complete the live check ourselves: the brief is
explicit that "describe exactly what a human would need to do at the GUI" is
"a perfectly good outcome," which reads as asking for a human to run that
step, not for the agent to emulate one. Given a real, working probe
(the same `~/.cursor/hooks/probe.mjs`) can be dropped back in at zero cost
whenever someone wants to close the loop, we judged that safer than opening
someone's real, signed-in coding assistant and typing into it unsupervised.

## 3. Payload field names (verbatim, from the actual construction site)

Every hook invocation gets a set of generic fields added by
`executeHookForStep`, in `CursorHooksService`:

```js
u = {
  ...t,                                    // event-specific fields, below
  ...(l !== undefined && { session_id: l }),
  hook_event_name: e,
  cursor_version: this.productService.version,
  workspace_roots: this.workspaceContextService.getWorkspace().folders.map(x => x.uri.path),
  user_email: n,
  ...(!s && { transcript_path: a }),
  ...(e === cd.subagentStop && { agent_transcript_path: c ?? null }),
}
```

So every hook payload carries: `hook_event_name`, `cursor_version`,
`workspace_roots` (array of workspace folder paths), `user_email` (nullable),
and usually `session_id` and `transcript_path`.

**`sessionStart`**-specific fields (from the composer's session-init call site):

```
conversation_id, generation_id (""), model, ...modelHookFields,
is_background_agent, composer_mode
```

**`beforeSubmitPrompt`**-specific fields (from the composer's submit call site):

```
conversation_id, generation_id, model, ...modelHookFields,
composer_mode, prompt, attachments
```

`prompt` is the literal text the user just typed — confirming
`beforeSubmitPrompt` sees the outgoing message, consistent with a hook meant
to inspect/augment/block it.

## 4. Accepted response shape

From the shipped validators (`beforePromptSubmitResponse.ts`,
`sessionStartResponse.ts`):

```
beforePromptSubmitResponse:
  { continue?: boolean, user_message?: string, additional_context?: string }

sessionStartResponse:
  { env?: Record<string,string>, additional_context?: string,
    continue?: boolean, user_message?: string }
```

`continue: false` is a real, wired behavior on `beforeSubmitPrompt`, not just
schema-valid: the composer code shows it aborting the chat and rendering
`user_message` (or a default string) as the assistant's reply.

## 5. Bonus finding: Claude Code's hook response shape is accepted too — but not uniformly, and not unconditionally

**Corrected 2026-09-09 (fix round 1).** The original version of this section
overstated the scope of the compatibility layer on two points: which events
the *nested* Claude shape actually works for, and whether the
`hookEventName` check is skipped. Both are corrected below, with the exact
call chain.

There are **two separate response shapes** Cursor's normalizer will accept
for `additional_context`, read by two different functions, tried in this
order (`Lkf`, the merge step, calls `Mkf(t) ?? Pkf(e, t, i)`):

```js
function Mkf(e) { return typeof e.additionalContext == "string" ? e.additionalContext : void 0 }

function Pkf(e, t, n) {
  if (!Dzs(n)) return;               // Dzs = enableClaudeNestedHookSpecificOutputCompatibility flag
  const i = nmd[e];                  // nmd = Cursor-internal step -> Claude hookEventName string
  if (i === void 0) return;          // no Claude event maps to this Cursor step -> bail, unrecognized
  const r = Mzs(t);                  // Mzs = extract t.hookSpecificOutput (if it's an object)
  if (Pzs(r, i)) return typeof r.additionalContext == "string" ? r.additionalContext : void 0
}

function Pzs(e, t) {                 // the hookEventName check
  if (!e) return !1;
  const n = e.hookEventName;
  return n === void 0 || n === "" ? !0 : n === t
}
```

- **`Mkf` is the *flat* reader.** It reads a top-level, unnested,
  camelCase `additionalContext` field directly on the parsed hook response
  (`{"additionalContext": "..."}`). It does not look at `hookEventName` at
  all — there is no nested object here to check a name against.
- **`Pkf` is the *nested* reader** — the one that recognizes
  `packages/plugin/hooks/prompt-submit.mjs`'s actual output shape,
  `{"hookSpecificOutput": {"hookEventName": "...", "additionalContext": "..."}}`.
  It is gated on the compatibility flag (still hardcoded `true`, see below),
  **and it does check `hookEventName`**, via `Pzs` — permissively:
  - `hookEventName` absent or `""` → passes (no check performed).
  - `hookEventName` present and equal to the expected name for the current
    step → passes.
  - `hookEventName` present and *different* from the expected name → `Pzs`
    returns `false`, `Pkf` returns `undefined`, and the nested
    `additionalContext` is **silently dropped** — no error, no warning, the
    hook just behaves as if it returned no context at all. **This is the
    trap:** a hook author who ships a mismatched `hookEventName` (e.g. a
    stale value copied from a different step, or a typo) will not see any
    failure — the context simply never arrives, and it's easy to misdiagnose
    as an injection-mechanism problem rather than a name mismatch.

The gate for the nested path, `enableClaudeNestedHookSpecificOutputCompatibility`,
is still **hardcoded to `true`** in `validateParsedHookResponse` in this
build — that part of the original finding holds:

```js
validateParsedHookResponse(e, t) {
  return Imd(e, t, { enableClaudeNestedHookSpecificOutputCompatibility: true })
}
```

**Which events actually get the nested shape — corrected list.** `Pkf`'s
early-return on `nmd[e] === void 0` means the nested shape only works for
Cursor steps that have a corresponding entry in `nmd` (the table built by
inverting `u4i`, Cursor's Claude-event-name → internal-step map):

```js
u4i = {
  PreToolUse: cd.preToolUse, PermissionRequest: null,
  PostToolUse: cd.postToolUse, UserPromptSubmit: cd.beforeSubmitPrompt,
  Stop: cd.stop, SubagentStop: cd.subagentStop,
  SessionStart: cd.sessionStart, SessionEnd: cd.sessionEnd,
  PreCompact: cd.preCompact, Notification: null
}
nmd = Object.fromEntries(Object.entries(u4i).filter(e => e[1] !== null).map(([e, t]) => [t, e]))
```

**`u4i` has no `PostToolUseFailure` entry at all** — Claude Code has no such
event, so there is nothing to map it from. Intersecting `nmd`'s keys with
`d4i` (the set of five steps that support `additional_context` merging —
`sessionStart`, `beforeSubmitPrompt`, `preToolUse`, `postToolUse`,
`postToolUseFailure`), the **nested `hookSpecificOutput.additionalContext`
shape is recognized only for `sessionStart`, `beforeSubmitPrompt`,
`preToolUse`, and `postToolUse`. It is NOT recognized for
`postToolUseFailure`** — `Pkf(cd.postToolUseFailure, ...)` hits
`nmd[e] === void 0` and returns `undefined` before ever inspecting
`hookSpecificOutput` or `hookEventName`.

`postToolUseFailure` is still in `d4i`, so `Lkf` still tries `Mkf(t)` for
it — meaning a hook responding to `postToolUseFailure` **can** inject
`additional_context`, but only via the **flat, unnested**
`{"additionalContext": "..."}` shape, never via
`hookSpecificOutput.additionalContext`. A `postToolUseFailure` hook that
emits Claude Code's usual nested envelope will have it silently ignored,
same failure mode as the `hookEventName` mismatch above.

**Net effect, corrected:** a hook script that already speaks Claude Code's
nested `hookSpecificOutput.additionalContext` shape, with a correct (or
omitted) `hookEventName`, will have that value picked up as-is by Cursor's
`sessionStart`, `beforeSubmitPrompt`, `preToolUse`, and `postToolUse`
handlers — no format translation needed. **`postToolUseFailure` is the one
exception**: it must use the flat `additionalContext` shape instead. Worth
reusing the nested shape for Task 3's four supported events rather than
hand-rolling a second Cursor-flavored response shape, but Task 3 should
**not** build a `postToolUseFailure` integration assuming the nested shape
works there, and should be deliberate about setting (or omitting, never
guessing) `hookEventName` on every nested response it does emit.

## 6. cwd and other operational semantics

**cwd resolution (`_getHookCwd`)**, confirmed against the actual config-URI
construction:

- User-level: `this.configUri = joinPath(userHome, ".cursor", "hooks.json")`,
  and the default branch of `_getHookCwd` returns `dirname(configUri)`. That
  resolves to **`~/.cursor`**, exactly as the controller ruling for this task
  states, and exactly why the probe had to live at
  `~/.cursor/hooks/probe.mjs` for `node ./hooks/probe.mjs` to resolve.
- Project-level (`project` / `claude-project` / `claude-project-local`
  sources): cwd is the config path with `../..` resolved against it via
  Node-style path segments (not URL semantics) — i.e. pop `hooks.json`, pop
  `.cursor`, landing on the **project root**, assuming the standard
  `<project>/.cursor/hooks.json` layout.
- `claude-plugin` source: plugin install path, except `stop`/`subagentStop`
  which use the first workspace folder.

**Environment variables** set on the hook's process:
`CURSOR_PROJECT_DIR`, `CURSOR_VERSION`, `CLAUDE_PROJECT_DIR` (mirrors
`CURSOR_PROJECT_DIR`), plus conditionally `CURSOR_CODE_REMOTE`,
`CURSOR_USER_EMAIL`, `CURSOR_TRANSCRIPT_PATH`, and for `claude-plugin` source
`CURSOR_PLUGIN_ROOT` / `CLAUDE_PLUGIN_ROOT`.

**Transport:** on non-Windows, the payload is JSON on **stdin** and the
response must be JSON on **stdout** (matches the brief's probe design
exactly). On Windows, the payload goes through a temp file instead
(`"windows_temp_file"` mode) — irrelevant on this Mac, but worth remembering
if Task 3 targets Windows too.

**Exit-code behavior**, from `_executeCommandHookScript`:

| exit code | meaning |
|---|---|
| `0` | success — stdout is parsed as JSON and (if schema-valid) applied |
| `2` | **blocked** — stdout/stderr text becomes the block reason |
| `124` | timed out (default timeout 60s, overridable per-hook via `timeout`) |
| any other non-zero (or no output, or invalid JSON) | treated as a soft failure — ignored **unless** the hook config sets `failClosed: true`, in which case a synthetic blocking response is generated |

**Response-size limits** on `additional_context`: inlined up to 10,000 chars
(`<system_reminder>` wrapper); above that and up to 1,000,000 chars it's
"spilled" to a writer if one is configured for that call site (only wired up
for `beforeSubmitPrompt` in the code we found); above 1,000,000 chars it's
dropped outright with a logged warning.

## 7. Live verification — not completed, and exactly what a human should do

We could not get a live, model-observed confirmation in this pass, because:

1. `cursor-agent -p` requires a separate auth mechanism (`CURSOR_API_KEY` or
   `cursor-agent login`) that isn't configured on this machine, and setting
   it up needs the user's own action (see §2).
2. It remains **unknown whether `cursor-agent` (even once authenticated) runs
   the same hook pipeline as the GUI app** — the code traced above lives in
   `workbench.desktop.main.js`, which is the Electron/GUI bundle. The
   headless CLI ships as a separate binary
   (`~/.local/share/cursor-agent/versions/.../index.js`) and we did not trace
   whether it shares this hook service or has none at all. This caveat from
   the brief is **still open**, independent of the auth blocker.
3. We deliberately did not automate the GUI app ourselves (see §2's
   reasoning).

**What a human should do** (5 minutes, exactly Step 3–4 of the task brief):

```bash
mkdir -p ~/.cursor/hooks
cp ~/.cursor/hooks.json ~/.cursor/hooks.json.bak 2>/dev/null || true  # back up if present
cat > ~/.cursor/hooks/probe.mjs <<'EOF'
#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
let raw = '';
for await (const c of process.stdin) raw += c;
appendFileSync(process.env.PROBE_LOG || '/tmp/cursor-probe.log', raw + '\n---\n');
let event = '';
try { event = JSON.parse(raw).hook_event_name || ''; } catch {}
process.stdout.write(JSON.stringify({
  additional_context: `TEAMSHARE_PROBE_MARKER_7Q2X fired on ${event}`,
}));
process.exit(0);
EOF
cat > ~/.cursor/hooks.json <<'EOF'
{
  "version": 1,
  "hooks": {
    "sessionStart": [{ "command": "node ./hooks/probe.mjs" }],
    "beforeSubmitPrompt": [{ "command": "node ./hooks/probe.mjs" }]
  }
}
EOF
```

Then, in the Cursor GUI: open a **new chat**, ask
`What is the marker word in your context? Reply with only that word.`, note
the answer, send a **second** message with the same question, note that
answer too. Then:

```bash
cat /tmp/cursor-probe.log   # inspect hook_event_name per invocation and the exact fields present
rm -f ~/.cursor/hooks.json ~/.cursor/hooks/probe.mjs /tmp/cursor-probe.log
mv ~/.cursor/hooks.json.bak ~/.cursor/hooks.json 2>/dev/null || true
```

**Interpretation caveat** (this is new, and matters): because §1 shows
`sessionStart`'s `additional_context` sticks to the composer for the whole
chat rather than firing once, **both messages should echo the marker if both
events inject** — the second message answering correctly does not, by
itself, distinguish "`beforeSubmitPrompt` injects" from "`sessionStart`'s
context is still attached." The reliable signal is `/tmp/cursor-probe.log`:
count the entries and check each one's `hook_event_name`. Two entries with
`hook_event_name: "sessionStart"` and `"beforeSubmitPrompt"` on message 1,
and one more `"beforeSubmitPrompt"` entry on message 2, is what both-inject
looks like operationally.

## 8. Where this contradicts Cursor's published docs

cursor.com/docs/hooks states that `beforeSubmitPrompt` cannot inject text
into the model's context — that a hook at this step can only observe or
block, not augment. The shipped 3.19.10 composer code contradicts this
directly: `beforeSubmitPrompt`'s `additional_context` is read, wrapped in a
`<system_reminder>` block, and included in the outgoing request. This is not
an edge case or a soon-to-be-removed internal API — it sits directly in the
mainline "submit a chat message" code path, guarded by nothing more than
"does a hook exist for this step."

The likely reason claude-mem (and, per the brief, the published docs)
concluded otherwise: they tested against the documented contract rather than
the shipped one, or against an older Cursor version where this path may not
have existed. This spec should be re-checked against future Cursor versions
before being relied on indefinitely — the version pin at the top of this
document is load-bearing.

## 9. Gate decision for Task 3

Per the brief's gate: since both `sessionStart` and `beforeSubmitPrompt` show
strong (traced, not merely validated) evidence of injecting, **Task 3 should
proceed on the assumption both work**, rather than falling back to the
`.cursor/rules/*.mdc` approach. That fallback should be kept as a documented
Plan B, not exercised — the static evidence here is unusually strong (a full
call-chain trace to the outgoing request, not "a validator accepts the
field"), but it has not been confirmed by an actual human-observed run (§7).
Task 3 should budget five minutes for someone to run the §7 check before
declaring parity in the README, and should account for the §1 stickiness
finding (`sessionStart` context persists across the whole chat) when
designing how often to refresh injected content.

## 10. Machine state

`~/.cursor/hooks.json` and `~/.cursor/hooks/probe.mjs` were created for this
verification and removed afterward. No pre-existing `~/.cursor/hooks.json`
was found, so there was nothing to back up or restore. `/tmp/cursor-probe.log`
was never created because `cursor-agent -p` failed at authentication before
any hook could run. `cursor-agent create-chat` created one empty, unnamed
chat session server-side (referenced only by a UUID, never sent a message) as
a side effect of probing the CLI's auth behavior; it holds no content and we
did not find a non-interactive way to delete it (`cursor-agent ls` requires a
TTY).

## Codex

**Date:** 2026-09-09
**Binary:** `codex-cli 0.148.0-alpha.9`, found at
`~/.codex/plugins/.plugin-appserver/codex` (installed as the engine behind a
"ChatGPT" desktop app's Codex plugin runtime on this machine) and again,
identically versioned, bundled as a Cursor extension
(`~/.cursor/extensions/openai.chatgpt-*/bin/macos-aarch64/codex`, running live
as `codex app-server` under Cursor's own process tree). No standalone `codex`
on PATH; `~/.codex/config.toml` has no `hooks` section, confirming the
brief's own `grep -i hook` finding — but that finding was about config.toml,
not about whether Codex has a hook system.
**Verification method:** binary inspection (`codex features list`, `codex
plugin --help`, `strings` over the executable for its embedded serde
struct/field names) followed by a **live, model-call-free run**: a real
`codex exec` invocation, in an isolated `CODEX_HOME`, with a hand-written
`hooks.json` and an intentionally-invalid `OPENAI_API_KEY` so the run reaches
the hook-execution stage and fails at authentication afterward, at zero API
cost. This follows the same "verify hands-on, don't trust the claim" standard
Task 1 used on Cursor.

### 1. Bottom line

**Codex has a first-class, actively-maintained native hook system —
`features list` reports `hooks  stable  true` — and it is not "Cursor with
different event names." It is a near-verbatim reimplementation of Claude
Code's own hook contract**: the same event names, the same input payload
shape, and the same nested `hookSpecificOutput.additionalContext` response
envelope for injecting context. Cursor's flat `additional_context` field —
which claude-mem's `codex-hooks.json` and this task's own brief both assumed
Codex would share — is specifically a Cursor accommodation; nothing in
Codex's schema resembles it.

This reverses the working assumption already baked into
`packages/plugin/hooks/hosts.mjs` before this task (a comment there read
"Cursor and Codex both take additional_context"). That comment was never
verified against Codex; it was inherited from Cursor's shape on the
assumption that "similar event names" implied "similar response shape." It
did not. This spec and the `hosts.mjs` code have both been corrected.

### 2. Evidence Codex's plugin system is Claude Code's, not merely similar to it

Before finding Codex's *own* hooks, this machine's `~/.codex/plugins/cache/`
turned up cached copies of real Claude Code plugins —
`claude-plugins-official/superpowers`, `claude-plugins-official/
security-guidance`, `understand-anything` — each with the standard
`.claude-plugin/plugin.json` manifest and a `hooks/hooks.json` in Claude
Code's own PascalCase format (`{"hooks": {"SessionStart": [{"matcher": ...,
"hooks": [{"type": "command", "command": "...${CLAUDE_PLUGIN_ROOT}..."}]}]}}`).
Codex's plugin runtime sets `CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DATA`
alongside its own `PLUGIN_ROOT` / `PLUGIN_DATA` (both strings sit adjacent in
the binary's embedded config-source labels) specifically so plugins authored
for Claude Code run unmodified inside Codex's marketplace. This was the first
signal that "Codex's hook contract" and "Claude Code's hook contract" might
not be two things — they might be one thing wearing two names. The live test
in §4 confirms it for Codex's *own*, non-plugin-scoped hooks.json too.

### 3. Config location and event names

`codex features list` (a subcommand of the real binary, not documentation)
reports:

```
hooks   stable   true
```

`strings` over the binary surfaces its embedded serde schema directly —
struct names `SessionStartHookSpecificOutputWire`,
`UserPromptSubmitHookSpecificOutputWire`, `PreToolUseHookSpecificOutputWire`,
`PostToolUseHookSpecificOutputWire`, `PermissionRequestHookSpecificOutputWire`,
`SubagentStartHookSpecificOutputWire`, and a `HookEventNameWire` enum whose
variants are exactly `PreToolUse, PermissionRequest, PostToolUse, PreCompact,
PostCompact, SessionStart, UserPromptSubmit, SubagentStart, SubagentStop,
Stop, SessionEnd` — a superset of Claude Code's five hook events, using
Claude Code's own PascalCase names verbatim, not Cursor's camelCase
(`sessionStart`, `beforeSubmitPrompt`).

The binary's config-source labels (from `codex_config::loader::layer_io`, its
config-layering module) list `hooks.json` as a named layer alongside
`config.toml` and `managed_config.toml`, and a `source` enum for where a
given hook came from includes `user`, `project`, `plugin`, `mdm`, and
others — i.e. hooks.json is a real, user-scoped config layer, not only a
plugin-manifest convention.

**Confirmed live:** the correct path is `$CODEX_HOME/hooks.json`
(`~/.codex/hooks.json` by default), sibling to `config.toml`. A hooks.json
written there in exactly this shape was picked up and executed by a real
`codex exec` with no other configuration:

```json
{
  "hooks": {
    "SessionStart": [ { "hooks": [ { "type": "command", "command": "..." } ] } ],
    "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": "..." } ] } ]
  }
}
```

This is the same "matcher group containing a `hooks` array of `{type,
command}` entries" shape real Claude Code plugins already ship — not a
simpler flat shape invented for this task. No `matcher` key was supplied and
both hooks still ran on every occurrence of their event, so omitting it means
"run unconditionally," same as its absence would mean in Claude Code.

### 4. The live test

Setup: an isolated `CODEX_HOME` (so nothing on this machine's real Codex
config was touched), a `config.toml` with `model_provider = "openai"` and
`approval_policy = "never"`, the `hooks.json` above pointing both events at a
small Node script that appends its stdin to a probe file and replies with
`{"hookSpecificOutput": {"hookEventName": "<event>", "additionalContext":
"TEAMSHARE_PROBE_MARKER_CODEX_9K3"}}`, and `OPENAI_API_KEY` set to an
obviously invalid string. Run:

```
codex exec --skip-git-repo-check --dangerously-bypass-hook-trust --ephemeral \
  -C <isolated workspace> "hi"
```

(`--dangerously-bypass-hook-trust` is itself evidence hooks are a real,
actively-enforced feature: Codex normally requires a persisted trust decision
before running an enabled hook, exactly like Claude Code's own hook-approval
prompt.)

Result — the run's own stderr, unprompted:

```
hook: SessionStart
hook: SessionStart Completed
hook: UserPromptSubmit
hook: UserPromptSubmit Completed
```

...followed by the *expected* failure: repeated `401 Unauthorized` against
`api.openai.com`, from the deliberately-invalid key — proving no real model
call, and no cost, was needed to get this result. The probe file received
the real stdin payloads:

```json
{"session_id":"...","transcript_path":null,"cwd":"...","hook_event_name":"SessionStart","model":"gpt-5.6-sol","permission_mode":"bypassPermissions","source":"startup"}
```
```json
{"session_id":"...","turn_id":"...","transcript_path":null,"cwd":"...","hook_event_name":"UserPromptSubmit","model":"gpt-5.6-sol","permission_mode":"bypassPermissions","prompt":"hi"}
```

Both fields and values are immediately recognizable from Claude Code's own
hook payload: `session_id`, `transcript_path`, `cwd`, `hook_event_name`
(carrying the PascalCase event name as its *string value*, exactly as Claude
Code does), and — for `SessionStart` — a `source` field whose observed value,
`"startup"`, is one of the values `packages/plugin/hooks/session-start.mjs`
already gates on for Claude Code. No error or warning followed the hooks'
nested `hookSpecificOutput.additionalContext` responses ("Completed" both
times), which is the closest zero-cost confirmation available that Codex's
deserializer accepted the shape rather than silently discarding it. A
bare-stdout SessionStart response (Claude Code's other accepted shape) was
never tried, so this task does not claim it also works — only that the
tried, nested shape does.

### 5. What this changes from the brief's assumption

The brief framed this task's central question as "Codex's hook events are
named like Claude Code's... Whether Codex accepts Claude Code's *response*
shape is unverified, and that is the whole question," while separately
assuming (for scoping purposes) that the answer would look like Cursor's —
"differing only in config path, event names, and TEAMSHARE_HOST=codex." The
live test answers the actual question directly: **yes, Codex accepts Claude
Code's response shape** — because it *is* Claude Code's response-parsing
code, not a lookalike. Three concrete consequences for the implementation:

- `packages/plugin/hooks/hosts.mjs`'s `renderResponse` now branches on
  `host === 'codex'` separately from Cursor, emitting
  `{hookSpecificOutput: {hookEventName, additionalContext}}` for both events
  (SessionStart included — unlike Claude Code, which takes bare stdout for
  SessionStart but was never confirmed to accept that from Codex, so the one
  shape actually watched working is used for both).
- `packages/plugin/hooks/session-start.mjs`'s re-ask protection
  (`ALLOWED_SOURCES`), previously gated on `host === 'claude-code'` only, now
  also applies to `host === 'codex'` — its SessionStart payload carries the
  same `source` field with at least the same `"startup"` value.
- `installHooksFor` in `teamshare-connect.mjs` (the middle Cursor's installer
  was factored into) parameterizes the hooks.json *entry* shape, not only the
  config path and event names — Cursor's entries are flat `{command}`;
  Codex's are Claude-Code-shaped matcher groups. The brief's "differing only
  in config path, event names, and TEAMSHARE_HOST" undersold this by one
  axis.

### 6. Gate decision for Task 4

Codex has a real, stable, actively-enforced hook system whose response
contract for context injection is confirmed working end to end on this
machine. **Task 4 proceeds**: `installCodexHooks` is implemented, wired into
`runConnect` alongside `installCursorHooks`, and both now share the
`installHooksFor` middle the brief asked for. This is not the "no hook
system, drop the task" branch the brief allowed for — that branch was ruled
out by direct evidence, not assumed absent from `config.toml`'s silence
alone.

### 7. Machine state

The isolated `CODEX_HOME` and workspace used for the live test lived entirely
under this session's scratch directory and were never pointed at this
machine's real `~/.codex`; nothing under the real `~/.codex` was read,
written, or backed up during verification. The one `codex exec` process that
hung during setup (a stdin-handling artifact of running under a piped
harness, unrelated to hooks — fixed by redirecting stdin from `/dev/null`)
was killed manually; it made no network request beyond the deliberately
invalid, immediately-rejected auth attempts described in §4.
