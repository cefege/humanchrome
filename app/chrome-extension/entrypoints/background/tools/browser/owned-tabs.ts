import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';
import { getCurrentRequestContext } from '../../utils/request-context';
import { getClientState } from '../../utils/client-state';

interface OwnedTabsParams {
  /** Optional filter — return only the row matching this tabId, if owned. */
  tabId?: number;
}

interface OwnedTabRow {
  tabId: number;
  windowId?: number;
  url: string;
  title: string;
  active: boolean;
  isActive: boolean; // alias for active
  status?: string;
  /** When this tab last became the client's `activeTabId`. */
  isPinnedActive: boolean;
}

interface OwnedTabsResponse {
  success: true;
  clientId: string;
  count: number;
  ownedTabs: OwnedTabRow[];
  activeTabId?: number;
  lastWindowId?: number;
}

/**
 * `chrome_owned_tabs` (IMP-0168) — return the tabs currently owned by the
 * calling MCP client (or, for UI surfaces, the calling `__ui:*` lane).
 *
 * Powers the "Tabs owned by this client" panel that lives in the popup
 * and sidepanel UIs (IMP-0170). Distinct from `chrome_get_windows_and_tabs`
 * (which is the whole-browser catalog) — this tool answers the narrower
 * "what does THIS client own" question without forcing the caller to
 * filter a multi-window tree by an owner column.
 *
 * Read-only by design — `static readonly mutates = false` (the base
 * class default), so the dispatcher doesn't auto-spawn a tab when the
 * caller has none. Returns `{ ownedTabs: [], count: 0 }` for a fresh
 * client with no claims.
 */
class OwnedTabsTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.OWNED_TABS;
  // No tab is needed to enumerate the caller's own owned set.
  static readonly autoSpawnTab = false;

  async execute(args: OwnedTabsParams = {}): Promise<ToolResult> {
    const ctx = getCurrentRequestContext();
    const clientId = ctx?.clientId;
    if (!clientId) {
      return createErrorResponse(
        'No client id bound to this call — ownership is per-MCP-client.',
        ToolErrorCode.INVALID_ARGS,
      );
    }

    const state = getClientState(clientId);
    const ownedIds = state ? Array.from(state.ownedTabs) : [];
    const filterTabId =
      typeof args.tabId === 'number' && Number.isFinite(args.tabId) ? args.tabId : undefined;
    const wantedIds =
      filterTabId !== undefined ? ownedIds.filter((id) => id === filterTabId) : ownedIds;

    const rows: OwnedTabRow[] = [];
    for (const tabId of wantedIds) {
      let tab: chrome.tabs.Tab | null = null;
      try {
        tab = await chrome.tabs.get(tabId);
      } catch {
        // Tab closed between ownership-set read and get — `chrome.tabs.onRemoved`
        // will sweep it from the owned set shortly. Skip it from this snapshot.
        continue;
      }
      rows.push({
        tabId,
        windowId: tab.windowId,
        url: tab.url ?? '',
        title: tab.title ?? '',
        active: tab.active === true,
        isActive: tab.active === true,
        status: tab.status,
        isPinnedActive: state?.activeTabId === tabId,
      });
    }

    // Sort by windowId then tabId for stable UI rendering.
    rows.sort((a, b) => {
      const wa = a.windowId ?? 0;
      const wb = b.windowId ?? 0;
      if (wa !== wb) return wa - wb;
      return a.tabId - b.tabId;
    });

    const body: OwnedTabsResponse = {
      success: true,
      clientId,
      count: rows.length,
      ownedTabs: rows,
      activeTabId: state?.activeTabId,
      lastWindowId: state?.lastWindowId,
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(body) }],
      isError: false,
    };
  }
}

export const ownedTabsTool = new OwnedTabsTool();
