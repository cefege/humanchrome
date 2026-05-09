import {
  createErrorResponse,
  createErrorResponseFromThrown,
  ToolResult,
} from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { TIMEOUTS, ERROR_MESSAGES } from '@/common/constants';

export type KeyboardShortcut =
  | 'copy'
  | 'paste'
  | 'cut'
  | 'undo'
  | 'redo'
  | 'save'
  | 'select_all'
  | 'find'
  | 'refresh'
  | 'back'
  | 'forward'
  | 'new_tab'
  | 'close_tab';

interface KeyboardToolParams {
  keys?: string; // Optional when `shortcut` is provided. String representing keys or key combinations (e.g., "Enter", "Ctrl+C").
  shortcut?: KeyboardShortcut; // High-level named shortcut, resolved to the platform-correct chord. Wins over `keys` if both supplied.
  selector?: string; // Optional: CSS selector or XPath for target element to send keyboard events to
  selectorType?: 'css' | 'xpath'; // Type of selector (default: 'css')
  delay?: number; // Optional: delay between keystrokes in milliseconds
  tabId?: number; // target existing tab id
  windowId?: number; // when no tabId, pick active tab from this window
  frameId?: number; // target frame id for iframe support
}

/**
 * Map a high-level shortcut name to the platform-correct key chord.
 * The chord uses the `Ctrl` / `Meta` token names that the in-page
 * keyboard-helper script already understands. Pure function so it
 * can be unit-tested without spawning a real chrome.runtime call.
 */
export function resolveShortcutKeys(shortcut: KeyboardShortcut, isMac: boolean): string {
  const mod = isMac ? 'Meta' : 'Ctrl';
  switch (shortcut) {
    case 'copy':
      return `${mod}+c`;
    case 'paste':
      return `${mod}+v`;
    case 'cut':
      return `${mod}+x`;
    case 'undo':
      return `${mod}+z`;
    case 'redo':
      // macOS convention is Cmd+Shift+Z; Windows/Linux is Ctrl+Y.
      return isMac ? 'Meta+Shift+z' : 'Ctrl+y';
    case 'save':
      return `${mod}+s`;
    case 'select_all':
      return `${mod}+a`;
    case 'find':
      return `${mod}+f`;
    case 'refresh':
      return `${mod}+r`;
    case 'back':
      // Browser-history back: Alt+Left on Win/Linux, Cmd+Left on macOS.
      return isMac ? 'Meta+ArrowLeft' : 'Alt+ArrowLeft';
    case 'forward':
      return isMac ? 'Meta+ArrowRight' : 'Alt+ArrowRight';
    case 'new_tab':
      return `${mod}+t`;
    case 'close_tab':
      return `${mod}+w`;
  }
}

async function isMacPlatform(): Promise<boolean> {
  try {
    const info = await chrome.runtime.getPlatformInfo();
    return info.os === 'mac';
  } catch {
    // Fallback: if the API is unavailable, assume non-mac so the chord
    // is the more portable Ctrl-prefixed variant.
    return false;
  }
}

/**
 * Tool for simulating keyboard input on web pages
 */
class KeyboardTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.KEYBOARD;
  static readonly mutates = true;

  /**
   * Execute keyboard operation
   */
  async execute(args: KeyboardToolParams): Promise<ToolResult> {
    const { selector, selectorType = 'css', delay = TIMEOUTS.KEYBOARD_DELAY, shortcut } = args;

    console.log(`Starting keyboard operation with options:`, args);

    // Resolve the final `keys` string. `shortcut` wins when both are present
    // — callers reaching for a named shortcut don't want a stale `keys` arg
    // silently overriding it.
    let keys: string | undefined = args.keys;
    if (shortcut) {
      const isMac = await isMacPlatform();
      keys = resolveShortcutKeys(shortcut, isMac);
    }

    if (!keys) {
      return createErrorResponse(
        ERROR_MESSAGES.INVALID_PARAMETERS + ': One of `keys` or `shortcut` must be provided',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'keys|shortcut' },
      );
    }

    try {
      const explicit = await this.tryGetTab(args.tabId);
      const tab = explicit || (await this.getActiveTabOrThrowInWindow(args.windowId));
      if (!tab.id) {
        return createErrorResponse(
          ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID',
          ToolErrorCode.TAB_NOT_FOUND,
          { tabId: args.tabId },
        );
      }

      // Snapshot the document we're targeting. Enter on a form can legitimately
      // navigate, so we only assert pre-action — catching the case where the
      // page navigated between resolution and dispatch (silent wrong-target
      // execution). Snapshot in parallel with a11y-helper injection — both
      // are independent IPC round-trips.
      const [snapshot] = await Promise.all([
        this.snapshotTabState(tab.id),
        this.injectContentScript(tab.id, ['inject-scripts/accessibility-tree-helper.js']),
      ]);

      let finalSelector = selector;
      let refForFocus: string | undefined = undefined;

      // If selector is XPath, convert to ref then try to get CSS selector
      if (selector && selectorType === 'xpath') {
        try {
          // First convert XPath to ref
          const ensured = await this.sendMessageToTab(tab.id, {
            action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
            selector,
            isXPath: true,
          });
          if (!ensured || !ensured.success || !ensured.ref) {
            return createErrorResponse(
              `Failed to resolve XPath selector: ${ensured?.error || 'unknown error'}`,
            );
          }
          refForFocus = ensured.ref;
          // Try to resolve ref to CSS selector
          const resolved = await this.sendMessageToTab(tab.id, {
            action: TOOL_MESSAGE_TYPES.RESOLVE_REF,
            ref: ensured.ref,
          });
          if (resolved && resolved.success && resolved.selector) {
            finalSelector = resolved.selector;
            refForFocus = undefined; // Prefer CSS selector if available
          }
          // If no CSS selector available, we'll use ref to focus below
        } catch (error) {
          return createErrorResponse(
            `Error resolving XPath: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      // If we have a ref but no CSS selector, focus the element via helper
      if (refForFocus) {
        const focusResult = await this.sendMessageToTab(tab.id, {
          action: 'focusByRef',
          ref: refForFocus,
        });
        if (focusResult && !focusResult.success) {
          return createErrorResponse(
            `Failed to focus element by ref: ${focusResult.error || 'unknown error'}`,
          );
        }
        // Clear selector so keyboard events go to the focused element
        finalSelector = undefined;
      }

      const frameIds = typeof args.frameId === 'number' ? [args.frameId] : undefined;
      await this.injectContentScript(
        tab.id,
        ['inject-scripts/keyboard-helper.js'],
        false,
        'ISOLATED',
        false,
        frameIds,
      );

      await this.assertSameDocument(snapshot);

      // Send keyboard simulation message to content script
      const result = await this.sendMessageToTab(
        tab.id,
        {
          action: TOOL_MESSAGE_TYPES.SIMULATE_KEYBOARD,
          keys,
          selector: finalSelector,
          delay,
        },
        args.frameId,
      );

      if (result.error) {
        return createErrorResponse(result.error);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: result.message || 'Keyboard operation successful',
              targetElement: result.targetElement,
              results: result.results,
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('Error in keyboard operation:', error);
      return createErrorResponseFromThrown(error);
    }
  }
}

export const keyboardTool = new KeyboardTool();
