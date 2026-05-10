import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { jsonOk } from './_common';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';
import { sendNativeRequest } from '@/entrypoints/background/native-host';

interface PrintToPdfParams {
  tabId?: number;
  windowId?: number;
  savePath?: string;
  landscape?: boolean;
  printBackground?: boolean;
  scale?: number;
  paperWidthIn?: number;
  paperHeightIn?: number;
  marginTopIn?: number;
  marginRightIn?: number;
  marginBottomIn?: number;
  marginLeftIn?: number;
  pageRanges?: string;
}

interface PrintToPdfCdpResult {
  data: string;
}

interface BridgeFileResp {
  success: boolean;
  filePath?: string;
  bytes?: number;
  error?: string;
  message?: string;
}

async function attachDebuggerOnce(tabId: number): Promise<boolean> {
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/already attached/i.test(msg)) return false;
    throw err;
  }
}

async function detachDebuggerSafe(tabId: number): Promise<void> {
  try {
    await chrome.debugger.detach({ tabId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/not attached/i.test(msg)) throw err;
  }
}

class PrintToPdfTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.PRINT_TO_PDF;
  static readonly mutates = false;

  async execute(args: PrintToPdfParams = {}): Promise<ToolResult> {
    if (typeof chrome.debugger === 'undefined') {
      return createErrorResponse('chrome.debugger is unavailable.', ToolErrorCode.UNKNOWN);
    }

    let tabId = typeof args.tabId === 'number' ? args.tabId : undefined;
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

    let weAttached = false;
    try {
      weAttached = await attachDebuggerOnce(tabId);
      const result = (await chrome.debugger.sendCommand({ tabId }, 'Page.printToPDF', {
        landscape: !!args.landscape,
        printBackground: args.printBackground !== false,
        scale: typeof args.scale === 'number' ? args.scale : 1,
        paperWidth: typeof args.paperWidthIn === 'number' ? args.paperWidthIn : 8.5,
        paperHeight: typeof args.paperHeightIn === 'number' ? args.paperHeightIn : 11,
        marginTop: typeof args.marginTopIn === 'number' ? args.marginTopIn : 0.4,
        marginBottom: typeof args.marginBottomIn === 'number' ? args.marginBottomIn : 0.4,
        marginLeft: typeof args.marginLeftIn === 'number' ? args.marginLeftIn : 0.4,
        marginRight: typeof args.marginRightIn === 'number' ? args.marginRightIn : 0.4,
        pageRanges: typeof args.pageRanges === 'string' ? args.pageRanges : '',
        transferMode: 'ReturnAsBase64',
      })) as PrintToPdfCdpResult | undefined;

      if (!result?.data) {
        return createErrorResponse('Page.printToPDF returned no data', ToolErrorCode.UNKNOWN, {
          tabId,
        });
      }

      // Optional bridge save. When savePath is supplied use saveToPath (arbitrary
      // filesystem path); otherwise fall through to base64 in the response.
      if (typeof args.savePath === 'string' && args.savePath.length > 0) {
        try {
          const resp = await sendNativeRequest<BridgeFileResp>(
            'file_operation',
            { action: 'saveToPath', destPath: args.savePath, base64Data: result.data },
            30_000,
          );
          if (!resp || resp.success !== true) {
            return createErrorResponse(
              `Bridge saveToPath failed: ${resp?.error ?? resp?.message ?? 'unknown'}`,
              ToolErrorCode.UNKNOWN,
              { tabId, savePath: args.savePath },
            );
          }
          return jsonOk({
            ok: true,
            tabId,
            path: resp.filePath ?? args.savePath,
            bytes: resp.bytes ?? null,
          });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return createErrorResponse(`Bridge saveToPath failed: ${msg}`, ToolErrorCode.UNKNOWN, {
            tabId,
            savePath: args.savePath,
          });
        }
      }

      return jsonOk({
        ok: true,
        tabId,
        base64: result.data,
        bytes: Math.floor((result.data.length * 3) / 4),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/no tab with id|target closed|cannot access/i.test(msg)) {
        return createErrorResponse(`Tab ${tabId} not found`, ToolErrorCode.TAB_CLOSED, { tabId });
      }
      console.error('Error in PrintToPdfTool.execute:', error);
      return createErrorResponse(`chrome_print_to_pdf failed: ${msg}`, ToolErrorCode.UNKNOWN, {
        tabId,
      });
    } finally {
      if (weAttached) {
        try {
          await detachDebuggerSafe(tabId);
        } catch {
          // already detached
        }
      }
    }
  }
}

export const printToPdfTool = new PrintToPdfTool();
