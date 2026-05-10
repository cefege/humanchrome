import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { jsonOk } from './_common';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';

interface ClearBrowsingDataParams {
  dataTypes: string[];
  since?: number;
  origins?: string[];
}

const VALID_DATA_TYPES = [
  'cookies',
  'localStorage',
  'indexedDB',
  'cache',
  'cacheStorage',
  'history',
  'downloads',
  'formData',
  'passwords',
  'serviceWorkers',
  'webSQL',
  'fileSystems',
  'pluginData',
  'appcache',
] as const;

class ClearBrowsingDataTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.CLEAR_BROWSING_DATA;
  static readonly mutates = true;

  async execute(args: ClearBrowsingDataParams): Promise<ToolResult> {
    if (typeof chrome.browsingData === 'undefined') {
      return createErrorResponse(
        'chrome.browsingData is unavailable — the `browsingData` permission is not granted.',
        ToolErrorCode.UNKNOWN,
      );
    }

    const dataTypes = args?.dataTypes;
    if (!Array.isArray(dataTypes) || dataTypes.length === 0) {
      return createErrorResponse(
        'Parameter [dataTypes] is required and must be a non-empty string array.',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'dataTypes' },
      );
    }
    const known = new Set(VALID_DATA_TYPES as unknown as string[]);
    const unknown = dataTypes.filter((t) => !known.has(t));
    if (unknown.length > 0) {
      return createErrorResponse(
        `Parameter [dataTypes] contains unknown value(s): ${unknown.join(', ')}. Valid: ${VALID_DATA_TYPES.join(', ')}.`,
        ToolErrorCode.INVALID_ARGS,
        { arg: 'dataTypes', unknown },
      );
    }

    const since = typeof args.since === 'number' ? args.since : 0;
    const removalOptions: chrome.browsingData.RemovalOptions = { since };
    if (Array.isArray(args.origins) && args.origins.length > 0) {
      removalOptions.origins = args.origins;
    }

    const dataTypeSet: chrome.browsingData.DataTypeSet = {};
    for (const t of dataTypes) {
      (dataTypeSet as Record<string, boolean>)[t] = true;
    }

    try {
      await chrome.browsingData.remove(removalOptions, dataTypeSet);
      return jsonOk({
        ok: true,
        removed: dataTypes,
        since,
        origins: removalOptions.origins ?? null,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('Error in ClearBrowsingDataTool.execute:', error);
      return createErrorResponse(
        `chrome_clear_browsing_data failed: ${msg}`,
        ToolErrorCode.UNKNOWN,
      );
    }
  }
}

export const clearBrowsingDataTool = new ClearBrowsingDataTool();
