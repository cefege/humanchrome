import { createErrorResponse, classifyTabError, ToolResult } from '@/common/tool-handler';
import { jsonOk } from './_common';
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
  /**
   * Which path actually inserted text into the target.
   * - 'event': the synthetic ClipboardEvent's listener inserted text
   * - 'execCommand': the execCommand('insertText') fallback ran successfully
   * - 'none': neither path inserted text (paste claimed false, OR clipboard-only mode)
   */
  mode: 'event' | 'execCommand' | 'none';
  /** Number of characters added to the target's text content (after - before). */
  textInserted: number;
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
      const tab = await this.getOwnedTab({ windowId: args.windowId, required: false });
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
    //
    // When `text` IS provided, seeding the OS clipboard is a best-effort step:
    // it helps the minority of pages that call navigator.clipboard.readText()
    // themselves, but the shim (line 188) builds a synthetic DataTransfer + falls
    // back to execCommand('insertText') using the text directly. So a seed
    // failure (typically "Document is not focused" in background-mode) should
    // not block the whole paste — degrade gracefully and let the shim run.
    let clipboardSeedWarning: string | null = null;
    if (typeof args.text === 'string') {
      try {
        await writeClipboardFromBackground(args.text);
      } catch (error) {
        clipboardSeedWarning = error instanceof Error ? error.message : String(error);
        console.warn(
          `[chrome_paste] clipboard seed failed, continuing with shim: ${clipboardSeedWarning}`,
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
        textInserted: first.textInserted,
        tagName: first.tagName,
        clipboardSeedWarning,
      });
    } catch (error) {
      console.error('Error in PasteTool.execute:', error);
      return classifyTabError(error, {
        toolName: TOOL_NAMES.BROWSER.PASTE,
        tabId,
        extraDetails: { frameId: args.frameId },
      });
    }
  }
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

    // Helper: read the editor's text content. Different targets expose text
    // through different APIs — input/textarea via `.value`, contenteditable
    // via `.innerText`. Other elements get empty string (paste can't insert
    // into them; we still try execCommand for compatibility).
    const readText = (): string => {
      if ((target as HTMLElement).isContentEditable) return (target as HTMLElement).innerText ?? '';
      const v = (target as unknown as { value?: unknown }).value;
      return typeof v === 'string' ? v : '';
    };

    let mode: ShimSuccess['mode'] = 'none';
    let textBefore = '';
    let textAfter = '';
    let pasted = false;

    if (text !== null) {
      // Derive `pasted` from "text actually changed" rather than "event
      // dispatched successfully". Readonly inputs, contenteditable=false, and
      // pages whose paste listener is purely for telemetry all dispatch
      // cleanly but insert nothing — those must report pasted:false.
      textBefore = readText();

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
        target.dispatchEvent(ev);
      } catch {
        // Event construction can throw in odd execution contexts (e.g.
        // detached iframes). Swallow and let execCommand try.
      }

      // Did the listener insert text? If so, skip execCommand to avoid
      // double-insert on editors that accept both surfaces (LinkedIn React
      // composer style).
      textAfter = readText();
      if (textAfter !== textBefore) {
        mode = 'event';
      } else {
        // Fall back to execCommand. It returns true on many platforms even
        // when the target rejects insertion (readonly input, ce=false), so
        // trust the text-diff, not the return value.
        try {
          document.execCommand('insertText', false, text);
        } catch {
          // Some surfaces throw rather than return false; the post-check covers both.
        }
        textAfter = readText();
        if (textAfter !== textBefore) {
          mode = 'execCommand';
        }
      }

      pasted = textAfter !== textBefore;
    } else {
      // No text supplied — caller is asking us to deliver the OS clipboard
      // via the focused element's native paste handler. We can't introspect
      // the OS clipboard from the shim, so preserve the prior contract:
      // `pasted` reflects whether the element accepted focus (the precondition
      // for the browser to deliver the paste in the first place). textBefore
      // and textAfter stay at '' so textInserted is 0.
      pasted = focused;
    }

    const textInserted = textAfter.length - textBefore.length;

    return {
      ok: true,
      focused,
      resolution,
      tagName: el.tagName.toLowerCase(),
      pasted,
      mode,
      textInserted,
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export const pasteTool = new PasteTool();

/**
 * Test-only export of the in-page shim. The shim is serialized via
 * chrome.scripting.executeScript at runtime and never imported by the
 * extension; exposing it here lets jsdom tests verify the textBefore /
 * textAfter / `pasted` derivation against real DOM nodes — the only way
 * to catch silent-success classes like the readonly-input + paste-listener
 * combo that prior shim-mocking tests couldn't reach.
 */
export function _pasteShimForTest(
  selector: string | null,
  ref: string | null,
  text: string | null,
): ShimResult {
  return pasteShim(selector, ref, text);
}
