#!/usr/bin/env node
// Copies the two standalone, dependency-free CLIs into the plugin's bin/ so
// they ship twice from ONE source file each — and assembles the plugin's two
// hooks into one standalone file for the hosts that have no plugin system at
// all.
//
// Why a copy rather than an import: the marketplace entry
// (.claude-plugin/marketplace.json) installs `./packages/plugin` and nothing
// else, so anything under packages/server is simply absent on an installed
// machine. And why bin/ at all: Claude Code puts every installed plugin's
// bin/ directory on PATH, which turns these into plain commands a slash
// command can run by name — no ${CLAUDE_PLUGIN_ROOT}, no path quoting, no
// curl, nothing to download.
//
// Drift is caught, not hoped away: packages/plugin/tests/bin-sync.test.mjs
// fails if either copy differs from its source, and names this script.
import { readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SYNCED_BINS = [
  { from: 'packages/server/src/teamshare-team.mjs', to: 'packages/plugin/bin/teamshare-team' },
  { from: 'packages/server/src/teamshare-connect.mjs', to: 'packages/plugin/bin/teamshare-connect' },
];

// ---------------------------------------------------------------------------
// The standalone hook
//
// Cursor (and anything else without a plugin system) cannot be handed a
// directory of ES modules that import each other — teamshare-connect writes
// ONE file to ~/.teamshare/hooks/ and points every hook event at it. That file
// is assembled from the same four sources the Claude Code plugin runs, so the
// two can never drift into behaving differently.
//
// Assembly is deliberately paranoid. A bundler that silently produces a file
// which parses but does nothing is the worst possible failure here: Cursor
// swallows hook output, so a broken bundle looks exactly like "no unread
// shares". Every transformation below therefore asserts what it expected to
// find and throws if the sources have moved on, which fails
// `node scripts/sync-plugin-bin.mjs` and the drift test rather than shipping
// a hook that quietly does nothing.
// ---------------------------------------------------------------------------

export const HOOK_PARTS = [
  // Order matters: the shared parts declare what the two hook parts call.
  { file: 'packages/plugin/hooks/shared.mjs', kind: 'shared' },
  { file: 'packages/plugin/hooks/hosts.mjs', kind: 'shared' },
  { file: 'packages/plugin/hooks/session-start.mjs', kind: 'hook', run: 'runSessionStart' },
  { file: 'packages/plugin/hooks/prompt-submit.mjs', kind: 'hook', run: 'runPromptSubmit' },
];

// Names the generated file declares itself. A part that ever declares one of
// these would shadow it silently, so the assembler refuses instead.
const RESERVED_NAMES = [
  'hookStdinText',
  'readAllStdin',
  'hookKind',
  'dispatch',
  ...HOOK_PARTS.filter((p) => p.run).map((p) => p.run),
];

const RULE = '─'.repeat(70);

function fail(file, message) {
  throw new Error(
    `sync-plugin-bin: cannot assemble the standalone hook.\n` +
      `  ${file}: ${message}\n` +
      `  Fix the assembler in scripts/sync-plugin-bin.mjs — never hand-edit the generated file.`,
  );
}

/** Drop the shebang; the generated file gets exactly one, at the top. */
function stripShebang(source) {
  return source.replace(/^#![^\n]*\n/, '');
}

/**
 * Lift every `import` statement out of a part.
 *
 * The imports cannot stay where they are: four files' worth of
 * `import { readFileSync } from 'node:fs'` in one module is a duplicate-binding
 * SyntaxError, and the `./shared.mjs` imports name files that will not exist
 * next to the installed hook. So they are parsed out here, merged, and re-emitted
 * once at the top of the generated file.
 */
function splitImports(source, file) {
  const statements = [];
  const body = source.replace(
    /^import\s+(?:([\s\S]*?)\s+from\s+)?(['"])([^'"]+)\2\s*;?[ \t]*\r?\n/gm,
    (_match, clause, _quote, moduleName) => {
      statements.push({ clause: String(clause ?? '').trim(), module: moduleName });
      return '';
    },
  );
  // If anything import-shaped survived, the regex above did not understand it
  // and the merged import block would be missing a binding.
  if (/^\s*import\s/m.test(body)) fail(file, 'an import statement this script cannot parse');
  return { body, statements };
}

/**
 * Turn one import clause into bindings. Only the two forms these hooks
 * actually use are accepted — a default import or an `import x, { y }` would
 * need care this does not take, so it stops rather than guesses.
 */
function parseImportClause(clause, file) {
  if (clause === '') return { named: [], namespaces: [] };
  if (clause.startsWith('{')) {
    if (!clause.endsWith('}')) fail(file, `unterminated named import clause: ${clause}`);
    const named = clause
      .slice(1, -1)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return { named, namespaces: [] };
  }
  const namespace = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(clause);
  if (namespace) return { named: [], namespaces: [namespace[1]] };
  fail(file, `unsupported import clause: ${clause}`);
}

/**
 * `export` has no meaning in a file nothing imports, and is illegal inside the
 * blocks the hook parts get wrapped in. Strip the keyword, keep the
 * declaration — and refuse any export form that is more than a keyword
 * (`export default`, `export { … }`, `export *`), since dropping one of those
 * would change what the file does.
 */
function stripExportKeywords(source, file) {
  const stripped = source.replace(
    /^export\s+(?=(?:async\s+)?function\b|const\b|let\b|var\b|class\b)/gm,
    '',
  );
  if (/^export\b/m.test(stripped)) fail(file, 'an export form this script cannot strip');
  return stripped;
}

/**
 * Remove a part's own `main().then(…)` tail.
 *
 * Both hooks end by running themselves. In one file that would mean both hooks
 * fire on every event, so each tail is removed and the dispatcher at the foot
 * of the generated file calls exactly one of them.
 */
function stripEntrypoint(source, file) {
  const at = source.lastIndexOf('\nmain()');
  if (at === -1) fail(file, 'expected a top-level `main()` call to remove');
  const tail = source.slice(at + 1);
  if (!/^main\(\)\s*\.then\([\s\S]*\);\s*$/.test(tail)) {
    fail(file, `the entrypoint is not the expected \`main().then(…)\` shape:\n${tail.trim()}`);
  }
  return source.slice(0, at + 1).replace(/\n+$/, '\n');
}

/** Top-level declarations, for the collision check between shared parts. */
function declaredNames(source) {
  const names = [];
  const re = /^(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
  for (let m = re.exec(source); m; m = re.exec(source)) names.push(m[1]);
  return names;
}

const PREAMBLE = `// One file, both hooks, and not one import of its own.
//
// Claude Code installs teamshare as a plugin and runs the hooks from inside
// it. Cursor has no plugin system, so there is no directory for a set of ES
// modules that import each other to live in: teamshare-connect writes this
// single file to ~/.teamshare/hooks/ and points every hook event at it.
//
// It is assembled by scripts/sync-plugin-bin.mjs from the four files listed
// above, and every comment in them is preserved word for word — this is the
// copy a stranger reads before letting it run on their machine, so the
// reasoning has to come with it. A test regenerates this file and fails if it
// differs, which is why hand-editing it is pointless rather than merely
// discouraged.
//
// Two things the assembly does, both forced rather than chosen:
//
//   1. Each hook's body sits inside a { block }. Both hooks name their
//      entrypoint \`main\` and their stdin reader \`readStdin\`, and duplicate
//      top-level names are a SyntaxError in an ES module — not a warning, not
//      a last-one-wins. The block gives each hook its own scope; the two
//      shared parts above them stay at the top level, because that is what
//      the hooks call into.
//
//   2. stdin can be read exactly once, and the dispatcher has to read it to
//      know which hook the event belongs to. So it reads it, and each hook's
//      own reader is repointed at those same bytes.

let hookStdinText = '';

async function readAllStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}
`;

const DISPATCH = `// ${RULE}
// Dispatch
// ${RULE}
//
// Claude Code registers one command per event and needs no dispatch at all.
// A host without a plugin system points every event at this one file, so the
// event has to be resolved here.
//
// TEAMSHARE_HOOK_EVENT wins when it is set. teamshare-connect sets it on each
// entry it writes, because it knows which event it wired that entry to — and
// that is worth more than trusting a host to name its events the way its
// documentation says it does. The payload's own event name is the fallback,
// so this file still behaves when it is run by hand, or by a host nothing
// configured.

function hookKind(name) {
  const key = String(name || '').toLowerCase().replace(/[-_]/g, '');
  if (key === 'sessionstart') return 'session-start';
  if (key === 'beforesubmitprompt' || key === 'userpromptsubmit') return 'prompt-submit';
  return '';
}

async function dispatch() {
  hookStdinText = await readAllStdin();
  let payload = {};
  try {
    payload = JSON.parse(hookStdinText);
  } catch {
    payload = {};
  }

  const host = detectHost(payload, process.env);
  const { event } = normalizePayload(payload, host);
  const kind = hookKind(process.env.TEAMSHARE_HOOK_EVENT) || hookKind(event);

  if (kind === 'session-start') return runSessionStart();
  if (kind === 'prompt-submit') return runPromptSubmit();
  // An event this file has nothing to say about. Silence, not a guess.
}

dispatch().then(
  () => process.exit(0),
  () => process.exit(0),
);
`;

/**
 * Assemble the four hook sources into one import-free file.
 *
 * @param {(repoRelativePath: string) => string} read
 * @returns {string} the exact contents of packages/plugin/hooks/standalone.mjs
 */
export function buildStandaloneHook(read) {
  /** @type {Map<string, { named: string[], namespaces: string[] }>} */
  const merged = new Map();
  const partPaths = new Set(HOOK_PARTS.map((p) => p.file));
  const topLevelNames = new Map(RESERVED_NAMES.map((n) => [n, '(the generated file itself)']));
  const sections = [];

  for (const part of HOOK_PARTS) {
    const { file, kind, run } = part;
    const { body: withoutImports, statements } = splitImports(stripShebang(read(file)), file);

    for (const { clause, module } of statements) {
      if (module.startsWith('.')) {
        // A sibling hook file: it is already in this bundle, so the import
        // goes away. An import of anything else relative would silently lose
        // code, so name it instead.
        const resolved = join(dirname(file), module).split('\\').join('/');
        if (!partPaths.has(resolved)) fail(file, `imports ${module}, which is not one of the assembled parts`);
        continue;
      }
      const { named, namespaces } = parseImportClause(clause, file);
      const entry = merged.get(module) ?? { named: [], namespaces: [] };
      for (const n of named) if (!entry.named.includes(n)) entry.named.push(n);
      for (const n of namespaces) if (!entry.namespaces.includes(n)) entry.namespaces.push(n);
      merged.set(module, entry);
    }

    let body = stripExportKeywords(withoutImports, file).trim();

    if (kind === 'shared') {
      // Shared parts stay at the top level — the hooks call into them — so
      // their declarations have to be unique across the whole file.
      for (const name of declaredNames(body)) {
        const owner = topLevelNames.get(name);
        if (owner) fail(file, `declares \`${name}\`, which ${owner} already declares`);
        topLevelNames.set(name, file);
      }
      sections.push(`// ${RULE}\n// ${file}\n// ${RULE}\n\n${body}\n`);
      continue;
    }

    // A hook part. Its own entrypoint goes; the block keeps everything else
    // out of the other hook's way.
    body = stripEntrypoint(body + '\n', file).trimEnd();
    if (!/^async function readStdin\(\) \{$/m.test(body)) {
      fail(file, 'expected `async function readStdin() {` to repoint at the already-read stdin');
    }
    if (!/^async function main\(\) \{$/m.test(body)) {
      fail(file, 'expected `async function main() {` to use as this hook\'s entrypoint');
    }

    // The block scopes this part's names away from the *other* hook's, but not
    // away from the ones the generated file declares around it. A hook part
    // that declared `hookStdinText`, or its own `runSessionStart`, would
    // block-shadow the real binding: the dispatcher would then call an
    // undefined one, the TypeError would be swallowed by
    // `dispatch().then(…, () => process.exit(0))`, and the hook would exit 0
    // having done nothing — indistinguishable, on a host that swallows hook
    // output, from "no unread shares". So the reserved names are enforced
    // against hook parts too, not only against the shared ones.
    for (const name of declaredNames(body)) {
      if (RESERVED_NAMES.includes(name)) {
        fail(file, `declares \`${name}\`, which (the generated file itself) already declares`);
      }
    }

    sections.push(
      `// ${RULE}\n// ${file}\n// ${RULE}\n\n` +
        `let ${run};\n{\n` +
        `${body}\n\n` +
        `// The dispatcher below has already drained stdin. Hand this hook the\n` +
        `// same bytes rather than let it read an exhausted stream and decide it\n` +
        `// was handed an empty payload.\n` +
        `readStdin = async () => hookStdinText;\n` +
        `${run} = main;\n}\n`,
    );
  }

  const importLines = [...merged.entries()].map(([module, { named, namespaces }]) => {
    const clauses = [
      ...namespaces.map((n) => `* as ${n}`),
      ...(named.length > 0 ? [`{ ${named.join(', ')} }`] : []),
    ];
    return `import ${clauses.join(', ')} from '${module}';`;
  });

  const header =
    '#!/usr/bin/env node\n' +
    '// GENERATED by scripts/sync-plugin-bin.mjs — do not edit.\n' +
    '// Assembled from, in order:\n' +
    HOOK_PARTS.map((p) => `//   ${p.file}\n`).join('') +
    '\n';

  return [header + importLines.join('\n') + '\n', PREAMBLE, ...sections, DISPATCH].join('\n');
}

// ---------------------------------------------------------------------------
// Embedding the standalone hook in teamshare-connect.mjs
//
// teamshare-connect is a single file people curl and run; it cannot import the
// hook, and fetching it at install time would add a failure mode and a version
// skew for nothing. So the source is spliced in between the markers below, as
// a readable template literal rather than an opaque blob — a script that
// writes an executable onto your machine should let you read what it writes.
// ---------------------------------------------------------------------------

export const HOOK_SOURCE_BEGIN = '// --- BEGIN GENERATED HOOK SOURCE (scripts/sync-plugin-bin.mjs) ---';
export const HOOK_SOURCE_END = '// --- END GENERATED HOOK SOURCE ---';

/**
 * Escape a source file so a template literal reproduces it byte for byte.
 * Backslash first, or the escapes this adds get escaped in turn.
 */
export function escapeForTemplateLiteral(source) {
  return source.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

/**
 * Replace the embedded copy in teamshare-connect.mjs with `standalone`.
 * Returns the new file contents; already-in-sync input comes back unchanged,
 * which is what the drift test asserts.
 */
export function spliceHookSource(connector, standalone) {
  const begin = connector.indexOf(HOOK_SOURCE_BEGIN);
  const end = connector.indexOf(HOOK_SOURCE_END);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(
      'sync-plugin-bin: teamshare-connect.mjs is missing the generated-hook markers\n' +
        `  expected ${HOOK_SOURCE_BEGIN}\n  and      ${HOOK_SOURCE_END}`,
    );
  }
  const block =
    `${HOOK_SOURCE_BEGIN}\n` +
    `export const TEAMSHARE_HOOK_SOURCE = \`${escapeForTemplateLiteral(standalone)}\`;\n`;
  return connector.slice(0, begin) + block + connector.slice(end);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const readPart = (f) => readFileSync(join(root, f), 'utf8');

  const standalone = buildStandaloneHook(readPart);
  const standalonePath = 'packages/plugin/hooks/standalone.mjs';
  mkdirSync(dirname(join(root, standalonePath)), { recursive: true });
  writeFileSync(join(root, standalonePath), standalone);
  chmodSync(join(root, standalonePath), 0o755);
  console.log(`assembled ${HOOK_PARTS.length} hook parts -> ${standalonePath}`);

  const connectorPath = 'packages/server/src/teamshare-connect.mjs';
  const connector = readPart(connectorPath);
  const spliced = spliceHookSource(connector, standalone);
  if (spliced !== connector) {
    writeFileSync(join(root, connectorPath), spliced);
    console.log(`embedded ${standalonePath} -> ${connectorPath}`);
  }

  // After the splice, never before: the bin copy must carry the embedded hook.
  for (const { from, to } of SYNCED_BINS) {
    const source = readFileSync(join(root, from));
    mkdirSync(dirname(join(root, to)), { recursive: true });
    writeFileSync(join(root, to), source);
    chmodSync(join(root, to), 0o755);
    console.log(`synced ${from} -> ${to}`);
  }
}
