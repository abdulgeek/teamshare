// Shared by the two hooks in this directory.
//
// A real module import, not another hand-maintained copy: both hooks ship
// inside packages/plugin, so a sibling file is always present at runtime. The
// "duplicate it by hand" note in session-start.mjs is about packages/server,
// which an installed plugin genuinely cannot reach — that constraint has never
// applied between files sitting next to each other.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

// Kept byte-identical to DEFAULT_SERVER_URL in packages/server/src/
// teamshare-team.mjs and teamshare-connect.mjs. This one IS a hand-maintained
// duplicate — those files must each stay a single dependency-free download —
// and packages/plugin/tests/bin-sync.test.mjs fails if the four disagree.
export const DEFAULT_SERVER_URL = 'https://54.90.22.249.sslip.io';

const hooksDir = dirname(fileURLToPath(import.meta.url));

export function readConfigFile() {
  try {
    return JSON.parse(readFileSync(join(homedir(), '.teamshare.json'), 'utf8'));
  } catch {
    return null;
  }
}

// The address compiled into this plugin's own .mcp.json — the single line a
// self-hoster forks. Read back so the hooks can never end up polling a
// different server than the MCP connection beside them.
export function readBundledMcpUrl() {
  try {
    const manifest = JSON.parse(readFileSync(join(hooksDir, '..', '.mcp.json'), 'utf8'));
    const url = manifest?.mcpServers?.teamshare?.url;
    if (typeof url !== 'string' || !url.trim() || url.includes('${')) return undefined;
    return url.trim().replace(/\/+$/, '').replace(/\/mcp$/i, '');
  } catch {
    return undefined;
  }
}

// URL: TEAMSHARE_URL, then ~/.teamshare.json, then this plugin's .mcp.json,
// then the built-in default. Token: the plugin's userConfig option, then the
// config file. A missing token is the only thing that leaves a machine
// unconfigured — the URL always resolves.
export function loadConfig(env = process.env) {
  const fileCfg = readConfigFile();
  const url =
    (env.TEAMSHARE_URL ?? '').trim() ||
    (typeof fileCfg?.url === 'string' ? fileCfg.url.trim() : '') ||
    readBundledMcpUrl() ||
    DEFAULT_SERVER_URL;
  const token = env.CLAUDE_PLUGIN_OPTION_TEAMSHARE_TOKEN || fileCfg?.token;
  if (!token) return null;
  return { url: String(url).replace(/\/+$/, ''), token };
}

// Defence in depth: neutralise literal fence-looking text so a share cannot
// forge a fence boundary of its own. NOT the real security boundary — the
// unpredictable per-render tag is — but a teammate's share text still should
// not be able to visually masquerade as a fence line.
//
// Deliberately mirrors neutralizeFences in packages/server/src/mcp.ts. The
// dash-lookalike pattern must not be defeated by a single dash, by non-ASCII
// dash glyphs pasted in place of "-", or by non-whitespace filler between the
// marker words ("END-UNTRUSTED", "END_OF_UNTRUSTED").
const DASH = '\\-\\u2012\\u2013\\u2014\\u2015';
const FENCE_LOOKALIKE = new RegExp(`[${DASH}]+\\s*(?:BEGIN|END)(?:[\\s_${DASH}]|OF)*UNTRUSTED[^\\n]*`, 'gi');
const TEAMSHARE_TAG = /<\/?\s*teamshare-(?:unread|new)\b[^>]*>/gi;

export function neutralizeFences(text) {
  return String(text)
    .replace(FENCE_LOOKALIKE, '[redacted fence marker]')
    .replace(TEAMSHARE_TAG, '[redacted fence marker]');
}

export async function fetchUnread(cfg, timeoutMs, project) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL(`${cfg.url}/unread`);
    if (project) url.searchParams.set('project', project);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${cfg.token}` },
      signal: controller.signal,
    });
    return { status: res.status, digest: res.ok ? await res.json() : null };
  } finally {
    clearTimeout(timer);
  }
}

// A hand-maintained copy of PROJECT_KEY_SHAPE in
// packages/server/src/project.ts, which carries the reasoning. In short: it is
// the one definition of a project key's shape, and the server tests every
// ?project= against it. A key this file mints that the server would reject is
// a 400 on every session that machine ever starts — and a hook cannot show a
// digest it never received. packages/plugin/tests/bin-sync.test.mjs asserts
// the round trip: every key either copy produces is one this shape accepts.
const PROJECT_KEY_SHAPE = /^[a-z0-9][a-z0-9.-]*\/[^\s\p{Cc}\p{Cf}]+$/u;

// A hand-maintained copy of normalizeProject in packages/server/src/project.ts
// — this file ships inside packages/plugin and is bundled into
// standalone.mjs, so it cannot import from packages/server. Kept in sync by
// packages/plugin/tests/bin-sync.test.mjs, which runs both against a shared
// table of inputs (including the SCP-vs-URL-port distinction below) rather
// than comparing source text, since this copy carries no TypeScript types.
//
// SCP syntax (`user@host:path`) has no `://` anywhere in it — that is the one
// thing that tells it apart from a URL, and checking for a scheme FIRST is
// what keeps an explicit port (`ssh://git@host:22/owner/repo`) from being
// mistaken for the SCP host:path separator and folded to a different key
// than the same repo's HTTPS form.
export function normalizeProjectKey(remoteUrl) {
  const raw = String(remoteUrl || '').trim();
  if (!raw) return null;
  let rest;
  if (!raw.includes('://')) {
    // git@host:owner/repo -> host/owner/repo
    const scp = /^[^@\s]+@([^:\s]+):(.+)$/.exec(raw);
    if (!scp) return null;
    rest = `${scp[1]}/${scp[2]}`;
  } else {
    const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/]+)(\/.*)?$/i.exec(raw);
    if (!m) return null;
    // The host may carry an explicit port; strip it before folding.
    const host = m[1].replace(/:\d+$/, '');
    rest = host + (m[2] ?? '');
  }
  const key = rest.replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase();
  // The shape above IS the guard, exactly as on the server: whatever comes
  // back from here is a key /unread will accept.
  return PROJECT_KEY_SHAPE.test(key) ? key : null;
}

// The reader's own repo, resolved once per hook run from the payload's
// working directory — never process.cwd(), which need not agree with it.
// Never a reason to fail a session: no git binary, no repo, no remote, or a
// cwd that no longer exists all land here as "no project", and a reader with
// no project sees the whole board rather than an error.
export function resolveProject(cwd) {
  if (!cwd) return undefined;
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd,
      timeout: 800,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString('utf8')
      .trim();
    return normalizeProjectKey(remote) ?? undefined;
  } catch {
    // No git, no repo, no remote: the reader has no project and sees the
    // whole board. Never a reason to fail a session start.
    return undefined;
  }
}
