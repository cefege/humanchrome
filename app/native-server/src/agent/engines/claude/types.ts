/**
 * Shared types for the extracted ClaudeEngine handlers.
 *
 * `RunState` captures the per-run mutable bag that `initializeAndRun`
 * used to thread through closures. Handlers receive it by reference and
 * mutate the fields they're responsible for; the orchestrator never
 * inspects individual fields after the loop returns (except via the
 * `cleanupTempFiles` helper which reads `tempFiles`).
 */
import type { Logger } from 'pino';
import type { EngineExecutionContext } from '../types';
import type { AgentMessage, RealtimeEvent } from '../../types';

/**
 * Per-run, mutable state shared across stream-event and message-type
 * handlers. Fields that are written by exactly one handler are scoped to
 * that handler in comments below.
 */
export interface RunState {
  /** Stable session id from the caller (for outgoing message envelopes). */
  readonly sessionId: string;
  /** Stable request id from the caller. */
  readonly requestId: string;
  /** Engine name literal, stamped into message envelopes. */
  readonly cliSource: 'claude';

  /** Accumulated assistant text for the in-flight content block. */
  assistantBuffer: string;
  /** UUID for the in-flight assistant message — regenerated per message_start. */
  assistantMessageId: string | null;
  /** ISO timestamp captured at first emit for the in-flight assistant message. */
  assistantCreatedAt: string | null;
  /** Last (content, isFinal) tuple emitted for dedup. */
  lastAssistantEmitted: { content: string; isFinal: boolean } | null;

  /**
   * Tool input accumulation for streaming tool_use blocks.
   * Key: content block index, Value: { toolName, toolId, inputJson }.
   */
  readonly pendingToolInputs: Map<
    number,
    { toolName: string; toolId: string; inputJsonParts: string[] }
  >;
  /** Most recently observed content_block index (used when event.index is missing). */
  currentContentBlockIndex: number;

  /** Temp files written for image attachments, cleaned up in finally. */
  readonly tempFiles: string[];

  /** Per-run logger child, pre-bound with sessionId/requestId/projectId/model. */
  readonly runLog: Logger;
}

/**
 * Dispatcher signature for the per-run tool-message emitter. Threaded
 * into handlers so they don't reach into the engine instance directly.
 */
export type ClaudeToolDispatcher = (
  content: string,
  metadata: Record<string, unknown>,
  messageType: 'tool_use' | 'tool_result',
  isStreaming: boolean,
) => void;

/**
 * Callback used by the message-type handler to emit assistant messages
 * via the shared dedup + envelope path defined in `run-helpers.ts`.
 */
export type EmitAssistantFn = (isFinal: boolean) => void;

/**
 * Subset of `EngineExecutionContext` plus the side-channel callbacks
 * the handlers need. Kept as a thin alias so future additions stay
 * local to this file.
 */
export type HandlerContext = EngineExecutionContext;

/**
 * Argument bag for every stream-event / message-type handler. Bundles
 * the orchestrator-owned hooks so handler signatures stay short.
 */
export interface HandlerDeps {
  readonly ctx: HandlerContext;
  readonly emitAssistant: EmitAssistantFn;
  readonly dispatchToolMessage: ClaudeToolDispatcher;
}

/**
 * Re-export the AgentMessage / RealtimeEvent types for handlers that
 * need to build envelopes inline (auth_status, tool_progress).
 */
export type { AgentMessage, RealtimeEvent };
