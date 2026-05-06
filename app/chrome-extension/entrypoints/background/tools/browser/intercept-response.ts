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
 *
 * Multi-match mode (count > 1):
 *   When count > 1 we accumulate up to N matching responses before
 *   detaching, then return them as `responses: InterceptedResponse[]`.
 *   On timeout we still resolve with whatever was collected (matched > 0)
 *   so paginated flows that don't quite hit the expected count still
 *   return useful data. matched === 0 + timeout still produces the
 *   standard TIMEOUT error envelope.
 */

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_COUNT = 100;
const OWNER = 'intercept-response' as const;

interface InterceptResponseParams {
  urlPattern: string;
  method?: string;
  timeoutMs?: number;
  tabId?: number;
  returnBody?: boolean;
  count?: number;
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

interface CompletedMatch extends PendingMatch {
  base64Encoded?: boolean;
  bodyParsed?: boolean;
  body?: unknown;
  bodyOmitted?: boolean;
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
    const rawCount = Number(args.count);
    const count =
      Number.isFinite(rawCount) && rawCount > 0 ? Math.min(MAX_COUNT, Math.floor(rawCount)) : 1;
    const multi = count > 1;

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
      let resolved = false;
      const finish = (result: ToolResult): void => {
        if (resolved) return;
        resolved = true;
        resolve(result);
      };

      // In single-match mode, `pending` is the in-flight request being
      // body-fetched (legacy zero-behavior-change path). In multi-match
      // mode we keep a Map of requestId -> PendingMatch so multiple
      // overlapping requests can be tracked simultaneously.
      let pending: PendingMatch | null = null;
      const pendingByRequestId = new Map<string, PendingMatch>();
      const completed: CompletedMatch[] = [];
      let inFlightBodyReads = 0;
      let timedOut = false;

      const buildMultiResult = (): ToolResult => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              tabId,
              count,
              matched: completed.length,
              responses: completed,
            }),
          },
        ],
        isError: false,
      });

      const maybeFinishMulti = async (): Promise<void> => {
        if (!multi) return;
        // Resolve when we've reached count, OR when timeout fired and
        // there are no more body reads in flight.
        if (completed.length >= count) {
          clearTimeout(timer);
          await cleanup();
          finish(buildMultiResult());
          return;
        }
        if (timedOut && inFlightBodyReads === 0) {
          await cleanup();
          if (completed.length === 0) {
            finish(
              createErrorResponse(
                `Timed out after ${timeoutMs}ms waiting for response matching "${args.urlPattern}" on tab ${tabId}`,
                ToolErrorCode.TIMEOUT,
                { tabId },
              ),
            );
          } else {
            finish(buildMultiResult());
          }
        }
      };

      const timer = setTimeout(async () => {
        if (multi) {
          // Stop accepting new matches and let any in-flight body reads
          // settle, then return whatever we have.
          timedOut = true;
          // Detach the listener now so no more matches accumulate, but
          // keep `attached` true until cleanup() runs after in-flight
          // reads finish (sendCommand needs the session).
          if (listener) {
            try {
              chrome.debugger.onEvent.removeListener(listener);
            } catch {
              // ignore
            }
            listener = null;
          }
          if (inFlightBodyReads === 0) {
            await cleanup();
            if (completed.length === 0) {
              finish(
                createErrorResponse(
                  `Timed out after ${timeoutMs}ms waiting for response matching "${args.urlPattern}" on tab ${tabId}`,
                  ToolErrorCode.TIMEOUT,
                  { tabId },
                ),
              );
            } else {
              finish(buildMultiResult());
            }
          }
          return;
        }
        await cleanup();
        finish(
          createErrorResponse(
            `Timed out after ${timeoutMs}ms waiting for response matching "${args.urlPattern}" on tab ${tabId}`,
            ToolErrorCode.TIMEOUT,
            { tabId },
          ),
        );
      }, timeoutMs);

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

        if (method === 'Network.responseReceived' && p) {
          // Single-match: only accept the first match (existing behavior).
          if (!multi && pending) return;

          const requestId = String((p.requestId as string) || '');
          const response = (p.response as Record<string, unknown>) || {};
          const url = String(response.url || requests.get(requestId)?.url || '');
          if (!url) return;
          if (!matches(url)) return;
          const reqMeta = requests.get(requestId);
          const reqMethod = (reqMeta?.method || 'GET').toUpperCase();
          if (methodFilter && reqMethod !== methodFilter) return;

          const match: PendingMatch = {
            requestId,
            url,
            method: reqMethod,
            status: Number(response.status || 0),
            statusText: String(response.statusText || ''),
            mimeType: String(response.mimeType || ''),
            responseHeaders: (response.headers as Record<string, string>) || {},
          };

          if (multi) {
            // Cap how many we even start tracking (count - completed - tracked)
            // so we don't body-read more than required if many fire at once.
            const tracking = pendingByRequestId.size + completed.length;
            if (tracking >= count) return;
            pendingByRequestId.set(requestId, match);

            if (!wantBody) {
              completed.push({ ...match, bodyOmitted: true });
              pendingByRequestId.delete(requestId);
              void maybeFinishMulti();
            }
            return;
          }

          // Single-match path (preserve original behavior exactly).
          pending = match;

          if (!wantBody) {
            clearTimeout(timer);
            (async () => {
              await cleanup();
              finish({
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

        if (method === 'Network.loadingFinished' && p) {
          const requestId = String((p.requestId as string) || '');

          if (multi) {
            const match = pendingByRequestId.get(requestId);
            if (!match) return;
            pendingByRequestId.delete(requestId);
            inFlightBodyReads += 1;
            (async () => {
              try {
                const body = (await cdpSessionManager.sendCommand(
                  tabId!,
                  'Network.getResponseBody',
                  { requestId: match.requestId },
                )) as { body: string; base64Encoded: boolean };
                const parsed = tryParseJson(body.body, match.mimeType);
                completed.push({
                  ...match,
                  base64Encoded: body.base64Encoded,
                  bodyParsed: parsed.parsed,
                  body: parsed.parsed ? parsed.json : body.body,
                });
              } catch {
                // Skip this match — body unavailable (e.g. request was
                // cancelled mid-flight). Keep going for other matches.
              } finally {
                inFlightBodyReads -= 1;
                void maybeFinishMulti();
              }
            })();
            return;
          }

          // Single-match path.
          if (!pending) return;
          if (requestId !== pending.requestId) return;
          clearTimeout(timer);
          (async () => {
            try {
              const body = (await cdpSessionManager.sendCommand(tabId!, 'Network.getResponseBody', {
                requestId: pending!.requestId,
              })) as { body: string; base64Encoded: boolean };
              const parsed = tryParseJson(body.body, pending!.mimeType);
              await cleanup();
              finish({
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
              finish(
                createErrorResponse(
                  `Failed to read response body for ${pending!.url}: ${(err as Error).message || String(err)}`,
                ),
              );
            }
          })();
          return;
        }

        if (method === 'Network.loadingFailed' && p) {
          const requestId = String((p.requestId as string) || '');

          if (multi) {
            // Skip this entry — but keep listening for more matches up
            // to the requested count.
            if (pendingByRequestId.has(requestId)) {
              pendingByRequestId.delete(requestId);
            }
            return;
          }

          if (!pending) return;
          if (requestId !== pending.requestId) return;
          clearTimeout(timer);
          (async () => {
            await cleanup();
            finish(
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
          finish(
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
