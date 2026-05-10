/**
 * Input action handlers extracted from computer.ts (IMP-0054 slice 4).
 * Covers `type`, `key`, `fill`, `fill_form`, and `wait`.
 *
 * Same deps bag as click/scroll: tab + project + injectContentScript +
 * sendMessageToTab. Reuses ClickActionDeps shape.
 */
import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import { TIMEOUTS } from '@/common/constants';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { CDPHelper } from '../cdp-helper';
import { clickTool, fillTool } from '../../interaction';
import { keyboardTool } from '../../keyboard';
import { type ComputerParams } from '../../computer';
import { type ClickActionDeps } from './click-actions';

export type InputActionDeps = ClickActionDeps;

/** Handles `type`. */
export async function handleType(
  params: ComputerParams,
  deps: InputActionDeps,
): Promise<ToolResult> {
  const { tab } = deps;
  const tabId = tab.id!;
  if (!params.text) return createErrorResponse('Text parameter is required for type action');

  try {
    if (params.ref) {
      await clickTool.execute({
        ref: params.ref,
        waitForNavigation: false,
        timeoutMs: TIMEOUTS.DEFAULT_WAIT * 5,
      });
    }
    await CDPHelper.attach(tabId);
    // CDP insertText avoids complex KeyboardEvent emulation for long text
    await CDPHelper.insertText(tabId, params.text);
    await CDPHelper.detach(tabId);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success: true, action: 'type', length: params.text.length }),
        },
      ],
      isError: false,
    };
  } catch {
    await CDPHelper.detach(tabId);
    // Fallback to DOM-based keyboard tool
    return keyboardTool.execute({
      keys: params.text.split('').join(','),
      delay: 0,
      selector: undefined,
    });
  }
}

/** Handles `fill`. */
export async function handleFill(
  params: ComputerParams,
  _deps: InputActionDeps,
): Promise<ToolResult> {
  if (!params.ref && !params.selector) {
    return createErrorResponse('Provide ref or selector and a value for fill');
  }
  if (params.value === undefined) {
    return createErrorResponse('Provide a value for fill');
  }
  return fillTool.execute({
    selector: params.selector,
    selectorType: params.selectorType,
    ref: params.ref,
    value: params.value,
    tabId: params.tabId,
    windowId: params.windowId,
    frameId: params.frameId,
  });
}

/** Handles `fill_form`. */
export async function handleFillForm(
  params: ComputerParams,
  _deps: InputActionDeps,
): Promise<ToolResult> {
  const elements = params.elements;
  if (!Array.isArray(elements) || elements.length === 0) {
    return createErrorResponse('elements must be a non-empty array for fill_form');
  }
  const results: Array<{ ref: string; ok: boolean; error?: string }> = [];
  for (const item of elements) {
    if (!item || !item.ref) {
      results.push({ ref: String(item?.ref || ''), ok: false, error: 'missing ref' });
      continue;
    }
    try {
      const r = await fillTool.execute({
        ref: item.ref,
        value: item.value,
        tabId: params.tabId,
        windowId: params.windowId,
        frameId: params.frameId,
      });
      const ok = !r.isError;
      results.push({ ref: item.ref, ok, error: ok ? undefined : 'failed' });
    } catch (e) {
      results.push({
        ref: item.ref,
        ok: false,
        error: String(e instanceof Error ? e.message : e),
      });
    }
  }
  const successCount = results.filter((r) => r.ok).length;
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          success: true,
          action: 'fill_form',
          filled: successCount,
          total: results.length,
          results,
        }),
      },
    ],
    isError: false,
  };
}

/** Handles `key` — single token, key chord (cmd+a), or whitespace-separated sequence. */
export async function handleKey(
  params: ComputerParams,
  deps: InputActionDeps,
): Promise<ToolResult> {
  const { tab } = deps;
  const tabId = tab.id!;
  if (!params.text) {
    return createErrorResponse(
      'text is required for key action (e.g., "Backspace Backspace Enter" or "cmd+a")',
    );
  }
  const tokens = params.text.trim().split(/\s+/).filter(Boolean);
  const repeat = params.repeat ?? 1;
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 100) {
    return createErrorResponse('repeat must be an integer between 1 and 100 for key action');
  }
  try {
    if (params.ref) {
      await clickTool.execute({
        ref: params.ref,
        waitForNavigation: false,
        timeoutMs: TIMEOUTS.DEFAULT_WAIT * 5,
      });
    }
    await CDPHelper.attach(tabId);
    for (let i = 0; i < repeat; i++) {
      for (const t of tokens) {
        if (t.includes('+')) await CDPHelper.dispatchKeyChord(tabId, t);
        else await CDPHelper.dispatchSimpleKey(tabId, t);
      }
    }
    await CDPHelper.detach(tabId);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success: true, action: 'key', keys: tokens, repeat }),
        },
      ],
      isError: false,
    };
  } catch {
    await CDPHelper.detach(tabId);
    // Fallback to DOM keyboard simulation (comma-separated combinations)
    const keysStr = tokens.join(',');
    const repeatedKeys =
      repeat === 1 ? keysStr : Array.from({ length: repeat }, () => keysStr).join(',');
    return keyboardTool.execute({ keys: repeatedKeys });
  }
}

/** Handles `wait` — text-condition wait via content script, or plain sleep. */
export async function handleWait(
  params: ComputerParams,
  deps: InputActionDeps,
): Promise<ToolResult> {
  const { tab, injectContentScript, sendMessageToTab } = deps;
  const tabId = tab.id!;

  const waitText = typeof params.text === 'string' ? params.text : '';
  if (waitText.trim().length > 0) {
    try {
      // wait-helper must reach all frames so deeply-nested matches still resolve.
      await injectContentScript(tabId, ['inject-scripts/wait-helper.js'], false, 'ISOLATED', true);
      const appear = params.appear !== false; // default true
      const timeoutMs = Math.max(0, Math.min(params.timeoutMs ?? 10000, 120000));
      const resp = await sendMessageToTab(tabId, {
        action: TOOL_MESSAGE_TYPES.WAIT_FOR_TEXT,
        text: waitText,
        appear,
        timeout: timeoutMs,
      });
      if (!resp || resp.success !== true) {
        const reason = (resp as { reason?: string } | undefined)?.reason;
        const errStr = (resp as { error?: string } | undefined)?.error;
        return createErrorResponse(
          reason === 'timeout'
            ? `wait_for timed out after ${timeoutMs}ms for text: ${waitText}`
            : `wait_for failed: ${errStr || 'unknown error'}`,
        );
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              action: 'wait_for',
              appear,
              text: waitText,
              matched: resp.matched || null,
              tookMs: (resp as { tookMs?: number }).tookMs,
            }),
          },
        ],
        isError: false,
      };
    } catch (e) {
      return createErrorResponse(`wait_for failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const seconds = Math.max(0, Math.min(params.duration ?? 0, 30));
  if (!seconds) return createErrorResponse('Duration parameter is required and must be > 0');
  await new Promise((r) => setTimeout(r, seconds * 1000));
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ success: true, action: 'wait', duration: seconds }),
      },
    ],
    isError: false,
  };
}
