import {
  createErrorResponse,
  createErrorResponseFromThrown,
  ToolResult,
} from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';
import { DEFAULT_WAIT_FOR_TAB_TIMEOUT_MS, waitForTabComplete } from '../../utils/wait-for-tab';

interface WaitForTabParams {
  tabId?: number;
  timeoutMs?: number;
}

class WaitForTabTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.WAIT_FOR_TAB;

  async execute(args: WaitForTabParams): Promise<ToolResult> {
    const { tabId, timeoutMs = DEFAULT_WAIT_FOR_TAB_TIMEOUT_MS } = args ?? {};

    if (typeof tabId !== 'number') {
      return createErrorResponse(
        'tabId is required for chrome_wait_for_tab',
        ToolErrorCode.INVALID_ARGS,
      );
    }

    const startedAt = Date.now();
    try {
      const tab = await waitForTabComplete(tabId, { timeoutMs });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              tabId: tab.id,
              status: tab.status,
              url: tab.url,
              title: tab.title,
              durationMs: Date.now() - startedAt,
            }),
          },
        ],
        isError: false,
      };
    } catch (err) {
      return createErrorResponseFromThrown(err);
    }
  }
}

export const waitForTabTool = new WaitForTabTool();
