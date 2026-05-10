/**
 * Locks the realtime envelope shape (role=tool, cliSource=codex,
 * metadata.cli_type=codex, isStreaming/isFinal flags), the per-scope
 * dedup contract, and the trim-empty short-circuit so future refactors
 * don't silently flip what the sidepanel UI sees.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { CodexEngine } from './codex';

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
  const engine = new CodexEngine();
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

describe('CodexEngine.dispatchToolMessageRun', () => {
  it('emits a realtime message with the codex envelope shape', async () => {
    const { scope, dispatch } = setup({ sessionId: 'sess-A', requestId: 'req-1' });
    dispatch('hello world', { tool: 'plan' }, 'tool_use', false);

    expect(scope.emit).toHaveBeenCalledTimes(1);
    const event = scope.emit.mock.calls[0][0];
    expect(event.type).toBe('message');
    expect(event.data.role).toBe('tool');
    expect(event.data.content).toBe('hello world');
    expect(event.data.messageType).toBe('tool_use');
    expect(event.data.cliSource).toBe('codex');
    expect(event.data.sessionId).toBe('sess-A');
    expect(event.data.requestId).toBe('req-1');
    expect(event.data.isStreaming).toBe(false);
    expect(event.data.isFinal).toBe(true);
    expect(event.data.metadata.cli_type).toBe('codex');
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

  it('treats different metadata as different messages (no false-positive dedup)', async () => {
    const { scope, dispatch } = setup();
    dispatch('payload', { k: 1 }, 'tool_use', false);
    dispatch('payload', { k: 2 }, 'tool_use', false);
    expect(scope.emit).toHaveBeenCalledTimes(2);
  });

  it('treats undefined requestId the same as empty string for hashing (so dedup still works)', async () => {
    const { scope, dispatch } = setup({ sessionId: 'sess-C' });
    // requestId left undefined
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
