// `teamshare create-team` (the server CLI's break-glass wiring) reuses the
// exact same create/rotate/verify/join-instructions logic as the standalone
// script — the actual implementation lives in `./teamshare-team.mjs`, a
// plain, dependency-free ESM script with zero imports outside Node builtins
// and no build step, so it also runs standalone:
//
//   node teamshare-team.mjs create-team <server-url> "<team name>"
//   node teamshare-team.mjs rotate-team <server-url>
//
// That is the real first-time path (see README.md /
// docs/superpowers/specs/2026-08-29-teamshare-multi-team-design.md
// §Surfaces) — it has to work before anything else is installed. This file
// exists only so the `teamshare` CLI (built from TypeScript) and its tests
// get full type information for the exact same code; there is no second
// implementation to keep in sync. See teamshare-team.d.mts for the type
// surface.
//
// The same-directory relative import matters for packaging: it must resolve
// whether this compiles to dist/team.js (co-located with a copy of
// teamshare-team.mjs — see the package's "build" script, which copies it
// into dist/ alongside the compiled output, mirroring connect.ts/
// teamshare-connect.mjs) or runs straight from src/ under vitest.
export * from './teamshare-team.mjs';
