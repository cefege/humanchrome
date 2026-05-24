/**
 * Top-level SDK message handlers for ClaudeEngine. Each function maps to
 * exactly one value of `message.type` from `@anthropic-ai/claude-agent-sdk`:
 *
 *   - assistant     → text fallback when content arrived outside the stream
 *   - result        → final-turn metadata: emit usage, throw on is_error,
 *                     clear stored session id on resume failure
 *   - system        → handle subtype=init (session id, management info)
 *                     and subtype=status (log only)
 *   - auth_status   → surface authentication prompts to the UI
 *   - tool_progress → emit per-tool progress message
 *
 * Handlers receive the shared `RunState`, the `HandlerDeps` bundle
 * (ctx, emitAssistant, dispatchToolMessage), and any per-message
 * orchestrator inputs (e.g. `projectId`, `resumeClaudeSessionId`).
 */
import { randomUUID } from 'node:crypto';
import { extractMessageContent, pickFirstString } from './extractors';
import type { AgentMessage, HandlerDeps, RunState } from './types';

/**
 * Handle `assistant` fallback messages (non-streaming variant).
 */
export function handleAssistantMessage(
  state: RunState,
  message: unknown,
  deps: HandlerDeps,
): void {
  const content = extractMessageContent(message);
  if (content) {
    state.assistantBuffer = content;
    deps.emitAssistant(true);
  }
}

/**
 * Handle `result` messages. Emits usage statistics, throws on errors
 * (clearing the stored session id when the error is a resume failure),
 * and otherwise emits the final assistant content if it differs from
 * what was already streamed.
 */
export async function handleResultMessage(
  state: RunState,
  message: unknown,
  deps: HandlerDeps,
  opts: {
    projectId?: string;
    resumeClaudeSessionId?: string;
  },
): Promise<void> {
  const resultRecord = message as Record<string, unknown>;

  // Log full result for debugging
  state.runLog.debug({ result: resultRecord }, 'claude result message');

  // Extract and emit usage statistics
  const usage = resultRecord.usage as Record<string, unknown> | undefined;
  const totalCostUsd =
    typeof resultRecord.total_cost_usd === 'number' ? resultRecord.total_cost_usd : 0;
  const durationMs =
    typeof resultRecord.duration_ms === 'number' ? resultRecord.duration_ms : 0;
  const numTurns = typeof resultRecord.num_turns === 'number' ? resultRecord.num_turns : 0;

  if (usage || totalCostUsd > 0) {
    deps.ctx.emit({
      type: 'usage',
      data: {
        sessionId: state.sessionId,
        requestId: state.requestId,
        inputTokens: typeof usage?.input_tokens === 'number' ? usage.input_tokens : 0,
        outputTokens: typeof usage?.output_tokens === 'number' ? usage.output_tokens : 0,
        cacheReadInputTokens:
          typeof usage?.cache_read_input_tokens === 'number'
            ? usage.cache_read_input_tokens
            : undefined,
        cacheCreationInputTokens:
          typeof usage?.cache_creation_input_tokens === 'number'
            ? usage.cache_creation_input_tokens
            : undefined,
        totalCostUsd,
        durationMs,
        numTurns,
      },
    });
  }

  // Check if result contains errors (SDK puts error details here)
  // Note: is_error can be true even with empty errors array
  if (resultRecord.is_error) {
    const errors = resultRecord.errors as string[] | undefined;
    const resultText = resultRecord.result as string | undefined;
    const errorMsg = errors?.length
      ? errors.join('; ')
      : resultText || 'Unknown error from Claude Code';
    state.runLog.error({ errorMsg }, 'claude result error');

    // Check if this is a resume failure
    const isResumeFailure =
      errorMsg.includes('No conversation found') ||
      errorMsg.includes('Failed to resume session') ||
      errorMsg.includes('session ID');

    if (isResumeFailure && opts.resumeClaudeSessionId) {
      // Clear the stored session ID so next request starts fresh
      if (deps.ctx.persistClaudeSessionId && opts.projectId) {
        try {
          // Pass empty string to clear the session
          await deps.ctx.persistClaudeSessionId('');
          state.runLog.warn('cleared invalid session ID');
        } catch {
          // Ignore clear errors
        }
      }
      throw new Error(
        `Resume failed: ${errorMsg}. Session has been cleared - please retry.`,
      );
    }

    throw new Error(errorMsg);
  }

  // Extract content from successful result
  const resultContent = extractMessageContent(message);
  if (resultContent && resultContent !== state.assistantBuffer.trim()) {
    state.assistantBuffer = resultContent;
    deps.emitAssistant(true);
  }
}

/**
 * Handle `system` messages, including:
 *  - subtype=init: persist Claude session id and management info
 *  - subtype=status: log only
 */
export async function handleSystemMessage(
  state: RunState,
  message: unknown,
  deps: HandlerDeps,
  opts: { projectId?: string },
): Promise<void> {
  const record = message as Record<string, unknown>;
  const subtype = pickFirstString(record.subtype);

  if (subtype === 'init') {
    // system:init - contains session_id and management information
    const claudeSessionId = record.session_id ? String(record.session_id) : undefined;

    if (claudeSessionId) {
      state.runLog.info({ claudeSessionId }, 'claude session initialized');

      // Persist the session ID if callback is provided and projectId exists
      if (deps.ctx.persistClaudeSessionId && opts.projectId) {
        try {
          await deps.ctx.persistClaudeSessionId(claudeSessionId);
          state.runLog.debug({ projectId: opts.projectId }, 'claude session id persisted for project');
        } catch (persistError) {
          state.runLog.warn(
            {
              err:
                persistError instanceof Error ? persistError.message : String(persistError),
            },
            'failed to persist session id',
          );
        }
      }
    }

    // Extract and persist management information
    if (deps.ctx.persistManagementInfo) {
      try {
        const managementInfo = {
          tools: Array.isArray(record.tools)
            ? record.tools.filter((t): t is string => typeof t === 'string')
            : undefined,
          agents: Array.isArray(record.agents)
            ? record.agents.filter((a): a is string => typeof a === 'string')
            : undefined,
          // SDK returns plugins as { name, path }[] objects
          plugins: Array.isArray(record.plugins)
            ? (record.plugins as Array<{ name?: string; path?: string }>)
                .filter((p) => p && typeof p.name === 'string')
                .map((p) => ({
                  name: String(p.name),
                  path: p.path ? String(p.path) : undefined,
                }))
            : undefined,
          skills: Array.isArray(record.skills)
            ? record.skills.filter((s): s is string => typeof s === 'string')
            : undefined,
          mcpServers: Array.isArray(record.mcp_servers)
            ? (record.mcp_servers as Array<{ name?: string; status?: string }>)
                .filter((s) => s && typeof s.name === 'string')
                .map((s) => ({
                  name: String(s.name),
                  status: String(s.status || 'unknown'),
                }))
            : undefined,
          slashCommands: Array.isArray(record.slash_commands)
            ? record.slash_commands.filter((c): c is string => typeof c === 'string')
            : undefined,
          model: pickFirstString(record.model),
          permissionMode: pickFirstString(record.permissionMode),
          cwd: pickFirstString(record.cwd),
          outputStyle: pickFirstString(record.output_style),
          betas: Array.isArray(record.betas)
            ? record.betas.filter((b): b is string => typeof b === 'string')
            : undefined,
          claudeCodeVersion: pickFirstString(record.claude_code_version),
          apiKeySource: pickFirstString(record.apiKeySource),
        };

        await deps.ctx.persistManagementInfo(managementInfo);
        state.runLog.debug('management info persisted');
      } catch (persistError) {
        state.runLog.warn(
          {
            err:
              persistError instanceof Error ? persistError.message : String(persistError),
          },
          'failed to persist management info',
        );
      }
    }
  } else if (subtype === 'status') {
    // system:status - log for debugging (e.g., compacting)
    const statusText = pickFirstString(record.status);
    state.runLog.debug({ statusText: statusText || 'unknown' }, 'claude system status');
  }
}

/**
 * Handle `auth_status` messages by surfacing authentication prompts to
 * the UI as system-role messages.
 */
export function handleAuthStatusMessage(
  state: RunState,
  message: unknown,
  deps: HandlerDeps,
): void {
  const record = message as Record<string, unknown>;
  const isAuthenticating = record.isAuthenticating === true;
  const output = Array.isArray(record.output)
    ? record.output.filter((o): o is string => typeof o === 'string')
    : [];
  const authError = pickFirstString(record.error);

  state.runLog.info({ isAuthenticating, hasError: !!authError }, 'claude auth status');

  // Build content from output or error
  const content = authError || output.join('\n') || 'Authentication in progress...';

  // Determine if login is required:
  // - Not currently authenticating AND (has error OR output contains login keywords)
  const outputText = output.join(' ').toLowerCase();
  const requiresLogin =
    !isAuthenticating &&
    (!!authError ||
      outputText.includes('login') ||
      outputText.includes('authenticate') ||
      outputText.includes('sign in'));

  // Emit auth status as a system message so UI can display login prompts
  const authSystemMessage: AgentMessage = {
    id: randomUUID(),
    sessionId: state.sessionId,
    role: 'system',
    content,
    messageType: 'status',
    cliSource: state.cliSource,
    requestId: state.requestId,
    isStreaming: false,
    isFinal: !isAuthenticating,
    createdAt: new Date().toISOString(),
    metadata: {
      cli_type: 'claude',
      event_type: 'auth_status',
      isAuthenticating,
      output,
      error: authError,
      requires_login: requiresLogin,
    },
  };

  deps.ctx.emit({ type: 'message', data: authSystemMessage });
}

/**
 * Handle `tool_progress` messages by emitting a streaming tool message
 * for the in-flight tool call. The message id is derived from
 * `tool_use_id` so the UI can update the same row.
 */
export function handleToolProgressMessage(
  state: RunState,
  message: unknown,
  deps: HandlerDeps,
): void {
  const record = message as Record<string, unknown>;
  const toolUseId = pickFirstString(record.tool_use_id);
  const toolName = pickFirstString(record.tool_name);
  const parentToolUseId = pickFirstString(record.parent_tool_use_id);
  const elapsedTimeSeconds =
    typeof record.elapsed_time_seconds === 'number' ? record.elapsed_time_seconds : undefined;

  if (toolName || toolUseId) {
    const displayName = toolName || toolUseId || 'tool';
    const elapsedStr =
      elapsedTimeSeconds !== undefined ? ` (${elapsedTimeSeconds.toFixed(1)}s)` : '';
    state.runLog.debug({ tool: displayName, elapsedTimeSeconds }, 'claude tool progress');

    // Use tool_use_id as message id if available, so UI can update the same progress entry
    const messageId = toolUseId ? `progress-${toolUseId}` : randomUUID();

    // Emit tool progress as a tool message
    const progressMessage: AgentMessage = {
      id: messageId,
      sessionId: state.sessionId,
      role: 'tool',
      content: `${displayName} in progress${elapsedStr}`,
      messageType: 'tool_use',
      cliSource: state.cliSource,
      requestId: state.requestId,
      isStreaming: true,
      isFinal: false,
      createdAt: new Date().toISOString(),
      metadata: {
        cli_type: 'claude',
        event_type: 'tool_progress',
        toolUseId,
        toolName,
        parentToolUseId,
        elapsedTimeSeconds,
      },
    };

    deps.ctx.emit({ type: 'message', data: progressMessage });
  }
}

/**
 * Top-level dispatcher for SDK message types other than `stream_event`.
 * Returns silently for unrecognized message types.
 */
export async function handleSdkMessage(
  state: RunState,
  message: { type: string },
  deps: HandlerDeps,
  opts: {
    projectId?: string;
    resumeClaudeSessionId?: string;
  },
): Promise<void> {
  switch (message.type) {
    case 'assistant':
      handleAssistantMessage(state, message, deps);
      return;
    case 'result':
      await handleResultMessage(state, message, deps, opts);
      return;
    case 'system':
      await handleSystemMessage(state, message, deps, { projectId: opts.projectId });
      return;
    case 'auth_status':
      handleAuthStatusMessage(state, message, deps);
      return;
    case 'tool_progress':
      handleToolProgressMessage(state, message, deps);
      return;
    default:
      // Unknown message type — orchestrator will have already dispatched
      // stream_event separately; everything else is silently ignored.
      return;
  }
}
