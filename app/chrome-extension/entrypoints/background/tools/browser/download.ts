import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { jsonOk } from './_common';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';
import { DEFAULT_HANDLE_DOWNLOAD_TIMEOUT_MS, MAX_TOOL_TIMEOUT_MS } from '../../utils/timeouts';

interface HandleDownloadParams {
  filenameContains?: string;
  timeoutMs?: number; // default 60000
  waitForComplete?: boolean; // default true
  /**
   * Optional source-tab filter. chrome.downloads events surface a `tabId`
   * field for downloads kicked off by user navigation; when provided, only
   * downloads from this tab are matched. Filter is best-effort — programmatic
   * downloads (a.click() on detached anchor, fetch+blob) often surface
   * tabId=undefined and are matched regardless.
   */
  tabId?: number;
}

/**
 * Tool: wait for a download and return info
 */
class HandleDownloadTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.HANDLE_DOWNLOAD;

  async execute(args: HandleDownloadParams): Promise<ToolResult> {
    const filenameContains = String(args?.filenameContains || '').trim();
    const waitForComplete = args?.waitForComplete !== false;
    const timeoutMs = Math.max(
      1000,
      Math.min(Number(args?.timeoutMs ?? DEFAULT_HANDLE_DOWNLOAD_TIMEOUT_MS), MAX_TOOL_TIMEOUT_MS),
    );
    const tabId = typeof args?.tabId === 'number' ? args.tabId : undefined;

    try {
      const result = await waitForDownload({ filenameContains, waitForComplete, timeoutMs, tabId });
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, download: result }) }],
        isError: false,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return createErrorResponse(`Handle download failed: ${msg}`);
    }
  }
}

interface DownloadInfo {
  id: number;
  filename: string;
  url: string;
  state: chrome.downloads.DownloadItem['state'];
  mime?: string;
  fileSize?: number;
  danger?: chrome.downloads.DownloadItem['danger'];
  startTime?: string;
  endTime?: string;
  exists?: boolean;
}

async function waitForDownload(opts: {
  filenameContains?: string;
  waitForComplete: boolean;
  timeoutMs: number;
  tabId?: number;
}) {
  const { filenameContains, waitForComplete, timeoutMs, tabId } = opts;
  return new Promise<DownloadInfo>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onError = (err: unknown) => {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const cleanup = () => {
      try {
        if (timer) clearTimeout(timer);
      } catch {}
      try {
        chrome.downloads.onCreated.removeListener(onCreated);
      } catch {}
      try {
        chrome.downloads.onChanged.removeListener(onChanged);
      } catch {}
    };
    const matches = (item: chrome.downloads.DownloadItem) => {
      // tabId on DownloadItem is non-standard but Chrome surfaces it on
      // user-initiated downloads. When defined and non-matching, skip;
      // undefined (programmatic blob downloads) falls through unfiltered.
      if (tabId !== undefined) {
        const itemTabId = (item as unknown as { tabId?: number }).tabId;
        if (typeof itemTabId === 'number' && itemTabId !== tabId) return false;
      }
      if (!filenameContains) return true;
      const name = (item.filename || '').split(/[/\\]/).pop() || '';
      return name.includes(filenameContains) || (item.url || '').includes(filenameContains);
    };
    const fulfill = async (item: chrome.downloads.DownloadItem) => {
      // try to fill more details via downloads.search
      try {
        const [found] = await chrome.downloads.search({ id: item.id });
        const out = found || item;
        cleanup();
        resolve({
          id: out.id,
          filename: out.filename,
          url: out.url,
          mime: out.mime || undefined,
          fileSize: out.fileSize ?? out.totalBytes ?? undefined,
          state: out.state,
          danger: out.danger,
          startTime: out.startTime,
          endTime: out.endTime || undefined,
          exists: out.exists,
        });
        return;
      } catch {
        cleanup();
        resolve({ id: item.id, filename: item.filename, url: item.url, state: item.state });
      }
    };
    const onCreated = (item: chrome.downloads.DownloadItem) => {
      try {
        if (!matches(item)) return;
        if (!waitForComplete) {
          fulfill(item);
        }
      } catch {}
    };
    const onChanged = (delta: chrome.downloads.DownloadDelta) => {
      try {
        if (!delta || typeof delta.id !== 'number') return;
        // pull item and check
        chrome.downloads
          .search({ id: delta.id })
          .then((arr) => {
            const item = arr && arr[0];
            if (!item) return;
            if (!matches(item)) return;
            if (waitForComplete && item.state === 'complete') fulfill(item);
          })
          .catch(() => {});
      } catch {}
    };
    chrome.downloads.onCreated.addListener(onCreated);
    chrome.downloads.onChanged.addListener(onChanged);
    timer = setTimeout(() => onError(new Error('Download wait timed out')), timeoutMs);
    // Try to find an already-running matching download
    chrome.downloads
      .search({ state: waitForComplete ? 'in_progress' : undefined })
      .then((arr) => {
        const hit = (arr || []).find((d) => matches(d));
        if (hit && !waitForComplete) fulfill(hit);
      })
      .catch(() => {});
  });
}

export const handleDownloadTool = new HandleDownloadTool();

export interface DownloadListParams {
  state?: chrome.downloads.DownloadQuery['state'] | 'all';
  filenameContains?: string;
  limit?: number;
}

class DownloadListTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.DOWNLOAD_LIST;

  async execute(args: DownloadListParams = {}): Promise<ToolResult> {
    if (!chrome.downloads?.search) {
      return createErrorResponse(
        'chrome.downloads.search is unavailable. The "downloads" permission is required.',
        ToolErrorCode.UNKNOWN,
      );
    }

    const state = args.state ?? 'all';
    const needle = (args.filenameContains ?? '').toLowerCase();
    const limit = Math.max(1, Math.min(typeof args.limit === 'number' ? args.limit : 25, 100));

    try {
      const query: chrome.downloads.DownloadQuery = {};
      if (state !== 'all') query.state = state;
      const results = await chrome.downloads.search(query);
      // Filter on the basename only — full path is OS-dependent and tends to
      // false-positive against the user's home dir.
      const filtered = needle
        ? results.filter((d) => basename(d.filename).toLowerCase().includes(needle))
        : results;
      const items = filtered.slice(0, limit).map((d) => ({
        id: d.id,
        url: d.url,
        filename: d.filename,
        state: d.state,
        totalBytes: d.totalBytes,
        bytesReceived: d.bytesReceived,
        startTime: d.startTime,
        endTime: d.endTime,
        mime: d.mime,
        error: d.error,
      }));
      return jsonOk({ count: items.length, items });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return createErrorResponse(`chrome_download_list failed: ${msg}`, ToolErrorCode.UNKNOWN);
    }
  }
}

export interface DownloadCancelParams {
  downloadId?: number;
}

class DownloadCancelTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.DOWNLOAD_CANCEL;
  static readonly mutates = true;

  async execute(args: DownloadCancelParams = {}): Promise<ToolResult> {
    if (typeof args.downloadId !== 'number') {
      return createErrorResponse('`downloadId` (number) is required.', ToolErrorCode.INVALID_ARGS, {
        arg: 'downloadId',
      });
    }
    if (!chrome.downloads?.cancel) {
      return createErrorResponse(
        'chrome.downloads.cancel is unavailable. The "downloads" permission is required.',
        ToolErrorCode.UNKNOWN,
      );
    }
    const downloadId = args.downloadId;
    try {
      await chrome.downloads.cancel(downloadId);
      // Best-effort post-state read so callers can distinguish a real cancel
      // from a no-op against an already-finished download.
      const postState = await chrome.downloads
        .search({ id: downloadId })
        .then((after) => after?.[0]?.state ?? 'unknown')
        .catch(() => 'unknown' as const);
      return jsonOk({ cancelled: true, downloadId, postState });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return createErrorResponse(`chrome_download_cancel failed: ${msg}`, ToolErrorCode.UNKNOWN, {
        downloadId,
      });
    }
  }
}

function basename(path: string | undefined): string {
  return (path ?? '').split(/[/\\]/).pop() ?? '';
}

export const downloadListTool = new DownloadListTool();
export const downloadCancelTool = new DownloadCancelTool();
