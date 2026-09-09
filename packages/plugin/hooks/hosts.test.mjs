import { describe, it, expect } from 'vitest';
import { detectHost, normalizePayload, renderResponse } from './hosts.mjs';

describe('detectHost', () => {
  it('reads Claude Code from its own payload', () => {
    expect(detectHost({ hook_event_name: 'SessionStart', source: 'startup' }, {})).toBe('claude-code');
  });

  it('reads Cursor from its camelCase event names', () => {
    expect(detectHost({ hook_event_name: 'sessionStart', conversation_id: 'c1' }, {})).toBe('cursor');
    expect(detectHost({ hook_event_name: 'beforeSubmitPrompt' }, {})).toBe('cursor');
  });

  it('trusts an explicit override over inference', () => {
    // The connector writes hooks with TEAMSHARE_HOST set, so a host whose
    // payload we have never seen still renders correctly rather than
    // silently falling back to Claude Code's shape.
    expect(detectHost({ hook_event_name: 'sessionStart' }, { TEAMSHARE_HOST: 'codex' })).toBe('codex');
  });
});

describe('normalizePayload', () => {
  it('finds the session id under each host\'s own name', () => {
    expect(normalizePayload({ session_id: 's1' }, 'claude-code').sessionId).toBe('s1');
    expect(normalizePayload({ conversation_id: 'c1' }, 'cursor').sessionId).toBe('c1');
  });

  it('falls back to a stable placeholder rather than undefined', () => {
    // sessionId keys the poll state. `undefined` there would make every
    // prompt look like a new session and re-seed forever.
    expect(normalizePayload({}, 'cursor').sessionId).toBe('unknown');
  });

  it('takes cwd from workspace_roots on Cursor', () => {
    expect(normalizePayload({ workspace_roots: ['/repo/a', '/repo/b'] }, 'cursor').cwd).toBe('/repo/a');
  });
});

describe('renderResponse', () => {
  it('writes bare text for a Claude Code session start', () => {
    expect(renderResponse({ host: 'claude-code', event: 'session-start', context: 'HELLO' })).toBe('HELLO\n');
  });

  it('wraps a Claude Code prompt-submit in hookSpecificOutput', () => {
    const out = JSON.parse(renderResponse({
      host: 'claude-code', event: 'prompt-submit', context: 'HELLO', userMessage: 'note',
    }));
    expect(out.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(out.hookSpecificOutput.additionalContext).toBe('HELLO');
    expect(out.systemMessage).toBe('note');
  });

  it('uses additional_context for Cursor, on both events', () => {
    for (const event of ['session-start', 'prompt-submit']) {
      const out = JSON.parse(renderResponse({ host: 'cursor', event, context: 'HELLO' }));
      expect(out.additional_context).toBe('HELLO');
      // Cursor has no systemMessage channel; a stray field must not appear.
      expect(out.systemMessage).toBeUndefined();
    }
  });

  it('wraps Codex in hookSpecificOutput on both events, unlike Cursor', () => {
    // Confirmed live against a real `codex exec` run (see the "Codex" section
    // of docs/superpowers/specs/2026-09-09-cursor-hook-contract.md): Codex's
    // hook deserializer is Claude Code's, not Cursor's, so it wants the nested
    // envelope even though `detectHost` would otherwise group it with Cursor.
    const start = JSON.parse(renderResponse({ host: 'codex', event: 'session-start', context: 'HELLO' }));
    expect(start.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(start.hookSpecificOutput.additionalContext).toBe('HELLO');

    const submit = JSON.parse(renderResponse({ host: 'codex', event: 'prompt-submit', context: 'HELLO' }));
    expect(submit.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(submit.hookSpecificOutput.additionalContext).toBe('HELLO');
  });

  it('writes nothing at all when there is nothing to say', () => {
    expect(renderResponse({ host: 'cursor', event: 'session-start', context: '' })).toBe('');
    expect(renderResponse({ host: 'claude-code', event: 'session-start', context: '' })).toBe('');
  });

  it('renders the token-rejected notice as valid output on every host', () => {
    // The 401 branch of session-start.mjs used to write a bare line. That is
    // fine on Claude Code and malformed JSON on Cursor — the hook would break
    // exactly when it had something important to say.
    const notice = 'teamshare: server rejected this machine — reconfigure via /plugin';
    expect(renderResponse({ host: 'claude-code', event: 'session-start', context: notice })).toBe(`${notice}\n`);
    expect(JSON.parse(renderResponse({ host: 'cursor', event: 'session-start', context: notice })))
      .toEqual({ additional_context: notice });
  });
});
