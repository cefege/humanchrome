import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolError, ToolErrorCode } from 'humanchrome-shared';
import { DEFAULT_WAIT_FOR_TAB_TIMEOUT_MS, waitForTabComplete } from '../../utils/wait-for-tab';

interface NavigateBatchToolParams {
  urls: string[];
  windowId?: number;
  background?: boolean;
  perTabDelayMs?: number;
  /**
   * Cap on number of in-flight tab loads. When omitted (or <= 0), all URLs
   * open in parallel (legacy behavior). When set, opens at most N tabs at a
   * time and waits for each to reach status:'complete' before the worker
   * starts its next URL. Clamped to [1, urls.length].
   */
  maxConcurrent?: number;
  /**
   * Per-URL load timeout when maxConcurrent is set. Defaults to the standard
   * waitForTabComplete timeout (30s). Ignored when maxConcurrent is not set.
   */
  perUrlTimeoutMs?: number;
}

/**
 * Open many URLs at once and return their tabIds.
 *
 * Why this exists
 * ---------------
 * The fan-out workflow — open N tabs, then iterate through them sequentially
 * — needs a single round-trip primitive instead of N `chrome_navigate` calls.
 * Tabs open in the background by default so the user's foreground tab keeps
 * focus while everything loads. Pair with `chrome_wait_for_tab` to drain.
 *
 * Concurrency
 * -----------
 * By default, every URL is opened back-to-back (with optional `perTabDelayMs`
 * spacing) and the tool returns as soon as the opens are issued — it does not
 * wait for any tab to finish loading. When `maxConcurrent` is provided, a
 * worker pool of that size picks URLs off a queue; each worker opens a tab,
 * waits for it to reach `status:'complete'` (TIMEOUT and other load failures
 * are recorded as errors but do not abort the worker), then picks the next
 * URL. This prevents the burst-open pattern that anti-bot platforms flag
 * while still parallelizing N tabs at a time.
 */
class NavigateBatchTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.NAVIGATE_BATCH;
  static readonly mutates = true;

  async execute(args: NavigateBatchToolParams): Promise<ToolResult> {
    const {
      urls,
      windowId,
      background = true,
      perTabDelayMs = 0,
      maxConcurrent,
      perUrlTimeoutMs = DEFAULT_WAIT_FOR_TAB_TIMEOUT_MS,
    } = args ?? {};

    if (!Array.isArray(urls) || urls.length === 0) {
      return createErrorResponse(
        'urls must be a non-empty array of strings',
        ToolErrorCode.INVALID_ARGS,
      );
    }
    for (const u of urls) {
      if (typeof u !== 'string' || u.length === 0) {
        return createErrorResponse(
          'every entry in urls must be a non-empty string',
          ToolErrorCode.INVALID_ARGS,
        );
      }
    }

    let targetWindowId = windowId;
    if (typeof targetWindowId !== 'number') {
      try {
        // windowTypes filter excludes devtools/popup so the fallback can't
        // pick a window the user isn't actually working in.
        const lastFocused = await chrome.windows.getLastFocused({
          populate: false,
          windowTypes: ['normal'],
        });
        if (lastFocused.id !== undefined) targetWindowId = lastFocused.id;
      } catch {
        // No existing window — chrome.tabs.create without windowId will create one.
      }
    }

    // Track results in a sparse array so the response preserves input order
    // even when workers finish out of order. We then compact at the end.
    const openedByIndex: Array<{ tabId: number; url: string } | undefined> = new Array(urls.length);
    const errorsByIndex: Array<{ url: string; message: string } | undefined> = new Array(
      urls.length,
    );

    const openOne = async (index: number): Promise<{ tabId: number; url: string } | undefined> => {
      const url = urls[index];
      try {
        const tab = await chrome.tabs.create({
          url,
          active: !background,
          ...(typeof targetWindowId === 'number' ? { windowId: targetWindowId } : {}),
        });
        if (typeof tab.id !== 'number') {
          errorsByIndex[index] = { url, message: 'Created tab returned no id' };
          return undefined;
        }
        const result = { tabId: tab.id, url };
        openedByIndex[index] = result;
        return result;
      } catch (err) {
        errorsByIndex[index] = {
          url,
          message: err instanceof Error ? err.message : String(err),
        };
        return undefined;
      }
    };

    // Decide between legacy (parallel-ish, no waiting) path and worker-pool
    // (bounded concurrency, waits for each tab to load) path. maxConcurrent
    // omitted, <=0, or >= urls.length means "no useful cap" → legacy behavior.
    const useWorkerPool =
      typeof maxConcurrent === 'number' &&
      Number.isFinite(maxConcurrent) &&
      maxConcurrent >= 1 &&
      maxConcurrent < urls.length;

    if (!useWorkerPool) {
      // Legacy path: open sequentially with optional perTabDelayMs spacing,
      // do NOT wait for tabs to finish loading. This preserves the prior
      // contract (caller drains via chrome_wait_for_tab).
      for (let i = 0; i < urls.length; i++) {
        await openOne(i);
        if (perTabDelayMs > 0 && i < urls.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, perTabDelayMs));
        }
      }
    } else {
      // Worker-pool path. Each worker repeatedly:
      //   1. claims the next index from a shared cursor
      //   2. opens the tab
      //   3. waits for status:'complete' (TIMEOUT/TAB_CLOSED → record + continue)
      //   4. honors perTabDelayMs as intra-worker spacing
      const concurrency = Math.max(1, Math.min(maxConcurrent!, urls.length));
      let cursor = 0;
      const claimNext = (): number | undefined => {
        if (cursor >= urls.length) return undefined;
        return cursor++;
      };

      const worker = async () => {
        for (;;) {
          const index = claimNext();
          if (index === undefined) return;

          const opened = await openOne(index);
          if (opened) {
            try {
              await waitForTabComplete(opened.tabId, { timeoutMs: perUrlTimeoutMs });
            } catch (err) {
              // TIMEOUT / TAB_CLOSED / TAB_NOT_FOUND while waiting — keep the
              // tabId in the success list (caller can still inspect / close
              // it) but surface a load error so the agent knows it didn't
              // settle. Do NOT abort the worker.
              const message =
                err instanceof ToolError
                  ? `${err.code}: ${err.message}`
                  : err instanceof Error
                    ? err.message
                    : String(err);
              errorsByIndex[index] = { url: opened.url, message };
            }
          }

          // Intra-worker spacing. Skip after the worker's last URL.
          if (perTabDelayMs > 0 && cursor < urls.length) {
            await new Promise((resolve) => setTimeout(resolve, perTabDelayMs));
          }
        }
      };

      const workers = Array.from({ length: concurrency }, () => worker());
      await Promise.allSettled(workers);
    }

    const opened = openedByIndex.filter(
      (r): r is { tabId: number; url: string } => r !== undefined,
    );
    const errors = errorsByIndex.filter(
      (e): e is { url: string; message: string } => e !== undefined,
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            tabs: opened,
            windowId: targetWindowId,
            count: opened.length,
            ...(errors.length > 0 ? { errors } : {}),
          }),
        },
      ],
      isError: false,
    };
  }
}

export const navigateBatchTool = new NavigateBatchTool();
