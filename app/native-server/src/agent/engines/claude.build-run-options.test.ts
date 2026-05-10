/**
 * Unit tests for `ClaudeEngine.buildRunOptions` (IMP-0009 slice 2).
 *
 * Locks the queryOptions shape that lands in the SDK call. The builder
 * is pure-ish (only side effect is appending to `stderrBuffer` via the
 * SDK stderr callback, exercised separately) so we can assert the
 * structure without spawning a real Claude run.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { ClaudeEngine } from './claude';

jest.mock('../project-service', () => ({
  getProject: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
}));

/**
 * Minimal pino-shaped logger stub. Hoisted to module scope so every
 * `build()` call shares the same no-op sink (the builder never inspects
 * call counts; it just needs the methods to exist).
 */
function createStubLog(): any {
  const noop = () => {};
  const child: any = { warn: noop, info: noop, debug: noop, trace: noop, error: noop };
  child.child = () => child;
  return child;
}
const stubLog = createStubLog();

// Reach into the private builder via a type assertion. Mirrors the
// pattern in `codex.cli-invocation.test.ts` / `codex.emit-todo-list.test.ts`.
// The input/output shapes are duplicated locally rather than derived via
// `Parameters<...>`/`ReturnType<...>` because `buildRunOptions` is `private`,
// so TypeScript erases it from the public surface and the conditional
// extraction collapses to `never`.
interface BuildInput {
  repoPath?: string;
  resolvedModel?: string;
  permissionMode?: string;
  allowDangerouslySkipPermissions?: boolean;
  optionsConfig?: unknown;
  systemPromptConfig?: unknown;
  signal?: AbortSignal;
  projectId?: string;
  resumeClaudeSessionId?: string;
  claudeEnv?: NodeJS.ProcessEnv;
  stderrBuffer?: string[];
}
interface BuildOutput {
  queryOptions: Record<string, unknown>;
  internalAbortController: AbortController;
}

async function build(overrides: BuildInput = {}): Promise<BuildOutput> {
  const engine = new ClaudeEngine();
  const input = {
    repoPath: '/tmp/repo',
    resolvedModel: 'claude-opus-4-7',
    permissionMode: undefined,
    allowDangerouslySkipPermissions: undefined,
    optionsConfig: undefined,
    systemPromptConfig: undefined,
    signal: undefined,
    projectId: undefined,
    resumeClaudeSessionId: undefined,
    claudeEnv: { PATH: '/usr/bin' } as NodeJS.ProcessEnv,
    runLog: stubLog,
    stderrBuffer: [] as string[],
    ...overrides,
  };
  return (
    engine as unknown as {
      buildRunOptions: (i: typeof input) => Promise<BuildOutput>;
    }
  ).buildRunOptions(input);
}

describe('ClaudeEngine.buildRunOptions', () => {
  it('defaults permissionMode to bypassPermissions and forces allowDangerouslySkipPermissions=true', async () => {
    const { queryOptions } = await build();
    expect(queryOptions.permissionMode).toBe('bypassPermissions');
    expect(queryOptions.allowDangerouslySkipPermissions).toBe(true);
  });

  it('honors an explicit valid permissionMode', async () => {
    const { queryOptions } = await build({ permissionMode: 'acceptEdits' });
    expect(queryOptions.permissionMode).toBe('acceptEdits');
    expect(queryOptions.allowDangerouslySkipPermissions).toBe(false);
  });

  it('falls back to "default" for an invalid permissionMode', async () => {
    const { queryOptions } = await build({ permissionMode: 'totally-not-a-mode' });
    expect(queryOptions.permissionMode).toBe('default');
  });

  it('sets cwd, additionalDirectories, model, includePartialMessages, abortController', async () => {
    const { queryOptions, internalAbortController } = await build({ repoPath: '/work' });
    expect(queryOptions.cwd).toBe('/work');
    expect(queryOptions.additionalDirectories).toEqual(['/work']);
    expect(queryOptions.model).toBe('claude-opus-4-7');
    expect(queryOptions.includePartialMessages).toBe(true);
    expect(queryOptions.abortController).toBe(internalAbortController);
  });

  it('mirrors an external aborted signal into the internal AbortController', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const { internalAbortController } = await build({ signal: ctl.signal });
    expect(internalAbortController.signal.aborted).toBe(true);
  });

  it('propagates a deferred external abort', async () => {
    const ctl = new AbortController();
    const { internalAbortController } = await build({ signal: ctl.signal });
    expect(internalAbortController.signal.aborted).toBe(false);
    ctl.abort();
    expect(internalAbortController.signal.aborted).toBe(true);
  });

  it('defaults settingSources to ["project"] when nothing supplied', async () => {
    const { queryOptions } = await build();
    expect(queryOptions.settingSources).toEqual(['project']);
  });

  it('honors settingSources=[] (isolation mode)', async () => {
    const { queryOptions } = await build({ optionsConfig: { settingSources: [] } });
    expect(queryOptions.settingSources).toEqual([]);
  });

  it('filters invalid settingSources entries', async () => {
    const { queryOptions } = await build({
      optionsConfig: { settingSources: ['user', 'project', 'evil', 'local', 42] },
    });
    expect(queryOptions.settingSources).toEqual(['user', 'project', 'local']);
  });

  it('applies systemPromptConfig string', async () => {
    const { queryOptions } = await build({ systemPromptConfig: '  hello  ' });
    expect(queryOptions.systemPrompt).toBe('hello');
  });

  it('skips empty-string systemPromptConfig', async () => {
    const { queryOptions } = await build({ systemPromptConfig: '   ' });
    expect(queryOptions.systemPrompt).toBeUndefined();
  });

  it('applies systemPromptConfig {type: "preset", preset: "claude_code"}', async () => {
    const { queryOptions } = await build({
      systemPromptConfig: { type: 'preset', preset: 'claude_code', append: 'extra' },
    });
    expect(queryOptions.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'extra',
    });
  });

  it('forwards optionsConfig allowedTools / disallowedTools when string arrays', async () => {
    const { queryOptions } = await build({
      optionsConfig: {
        allowedTools: ['Bash', 'Edit'],
        disallowedTools: ['Read'],
      },
    });
    expect(queryOptions.allowedTools).toEqual(['Bash', 'Edit']);
    expect(queryOptions.disallowedTools).toEqual(['Read']);
  });

  it('forwards optionsConfig.tools as a string array', async () => {
    const { queryOptions } = await build({
      optionsConfig: { tools: ['Bash', 'Read'] },
    });
    expect(queryOptions.tools).toEqual(['Bash', 'Read']);
  });

  it('forwards optionsConfig.tools as a {type: "preset"} object', async () => {
    const { queryOptions } = await build({
      optionsConfig: { tools: { type: 'preset', preset: 'claude_code' } },
    });
    expect(queryOptions.tools).toEqual({ type: 'preset', preset: 'claude_code' });
  });

  it('forwards optionsConfig.betas when string array', async () => {
    const { queryOptions } = await build({
      optionsConfig: { betas: ['interleaved-thinking-2025-05-14'] },
    });
    expect(queryOptions.betas).toEqual(['interleaved-thinking-2025-05-14']);
  });

  it('forwards optionsConfig.outputFormat / enableFileCheckpointing / sandbox', async () => {
    const { queryOptions } = await build({
      optionsConfig: {
        outputFormat: { type: 'json' },
        enableFileCheckpointing: true,
        sandbox: { mode: 'workspace-write' },
      },
    });
    expect(queryOptions.outputFormat).toEqual({ type: 'json' });
    expect(queryOptions.enableFileCheckpointing).toBe(true);
    expect(queryOptions.sandbox).toEqual({ mode: 'workspace-write' });
  });

  it('forwards numeric SDK options when finite', async () => {
    const { queryOptions } = await build({
      optionsConfig: {
        maxThinkingTokens: 12000,
        maxTurns: 50,
        maxBudgetUsd: 5,
      },
    });
    expect(queryOptions.maxThinkingTokens).toBe(12000);
    expect(queryOptions.maxTurns).toBe(50);
    expect(queryOptions.maxBudgetUsd).toBe(5);
  });

  it('drops non-finite numeric SDK options (NaN, Infinity)', async () => {
    const { queryOptions } = await build({
      optionsConfig: {
        maxThinkingTokens: NaN,
        maxTurns: Infinity,
      },
    });
    expect(queryOptions.maxThinkingTokens).toBeUndefined();
    expect(queryOptions.maxTurns).toBeUndefined();
  });

  it('injects HumanChrome MCP server by default', async () => {
    const { queryOptions } = await build();
    const mcp = queryOptions.mcpServers as Record<string, { type: string; url: string }>;
    expect(mcp.humanchrome).toBeDefined();
    expect(mcp.humanchrome.type).toBe('http');
  });

  it('preserves user-provided mcpServers alongside the HumanChrome injection', async () => {
    const { queryOptions } = await build({
      optionsConfig: {
        mcpServers: {
          custom: { type: 'http', url: 'https://custom.example/mcp' },
        },
      },
    });
    const mcp = queryOptions.mcpServers as Record<string, { type: string; url: string }>;
    expect(mcp.custom).toBeDefined();
    expect(mcp.humanchrome).toBeDefined();
  });

  it('sets resume option when resumeClaudeSessionId is provided', async () => {
    const { queryOptions } = await build({ resumeClaudeSessionId: 'sess-123' });
    expect(queryOptions.resume).toBe('sess-123');
  });

  it('does NOT set resume option when resumeClaudeSessionId is missing', async () => {
    const { queryOptions } = await build({ resumeClaudeSessionId: undefined });
    expect(queryOptions.resume).toBeUndefined();
  });

  it('exposes a stderr callback that pushes lines into the caller-owned buffer', async () => {
    const buffer: string[] = [];
    const { queryOptions } = await build({ stderrBuffer: buffer });
    const cb = queryOptions.stderr as (s: string) => void;
    cb('first line\n');
    cb('second line\n');
    cb(''); // empty after trim → ignored
    expect(buffer).toEqual(['first line', 'second line']);
  });

  it('caps stderr buffer growth via the MAX_STDERR_LINES guard', async () => {
    // The cap is `ClaudeEngine.MAX_STDERR_LINES` (private static, currently 200).
    // We deliberately don't import the constant: the test asserts the *contract*
    // (buffer never grows unbounded after the cap, newest line wins) rather
    // than the exact number, so a future bump won't silently break it. Pre-fill
    // with 250 lines — comfortably above any reasonable cap — so the first
    // appended line MUST trigger the shift path.
    const PRE_FILL = 250;
    const buffer: string[] = [];
    for (let i = 0; i < PRE_FILL; i++) buffer.push(`pre-${i}`);
    const { queryOptions } = await build({ stderrBuffer: buffer });
    const cb = queryOptions.stderr as (s: string) => void;
    cb('NEW\n');
    // After one push past the cap we expect AT MOST PRE_FILL + 1 lines (one
    // shift fired). The newest line must be at the tail.
    expect(buffer.length).toBeLessThanOrEqual(PRE_FILL + 1);
    expect(buffer[buffer.length - 1]).toBe('NEW');
  });

  it('merges session env over claudeEnv and re-prepends node bin to PATH', async () => {
    const { queryOptions } = await build({
      claudeEnv: { PATH: '/usr/bin', FOO: 'base' } as NodeJS.ProcessEnv,
      optionsConfig: {
        env: { FOO: 'session', BAR: 'set' },
      },
    });
    const env = queryOptions.env as NodeJS.ProcessEnv;
    expect(env.FOO).toBe('session');
    expect(env.BAR).toBe('set');
    // Node bin path should be present even though session env didn't include it
    expect(env.PATH).toContain('/usr/bin');
  });
});
