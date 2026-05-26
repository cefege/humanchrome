import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolError, ToolErrorCode, invalidArgsEnumDetails } from 'humanchrome-shared';

const EMULATE_ACTIONS = [
  'set_device',
  'set_ua',
  'set_locale',
  'set_timezone',
  'set_geolocation',
  'set_color_scheme',
  'reset_all',
  'get_state',
] as const;
import { cdpSessionManager } from '@/utils/cdp-session-manager';

/**
 * chrome_emulate — IMP-0124.
 *
 * Multi-action wrapper for CDP `Emulation.*` overrides. Per-tab,
 * persistent across navigations until reset_all or tab close.
 *
 * Why this matters: anti-bot platforms cross-check timezone, locale,
 * UA, viewport vs the source IP. Mobile-only flows (Instagram DMs,
 * WhatsApp Web mobile UI) require device emulation. Today the only
 * emulation surface is `chrome_network_emulate` (throughput/latency)
 * and `chrome_proxy` (IP) — no primitive for UA, timezone,
 * geolocation, locale, color-scheme, viewport. Pairs naturally with
 * `chrome_proxy`: agent sets timezone + locale + geolocation to match
 * the proxy region in one tool call instead of injecting JS that
 * doesn't survive navigation.
 *
 * Actions:
 *   - set_device({width, height, deviceScaleFactor?, mobile?, hasTouch?, preset?})
 *   - set_ua({userAgent, acceptLanguage?, platform?})
 *   - set_locale({locale})            — BCP 47 tag, e.g. "en-US"
 *   - set_timezone({timezone})        — IANA name, e.g. "America/New_York"
 *   - set_geolocation({latitude, longitude, accuracy?})
 *   - set_color_scheme({colorScheme?, reducedMotion?})
 *   - reset_all({tabId})              — clear every override, drop the entry
 *   - get_state({tabId})              — return what's currently set on the tab
 *
 * Presets (set_device): 'iphone-15', 'iphone-15-pro-max', 'pixel-7',
 * 'pixel-7-pro', 'ipad-mini', 'desktop'. Caller can still pass
 * width/height/dsf/mobile/touch explicitly to override the preset.
 */

type Action =
  | 'set_device'
  | 'set_ua'
  | 'set_locale'
  | 'set_timezone'
  | 'set_geolocation'
  | 'set_color_scheme'
  | 'reset_all'
  | 'get_state';

interface EmulateParams {
  action?: Action;
  tabId?: number;
  // set_device
  preset?: string;
  width?: number;
  height?: number;
  deviceScaleFactor?: number;
  mobile?: boolean;
  hasTouch?: boolean;
  // set_ua
  userAgent?: string;
  acceptLanguage?: string;
  platform?: string;
  // set_locale
  locale?: string;
  // set_timezone
  timezone?: string;
  // set_geolocation
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  // set_color_scheme
  colorScheme?: 'light' | 'dark' | 'no-preference';
  reducedMotion?: 'reduce' | 'no-preference';
}

interface TabEmulationState {
  device?: {
    width: number;
    height: number;
    deviceScaleFactor: number;
    mobile: boolean;
    hasTouch: boolean;
    preset?: string;
  };
  ua?: { userAgent: string; acceptLanguage?: string; platform?: string };
  locale?: string;
  timezone?: string;
  geolocation?: { latitude: number; longitude: number; accuracy: number };
  colorScheme?: 'light' | 'dark' | 'no-preference';
  reducedMotion?: 'reduce' | 'no-preference';
}

const OWNER = 'emulate' as const;

const TAB_STATE = new Map<number, TabEmulationState>();

let tabRemovedListenerInstalled = false;
function installTabRemovedListenerOnce(): void {
  if (tabRemovedListenerInstalled) return;
  if (typeof chrome === 'undefined' || !chrome.tabs?.onRemoved?.addListener) return;
  chrome.tabs.onRemoved.addListener((tabId) => {
    TAB_STATE.delete(tabId);
  });
  tabRemovedListenerInstalled = true;
}

/** Test-only: clear per-tab state + re-arm the onRemoved listener install flag. */
export function _resetEmulateForTests(): void {
  TAB_STATE.clear();
  tabRemovedListenerInstalled = false;
}

interface DevicePreset {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  hasTouch: boolean;
}

const PRESETS: Readonly<Record<string, DevicePreset>> = {
  'iphone-15': { width: 393, height: 852, deviceScaleFactor: 3, mobile: true, hasTouch: true },
  'iphone-15-pro-max': {
    width: 430,
    height: 932,
    deviceScaleFactor: 3,
    mobile: true,
    hasTouch: true,
  },
  'pixel-7': { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true, hasTouch: true },
  'pixel-7-pro': {
    width: 412,
    height: 892,
    deviceScaleFactor: 3.5,
    mobile: true,
    hasTouch: true,
  },
  'ipad-mini': { width: 768, height: 1024, deviceScaleFactor: 2, mobile: true, hasTouch: true },
  desktop: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false, hasTouch: false },
};

class EmulateTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.EMULATE;
  static readonly mutates = true;

  async execute(args: EmulateParams = {}): Promise<ToolResult> {
    const action = args.action;
    if (!action || !EMULATE_ACTIONS.includes(action)) {
      return createErrorResponse(
        'action is required (one of: set_device, set_ua, set_locale, set_timezone, set_geolocation, set_color_scheme, reset_all, get_state)',
        ToolErrorCode.INVALID_ARGS,
        invalidArgsEnumDetails('action', action, EMULATE_ACTIONS),
      );
    }

    installTabRemovedListenerOnce();

    let tab: chrome.tabs.Tab;
    try {
      tab = await this.getOwnedTab({ explicit: args.tabId });
    } catch (e) {
      if (e instanceof ToolError) {
        return createErrorResponse(e.message, e.code, e.details);
      }
      return createErrorResponse(
        e instanceof Error ? e.message : String(e),
        ToolErrorCode.TAB_NOT_FOUND,
      );
    }
    const tabId = tab.id!;
    const state = TAB_STATE.get(tabId) ?? {};

    try {
      switch (action) {
        case 'get_state':
          return this.ok({ tabId, state });

        case 'set_device': {
          const device = resolveDevice(args);
          if ('error' in device) {
            return createErrorResponse(device.error, ToolErrorCode.INVALID_ARGS, {
              arg: device.arg,
            });
          }
          await cdpSessionManager.withSession(tabId, OWNER, async () => {
            await cdpSessionManager.sendCommand(tabId, 'Emulation.setDeviceMetricsOverride', {
              width: device.width,
              height: device.height,
              deviceScaleFactor: device.deviceScaleFactor,
              mobile: device.mobile,
            });
            await cdpSessionManager.sendCommand(tabId, 'Emulation.setTouchEmulationEnabled', {
              enabled: device.hasTouch,
            });
          });
          state.device = device;
          TAB_STATE.set(tabId, state);
          return this.ok({ tabId, device });
        }

        case 'set_ua': {
          if (typeof args.userAgent !== 'string' || args.userAgent.length === 0) {
            return createErrorResponse(
              'userAgent is required (non-empty string)',
              ToolErrorCode.INVALID_ARGS,
              { arg: 'userAgent' },
            );
          }
          const params: Record<string, unknown> = { userAgent: args.userAgent };
          if (args.acceptLanguage) params.acceptLanguage = args.acceptLanguage;
          if (args.platform) params.platform = args.platform;
          await cdpSessionManager.withSession(tabId, OWNER, async () => {
            await cdpSessionManager.sendCommand(tabId, 'Emulation.setUserAgentOverride', params);
          });
          state.ua = {
            userAgent: args.userAgent,
            acceptLanguage: args.acceptLanguage,
            platform: args.platform,
          };
          TAB_STATE.set(tabId, state);
          return this.ok({ tabId, ua: state.ua });
        }

        case 'set_locale': {
          if (typeof args.locale !== 'string' || args.locale.length === 0) {
            return createErrorResponse(
              'locale is required (BCP 47 tag, e.g. "en-US")',
              ToolErrorCode.INVALID_ARGS,
              { arg: 'locale' },
            );
          }
          await cdpSessionManager.withSession(tabId, OWNER, async () => {
            await cdpSessionManager.sendCommand(tabId, 'Emulation.setLocaleOverride', {
              locale: args.locale,
            });
          });
          state.locale = args.locale;
          TAB_STATE.set(tabId, state);
          return this.ok({ tabId, locale: args.locale });
        }

        case 'set_timezone': {
          if (typeof args.timezone !== 'string' || args.timezone.length === 0) {
            return createErrorResponse(
              'timezone is required (IANA name, e.g. "America/New_York")',
              ToolErrorCode.INVALID_ARGS,
              { arg: 'timezone' },
            );
          }
          await cdpSessionManager.withSession(tabId, OWNER, async () => {
            await cdpSessionManager.sendCommand(tabId, 'Emulation.setTimezoneOverride', {
              timezoneId: args.timezone,
            });
          });
          state.timezone = args.timezone;
          TAB_STATE.set(tabId, state);
          return this.ok({ tabId, timezone: args.timezone });
        }

        case 'set_geolocation': {
          if (
            typeof args.latitude !== 'number' ||
            typeof args.longitude !== 'number' ||
            !Number.isFinite(args.latitude) ||
            !Number.isFinite(args.longitude)
          ) {
            return createErrorResponse(
              'latitude and longitude are required (finite numbers)',
              ToolErrorCode.INVALID_ARGS,
              { arg: 'latitude|longitude' },
            );
          }
          if (args.latitude < -90 || args.latitude > 90) {
            return createErrorResponse(
              'latitude must be in [-90, 90]',
              ToolErrorCode.INVALID_ARGS,
              { arg: 'latitude' },
            );
          }
          if (args.longitude < -180 || args.longitude > 180) {
            return createErrorResponse(
              'longitude must be in [-180, 180]',
              ToolErrorCode.INVALID_ARGS,
              { arg: 'longitude' },
            );
          }
          const accuracy =
            typeof args.accuracy === 'number' && Number.isFinite(args.accuracy) && args.accuracy >= 0
              ? args.accuracy
              : 100;
          await cdpSessionManager.withSession(tabId, OWNER, async () => {
            await cdpSessionManager.sendCommand(tabId, 'Emulation.setGeolocationOverride', {
              latitude: args.latitude,
              longitude: args.longitude,
              accuracy,
            });
          });
          state.geolocation = { latitude: args.latitude!, longitude: args.longitude!, accuracy };
          TAB_STATE.set(tabId, state);
          return this.ok({ tabId, geolocation: state.geolocation });
        }

        case 'set_color_scheme': {
          const features: Array<{ name: string; value: string }> = [];
          if (args.colorScheme) {
            if (!['light', 'dark', 'no-preference'].includes(args.colorScheme)) {
              return createErrorResponse(
                `colorScheme must be one of: light, dark, no-preference`,
                ToolErrorCode.INVALID_ARGS,
                { arg: 'colorScheme' },
              );
            }
            features.push({ name: 'prefers-color-scheme', value: args.colorScheme });
            state.colorScheme = args.colorScheme;
          }
          if (args.reducedMotion) {
            if (!['reduce', 'no-preference'].includes(args.reducedMotion)) {
              return createErrorResponse(
                `reducedMotion must be one of: reduce, no-preference`,
                ToolErrorCode.INVALID_ARGS,
                { arg: 'reducedMotion' },
              );
            }
            features.push({ name: 'prefers-reduced-motion', value: args.reducedMotion });
            state.reducedMotion = args.reducedMotion;
          }
          if (features.length === 0) {
            return createErrorResponse(
              'set_color_scheme requires at least one of: colorScheme, reducedMotion',
              ToolErrorCode.INVALID_ARGS,
              { arg: 'colorScheme|reducedMotion' },
            );
          }
          await cdpSessionManager.withSession(tabId, OWNER, async () => {
            await cdpSessionManager.sendCommand(tabId, 'Emulation.setEmulatedMedia', {
              features,
            });
          });
          TAB_STATE.set(tabId, state);
          return this.ok({
            tabId,
            colorScheme: state.colorScheme,
            reducedMotion: state.reducedMotion,
          });
        }

        case 'reset_all': {
          // Best-effort: send the clears we know about; ignore individual
          // command rejections (the override may not have been set in the
          // first place) but surface a transport-level failure. The 7 calls
          // are independent — run them in parallel so reset_all costs one
          // RTT instead of seven.
          await cdpSessionManager.withSession(tabId, OWNER, async () => {
            const safe = async (method: string, params?: object) => {
              try {
                await cdpSessionManager.sendCommand(tabId, method, params ?? {});
              } catch {
                /* ignore — override may not have been set */
              }
            };
            await Promise.all([
              safe('Emulation.clearDeviceMetricsOverride'),
              safe('Emulation.setTouchEmulationEnabled', { enabled: false }),
              safe('Emulation.setUserAgentOverride', { userAgent: '' }),
              safe('Emulation.setLocaleOverride', {}),
              safe('Emulation.setTimezoneOverride', { timezoneId: '' }),
              safe('Emulation.clearGeolocationOverride'),
              safe('Emulation.setEmulatedMedia', { features: [] }),
            ]);
          });
          TAB_STATE.delete(tabId);
          return this.ok({ tabId, cleared: true });
        }

        default:
          return createErrorResponse(
            `Unknown action "${action as string}"`,
            ToolErrorCode.INVALID_ARGS,
            { arg: 'action' },
          );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/another debugger|already attached/i.test(msg)) {
        return createErrorResponse(msg, ToolErrorCode.CDP_BUSY, { tabId });
      }
      return createErrorResponse(`chrome_emulate(${action}) failed: ${msg}`, ToolErrorCode.UNKNOWN, {
        tabId,
        action,
      });
    }
  }

  private ok(payload: Record<string, unknown>): ToolResult {
    return {
      content: [{ type: 'text', text: JSON.stringify({ success: true, ...payload }) }],
      isError: false,
    };
  }
}

function resolveDevice(
  args: EmulateParams,
):
  | { width: number; height: number; deviceScaleFactor: number; mobile: boolean; hasTouch: boolean; preset?: string }
  | { error: string; arg: string } {
  let base: Partial<DevicePreset> & { preset?: string } = {};
  if (args.preset) {
    const p = PRESETS[args.preset];
    if (!p) {
      return {
        error: `Unknown preset "${args.preset}". Known: ${Object.keys(PRESETS).join(', ')}`,
        arg: 'preset',
      };
    }
    base = { ...p, preset: args.preset };
  }
  const width = args.width ?? base.width;
  const height = args.height ?? base.height;
  const deviceScaleFactor = args.deviceScaleFactor ?? base.deviceScaleFactor ?? 1;
  const mobile = args.mobile ?? base.mobile ?? false;
  const hasTouch = args.hasTouch ?? base.hasTouch ?? false;
  if (typeof width !== 'number' || typeof height !== 'number' || width <= 0 || height <= 0) {
    return {
      error: 'set_device requires width+height (positive numbers) or a known preset',
      arg: 'width|height|preset',
    };
  }
  return { width, height, deviceScaleFactor, mobile, hasTouch, preset: base.preset };
}

export const emulateTool = new EmulateTool();
