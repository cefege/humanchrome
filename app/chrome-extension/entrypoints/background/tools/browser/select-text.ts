import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { jsonOk } from './_common';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';

interface SelectTextParams {
  tabId?: number;
  windowId?: number;
  selector?: string;
  ref?: string;
  frameId?: number;
  substring?: string;
  start?: number;
  end?: number;
}

interface ShimSuccess {
  ok: true;
  resolution: 'ref' | 'selector';
  mode: 'input-range' | 'dom-range';
  start: number;
  end: number;
  selected: string;
  tagName: string;
}

interface ShimFailure {
  ok: false;
  message: string;
}

type ShimResult = ShimSuccess | ShimFailure;

/**
 * Select text inside a target element. For inputs/textareas, uses
 * `setSelectionRange(start, end)`. For everything else, walks text nodes
 * and applies the selection via `window.getSelection().addRange(range)`.
 *
 * Pair with chrome_clipboard or chrome_paste for "extract this field"
 * flows where the agent wants the page's current Selection state to
 * match a specific substring, not just a JSON snapshot.
 */
class SelectTextTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.SELECT_TEXT;
  static readonly mutates = true;

  async execute(args: SelectTextParams = {}): Promise<ToolResult> {
    const hasSelector = typeof args.selector === 'string' && args.selector.length > 0;
    const hasRef = typeof args.ref === 'string' && args.ref.length > 0;
    if (hasSelector === hasRef) {
      return createErrorResponse(
        'Exactly one of [selector] or [ref] is required.',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'selector|ref' },
      );
    }

    const hasSubstring = typeof args.substring === 'string';
    const hasRange = typeof args.start === 'number' && typeof args.end === 'number';
    if (hasSubstring === hasRange) {
      return createErrorResponse(
        'Exactly one of [substring] or [start AND end] is required.',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'substring|start+end' },
      );
    }
    if (hasRange && (args.start as number) > (args.end as number)) {
      return createErrorResponse('[start] must be <= [end].', ToolErrorCode.INVALID_ARGS, {
        arg: 'start+end',
        start: args.start,
        end: args.end,
      });
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

    try {
      const target: { tabId: number; frameIds?: number[] } = { tabId };
      if (typeof args.frameId === 'number') target.frameIds = [args.frameId];
      const injected = await chrome.scripting.executeScript({
        target,
        world: 'ISOLATED',
        func: selectTextShim,
        args: [
          args.selector ?? null,
          args.ref ?? null,
          args.substring ?? null,
          typeof args.start === 'number' ? args.start : null,
          typeof args.end === 'number' ? args.end : null,
        ],
      });
      const first = injected?.[0]?.result as ShimResult | undefined;
      if (!first) {
        return createErrorResponse(
          'select-text shim returned no result (frame missing or blocked?)',
          ToolErrorCode.UNKNOWN,
          { tabId, frameId: args.frameId },
        );
      }
      if (!first.ok) {
        // "substring not found" is a recoverable agent-level signal — classify
        // as INVALID_ARGS so callers can branch without re-raising.
        const code = /substring/i.test(first.message)
          ? ToolErrorCode.INVALID_ARGS
          : ToolErrorCode.UNKNOWN;
        return createErrorResponse(first.message, code, {
          tabId,
          frameId: args.frameId,
        });
      }
      return jsonOk({
        ok: true,
        tabId,
        frameId: args.frameId ?? null,
        resolution: first.resolution,
        mode: first.mode,
        start: first.start,
        end: first.end,
        selected: first.selected,
        tagName: first.tagName,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/no tab with id/i.test(msg)) {
        return createErrorResponse(`Tab ${tabId} not found`, ToolErrorCode.TAB_CLOSED, { tabId });
      }
      console.error('Error in SelectTextTool.execute:', error);
      return createErrorResponse(`chrome_select_text failed: ${msg}`, ToolErrorCode.UNKNOWN, {
        tabId,
        frameId: args.frameId,
      });
    }
  }
}

/** ISOLATED-world shim. Self-contained — no closure capture. */
function selectTextShim(
  selector: string | null,
  ref: string | null,
  substring: string | null,
  start: number | null,
  end: number | null,
): ShimResult {
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

    const tagName = el.tagName.toLowerCase();
    const isInputLike = tagName === 'input' || tagName === 'textarea';

    if (isInputLike) {
      const input = el as HTMLInputElement | HTMLTextAreaElement;
      const value = input.value ?? '';
      let s: number;
      let e: number;
      if (substring !== null) {
        const idx = value.indexOf(substring);
        if (idx < 0) {
          return { ok: false, message: `substring "${substring}" not found in input value` };
        }
        s = idx;
        e = idx + substring.length;
      } else {
        s = Math.max(0, Math.min(value.length, start as number));
        e = Math.max(0, Math.min(value.length, end as number));
      }
      input.focus({ preventScroll: false });
      input.setSelectionRange(s, e);
      return {
        ok: true,
        resolution,
        mode: 'input-range',
        start: s,
        end: e,
        selected: value.slice(s, e),
        tagName,
      };
    }

    // DOM Range path: walk text nodes to convert character offsets into
    // (node, offset) anchor/focus pairs, then apply via window.getSelection().
    const text = el.textContent ?? '';
    let s: number;
    let e: number;
    if (substring !== null) {
      const idx = text.indexOf(substring);
      if (idx < 0) {
        return { ok: false, message: `substring "${substring}" not found in element text` };
      }
      s = idx;
      e = idx + substring.length;
    } else {
      s = Math.max(0, Math.min(text.length, start as number));
      e = Math.max(0, Math.min(text.length, end as number));
    }

    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let cursor = 0;
    let startNode: Text | null = null;
    let startOffset = 0;
    let endNode: Text | null = null;
    let endOffset = 0;
    let node: Node | null = walker.nextNode();
    while (node) {
      const tn = node as Text;
      const len = tn.data.length;
      if (startNode === null && cursor + len >= s) {
        startNode = tn;
        startOffset = s - cursor;
      }
      if (cursor + len >= e) {
        endNode = tn;
        endOffset = e - cursor;
        break;
      }
      cursor += len;
      node = walker.nextNode();
    }

    if (!startNode || !endNode) {
      return {
        ok: false,
        message: `unable to map offsets ${s}-${e} into the element's text nodes`,
      };
    }

    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    const sel = window.getSelection();
    if (!sel) {
      return { ok: false, message: 'window.getSelection() returned null' };
    }
    sel.removeAllRanges();
    sel.addRange(range);

    return {
      ok: true,
      resolution,
      mode: 'dom-range',
      start: s,
      end: e,
      selected: range.toString(),
      tagName,
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export const selectTextTool = new SelectTextTool();
