/**
 * AgentEngineBase — shared scaffolding lifted from `claude.ts` and `codex.ts`.
 *
 * Each concrete engine still owns its own `initializeAndRun` (the SDK loop /
 * subprocess loop diverge too much to share), but every CLI engine needs the
 * same handful of leaf helpers: project-root resolution, attachment temp-file
 * writes, base64 hashing for dedup, the recursive `pickFirstString` payload
 * picker, and the per-run tool-message dispatcher that emits realtime envelopes
 * with the right `cli_type` and `cliSource`.
 *
 * Conservative scope: only helpers whose behaviour is byte-identical across
 * engines (modulo the cli_type literal in `dispatchToolMessageRun`) live here.
 * Helpers that look similar but diverge on early-returns, error messages, or
 * object-recursion (e.g. codex's `pickFirstString` recurses into objects;
 * claude's does not) stay on the concrete classes.
 */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentEngine, EngineName } from './types';
import type { AgentMessage, RealtimeEvent } from '../types';

/**
 * Per-run state threaded into `dispatchToolMessageRun`. Mirrors the previous
 * `ClaudeDispatchScope` / `CodexDispatchScope` shapes (identical fields), so
 * concrete engines can keep their own type aliases for documentation.
 */
export interface EngineDispatchScope {
  sessionId: string;
  requestId?: string;
  streamedToolHashes: Set<string>;
  emit: (event: RealtimeEvent) => void;
}

export abstract class AgentEngineBase implements AgentEngine {
  public abstract readonly name: EngineName;
  public abstract initializeAndRun(...args: any[]): Promise<void>;

  /**
   * Maximum number of stderr lines to keep in memory to avoid unbounded growth.
   */
  protected static readonly MAX_STDERR_LINES = 200;

  /**
   * Resolve the project root path, honouring `MCP_AGENT_PROJECT_ROOT` env var
   * and falling back to the current working directory when nothing is provided.
   */
  protected resolveRepoPath(projectRoot?: string): string {
    const base =
      (projectRoot && projectRoot.trim()) || process.env.MCP_AGENT_PROJECT_ROOT || process.cwd();
    return path.resolve(base);
  }

  /**
   * Base64-encode a string for dedup hashing. Uses the FULL hash, not a prefix —
   * the previous 16-char slice collided for small metadata diffs (e.g. `{k:1}`
   * vs `{k:2}` share their first 16 base64 chars), silently dropping the second
   * message as a duplicate. Set lookup is still O(1) on the longer key.
   */
  protected encodeHash(value: string): string {
    return Buffer.from(value, 'utf-8').toString('base64');
  }

  /**
   * Write an attachment to a temporary file and return its path. Used by both
   * Claude (which references images via local file paths in the prompt text)
   * and Codex (which passes them via `--image` CLI flags).
   */
  protected async writeAttachmentToTemp(attachment: {
    type: string;
    name: string;
    mimeType: string;
    dataBase64: string;
  }): Promise<string> {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');

    const tempDir = os.tmpdir();
    const ext = attachment.mimeType.split('/')[1] || 'bin';
    const sanitizedName = attachment.name.replace(/[^a-zA-Z0-9.-]/g, '_');
    const fileName = `mcp-agent-${Date.now()}-${sanitizedName}.${ext}`;
    const filePath = path.join(tempDir, fileName);

    const buffer = Buffer.from(attachment.dataBase64, 'base64');
    await fs.writeFile(filePath, buffer);

    return filePath;
  }

  /**
   * Build + emit one tool message into the realtime stream, with per-run
   * deduplication. Dedup is content+metadata+sessionId+requestId scoped so the
   * same payload from two source events doesn't double-fire the UI. The dedup
   * set lives on the scope so each run gets a fresh window.
   *
   * The `cliType` parameter is the only behavioural diff between the previous
   * engine-local copies: it's stamped into the message metadata and used as
   * the `cliSource` field so downstream UIs can distinguish providers.
   */
  protected dispatchToolMessageRun(
    scope: EngineDispatchScope,
    content: string,
    metadata: Record<string, unknown>,
    messageType: 'tool_use' | 'tool_result',
    isStreaming: boolean,
    cliType: EngineName,
  ): void {
    const trimmed = content.trim();
    if (!trimmed) return;

    const hash = this.encodeHash(
      `${messageType}:${trimmed}:${JSON.stringify(metadata)}:${scope.sessionId}:${scope.requestId || ''}`,
    );
    if (scope.streamedToolHashes.has(hash)) return;
    scope.streamedToolHashes.add(hash);

    const message: AgentMessage = {
      id: randomUUID(),
      sessionId: scope.sessionId,
      role: 'tool',
      content: trimmed,
      messageType,
      cliSource: cliType,
      requestId: scope.requestId,
      isStreaming,
      isFinal: !isStreaming,
      createdAt: new Date().toISOString(),
      metadata: { cli_type: cliType, ...metadata },
    };

    scope.emit({ type: 'message', data: message });
  }
}
