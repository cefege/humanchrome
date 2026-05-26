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

import { awaitElementTool } from '@/entrypoints/background/tools/browser/await-element';
import { tabGroupsTool } from '@/entrypoints/background/tools/browser/tab-groups';
import { sessionsTool } from '@/entrypoints/background/tools/browser/sessions';
import { networkCaptureTool } from '@/entrypoints/background/tools/browser/network-capture';
import { waitForTool } from '@/entrypoints/background/tools/browser/wait-for';
import { actionBadgeTool } from '@/entrypoints/background/tools/browser/action-badge';

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
  it('chrome_await_element bad state → details.arg/received/expected/hint', async () => {
    const res = await awaitElementTool.execute({ selector: '#x', state: 'persent' } as any);
    expect(res.isError).toBe(true);
    const env = parseEnvelope(res);
    expect(env.error.code).toBe('INVALID_ARGS');
    expect(env.error.details.arg).toBe('state');
    expect(env.error.details.received).toBe('persent');
    expect(env.error.details.expected).toEqual({ enum: ['present', 'absent'] });
    expect(env.error.details.hint).toBe('Did you mean "present"?');
  });

  it('chrome_await_element bad selectorType → enum + hint when close', async () => {
    const res = await awaitElementTool.execute({
      selector: '#x',
      selectorType: 'cs' as any,
    });
    const env = parseEnvelope(res);
    expect(env.error.code).toBe('INVALID_ARGS');
    expect(env.error.details.arg).toBe('selectorType');
    expect(env.error.details.received).toBe('cs');
    expect(env.error.details.expected.enum).toContain('css');
    expect(env.error.details.hint).toBe('Did you mean "css"?');
  });

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
});
