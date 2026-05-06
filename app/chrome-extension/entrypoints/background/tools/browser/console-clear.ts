import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';
import { consoleBuffer } from './console-buffer';

interface ConsoleClearToolParams {
  tabId?: number;
  windowId?: number;
}

/**
 * Reset the per-tab console buffer used by `chrome_console` (mode="buffer")
 * and the `console_clean` predicate of `chrome_assert`. After a clear, the
 * next read is scoped to messages that arrived strictly after the call —
 * the same reset pattern test frameworks use between assertions.
 *
 * Returns `{ success, tabId, cleared }` where `cleared` is the number of
 * buffered entries dropped (messages + exceptions). When the buffer wasn't
 * yet started for this tab, `cleared` is 0 and the call is a no-op.
 */
class ConsoleClearTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.CONSOLE_CLEAR;

  async execute(args: ConsoleClearToolParams = {}): Promise<ToolResult> {
    const { tabId, windowId } = args || {};

    let targetTab: chrome.tabs.Tab | null = null;
    try {
      if (typeof tabId === 'number') {
        targetTab = await this.tryGetTab(tabId);
        if (!targetTab?.id) {
          return createErrorResponse(
            `Tab ${tabId} not found.`,
            ToolErrorCode.TAB_NOT_FOUND,
            { tabId },
          );
        }
      } else {
        targetTab = await this.getActiveTabOrThrowInWindow(windowId);
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return createErrorResponse(msg, ToolErrorCode.TAB_NOT_FOUND, { tabId, windowId });
    }

    const targetTabId = targetTab.id!;

    // consoleBuffer.clear returns null when capture hasn't started for this
    // tab — that's a no-op (nothing was buffered yet), not an error. The
    // assert/console-buffer-mode flow auto-starts capture, so a clear before
    // any read is a legitimate "ensure-clean" call.
    const result = consoleBuffer.clear(targetTabId, 'manual');
    const clearedMessages = result?.clearedMessages ?? 0;
    const clearedExceptions = result?.clearedExceptions ?? 0;
    const cleared = clearedMessages + clearedExceptions;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            tabId: targetTabId,
            cleared,
            clearedMessages,
            clearedExceptions,
            bufferActive: result !== null,
          }),
        },
      ],
      isError: false,
    };
  }
}

export const consoleClearTool = new ConsoleClearTool();
