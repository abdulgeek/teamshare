# teamshare v2 — Tool Integrations

**Date:** 2026-08-29
**Status:** Design, not yet implemented. v1 (the shared-context loop) is built and on `feat/teamshare`.

## Why this is a separate document

The user asked for four integration directions. One of them shipped in v1
because it needs no credentials; the other three each require teamshare to
hold secrets or to become infrastructure, which is a different kind of
system than v1 is. Building them badly — a Slack token sitting unencrypted
in the same SQLite file as the shares — would be worse than not building
them, so they are specified here rather than rushed.

| Direction | Status |
|---|---|
| **Enrich shares (pull in)** | **Shipped in v1.** No credentials, no schema change. |
| Broadcast out (push to Slack/Jira) | Specified below, §2. Needs secret management. |
| teamshare as a shared tool hub | Specified below, §3. Largest; teamshare becomes infrastructure. |
| Cross-agent reach (Codex/Cursor) | Specified below, §4. Mostly adapters and testing. |

## 1. Enrich shares — shipped, for reference

A share names a concrete identifier (`PROJ-123`, a PR URL, a commit SHA).
When a teammate asks for detail, their agent resolves it with **their own**
already-configured connectors. teamshare stores no tokens and gained no
fields; the whole feature is a rule in the `share-format` skill and in
`read_share`/the hook.

The safety limit is load-bearing and must survive any future edit: only
well-formed identifiers may be resolved — a ticket key, a repo/PR reference,
a commit SHA — never an arbitrary URL or host appearing in share text, and
the share's contents are never sent to an external service. Share text is
untrusted teammate input; it may name a thing to look up, but it never
dictates what the agent does. Without that limit, a share becomes a channel
for making every teammate's agent fetch an attacker-chosen URL.

## 2. Broadcast out — push shares to Slack and Jira

**Goal:** teammates who are not in Claude Code still see what was shared.

**Shape.** Per-team outbound *channels*, configured server-side, each
subscribing to a filter over shares (by priority, by tag, or all).

```
channels (id PK, kind /*slack|jira|webhook*/, config JSON,
          min_priority, tag_filter, created_by, created_at, enabled)
deliveries (share_id, channel_id, status, attempts, last_error, at,
            PRIMARY KEY (share_id, channel_id))
```

**Secrets are the whole problem.** A Slack bot token in the shares database
is a credential with a much larger blast radius than the team token: it can
read and post across a workspace. Requirements:

- Secrets live **outside** the shares DB, read from the process environment
  or a file the server reads at boot (`TEAMSHARE_SLACK_TOKEN`). The
  `channels.config` row holds only non-secret routing (channel id, project
  key) and a *reference* to which env var supplies the secret.
- Secrets are never returned by any MCP tool, never logged, and never
  included in `doctor` output. The existing rule that `serve` prints the
  team token only on first mint applies here with no exceptions at all.
- A channel misconfiguration must fail loudly at boot, not silently at the
  first share.

**Delivery is asynchronous and must not block `share`.** The `share` tool
returns as it does today; delivery is attempted after commit, retried with
backoff, and recorded in `deliveries`. A dead Slack webhook must never make
publishing a share fail — v1's whole promise is that the shared memory keeps
working.

**Outbound content is a leak surface.** A share is internal-by-default. The
spec's v1 trust model says share text is untrusted *input*; pushing it
outward makes it untrusted *output* too. Therefore: an explicit
`broadcast: true` on the share, or an explicit per-channel filter the team
configured, is required — never a default that ships every share to Slack.

**New MCP tools:** `list_channels`, `add_channel`, `remove_channel`,
`delivery_status(share_id)`. Channel management is admin-shaped; with v1's
single shared token every member is an admin, which is acceptable only
because §5 is honest about it.

## 3. teamshare as a shared tool hub

**Goal:** one teamshare install gives the whole team the same toolset —
Jira, GitHub, Slack — without each engineer configuring anything.

**Shape.** teamshare's MCP server aggregates other MCP servers and
re-exposes their tools under a namespace (`jira__create_issue`). The server
holds one upstream connection per configured backend and proxies calls,
attaching its own credentials.

**This is the largest of the three and changes what teamshare is.** v1 is a
small, self-hosted note store; this makes it the team's credential broker
and a single point of failure for every tool. Consequences to accept
before starting:

- Every proxied call runs with **teamshare's** credentials, not the calling
  engineer's, so per-user permissions in Jira/GitHub are erased. Every
  member gets the union of what the service account can do. For a small
  trusted team that may be fine; it must be a deliberate choice, and
  `receipts`-style attribution should record which member invoked a tool.
- The v1 identity model (client-asserted, advisory) is too weak to gate
  destructive proxied tools. If this direction is taken, per-user tokens
  (currently out of scope) become a prerequisite, not an optional upgrade.
- Aggregating an upstream's tool descriptions imports **their** text into
  every member's context. Upstream tool descriptions must be treated as
  untrusted data with the same fencing v1 applies to share text.

**Recommendation:** do §2 first. It delivers most of the practical value
(teammates outside Claude see shares) at a fraction of the risk. Reach for
§3 only if the team genuinely wants centralized tool access, and pair it
with per-user tokens.

## 4. Cross-agent reach — Codex, Cursor, and others

**Mostly already true.** The core is plain MCP over Streamable HTTP with no
Claude-specific assumptions; the Claude Code plugin is a thin adapter. The
server already sets its `instructions` field to tell any connected client to
call `unread` at conversation start, which is the portable fallback for
clients without a session-start hook.

**What is actually left:**
- A per-agent adapter providing the equivalent of the SessionStart hook. The
  work is small — read `~/.teamshare.json`, call `GET /unread`, inject the
  digest — and the fence/receipt rules must be copied exactly, including the
  "record receipts only for shares the user explicitly answered" rule.
- The `neutralizeFences` copy problem gets worse with each adapter. Before
  the second adapter exists, extract the fence logic into one small shared
  module that every adapter vendors from a single source, rather than three
  hand-maintained copies drifting apart.
- Testing against a real second agent, which v1 never did.

## 5. What must stay true

Whatever gets built here, these v1 properties are not negotiable:

- **Share text is untrusted data everywhere it surfaces**, inside an
  unpredictable per-render fence. Any new surface that emits teammate text —
  a Slack message, a proxied tool result, another agent's digest — inherits
  this.
- **A broken integration never breaks the core loop.** Sharing and reading
  must keep working when Slack, Jira, or an upstream MCP server is down.
- **No credential is ever printed, logged, returned by a tool, or placed on
  a command line.**
- **Failures are loud.** v1's biggest weakness was that every delivery
  failure was silent; `teamshare doctor` exists because of it. Every
  integration added here extends `doctor` with a check, or it is not done.
