import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';
import { getCurrentRequestContext } from '../../utils/request-context';
import { claimTabForClient, findTabOwner } from '../../utils/client-state';

interface ClaimTabParams {
  tabId?: number;
}

/**
 * Claim a tab as owned by the calling MCP client.
 *
 * Tabs the user opened manually (or that another client released on
 * disconnect) start out unowned and are invisible to the implicit
 * tab-resolution path. This tool brings such a tab into the calling
 * client's owned set so subsequent calls without an explicit `tabId`
 * can target it.
 *
 * Refuses to take a tab currently owned by a different client — callers
 * must coordinate (or use the `force: true` follow-up once it exists).
 */
class ClaimTabTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.CLAIM_TAB;
  // Even though this mutates per-client state, it never needs the dispatcher
  // to auto-spawn a tab — it's targeting a specific existing tab.
  static readonly autoSpawnTab = false;

  async execute(args: ClaimTabParams): Promise<ToolResult> {
    const ctx = getCurrentRequestContext();
    const clientId = ctx?.clientId;

    if (!clientId) {
      return createErrorResponse(
        'No client id bound to this call — ownership is per-MCP-client.',
        ToolErrorCode.INVALID_ARGS,
      );
    }
    const tabId = args?.tabId;
    if (typeof tabId !== 'number' || !Number.isFinite(tabId)) {
      return createErrorResponse(
        '`tabId` is required and must be a number',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'tabId' },
      );
    }

    const tab = await this.tryGetTab(tabId);
    if (!tab) {
      return createErrorResponse(`Tab ${tabId} not found`, ToolErrorCode.TAB_NOT_FOUND, { tabId });
    }

    const owner = findTabOwner(tabId);
    if (owner && owner !== clientId) {
      return createErrorResponse(
        `Tab ${tabId} is owned by client ${owner}; coordinate with them or wait until they release it.`,
        ToolErrorCode.TAB_NOT_OWNED,
        { tabId, owner },
      );
    }

    const previousOwner = claimTabForClient(clientId, tabId, tab.windowId);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            tabId,
            windowId: tab.windowId,
            previousOwner,
          }),
        },
      ],
      isError: false,
    };
  }
}

export const claimTabTool = new ClaimTabTool();
