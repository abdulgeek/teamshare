import { defineConfig } from 'vitest/config';

// Test files run one at a time, deliberately.
//
// Most files here start a real HTTP server on an ephemeral port (`app.listen(0)`)
// and address it by port number alone. Run in parallel worker processes, one
// file's server can close and free a port that another file's `listen(0)` is
// then handed — so a request can reach a server belonging to a different file,
// configured differently. That surfaced twice as failures that made no sense
// against the code under test: a 403 on a route that cannot return one (only
// `maxTeams`, set in another file, produces it), and a cross-team isolation
// assertion seeing another file's data. Both passed on every re-run in
// isolation.
//
// A flaky isolation test is worse than a slow suite: it trains you to re-run
// and move on, which is exactly what you must not do with that particular
// assertion. The whole suite takes about a second and a half, so serialising
// files costs nothing measurable and removes the class outright.
//
// If this is ever revisited: the real fix is for each test server to be
// addressable by something other than a recycled port — but nothing here needs
// the parallelism badly enough to justify that.
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
