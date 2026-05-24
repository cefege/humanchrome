/**
 * Pure extractors lifted out of `ClaudeEngine` so the stream-event and
 * message-type handlers can be unit-testable without instantiating the
 * engine. None of these depend on per-run state; they accept SDK payloads
 * and return primitives or plain objects.
 *
 * Behavioural parity: each function is a byte-for-byte port of the
 * previous engine-method equivalent. Do NOT diverge from the codex
 * variants — the base-class comments explicitly call out the recursion
 * difference (claude does NOT recurse into objects in `pickFirstString`;
 * codex does), and we are preserving that intentional split.
 */

/**
 * Pick first string value from unknown input.
 *
 * Recurses into arrays but not into objects, matching the historical
 * claude-only semantics.
 */
export function pickFirstString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const candidate = pickFirstString(entry);
      if (candidate) return candidate;
    }
    return undefined;
  }
  return undefined;
}

/**
 * Extract content from SDK message.
 * Handles various message structures from Claude Agent SDK:
 * - result.result (final result text)
 * - assistant.message (nested message content)
 * - content/text (direct content fields)
 * - content[] (array of content blocks)
 *
 * @param message - The message object to extract content from
 * @param depth - Current recursion depth (max 3 to prevent infinite loops)
 */
export function extractMessageContent(message: unknown, depth = 0): string | undefined {
  // Prevent infinite recursion
  if (depth > 3 || !message || typeof message !== 'object') return undefined;
  const record = message as Record<string, unknown>;

  // Handle result message: result field contains final text
  if (typeof record.result === 'string') {
    return record.result.trim();
  }

  // Handle assistant message: message field may contain nested content
  if (record.message && typeof record.message === 'object') {
    const nested = extractMessageContent(record.message, depth + 1);
    if (nested) return nested;
  }

  // Try common content fields
  if (typeof record.content === 'string') {
    return record.content.trim();
  }
  if (typeof record.text === 'string') {
    return record.text.trim();
  }
  if (Array.isArray(record.content)) {
    const textParts: string[] = [];
    for (const part of record.content) {
      if (part && typeof part === 'object' && (part as Record<string, unknown>).type === 'text') {
        const text = (part as Record<string, unknown>).text;
        if (typeof text === 'string') {
          textParts.push(text);
        }
      }
    }
    if (textParts.length > 0) {
      return textParts.join('').trim();
    }
  }

  return undefined;
}

/**
 * Build metadata for tool result events.
 */
export function buildToolResultMetadata(block: Record<string, unknown>): Record<string, unknown> {
  const toolUseId = pickFirstString(block.tool_use_id);
  const isError = block.is_error === true;

  return {
    toolUseId,
    is_error: isError,
    status: isError ? 'failed' : 'completed',
    cli_type: 'claude',
  };
}

/**
 * Extract content from a tool_result block.
 */
export function extractToolResultContent(block: Record<string, unknown>): string | undefined {
  const content = block.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const textParts = content
      .filter((c) => c && typeof c === 'object' && (c as Record<string, unknown>).type === 'text')
      .map((c) => (c as Record<string, unknown>).text as string)
      .filter(Boolean);
    if (textParts.length > 0) {
      return textParts.join('\n');
    }
  }
  return undefined;
}
