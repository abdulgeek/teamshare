// `teamshare connect` — writes the MCP server config for every AI coding
// assistant it can detect on this machine, so joining the team's shared
// context is one command instead of a per-tool manual edit.
//
// The actual implementation lives in `./teamshare-connect.mjs` — a plain,
// dependency-free ESM script with zero imports outside Node builtins and no
// build step, so it also runs standalone:
//
//   node teamshare-connect.mjs <server-url> <team-token>
//
// That is the primary path for every assistant other than Claude Code (see
// README.md) — no clone-and-build required. This file exists only so the
// `teamshare` CLI (built from TypeScript) and its tests get full type
// information for the exact same code; there is no second implementation to
// keep in sync. See teamshare-connect.d.mts for the type surface.
//
// The same-directory relative import matters for packaging: it must resolve
// whether this compiles to dist/connect.js (co-located with a copy of
// teamshare-connect.mjs — see the package's "build" script, which copies it
// into dist/ alongside the compiled output) or runs straight from src/ under
// vitest. A parent-directory import would break the moment dist/ is
// relocated or published on its own.
export * from './teamshare-connect.mjs';
