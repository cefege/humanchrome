import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, jest } from '@jest/globals';

// The queue singleton's default source gate reads the native-messaging host.
// Force it inactive so `submit` enqueues without the drain worker forwarding
// anything to a (nonexistent) extension — keeps this surface test hermetic.
jest.mock('../native-messaging-host', () => ({
  __esModule: true,
  default: { isSourceActive: () => false, newRequestId: () => 'test-req' },
}));
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_SCHEMAS, buildDispatcherTool, isKnownToolName } from 'humanchrome-shared';
import { handleTasksTool } from './tasks-tool';

function parse(result: CallToolResult): unknown {
  const block = result.content[0];
  if (block.type === 'text') return JSON.parse(block.text);
  throw new Error('expected a text content block');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

beforeAll(() => {
  process.env.CHROME_MCP_AGENT_DB_FILE = path.join(os.tmpdir(), `tasks-tool-${Date.now()}.db`);
});

describe('handleTasksTool', () => {
  it('submit returns a queued ack and the row is listable, then cancellable', async () => {
    const submit = parse(
      await handleTasksTool(
        { action: 'submit', tool: 'chrome_navigate', args: { url: 'https://example.com' } },
        'c1',
      ),
    );
    expect(isRecord(submit)).toBe(true);
    if (!isRecord(submit)) return;
    expect(submit.status).toBe('queued');
    expect(typeof submit.taskId).toBe('string');
    const taskId = submit.taskId;

    const listed = parse(await handleTasksTool({ action: 'list' }, 'c1'));
    expect(isRecord(listed)).toBe(true);
    if (!isRecord(listed)) return;
    const tasks = listed.tasks;
    expect(Array.isArray(tasks)).toBe(true);
    const found = (tasks as Array<Record<string, unknown>>).find((t) => t.id === taskId);
    expect(found?.status).toBe('queued');

    const cancelled = parse(await handleTasksTool({ action: 'cancel', taskId }, 'c1'));
    expect(cancelled).toEqual({ cancelled: true, status: 'cancelled' });
  });

  it('status returns the row (args parsed) or {found:false}', async () => {
    const submit = parse(
      await handleTasksTool(
        { action: 'submit', tool: 'chrome_navigate', args: { url: 'https://x.test' } },
        'c1',
      ),
    );
    if (!isRecord(submit) || typeof submit.taskId !== 'string') throw new Error('no taskId');
    const status = parse(await handleTasksTool({ action: 'status', taskId: submit.taskId }, 'c1'));
    expect(isRecord(status)).toBe(true);
    if (!isRecord(status)) return;
    expect(status.id).toBe(submit.taskId);
    expect(status.args).toEqual({ url: 'https://x.test' });

    const missing = parse(await handleTasksTool({ action: 'status', taskId: 'nope' }, 'c1'));
    expect(missing).toEqual({ found: false });
  });

  it('rejects an unknown action with an INVALID_ARGS envelope', async () => {
    const result = await handleTasksTool({ action: 'bogus' }, 'c1');
    expect(result.isError).toBe(true);
    const payload = parse(result);
    expect(isRecord(payload)).toBe(true);
    if (!isRecord(payload) || !isRecord(payload.error)) return;
    expect(payload.error.code).toBe('INVALID_ARGS');
  });

  it('rejects submitting chrome_tasks itself (no recursion)', async () => {
    const result = await handleTasksTool(
      { action: 'submit', tool: 'chrome_tasks', args: {} },
      'c1',
    );
    expect(result.isError).toBe(true);
  });

  it('is registered in the shared catalog and dispatcher description', () => {
    expect(TOOL_SCHEMAS.some((t) => t.name === 'chrome_tasks')).toBe(true);
    expect(isKnownToolName('chrome_tasks')).toBe(true);
    expect(buildDispatcherTool().description).toContain('chrome_tasks');
  });
});
