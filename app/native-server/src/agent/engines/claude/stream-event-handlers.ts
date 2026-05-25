/**
 * Stream-event handlers for the Claude SDK `stream_event` message family.
 *
 * One handler per `event.type` value the orchestrator dispatches on:
 *   - message_start      → reset assistant accumulator + ids
 *   - content_block_start → register pending tool_use, or emit tool_result
 *   - content_block_delta → accumulate tool input JSON or assistant text
 *   - content_block_stop  → finalize tool_use, or emit tool_result
 *   - message_delta       → no-op (metadata only)
 *   - message_stop        → emit final assistant message
 *
 * Handlers are intentionally side-effect-only: they mutate `state` and
 * call `deps.emitAssistant` / `deps.dispatchToolMessage`. Anything pure
 * (action inference, metadata building) lives in `tool-metadata.ts`.
 */
import { randomUUID } from 'node:crypto';
import {
  pickFirstString,
  buildToolResultMetadata,
  extractToolResultContent,
} from './extractors';
import { buildToolMetadata } from './tool-metadata';
import type { HandlerDeps, RunState } from './types';

/**
 * Handle `stream_event` of type `message_start`.
 * Resets the assistant accumulator for a fresh message.
 */
export function handleMessageStart(state: RunState): void {
  state.assistantBuffer = '';
  state.assistantMessageId = randomUUID();
  state.assistantCreatedAt = new Date().toISOString();
  state.lastAssistantEmitted = null;
}

/**
 * Handle `stream_event` of type `content_block_start`.
 * - `tool_use` blocks register a pending input accumulator (emit deferred
 *   to `content_block_stop` so we have the full input).
 * - `tool_result` blocks emit immediately.
 */
export function handleContentBlockStart(
  state: RunState,
  event: Record<string, unknown>,
  deps: HandlerDeps,
): void {
  const contentBlock = event.content_block as Record<string, unknown> | undefined;
  const blockIndex =
    typeof event.index === 'number' ? event.index : ++state.currentContentBlockIndex;
  state.currentContentBlockIndex = blockIndex;

  if (contentBlock && contentBlock.type === 'tool_use') {
    const toolName = pickFirstString(contentBlock.name) || 'tool';
    const toolId = pickFirstString(contentBlock.id) || '';

    // Store pending tool input for accumulation
    // Don't emit message here - wait for content_block_stop with complete input
    state.pendingToolInputs.set(blockIndex, {
      toolName,
      toolId,
      inputJsonParts: [],
    });
  } else if (contentBlock && contentBlock.type === 'tool_result') {
    // Handle tool_result in content_block_start
    const metadata = buildToolResultMetadata(contentBlock);
    const content = extractToolResultContent(contentBlock);
    const isError = contentBlock.is_error === true;

    deps.dispatchToolMessage(
      isError
        ? `Error: ${content || 'Tool execution failed'}`
        : content || 'Tool completed',
      metadata,
      'tool_result',
      false,
    );
  }
}

/**
 * Handle `stream_event` of type `content_block_stop`.
 * Finalizes a pending tool_use (parses accumulated JSON, builds metadata,
 * emits the tool_use message), or emits a terminal tool_result.
 */
export function handleContentBlockStop(
  state: RunState,
  event: Record<string, unknown>,
  deps: HandlerDeps,
): void {
  const blockIndex =
    typeof event.index === 'number' ? event.index : state.currentContentBlockIndex;

  // Check if we have accumulated tool input for this block
  if (state.pendingToolInputs.has(blockIndex)) {
    const pending = state.pendingToolInputs.get(blockIndex)!;
    state.pendingToolInputs.delete(blockIndex);

    // Parse the accumulated JSON
    const fullJsonStr = pending.inputJsonParts.join('');
    let input: Record<string, unknown> = {};
    try {
      if (fullJsonStr) {
        input = JSON.parse(fullJsonStr);
      }
    } catch (e) {
      state.runLog.warn(
        { err: e instanceof Error ? e.message : String(e) },
        'failed to parse tool input JSON',
      );
    }

    // Gate the JSON.stringify on level enablement — without the guard the
    // serialize runs even when debug is disabled, costing per-event on
    // streams with large tool inputs.
    if (state.runLog.isLevelEnabled?.('debug')) {
      state.runLog.debug(
        {
          toolName: pending.toolName,
          inputPreview: JSON.stringify(input).slice(0, 500),
        },
        'content_block_stop',
      );
    }

    // Build metadata with full input
    const metadata = buildToolMetadata({
      name: pending.toolName,
      id: pending.toolId,
      input,
    });

    // Build informative content
    let content = `Using tool: ${pending.toolName}`;
    if (input.command) content = `Running: ${input.command}`;
    else if (input.file_path) content = `Operating on: ${input.file_path}`;
    else if (input.pattern) content = `Searching: ${input.pattern}`;
    else if (input.query) content = `Searching: ${input.query}`;

    // Emit final tool_use message with complete metadata
    deps.dispatchToolMessage(content, metadata, 'tool_use', false);
  }

  // Check if this block was a tool_result
  const contentBlock = event.content_block as Record<string, unknown> | undefined;
  if (contentBlock && contentBlock.type === 'tool_result') {
    const metadata = buildToolResultMetadata(contentBlock);
    const content = extractToolResultContent(contentBlock);
    const isError = contentBlock.is_error === true;

    deps.dispatchToolMessage(
      isError
        ? `Error: ${content || 'Tool execution failed'}`
        : content || 'Tool completed',
      metadata,
      'tool_result',
      false,
    );
  }
}

/**
 * Handle `stream_event` of type `content_block_delta`.
 * - `input_json_delta` deltas append to the pending tool-use JSON buffer.
 * - All other text-shaped deltas append to the assistant buffer and
 *   trigger a streaming emit.
 */
export function handleContentBlockDelta(
  state: RunState,
  event: Record<string, unknown>,
  deps: HandlerDeps,
): void {
  const delta = event.delta as Record<string, unknown> | string | undefined;
  const blockIndex =
    typeof event.index === 'number' ? event.index : state.currentContentBlockIndex;

  // Check if this is a tool_use input_json_delta
  if (delta && typeof delta === 'object' && delta.type === 'input_json_delta') {
    const partialJson = delta.partial_json as string | undefined;
    if (partialJson && state.pendingToolInputs.has(blockIndex)) {
      state.pendingToolInputs.get(blockIndex)!.inputJsonParts.push(partialJson);
    }
    return;
  }

  // Handle text delta for assistant messages
  let textChunk = '';

  if (typeof delta === 'string') {
    textChunk = delta;
  } else if (delta && typeof delta === 'object') {
    if (typeof delta.text === 'string') {
      textChunk = delta.text;
    } else if (typeof delta.delta === 'string') {
      textChunk = delta.delta;
    } else if (typeof delta.partial === 'string') {
      textChunk = delta.partial;
    }
  }

  if (textChunk) {
    state.assistantBuffer += textChunk;
    deps.emitAssistant(false);
  }
}

/**
 * Handle `stream_event` of type `message_stop`.
 * Emits the final assistant message (idempotent via dedup in emitAssistant).
 */
export function handleMessageStop(_state: RunState, deps: HandlerDeps): void {
  deps.emitAssistant(true);
}

/**
 * Top-level dispatcher for the `stream_event` family. Returns silently
 * for unrecognized event types (including `message_delta`, which is
 * intentionally a no-op — metadata-only delta).
 */
export function handleStreamEvent(
  eventType: string | undefined,
  event: Record<string, unknown>,
  state: RunState,
  deps: HandlerDeps,
): void {
  switch (eventType) {
    case 'message_start':
      handleMessageStart(state);
      return;
    case 'content_block_start':
      handleContentBlockStart(state, event, deps);
      return;
    case 'content_block_stop':
      handleContentBlockStop(state, event, deps);
      return;
    case 'content_block_delta':
      handleContentBlockDelta(state, event, deps);
      return;
    case 'message_delta':
      // metadata-only delta; nothing to emit here
      return;
    case 'message_stop':
      handleMessageStop(state, deps);
      return;
    default:
      // Other stream events are ignored
      return;
  }
}
