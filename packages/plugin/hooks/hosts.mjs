// The only host-specific parts of a teamshare hook: what the payload is
// called, and what shape the response takes.
//
// Verified per host rather than assumed — see
// docs/superpowers/specs/2026-09-09-cursor-hook-contract.md. Cursor's own
// published docs say beforeSubmitPrompt cannot inject context; the validator
// shipped in Cursor 3.19.10 says otherwise, and the probe in Task 1 settles
// which is true. Codex's own contract is verified the same way — see that
// document's "Codex" section: a live `codex exec` run, with a real hooks.json
// under an isolated CODEX_HOME, confirmed the wire shape below by watching
// Codex accept it (no "invalid ... JSON output" warning, hook reported
// Completed) rather than by reading a claim about it.

const CURSOR_EVENTS = new Set([
  'sessionStart', 'beforeSubmitPrompt', 'stop', 'postToolUse', 'afterFileEdit',
]);

export function detectHost(payload = {}, env = {}) {
  // An explicit override always wins: the connector sets it, so a host we
  // have never seen renders correctly instead of silently getting Claude
  // Code's shape and injecting nothing.
  const forced = String(env.TEAMSHARE_HOST || '').trim();
  if (forced) return forced;
  const event = String(payload.hook_event_name || '');
  if (CURSOR_EVENTS.has(event)) return 'cursor';
  return 'claude-code';
}

export function normalizePayload(payload = {}, host = 'claude-code') {
  const sessionId =
    (host === 'cursor' ? payload.conversation_id : payload.session_id) ||
    payload.session_id ||
    payload.conversation_id ||
    'unknown';
  const cwd = Array.isArray(payload.workspace_roots)
    ? payload.workspace_roots[0]
    : payload.cwd;
  return { sessionId: String(sessionId), event: String(payload.hook_event_name || ''), cwd };
}

export function renderResponse({ host, event, context, userMessage }) {
  if (!context) return '';
  if (host === 'claude-code') {
    // SessionStart takes bare stdout as context; UserPromptSubmit takes JSON.
    if (event === 'session-start') return `${context}\n`;
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context },
      ...(userMessage ? { systemMessage: userMessage } : {}),
    });
  }
  if (host === 'codex') {
    // Codex is not Cursor with different event names — its hook runtime is a
    // near-verbatim port of Claude Code's, deserializing the same
    // hookSpecificOutput envelope with the same hookEventName/additionalContext
    // fields (confirmed live, not inferred from Cursor's shape or from
    // claude-mem's guess — see the "Codex" section of the doc cited above).
    // Unlike Claude Code, a bare-stdout SessionStart was never exercised, so
    // both events use the one shape that was actually watched work.
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: event === 'session-start' ? 'SessionStart' : 'UserPromptSubmit',
        additionalContext: context,
      },
    });
  }
  // Cursor takes a flat additional_context. It has no channel for a
  // user-visible line, so userMessage is dropped rather than smuggled into
  // the model's context where it would read as an instruction.
  return JSON.stringify({ additional_context: context });
}
