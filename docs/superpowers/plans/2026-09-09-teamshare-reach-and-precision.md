# teamshare: reach and precision — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Cursor and Codex the same session-start digest and mid-session nudge Claude Code already has, then make shares precise enough to stay worth reading — scoped to a repo, or addressed to one person.

**Architecture:** The two hooks stop being Claude-Code-shaped. A host adapter normalises the incoming payload and renders the outgoing response per host, so one implementation serves all three. `teamshare-connect` grows the ability to install those hooks for Cursor and Codex, writing `~/.teamshare.json` as the credential source the hooks already know how to read. On the server, two schema steps add an optional repo scope and an optional recipient list to a share; both narrow `getUnread` and neither changes what an existing client sees.

**Tech Stack:** Node 20 ESM (no build step in `packages/plugin`), TypeScript + `better-sqlite3` v12 + Express 5 in `packages/server`, vitest throughout, MCP over Streamable HTTP.

**Spec:** No separate spec document. This plan is the spec; the design decisions and their reasoning are stated inline per task. Team memory — the fourth item discussed — is deliberately **out of scope** and needs its own design doc first (see "Out of scope" below).

## Global Constraints

- Node **>= 20**. `better-sqlite3` pinned to `^12.11.1` — v13 segfaults on Node 20.
- `packages/plugin` has **no build step**. Everything under `hooks/` and `bin/` runs as written.
- `packages/server/src/teamshare-connect.mjs` and `teamshare-team.mjs` must each stay a **single dependency-free file** with no relative imports — they are curl-and-run. Copies in `packages/plugin/bin/` are byte-identical, synced by `node scripts/sync-plugin-bin.mjs`, drift-guarded by `packages/plugin/tests/bin-sync.test.mjs`.
- Schema migrations are **versioned and transactional**, triggered on `schema_version` and never on table existence. Current version is **4**. Never edit the frozen v1 `SCHEMA` constant.
- Every query touching shares/receipts/members filters on `team_id` on **every leg**. Cross-team isolation must not regress.
- Teammate-authored text is **untrusted**: always inside the unpredictable per-render fence (`wrapUntrusted` / the hooks' equivalent), never presented as instructions.
- Hooks **fail silently and exit 0**. A teamshare outage must be invisible from inside a session.
- Credentials never appear in argv or in a command line. Files holding them are `0600`.
- Dates render as `formatDay` output (`Tuesday, 08-09-2026`), never ISO instants, on every reader-facing surface.
- `packages/server` runs tests with `fileParallelism: false` — do not re-enable it.
- Bump `version` in all three of `packages/plugin/.claude-plugin/plugin.json`, `packages/plugin/package.json`, `.claude-plugin/marketplace.json` together, and never downwards.

## Out of scope

**Team memory** (durable facts every assistant knows, as opposed to time-bound shares) is a separate subsystem: different lifetime, different injection budget, a personal-vs-team privacy boundary, and its own retrieval story. It gets `docs/superpowers/specs/2026-09-XX-teamshare-memory-design.md` and its own plan after this one lands.

---

### Task 1: Prove Cursor actually honours injected context

Everything downstream assumes Cursor can inject text into the model's context from a hook. Two sources disagree about whether it can: Cursor's published docs say `beforeSubmitPrompt` "cannot inject text into model context", while the validator shipped inside Cursor 3.19.10 accepts an `additional_context` string on both `beforePromptSubmitResponse` and `sessionStartResponse`. claude-mem works around the documented limitation by writing a `.cursor/rules/*.mdc` file instead.

A validator accepting a field is not proof the field is used. This task settles it by observation before any code is built on it.

**Files:**
- Create: `/private/tmp/claude-501/.../scratchpad/cursor-probe/hooks/probe.mjs` (throwaway, not committed)
- Create: `~/.cursor/hooks.json` (temporary; back up and restore any existing file)
- Create: `docs/superpowers/specs/2026-09-09-cursor-hook-contract.md` (the recorded finding)

**Interfaces:**
- Produces: a documented, verified answer to "which Cursor hook events can inject context, and in what shape", consumed by Tasks 2–4.

- [ ] **Step 1: Back up any existing Cursor hooks config**

```bash
[ -f ~/.cursor/hooks.json ] && cp ~/.cursor/hooks.json ~/.cursor/hooks.json.teamshare-probe-backup || echo "no existing hooks.json"
```

- [ ] **Step 2: Write the probe hook**

It records every payload it is handed and returns a marker in `additional_context`. Writing the payload to a file is what tells us the field names Cursor really sends.

```javascript
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
```

- [ ] **Step 3: Point Cursor at it**

User-level hooks run with cwd `~/.cursor/`, so the command path is relative to that.

```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [{ "command": "node ./hooks/probe.mjs" }],
    "beforeSubmitPrompt": [{ "command": "node ./hooks/probe.mjs" }]
  }
}
```

- [ ] **Step 4: Observe a real Cursor session**

Open Cursor, start a new chat, and ask: `What is the marker word in your context? Reply with only that word.` Then send a second message and ask again.

Record three things: whether the marker came back on the **first** message (proves `sessionStart` injection), whether it came back on the **second** (proves `beforeSubmitPrompt` injection), and the exact payload JSON the probe logged for each event.

- [ ] **Step 5: Write down what was observed**

Create `docs/superpowers/specs/2026-09-09-cursor-hook-contract.md` recording: Cursor version, which events injected, the verbatim payload field names for each (`conversation_id`, `workspace_roots`, `prompt`, …), the response shape accepted, cwd semantics for user vs project hooks, and exit-code behaviour. State plainly where this contradicts Cursor's published docs — the next person will otherwise trust the docs and be wrong.

- [ ] **Step 6: Restore the machine**

```bash
rm -f ~/.cursor/hooks.json ~/.cursor/hooks/probe.mjs /tmp/cursor-probe.log
[ -f ~/.cursor/hooks.json.teamshare-probe-backup ] && mv ~/.cursor/hooks.json.teamshare-probe-backup ~/.cursor/hooks.json || true
```

- [ ] **Step 7: Commit the finding**

```bash
git add docs/superpowers/specs/2026-09-09-cursor-hook-contract.md
git commit -m "docs: record the verified Cursor hook injection contract"
```

**Gate:** If `beforeSubmitPrompt` does **not** inject, Task 3 ships Cursor with the session-start digest only, and the README says so rather than claiming parity. If `sessionStart` does not inject either, fall back to claude-mem's approach — writing `.cursor/rules/teamshare.mdc` with `alwaysApply: true` — and note the staleness cost: a rules file is only as fresh as the last hook run.

---

### Task 2: A host-neutral hook core

`session-start.mjs` and `prompt-submit.mjs` both read Claude Code's payload shape (`source`, `session_id`) and write Claude Code's response shape (bare stdout; `hookSpecificOutput.additionalContext`). Cursor and Codex differ in both directions. Rather than fork the files per host, the payload and the response become the only host-specific parts.

**Files:**
- Create: `packages/plugin/hooks/hosts.mjs`
- Create: `packages/plugin/hooks/hosts.test.mjs`
- Modify: `packages/plugin/hooks/session-start.mjs`
- Modify: `packages/plugin/hooks/prompt-submit.mjs`

**Interfaces:**
- Consumes: `loadConfig`, `neutralizeFences`, `fetchUnread` from `hooks/shared.mjs` (unchanged).
- Produces:
  - `detectHost(payload, env) -> 'claude-code' | 'cursor' | 'codex'`
  - `normalizePayload(payload, host) -> { sessionId: string, event: string, cwd: string | undefined }`
  - `renderResponse({ host, context, userMessage }) -> string` (the exact bytes to write to stdout; `''` means write nothing)

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, it, expect } from 'vitest';
import { detectHost, normalizePayload, renderResponse } from './hosts.mjs';

describe('detectHost', () => {
  it('reads Claude Code from its own payload', () => {
    expect(detectHost({ hook_event_name: 'SessionStart', source: 'startup' }, {})).toBe('claude-code');
  });

  it('reads Cursor from its camelCase event names', () => {
    expect(detectHost({ hook_event_name: 'sessionStart', conversation_id: 'c1' }, {})).toBe('cursor');
    expect(detectHost({ hook_event_name: 'beforeSubmitPrompt' }, {})).toBe('cursor');
  });

  it('trusts an explicit override over inference', () => {
    // The connector writes hooks with TEAMSHARE_HOST set, so a host whose
    // payload we have never seen still renders correctly rather than
    // silently falling back to Claude Code's shape.
    expect(detectHost({ hook_event_name: 'sessionStart' }, { TEAMSHARE_HOST: 'codex' })).toBe('codex');
  });
});

describe('normalizePayload', () => {
  it('finds the session id under each host\'s own name', () => {
    expect(normalizePayload({ session_id: 's1' }, 'claude-code').sessionId).toBe('s1');
    expect(normalizePayload({ conversation_id: 'c1' }, 'cursor').sessionId).toBe('c1');
  });

  it('falls back to a stable placeholder rather than undefined', () => {
    // sessionId keys the poll state. `undefined` there would make every
    // prompt look like a new session and re-seed forever.
    expect(normalizePayload({}, 'cursor').sessionId).toBe('unknown');
  });

  it('takes cwd from workspace_roots on Cursor', () => {
    expect(normalizePayload({ workspace_roots: ['/repo/a', '/repo/b'] }, 'cursor').cwd).toBe('/repo/a');
  });
});

describe('renderResponse', () => {
  it('writes bare text for a Claude Code session start', () => {
    expect(renderResponse({ host: 'claude-code', event: 'session-start', context: 'HELLO' })).toBe('HELLO\n');
  });

  it('wraps a Claude Code prompt-submit in hookSpecificOutput', () => {
    const out = JSON.parse(renderResponse({
      host: 'claude-code', event: 'prompt-submit', context: 'HELLO', userMessage: 'note',
    }));
    expect(out.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(out.hookSpecificOutput.additionalContext).toBe('HELLO');
    expect(out.systemMessage).toBe('note');
  });

  it('uses additional_context for Cursor, on both events', () => {
    for (const event of ['session-start', 'prompt-submit']) {
      const out = JSON.parse(renderResponse({ host: 'cursor', event, context: 'HELLO' }));
      expect(out.additional_context).toBe('HELLO');
      // Cursor has no systemMessage channel; a stray field must not appear.
      expect(out.systemMessage).toBeUndefined();
    }
  });

  it('writes nothing at all when there is nothing to say', () => {
    expect(renderResponse({ host: 'cursor', event: 'session-start', context: '' })).toBe('');
    expect(renderResponse({ host: 'claude-code', event: 'session-start', context: '' })).toBe('');
  });

  it('renders the token-rejected notice as valid output on every host', () => {
    // The 401 branch of session-start.mjs used to write a bare line. That is
    // fine on Claude Code and malformed JSON on Cursor — the hook would break
    // exactly when it had something important to say.
    const notice = 'teamshare: server rejected this machine — reconfigure via /plugin';
    expect(renderResponse({ host: 'claude-code', event: 'session-start', context: notice })).toBe(`${notice}\n`);
    expect(JSON.parse(renderResponse({ host: 'cursor', event: 'session-start', context: notice })))
      .toEqual({ additional_context: notice });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/plugin && npx vitest run hooks/hosts.test.mjs`
Expected: FAIL — `Failed to resolve import "./hosts.mjs"`.

- [ ] **Step 3: Write `hooks/hosts.mjs`**

```javascript
// The only host-specific parts of a teamshare hook: what the payload is
// called, and what shape the response takes.
//
// Verified per host rather than assumed — see
// docs/superpowers/specs/2026-09-09-cursor-hook-contract.md. Cursor's own
// published docs say beforeSubmitPrompt cannot inject context; the validator
// shipped in Cursor 3.19.10 says otherwise, and the probe in Task 1 settles
// which is true.

const CURSOR_EVENTS = new Set([
  'sessionStart', 'beforeSubmitPrompt', 'stop', 'postToolUse', 'afterFileEdit',
]);

export function detectHost(payload = {}, env = {}) {
  // An explicit override always wins: the connector sets it, so a host we
  // have never seen renders correctly instead of silently getting Claude
  // Code's shape and injecting nothing.
  const forced = String(env.TEAMSHARE_HOST || '').trim();
  if (forced) return forced;
  const event = String(payload.hook_event_name || '');
  if (CURSOR_EVENTS.has(event)) return 'cursor';
  return 'claude-code';
}

export function normalizePayload(payload = {}, host = 'claude-code') {
  const sessionId =
    (host === 'cursor' ? payload.conversation_id : payload.session_id) ||
    payload.session_id ||
    payload.conversation_id ||
    'unknown';
  const cwd = Array.isArray(payload.workspace_roots)
    ? payload.workspace_roots[0]
    : payload.cwd;
  return { sessionId: String(sessionId), event: String(payload.hook_event_name || ''), cwd };
}

export function renderResponse({ host, event, context, userMessage }) {
  if (!context) return '';
  if (host === 'claude-code') {
    // SessionStart takes bare stdout as context; UserPromptSubmit takes JSON.
    if (event === 'session-start') return `${context}\n`;
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context },
      ...(userMessage ? { systemMessage: userMessage } : {}),
    });
  }
  // Cursor and Codex both take additional_context. Neither has a channel for
  // a user-visible line, so userMessage is dropped rather than smuggled into
  // the model's context where it would read as an instruction.
  return JSON.stringify({ additional_context: context });
}
```

- [ ] **Step 4: Run the tests**

Run: `cd packages/plugin && npx vitest run hooks/hosts.test.mjs`
Expected: PASS (12 assertions).

- [ ] **Step 5: Route both hooks through it**

In `session-start.mjs`, replace the direct `process.stdout.write(...)` and the `payload.source` gate:

```javascript
import { detectHost, normalizePayload, renderResponse } from './hosts.mjs';

// ...inside main(), after parsing the payload:
const host = detectHost(payload, process.env);
const { sessionId, event } = normalizePayload(payload, host);

// The source gate is Claude-Code-only: Cursor's sessionStart has no
// `source`, and gating on a field it never sends would silence it entirely.
if (host === 'claude-code' && payload.source && !ALLOWED_SOURCES.has(payload.source)) return;

const emit = (context) => {
  const out = renderResponse({ host, event: 'session-start', context });
  if (out) process.stdout.write(out);
};

// BOTH writes go through the renderer. This one is easy to miss: on Claude
// Code a bare line of stdout is valid context, but on Cursor the same bytes
// are malformed JSON, so a rejected token would break the hook itself rather
// than reporting the rejection.
if (status === 401 || status === 400) {
  emit('teamshare: server rejected this machine — reconfigure via /plugin');
  return;
}

// ...and at the end, replacing the bare digest write:
emit(render(digest));
```

In `prompt-submit.mjs`, replace the hand-built JSON at the end of `main()`:

```javascript
const host = detectHost(payload, process.env);
const { sessionId } = normalizePayload(payload, host);
// ...
const out = renderResponse({
  host,
  event: 'prompt-submit',
  context: renderAnnouncement(announce),
  userMessage: renderSystemMessage(announce),
});
if (out) process.stdout.write(out);
```

- [ ] **Step 6: Run the whole plugin suite**

Run: `cd packages/plugin && npx vitest run`
Expected: PASS. The existing Claude Code hook tests must be untouched — they assert the same bytes as before, which is the point of routing through a renderer rather than changing behaviour.

- [ ] **Step 7: Commit**

```bash
git add packages/plugin/hooks/hosts.mjs packages/plugin/hooks/hosts.test.mjs \
        packages/plugin/hooks/session-start.mjs packages/plugin/hooks/prompt-submit.mjs
git commit -m "refactor(plugin): make the hooks host-neutral"
```

---

### Task 3: Install teamshare's hooks into Cursor

Cursor users have no Claude Code plugin, so the hook files have to arrive some other way. The connector already writes MCP config for eight assistants; it grows a ninth job — writing the two hook scripts plus `~/.cursor/hooks.json`, and writing `~/.teamshare.json` as the credential the hooks read.

The hook source is **embedded in `teamshare-connect.mjs`** rather than fetched at install time. That file must stay a single curl-and-run download, and a network fetch at install would add a failure mode and version skew for no benefit. The existing `scripts/sync-plugin-bin.mjs` + drift-test pattern keeps the embedded copy honest.

**Files:**
- Modify: `scripts/sync-plugin-bin.mjs`
- Modify: `packages/server/src/teamshare-connect.mjs`
- Modify: `packages/plugin/tests/bin-sync.test.mjs`
- Modify: `packages/server/src/connect.test.ts`
- Create: `packages/plugin/hooks/standalone.mjs` (generated; committed)

**Interfaces:**
- Consumes: `detectHost` / `normalizePayload` / `renderResponse` (Task 2), `loadConfig` / `fetchUnread` / `neutralizeFences` from `shared.mjs`.
- Produces:
  - `installCursorHooks({ home, url, token, dryRun, fs }) -> { status: 'written'|'skipped'|'error', path, backup? }`
  - `TEAMSHARE_HOOK_SOURCE` — the standalone hook source, embedded as a string constant.

- [ ] **Step 1: Write the failing test**

```typescript
it('writes Cursor hooks, a credential file, and backs up what was there', async () => {
  const home = tmp();
  mkdirSync(join(home, '.cursor'), { recursive: true });
  writeFileSync(join(home, '.cursor', 'hooks.json'), JSON.stringify({ version: 1, hooks: {} }));

  const result = installCursorHooks({ home, url: 'https://ts.example.com', token: 'tsm_abc' });
  expect(result.status).toBe('written');

  const cfg = JSON.parse(readFileSync(join(home, '.cursor', 'hooks.json'), 'utf8'));
  expect(Object.keys(cfg.hooks)).toEqual(expect.arrayContaining(['sessionStart', 'beforeSubmitPrompt']));

  // The hook file is self-contained: no relative imports, because nothing
  // else is copied alongside it.
  const hook = readFileSync(join(home, '.teamshare', 'hooks', 'teamshare-hook.mjs'), 'utf8');
  expect(hook).not.toMatch(/from '\.\//);
  expect(hook.startsWith('#!/usr/bin/env node')).toBe(true);

  // The credential the hook reads, owner-only.
  const creds = JSON.parse(readFileSync(join(home, '.teamshare.json'), 'utf8'));
  expect(creds).toMatchObject({ url: 'https://ts.example.com', token: 'tsm_abc' });
  expect(statSync(join(home, '.teamshare.json')).mode & 0o777).toBe(0o600);

  // Never destroy an existing config without a copy of it.
  expect(existsSync(result.backup)).toBe(true);
});

it('leaves another tool\'s hooks alone when it adds its own', () => {
  const home = tmp();
  mkdirSync(join(home, '.cursor'), { recursive: true });
  writeFileSync(join(home, '.cursor', 'hooks.json'), JSON.stringify({
    version: 1, hooks: { stop: [{ command: 'someone-elses-tool' }] },
  }));
  installCursorHooks({ home, url: 'https://ts.example.com', token: 'tsm_abc' });
  const cfg = JSON.parse(readFileSync(join(home, '.cursor', 'hooks.json'), 'utf8'));
  expect(cfg.hooks.stop).toEqual([{ command: 'someone-elses-tool' }]);
});

it('writes nothing on a dry run', () => {
  const home = tmp();
  const result = installCursorHooks({ home, url: 'https://ts.example.com', token: 'tsm_abc', dryRun: true });
  expect(result.status).toBe('skipped');
  expect(existsSync(join(home, '.cursor', 'hooks.json'))).toBe(false);
  expect(existsSync(join(home, '.teamshare.json'))).toBe(false);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/server && npx vitest run src/connect.test.ts -t "Cursor hooks"`
Expected: FAIL — `installCursorHooks is not exported`.

- [ ] **Step 3: Generate the standalone hook**

Extend `scripts/sync-plugin-bin.mjs` to concatenate `hooks/shared.mjs`, `hooks/hosts.mjs`, `hooks/session-start.mjs` and `hooks/prompt-submit.mjs` into one import-free file, dispatching on the normalised event, and write it to `packages/plugin/hooks/standalone.mjs`. Strip the `import ... from './...'` lines and the `export ` keywords; keep every comment — they are the reasoning, and the standalone copy is the one a stranger reads.

```javascript
const HOOK_PARTS = [
  'packages/plugin/hooks/shared.mjs',
  'packages/plugin/hooks/hosts.mjs',
  'packages/plugin/hooks/session-start.mjs',
  'packages/plugin/hooks/prompt-submit.mjs',
];

export function buildStandaloneHook(read) {
  const body = HOOK_PARTS.map((f) => read(f)
    .replace(/^#!.*\n/, '')
    .replace(/^import .*? from '\.\/.*?';\n/gm, '')
    .replace(/^export (function|const|async function)/gm, '$1')
    .replace(/^main\(\)[\s\S]*?\);\n/gm, '')   // drop each part's own entrypoint
  ).join('\n');
  return `#!/usr/bin/env node\n// GENERATED by scripts/sync-plugin-bin.mjs — do not edit.\n${body}\n${DISPATCH}`;
}
```

- [ ] **Step 4: Add `installCursorHooks` to the connector**

Merge into any existing `hooks.json` rather than replacing it; back the old file up first, exactly as the MCP targets already do.

```javascript
export function installCursorHooks(opts) {
  const { home, url, token, dryRun = false, fs: fsImpl = nodeFs } = opts;
  if (dryRun) return { status: 'skipped' };

  const hookPath = joinPath(home, '.teamshare', 'hooks', 'teamshare-hook.mjs');
  fsImpl.mkdirSync(dirnamePath(hookPath), { recursive: true, mode: 0o700 });
  fsImpl.writeFileSync(hookPath, TEAMSHARE_HOOK_SOURCE, { mode: 0o755 });

  // The hook reads this; there is no CLAUDE_PLUGIN_OPTION_* outside Claude Code.
  const credPath = joinPath(home, '.teamshare.json');
  fsImpl.writeFileSync(credPath, JSON.stringify({ url, token }, null, 2) + '\n', { mode: 0o600 });
  try { fsImpl.chmodSync(credPath, 0o600); } catch {}

  const cfgPath = joinPath(home, '.cursor', 'hooks.json');
  let cfg = { version: 1, hooks: {} };
  let backup;
  if (fsImpl.existsSync(cfgPath)) {
    backup = `${cfgPath}.teamshare-backup-${Date.now()}`;
    fsImpl.copyFileSync(cfgPath, backup);
    try { cfg = JSON.parse(fsImpl.readFileSync(cfgPath, 'utf8')) || cfg; } catch { /* keep the default */ }
    cfg.hooks = cfg.hooks || {};
  }
  const command = `TEAMSHARE_HOST=cursor node ${hookPath}`;
  for (const event of ['sessionStart', 'beforeSubmitPrompt']) {
    const existing = (cfg.hooks[event] || []).filter((h) => !String(h.command || '').includes('teamshare-hook.mjs'));
    cfg.hooks[event] = [...existing, { command }];
  }
  fsImpl.mkdirSync(dirnamePath(cfgPath), { recursive: true });
  fsImpl.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  return { status: 'written', path: cfgPath, backup };
}
```

- [ ] **Step 5: Run the tests**

Run: `cd packages/server && npx vitest run src/connect.test.ts`
Expected: PASS.

- [ ] **Step 6: Guard the generated copy against drift**

Add to `packages/plugin/tests/bin-sync.test.mjs`:

```javascript
it('the standalone hook is regenerated from its parts, and imports nothing', () => {
  const generated = readFileSync(join(pluginRoot, 'hooks', 'standalone.mjs'), 'utf8');
  expect(generated).toBe(buildStandaloneHook((f) => readFileSync(join(repoRoot, f), 'utf8')));
  // If this fails the fix is `node scripts/sync-plugin-bin.mjs`, never a hand edit.
  expect(generated).not.toMatch(/from '\.\//);
});

it('the connector embeds exactly that file', () => {
  const connector = readFileSync(join(repoRoot, 'packages/server/src/teamshare-connect.mjs'), 'utf8');
  const embedded = /TEAMSHARE_HOOK_SOURCE = String\.raw`([\s\S]*?)`;/.exec(connector)?.[1];
  expect(embedded).toBe(readFileSync(join(pluginRoot, 'hooks', 'standalone.mjs'), 'utf8'));
});
```

- [ ] **Step 7: Verify it end to end against a live server**

Start a local server, create a team, invite two members, publish a share as one, then run the standalone hook by hand with a Cursor-shaped payload and confirm the reply is `{"additional_context": ...}` carrying the digest:

```bash
echo '{"hook_event_name":"sessionStart","conversation_id":"c1","workspace_roots":["/tmp"]}' \
  | TEAMSHARE_HOST=cursor HOME=/tmp/probe-home node packages/plugin/hooks/standalone.mjs
```

- [ ] **Step 8: Commit**

```bash
node scripts/sync-plugin-bin.mjs
git add scripts/sync-plugin-bin.mjs packages/plugin/hooks/standalone.mjs \
        packages/server/src/teamshare-connect.mjs packages/plugin/bin/teamshare-connect \
        packages/plugin/tests/bin-sync.test.mjs packages/server/src/connect.test.ts
git commit -m "feat(connect): give Cursor the session digest and the mid-session nudge"
```

---

### Task 4: Codex

Codex's hook events are named like Claude Code's (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`) — claude-mem ships a `codex-hooks.json` using exactly those. Whether Codex accepts Claude Code's *response* shape is unverified, and that is the whole question.

**Files:**
- Modify: `packages/server/src/teamshare-connect.mjs`
- Modify: `packages/server/src/connect.test.ts`
- Modify: `docs/superpowers/specs/2026-09-09-cursor-hook-contract.md` (add a Codex section)

**Interfaces:**
- Consumes: `TEAMSHARE_HOOK_SOURCE`, `installCursorHooks` (Task 3).
- Produces: `installCodexHooks({ home, url, token, dryRun, fs }) -> { status, path, backup? }`

- [ ] **Step 1: Find out what Codex actually supports**

Codex is installed at `~/.codex`. Read `~/.codex/config.toml` for a hooks section, and check the Codex docs for the response contract. Record the answer in the spec from Task 1 under a "Codex" heading — including, if it is the case, that Codex has no hook system and this task is dropped.

- [ ] **Step 2: Write the failing test**

Substitute the real config path from Step 1 for `.codex/hooks.json` if it turned out to be somewhere else.

```typescript
it('installs Codex hooks without disturbing an existing config', () => {
  const home = tmp();
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(join(home, '.codex', 'hooks.json'), JSON.stringify({
    hooks: { Stop: [{ type: 'command', command: 'someone-elses-tool' }] },
  }));

  const result = installCodexHooks({ home, url: 'https://ts.example.com', token: 'tsm_abc' });
  expect(result.status).toBe('written');

  const cfg = JSON.parse(readFileSync(join(home, '.codex', 'hooks.json'), 'utf8'));
  expect(Object.keys(cfg.hooks)).toEqual(expect.arrayContaining(['SessionStart', 'UserPromptSubmit']));
  expect(cfg.hooks.Stop).toEqual([{ type: 'command', command: 'someone-elses-tool' }]);

  // The host override is what makes the shared hook render Codex's response
  // shape instead of inferring Claude Code from a familiar event name.
  expect(JSON.stringify(cfg.hooks.SessionStart)).toContain('TEAMSHARE_HOST=codex');

  expect(statSync(join(home, '.teamshare.json')).mode & 0o777).toBe(0o600);
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `cd packages/server && npx vitest run src/connect.test.ts -t "Codex hooks"`
Expected: FAIL — not exported.

- [ ] **Step 4: Implement it**

The same shape as `installCursorHooks`, differing only in config path, event names, and `TEAMSHARE_HOST=codex`. Factor the shared middle into one `installHooksFor({ home, url, token, configPath, events, host, fs })` and have both call it — two near-identical 30-line functions is the kind of duplication that drifts.

- [ ] **Step 5: Run the tests**

Run: `cd packages/server && npx vitest run src/connect.test.ts`
Expected: PASS.

- [ ] **Step 6: Report it in the connector's output**

`formatConnectOutput` should list hook installation on its own line, so someone can see that Cursor got hooks and Zed did not:

```
  [written]       Cursor -> ~/.cursor/mcp.json
  [hooks]         Cursor -> ~/.cursor/hooks.json (session digest + live nudge)
  [not installed] Codex
```

- [ ] **Step 7: Commit**

```bash
node scripts/sync-plugin-bin.mjs
git add packages/server/src/teamshare-connect.mjs packages/plugin/bin/teamshare-connect \
        packages/server/src/connect.test.ts docs/superpowers/specs/2026-09-09-cursor-hook-contract.md
git commit -m "feat(connect): install teamshare hooks for Codex"
```

---

### Task 5: Scope a share to one repository (server)

A frontend engineer should not be shown backend deploy notes. A share gains an optional `project` — a normalised git remote, the only project identity stable across machines and people — and `getUnread` narrows on it.

**Design decisions, stated so the implementer does not have to guess:**
- **Opt-in, never inferred from cwd.** A share published while sitting in a repo is not necessarily about that repo ("I'm out sick today"). Silently scoping it would hide it from everyone else. The publisher's assistant sets `project` when the note is repo-specific.
- **Identity is the normalised remote**, e.g. `github.com/abdulgeek/teamshare`: lowercase, scheme/credentials/`.git` stripped, SSH `git@host:owner/repo` folded to the same form. A directory basename collides across orgs; an absolute path differs per machine.
- **No remote, no scope.** A repo without an `origin` cannot be identified, so a share from it stays team-wide rather than being scoped to something unmatchable.
- **A reader with no project sees everything.** Narrowing is for readers who *are* in a repo; someone in a scratch directory should not lose the whole board.

**Files:**
- Modify: `packages/server/src/db.ts` (migration to schema 5)
- Modify: `packages/server/src/shares.ts`
- Modify: `packages/server/src/unread.ts`
- Create: `packages/server/src/project.ts`
- Create: `packages/server/src/project.test.ts`
- Modify: `packages/server/src/db.test.ts`, `src/unread.test.ts`

**Interfaces:**
- Produces:
  - `normalizeProject(remoteUrl: string) -> string | null`
  - `ShareRow.project: string | null`; `createShare(scope, email, input & { project?: string }, now)`
  - `getUnread(scope, email, now, expiryDays, { project?: string, ... })`

- [ ] **Step 1: Write the failing test for project identity**

```typescript
import { describe, it, expect } from 'vitest';
import { normalizeProject } from './project.js';

describe('normalizeProject', () => {
  it('folds every way of writing the same remote into one key', () => {
    const want = 'github.com/abdulgeek/teamshare';
    for (const url of [
      'https://github.com/abdulgeek/teamshare.git',
      'https://github.com/abdulgeek/teamshare',
      'git@github.com:abdulgeek/teamshare.git',
      'ssh://git@github.com/abdulgeek/teamshare.git',
      'https://user:token@github.com/abdulgeek/teamshare.git',
      'HTTPS://GitHub.com/AbdulGeek/TeamShare.git',
    ]) {
      expect(normalizeProject(url), url).toBe(want);
    }
  });

  it('never leaks a credential into the key', () => {
    expect(normalizeProject('https://user:s3cret@github.com/a/b.git')).not.toContain('s3cret');
  });

  it('returns null for anything it cannot identify', () => {
    expect(normalizeProject('')).toBeNull();
    expect(normalizeProject('not a url')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/server && npx vitest run src/project.test.ts`
Expected: FAIL — cannot resolve `./project.js`.

- [ ] **Step 3: Write `project.ts`**

```typescript
/**
 * A project key that is the same for everyone on the team.
 *
 * The git remote is the only candidate: a directory basename collides across
 * orgs (`api`, `web`), and an absolute path differs on every machine. Anything
 * without a remote is deliberately unidentifiable — see the plan.
 */
export function normalizeProject(remoteUrl: string): string | null {
  const raw = String(remoteUrl || '').trim();
  if (!raw) return null;
  // git@host:owner/repo -> host/owner/repo
  const scp = /^[^@\s]+@([^:\s]+):(.+)$/.exec(raw);
  let rest: string;
  if (scp) {
    rest = `${scp[1]}/${scp[2]}`;
  } else {
    const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?(.+)$/i.exec(raw);
    if (!m) return null;
    rest = m[1];
  }
  const key = rest.replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase();
  return /^[a-z0-9.-]+\/.+/.test(key) ? key : null;
}
```

- [ ] **Step 4: Run the tests**

Run: `cd packages/server && npx vitest run src/project.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing migration test**

```typescript
it('adds shares.project at schema 5 without disturbing existing rows', () => {
  const db = openDb(':memory:');
  const scope = makeTeamScope(db, getOrCreateDefaultTeamId(db));
  const { id } = createShare(scope, 'a@t.com', { what: 'x', priority: 'fyi' }, NOW);
  expect(getShare(scope, id)?.project).toBeNull();
  expect(readConfig(db, 'schema_version')).toBe('5');
  db.close();
});
```

- [ ] **Step 6: Add the migration**

A new step in the existing chain, keyed on `schema_version === '4'`, inside the same per-step transaction. `project` is nullable, so no table rebuild is needed — `ALTER TABLE shares ADD COLUMN project TEXT` then `setConfig(db, 'schema_version', '5')`. Add an index on `(team_id, project)`; every unread query filters on both.

- [ ] **Step 7: Narrow `getUnread`**

Add `project?: string` to `UnreadOptions`, and to the shared `WHERE_UNREAD`:

```sql
AND (s.project IS NULL OR s.project = ?)
```

bound to the reader's project, and omitted entirely when the reader has none — a reader outside any repo sees the whole board rather than only unscoped shares.

- [ ] **Step 8: Write the failing behaviour test, then make it pass**

```typescript
it('shows a scoped share only to a reader in that repo, and unscoped ones to everyone', () => {
  createShare(scope, 'adnan@team.com', { what: 'api thing', priority: 'fyi', project: 'github.com/acme/api' }, NOW);
  createShare(scope, 'adnan@team.com', { what: 'out sick', priority: 'fyi' }, NOW);

  const inApi = getUnread(scope, 'priya@team.com', NOW, 14, { project: 'github.com/acme/api' });
  expect(inApi.shares.map((s) => s.what).sort()).toEqual(['api thing', 'out sick']);

  const inWeb = getUnread(scope, 'priya@team.com', NOW, 14, { project: 'github.com/acme/web' });
  expect(inWeb.shares.map((s) => s.what)).toEqual(['out sick']);

  // No project at all: the reader is not in a repo, so nothing is hidden.
  const anywhere = getUnread(scope, 'priya@team.com', NOW, 14);
  expect(anywhere.shares).toHaveLength(2);
});
```

Run: `cd packages/server && npx vitest run src/unread.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/server/src/project.ts packages/server/src/project.test.ts \
        packages/server/src/db.ts packages/server/src/shares.ts packages/server/src/unread.ts \
        packages/server/src/db.test.ts packages/server/src/unread.test.ts
git commit -m "feat(server): scope a share to one repository"
```

---

### Task 6: Surface project scope to readers and publishers

**Files:**
- Modify: `packages/server/src/mcp.ts`, `packages/server/src/app.ts`
- Modify: `packages/plugin/hooks/shared.mjs`, `session-start.mjs`, `prompt-submit.mjs`
- Modify: `packages/plugin/skills/share-format/SKILL.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: `normalizeProject`, `getUnread(..., { project })` (Task 5).
- Produces: `/unread?project=<key>`; `share` tool gains `project?: string`; hooks send the reader's project.

- [ ] **Step 1: Write the failing test**

```typescript
it('passes the caller\'s project through from the query string', async () => {
  const res = await fetch(`${base}/unread?project=github.com/acme/api`, {
    headers: { Authorization: `Bearer ${memberToken}` },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.shares.map((s: { what: string }) => s.what)).toContain('api thing');
});

it('rejects a project key that is not one', async () => {
  // A malformed key must not silently widen the digest back to everything.
  const res = await fetch(`${base}/unread?project=${encodeURIComponent('../../etc')}`, {
    headers: { Authorization: `Bearer ${memberToken}` },
  });
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/server && npx vitest run src/http.test.ts -t "project"`
Expected: FAIL — the query parameter is ignored, so the second test gets 200.

- [ ] **Step 3: Implement the route and the tool**

In `app.ts`, read `req.query.project`, validate it against the same shape `normalizeProject` produces (`/^[a-z0-9.-]+\/[a-z0-9._/-]+$/`), 400 on anything else, and pass it to `getUnread`. In `mcp.ts`, add `project: z.string().optional()` to the `share` tool with a description saying it is for repo-specific notes and that omitting it means the whole team, and add `project` to `unread`.

- [ ] **Step 4: Run the tests**

Run: `cd packages/server && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Have the hooks send the reader's project**

In `shared.mjs`, resolve it once per run and append it to the `/unread` URL. Force `cwd` to the payload's working directory, and never let a failure matter:

```javascript
export function resolveProject(cwd) {
  if (!cwd) return undefined;
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd, timeout: 800, stdio: ['ignore', 'pipe', 'ignore'],
    }).toString('utf8').trim();
    return normalizeProjectKey(remote) ?? undefined;
  } catch {
    // No git, no repo, no remote: the reader has no project and sees the
    // whole board. Never a reason to fail a session start.
    return undefined;
  }
}
```

`normalizeProjectKey` is a hand-maintained copy of `normalizeProject` — `shared.mjs` cannot import from `packages/server`. Add it to the drift guards in `bin-sync.test.mjs` alongside `DEFAULT_SERVER_URL`.

- [ ] **Step 6: Show the scope in the digest**

A scoped share should say so, or a reader cannot tell why their colleague never saw it:

```
- id=shr_x | FYI | from Ann | 3 hours ago (Tuesday, 08-09-2026) | acme/api
```

- [ ] **Step 7: Run everything, then document it**

Run: `pnpm -r test`
Expected: PASS. Then add a README subsection under "How old is it, and does it still matter?" explaining opt-in scoping, the git-remote key, and that a reader outside a repo sees everything.

- [ ] **Step 8: Commit**

```bash
node scripts/sync-plugin-bin.mjs
git add -A
git commit -m "feat: surface repository scope to readers and publishers"
```

---

### Task 7: Address a share to specific people (server)

*"Tell Sam the PR is ready"* should reach Sam and nobody else. Recipients live in their own table rather than a JSON column: the unread query filters on them on every request, and `receipts` already establishes the composite-FK pattern to copy.

**Files:**
- Modify: `packages/server/src/db.ts` (migration to schema 6)
- Modify: `packages/server/src/shares.ts`, `src/unread.ts`, `src/receipts.ts`
- Modify: `packages/server/src/db.test.ts`, `src/unread.test.ts`, `src/receipts.test.ts`

**Interfaces:**
- Produces:
  - `createShare(scope, email, input & { recipients?: string[] }, now) -> { id, notified }`
  - `ShareRow.recipients: string[]` (empty = whole team)
  - `getReceipts` counts only recipients as expected readers

- [ ] **Step 1: Write the failing test**

```typescript
it('reaches only the people it names, and never the sender', () => {
  createShare(scope, 'adnan@team.com', { what: 'for sam', priority: 'fyi', recipients: ['sam@team.com'] }, NOW);
  expect(getUnread(scope, 'sam@team.com', NOW, 14).total).toBe(1);
  expect(getUnread(scope, 'priya@team.com', NOW, 14).total).toBe(0);
  expect(getUnread(scope, 'adnan@team.com', NOW, 14).total).toBe(0);
});

it('normalises recipient addresses the way every other email is normalised', () => {
  createShare(scope, 'adnan@team.com', { what: 'x', priority: 'fyi', recipients: ['SAM@Team.com '] }, NOW);
  expect(getUnread(scope, 'sam@team.com', NOW, 14).total).toBe(1);
});

it('counts only the addressed people as notified', () => {
  const { notified } = createShare(
    scope, 'adnan@team.com',
    { what: 'x', priority: 'fyi', recipients: ['sam@team.com', 'priya@team.com'] }, NOW,
  );
  expect(notified).toBe(2);
});

it('treats an empty recipient list as the whole team, not as nobody', () => {
  createShare(scope, 'adnan@team.com', { what: 'everyone', priority: 'fyi', recipients: [] }, NOW);
  expect(getUnread(scope, 'priya@team.com', NOW, 14).total).toBe(1);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/server && npx vitest run src/unread.test.ts -t "reaches only"`
Expected: FAIL — `recipients` is ignored, so Priya sees it.

- [ ] **Step 3: Add the migration and the table**

Keyed on `schema_version === '5'`, in one transaction:

```sql
CREATE TABLE share_recipients (
  team_id  TEXT NOT NULL,
  share_id TEXT NOT NULL,
  email    TEXT NOT NULL,
  PRIMARY KEY (team_id, share_id, email),
  FOREIGN KEY (team_id, share_id) REFERENCES shares(team_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_share_recipients_email ON share_recipients(team_id, email);
```

`ON DELETE CASCADE` matters: `retractShare` deletes the share, and a stale recipient row would otherwise outlive it.

- [ ] **Step 4: Filter unread on it**

```sql
AND (
  NOT EXISTS (SELECT 1 FROM share_recipients sr WHERE sr.team_id = ? AND sr.share_id = s.id)
  OR EXISTS (SELECT 1 FROM share_recipients sr WHERE sr.team_id = ? AND sr.share_id = s.id AND sr.email = ?)
)
```

The first arm is what makes an unaddressed share team-wide; without it, every existing share would vanish for everyone.

- [ ] **Step 5: Run the tests**

Run: `cd packages/server && npx vitest run src/unread.test.ts src/db.test.ts`
Expected: PASS.

- [ ] **Step 6: Make receipts mean the right thing**

`getReceipts` currently reports "not yet seen by" every member. For an addressed share that is wrong — it should list only the people it was sent to. Add a test asserting exactly that, then implement it.

- [ ] **Step 7: Run the whole server suite**

Run: `cd packages/server && npx vitest run`
Expected: PASS, including every cross-team isolation test.

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/db.ts packages/server/src/shares.ts packages/server/src/unread.ts \
        packages/server/src/receipts.ts packages/server/src/*.test.ts
git commit -m "feat(server): address a share to specific people"
```

---

### Task 8: Surface direct shares, then ship

**Files:**
- Modify: `packages/server/src/mcp.ts`
- Modify: `packages/plugin/skills/share-format/SKILL.md`, `packages/plugin/commands/share.md`
- Modify: `README.md`, `docs/reference.md`
- Modify: the three version files

**Interfaces:**
- Consumes: everything above.
- Produces: `share` tool with `recipients?: string[]`; a digest that says who a share was addressed to.

- [ ] **Step 1: Write the failing test**

```typescript
it('lets one member address a share to another, and shows who it went to', async () => {
  const adnan = await connectWithToken(adnanToken);
  await adnan.callTool({
    name: 'share',
    arguments: { what: 'PR is ready', priority: 'fyi', recipients: ['priya@team.com'] },
  });
  await adnan.close();

  const priya = await connectWithToken(priyaToken);
  const digest = textOf(await priya.callTool({ name: 'unread', arguments: {} }));
  expect(digest).toContain('PR is ready');
  expect(digest).toContain('to you');
  await priya.close();

  const sam = await connectWithToken(samToken);
  expect(textOf(await sam.callTool({ name: 'unread', arguments: {} }))).toContain('No unread');
  await sam.close();
});

it('refuses a recipient who is not on the team', async () => {
  const adnan = await connectWithToken(adnanToken);
  const res = await adnan.callTool({
    name: 'share', arguments: { what: 'x', priority: 'fyi', recipients: ['stranger@elsewhere.com'] },
  });
  // Silently dropping an unknown recipient would look like a delivered share
  // that nobody ever receives.
  expect(res.isError).toBeTruthy();
  await adnan.close();
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/server && npx vitest run src/mcp.test.ts -t "address a share"`
Expected: FAIL — `recipients` is not in the tool schema.

- [ ] **Step 3: Implement it**

Add `recipients: z.array(z.string()).max(20).optional()` to the `share` tool, validate each against the team's members (reusing `validateInviteEmail` for shape and `listMembers` for existence), and fail with the offending address named. In `renderDigest` and both hooks, mark an addressed share `to you` rather than printing the whole recipient list — the list is other people's names and adds nothing to the reader.

- [ ] **Step 4: Run the tests**

Run: `pnpm -r test`
Expected: PASS.

- [ ] **Step 5: Teach the skill to use it**

`share-format/SKILL.md` currently distils a message into what/why/action. Add: when the user names a person ("tell Sam…", "let the backend team know…"), set `recipients`; when they name a repo or the note is clearly about one, set `project`. Both stay off by default — a share with neither is team-wide, which is the common case.

- [ ] **Step 6: Document all three features together**

README gets one new subsection covering scope and direct shares, with real captured output. `docs/reference.md` gets the schema changes, the project-key rule, and the recipient semantics.

- [ ] **Step 7: Verify end to end against a live server**

Start a server, create a team, invite three people, and check by hand: an unscoped share reaches all three; a scoped one reaches only a reader in that repo; an addressed one reaches only its recipient; receipts for the addressed one list only the recipient. Capture the output for the README rather than writing it from memory.

- [ ] **Step 8: Bump, commit, push, deploy**

```bash
node scripts/sync-plugin-bin.mjs
pnpm -r test
claude plugin validate .
git add -A && git commit -m "feat: direct shares, and the docs for scope and recipients"
git push origin main
```

Then deploy to production over SSM exactly as previous changes did (`git fetch --depth 1 origin main && git reset --hard origin/main`, `pnpm install --frozen-lockfile`, `pnpm --filter teamshare-server build`, `systemctl restart teamshare.service`), and verify: production commit matches `main`, both services active, `/health` 200, unauthenticated `/unread` 401.

---

## Verification checklist

Run before calling this plan done:

- [ ] `pnpm -r test` passes.
- [ ] `claude plugin validate .` passes for both manifests.
- [ ] The three version files agree and none went backwards.
- [ ] `node scripts/sync-plugin-bin.mjs` produces no diff.
- [ ] A Cursor session shows the digest, and a mid-session share appears on the next message.
- [ ] A Claude Code session behaves exactly as before — the host adapter changed no bytes for the existing host.
- [ ] Production, GitHub and local are on the same commit; `/health` 200 and unauthenticated `/unread` 401.
