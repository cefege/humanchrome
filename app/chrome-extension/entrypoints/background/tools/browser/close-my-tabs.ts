import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';
import { getCurrentRequestContext } from '../../utils/request-context';
import { getClientState, releaseTabFromClient } from '../../utils/client-state';
import { safeRemoveTabs } from '@/utils/last-tab-guard';

interface CloseMyTabsParams {
  keep?: number[];
}

interface FailedClose {
  tabId: number;
  reason: 'TAB_CLOSED' | 'UNKNOWN';
  message?: string;
}

/**
 * Close every tab currently owned by the calling MCP client.
 *
 * Disconnect releases ownership without closing — call this tool when
 * the caller wants the opposite (CI cleanup, one-shot script, agent
 * dismissing its workspace). Optional `keep` preserves a subset.
 *
 * Partial success is normal: an already-closed tab surfaces as
 * `reason: 'TAB_CLOSED'` in `failed[]` and `success` stays `true`.
 */
class CloseMyTabsTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.CLOSE_MY_TABS;
  static readonly autoSpawnTab = false;

  async execute(args: CloseMyTabsParams = {}): Promise<ToolResult> {
    const ctx = getCurrentRequestContext();
    const clientId = ctx?.clientId;
    if (!clientId) {
      return createErrorResponse(
        'No client id bound to this call — ownership is per-MCP-client.',
        ToolErrorCode.INVALID_ARGS,
      );
    }

    let keep: number[] = [];
    if (args.keep !== undefined) {
      if (!Array.isArray(args.keep)) {
        return createErrorResponse(
          '`keep` must be an array of numbers',
          ToolErrorCode.INVALID_ARGS,
          { arg: 'keep' },
        );
      }
      for (const id of args.keep) {
        if (typeof id !== 'number' || !Number.isFinite(id)) {
          return createErrorResponse(
            '`keep` entries must be finite numbers',
            ToolErrorCode.INVALID_ARGS,
            { arg: 'keep' },
          );
        }
      }
      keep = args.keep;
    }

    const state = getClientState(clientId);
    const owned = state ? Array.from(state.ownedTabs) : [];
    const keepSet = new Set(keep.filter((id) => state?.ownedTabs.has(id)));
    const toClose = owned.filter((id) => !keepSet.has(id));

    const closed: number[] = [];
    const failed: FailedClose[] = [];

    for (const tabId of toClose) {
      try {
        await safeRemoveTabs(tabId);
        releaseTabFromClient(clientId, tabId);
        closed.push(tabId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        releaseTabFromClient(clientId, tabId);
        if (/no tab with id/i.test(message)) {
          failed.push({ tabId, reason: 'TAB_CLOSED' });
        } else {
          failed.push({ tabId, reason: 'UNKNOWN', message });
        }
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            closed,
            kept: Array.from(keepSet),
            failed,
          }),
        },
      ],
      isError: false,
    };
  }
}

export const closeMyTabsTool = new CloseMyTabsTool();
