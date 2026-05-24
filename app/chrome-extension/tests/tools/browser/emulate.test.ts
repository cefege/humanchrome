/**
 * chrome_emulate tests (IMP-0124).
 *
 * Covers arg validation across actions, preset resolution + explicit-arg
 * override, CDP commands issued for each set_*, reset_all wipes state and
 * tolerates per-command rejections, get_state echoes the per-tab state,
 * CDP_BUSY classification, and tab-close eviction.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendCommandMock = vi.fn();
const withSessionMock = vi.fn(
  async (_tabId: number, _owner: string, fn: () => Promise<unknown>) => fn(),
);

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: {
    sendCommand: (...args: unknown[]) => sendCommandMock(...args),
    withSession: (...args: unknown[]) =>
      withSessionMock(
        args[0] as number,
        args[1] as string,
        args[2] as () => Promise<unknown>,
      ),
  },
}));

import {
  emulateTool,
  _resetEmulateForTests,
} from '@/entrypoints/background/tools/browser/emulate';
import { runWithContext } from '@/entrypoints/background/utils/request-context';
import {
  _resetClientStateForTests,
  claimTabForClient,
} from '@/entrypoints/background/utils/client-state';

const TEST_CLIENT = 'emulate-test-client';
const TAB_ID = 7;

type OnRemovedListener = (tabId: number) => void;
let onRemovedListeners: OnRemovedListener[] = [];

function exec(args: any): Promise<any> {
  return runWithContext({ clientId: TEST_CLIENT }, () => emulateTool.execute(args));
}

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

beforeEach(() => {
  _resetClientStateForTests();
  _resetEmulateForTests();
  onRemovedListeners = [];
  sendCommandMock.mockReset();
  sendCommandMock.mockResolvedValue(undefined);
  withSessionMock.mockClear();

  (globalThis.chrome as any) = {
    storage: { session: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
    tabs: {
      get: vi.fn(async (id: number) => ({ id, windowId: 1 })),
      onRemoved: {
        addListener: (cb: OnRemovedListener) => {
          onRemovedListeners.push(cb);
        },
        removeListener: () => undefined,
      },
    },
    windows: { onRemoved: { addListener: () => undefined } },
    runtime: { lastError: undefined },
  };

  claimTabForClient(TEST_CLIENT, TAB_ID, 1);
});

afterEach(() => {
  _resetClientStateForTests();
  _resetEmulateForTests();
});

describe('chrome_emulate — validation', () => {
  it('rejects missing action', async () => {
    const res = await exec({});
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.details?.arg).toBe('action');
  });

  it('set_device rejects without width+height or preset', async () => {
    const res = await exec({ action: 'set_device' });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.details?.arg).toBe('width|height|preset');
  });

  it('set_device rejects an unknown preset', async () => {
    const res = await exec({ action: 'set_device', preset: 'nokia-3310' });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.details?.arg).toBe('preset');
  });

  it('set_ua rejects missing userAgent', async () => {
    const res = await exec({ action: 'set_ua' });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.details?.arg).toBe('userAgent');
  });

  it('set_geolocation rejects out-of-range latitude', async () => {
    const res = await exec({ action: 'set_geolocation', latitude: 91, longitude: 0 });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.details?.arg).toBe('latitude');
  });

  it('set_color_scheme rejects empty payload', async () => {
    const res = await exec({ action: 'set_color_scheme' });
    expect(res.isError).toBe(true);
  });
});

describe('chrome_emulate — set actions', () => {
  it('set_device with preset issues setDeviceMetricsOverride + setTouchEmulationEnabled', async () => {
    const res = await exec({ action: 'set_device', preset: 'iphone-15' });
    expect(res.isError).toBe(false);
    expect(sendCommandMock).toHaveBeenCalledWith(
      TAB_ID,
      'Emulation.setDeviceMetricsOverride',
      expect.objectContaining({
        width: 393,
        height: 852,
        deviceScaleFactor: 3,
        mobile: true,
      }),
    );
    expect(sendCommandMock).toHaveBeenCalledWith(TAB_ID, 'Emulation.setTouchEmulationEnabled', {
      enabled: true,
    });
    const body = parseBody(res);
    expect(body.device.preset).toBe('iphone-15');
  });

  it('explicit width/height overrides a preset', async () => {
    await exec({
      action: 'set_device',
      preset: 'iphone-15',
      width: 500,
      height: 1000,
    });
    expect(sendCommandMock).toHaveBeenCalledWith(
      TAB_ID,
      'Emulation.setDeviceMetricsOverride',
      expect.objectContaining({ width: 500, height: 1000 }),
    );
  });

  it('set_ua passes acceptLanguage + platform through', async () => {
    await exec({
      action: 'set_ua',
      userAgent: 'Mozilla/5.0 …',
      acceptLanguage: 'en-US',
      platform: 'MacIntel',
    });
    expect(sendCommandMock).toHaveBeenCalledWith(
      TAB_ID,
      'Emulation.setUserAgentOverride',
      expect.objectContaining({
        userAgent: 'Mozilla/5.0 …',
        acceptLanguage: 'en-US',
        platform: 'MacIntel',
      }),
    );
  });

  it('set_timezone sends timezoneId', async () => {
    await exec({ action: 'set_timezone', timezone: 'America/New_York' });
    expect(sendCommandMock).toHaveBeenCalledWith(TAB_ID, 'Emulation.setTimezoneOverride', {
      timezoneId: 'America/New_York',
    });
  });

  it('set_geolocation defaults accuracy to 100', async () => {
    await exec({ action: 'set_geolocation', latitude: 40.7, longitude: -74 });
    expect(sendCommandMock).toHaveBeenCalledWith(
      TAB_ID,
      'Emulation.setGeolocationOverride',
      expect.objectContaining({ latitude: 40.7, longitude: -74, accuracy: 100 }),
    );
  });

  it('set_color_scheme sends Emulation.setEmulatedMedia features', async () => {
    await exec({
      action: 'set_color_scheme',
      colorScheme: 'dark',
      reducedMotion: 'reduce',
    });
    expect(sendCommandMock).toHaveBeenCalledWith(TAB_ID, 'Emulation.setEmulatedMedia', {
      features: [
        { name: 'prefers-color-scheme', value: 'dark' },
        { name: 'prefers-reduced-motion', value: 'reduce' },
      ],
    });
  });
});

describe('chrome_emulate — state + reset', () => {
  it('get_state echoes accumulated overrides', async () => {
    await exec({ action: 'set_locale', locale: 'fr-FR' });
    await exec({ action: 'set_timezone', timezone: 'Europe/Paris' });
    const res = await exec({ action: 'get_state' });
    const body = parseBody(res);
    expect(body.state.locale).toBe('fr-FR');
    expect(body.state.timezone).toBe('Europe/Paris');
  });

  it('reset_all wipes per-tab state and issues all clears (best-effort)', async () => {
    await exec({ action: 'set_locale', locale: 'fr-FR' });
    sendCommandMock.mockClear();
    // Make one of the clears reject to confirm reset_all tolerates it.
    sendCommandMock.mockRejectedValueOnce(new Error('Emulation.clearGeolocationOverride failed'));

    const res = await exec({ action: 'reset_all' });
    expect(parseBody(res).cleared).toBe(true);

    const after = parseBody(await exec({ action: 'get_state' }));
    expect(after.state).toEqual({});
  });
});

describe('chrome_emulate — error classification + cleanup', () => {
  it('classifies "another debugger" as CDP_BUSY', async () => {
    sendCommandMock.mockRejectedValueOnce(new Error('Another debugger is already attached'));
    const res = await exec({ action: 'set_locale', locale: 'en-US' });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.code).toBe('CDP_BUSY');
  });

  it('chrome.tabs.onRemoved evicts the per-tab state', async () => {
    await exec({ action: 'set_locale', locale: 'de-DE' });
    expect(parseBody(await exec({ action: 'get_state' })).state.locale).toBe('de-DE');

    expect(onRemovedListeners.length).toBeGreaterThan(0);
    for (const cb of onRemovedListeners) cb(TAB_ID);

    expect(parseBody(await exec({ action: 'get_state' })).state).toEqual({});
  });
});
