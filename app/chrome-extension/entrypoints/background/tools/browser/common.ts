import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { browserMetadataPolicy, TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';
import { captureFrameOnAction, isAutoCaptureActive } from './gif-recorder';
import { ensureRustKernel } from '@/shared/rust-kernel';

// Default window dimensions
const DEFAULT_WINDOW_WIDTH = 1280;
const DEFAULT_WINDOW_HEIGHT = 720;

interface NavigateToolParams {
  url?: string;
  newWindow?: boolean;
  newTab?: boolean;
  width?: number;
  height?: number;
  refresh?: boolean;
  reload?: boolean; // when true and URL matches an open tab, force a real
  // reload instead of just activating — necessary when the only difference
  // is a hash fragment, which otherwise no-ops without resetting DOM state.
  tabId?: number;
  windowId?: number;
  background?: boolean; // when true, do not activate tab or focus window
}

/**
 * Tool for navigating to URLs in browser tabs or windows
 */
class NavigateTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.NAVIGATE;
  static readonly mutates = true;

  /**
   * Trigger GIF auto-capture after successful navigation
   */
  private async triggerAutoCapture(tabId: number, url?: string): Promise<void> {
    if (!isAutoCaptureActive(tabId)) {
      return;
    }
    try {
      await captureFrameOnAction(tabId, { type: 'navigate', url });
    } catch (error) {
      console.warn('[NavigateTool] Auto-capture failed:', error);
    }
  }

  async execute(args: NavigateToolParams): Promise<ToolResult> {
    const {
      newWindow = false,
      newTab = false,
      width,
      height,
      url,
      refresh = false,
      reload = false,
      tabId,
      background = true, // default true to avoid stealing focus; pass false to foreground
      windowId,
    } = args;

    console.log(
      `Attempting to ${refresh ? 'refresh current tab' : `open URL: ${url}`} with options:`,
      args,
    );

    try {
      // When the caller pinned a specific tabId, validate it exists before any
      // fallback path. Otherwise an invalid id silently activates an unrelated
      // tab via URL-pattern match — caller asked for tab X, got tab Y.
      if (typeof tabId === 'number') {
        const pinned = await this.tryGetTab(tabId);
        if (!pinned) {
          return createErrorResponse(`Tab ${tabId} not found`, ToolErrorCode.TAB_NOT_FOUND, {
            tabId,
          });
        }
      }

      // Handle refresh option first
      if (refresh) {
        console.log('Refreshing current active tab');
        // Get target tab (explicit or active in provided window)
        const targetTab = await this.getOwnedTab({ explicit: tabId, windowId });
        if (!targetTab.id)
          return createErrorResponse('No target tab found to refresh', ToolErrorCode.TAB_NOT_FOUND);
        await chrome.tabs.reload(targetTab.id);

        console.log(`Refreshed tab ID: ${targetTab.id}`);

        // Get updated tab information
        const updatedTab = await chrome.tabs.get(targetTab.id);

        // Trigger auto-capture on refresh
        await this.triggerAutoCapture(updatedTab.id!, updatedTab.url);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: 'Successfully refreshed current tab',
                tabId: updatedTab.id,
                windowId: updatedTab.windowId,
                url: updatedTab.url,
              }),
            },
          ],
          isError: false,
        };
      }

      // Validate that url is provided when not refreshing
      if (!url) {
        return createErrorResponse(
          'URL parameter is required when refresh is not true',
          ToolErrorCode.INVALID_ARGS,
        );
      }

      // Handle history navigation: url="back" or url="forward"
      if (url === 'back' || url === 'forward') {
        const targetTab = await this.getOwnedTab({ explicit: tabId, windowId });
        if (!targetTab.id) {
          return createErrorResponse(
            'No target tab found for history navigation',
            ToolErrorCode.TAB_NOT_FOUND,
          );
        }

        // Respect background flag for focus behavior
        await this.ensureFocus(targetTab, {
          activate: background !== true,
          focusWindow: background !== true,
        });

        if (url === 'forward') {
          await chrome.tabs.goForward(targetTab.id);
          console.log(`Navigated forward in tab ID: ${targetTab.id}`);
        } else {
          await chrome.tabs.goBack(targetTab.id);
          console.log(`Navigated back in tab ID: ${targetTab.id}`);
        }

        const updatedTab = await chrome.tabs.get(targetTab.id);

        // Trigger auto-capture on history navigation
        await this.triggerAutoCapture(updatedTab.id!, updatedTab.url);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: `Successfully navigated ${url} in browser history`,
                tabId: updatedTab.id,
                windowId: updatedTab.windowId,
                url: updatedTab.url,
              }),
            },
          ],
          isError: false,
        };
      }

      // 1. Check if URL is already open — UNLESS the caller explicitly asked
      // for a fresh tab. `newTab:true` is the documented override for
      // workflows that need a guaranteed-clean tab (e.g. a send flow that
      // must not inherit a stale CDP session left on a same-host tab).
      // Skipping this whole block also skips the host-match activation
      // below, so we fall straight through to the new-tab creation path.
      const skipExistingTabLookup = newTab === true && typeof tabId !== 'number';
      if (skipExistingTabLookup) {
        console.log('newTab:true — bypassing existing-tab lookup');
      }
      console.log(`Checking if URL is already open: ${url}`);

      await ensureRustKernel();
      const urlPatterns = browserMetadataPolicy.buildNavigationUrlPatterns(url);
      const candidateTabs = skipExistingTabLookup
        ? []
        : await chrome.tabs.query({ url: urlPatterns });
      console.log(`Found ${candidateTabs.length} matching tabs with patterns:`, urlPatterns);

      const explicitTab = await this.tryGetTab(tabId);
      const existingTab =
        explicitTab ||
        (() => {
          const index = browserMetadataPolicy.pickBestNavigationCandidateIndex(url, candidateTabs);
          return index === undefined ? undefined : candidateTabs[index];
        })();
      if (existingTab?.id !== undefined) {
        console.log(
          `URL already open in Tab ID: ${existingTab.id}, Window ID: ${existingTab.windowId}`,
        );
        // Update URL only when explicit tab specified and url differs
        if (explicitTab && typeof explicitTab.id === 'number') {
          await chrome.tabs.update(explicitTab.id, { url });
        }
        // reload:true — force a fresh DOM. Without this, hash-only changes
        // (and same-URL re-navigates) leave the page state intact and the
        // caller silently gets the previous page's DOM, form values, etc.
        if (reload && typeof existingTab.id === 'number') {
          if (existingTab.url !== url) {
            await chrome.tabs.update(existingTab.id, { url });
          }
          await chrome.tabs.reload(existingTab.id);
        }
        // Optionally bring to foreground based on background flag
        await this.ensureFocus(existingTab, {
          activate: background !== true,
          focusWindow: background !== true,
        });

        console.log(`Activated existing Tab ID: ${existingTab.id}${reload ? ' (reloaded)' : ''}`);
        // Get updated tab information and return it
        const updatedTab = await chrome.tabs.get(existingTab.id);

        // Trigger auto-capture on existing tab activation
        await this.triggerAutoCapture(updatedTab.id!, updatedTab.url);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: reload ? 'Reloaded existing tab' : 'Activated existing tab',
                tabId: updatedTab.id,
                windowId: updatedTab.windowId,
                url: updatedTab.url,
                reloaded: reload,
              }),
            },
          ],
          isError: false,
        };
      }

      // 2. If URL is not already open, decide how to open it based on options
      const openInNewWindow = newWindow || typeof width === 'number' || typeof height === 'number';

      if (openInNewWindow) {
        console.log('Opening URL in a new window.');

        // Create new window
        const newWindow = await chrome.windows.create({
          url: url,
          width: typeof width === 'number' ? width : DEFAULT_WINDOW_WIDTH,
          height: typeof height === 'number' ? height : DEFAULT_WINDOW_HEIGHT,
          focused: background === true ? false : true,
        });

        if (newWindow && newWindow.id !== undefined) {
          console.log(`URL opened in new Window ID: ${newWindow.id}`);

          // Trigger auto-capture if the new window has a tab
          const firstTab = newWindow.tabs?.[0];
          if (firstTab?.id) {
            await this.triggerAutoCapture(firstTab.id, firstTab.url);
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  message: 'Opened URL in new window',
                  windowId: newWindow.id,
                  tabs: newWindow.tabs
                    ? newWindow.tabs.map((tab) => ({
                        tabId: tab.id,
                        url: tab.url,
                      }))
                    : [],
                }),
              },
            ],
            isError: false,
          };
        }
      } else {
        console.log('Opening URL in the last active window.');
        // Try to open a new tab in the specified window, otherwise the most recently active window
        let targetWindow: chrome.windows.Window | null = null;
        if (typeof windowId === 'number') {
          targetWindow = await chrome.windows.get(windowId, { populate: false });
        }
        if (!targetWindow) {
          targetWindow = await chrome.windows.getLastFocused({
            populate: false,
            windowTypes: ['normal'],
          });
        }

        if (targetWindow && targetWindow.id !== undefined) {
          console.log(`Found target Window ID: ${targetWindow.id}`);

          const newTab = await chrome.tabs.create({
            url: url,
            windowId: targetWindow.id,
            active: background === true ? false : true,
          });
          if (background !== true) {
            await chrome.windows.update(targetWindow.id, { focused: true });
          }

          console.log(
            `URL opened in new Tab ID: ${newTab.id} in existing Window ID: ${targetWindow.id}`,
          );

          // Trigger auto-capture on new tab
          if (newTab.id) {
            await this.triggerAutoCapture(newTab.id, newTab.url);
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  message: 'Opened URL in new tab in existing window',
                  tabId: newTab.id,
                  windowId: targetWindow.id,
                  url: newTab.url,
                }),
              },
            ],
            isError: false,
          };
        } else {
          // In rare cases, if there's no recently active window (e.g., browser just started with no windows)
          // Fall back to opening in a new window
          console.warn('No last focused window found, falling back to creating a new window.');

          const fallbackWindow = await chrome.windows.create({
            url: url,
            width: DEFAULT_WINDOW_WIDTH,
            height: DEFAULT_WINDOW_HEIGHT,
            focused: true,
          });

          if (fallbackWindow && fallbackWindow.id !== undefined) {
            console.log(`URL opened in fallback new Window ID: ${fallbackWindow.id}`);

            // Trigger auto-capture if fallback window has a tab
            const firstTab = fallbackWindow.tabs?.[0];
            if (firstTab?.id) {
              await this.triggerAutoCapture(firstTab.id, firstTab.url);
            }

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    message: 'Opened URL in new window',
                    windowId: fallbackWindow.id,
                    tabs: fallbackWindow.tabs
                      ? fallbackWindow.tabs.map((tab) => ({
                          tabId: tab.id,
                          url: tab.url,
                        }))
                      : [],
                  }),
                },
              ],
              isError: false,
            };
          }
        }
      }

      // If all attempts fail, return a generic error
      return createErrorResponse('Failed to open URL: Unknown error occurred');
    } catch (error) {
      if (chrome.runtime.lastError) {
        console.error(`Chrome API Error: ${chrome.runtime.lastError.message}`, error);
        return createErrorResponse(`Chrome API Error: ${chrome.runtime.lastError.message}`);
      } else {
        console.error('Error in navigate:', error);
        return createErrorResponse(
          `Error navigating to URL: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
export const navigateTool = new NavigateTool();
