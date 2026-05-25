import { createErrorResponse, classifyTabError, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';
import { MAX_RESPONSE_BODY_BYTES } from '../../utils/timeouts';
import { utf8ByteLength, utf8ToBase64 } from '@/utils/encoding';
import { networkCaptureStartTool } from './network-capture-web-request';
import { getDebuggerCaptureData } from './network-capture';

/**
 * chrome_har_export — IMP-0144.
 *
 * Emit captured network data in standard HAR 1.2 JSON. The
 * `chrome_network_capture` backends (debugger + web-request) already
 * collect rich per-request data; this tool is a pure formatter that
 * shapes it into the format every external tool (DevTools "Save all
 * as HAR", Charles, Playwright trace viewer, har-validator suites)
 * expects.
 *
 * Multi-action:
 *   - `export_from_active` ({tabId?}): read whichever capture is
 *     currently running for the tab, format as HAR. Returns the
 *     JSON inline in the response.
 *   - `save_to_downloads` ({tabId?, filename?}): same export, but
 *     write the HAR JSON to ~/Downloads via chrome.downloads.download.
 *     Returns the download id + suggested path. Useful when the HAR
 *     is large enough to bloat the LLM context.
 *
 * Body sizes still honor the 1 MiB cap. Truncation is surfaced via a
 * comment on the entry's `content` block so HAR viewers display it
 * without rejecting the file.
 */

interface HarExportParams {
  action?: 'export_from_active' | 'save_to_downloads';
  tabId?: number;
  windowId?: number;
  filename?: string; // for save_to_downloads
}

interface HarEntry {
  startedDateTime: string;
  time: number;
  request: HarRequest;
  response: HarResponse;
  cache: Record<string, never>;
  timings: HarTimings;
  comment?: string;
}

interface HarRequest {
  method: string;
  url: string;
  httpVersion: string;
  headers: HarHeader[];
  queryString: HarQueryString[];
  cookies: never[];
  headersSize: number;
  bodySize: number;
  postData?: { mimeType: string; text: string };
}

interface HarResponse {
  status: number;
  statusText: string;
  httpVersion: string;
  headers: HarHeader[];
  cookies: never[];
  content: { size: number; mimeType: string; text?: string; encoding?: string; comment?: string };
  redirectURL: string;
  headersSize: number;
  bodySize: number;
}

interface HarHeader {
  name: string;
  value: string;
}

interface HarQueryString {
  name: string;
  value: string;
}

interface HarTimings {
  send: number;
  wait: number;
  receive: number;
  blocked?: number;
}

interface HarLog {
  version: '1.2';
  creator: { name: string; version: string };
  pages?: never[];
  entries: HarEntry[];
  comment?: string;
}

class HarExportTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.HAR_EXPORT;

  async execute(args: HarExportParams = {}): Promise<ToolResult> {
    const action = args.action ?? 'export_from_active';
    if (action !== 'export_from_active' && action !== 'save_to_downloads') {
      return createErrorResponse(
        `Invalid action "${action as string}": expected one of export_from_active|save_to_downloads`,
        ToolErrorCode.INVALID_ARGS,
        { arg: 'action' },
      );
    }

    let tab: chrome.tabs.Tab;
    try {
      tab = await this.getOwnedTab({
        explicit: args.tabId,
        windowId: args.windowId,
        isRead: true,
      });
    } catch (err) {
      return classifyTabError(err, {
        toolName: TOOL_NAMES.BROWSER.HAR_EXPORT,
      });
    }
    const tabId = tab.id!;

    // Pick whichever backend is active for this tab. Debugger wins when
    // both are running (mirrors network-capture.ts's resolution order).
    const entries = collectEntries(tabId);
    const har = buildHar(entries);

    if (action === 'save_to_downloads') {
      return this.saveToDownloads(har, tabId, args.filename);
    }

    const payload = {
      success: true,
      tabId,
      entryCount: har.log.entries.length,
      truncatedEntries: countTruncated(har.log.entries),
      har,
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      isError: false,
    };
  }

  private async saveToDownloads(
    har: { log: HarLog },
    tabId: number,
    filename?: string,
  ): Promise<ToolResult> {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const name = (filename ?? `humanchrome-tab-${tabId}-${ts}.har`).replace(/[^\w.-]/g, '_');
    const json = JSON.stringify(har);
    // chrome.downloads can take a data: URL. Use base64 to survive
    // non-ASCII chars in headers / response bodies cleanly.
    // (UTF-8 → base64 via TextEncoder + btoa-style fallback.)
    const dataUrl = `data:application/json;charset=utf-8;base64,${utf8ToBase64(json)}`;
    try {
      const id = await chrome.downloads.download({
        url: dataUrl,
        filename: name,
        saveAs: false,
        conflictAction: 'uniquify',
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              tabId,
              downloadId: id,
              filename: name,
              entryCount: har.log.entries.length,
              bytes: json.length,
            }),
          },
        ],
        isError: false,
      };
    } catch (err) {
      return createErrorResponse(
        `Failed to save HAR: ${err instanceof Error ? err.message : String(err)}`,
        ToolErrorCode.UNKNOWN,
        { tabId },
      );
    }
  }
}

/**
 * Read whichever capture backend is collecting for this tab. Either
 * backend can be present (or both, or neither); each returns a
 * captureInfo shape with a `requests` map keyed by requestId.
 *
 * Returns a flat array of normalized entries ordered by request start
 * time. Exported as a top-level function so tests can drive the
 * formatter against synthetic inputs.
 */
function collectEntries(tabId: number): NormalizedEntry[] {
  const out: NormalizedEntry[] = [];

  // Debugger backend: per-tab Map<tabId, {requests: Record<requestId, RawRequest>}>.
  const debuggerCapture = getDebuggerCaptureData();
  const debuggerForTab = debuggerCapture?.get(tabId) as
    | { requests?: Record<string, RawRequest> }
    | undefined;
  if (debuggerForTab?.requests) {
    for (const r of Object.values(debuggerForTab.requests)) {
      if (typeof r?.url === 'string') out.push(normalize(r));
    }
  }

  // webRequest backend: per-tab Map keyed by tabId.
  const webCapture = networkCaptureStartTool?.captureData?.get(tabId) as
    | { requests?: Record<string, RawRequest> }
    | undefined;
  if (webCapture?.requests) {
    for (const r of Object.values(webCapture.requests)) {
      if (typeof r?.url === 'string') out.push(normalize(r));
    }
  }

  out.sort((a, b) => a.requestTime - b.requestTime);
  return out;
}

interface RawRequest {
  url: string;
  method?: string;
  type?: string;
  requestTime: number;
  responseTime?: number;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  status?: number;
  statusText?: string;
  responseSize?: number;
  mimeType?: string;
  requestBody?: string;
  responseBody?: string;
}

interface NormalizedEntry {
  url: string;
  method: string;
  requestTime: number;
  responseTime?: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  status: number;
  statusText: string;
  responseSize: number;
  mimeType: string;
  requestBody?: string;
  responseBody?: string;
}

function normalize(r: RawRequest): NormalizedEntry {
  return {
    url: r.url,
    method: (r.method || 'GET').toUpperCase(),
    requestTime: r.requestTime,
    responseTime: r.responseTime,
    requestHeaders: r.requestHeaders ?? {},
    responseHeaders: r.responseHeaders ?? {},
    status: r.status ?? 0,
    statusText: r.statusText ?? '',
    responseSize: r.responseSize ?? 0,
    mimeType: r.mimeType ?? 'application/octet-stream',
    requestBody: r.requestBody,
    responseBody: r.responseBody,
  };
}

function buildHar(entries: NormalizedEntry[]): { log: HarLog } {
  return {
    log: {
      version: '1.2',
      creator: { name: 'humanchrome', version: '1.0' },
      entries: entries.map(toHarEntry),
    },
  };
}

function toHarEntry(e: NormalizedEntry): HarEntry {
  const started = new Date(e.requestTime).toISOString();
  const totalMs = e.responseTime ? Math.max(0, e.responseTime - e.requestTime) : 0;

  const url = parseUrl(e.url);
  const reqHeaders = headersOf(e.requestHeaders);
  const respHeaders = headersOf(e.responseHeaders);

  const content: HarEntry['response']['content'] = {
    size: e.responseSize || 0,
    mimeType: e.mimeType,
  };
  if (e.responseBody !== undefined) {
    const { text, truncated, originalSize } = capBody(e.responseBody);
    content.text = text;
    if (truncated) {
      content.comment = JSON.stringify({
        truncated: true,
        originalSize,
        limit: MAX_RESPONSE_BODY_BYTES,
        unit: 'bytes',
      });
    }
  }

  const request: HarRequest = {
    method: e.method,
    url: e.url,
    httpVersion: 'HTTP/1.1',
    headers: reqHeaders,
    queryString: url.queryString,
    cookies: [],
    headersSize: -1,
    bodySize: e.requestBody ? utf8ByteLength(e.requestBody) : 0,
  };
  if (e.requestBody) {
    request.postData = {
      mimeType: reqHeaders.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? 'text/plain',
      text: capBody(e.requestBody).text,
    };
  }

  const response: HarResponse = {
    status: e.status,
    statusText: e.statusText,
    httpVersion: 'HTTP/1.1',
    headers: respHeaders,
    cookies: [],
    content,
    redirectURL: respHeaders.find((h) => h.name.toLowerCase() === 'location')?.value ?? '',
    headersSize: -1,
    bodySize: e.responseSize || 0,
  };

  return {
    startedDateTime: started,
    time: totalMs,
    request,
    response,
    cache: {},
    timings: {
      // We don't have phase-level timings — collapse into a single wait
      // span. Total `time` is the sum of timings, so put it all in `wait`
      // and zero the rest. send/receive are required by HAR 1.2.
      send: 0,
      wait: totalMs,
      receive: 0,
    },
  };
}

function parseUrl(href: string): { queryString: HarQueryString[] } {
  try {
    const u = new URL(href);
    const queryString: HarQueryString[] = [];
    for (const [name, value] of u.searchParams) queryString.push({ name, value });
    return { queryString };
  } catch {
    return { queryString: [] };
  }
}

function headersOf(rec: Record<string, string>): HarHeader[] {
  return Object.entries(rec).map(([name, value]) => ({ name, value }));
}

function capBody(body: string): { text: string; truncated: boolean; originalSize: number } {
  const size = utf8ByteLength(body);
  if (size <= MAX_RESPONSE_BODY_BYTES) return { text: body, truncated: false, originalSize: size };
  // Slice by chars then re-measure. UTF-8 multi-byte chars at the
  // boundary could push us over; cap conservatively at MAX/1.2 chars
  // then trim until bytes ≤ MAX. The constant factor avoids an O(N)
  // trim loop on worst-case multi-byte content.
  const approx = Math.min(body.length, Math.floor(MAX_RESPONSE_BODY_BYTES / 1.2));
  let text = body.slice(0, approx);
  while (utf8ByteLength(text) > MAX_RESPONSE_BODY_BYTES && text.length > 0) {
    text = text.slice(0, text.length - 256);
  }
  return { text, truncated: true, originalSize: size };
}

function countTruncated(entries: HarEntry[]): number {
  let n = 0;
  for (const e of entries) {
    const comment = e.response.content.comment;
    if (comment && /"truncated"\s*:\s*true/.test(comment)) n += 1;
  }
  return n;
}

/** Test-only: exposed for unit tests of the formatter without driving the live capture buffers. */
export const _buildHarForTests = buildHar;
export const _normalizeForTests = normalize;
export const _capBodyForTests = capBody;

export const harExportTool = new HarExportTool();
