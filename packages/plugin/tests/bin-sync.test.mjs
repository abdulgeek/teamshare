// The plugin ships copies, not imports.
//
// The marketplace entry installs `./packages/plugin` and nothing else, so
// anything under packages/server is simply absent on an installed machine.
// These two CLIs therefore ship twice from one source file each, and the
// address they all point at is written down in four places that cannot import
// one another. None of that is safe by construction — it is safe because this
// file fails when any of it drifts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, statSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { buildStandaloneHook, spliceHookSource } from '../../../scripts/sync-plugin-bin.mjs';
import { TEAMSHARE_HOOK_SOURCE } from '../../server/src/teamshare-connect.mjs';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// tests/ deliberately, not bin/: a directory Claude Code puts on PATH should
// contain only things meant to be run.
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

  it('agrees with the fallback the hooks share', () => {
    // Both hooks resolve the address through hooks/shared.mjs, so there is one
    // constant here rather than one per hook.
    expect(constantIn('packages/plugin/hooks/shared.mjs')).toBe(declared.replace(/\/mcp$/, ''));
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

// ---------------------------------------------------------------------------
// The standalone hook
//
// A third copy, and the one with the least margin for error. Cursor has no
// plugin directory, so teamshare-connect writes ONE assembled file onto the
// machine — and Cursor swallows hook output, which means a bundle that parses
// but does nothing is indistinguishable from "no unread shares". Nobody would
// ever report it. So this file does not merely check that the bytes match: it
// runs the thing.
// ---------------------------------------------------------------------------

const standalonePath = join(pluginRoot, 'hooks', 'standalone.mjs');

describe('the standalone hook', () => {
  it('is regenerated from its parts, and imports nothing relative', () => {
    const generated = readFileSync(standalonePath, 'utf8');
    expect(generated).toBe(buildStandaloneHook((f) => readFileSync(join(repoRoot, f), 'utf8')));
    // If this fails the fix is `node scripts/sync-plugin-bin.mjs`, never a hand edit.
    expect(generated).not.toMatch(/from '\.\//);
  });

  it('the connector embeds exactly that file', () => {
    // Compared as the evaluated constant rather than by re-extracting it with
    // a regex: the constant is what actually gets written to a machine, and
    // the hook source is full of backticks and ${...} that any extraction
    // regex would have to un-escape correctly to agree with.
    expect(TEAMSHARE_HOOK_SOURCE).toBe(readFileSync(standalonePath, 'utf8'));
  });

  it('the embedded copy is readable source, not an opaque blob', () => {
    // People curl teamshare-connect and run it. A script that writes an
    // executable onto your machine should let you read what it writes.
    const connector = readFileSync(join(repoRoot, 'packages/server/src/teamshare-connect.mjs'), 'utf8');
    expect(connector).toContain('unread team share(s) published by teammates.');
    expect(spliceHookSource(connector, readFileSync(standalonePath, 'utf8'))).toBe(connector);
  });

  it('starts with a shebang and declares each hook exactly once', () => {
    const generated = readFileSync(standalonePath, 'utf8');
    expect(generated.startsWith('#!/usr/bin/env node')).toBe(true);
    // Duplicate top-level names are a SyntaxError in an ES module, which is
    // why each hook's body is wrapped in a block. Two `let run...` at the top
    // level, two `main` inside blocks.
    expect(generated.match(/^let runSessionStart;$/gm)).toHaveLength(1);
    expect(generated.match(/^let runPromptSubmit;$/gm)).toHaveLength(1);
    expect(generated.match(/^async function main\(\) \{$/gm)).toHaveLength(2);
  });

  it('refuses to assemble a part it does not understand rather than emitting a broken bundle', () => {
    // The whole safety argument for this generator: when the sources move on,
    // it stops. It never guesses and it never half-strips.
    const read = (f) => {
      const real = readFileSync(join(repoRoot, f), 'utf8');
      return f.endsWith('session-start.mjs') ? real.replace('main().then(', 'runIt().then(') : real;
    };
    expect(() => buildStandaloneHook(read)).toThrow(/main\(\)/);
  });

  it('refuses a hook part that declares a name the generated file declares', () => {
    // The block each hook part is wrapped in scopes its names away from the
    // *other* hook's — not away from the dispatcher's. A `let runPromptSubmit;`
    // at a hook part's own top level assembles cleanly and parses cleanly, and
    // then dispatch() calls an undefined binding: the TypeError is swallowed by
    // `dispatch().then(…, () => process.exit(0))`, so the hook exits 0 having
    // printed nothing. On a host that swallows hook output that is
    // indistinguishable from "no unread shares", and nobody would report it.
    // `hookStdinText` is worse still — it would pass every execution test in
    // this file, because a hook reading an empty payload still behaves.
    for (const name of ['hookStdinText', 'readAllStdin', 'runPromptSubmit']) {
      const read = (f) => {
        const real = readFileSync(join(repoRoot, f), 'utf8');
        // After the shebang, or stripShebang would leave a `#!` mid-file.
        return f.endsWith('prompt-submit.mjs')
          ? real.replace(/^(#![^\n]*\n)/, `$1let ${name};\n`)
          : real;
      };
      expect(() => buildStandaloneHook(read)).toThrow(new RegExp(`declares \`${name}\``));
    }
  });
});

// The real test. Everything above compares bytes; this runs the file the way
// Cursor runs it and reads what comes back.
describe('the standalone hook, actually run', () => {
  let server;
  let origin;
  let home;

  const digest = {
    total: 1,
    older: 0,
    shares: [{
      id: 11,
      priority: 'blocking',
      sender_name: 'Grace Hopper',
      what: 'auth refactor lands Friday; do not merge src/auth',
      age: '3 hours ago',
      day: '2026-09-09',
      relevance: 'new',
      created_at: '2026-09-09T09:00:00Z',
    }],
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.headers.authorization !== 'Bearer tsm_probe') {
        res.writeHead(401, { 'content-type': 'application/json' }).end('{}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(digest));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;

    home = mkdtempSync(join(tmpdir(), 'teamshare-standalone-'));
    writeFileSync(join(home, '.teamshare.json'), JSON.stringify({ url: origin, token: 'tsm_probe' }));
  });

  afterAll(async () => {
    rmSync(home, { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  });

  const run = (payload, env = {}) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [standalonePath],
        { env: { ...process.env, HOME: home, TEAMSHARE_POLL_SECONDS: '0', ...env } },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      );
      child.stdin.end(JSON.stringify(payload));
    });

  it("answers Cursor's sessionStart with the digest in the flat shape Cursor takes", async () => {
    const out = await run(
      { hook_event_name: 'sessionStart', conversation_id: 'c1', workspace_roots: ['/tmp'] },
      { TEAMSHARE_HOST: 'cursor', TEAMSHARE_HOOK_EVENT: 'sessionStart' },
    );
    const parsed = JSON.parse(out);
    // Flat additional_context, NOT Claude Code's nested hookSpecificOutput.
    expect(Object.keys(parsed)).toEqual(['additional_context']);
    expect(parsed.additional_context).toContain('Grace Hopper');
    expect(parsed.additional_context).toContain('do not merge src/auth');
  });

  it('dispatches on the payload alone when nothing tells it which event this is', async () => {
    const out = await run({ hook_event_name: 'sessionStart', conversation_id: 'c2' }, { TEAMSHARE_HOST: 'cursor' });
    expect(JSON.parse(out).additional_context).toContain('Grace Hopper');
  });

  it("still speaks Claude Code's shape, since it is assembled from those same hooks", async () => {
    const out = await run({ hook_event_name: 'SessionStart', session_id: 's1', source: 'startup', cwd: '/tmp' });
    // Bare stdout, not JSON — SessionStart's contract on Claude Code.
    expect(out).toContain('<teamshare-unread>');
    expect(out.trimStart().startsWith('{')).toBe(false);
  });

  it('says nothing on an event it has no hook for', async () => {
    const out = await run({ hook_event_name: 'afterFileEdit' }, { TEAMSHARE_HOST: 'cursor' });
    expect(out).toBe('');
  });

  it('seeds silently on the first prompt of a session, then announces what arrives after it', async () => {
    const prompt = { hook_event_name: 'beforeSubmitPrompt', conversation_id: 'p1' };
    const env = { TEAMSHARE_HOST: 'cursor', TEAMSHARE_HOOK_EVENT: 'beforeSubmitPrompt' };

    // The session digest has just shown share 11; saying it again a second
    // later would be its own kind of broken.
    expect(await run(prompt, env)).toBe('');

    digest.shares.push({
      id: 13,
      priority: 'fyi',
      sender_name: 'Alan Turing',
      what: 'prod deploy frozen until 4pm',
      age: 'just now',
      day: '2026-09-09',
      relevance: 'new',
      created_at: '2026-09-09T12:00:00Z',
    });
    digest.total = 2;

    const parsed = JSON.parse(await run(prompt, env));
    expect(Object.keys(parsed)).toEqual(['additional_context']);
    expect(parsed.additional_context).toContain('Alan Turing');
    // Only the new one. The seeded share is not re-announced.
    expect(parsed.additional_context).not.toContain('Grace Hopper');
  });

  it('exits 0 and says nothing when this machine has no credentials at all', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'teamshare-standalone-bare-'));
    try {
      const out = await run(
        { hook_event_name: 'sessionStart', conversation_id: 'c9' },
        { HOME: bare, TEAMSHARE_HOST: 'cursor' },
      );
      expect(out).toBe('');
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
