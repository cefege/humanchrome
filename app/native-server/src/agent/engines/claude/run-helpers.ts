/**
 * Run-scoped helpers extracted from `ClaudeEngine.initializeAndRun`.
 *
 * Each function operates on the shared `RunState` and is intentionally
 * free-standing so unit tests can drive them with synthetic state. The
 * legacy closures (`emitAssistant`, `cleanupTempFiles`) used to capture
 * `sessionId` / `requestId` / `ctx.emit` via closure scope; here they
 * accept those inputs explicitly.
 */
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { AgentMessage } from '../../types';
import type { EngineExecutionContext } from '../types';
import type { RunState } from './types';

/**
 * Build a fresh per-run state bag at the top of `initializeAndRun`.
 */
export function createRunState(input: {
  sessionId: string;
  requestId: string;
  runLog: Logger;
}): RunState {
  return {
    sessionId: input.sessionId,
    requestId: input.requestId,
    cliSource: 'claude',
    assistantBuffer: '',
    assistantMessageId: null,
    assistantCreatedAt: null,
    lastAssistantEmitted: null,
    pendingToolInputs: new Map(),
    currentContentBlockIndex: -1,
    tempFiles: [],
    runLog: input.runLog,
  };
}

/**
 * Emit assistant message to the stream, deduplicating against the
 * previous `(content, isFinal)` tuple so identical final emissions are
 * suppressed.
 */
export function emitAssistantMessage(
  state: RunState,
  ctx: EngineExecutionContext,
  isFinal: boolean,
): void {
  const content = state.assistantBuffer.trim();
  if (!content) return;

  // Deduplicate: skip if same content and isFinal state was already emitted
  if (
    state.lastAssistantEmitted &&
    state.lastAssistantEmitted.content === content &&
    state.lastAssistantEmitted.isFinal === isFinal
  ) {
    return;
  }
  state.lastAssistantEmitted = { content, isFinal };

  if (!state.assistantMessageId) {
    state.assistantMessageId = randomUUID();
  }
  if (!state.assistantCreatedAt) {
    state.assistantCreatedAt = new Date().toISOString();
  }

  const message: AgentMessage = {
    id: state.assistantMessageId,
    sessionId: state.sessionId,
    role: 'assistant',
    content,
    messageType: 'chat',
    cliSource: state.cliSource,
    requestId: state.requestId,
    isStreaming: !isFinal,
    isFinal,
    createdAt: state.assistantCreatedAt,
  };

  ctx.emit({ type: 'message', data: message });
}

/**
 * Best-effort cleanup for temp files written during image-attachment
 * fallback. Always called in the orchestrator's `finally` block, so it
 * must never throw — individual file failures are logged and swallowed.
 */
export async function cleanupTempFiles(state: RunState): Promise<void> {
  if (state.tempFiles.length === 0) return;

  try {
    const fs = await import('node:fs/promises');
    for (const filePath of state.tempFiles) {
      try {
        await fs.unlink(filePath);
        state.runLog.debug({ filePath }, 'cleaned up temp file');
      } catch (err) {
        // Best-effort cleanup; ignore failures (file may already be deleted)
        state.runLog.warn(
          { filePath, err: err instanceof Error ? err.message : String(err) },
          'failed to cleanup temp file',
        );
      }
    }
  } catch (err) {
    state.runLog.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'failed to cleanup temp files',
    );
  }
}
