/**
 * Unit tests for `CodexEngine.buildCliInvocation` (IMP-0049 slice 1).
 *
 * The method is the analog of `ClaudeEngine.loadSdk` extracted in
 * IMP-0009 slice 1: a self-contained piece pulled out of the giant
 * `initializeAndRun` so it can be unit-tested without spawning a real
 * Codex process. Locks the args-list ordering and the temp-file
 * surface so future slices can move callsites without losing coverage.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { CodexEngine } from './codex';
import {
  CODEX_AUTO_INSTRUCTIONS,
  DEFAULT_CODEX_CONFIG,
  type CodexEngineConfig,
} from 'humanchrome-shared';

// Avoid touching real filesystem in attachment tests.
jest.mock('node:fs/promises', () => ({
  writeFile: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));

const baseConfig: CodexEngineConfig = {
  ...DEFAULT_CODEX_CONFIG,
  autoInstructions: CODEX_AUTO_INSTRUCTIONS,
};

function callBuilder(
  overrides: Partial<{
    prompt: string;
    repoPath: string;
    enableHumanChrome: boolean;
    model: string;
    attachments: { type: string; name: string; mimeType: string; dataBase64: string }[];
    resolvedImagePaths: string[];
    resolvedConfig: CodexEngineConfig;
  }> = {},
): Promise<{ executable: string; args: string[]; tempFiles: string[] }> {
  const engine = new CodexEngine();
  const input = {
    prompt: 'do the thing',
    repoPath: '/tmp/work',
    enableHumanChrome: true,
    model: undefined,
    attachments: undefined,
    resolvedImagePaths: undefined,
    resolvedConfig: baseConfig,
    ...overrides,
  };
  // `buildCliInvocation` is private; reach in for tests so callers don't
  // need to stand up a full `initializeAndRun` flow.
  return (
    engine as unknown as {
      buildCliInvocation: (
        i: typeof input,
      ) => Promise<{ executable: string; args: string[]; tempFiles: string[] }>;
    }
  ).buildCliInvocation(input);
}

describe('CodexEngine.buildCliInvocation', () => {
  it('uses codex.cmd on win32 and codex elsewhere', async () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const mac = await callBuilder();
    expect(mac.executable).toBe('codex');

    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const win = await callBuilder();
    expect(win.executable).toBe('codex.cmd');

    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  });

  it('starts with the canonical exec flag block then the repoPath after --cd', async () => {
    const result = await callBuilder({ repoPath: '/repo' });
    expect(result.args.slice(0, 8)).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      '--color',
      'never',
      '--cd',
      '/repo',
    ]);
    // first config flag from buildCodexConfigArgs lands right after the canonical block.
    expect(result.args[8]).toBe('-c');
  });

  it('appends the prompt as the LAST positional arg', async () => {
    const result = await callBuilder({ prompt: 'final prompt' });
    expect(result.args[result.args.length - 1]).toBe('final prompt');
  });

  it('injects the humanchrome MCP url + type when enableHumanChrome is true', async () => {
    const result = await callBuilder({ enableHumanChrome: true });
    const flat = result.args.join(' ');
    expect(flat).toMatch(/mcp_servers\.humanchrome\.url=/);
    expect(flat).toMatch(/mcp_servers\.humanchrome\.type="http"/);
  });

  it('omits the humanchrome MCP entries when enableHumanChrome is false', async () => {
    const result = await callBuilder({ enableHumanChrome: false });
    expect(result.args.join(' ')).not.toMatch(/mcp_servers\.humanchrome\./);
  });

  it('inserts --model when a non-empty trimmed model is provided', async () => {
    const result = await callBuilder({ model: '  gpt-codex-pro  ' });
    const idx = result.args.indexOf('--model');
    expect(idx).toBeGreaterThan(-1);
    expect(result.args[idx + 1]).toBe('gpt-codex-pro');
  });

  it('omits --model when model is missing or whitespace-only', async () => {
    const blank = await callBuilder({ model: '   ' });
    expect(blank.args).not.toContain('--model');
    const missing = await callBuilder({ model: undefined });
    expect(missing.args).not.toContain('--model');
  });

  it('prefers resolvedImagePaths over attachments when both are present', async () => {
    const result = await callBuilder({
      resolvedImagePaths: ['/persistent/a.png', '/persistent/b.png'],
      attachments: [{ type: 'image', name: 'c.png', mimeType: 'image/png', dataBase64: 'AAA' }],
    });
    const imageArgs = result.args.reduce<string[]>((acc, a, i) => {
      if (a === '--image') acc.push(result.args[i + 1]);
      return acc;
    }, []);
    expect(imageArgs).toEqual(['/persistent/a.png', '/persistent/b.png']);
    expect(result.tempFiles).toEqual([]);
  });

  it('writes attachments to temp files when no resolvedImagePaths are supplied', async () => {
    const result = await callBuilder({
      attachments: [
        { type: 'image', name: 'photo one.png', mimeType: 'image/png', dataBase64: 'AAA' },
        { type: 'image', name: 'photo two.png', mimeType: 'image/png', dataBase64: 'BBB' },
      ],
    });
    expect(result.tempFiles.length).toBe(2);
    const imageArgs = result.args.reduce<string[]>((acc, a, i) => {
      if (a === '--image') acc.push(result.args[i + 1]);
      return acc;
    }, []);
    expect(imageArgs).toEqual(result.tempFiles);
  });

  it('skips non-image attachments silently', async () => {
    const result = await callBuilder({
      attachments: [
        { type: 'document', name: 'spec.pdf', mimeType: 'application/pdf', dataBase64: 'AAA' },
      ],
    });
    expect(result.tempFiles).toEqual([]);
    expect(result.args).not.toContain('--image');
  });
});
