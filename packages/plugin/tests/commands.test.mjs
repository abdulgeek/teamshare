// The names in the README have to be the names Claude Code actually accepts.
//
// Claude Code namespaces a plugin's commands as `<plugin>:<file>`, so
// commands/invite.md is `/teamshare:invite` — the bare `/teamshare-invite`
// the README used to print is simply not a command, and typing it gets
// "Unknown command". That is how this shipped broken: nothing connected the
// documentation to the filenames.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(pluginRoot, '..', '..');

const manifest = JSON.parse(readFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8'));
const commandFiles = readdirSync(join(pluginRoot, 'commands'))
  .filter((f) => f.endsWith('.md'))
  .map((f) => f.replace(/\.md$/, ''));
const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');

// Every `/teamshare:<something>` the README mentions, deduplicated.
const documented = [...new Set([...readme.matchAll(/\/teamshare:([a-z-]+)/g)].map((m) => m[1]))];

describe('slash command names', () => {
  it('every command the README documents actually exists', () => {
    for (const name of documented) {
      expect(commandFiles, `README documents /teamshare:${name}, but commands/${name}.md does not exist`).toContain(name);
    }
  });

  it('every command that exists is documented', () => {
    for (const name of commandFiles) {
      expect(documented, `commands/${name}.md ships undocumented`).toContain(name);
    }
  });

  it('the README never uses the un-namespaced form, which Claude Code rejects', () => {
    // `/teamshare-invite` and friends look right and are not commands.
    //
    // The dot is inside the character class on purpose: matching it greedily
    // and filtering afterwards is the only reliable way to exclude the two
    // real file paths (.../teamshare-connect.mjs, .../teamshare-team.mjs). A
    // trailing (?!\.) lookahead does not work here — the engine just
    // backtracks one character and matches anyway.
    const bare = [...readme.matchAll(/\/teamshare-[a-z.-]+/g)]
      .map((m) => m[0])
      .filter((m) => !m.includes('.'));
    expect(bare).toEqual([]);
  });

  it('no command name repeats the plugin name, so nothing reads /teamshare:teamshare-…', () => {
    for (const name of commandFiles) {
      expect(name.startsWith('teamshare-'), `commands/${name}.md would be /teamshare:${name}`).toBe(false);
    }
  });

  it('each command declares a description, which is what /help and the picker show', () => {
    for (const name of commandFiles) {
      const body = readFileSync(join(pluginRoot, 'commands', `${name}.md`), 'utf8');
      expect(body.startsWith('---'), `commands/${name}.md has no frontmatter`).toBe(true);
      expect(/\ndescription:\s*\S/.test(body.split('---')[1] ?? ''), `commands/${name}.md has no description`).toBe(true);
    }
  });

  it('commands referenced from inside other commands exist too', () => {
    for (const name of commandFiles) {
      const body = readFileSync(join(pluginRoot, 'commands', `${name}.md`), 'utf8');
      for (const [, referenced] of body.matchAll(/\/teamshare:([a-z-]+)/g)) {
        expect(commandFiles, `commands/${name}.md points at /teamshare:${referenced}, which does not exist`).toContain(referenced);
      }
      const bareHere = (body.match(/\/teamshare-[a-z.-]+/g) ?? []).filter((m) => !m.includes('.'));
      expect(bareHere, `commands/${name}.md uses the un-namespaced form`).toEqual([]);
    }
  });

  it('create-team does not tell the agent to generate-secret first', () => {
    const body = readFileSync(join(pluginRoot, 'commands', 'create-team.md'), 'utf8');
    expect(body).toMatch(/Do not run `\/teamshare:generate-secret`/i);
    expect(body).not.toMatch(/Generate the signup secret first/i);
  });
});
