// The plugin ships copies, not imports.
//
// The marketplace entry installs `./packages/plugin` and nothing else, so
// anything under packages/server is simply absent on an installed machine.
// These two CLIs therefore ship twice from one source file each, and the
// address they all point at is written down in four places that cannot import
// one another. None of that is safe by construction — it is safe because this
// file fails when any of it drifts.
import { describe, it, expect } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(pluginRoot, '..', '..');

const COPIES = [
  { source: 'packages/server/src/teamshare-team.mjs', copy: 'bin/teamshare-team' },
  { source: 'packages/server/src/teamshare-connect.mjs', copy: 'bin/teamshare-connect' },
];

describe('the plugin bin copies', () => {
  for (const { source, copy } of COPIES) {
    it(`${copy} is byte-identical to ${source}`, () => {
      const from = readFileSync(join(repoRoot, source));
      const to = readFileSync(join(pluginRoot, copy));
      // If this fails the fix is `node scripts/sync-plugin-bin.mjs`, never a
      // hand edit of the copy — the copy has no separate life.
      expect(to.equals(from)).toBe(true);
    });

    it(`${copy} is executable, or Claude Code cannot run it from PATH`, () => {
      // Claude Code puts every installed plugin's bin/ on PATH. A copy without
      // the executable bit is on PATH and still unrunnable, which presents as
      // "command not found" from inside a slash command.
      expect(statSync(join(pluginRoot, copy)).mode & 0o111).not.toBe(0);
    });

    it(`${copy} starts with a shebang so PATH execution works at all`, () => {
      expect(readFileSync(join(pluginRoot, copy), 'utf8').startsWith('#!/usr/bin/env node')).toBe(true);
    });
  }

  it('the plugin package is an ES module, which is what makes the extensionless copies load', () => {
    // The copies have no .mjs extension, so Node decides ESM-vs-CJS from the
    // nearest package.json. Drop this field and both bins fail at import with
    // "Cannot use import statement outside a module".
    const pkg = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'));
    expect(pkg.type).toBe('module');
  });
});

describe('one server address, written in four places that cannot import each other', () => {
  const mcp = JSON.parse(readFileSync(join(pluginRoot, '.mcp.json'), 'utf8'));
  const declared = mcp.mcpServers.teamshare.url;

  const constantIn = (relativePath) => {
    const text = readFileSync(join(repoRoot, relativePath), 'utf8');
    const match = /DEFAULT_SERVER_URL = '([^']+)'/.exec(text);
    expect(match, `no DEFAULT_SERVER_URL found in ${relativePath}`).toBeTruthy();
    return match[1];
  };

  it('.mcp.json names a concrete origin, not an unresolved placeholder', () => {
    // A `${user_config.X}` here was how the URL used to arrive, and it is why
    // install asked for two values instead of one. It must never come back:
    // userConfig has no working default, so an unset value would leave the MCP
    // server pointed at a broken address.
    expect(declared).toMatch(/^https?:\/\/\S+\/mcp$/);
    expect(declared).not.toContain('${');
  });

  it('agrees with the constant compiled into both standalone CLIs', () => {
    const origin = declared.replace(/\/mcp$/, '');
    expect(constantIn('packages/server/src/teamshare-team.mjs')).toBe(origin);
    expect(constantIn('packages/server/src/teamshare-connect.mjs')).toBe(origin);
  });

  it('agrees with the fallback in the session-start hook', () => {
    expect(constantIn('packages/plugin/hooks/session-start.mjs')).toBe(declared.replace(/\/mcp$/, ''));
  });
});

describe('the install prompt', () => {
  const manifest = JSON.parse(readFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8'));

  it('asks for exactly one value, and it is the personal token', () => {
    // The entire point of the change: the server address is not a per-person
    // value and must never be prompted for again.
    expect(Object.keys(manifest.userConfig)).toEqual(['TEAMSHARE_TOKEN']);
  });

  it('marks that value sensitive, so it is stored as a credential rather than plain settings', () => {
    expect(manifest.userConfig.TEAMSHARE_TOKEN.sensitive).toBe(true);
  });
});
