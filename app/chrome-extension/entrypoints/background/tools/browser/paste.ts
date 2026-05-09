import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';
import { offscreenManager } from '@/utils/offscreen-manager';
import { MessageTarget } from '@/common/message-types';

interface PasteParams {
  tabId?: number;
  windowId?: number;
  selector?: string;
  ref?: string;
  frameId?: number;
  text?: string;
}

interface ShimSuccess {
  ok: true;
  focused: boolean;
  resolution: 'ref' | 'selector';
  tagName: string;
  pasted: boolean;
  mode: 'event' | 'execCommand' | 'both';
}

interface ShimFailure {
  ok: false;
  message: string;
}

type ShimResult = ShimSuccess | ShimFailure;

interface OffscreenWriteResp {
  success: boolean;
  error?: string;
}

/**
 * Write text to the system clipboard via the offscreen document.
 * Co-located here (instead of importing chrome_clipboard's tool) so
 * paste only depends on the same low-level offscreen plumbing without
 * re-entering the dispatcher.
 */
async function writeClipboardFromBackground(text: string): Promise<void> {
  await offscreenManager.ensureOffscreenDocument();
  const resp = (await chrome.runtime.sendMessage({
    target: MessageTarget.Offscreen,
    type: 'clipboard.write',
    text,
  })) as OffscreenWriteResp | undefined;
  if (!resp || resp.success !== true) {
    throw new Error(resp?.error ?? 'offscreen clipboard.write returned no response');
  }
}

class PasteTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.PASTE;
  static readonly mutates = true;

  async execute(args: PasteParams = {}): Promise<ToolResult> {
    const hasSelector = typeof args.selector === 'string' && args.selector.length > 0;
    const hasRef = typeof args.ref === 'string' && args.ref.length > 0;
    if (hasSelector === hasRef) {
      return createErrorResponse(
        'Exactly one of [selector] or [ref] is required.',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'selector|ref' },
      );
    }

    let tabId: number | undefined = typeof args.tabId === 'number' ? args.tabId : undefined;
    if (tabId === undefined) {
      const tab = await this.getActiveTabInWindow(args.windowId);
      if (!tab || typeof tab.id !== 'number') {
        return createErrorResponse(
          'No active tab found',
          ToolErrorCode.TAB_NOT_FOUND,
          typeof args.windowId === 'number' ? { windowId: args.windowId } : undefined,
        );
      }
      tabId = tab.id;
    }

    // Optionally seed the clipboard before dispatching the paste. If `text`
    // is omitted, the synthetic ClipboardEvent uses whatever the OS clipboard
    // currently holds (the shim falls back to navigator.clipboard.readText()
    // inside the page when text is null).
    if (typeof args.text === 'string') {
      try {
        await writeClipboardFromBackground(args.text);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return createErrorResponse(
          `Failed to seed clipboard before paste: ${msg}`,
          ToolErrorCode.UNKNOWN,
        );
      }
    }

    try {
      const target: { tabId: number; frameIds?: number[] } = { tabId };
      if (typeof args.frameId === 'number') target.frameIds = [args.frameId];
      const injected = await chrome.scripting.executeScript({
        target,
        world: 'ISOLATED',
        func: pasteShim,
        args: [args.selector ?? null, args.ref ?? null, args.text ?? null],
      });

      const first = injected?.[0]?.result as ShimResult | undefined;
      if (!first) {
        return createErrorResponse(
          'Paste shim returned no result (frame missing or blocked?)',
          ToolErrorCode.UNKNOWN,
          { tabId, frameId: args.frameId },
        );
      }
      if (!first.ok) {
        return createErrorResponse(first.message, ToolErrorCode.UNKNOWN, {
          tabId,
          frameId: args.frameId,
        });
      }
      return jsonOk({
        ok: true,
        tabId,
        frameId: args.frameId ?? null,
        resolution: first.resolution,
        focused: first.focused,
        pasted: first.pasted,
        mode: first.mode,
        tagName: first.tagName,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/no tab with id/i.test(msg)) {
        return createErrorResponse(`Tab ${tabId} not found`, ToolErrorCode.TAB_CLOSED, { tabId });
      }
      console.error('Error in PasteTool.execute:', error);
      return createErrorResponse(`chrome_paste failed: ${msg}`, ToolErrorCode.UNKNOWN, {
        tabId,
        frameId: args.frameId,
      });
    }
  }
}

function jsonOk(body: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false };
}

/**
 * ISOLATED-world shim. Dispatches both a synthetic ClipboardEvent and an
 * execCommand('insertText') fallback so pages that listen for the paste
 * event AND pages that just rely on input.value === '...' (autofill-style)
 * both end up with the right text. `mode` reports which fired.
 */
function pasteShim(selector: string | null, ref: string | null, text: string | null): ShimResult {
  try {
    let el: Element | null = null;
    let resolution: 'ref' | 'selector' = 'selector';

    if (ref) {
      resolution = 'ref';
      const map = (window as unknown as { __claudeElementMap?: Record<string, WeakRef<Element>> })
        .__claudeElementMap;
      if (!map || !map[ref]) {
        return { ok: false, message: `ref "${ref}" not found in element map` };
      }
      const deref = map[ref].deref?.();
      if (!deref) {
        return { ok: false, message: `ref "${ref}" element has been garbage-collected` };
      }
      el = deref;
    } else if (selector) {
      el = document.querySelector(selector);
      if (!el) {
        return { ok: false, message: `selector "${selector}" matched no element` };
      }
    } else {
      return { ok: false, message: 'neither selector nor ref provided' };
    }

    const target = el as HTMLElement;
    if (typeof target.focus === 'function') {
      target.focus({ preventScroll: false });
    }
    const focused = document.activeElement === el;

    let eventDispatched = false;
    let execCommandDispatched = false;
    if (text !== null) {
      // Synthetic ClipboardEvent — pages with .addEventListener('paste', ...) handlers
      // (rich editors, framework controls) see the data via event.clipboardData.
      try {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        const ev = new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: dt,
        });
        const accepted = target.dispatchEvent(ev);
        // accepted is `false` when the page called preventDefault — treat that
        // as a successful event-driven paste.
        eventDispatched = !accepted ? true : true;
      } catch {
        eventDispatched = false;
      }

      // Fallback for plain inputs / textareas that don't react to paste events.
      try {
        const ok = document.execCommand('insertText', false, text);
        execCommandDispatched = ok === true;
      } catch {
        execCommandDispatched = false;
      }
    }

    const pasted = text === null ? focused : eventDispatched || execCommandDispatched;
    const mode: ShimSuccess['mode'] =
      eventDispatched && execCommandDispatched ? 'both' : eventDispatched ? 'event' : 'execCommand';

    return {
      ok: true,
      focused,
      resolution,
      tagName: el.tagName.toLowerCase(),
      pasted,
      mode,
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export const pasteTool = new PasteTool();
