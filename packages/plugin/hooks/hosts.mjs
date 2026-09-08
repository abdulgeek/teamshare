// The only host-specific parts of a teamshare hook: what the payload is
// called, and what shape the response takes.
//
// Verified per host rather than assumed — see
// docs/superpowers/specs/2026-09-09-cursor-hook-contract.md. Cursor's own
// published docs say beforeSubmitPrompt cannot inject context; the validator
// shipped in Cursor 3.19.10 says otherwise, and the probe in Task 1 settles
// which is true.

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
  // Cursor and Codex both take additional_context. Neither has a channel for
  // a user-visible line, so userMessage is dropped rather than smuggled into
  // the model's context where it would read as an instruction.
  return JSON.stringify({ additional_context: context });
}
