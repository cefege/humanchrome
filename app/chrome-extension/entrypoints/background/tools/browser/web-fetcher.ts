import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'humanchrome-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { sendNativeRequest } from '@/entrypoints/background/native-host';

/**
 * Convert a Blob to its raw base64 representation (without the
 * `data:...;base64,` prefix). Uses FileReader → readAsDataURL so the encoding
 * happens natively and handles arbitrary sizes. Replaces a previous
 * `String.fromCharCode` byte loop that quadratically grew a string and could
 * blow the stack / run out of memory on multi-hundred-MB MHTML captures.
 */
async function blobToBase64(blob: Blob): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const commaIdx = result.indexOf(',');
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Merge a Readability-backed in-page response (text or markdown branch)
 * into the dispatcher's accumulating result. The two branches share
 * identical projection rules: copy the named content field, normalize
 * `article` to a fixed 5-field shape, pass `metadata` and `fallback`
 * through. On failure, surface `<key>Error` so callers can distinguish
 * which branch failed.
 */
function applyReadabilityResponse(
  result: Record<string, unknown>,
  response: any,
  key: 'textContent' | 'markdownContent',
): void {
  if (!response?.success) {
    result[`${key}Error`] = response?.error;
    return;
  }
  result[key] = response[key];
  if (response.fallback) result.fallback = true;
  if (response.article) {
    result.article = {
      title: response.article.title,
      byline: response.article.byline,
      siteName: response.article.siteName,
      excerpt: response.article.excerpt,
      lang: response.article.lang,
    };
  }
  if (response.metadata) result.metadata = response.metadata;
}

interface WebFetcherToolParams {
  htmlContent?: boolean;
  textContent?: boolean;
  markdownContent?: boolean;
  url?: string;
  selector?: string;
  tabId?: number;
  background?: boolean;
  windowId?: number;
  raw?: boolean;
  savePath?: string;
}

class WebFetcherTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.WEB_FETCHER;
  // Full-page text/html/markdown legitimately runs to 100-200 KiB; raise
  // ceiling so the IMP-0179 outer guard doesn't cut normal usage. Callers
  // hitting the cap can still pass `raw: true` to bypass entirely.
  static readonly outputBudgetBytes = 256 * 1024;

  async execute(args: WebFetcherToolParams): Promise<ToolResult> {
    const htmlContent = args.htmlContent === true;
    const markdownContent = !htmlContent && args.markdownContent === true;
    const textContent = htmlContent || markdownContent ? false : args.textContent !== false;
    const url = args.url;
    const selector = args.selector;
    const explicitTabId = args.tabId;
    const { background = true } = args;
    const windowId = args.windowId;

    // Precondition: a non-MHTML savePath needs *something* to write. If the
    // caller explicitly disabled every extraction mode, fail loud here
    // rather than waste a tab round-trip and an IPC call only to discover
    // there's nothing to save.
    if (
      args.savePath &&
      !args.savePath.endsWith('.mhtml') &&
      args.htmlContent === false &&
      args.textContent === false &&
      args.markdownContent !== true
    ) {
      return createErrorResponse(
        'savePath given but htmlContent, textContent, and markdownContent are all disabled — nothing to save. Enable one, or use savePath ending in .mhtml for a Chrome-bundled snapshot.',
      );
    }

    try {
      // ── Resolve tab ──────────────────────────────────────────────────
      let tab;

      if (typeof explicitTabId === 'number') {
        tab = await chrome.tabs.get(explicitTabId);
      } else if (url) {
        const allTabs = await chrome.tabs.query({});
        const matchingTabs = allTabs.filter((t) => {
          const tabUrl = t.url?.endsWith('/') ? t.url.slice(0, -1) : t.url;
          const targetUrl = url.endsWith('/') ? url.slice(0, -1) : url;
          return tabUrl === targetUrl;
        });

        if (matchingTabs.length > 0) {
          tab = matchingTabs[0];
        } else {
          tab = await chrome.tabs.create({ url, active: background ? false : true });
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }
      } else {
        // Per-client owned tab (IMP-0157). Read-only.
        const owned = await this.getOwnedTab({
          windowId: typeof windowId === 'number' ? windowId : undefined,
          isRead: true,
          required: false,
        });
        if (!owned) return createErrorResponse('No active tab found');
        tab = owned;
      }

      if (!tab.id) return createErrorResponse('Tab has no ID');

      if (!background) {
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
      }

      // ── Save mode: MHTML (savePath ends with .mhtml) ────────────────
      // Complete offline snapshot — HTML + CSS + images bundled in one file.
      // Scrolls down first to trigger lazy-loaded images/content.
      if (args.savePath && args.savePath.endsWith('.mhtml')) {
        await this.scrollToLoadContent(tab.id!);
        return await this.saveAsMhtml(tab, args.savePath);
      }

      // ── Extract content ─────────────────────────────────────────────
      const result: any = { success: true, url: tab.url, title: tab.title };

      // Turndown is loaded only on the markdown path to keep the per-call
      // inject footprint small for the common text/HTML branches.
      const injectFiles = markdownContent
        ? [
            'inject-scripts/turndown-bundle.js',
            'inject-scripts/turndown-gfm-bundle.js',
            'inject-scripts/web-fetcher-helper.js',
          ]
        : ['inject-scripts/web-fetcher-helper.js'];
      await this.injectContentScript(tab.id, injectFiles);

      if (htmlContent) {
        const htmlResponse = await this.sendMessageToTab(tab.id, {
          action: TOOL_MESSAGE_TYPES.WEB_FETCHER_GET_HTML_CONTENT,
          selector,
          raw: args.raw !== false,
          extractResources: !!args.savePath,
        });

        if (htmlResponse.success) {
          result.htmlContent = htmlResponse.htmlContent;
          if (htmlResponse.resources) result.resources = htmlResponse.resources;
        } else {
          result.htmlContentError = htmlResponse.error;
        }
      }

      if (textContent) {
        const textResponse = await this.sendMessageToTab(tab.id, {
          action: TOOL_MESSAGE_TYPES.WEB_FETCHER_GET_TEXT_CONTENT,
          selector,
        });
        applyReadabilityResponse(result, textResponse, 'textContent');
      }

      if (markdownContent) {
        const markdownResponse = await this.sendMessageToTab(tab.id, {
          action: TOOL_MESSAGE_TYPES.WEB_FETCHER_GET_MARKDOWN_CONTENT,
        });
        applyReadabilityResponse(result, markdownResponse, 'markdownContent');
      }

      // ── Save to disk ────────────────────────────────────────────────
      // Raw HTML saved to disk. Resources load from internet.
      // Auto-generates _resources.json sidecar with image/font/script inventory.
      if (args.savePath) {
        return await this.saveHtmlToDisk(tab, args.savePath, result);
      }

      // No savePath — return content inline (legacy/fallback)
      return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false };
    } catch (error) {
      return createErrorResponse(
        `Error fetching web content: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Scroll down the page to trigger lazy-loaded images/content, then scroll back to top.
   */
  private async scrollToLoadContent(tabId: number): Promise<void> {
    try {
      await chrome.tabs.update(tabId, { active: true });
      await chrome.scripting.executeScript({
        target: { tabId },
        func: async () => {
          const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
          const step = window.innerHeight * 0.8;
          const maxScroll = document.documentElement.scrollHeight;
          // Scroll down in steps
          for (let y = 0; y < maxScroll; y += step) {
            window.scrollTo(0, y);
            await delay(300);
          }
          // Scroll to very bottom
          window.scrollTo(0, maxScroll);
          await delay(500);
          // Back to top
          window.scrollTo(0, 0);
          await delay(300);
        },
      });
    } catch (e) {
      console.error('Scroll-to-load failed (non-fatal):', e);
    }
  }

  /**
   * Save complete page as MHTML (offline snapshot with all resources bundled).
   */
  private async saveAsMhtml(tab: chrome.tabs.Tab, savePath: string): Promise<ToolResult> {
    const mhtmlBlob = await chrome.pageCapture.saveAsMHTML({ tabId: tab.id! });
    if (!mhtmlBlob) {
      return createErrorResponse(
        'chrome.pageCapture.saveAsMHTML returned no blob — page may be unsupported (chrome://, devtools://) or capture was cancelled.',
      );
    }
    const base64Data = await blobToBase64(mhtmlBlob);

    const resp = await sendNativeRequest<any>(
      'file_operation',
      { action: 'saveToPath', destPath: savePath, base64Data },
      120_000,
    );

    if (!resp?.success) {
      return createErrorResponse(`Failed to save MHTML: ${resp?.error || 'unknown'}`);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            saved: true,
            format: 'mhtml',
            filePath: resp.filePath,
            size: resp.size,
            url: tab.url,
            title: tab.title,
          }),
        },
      ],
      isError: false,
    };
  }

  /**
   * Save raw HTML + viewport screenshot to disk.
   * HTML keeps original URLs so images/fonts load from internet.
   * Screenshot auto-saved as .png alongside the .html.
   */
  private async saveHtmlToDisk(
    tab: chrome.tabs.Tab,
    savePath: string,
    result: any,
  ): Promise<ToolResult> {
    const contentToSave = result.htmlContent || result.markdownContent || result.textContent || '';
    if (!contentToSave) {
      return createErrorResponse(
        'No content to save — enable htmlContent, markdownContent, or textContent',
      );
    }

    // Save HTML
    const resp = await sendNativeRequest<any>(
      'file_operation',
      { action: 'saveToPath', destPath: savePath, textData: contentToSave },
      60_000,
    );

    if (!resp?.success) {
      return createErrorResponse(`Failed to save file: ${resp?.error || 'unknown'}`);
    }

    // Screenshot disabled for now — use .mhtml for complete captures

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            saved: true,
            format: 'html',
            filePath: resp.filePath,
            size: resp.size,
            url: tab.url,
            title: tab.title,
          }),
        },
      ],
      isError: false,
    };
  }
}

export const webFetcherTool = new WebFetcherTool();
