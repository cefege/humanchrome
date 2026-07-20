/**
 * chrome_fill_lwc — commit a value into a Salesforce Lightning Web Component
 * (LWC) form control through the component's own `value` API plus a native
 * `change` event. This is the ONLY method proven to persist on Salesforce
 * Experience Cloud / Lightning forms.
 *
 * Why the normal fill tools don't work here:
 *  - chrome_fill_or_select / chrome_type_into set the inner DOM `.value` or
 *    dispatch keystrokes. The LWC value model and the Save logic read the
 *    COMPONENT's `@api value` property, not the shadow-DOM input's `.value`,
 *    so those edits are silently discarded on Save.
 *  - chrome_combobox_select drives ArrowDown/Enter, which binds Downshift /
 *    react-aria comboboxes but NOT lightning-combobox (whose value is a
 *    plain `@api value` setter).
 *
 * The fix (verified live on a Salesforce Experience Cloud form):
 *  - lightning-input-rich-text → set component.value = htmlString + change
 *  - lightning-combobox        → set component.value = optionValue  + change
 *  - plain input / textarea    → native prototype value setter + input + change
 *
 * LWC component properties are only settable from the page's MAIN world, so
 * (like chrome_javascript) we run via CDP Runtime.evaluate, which evaluates
 * in the main world by default. The selector is resolved with a deep
 * shadow-piercing query — Salesforce nests these controls many shadow roots
 * deep, so document.querySelector alone never finds them.
 */

import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { ToolErrorCode } from 'humanchrome-shared';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'humanchrome-shared';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { jsonOk } from './_common';

const CDP_SESSION_KEY = 'fill-lwc';
const DEFAULT_TIMEOUT_MS = 15_000;

type FillMode = 'richtext' | 'combobox' | 'input' | 'auto';

interface FillLwcParams {
  selector?: string;
  index?: number;
  value: string;
  mode?: FillMode;
  tabId?: number;
  windowId?: number;
  frameId?: number;
}

// Shape returned by the in-page function.
interface PageOk {
  ok: true;
  mode: 'richtext' | 'combobox' | 'input';
  tagName: string;
  valueAfter: string;
}
interface PageErr {
  ok: false;
  reason: 'no_match' | 'bad_args' | 'exception';
  message: string;
  matched?: number;
}
type PageResult = PageOk | PageErr;

interface CDPRemoteObject {
  type?: string;
  value?: unknown;
  description?: string;
}
interface CDPEvaluateResult {
  result?: CDPRemoteObject;
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

/**
 * Self-contained page function (serialized into a CDP Runtime.evaluate
 * expression). Must not reference anything outside its own scope — it runs
 * in the page's MAIN world with no closure over the extension. Args are
 * injected as a JSON literal at call time.
 */
function buildExpression(args: {
  selector: string | null;
  index: number;
  value: string;
  mode: FillMode;
}): string {
  const pageFn = function (a: {
    selector: string | null;
    index: number;
    value: string;
    mode: 'richtext' | 'combobox' | 'input' | 'auto';
  }): PageResult {
    try {
      // Deep shadow-DOM query: walk every open shadowRoot collecting matches.
      function deepQueryAll(sel: string, root: Document | ShadowRoot): Element[] {
        const out: Element[] = [];
        const walk = (n: Document | ShadowRoot | Element) => {
          if (!n || !(n as Element).querySelectorAll) return;
          (n as Element).querySelectorAll(sel).forEach((e) => out.push(e));
          (n as Element).querySelectorAll('*').forEach((e) => {
            const sr = (e as HTMLElement).shadowRoot;
            if (sr) walk(sr);
          });
        };
        walk(root);
        return out;
      }

      const sel =
        typeof a.selector === 'string' && a.selector.length > 0
          ? a.selector
          : 'lightning-input-rich-text, lightning-combobox, input, textarea';
      const matches = deepQueryAll(sel, document);
      if (matches.length === 0) {
        return {
          ok: false,
          reason: 'no_match',
          message: 'selector matched no element',
          matched: 0,
        };
      }
      const idx = Number.isFinite(a.index) ? Math.max(0, Math.floor(a.index)) : 0;
      const el = matches[idx];
      if (!el) {
        return {
          ok: false,
          reason: 'no_match',
          message: 'index ' + idx + ' out of range (' + matches.length + ' matched)',
          matched: matches.length,
        };
      }

      const tag = el.tagName.toLowerCase();
      let mode: 'richtext' | 'combobox' | 'input' = 'input';
      if (a.mode && a.mode !== 'auto') {
        mode = a.mode;
      } else if (tag === 'lightning-input-rich-text') {
        mode = 'richtext';
      } else if (tag === 'lightning-combobox') {
        mode = 'combobox';
      } else {
        mode = 'input';
      }

      const truncate = (v: unknown): string => {
        const s = v == null ? '' : String(v);
        return s.length > 200 ? s.slice(0, 200) : s;
      };

      if (mode === 'richtext') {
        const rt = el as unknown as { value: string };
        rt.value = a.value;
        el.dispatchEvent(
          new CustomEvent('change', {
            bubbles: true,
            composed: true,
            detail: { value: a.value },
          }),
        );
        return { ok: true, mode, tagName: tag, valueAfter: truncate(rt.value) };
      }

      if (mode === 'combobox') {
        const cb = el as unknown as { value: string };
        cb.value = a.value;
        el.dispatchEvent(
          new CustomEvent('change', {
            bubbles: true,
            composed: true,
            detail: { value: a.value },
          }),
        );
        return { ok: true, mode, tagName: tag, valueAfter: truncate(cb.value) };
      }

      // input / textarea — native prototype setter so frameworks tracking the
      // descriptor pick up the change, then input + change.
      const target = el as HTMLInputElement | HTMLTextAreaElement;
      const proto =
        target.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && typeof desc.set === 'function') {
        desc.set.call(target, a.value);
      } else {
        (target as { value: string }).value = a.value;
      }
      target.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      target.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      return { ok: true, mode, tagName: tag, valueAfter: truncate(target.value) };
    } catch (err) {
      return {
        ok: false,
        reason: 'exception',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  };

  return '(' + pageFn.toString() + ')(' + JSON.stringify(args) + ')';
}

class FillLwcTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.FILL_LWC;
  static readonly mutates = true;

  async execute(args: FillLwcParams): Promise<ToolResult> {
    if (typeof args?.value !== 'string') {
      return createErrorResponse(
        'Parameter [value] is required (string)',
        ToolErrorCode.INVALID_ARGS,
        {
          arg: 'value',
        },
      );
    }
    const mode: FillMode = args.mode ?? 'auto';
    if (!['richtext', 'combobox', 'input', 'auto'].includes(mode)) {
      return createErrorResponse(
        `Invalid mode "${mode}" (expected richtext|combobox|input|auto)`,
        ToolErrorCode.INVALID_ARGS,
        { arg: 'mode' },
      );
    }
    const selector =
      typeof args.selector === 'string' && args.selector.length > 0 ? args.selector : null;
    const index = typeof args.index === 'number' && Number.isFinite(args.index) ? args.index : 0;

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

    const expression = buildExpression({ selector, index, value: args.value, mode });

    try {
      const response = (await cdpSessionManager.withSession(tabId, CDP_SESSION_KEY, async () =>
        cdpSessionManager.sendCommand(
          tabId!,
          'Runtime.evaluate',
          {
            expression,
            returnByValue: true,
            awaitPromise: true,
            timeout: DEFAULT_TIMEOUT_MS,
          },
          DEFAULT_TIMEOUT_MS + 1000,
        ),
      )) as CDPEvaluateResult;

      if (response?.exceptionDetails) {
        const msg =
          response.exceptionDetails.exception?.description ||
          response.exceptionDetails.text ||
          'LWC fill evaluation threw';
        return createErrorResponse(msg, ToolErrorCode.UNKNOWN, { tabId });
      }

      const result = response?.result?.value as PageResult | undefined;
      if (!result || typeof result !== 'object') {
        return createErrorResponse('LWC fill returned no result', ToolErrorCode.UNKNOWN, { tabId });
      }

      if (!result.ok) {
        const code =
          result.reason === 'no_match'
            ? ToolErrorCode.NOT_ACTIONABLE
            : result.reason === 'bad_args'
              ? ToolErrorCode.INVALID_ARGS
              : ToolErrorCode.UNKNOWN;
        return createErrorResponse(result.message, code, {
          tabId,
          selector,
          index,
          matched: result.matched,
        });
      }

      return jsonOk({
        success: true,
        tabId,
        mode: result.mode,
        tagName: result.tagName,
        valueAfter: result.valueAfter,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/another debugger|already attached/i.test(msg)) {
        return createErrorResponse(msg, ToolErrorCode.CDP_BUSY, { tabId });
      }
      return createErrorResponse(msg, ToolErrorCode.UNKNOWN, { tabId });
    }
  }
}

export const fillLwcTool = new FillLwcTool();
