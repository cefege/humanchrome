/**
 * chrome_alarms tests.
 *
 * Wraps chrome.alarms.{create,clear,clearAll,get,getAll}. Each fire is
 * broadcast via chrome.runtime.sendMessage as `alarm_fired`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  alarmsTool,
  _resetAlarmsListenerInstalledForTest,
} from '@/entrypoints/background/tools/browser/alarms';

let createMock: ReturnType<typeof vi.fn>;
let clearMock: ReturnType<typeof vi.fn>;
let clearAllMock: ReturnType<typeof vi.fn>;
let getMock: ReturnType<typeof vi.fn>;
let getAllMock: ReturnType<typeof vi.fn>;
let onAlarmAddListener: ReturnType<typeof vi.fn>;

beforeEach(() => {
  _resetAlarmsListenerInstalledForTest();
  createMock = vi.fn().mockResolvedValue(undefined);
  clearMock = vi.fn().mockResolvedValue(true);
  clearAllMock = vi.fn().mockResolvedValue(true);
  getMock = vi.fn().mockResolvedValue({
    name: 'a1',
    scheduledTime: 1700000000,
    periodInMinutes: 5,
  });
  getAllMock = vi.fn().mockResolvedValue([
    { name: 'a1', scheduledTime: 1700000000 },
    { name: 'a2', scheduledTime: 1700000060000, periodInMinutes: 10 },
  ]);
  onAlarmAddListener = vi.fn();
  (globalThis.chrome as any).alarms = {
    create: createMock,
    clear: clearMock,
    clearAll: clearAllMock,
    get: getMock,
    getAll: getAllMock,
    onAlarm: { addListener: onAlarmAddListener },
  };
  (globalThis.chrome as any).runtime = {
    ...(globalThis.chrome as any).runtime,
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };
});

afterEach(() => {
  delete (globalThis.chrome as any).alarms;
});

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

describe('chrome_alarms', () => {
  it('rejects unknown action', async () => {
    const res = await alarmsTool.execute({} as any);
    expect(res.isError).toBe(true);
  });

  it('errors when chrome.alarms is undefined', async () => {
    delete (globalThis.chrome as any).alarms;
    const res = await alarmsTool.execute({ action: 'get_all' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('chrome.alarms is unavailable');
  });

  it('install the onAlarm listener exactly once across multiple calls', async () => {
    await alarmsTool.execute({ action: 'get_all' });
    await alarmsTool.execute({ action: 'get_all' });
    await alarmsTool.execute({ action: 'get_all' });
    expect(onAlarmAddListener).toHaveBeenCalledTimes(1);
  });

  it('create requires name', async () => {
    const res = await alarmsTool.execute({ action: 'create', delayInMinutes: 1 });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('name');
  });

  it('create requires when or delayInMinutes', async () => {
    const res = await alarmsTool.execute({ action: 'create', name: 'a' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('when|delayInMinutes');
  });

  it('create forwards delayInMinutes + periodInMinutes', async () => {
    await alarmsTool.execute({
      action: 'create',
      name: 'tick',
      delayInMinutes: 2,
      periodInMinutes: 5,
    });
    expect(createMock).toHaveBeenCalledWith('tick', { delayInMinutes: 2, periodInMinutes: 5 });
  });

  it('create forwards `when` for absolute scheduling', async () => {
    await alarmsTool.execute({ action: 'create', name: 'cron', when: 1700000000 });
    expect(createMock).toHaveBeenCalledWith('cron', { when: 1700000000 });
  });

  it('clear requires name', async () => {
    const res = await alarmsTool.execute({ action: 'clear' });
    expect(res.isError).toBe(true);
  });

  it('clear forwards the name and reports cleared', async () => {
    const body = parseBody(await alarmsTool.execute({ action: 'clear', name: 'a1' }));
    expect(clearMock).toHaveBeenCalledWith('a1');
    expect(body.cleared).toBe(true);
  });

  it('clear_all calls chrome.alarms.clearAll', async () => {
    await alarmsTool.execute({ action: 'clear_all' });
    expect(clearAllMock).toHaveBeenCalled();
  });

  it('get requires name', async () => {
    const res = await alarmsTool.execute({ action: 'get' });
    expect(res.isError).toBe(true);
  });

  it('get returns the serialized alarm', async () => {
    const body = parseBody(await alarmsTool.execute({ action: 'get', name: 'a1' }));
    expect(body.alarm.name).toBe('a1');
    expect(body.alarm.periodInMinutes).toBe(5);
  });

  it('get returns null when the alarm does not exist', async () => {
    getMock.mockResolvedValueOnce(undefined);
    const body = parseBody(await alarmsTool.execute({ action: 'get', name: 'missing' }));
    expect(body.alarm).toBeNull();
  });

  it('get_all returns the count and serialized list', async () => {
    const body = parseBody(await alarmsTool.execute({ action: 'get_all' }));
    expect(body.count).toBe(2);
    expect(body.alarms[1].periodInMinutes).toBe(10);
    expect(body.alarms[0].periodInMinutes).toBeNull();
  });
});
