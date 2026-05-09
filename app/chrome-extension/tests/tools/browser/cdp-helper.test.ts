import { beforeEach, describe, expect, it, vi } from 'vitest';

const stubs = vi.hoisted(() => ({
  attach: vi.fn(),
  detach: vi.fn(),
  sendCommand: vi.fn(),
}));

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: {
    attach: stubs.attach,
    detach: stubs.detach,
    sendCommand: stubs.sendCommand,
  },
}));

import { CDPHelper } from '@/entrypoints/background/tools/browser/computer/cdp-helper';

beforeEach(() => {
  stubs.attach.mockReset().mockResolvedValue(undefined);
  stubs.detach.mockReset().mockResolvedValue(undefined);
  stubs.sendCommand.mockReset().mockResolvedValue({});
});

describe('CDPHelper — extracted module', () => {
  it('attaches with the "computer" owner tag', async () => {
    await CDPHelper.attach(7);
    expect(stubs.attach).toHaveBeenCalledWith(7, 'computer');
  });

  it('detaches with the "computer" owner tag', async () => {
    await CDPHelper.detach(7);
    expect(stubs.detach).toHaveBeenCalledWith(7, 'computer');
  });

  it('forwards send() with the per-tab timeout when one is set via withTimeout', async () => {
    await CDPHelper.withTimeout(7, 1234, async () => {
      await CDPHelper.send(7, 'Some.method', { x: 1 });
    });
    expect(stubs.sendCommand).toHaveBeenCalledWith(7, 'Some.method', { x: 1 }, 1234);
  });

  it('falls back to undefined timeout when no withTimeout is in scope', async () => {
    await CDPHelper.send(7, 'Some.method', { y: 2 });
    expect(stubs.sendCommand).toHaveBeenCalledWith(7, 'Some.method', { y: 2 }, undefined);
  });

  it('restores the previous timeout after withTimeout exits (incl. nesting)', async () => {
    await CDPHelper.withTimeout(7, 1000, async () => {
      await CDPHelper.withTimeout(7, 2000, async () => {
        await CDPHelper.send(7, 'A');
      });
      await CDPHelper.send(7, 'B');
    });
    await CDPHelper.send(7, 'C');

    expect(stubs.sendCommand).toHaveBeenNthCalledWith(1, 7, 'A', undefined, 2000);
    expect(stubs.sendCommand).toHaveBeenNthCalledWith(2, 7, 'B', undefined, 1000);
    expect(stubs.sendCommand).toHaveBeenNthCalledWith(3, 7, 'C', undefined, undefined);
  });

  it('keeps timeouts isolated per tabId (no cross-tab clobber)', async () => {
    await CDPHelper.withTimeout(7, 5000, async () => {
      await CDPHelper.withTimeout(8, 9000, async () => {
        await CDPHelper.send(7, 'TabSeven');
        await CDPHelper.send(8, 'TabEight');
      });
    });
    expect(stubs.sendCommand).toHaveBeenNthCalledWith(1, 7, 'TabSeven', undefined, 5000);
    expect(stubs.sendCommand).toHaveBeenNthCalledWith(2, 8, 'TabEight', undefined, 9000);
  });

  it('builds the modifier mask additively', () => {
    expect(CDPHelper.modifierMask([])).toBe(0);
    expect(CDPHelper.modifierMask(['shift'])).toBe(8);
    expect(CDPHelper.modifierMask(['ctrl', 'alt', 'shift'])).toBe(11);
    // ctrl=2, control=2 (alias), meta=4, cmd=4 (alias) — should not double-add
    expect(CDPHelper.modifierMask(['ctrl', 'control'])).toBe(2);
  });

  it('insertText routes to Input.insertText (and dispatchSimpleKey for a single char piggybacks)', async () => {
    await CDPHelper.insertText(7, 'hello');
    expect(stubs.sendCommand).toHaveBeenLastCalledWith(
      7,
      'Input.insertText',
      { text: 'hello' },
      undefined,
    );

    await CDPHelper.dispatchSimpleKey(7, 'a');
    expect(stubs.sendCommand).toHaveBeenLastCalledWith(
      7,
      'Input.insertText',
      { text: 'a' },
      undefined,
    );
  });

  it('dispatchSimpleKey for a named key fires rawKeyDown + keyUp', async () => {
    await CDPHelper.dispatchSimpleKey(7, 'Enter');
    expect(stubs.sendCommand).toHaveBeenCalledTimes(2);
    expect(stubs.sendCommand.mock.calls[0]).toEqual([
      7,
      'Input.dispatchKeyEvent',
      { type: 'rawKeyDown', key: 'Enter', code: 'Enter' },
      undefined,
    ]);
    expect(stubs.sendCommand.mock.calls[1]).toEqual([
      7,
      'Input.dispatchKeyEvent',
      { type: 'keyUp', key: 'Enter', code: 'Enter' },
      undefined,
    ]);
  });

  it('dispatchKeyChord splits modifiers from the keytoken and applies the mask', async () => {
    await CDPHelper.dispatchKeyChord(7, 'Ctrl+Shift+a');
    expect(stubs.sendCommand).toHaveBeenCalledTimes(2);
    const [, , downParams] = stubs.sendCommand.mock.calls[0]!;
    const [, , upParams] = stubs.sendCommand.mock.calls[1]!;
    expect(downParams.modifiers).toBe(2 | 8); // ctrl + shift
    expect(downParams.key).toBe('A');
    expect(downParams.text).toBe('a');
    expect(upParams.modifiers).toBe(2 | 8);
  });
});
