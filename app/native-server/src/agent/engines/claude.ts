/**
 * ClaudeEngine — drives an interactive Claude Code session as a humanchrome
 * AgentEngine. Implements the AgentEngine contract so the bridge can swap
 * between this and CodexEngine with no caller changes.
 *
 * Lifecycle: init() lazily loads @anthropic-ai/claude-code (slice extracted
 * to loadSdk), then execute() opens an SDK conversation, wires the
 * tool-message loop (slice: dispatchToolMessageRun), and streams
 * RealtimeEvents back to the caller until the model yields a final text turn
 * or stop() is invoked.
 *
 * In-flight refactor: per-run state (active SDK iterator, in-flight todos,
 * dispatch scope, abort controller) still lives on the engine instance and
 * is reset between calls. IMP-0049 plans to extract that cluster into a
 * `RunContext` so multiple concurrent runs can be supported safely; until
 * then, callers must serialize execute() per engine instance.
 *
 * CCR (Claude-Code-Router) detection runs once per init via ccr-detector,
 * and gates how we shell out to the SDK — keep that path read-only.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { EngineExecutionContext, EngineInitOptions } from './types';
import type { AgentMessage } from '../types';
import { AgentEngineBase, type EngineDispatchScope } from './base';
import { detectCcr, validateCcrConfig } from '../ccr-detector';
import { getProject } from '../project-service';
import { getHumanChromeUrl } from '../../constant';
import { withContext } from '../../util/logger';
import { type Logger } from 'pino';
import { pickFirstString } from './claude/extractors';
import {
  createRunState,
  emitAssistantMessage,
  cleanupTempFiles,
} from './claude/run-helpers';
import { handleStreamEvent } from './claude/stream-event-handlers';
import { handleSdkMessage } from './claude/message-type-handlers';
import type { HandlerDeps } from './claude/types';

const log = withContext({ component: 'claude-engine' });

/**
 * Dispatcher signature for the per-run tool-message emitter. Threaded
 * into helpers so they don't capture loop-scoped state via closure.
 */
type ClaudeToolDispatcher = (
  content: string,
  metadata: Record<string, unknown>,
  messageType: 'tool_use' | 'tool_result',
  isStreaming: boolean,
) => void;

/**
 * Per-run state threaded into `dispatchToolMessageRun` so the method
 * stays unit-testable without reconstructing the in-loop closure.
 *
 * Aliased from the shared {@link EngineDispatchScope} for documentation —
 * the two shapes are intentionally identical so the base-class dispatcher
 * can serve both engines.
 */
type ClaudeDispatchScope = EngineDispatchScope;

/**
 * Input bag for {@link ClaudeEngine.buildRunOptions}.
 *
 * Field semantics mirror {@link EngineInitOptions} except for the four
 * runtime-derived members (`claudeEnv`, `runLog`, `stderrBuffer`, plus
 * the resolved `repoPath`/`resolvedModel`) which the caller computes
 * before the builder runs. `stderrBuffer` is mutated by the SDK stderr
 * callback the builder installs.
 */
interface ClaudeRunOptionsInput {
  repoPath: string;
  resolvedModel: string;
  permissionMode?: string;
  allowDangerouslySkipPermissions?: boolean;
  optionsConfig?: unknown;
  systemPromptConfig?: unknown;
  signal?: AbortSignal;
  projectId?: string;
  resumeClaudeSessionId?: string;
  claudeEnv: NodeJS.ProcessEnv;
  runLog: Logger;
  stderrBuffer: string[];
}

// Images are provided to Claude Code via local file paths referenced in the prompt text.
// Claude Code CLI reads images from local paths, so we write base64 images to temp files and reference them.

/**
 * ClaudeEngine integrates the Claude Agent SDK as an AgentEngine implementation.
 *
 * This engine uses the @anthropic-ai/claude-agent-sdk to interact with Claude,
 * streaming events back to the sidepanel UI via RealtimeEvent envelopes.
 */
export class ClaudeEngine extends AgentEngineBase {
  public readonly name = 'claude' as const;
  public readonly supportsMcp = true;

  async initializeAndRun(options: EngineInitOptions, ctx: EngineExecutionContext): Promise<void> {
    const {
      sessionId,
      instruction,
      model,
      projectRoot,
      requestId,
      signal,
      attachments,
      resolvedImagePaths,
      projectId,
      permissionMode,
      allowDangerouslySkipPermissions,
      systemPromptConfig,
      optionsConfig,
      resumeClaudeSessionId,
      useCcr,
    } = options;
    const repoPath = this.resolveRepoPath(projectRoot);

    // Check if already aborted
    if (signal?.aborted) {
      throw new Error('ClaudeEngine: execution was cancelled');
    }

    const normalizedInstruction = instruction.trim();
    if (!normalizedInstruction) {
      throw new Error('ClaudeEngine: instruction must not be empty');
    }

    // Images are passed via temp file paths appended to the prompt string
    const query = await this.loadSdk();

    // Resolve model
    const resolvedModel =
      model?.trim() || process.env.CLAUDE_DEFAULT_MODEL || 'claude-sonnet-4-20250514';

    // State management
    const stderrBuffer: string[] = [];
    const streamedToolHashes = new Set<string>();

    const runLog = log.child({ sessionId, requestId, projectId, model: resolvedModel });

    // Per-run state bag — handlers in `./claude/*` mutate this directly.
    const runState = createRunState({ sessionId, requestId, runLog });

    // Per-run dispatch scope: built once and threaded into the class
    // method so the in-loop closure stays a thin wrapper. Mirrors the
    // IMP-0049 slice 3 pattern in codex.ts.
    const dispatchScope: ClaudeDispatchScope = {
      sessionId,
      requestId,
      streamedToolHashes,
      emit: ctx.emit,
    };
    const dispatchToolMessage: ClaudeToolDispatcher = (
      content,
      metadata,
      messageType,
      isStreaming,
    ): void => {
      this.dispatchToolMessageRun(dispatchScope, content, metadata, messageType, isStreaming);
    };

    // Handler deps bundle — passed to every extracted handler.
    const handlerDeps: HandlerDeps = {
      ctx,
      emitAssistant: (isFinal: boolean) => emitAssistantMessage(runState, ctx, isFinal),
      dispatchToolMessage,
    };

    // Build prompt instruction (may be modified if images are attached)
    let promptInstruction = normalizedInstruction;

    try {
      runLog.info({ repoPath }, 'starting Claude query');

      // Check for image attachments - prefer resolvedImagePaths (persisted), fallback to temp files
      const hasResolvedPaths = resolvedImagePaths && resolvedImagePaths.length > 0;
      const imageAttachments = (attachments ?? []).filter((a) => a.type === 'image');
      const hasImages = hasResolvedPaths || imageAttachments.length > 0;

      if (hasImages) {
        // Strip any legacy "Image #N path:" lines to avoid duplicating references
        const instructionWithoutLegacyPaths = normalizedInstruction
          .replace(/\n*Image #\d+ path: [^\n]+/g, '')
          .trim();

        const imageLines: string[] = [];

        if (hasResolvedPaths) {
          // Use pre-resolved persistent paths (preferred - no temp files needed)
          runLog.debug({ count: resolvedImagePaths.length }, 'using pre-resolved image paths');
          for (let index = 0; index < resolvedImagePaths.length; index++) {
            imageLines.push(`Image #${index + 1} path: ${resolvedImagePaths[index]}`);
          }
        } else {
          // Fallback: write base64 to temp files (legacy behavior)
          runLog.debug(
            { count: imageAttachments.length },
            'writing image attachments to temp files (fallback)',
          );
          for (let index = 0; index < imageAttachments.length; index++) {
            const attachment = imageAttachments[index];
            const tempFilePath = await this.writeAttachmentToTemp(attachment);
            runState.tempFiles.push(tempFilePath);
            imageLines.push(`Image #${index + 1} path: ${tempFilePath}`);
          }
        }

        // Build final instruction with image paths appended
        promptInstruction = [instructionWithoutLegacyPaths, imageLines.join('\n')]
          .filter((segment) => segment && segment.trim().length > 0)
          .join('\n\n')
          .trim();

        runLog.debug(
          { previewLen: 200, preview: promptInstruction.slice(0, 200) },
          'prompt with image paths built',
        );
      }

      // Start Claude Agent SDK query
      // Session resumption: if resumeClaudeSessionId is provided (from sessions.engineSessionId or legacy project),
      // pass it as 'resume' to continue a previous Claude conversation.
      // If not provided, SDK will create a new session.

      // Build environment for Claude Code Router support
      // SDK treats options.env as a complete replacement, so we must merge with process.env
      // Reference: https://github.com/musistudio/claude-code-router/issues/855
      const claudeEnv = await this.buildClaudeEnv(useCcr);

      // Validate CCR configuration and emit friendly warning before calling into CCR
      // This prevents users from seeing cryptic "includes of undefined" errors
      if (useCcr) {
        await this.validateAndWarnCcrConfig(sessionId, requestId, ctx);
      }

      const { queryOptions, internalAbortController } = await this.buildRunOptions({
        repoPath,
        resolvedModel,
        permissionMode,
        allowDangerouslySkipPermissions,
        optionsConfig,
        systemPromptConfig,
        signal,
        projectId,
        resumeClaudeSessionId,
        claudeEnv,
        runLog,
        stderrBuffer,
      });

      const response = query({
        prompt: promptInstruction,
        options: queryOptions,
      });

      // Process streaming response. The stream-event and SDK message
      // dispatchers live in sibling modules under `./claude/` (IMP-0149);
      // the body here is intentionally a thin loop so the per-event /
      // per-message-type logic can be unit-tested in isolation.
      for await (const message of response) {
        // Check for cancellation before processing each message
        if (signal?.aborted) {
          runLog.info('claude execution cancelled via abort signal');
          throw new Error('ClaudeEngine: execution was cancelled');
        }

        runLog.trace({ type: message.type }, 'claude message');

        if (message.type === 'stream_event') {
          const event = (message as unknown as { event?: Record<string, unknown> }).event ?? {};
          const eventType = pickFirstString(event.type);
          handleStreamEvent(eventType, event, runState, handlerDeps);
        } else {
          await handleSdkMessage(runState, message as { type: string }, handlerDeps, {
            projectId,
            resumeClaudeSessionId,
          });
        }
      }

      // Ensure final message is emitted
      if (runState.assistantBuffer.trim()) {
        handlerDeps.emitAssistant(true);
      }

      runLog.info('claude query completed successfully');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // Log full stderr for debugging
      runLog.error({ err: message }, 'claude query error');
      if (stderrBuffer.length > 0) {
        runLog.error(
          { lines: stderrBuffer.length, tail: stderrBuffer.slice(-10) },
          'claude stderr tail',
        );
      }

      // Check if this is a resume failure from stderr
      const stderrText = stderrBuffer.join('\n');
      const isResumeFailure =
        stderrText.includes('No conversation found') ||
        stderrText.includes('Failed to resume session') ||
        stderrText.includes('session ID') ||
        message.includes('Resume failed');

      if (isResumeFailure && resumeClaudeSessionId && ctx.persistClaudeSessionId && projectId) {
        // Clear the stored session ID so next request starts fresh
        try {
          await ctx.persistClaudeSessionId('');
          runLog.warn('cleared invalid session id due to resume failure');
        } catch {
          // Ignore clear errors
        }
      }

      // Enhance error message for CCR-related errors
      const enhancedMessage = await this.enhanceCcrErrorMessage(message, stderrText);

      // Classify errors for better UX
      const errorMessage = this.classifyError(enhancedMessage, stderrBuffer);
      throw new Error(`ClaudeEngine: ${errorMessage}`, { cause: error });
    } finally {
      // Always cleanup temp files, even on error
      await cleanupTempFiles(runState);
    }
  }

  /**
   * Build environment variables for Claude Code.
   * Supports Claude Code Router (CCR) when useCcr is true:
   * 1. Auto-detecting CCR from config file (~/.claude-code-router/config.json)
   * 2. Passing through env vars if already set (via `eval "$(ccr activate)"`)
   *
   * SDK treats options.env as a complete replacement (not merged with process.env),
   * so we must explicitly include all necessary variables.
   *
   * @param useCcr - Whether CCR is enabled for this project. When false/undefined, CCR detection is skipped.
   */
  private async buildClaudeEnv(useCcr?: boolean): Promise<NodeJS.ProcessEnv> {
    const env: NodeJS.ProcessEnv = { ...process.env };

    // Ensure Node.js bin directory is in PATH (for child processes)
    const nodeBinDir = path.dirname(process.execPath);
    const currentPath = env.PATH || env.Path || '';
    if (!currentPath.includes(nodeBinDir)) {
      env.PATH = [nodeBinDir, currentPath].filter(Boolean).join(path.delimiter);
    }

    // Only detect CCR if explicitly enabled for this project
    if (useCcr && !env.ANTHROPIC_BASE_URL) {
      try {
        const ccrResult = await detectCcr();
        if (ccrResult.detected && ccrResult.baseUrl && ccrResult.authToken) {
          env.ANTHROPIC_BASE_URL = ccrResult.baseUrl;
          env.ANTHROPIC_AUTH_TOKEN = ccrResult.authToken;
          log.info({ source: ccrResult.source }, 'CCR auto-detected');
        } else if (ccrResult.error) {
          log.warn({ err: ccrResult.error }, 'CCR detection failed');
        } else {
          log.warn('CCR enabled but not detected (config not found or service not running)');
        }
      } catch (err) {
        // CCR detection is best-effort, don't fail the request
        log.warn({ err: err instanceof Error ? err.message : String(err) }, 'CCR detection error');
      }
    }

    // Log CCR-related env vars for debugging (without exposing full token)
    const baseUrl = env.ANTHROPIC_BASE_URL;
    const authToken = env.ANTHROPIC_AUTH_TOKEN;
    if (baseUrl) {
      log.debug({ baseUrl }, 'using ANTHROPIC_BASE_URL');
    }
    if (authToken) {
      const preview =
        authToken.length > 8 ? `${authToken.slice(0, 4)}...${authToken.slice(-4)}` : '****';
      log.debug({ preview }, 'using ANTHROPIC_AUTH_TOKEN');
    }

    return env;
  }

  /**
   * Load the Claude Agent SDK at runtime. Dynamic import avoids a hard
   * dependency on `@anthropic-ai/claude-agent-sdk` — the package is
   * optional and only required for callers that actually use this engine.
   * The string-variable + Function-eval indirection bypasses TypeScript's
   * static module resolution so the bundler doesn't try to resolve it.
   */
  private async loadSdk(): Promise<
    (args: { prompt: string; options?: Record<string, unknown> }) => AsyncIterable<any>
  > {
    try {
      const sdkModuleName = '@anthropic-ai/claude-agent-sdk';
      const sdk = await (Function(
        'moduleName',
        'return import(moduleName)',
      )(sdkModuleName) as Promise<any>);
      return sdk.query;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `ClaudeEngine: Failed to load Claude Agent SDK. Please install @anthropic-ai/claude-agent-sdk. Error: ${message}`,
        { cause: error },
      );
    }
  }

  /**
   * Build the Claude Agent SDK `query()` options bag for one run, plus
   * the AbortController the caller wires up to the external signal.
   *
   * Pure-ish builder: every input is read-only after construction except
   * `stderrBuffer`, which is intentionally mutated by the SDK's `stderr`
   * callback (passed by reference so the caller still sees the captured
   * lines for downstream error classification). Returns the controller
   * separately so the caller can use it for cancellation handoff without
   * digging into the options object.
   *
   * The six in-method IIFEs (`resolvedAllowDangerouslySkipPermissions`,
   * `enableHumanChrome`, `resolvedSettingSources`, `resolvedSystemPrompt`,
   * etc.) stay inline rather than promoted to private methods because
   * each one closes over `runLog.warn(...)` to surface invalid-input
   * diagnostics; lifting them would force threading the run-scoped logger
   * through every signature for no readability gain.
   */
  private async buildRunOptions(input: ClaudeRunOptionsInput): Promise<{
    queryOptions: Record<string, unknown>;
    internalAbortController: AbortController;
  }> {
    const {
      repoPath,
      resolvedModel,
      permissionMode,
      allowDangerouslySkipPermissions,
      optionsConfig,
      systemPromptConfig,
      signal,
      projectId,
      resumeClaudeSessionId,
      claudeEnv,
      runLog,
      stderrBuffer,
    } = input;

    // SDK default is 'default'; AgentChat overrides to 'bypassPermissions' for headless operation.
    const allowedPermissionModes = new Set([
      'default',
      'acceptEdits',
      'bypassPermissions',
      'plan',
      'dontAsk',
    ]);
    const normalizedPermissionMode =
      typeof permissionMode === 'string' ? permissionMode.trim() : '';

    let resolvedPermissionMode: string;
    if (normalizedPermissionMode === '') {
      resolvedPermissionMode = 'bypassPermissions';
    } else if (allowedPermissionModes.has(normalizedPermissionMode)) {
      resolvedPermissionMode = normalizedPermissionMode;
    } else {
      runLog.warn(
        { provided: normalizedPermissionMode },
        'invalid permissionMode — falling back to SDK default "default"',
      );
      resolvedPermissionMode = 'default';
    }

    // SDK requirement: bypassPermissions mode forces allowDangerouslySkipPermissions=true
    const resolvedAllowDangerouslySkipPermissions = (() => {
      const explicitValue =
        typeof allowDangerouslySkipPermissions === 'boolean'
          ? allowDangerouslySkipPermissions
          : undefined;

      if (resolvedPermissionMode === 'bypassPermissions') {
        if (explicitValue === false) {
          runLog.warn(
            'allowDangerouslySkipPermissions=false is incompatible with bypassPermissions mode — forcing to true',
          );
        }
        return true;
      }

      return explicitValue ?? false;
    })();

    const optionsRecord =
      optionsConfig && typeof optionsConfig === 'object' && !Array.isArray(optionsConfig)
        ? (optionsConfig as Record<string, unknown>)
        : undefined;

    // Resolve project-scoped HumanChrome toggle (default: enabled)
    const enableHumanChrome = await (async (): Promise<boolean> => {
      if (!projectId) return true;
      try {
        const project = await getProject(projectId);
        return project?.enableHumanChrome !== false;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        runLog.warn(
          { err: message },
          'failed to load project.enableHumanChrome — defaulting to true',
        );
        return true;
      }
    })();

    // SDK isolation mode: settingSources=[] prevents loading any filesystem settings
    // Default: include 'project' to load CLAUDE.md
    const resolvedSettingSources = (() => {
      const allowedSettingSources = new Set(['user', 'project', 'local']);
      const raw = optionsRecord?.settingSources;

      if (Array.isArray(raw) && raw.length === 0) {
        runLog.debug('isolation mode enabled: settingSources=[]');
        return [];
      }

      if (Array.isArray(raw)) {
        const sources: string[] = [];
        for (const entry of raw) {
          if (typeof entry === 'string' && allowedSettingSources.has(entry)) {
            sources.push(entry);
          }
        }
        if (sources.length > 0) {
          return sources;
        }
      }

      return ['project'];
    })();

    const resolvedSystemPrompt = (() => {
      if (typeof systemPromptConfig === 'string') {
        const trimmed = systemPromptConfig.trim();
        return trimmed.length > 0 ? trimmed : undefined;
      }
      if (
        !systemPromptConfig ||
        typeof systemPromptConfig !== 'object' ||
        Array.isArray(systemPromptConfig)
      ) {
        return undefined;
      }
      const record = systemPromptConfig as Record<string, unknown>;
      const type = record.type;
      if (type === 'custom' && typeof record.text === 'string') {
        const trimmed = record.text.trim();
        return trimmed.length > 0 ? trimmed : undefined;
      }
      if (type === 'preset' && record.preset === 'claude_code') {
        // Trim append and ignore empty strings to avoid "append is empty but object is passed" edge case
        const rawAppend = typeof record.append === 'string' ? record.append.trim() : '';
        const append = rawAppend.length > 0 ? rawAppend : undefined;
        return append
          ? { type: 'preset' as const, preset: 'claude_code' as const, append }
          : { type: 'preset' as const, preset: 'claude_code' as const };
      }
      return undefined;
    })();

    // SDK expects abortController option, not raw AbortSignal — mirror external signal into one we own.
    const internalAbortController = new AbortController();
    if (signal) {
      if (signal.aborted) {
        internalAbortController.abort();
      } else {
        signal.addEventListener(
          'abort',
          () => {
            internalAbortController.abort();
          },
          { once: true },
        );
      }
    }

    const queryOptions: Record<string, unknown> = {
      cwd: repoPath,
      additionalDirectories: [repoPath],
      model: resolvedModel,
      permissionMode: resolvedPermissionMode,
      allowDangerouslySkipPermissions: resolvedAllowDangerouslySkipPermissions,
      // includePartialMessages: stream content_block_delta events for live UI updates
      includePartialMessages: true,
      settingSources: resolvedSettingSources,
      systemPrompt: resolvedSystemPrompt,
      abortController: internalAbortController,
      // Merged env supports Claude Code Router (CCR) — see https://github.com/musistudio/claude-code-router/issues/855
      env: claudeEnv,
      stderr: (data: string) => {
        const line = String(data).trimEnd();
        if (!line) return;
        if (stderrBuffer.length > ClaudeEngine.MAX_STDERR_LINES) {
          stderrBuffer.shift();
        }
        stderrBuffer.push(line);
        runLog.debug({ line }, 'claude stderr');
      },
    };

    // Apply additional SDK options from optionsConfig
    if (optionsRecord) {
      const isStringArray = (value: unknown): value is string[] =>
        Array.isArray(value) && value.every((v) => typeof v === 'string');

      if (isStringArray(optionsRecord.allowedTools)) {
        queryOptions.allowedTools = optionsRecord.allowedTools;
      }
      if (isStringArray(optionsRecord.disallowedTools)) {
        queryOptions.disallowedTools = optionsRecord.disallowedTools;
      }

      const tools = optionsRecord.tools;
      if (isStringArray(tools)) {
        queryOptions.tools = tools;
      } else if (tools && typeof tools === 'object' && !Array.isArray(tools)) {
        const toolsRecord = tools as Record<string, unknown>;
        if (toolsRecord.type === 'preset' && toolsRecord.preset === 'claude_code') {
          queryOptions.tools = { type: 'preset', preset: 'claude_code' };
        }
      }

      if (isStringArray(optionsRecord.betas)) {
        queryOptions.betas = optionsRecord.betas;
      }

      if (
        typeof optionsRecord.maxThinkingTokens === 'number' &&
        Number.isFinite(optionsRecord.maxThinkingTokens)
      ) {
        queryOptions.maxThinkingTokens = optionsRecord.maxThinkingTokens;
      }
      if (typeof optionsRecord.maxTurns === 'number' && Number.isFinite(optionsRecord.maxTurns)) {
        queryOptions.maxTurns = optionsRecord.maxTurns;
      }
      if (
        typeof optionsRecord.maxBudgetUsd === 'number' &&
        Number.isFinite(optionsRecord.maxBudgetUsd)
      ) {
        queryOptions.maxBudgetUsd = optionsRecord.maxBudgetUsd;
      }

      if (
        optionsRecord.mcpServers &&
        typeof optionsRecord.mcpServers === 'object' &&
        !Array.isArray(optionsRecord.mcpServers)
      ) {
        queryOptions.mcpServers = optionsRecord.mcpServers;
      }
      if (
        optionsRecord.outputFormat &&
        typeof optionsRecord.outputFormat === 'object' &&
        !Array.isArray(optionsRecord.outputFormat)
      ) {
        queryOptions.outputFormat = optionsRecord.outputFormat;
      }
      if (typeof optionsRecord.enableFileCheckpointing === 'boolean') {
        queryOptions.enableFileCheckpointing = optionsRecord.enableFileCheckpointing;
      }
      if (
        optionsRecord.sandbox &&
        typeof optionsRecord.sandbox === 'object' &&
        !Array.isArray(optionsRecord.sandbox)
      ) {
        queryOptions.sandbox = optionsRecord.sandbox;
      }

      // Session env takes precedence over process env (per-session API keys, etc.)
      if (
        optionsRecord.env &&
        typeof optionsRecord.env === 'object' &&
        !Array.isArray(optionsRecord.env)
      ) {
        const sessionEnv = optionsRecord.env as Record<string, unknown>;
        const mergedEnv = { ...claudeEnv };
        for (const [key, value] of Object.entries(sessionEnv)) {
          if (typeof value === 'string') {
            mergedEnv[key] = value;
          }
        }
        // Re-prepend Node bin to PATH — session may have overwritten PATH and broken child processes
        const nodeBinDir = path.dirname(process.execPath);
        const mergedPath = mergedEnv.PATH || mergedEnv.Path || '';
        if (!mergedPath.includes(nodeBinDir)) {
          mergedEnv.PATH = [nodeBinDir, mergedPath].filter(Boolean).join(path.delimiter);
        }
        queryOptions.env = mergedEnv;
      }
    }

    // Inject the local HumanChrome bridge based on project preference.
    // Only controls the built-in "humanchrome" entry; user-configured MCP servers stay untouched.
    const HUMANCHROME_SERVER_NAME = 'humanchrome';
    if (enableHumanChrome) {
      const existingMcpServers =
        queryOptions.mcpServers &&
        typeof queryOptions.mcpServers === 'object' &&
        !Array.isArray(queryOptions.mcpServers)
          ? (queryOptions.mcpServers as Record<string, unknown>)
          : {};

      queryOptions.mcpServers = {
        ...existingMcpServers,
        [HUMANCHROME_SERVER_NAME]: {
          type: 'http',
          url: getHumanChromeUrl(),
        },
      };
      runLog.info({ url: getHumanChromeUrl() }, 'HumanChrome bridge enabled');
    } else if (
      queryOptions.mcpServers &&
      typeof queryOptions.mcpServers === 'object' &&
      !Array.isArray(queryOptions.mcpServers)
    ) {
      const existing = queryOptions.mcpServers as Record<string, unknown>;
      if (HUMANCHROME_SERVER_NAME in existing) {
        const { [HUMANCHROME_SERVER_NAME]: _removed, ...rest } = existing;
        if (Object.keys(rest).length > 0) {
          queryOptions.mcpServers = rest;
        } else {
          delete (queryOptions as Record<string, unknown>).mcpServers;
        }
      }
      runLog.info('HumanChrome bridge disabled');
    }

    if (resumeClaudeSessionId) {
      queryOptions.resume = resumeClaudeSessionId;
      runLog.info({ resumeClaudeSessionId }, 'resuming claude session');
    }

    return { queryOptions, internalAbortController };
  }

  /**
   * Build + emit one tool message into the realtime stream, with per-run
   * deduplication. Thin override of {@link AgentEngineBase.dispatchToolMessageRun}
   * that pins the `cli_type` literal to `'claude'`. The full implementation
   * (dedup hashing, scope writes, envelope shape) lives on the base class —
   * see `base.ts` for the IMP-0009 / IMP-0049 history.
   */
  protected dispatchToolMessageRun(
    scope: ClaudeDispatchScope,
    content: string,
    metadata: Record<string, unknown>,
    messageType: 'tool_use' | 'tool_result',
    isStreaming: boolean,
  ): void {
    super.dispatchToolMessageRun(scope, content, metadata, messageType, isStreaming, 'claude');
  }

  /**
   * Format error message for user display.
   * Preserves the original error message and only appends stderr context if useful.
   */
  private classifyError(message: string, stderrBuffer: string[]): string {
    // Always preserve the original error message
    // Only append stderr context if it contains useful information beyond the spawn line
    const usefulStderr = stderrBuffer.filter(
      (line) => !line.includes('Spawning Claude Code:') && line.trim().length > 0,
    );

    if (usefulStderr.length > 0) {
      const lastLines = usefulStderr.slice(-3).join(' | ');
      return `${message} (stderr: ${lastLines})`;
    }

    return message;
  }

  /**
   * Validate CCR configuration and emit a warning message if issues are found.
   * This is a best-effort check to provide actionable guidance before CCR crashes.
   */
  private async validateAndWarnCcrConfig(
    sessionId: string,
    requestId: string | undefined,
    ctx: EngineExecutionContext,
  ): Promise<void> {
    try {
      const validation = await validateCcrConfig();

      if (!validation.checked || validation.valid) {
        return;
      }

      // Build user-friendly warning message
      const lines = [
        '⚠️ Claude Code Router (CCR) configuration issue detected:',
        validation.issue ?? 'CCR configuration appears invalid.',
        '',
        validation.suggestion ?? 'Please check your CCR configuration.',
      ];

      if (validation.suggestedFix) {
        lines.push('', `Suggested fix: Router.default = "${validation.suggestedFix}"`);
      }

      const content = lines.join('\n');
      log.warn({ issue: validation.issue, sessionId, requestId }, 'CCR config warning');

      const warningMessage: AgentMessage = {
        id: randomUUID(),
        sessionId,
        role: 'system',
        content,
        messageType: 'status',
        cliSource: this.name,
        requestId,
        isStreaming: false,
        isFinal: true,
        createdAt: new Date().toISOString(),
        metadata: {
          cli_type: 'claude',
          warning_type: 'ccr_config',
          ccr_issue: validation.issue,
          ccr_suggested_fix: validation.suggestedFix,
        },
      };

      ctx.emit({ type: 'message', data: warningMessage });
    } catch (err) {
      // CCR config validation is best-effort, don't fail the request
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'CCR config validation error',
      );
    }
  }

  /**
   * Enhance error messages for CCR-related errors.
   * Detects the common "includes of undefined" crash and provides actionable guidance.
   */
  private async enhanceCcrErrorMessage(message: string, stderrText: string): Promise<string> {
    const combinedText = `${message}\n${stderrText}`;

    // Detect CCR's "includes of undefined" error pattern
    const isCcrIncludesError =
      combinedText.includes('claude-code-router') &&
      (combinedText.includes("reading 'includes'") || combinedText.includes('transformRequestIn'));

    if (!isCcrIncludesError) {
      return message;
    }

    // Try to get specific fix suggestion from CCR config
    let suggestion =
      'Edit ~/.claude-code-router/config.json and set Router.default to "provider,model" format (e.g., "venus,claude-4-5-sonnet-20250929"), then restart CCR.';

    try {
      const validation = await validateCcrConfig();
      if (validation.checked && !validation.valid && validation.suggestion) {
        suggestion = validation.suggestion;
      }
    } catch {
      // Use default suggestion if validation fails
    }

    return [
      message,
      '',
      '💡 CCR Configuration Issue Detected:',
      'This error is commonly caused by Router.default being set to only a provider name',
      '(e.g., "venus") instead of the required "provider,model" format.',
      '',
      `Fix: ${suggestion}`,
    ].join('\n');
  }

}
