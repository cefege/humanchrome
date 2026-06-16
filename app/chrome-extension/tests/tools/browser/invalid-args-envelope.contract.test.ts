/**
 * IMP-0178 — contract test for the self-correcting INVALID_ARGS envelope.
 *
 * Tools that validate enum-typed args MUST populate the canonical envelope
 * shape so the LLM can self-correct in one round-trip:
 *
 *   { error: {
 *       code: 'INVALID_ARGS',
 *       message: <human>,
 *       details: {
 *         arg: string,           // which argument
 *         received: <truncated>, // what the caller sent
 *         expected: <fragment>,  // schema fragment or { enum: [...] }
 *         hint?: string,         // "Did you mean ...?" when close
 *       }
 *   } }
 *
 * This file is the canary: any future tool that drops a field, mis-names
 * `arg`, or returns bare `INVALID_ARGS` without details breaks this test.
 * Cross-cuts the rollout — add a case for every tool that lands an enum
 * validator using `invalidArgsEnumDetails`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { tabGroupsTool } from '@/entrypoints/background/tools/browser/tab-groups';
import { sessionsTool } from '@/entrypoints/background/tools/browser/sessions';
import { networkCaptureTool } from '@/entrypoints/background/tools/browser/network-capture';
import { waitForTool } from '@/entrypoints/background/tools/browser/wait-for';
import { actionBadgeTool } from '@/entrypoints/background/tools/browser/action-badge';
import { clipboardTool } from '@/entrypoints/background/tools/browser/clipboard';
import { storageTool } from '@/entrypoints/background/tools/browser/storage';
import { emulateTool } from '@/entrypoints/background/tools/browser/emulate';
import { keyboardTool } from '@/entrypoints/background/tools/browser/keyboard';
import { historyTool } from '@/entrypoints/background/tools/browser/history';

// Slice 6: history_delete folded into history under action="delete".
const historyDeleteTool = {
  execute: (args: any) => historyTool.execute({ ...args, action: 'delete' }),
};

function parseEnvelope(res: any): any {
  return JSON.parse(res.content[0].text);
}

beforeEach(() => {
  (globalThis.chrome as any).tabs = {
    query: vi.fn().mockResolvedValue([{ id: 1 }]),
    get: vi.fn().mockResolvedValue({ id: 1 }),
    sendMessage: vi.fn().mockResolvedValue({ status: 'pong' }),
  };
  (globalThis.chrome as any).scripting = {
    executeScript: vi.fn().mockResolvedValue([{ result: undefined }]),
  };
  (globalThis.chrome as any).tabGroups = {};
  (globalThis.chrome as any).sessions = {};
});

describe('IMP-0178 INVALID_ARGS envelope', () => {
  it('chrome_tab_groups bad action → enum + hint', async () => {
    const res = await tabGroupsTool.execute({ action: 'creat' } as any);
    const env = parseEnvelope(res);
    expect(env.error.code).toBe('INVALID_ARGS');
    expect(env.error.details.arg).toBe('action');
    expect(env.error.details.received).toBe('creat');
    expect(env.error.details.expected.enum).toContain('create');
    expect(env.error.details.hint).toBe('Did you mean "create"?');
  });

  it('chrome_tab_groups bad color → enum surface', async () => {
    const res = await tabGroupsTool.execute({ action: 'create', color: 'purpl' } as any);
    const env = parseEnvelope(res);
    expect(env.error.code).toBe('INVALID_ARGS');
    expect(env.error.details.arg).toBe('color');
    expect(env.error.details.received).toBe('purpl');
    expect(env.error.details.expected.enum).toContain('purple');
    expect(env.error.details.hint).toBe('Did you mean "purple"?');
  });

  it('chrome_sessions bad action → enum + hint', async () => {
    const res = await sessionsTool.execute({ action: 'restor' } as any);
    const env = parseEnvelope(res);
    expect(env.error.code).toBe('INVALID_ARGS');
    expect(env.error.details.arg).toBe('action');
    expect(env.error.details.received).toBe('restor');
    expect(env.error.details.expected.enum).toContain('restore');
    expect(env.error.details.hint).toBe('Did you mean "restore"?');
  });

  it('chrome_network_capture bad action → enum + hint', async () => {
    const res = await networkCaptureTool.execute({ action: 'strat' } as any);
    const env = parseEnvelope(res);
    expect(env.error.code).toBe('INVALID_ARGS');
    expect(env.error.details.arg).toBe('action');
    expect(env.error.details.received).toBe('strat');
    expect(env.error.details.expected.enum).toContain('start');
    expect(env.error.details.hint).toBe('Did you mean "start"?');
  });

  it('garbage input far from any enum yields no hint but still expected', async () => {
    const res = await sessionsTool.execute({ action: 'xyzqqq' } as any);
    const env = parseEnvelope(res);
    expect(env.error.code).toBe('INVALID_ARGS');
    expect(env.error.details.expected.enum).toEqual(['get_recently_closed', 'restore']);
    expect(env.error.details.hint).toBeUndefined();
  });

  it('chrome_wait_for bad kind → enum + hint', async () => {
    const res = await waitForTool.execute({ kind: 'elemnt' } as any);
    const env = parseEnvelope(res);
    expect(env.error.code).toBe('INVALID_ARGS');
    expect(env.error.details.arg).toBe('kind');
    expect(env.error.details.received).toBe('elemnt');
    expect(env.error.details.expected.enum).toContain('element');
    expect(env.error.details.hint).toBe('Did you mean "element"?');
  });

  it('chrome_action_badge bad action → enum + hint', async () => {
    const res = await actionBadgeTool.execute({ action: 'st' } as any);
    const env = parseEnvelope(res);
    expect(env.error.code).toBe('INVALID_ARGS');
    expect(env.error.details.arg).toBe('action');
    expect(env.error.details.expected.enum).toEqual(['set', 'clear']);
    expect(env.error.details.hint).toBe('Did you mean "set"?');
  });

  it('chrome_clipboard bad action → enum + hint (IMP-0187)', async () => {
    const res = await clipboardTool.execute({ action: 'wrte' } as any);
    const env = parseEnvelope(res);
    expect(env.error.code).toBe('INVALID_ARGS');
    expect(env.error.details.arg).toBe('action');
    expect(env.error.details.expected.enum).toEqual(['read', 'write']);
    expect(env.error.details.hint).toBe('Did you mean "write"?');
  });

  it('chrome_storage bad action → enum + hint (IMP-0187)', async () => {
    const res = await storageTool.execute({ action: 'gte' } as any);
    const env = parseEnvelope(res);
    expect(env.error.code).toBe('INVALID_ARGS');
    expect(env.error.details.arg).toBe('action');
    expect(env.error.details.expected.enum).toEqual(['get', 'set', 'remove', 'clear', 'keys']);
    expect(env.error.details.hint).toBe('Did you mean "get"?');
  });

  it('chrome_emulate bad action → enum + hint (IMP-0187)', async () => {
    const res = await emulateTool.execute({ action: 'set_devic' } as any);
    const env = parseEnvelope(res);
    expect(env.error.code).toBe('INVALID_ARGS');
    expect(env.error.details.arg).toBe('action');
    expect(env.error.details.expected.enum).toContain('set_device');
    expect(env.error.details.hint).toBe('Did you mean "set_device"?');
  });

  it('chrome_keyboard missing keys+shortcut → one_of expected + hint (IMP-0187)', async () => {
    const res = await keyboardTool.execute({} as any);
    const env = parseEnvelope(res);
    expect(env.error.code).toBe('INVALID_ARGS');
    expect(env.error.details.arg).toBe('keys|shortcut');
    expect(env.error.details.expected.kind).toBe('one_of');
    expect(env.error.details.expected.options).toEqual(['keys', 'shortcut']);
    expect(env.error.details.hint).toContain('keys');
  });

  it('chrome_history_delete no mode chosen → one_of expected + hint (IMP-0187)', async () => {
    const res = await historyDeleteTool.execute({} as any);
    const env = parseEnvelope(res);
    expect(env.error.code).toBe('INVALID_ARGS');
    expect(env.error.details.arg).toBe('mode');
    expect(env.error.details.expected.kind).toBe('one_of');
    expect(env.error.details.expected.options).toEqual(['url', 'range', 'all']);
    expect(env.error.details.hint).toContain('url');
  });
});
