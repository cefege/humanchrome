import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';
import { cdpSessionManager } from '@/utils/cdp-session-manager';

/**
 * One-shot interception of the next network response on a tab whose URL
 * matches a pattern. The tool's reason for existing: LinkedIn / Voyager /
 * GraphQL APIs return JSON that already contains everything our DOM-walking
 * extractors slowly piece together. With this tool we navigate, listen for
 * exactly one matching response, and return the parsed body — no DOM walk.
 *
 * Lifecycle:
 *   1. Resolve target tab (arg or active).
 *   2. cdpSessionManager.attach(tabId, 'intercept-response')
 *      — refcounted; piggybacks on any other tool that already attached.
 *   3. Network.enable
 *   4. Listen for Network.requestWillBeSent (capture URL+method)
 *      and Network.responseReceived (match + capture requestId).
 *      Wait for Network.loadingFinished, then call Network.getResponseBody.
 *   5. Resolve with parsed body. Detach (refcount-safe).
 *   6. On timeout, reject; same detach path.
 *
 * Pattern syntax:
 *   "voyager/api/messaging" → simple substring match
 *   "/voyager\\/api\\/.*conversations/i" → wrapped slashes => regex (with flags)
 */

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 120_000;
const OWNER = 'intercept-response' as const;

interface InterceptResponseParams {
  urlPattern: string;
  method?: string;
  timeoutMs?: number;
  tabId?: number;
  returnBody?: boolean;
}

interface PendingMatch {
  requestId: string;
  url: string;
  method: string;
  status: number;
  statusText: string;
  mimeType: string;
  responseHeaders: Record<string, string>;
}

function compilePattern(pattern: string): (url: string) => boolean {
  const trimmed = pattern.trim();
  // Regex form: /pattern/flags
  if (trimmed.length >= 2 && trimmed.startsWith('/')) {
    const lastSlash = trimmed.lastIndexOf('/');
    if (lastSlash > 0) {
      const body = trimmed.slice(1, lastSlash);
      const flags = trimmed.slice(lastSlash + 1);
      try {
        const re = new RegExp(body, flags);
        return (url: string) => re.test(url);
      } catch {
        // fall through to substring
      }
    }
  }
  return (url: string) => url.includes(trimmed);
}

function tryParseJson(body: string, mimeType: string): { json?: unknown; parsed: boolean } {
  if (!body) return { parsed: false };
  // Don't try to parse obvious non-JSON
  const lower = (mimeType || '').toLowerCase();
  if (lower && !lower.includes('json') && !lower.includes('javascript')) {
    return { parsed: false };
  }
  try {
    return { json: JSON.parse(body), parsed: true };
  } catch {
    return { parsed: false };
  }
}

class InterceptResponseTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.INTERCEPT_RESPONSE;

  async execute(args: InterceptResponseParams): Promise<ToolResult> {
    if (!args || typeof args.urlPattern !== 'string' || !args.urlPattern.trim()) {
      return createErrorResponse('urlPattern is required', ToolErrorCode.INVALID_ARGS, {
        arg: 'urlPattern',
      });
    }
    const timeoutMs = Math.min(
      MAX_TIMEOUT_MS,
      Math.max(100, Number(args.timeoutMs) || DEFAULT_TIMEOUT_MS),
    );
    const wantBody = args.returnBody !== false;
    const methodFilter = args.method ? args.method.toUpperCase() : null;

    // Resolve tab
    let tabId = args.tabId;
    if (typeof tabId !== 'number') {
      try {
        const tab = await this.getActiveTabOrThrow();
        tabId = tab.id!;
      } catch (err) {
        return createErrorResponse(
          `Failed to resolve active tab: ${(err as Error).message || String(err)}`,
        );
      }
    }

    const matches = compilePattern(args.urlPattern);
    const requests = new Map<string, { url: string; method: string }>();

    let attached = false;
    let listener:
      | ((source: chrome.debugger.Debuggee, method: string, params?: unknown) => void)
      | null = null;

    const cleanup = async (): Promise<void> => {
      if (listener) {
        try {
          chrome.debugger.onEvent.removeListener(listener);
        } catch {
          // ignore
        }
        listener = null;
      }
      if (attached) {
        try {
          await cdpSessionManager.detach(tabId!, OWNER);
        } catch {
          // ignore — already detached or session never owned
        }
        attached = false;
      }
    };

    const promise = new Promise<ToolResult>((resolve) => {
      const timer = setTimeout(async () => {
        await cleanup();
        resolve(
          createErrorResponse(
            `Timed out after ${timeoutMs}ms waiting for response matching "${args.urlPattern}" on tab ${tabId}`,
            ToolErrorCode.TIMEOUT,
            { tabId },
          ),
        );
      }, timeoutMs);

      let pending: PendingMatch | null = null;

      listener = (source, method, params) => {
        if (source.tabId !== tabId) return;
        const p = params as Record<string, unknown> | undefined;

        if (method === 'Network.requestWillBeSent' && p) {
          const requestId = String((p.requestId as string) || '');
          const req = (p.request as Record<string, unknown>) || {};
          requests.set(requestId, {
            url: String(req.url || ''),
            method: String(req.method || 'GET'),
          });
          return;
        }

        if (method === 'Network.responseReceived' && p && !pending) {
          const requestId = String((p.requestId as string) || '');
          const response = (p.response as Record<string, unknown>) || {};
          const url = String(response.url || requests.get(requestId)?.url || '');
          if (!url) return;
          if (!matches(url)) return;
          const reqMeta = requests.get(requestId);
          const reqMethod = (reqMeta?.method || 'GET').toUpperCase();
          if (methodFilter && reqMethod !== methodFilter) return;

          pending = {
            requestId,
            url,
            method: reqMethod,
            status: Number(response.status || 0),
            statusText: String(response.statusText || ''),
            mimeType: String(response.mimeType || ''),
            responseHeaders: (response.headers as Record<string, string>) || {},
          };

          if (!wantBody) {
            clearTimeout(timer);
            (async () => {
              await cleanup();
              resolve({
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      ok: true,
                      tabId,
                      ...pending,
                      bodyOmitted: true,
                    }),
                  },
                ],
                isError: false,
              });
            })();
          }
          return;
        }

        if (method === 'Network.loadingFinished' && p && pending) {
          const requestId = String((p.requestId as string) || '');
          if (requestId !== pending.requestId) return;
          clearTimeout(timer);
          (async () => {
            try {
              const body = (await cdpSessionManager.sendCommand(tabId!, 'Network.getResponseBody', {
                requestId: pending!.requestId,
              })) as { body: string; base64Encoded: boolean };
              const parsed = tryParseJson(body.body, pending!.mimeType);
              await cleanup();
              resolve({
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      ok: true,
                      tabId,
                      ...pending,
                      base64Encoded: body.base64Encoded,
                      bodyParsed: parsed.parsed,
                      body: parsed.parsed ? parsed.json : body.body,
                    }),
                  },
                ],
                isError: false,
              });
            } catch (err) {
              await cleanup();
              resolve(
                createErrorResponse(
                  `Failed to read response body for ${pending!.url}: ${(err as Error).message || String(err)}`,
                ),
              );
            }
          })();
          return;
        }

        if (method === 'Network.loadingFailed' && p && pending) {
          const requestId = String((p.requestId as string) || '');
          if (requestId !== pending.requestId) return;
          clearTimeout(timer);
          (async () => {
            await cleanup();
            resolve(
              createErrorResponse(
                `Network request matched but failed to load: ${pending!.url} — ${String(p.errorText || 'unknown error')}`,
              ),
            );
          })();
        }
      };

      chrome.debugger.onEvent.addListener(listener);

      // Attach + Network.enable. Errors here resolve the promise immediately.
      (async () => {
        try {
          await cdpSessionManager.attach(tabId!, OWNER);
          attached = true;
          await cdpSessionManager.sendCommand(tabId!, 'Network.enable');
        } catch (err) {
          clearTimeout(timer);
          await cleanup();
          resolve(
            createErrorResponse(
              `Failed to attach debugger to tab ${tabId}: ${(err as Error).message || String(err)}`,
            ),
          );
        }
      })();
    });

    return promise;
  }
}

export const interceptResponseTool = new InterceptResponseTool();
