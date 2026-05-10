/**
 * Locks the realtime envelope shape (role=tool, cliSource=claude,
 * metadata.cli_type=claude, isStreaming/isFinal flags), the per-scope
 * dedup contract, and the trim-empty short-circuit. Slice 3 of IMP-0009
 * mirrors IMP-0049 slice 3; this test file mirrors codex's
 * `codex.dispatch-tool-message.test.ts`.
 *
 * Includes a regression test for the dedup-hash collision bug surfaced
 * during the codex slice — `{k:1}` vs `{k:2}` no longer collide on the
 * 16-char base64 prefix because we now use the full hash.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { ClaudeEngine } from './claude';

interface Scope {
  sessionId: string;
  requestId?: string;
  streamedToolHashes: Set<string>;
  emit: jest.Mock<(event: { type: string; data: any }) => void>;
}

function setup(overrides: Partial<{ sessionId: string; requestId: string }> = {}): {
  scope: Scope;
  dispatch: (
    content: string,
    metadata: Record<string, unknown>,
    messageType: 'tool_use' | 'tool_result',
    isStreaming: boolean,
  ) => void;
} {
  const engine = new ClaudeEngine();
  const scope: Scope = {
    sessionId: overrides.sessionId ?? 'sess-1',
    requestId: overrides.requestId,
    streamedToolHashes: new Set<string>(),
    emit: jest.fn(),
  };
  const dispatch = (
    content: string,
    metadata: Record<string, unknown>,
    messageType: 'tool_use' | 'tool_result',
    isStreaming: boolean,
  ): void => {
    (
      engine as unknown as {
        dispatchToolMessageRun: (
          s: Scope,
          c: string,
          m: Record<string, unknown>,
          mt: 'tool_use' | 'tool_result',
          isStreaming: boolean,
        ) => void;
      }
    ).dispatchToolMessageRun(scope, content, metadata, messageType, isStreaming);
  };
  return { scope, dispatch };
}

describe('ClaudeEngine.dispatchToolMessageRun', () => {
  it('emits a realtime message with the claude envelope shape', async () => {
    const { scope, dispatch } = setup({ sessionId: 'sess-A', requestId: 'req-1' });
    dispatch('hello world', { tool: 'plan' }, 'tool_use', false);

    expect(scope.emit).toHaveBeenCalledTimes(1);
    const event = scope.emit.mock.calls[0][0];
    expect(event.type).toBe('message');
    expect(event.data.role).toBe('tool');
    expect(event.data.content).toBe('hello world');
    expect(event.data.messageType).toBe('tool_use');
    expect(event.data.cliSource).toBe('claude');
    expect(event.data.sessionId).toBe('sess-A');
    expect(event.data.requestId).toBe('req-1');
    expect(event.data.isStreaming).toBe(false);
    expect(event.data.isFinal).toBe(true);
    expect(event.data.metadata.cli_type).toBe('claude');
    expect(event.data.metadata.tool).toBe('plan');
    expect(typeof event.data.id).toBe('string');
    expect(typeof event.data.createdAt).toBe('string');
  });

  it('isStreaming=true sets isFinal=false', async () => {
    const { scope, dispatch } = setup();
    dispatch('chunk', {}, 'tool_use', true);
    expect(scope.emit.mock.calls[0][0].data.isStreaming).toBe(true);
    expect(scope.emit.mock.calls[0][0].data.isFinal).toBe(false);
  });

  it('messageType=tool_result is forwarded as-is', async () => {
    const { scope, dispatch } = setup();
    dispatch('done', {}, 'tool_result', false);
    expect(scope.emit.mock.calls[0][0].data.messageType).toBe('tool_result');
  });

  it('trims whitespace-only content and short-circuits without emitting', async () => {
    const { scope, dispatch } = setup();
    dispatch('   \n\t  ', {}, 'tool_use', false);
    expect(scope.emit).not.toHaveBeenCalled();
    expect(scope.streamedToolHashes.size).toBe(0);
  });

  it('dedupes identical (content, metadata, messageType) payloads within the same scope', async () => {
    const { scope, dispatch } = setup({ sessionId: 'sess-B' });
    dispatch('payload', { k: 1 }, 'tool_use', false);
    dispatch('payload', { k: 1 }, 'tool_use', false);
    dispatch('payload', { k: 1 }, 'tool_use', false);
    expect(scope.emit).toHaveBeenCalledTimes(1);
  });

  it('does NOT dedupe across different scopes (per-run state is isolated)', async () => {
    const a = setup({ sessionId: 'sess-A' });
    const b = setup({ sessionId: 'sess-B' });
    a.dispatch('payload', { k: 1 }, 'tool_use', false);
    b.dispatch('payload', { k: 1 }, 'tool_use', false);
    expect(a.scope.emit).toHaveBeenCalledTimes(1);
    expect(b.scope.emit).toHaveBeenCalledTimes(1);
  });

  it('treats different metadata as different messages (full-hash regression)', async () => {
    const { scope, dispatch } = setup();
    dispatch('payload', { k: 1 }, 'tool_use', false);
    dispatch('payload', { k: 2 }, 'tool_use', false);
    expect(scope.emit).toHaveBeenCalledTimes(2);
  });

  it('treats undefined requestId the same as empty string for hashing (so dedup still works)', async () => {
    const { scope, dispatch } = setup({ sessionId: 'sess-C' });
    dispatch('p', {}, 'tool_use', false);
    dispatch('p', {}, 'tool_use', false);
    expect(scope.emit).toHaveBeenCalledTimes(1);
  });

  it('records the dedup hash on the scope (caller can inspect / reset)', async () => {
    const { scope, dispatch } = setup();
    expect(scope.streamedToolHashes.size).toBe(0);
    dispatch('first', {}, 'tool_use', false);
    expect(scope.streamedToolHashes.size).toBe(1);
    dispatch('second', {}, 'tool_use', false);
    expect(scope.streamedToolHashes.size).toBe(2);
  });
});
