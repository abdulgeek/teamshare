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

export async function fetchUnread(cfg, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${cfg.url}/unread`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
      signal: controller.signal,
    });
    return { status: res.status, digest: res.ok ? await res.json() : null };
  } finally {
    clearTimeout(timer);
  }
}
