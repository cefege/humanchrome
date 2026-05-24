import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { jsonOk } from './_common';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';
import {
  resolveSelectorToRef,
  STRUCTURED_SELECTOR_KINDS,
  type SelectorType,
} from './_selector-resolve';
import { parsePrefixedSelector } from '@/shared/selector/prefixed-parser';

/**
 * chrome_get_attributes — IMP-0126.
 *
 * Read DOM attributes, properties, and computed CSS by selector or ref.
 * Read-only. Closes the gap between `chrome_assert` (boolean-only) and
 * `chrome_read_page` (whole-tree, no computed styles) and
 * `chrome_javascript` (forces JS authoring + redactor).
 *
 * Single tool, no action enum. Pairs with chrome_assert for non-boolean
 * comparisons.
 *
 * Defaults when arrays are omitted: a small set of commonly-needed
 * fields so callers get useful output without specifying anything.
 * Empty arrays opt out of that group entirely.
 *
 * Examples:
 *   {selector:'a.profile-link'} → {tagName, attributes: {id, class, href, src, value, title, role, 'aria-label'}, properties: {tagName, checked, disabled, selected, value}, computedStyles: {}}
 *   {ref:'ref_12', computedStyles:['color','font-size']} → focuses computed CSS
 *   {selector:'.row', multi:true} → returns an array of one envelope per match
 */

interface GetAttributesParams {
  selector?: string;
  selectorType?: SelectorType;
  ref?: string;
  index?: number;
  multi?: boolean;
  tabId?: number;
  windowId?: number;
  frameId?: number;
  /** Attribute names. Omit → default set. Pass [] to opt out. */
  attributes?: string[];
  /** DOM-property names (e.g. checked, value, selectedIndex). Omit → default set. */
  properties?: string[];
  /** Computed style property names. Omit → empty (must opt in). */
  computedStyles?: string[];
}

const DEFAULT_ATTRIBUTES: ReadonlyArray<string> = [
  'id',
  'class',
  'href',
  'src',
  'value',
  'title',
  'role',
  'aria-label',
];
const DEFAULT_PROPERTIES: ReadonlyArray<string> = [
  'tagName',
  'checked',
  'disabled',
  'selected',
  'value',
];

interface ShimEntry {
  tagName: string;
  attributes: Record<string, string | null>;
  properties: Record<string, unknown>;
  computedStyles: Record<string, string>;
}

interface ShimSuccess {
  ok: true;
  resolution: 'ref' | 'selector';
  count: number;
  entries: ShimEntry[];
}

interface ShimFailure {
  ok: false;
  message: string;
}

type ShimResult = ShimSuccess | ShimFailure;

class GetAttributesTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.GET_ATTRIBUTES;

  async execute(args: GetAttributesParams = {}): Promise<ToolResult> {
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
      const tab = await this.getOwnedTab({
        windowId: args.windowId,
        required: false,
        isRead: true,
      });
      if (!tab || typeof tab.id !== 'number') {
        return createErrorResponse(
          'No active tab found',
          ToolErrorCode.TAB_NOT_FOUND,
          typeof args.windowId === 'number' ? { windowId: args.windowId } : undefined,
        );
      }
      tabId = tab.id;
    }

    // Resolve structured/prefixed selectors to a ref first, so the shim
    // only handles raw CSS / ref like the focus/click tools do.
    let shimSelector: string | null = args.selector ?? null;
    let shimRef: string | null = args.ref ?? null;
    const wantStructuredResolve =
      !shimRef &&
      shimSelector &&
      (() => {
        if (args.selectorType && STRUCTURED_SELECTOR_KINDS.includes(args.selectorType)) return true;
        if (args.selectorType === 'xpath') return true;
        if (!args.selectorType || args.selectorType === 'css') {
          const parsed = parsePrefixedSelector(shimSelector);
          return parsed.kind !== 'css';
        }
        return false;
      })();
    if (wantStructuredResolve) {
      const resolved = await resolveSelectorToRef(this, {
        tabId,
        frameId: args.frameId,
        selector: shimSelector!,
        selectorType: (args.selectorType ?? 'css') as SelectorType,
        index: args.index,
        multi: args.multi,
      });
      if (!resolved.ok) return resolved.error;
      shimRef = resolved.ref;
      shimSelector = null;
    }

    const attributes = args.attributes ?? [...DEFAULT_ATTRIBUTES];
    const properties = args.properties ?? [...DEFAULT_PROPERTIES];
    const computedStyles = args.computedStyles ?? [];

    try {
      const target: { tabId: number; frameIds?: number[] } = { tabId };
      if (typeof args.frameId === 'number') target.frameIds = [args.frameId];
      const injected = await chrome.scripting.executeScript({
        target,
        world: 'ISOLATED',
        func: getAttributesShim,
        args: [
          shimSelector,
          shimRef,
          attributes,
          properties,
          computedStyles,
          args.index ?? null,
          args.multi === true,
        ],
      });
      const first = injected?.[0]?.result as ShimResult | undefined;
      if (!first) {
        return createErrorResponse(
          'get-attributes shim returned no result (frame missing or blocked?)',
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
      // Single-match: flatten the single entry; multi-match: return the
      // array under `matches`. Mirrors the click/focus pattern of
      // returning either a singular envelope or one tagged with `multi`.
      if (args.multi === true) {
        return jsonOk({
          ok: true,
          tabId,
          frameId: args.frameId ?? null,
          resolution: first.resolution,
          multi: true,
          count: first.count,
          matches: first.entries,
        });
      }
      const single = first.entries[0];
      return jsonOk({
        ok: true,
        tabId,
        frameId: args.frameId ?? null,
        resolution: first.resolution,
        count: first.count,
        tagName: single?.tagName ?? null,
        attributes: single?.attributes ?? {},
        properties: single?.properties ?? {},
        computedStyles: single?.computedStyles ?? {},
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/no tab with id/i.test(msg)) {
        return createErrorResponse(`Tab ${tabId} not found`, ToolErrorCode.TAB_CLOSED, { tabId });
      }
      return createErrorResponse(`chrome_get_attributes failed: ${msg}`, ToolErrorCode.UNKNOWN, {
        tabId,
        frameId: args.frameId,
      });
    }
  }
}

/**
 * ISOLATED-world shim. Self-contained — chrome.scripting.func only
 * serializes the function body. Reads attributes via getAttribute,
 * properties via direct member access (covers DOM-property-only fields
 * like `checked`, `value`, `selectedIndex`, `files.length`), computed
 * styles via getComputedStyle().getPropertyValue.
 */
function getAttributesShim(
  selector: string | null,
  ref: string | null,
  attributeNames: string[],
  propertyNames: string[],
  computedStyleNames: string[],
  index: number | null,
  multi: boolean,
): ShimResult {
  try {
    let elements: Element[] = [];
    let resolution: 'ref' | 'selector' = 'selector';

    if (ref) {
      resolution = 'ref';
      const map = (window as unknown as { __claudeElementMap?: Record<string, WeakRef<Element>> })
        .__claudeElementMap;
      if (!map || !map[ref]) {
        return { ok: false, message: `ref "${ref}" not found in element map` };
      }
      const el = map[ref].deref?.();
      if (!el) {
        return { ok: false, message: `ref "${ref}" element has been garbage-collected` };
      }
      elements = [el];
    } else if (selector) {
      const list = document.querySelectorAll(selector);
      if (list.length === 0) {
        return { ok: false, message: `selector "${selector}" matched no element` };
      }
      if (multi) {
        elements = Array.from(list);
      } else if (index !== null && Number.isFinite(index)) {
        const idx = Math.max(0, Math.floor(index));
        if (idx >= list.length) {
          return {
            ok: false,
            message: `index ${idx} out of range for selector "${selector}" (matched ${list.length})`,
          };
        }
        elements = [list[idx]];
      } else if (list.length > 1) {
        return {
          ok: false,
          message: `selector "${selector}" matched ${list.length} elements (use multi:true or pass index)`,
        };
      } else {
        elements = [list[0]];
      }
    } else {
      return { ok: false, message: 'neither selector nor ref provided' };
    }

    const entries: ShimEntry[] = elements.map((el) => {
      const attributes: Record<string, string | null> = {};
      for (const name of attributeNames) {
        attributes[name] = el.getAttribute(name);
      }
      const properties: Record<string, unknown> = {};
      for (const name of propertyNames) {
        try {
          const value = (el as unknown as Record<string, unknown>)[name];
          // Skip Functions/Symbols and avoid serializing huge DOM nodes —
          // anything object-y other than plain primitives gets a string
          // marker so the envelope stays JSON-serializable.
          if (
            value === null ||
            value === undefined ||
            typeof value === 'string' ||
            typeof value === 'number' ||
            typeof value === 'boolean'
          ) {
            properties[name] = value;
          } else if (typeof value === 'object') {
            // FileList → length is the useful number; everything else gets
            // a stable string marker.
            const v = value as { length?: number };
            properties[name] = typeof v.length === 'number' ? { length: v.length } : '[object]';
          } else {
            properties[name] = `[${typeof value}]`;
          }
        } catch {
          properties[name] = '[error]';
        }
      }
      const computedStyles: Record<string, string> = {};
      if (computedStyleNames.length > 0) {
        const cs = window.getComputedStyle(el as HTMLElement);
        for (const name of computedStyleNames) {
          computedStyles[name] = cs.getPropertyValue(name);
        }
      }
      return {
        tagName: el.tagName.toLowerCase(),
        attributes,
        properties,
        computedStyles,
      };
    });

    return { ok: true, resolution, count: entries.length, entries };
  } catch (err) {
    return {
      ok: false,
      message: `get-attributes shim error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export const getAttributesTool = new GetAttributesTool();
