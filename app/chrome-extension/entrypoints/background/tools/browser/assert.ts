import {
  createErrorResponse,
  createErrorResponseFromThrown,
  ToolResult,
} from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';
import { ERROR_MESSAGES } from '@/common/constants';
import { consoleBuffer } from './console-buffer';

type Predicate =
  | { kind: 'url_matches'; pattern: string; type?: 'substring' | 'regex' }
  | {
      kind: 'element_present' | 'element_absent';
      selector?: string;
      ref?: string;
      selectorType?: 'css' | 'xpath';
    }
  | { kind: 'console_clean'; sinceMs?: number; pattern?: string }
  | { kind: 'network_succeeded'; urlPattern: string }
  | { kind: 'js'; expression: string };

interface AssertToolParams {
  predicates: Predicate[];
  tabId?: number;
  windowId?: number;
}

interface PredicateResult {
  predicate: Predicate;
  ok: boolean;
  detail?: unknown;
}

/**
 * Compile a string into either a substring matcher or a regex matcher.
 * `/foo/i` form selects regex; everything else is a literal substring.
 * Returns null on a malformed regex so the caller can surface INVALID_ARGS.
 */
function compileMatcher(
  pattern: string,
  preferred?: 'substring' | 'regex',
): ((s: string) => boolean) | null {
  const trimmed = pattern.trim();
  if (preferred === 'substring') {
    return (s) => s.includes(pattern);
  }
  if (preferred === 'regex' || (trimmed.startsWith('/') && trimmed.length >= 2)) {
    const last = trimmed.lastIndexOf('/');
    if (last > 0) {
      try {
        const re = new RegExp(trimmed.slice(1, last), trimmed.slice(last + 1));
        return (s) => re.test(s);
      } catch {
        return null;
      }
    }
    if (preferred === 'regex') {
      try {
        const re = new RegExp(pattern);
        return (s) => re.test(s);
      } catch {
        return null;
      }
    }
  }
  return (s) => s.includes(pattern);
}

class AssertTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.ASSERT;

  async execute(args: AssertToolParams): Promise<ToolResult> {
    const { predicates } = args || ({} as AssertToolParams);
    if (!Array.isArray(predicates) || predicates.length === 0) {
      return createErrorResponse(
        'Provide at least one predicate in `predicates`',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'predicates' },
      );
    }

    try {
      const explicit = await this.tryGetTab(args.tabId);
      const tab = explicit || (await this.getActiveTabOrThrowInWindow(args.windowId));
      if (!tab.id) {
        return createErrorResponse(ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID');
      }

      const results: PredicateResult[] = [];
      for (const p of predicates) {
        results.push(await this.evaluate(tab, p));
      }
      const ok = results.every((r) => r.ok);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok, tabId: tab.id, results }),
          },
        ],
        isError: false,
      };
    } catch (err) {
      return createErrorResponseFromThrown(err);
    }
  }

  private async evaluate(tab: chrome.tabs.Tab, p: Predicate): Promise<PredicateResult> {
    switch (p.kind) {
      case 'url_matches': {
        if (typeof p.pattern !== 'string' || !p.pattern.length) {
          return { predicate: p, ok: false, detail: { error: 'pattern is required' } };
        }
        const match = compileMatcher(p.pattern, p.type);
        if (!match) {
          return { predicate: p, ok: false, detail: { error: 'invalid regex pattern' } };
        }
        const url = tab.url ?? '';
        return { predicate: p, ok: match(url), detail: { url } };
      }
      case 'element_present':
      case 'element_absent': {
        if (!p.selector && !p.ref) {
          return {
            predicate: p,
            ok: false,
            detail: { error: 'selector or ref is required' },
          };
        }
        const found = await this.checkElementExists(tab.id!, p);
        const ok = p.kind === 'element_present' ? found : !found;
        return { predicate: p, ok, detail: { found } };
      }
      case 'console_clean': {
        const since = typeof p.sinceMs === 'number' ? p.sinceMs : 0;
        const isCapturing = consoleBuffer.isCapturing(tab.id!);
        if (!isCapturing) {
          return {
            predicate: p,
            ok: false,
            detail: {
              error:
                'console buffer not running for this tab — call chrome_console with mode="buffer" to start capture before asserting console_clean',
            },
          };
        }
        const matcher = p.pattern && p.pattern.length ? compileMatcher(p.pattern, 'regex') : null;
        const read = consoleBuffer.read(tab.id!, { onlyErrors: true });
        const errors = (read?.messages || [])
          .concat(
            (read?.exceptions || []).map((e) => ({ ...e, level: 'error', text: e.text || '' })),
          )
          .filter((m) => m.timestamp >= since)
          .filter((m) => (matcher ? matcher(m.text || '') : true));
        return {
          predicate: p,
          ok: errors.length === 0,
          detail: {
            errorCount: errors.length,
            firstError: errors[0]
              ? { text: errors[0].text, timestamp: errors[0].timestamp }
              : undefined,
          },
        };
      }
      case 'network_succeeded': {
        if (typeof p.urlPattern !== 'string' || !p.urlPattern.length) {
          return { predicate: p, ok: false, detail: { error: 'urlPattern is required' } };
        }
        const match = compileMatcher(p.urlPattern, 'regex');
        if (!match) {
          return { predicate: p, ok: false, detail: { error: 'invalid urlPattern' } };
        }
        return await this.checkNetworkSucceeded(tab.id!, p.urlPattern);
      }
      case 'js': {
        if (typeof p.expression !== 'string' || !p.expression.length) {
          return { predicate: p, ok: false, detail: { error: 'expression is required' } };
        }
        return await this.checkJsExpression(tab.id!, p);
      }
      default: {
        return {
          predicate: p,
          ok: false,
          detail: { error: `unknown predicate kind: ${(p as { kind: string }).kind}` },
        };
      }
    }
  }

  private async checkElementExists(
    tabId: number,
    p: Extract<Predicate, { kind: 'element_present' | 'element_absent' }>,
  ): Promise<boolean> {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (selector, selectorType, ref) => {
        try {
          if (ref) {
            const map = (window as unknown as { __claudeElementMap?: Record<string, Element> })
              .__claudeElementMap;
            const el = map?.[ref];
            return !!(el && (el as Element & { isConnected: boolean }).isConnected);
          }
          if (!selector) return false;
          if (selectorType === 'xpath') {
            const r = document.evaluate(
              selector,
              document,
              null,
              XPathResult.FIRST_ORDERED_NODE_TYPE,
              null,
            );
            return !!r.singleNodeValue;
          }
          return !!document.querySelector(selector);
        } catch {
          return false;
        }
      },
      args: [p.selector ?? null, p.selectorType ?? 'css', p.ref ?? null],
    });
    return !!result?.[0]?.result;
  }

  private async checkNetworkSucceeded(tabId: number, urlPattern: string): Promise<PredicateResult> {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (urlPattern: string) => {
        const trimmed = urlPattern.trim();
        let test: (s: string) => boolean = (s) => s.includes(urlPattern);
        if (trimmed.startsWith('/') && trimmed.length >= 2) {
          const last = trimmed.lastIndexOf('/');
          if (last > 0) {
            try {
              const re = new RegExp(trimmed.slice(1, last), trimmed.slice(last + 1));
              test = (s) => re.test(s);
            } catch {
              // fall through to substring match
            }
          }
        }
        const entries = (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
          .filter((e) => test(e.name))
          .sort((a, b) => b.startTime - a.startTime);
        const last = entries[0];
        if (!last) return { found: false };
        const status = (last as PerformanceResourceTiming & { responseStatus?: number })
          .responseStatus;
        return {
          found: true,
          url: last.name,
          status,
          // transferSize === 0 with duration > 0 + decodedBodySize === 0 may
          // indicate cors-blocked or 304; the agent can inspect detail.
          transferSize: last.transferSize,
          duration: last.duration,
        };
      },
      args: [urlPattern],
    });
    const detail = result?.[0]?.result as
      | { found: false }
      | {
          found: true;
          url: string;
          status?: number;
          transferSize: number;
          duration: number;
        }
      | undefined;
    if (!detail || !detail.found) {
      return {
        predicate: { kind: 'network_succeeded', urlPattern },
        ok: false,
        detail: { found: false },
      };
    }
    // Cross-origin without Timing-Allow-Origin reports status undefined or 0;
    // treat "fetch completed" (entry exists with non-negative duration) as ok.
    const ok =
      typeof detail.status === 'number' && detail.status > 0
        ? detail.status >= 200 && detail.status < 400
        : detail.duration >= 0;
    return {
      predicate: { kind: 'network_succeeded', urlPattern },
      ok,
      detail,
    };
  }

  private async checkJsExpression(
    tabId: number,
    p: Extract<Predicate, { kind: 'js' }>,
  ): Promise<PredicateResult> {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (expr: string) => {
        try {
          const fn = new Function(`return (${expr});`);
          const value = fn();
          return { ok: !!value, value: value === undefined ? null : value };
        } catch (err) {
          return { ok: false, error: (err as Error).message ?? String(err) };
        }
      },
      args: [p.expression],
    });
    const r = result?.[0]?.result as { ok: boolean; value?: unknown; error?: string } | undefined;
    if (!r) {
      return { predicate: p, ok: false, detail: { error: 'no result from page' } };
    }
    return { predicate: p, ok: r.ok, detail: r };
  }
}

export const assertTool = new AssertTool();
