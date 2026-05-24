import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';
import { getCurrentRequestContext } from '../../utils/request-context';
import {
  ALIAS_REGEX,
  getClientState,
  setAliasForClient,
} from '../../utils/client-state';

interface AliasTabParams {
  /** Tab to alias. Defaults to the caller's `activeTabId`. */
  tabId?: number;
  /** Alias name. Must match `^[a-z][a-z0-9_-]{0,31}$`. */
  alias: string;
}

/**
 * `browser_alias_tab` (IMP-0169) — name an owned tab so subsequent
 * tool calls can target it via `{tabAlias: 'checkout'}` instead of
 * juggling raw tab ids. Aliases are per-client (alice's `'checkout'`
 * is not bob's), self-evict when the underlying tab closes or the
 * client releases, and don't transfer on force-claim.
 *
 * Behavior:
 *   - `alias` regex `^[a-z][a-z0-9_-]{0,31}$` — INVALID_ARGS on miss.
 *   - `tabId` defaults to `activeTabId`; INVALID_ARGS if neither is
 *     resolvable (the caller has no active tab and didn't supply one).
 *   - The tab must be in the caller's owned set; otherwise
 *     TAB_NOT_OWNED (the caller can `browser_claim_tab` first).
 *   - Reusing an alias overwrites the prior mapping; response carries
 *     `previousTabId` so the LLM sees the change.
 *
 * Non-mutating (no `mutates`) — aliases live in ClientState, not in a
 * tab's page DOM. The dispatcher's per-tab queue doesn't apply.
 * `autoSpawnTab: false` because alias creation should fail loudly if
 * no tab is implied, not silently spawn one.
 */
class AliasTabTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.ALIAS_TAB;
  static readonly autoSpawnTab = false;

  async execute(args: AliasTabParams): Promise<ToolResult> {
    const ctx = getCurrentRequestContext();
    const clientId = ctx?.clientId;
    if (!clientId) {
      return createErrorResponse(
        'No client id bound to this call — aliases are per-MCP-client.',
        ToolErrorCode.INVALID_ARGS,
      );
    }

    const alias = typeof args?.alias === 'string' ? args.alias.trim() : '';
    if (!alias || !ALIAS_REGEX.test(alias)) {
      return createErrorResponse(
        `Parameter [alias] must match ${ALIAS_REGEX.toString()} (lowercase, 1–32 chars, starts with a letter).`,
        ToolErrorCode.INVALID_ARGS,
        { arg: 'alias' },
      );
    }

    const state = getClientState(clientId);
    let tabId: number | undefined =
      typeof args.tabId === 'number' && Number.isFinite(args.tabId) ? args.tabId : undefined;
    if (tabId === undefined) {
      tabId = state?.activeTabId;
    }
    if (typeof tabId !== 'number') {
      return createErrorResponse(
        'No `tabId` supplied and this client has no active tab to alias. Pass `tabId` explicitly or open/claim a tab first.',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'tabId' },
      );
    }

    if (!state || !state.ownedTabs.has(tabId)) {
      return createErrorResponse(
        `Tab ${tabId} is not in this client's owned set. Use browser_claim_tab to take it first.`,
        ToolErrorCode.TAB_NOT_OWNED,
        { tabId, clientId },
      );
    }

    const { previousTabId } = setAliasForClient(clientId, alias, tabId);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            alias,
            tabId,
            clientId,
            ...(previousTabId !== undefined && previousTabId !== tabId
              ? { previousTabId }
              : {}),
          }),
        },
      ],
      isError: false,
    };
  }
}

export const aliasTabTool = new AliasTabTool();
