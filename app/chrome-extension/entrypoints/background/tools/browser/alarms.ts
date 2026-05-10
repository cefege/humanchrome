import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { jsonOk } from './_common';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';

type AlarmsAction = 'create' | 'clear' | 'clear_all' | 'get' | 'get_all';

interface AlarmsParams {
  action: AlarmsAction;
  name?: string;
  delayInMinutes?: number;
  periodInMinutes?: number;
  when?: number;
}

function serializeAlarm(a: chrome.alarms.Alarm | null | undefined): Record<string, unknown> | null {
  if (!a) return null;
  return {
    name: a.name,
    scheduledTime: a.scheduledTime,
    periodInMinutes: a.periodInMinutes ?? null,
  };
}

let listenerInstalled = false;
function installFiredListener(): void {
  if (listenerInstalled) return;
  if (typeof chrome.alarms === 'undefined') return;
  chrome.alarms.onAlarm.addListener((alarm) => {
    // Broadcast each fire as a runtime message so flows polling for this
    // event can correlate. Same shape as chrome_context_menu's onClicked
    // bridge.
    chrome.runtime
      .sendMessage({
        target: 'background',
        type: 'alarm_fired',
        name: alarm.name,
        scheduledTime: alarm.scheduledTime,
      })
      .catch(() => {
        // No listener — fine. The bridge connector watches onAlarm directly.
      });
  });
  listenerInstalled = true;
}

class AlarmsTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.ALARMS;
  static readonly mutates = true;

  async execute(args: AlarmsParams): Promise<ToolResult> {
    const action = args?.action;
    if (
      action !== 'create' &&
      action !== 'clear' &&
      action !== 'clear_all' &&
      action !== 'get' &&
      action !== 'get_all'
    ) {
      return createErrorResponse(
        'Parameter [action] is required and must be one of: create, clear, clear_all, get, get_all.',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'action' },
      );
    }
    if (typeof chrome.alarms === 'undefined') {
      return createErrorResponse('chrome.alarms is unavailable.', ToolErrorCode.UNKNOWN);
    }

    installFiredListener();

    try {
      switch (action) {
        case 'create':
          return await this.actionCreate(args);
        case 'clear':
          return await this.actionClear(args);
        case 'clear_all':
          return await this.actionClearAll();
        case 'get':
          return await this.actionGet(args);
        case 'get_all':
          return await this.actionGetAll();
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('Error in AlarmsTool.execute:', error);
      return createErrorResponse(`chrome_alarms failed: ${msg}`, ToolErrorCode.UNKNOWN, { action });
    }
  }

  private async actionCreate(args: AlarmsParams): Promise<ToolResult> {
    if (typeof args.name !== 'string' || args.name.length === 0) {
      return createErrorResponse(
        'Parameter [name] is required for action="create".',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'name' },
      );
    }
    const opts: chrome.alarms.AlarmCreateInfo = {};
    if (typeof args.when === 'number') opts.when = args.when;
    if (typeof args.delayInMinutes === 'number') opts.delayInMinutes = args.delayInMinutes;
    if (typeof args.periodInMinutes === 'number') opts.periodInMinutes = args.periodInMinutes;
    if (typeof opts.when !== 'number' && typeof opts.delayInMinutes !== 'number') {
      return createErrorResponse(
        'action="create" needs at least one of [when], [delayInMinutes].',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'when|delayInMinutes' },
      );
    }
    await chrome.alarms.create(args.name, opts);
    return jsonOk({
      ok: true,
      action: 'create',
      name: args.name,
      when: opts.when ?? null,
      delayInMinutes: opts.delayInMinutes ?? null,
      periodInMinutes: opts.periodInMinutes ?? null,
    });
  }

  private async actionClear(args: AlarmsParams): Promise<ToolResult> {
    if (typeof args.name !== 'string' || args.name.length === 0) {
      return createErrorResponse(
        'Parameter [name] is required for action="clear".',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'name' },
      );
    }
    const cleared = await chrome.alarms.clear(args.name);
    return jsonOk({ ok: true, action: 'clear', name: args.name, cleared });
  }

  private async actionClearAll(): Promise<ToolResult> {
    const cleared = await chrome.alarms.clearAll();
    return jsonOk({ ok: true, action: 'clear_all', cleared });
  }

  private async actionGet(args: AlarmsParams): Promise<ToolResult> {
    if (typeof args.name !== 'string' || args.name.length === 0) {
      return createErrorResponse(
        'Parameter [name] is required for action="get".',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'name' },
      );
    }
    const alarm = await chrome.alarms.get(args.name);
    return jsonOk({ ok: true, action: 'get', alarm: serializeAlarm(alarm) });
  }

  private async actionGetAll(): Promise<ToolResult> {
    const alarms = await chrome.alarms.getAll();
    return jsonOk({
      ok: true,
      action: 'get_all',
      alarms: (alarms ?? []).map(serializeAlarm),
      count: (alarms ?? []).length,
    });
  }
}

export const alarmsTool = new AlarmsTool();

/** Test-only — drop the listener-installed flag. */
export function _resetAlarmsListenerInstalledForTest(): void {
  listenerInstalled = false;
}
