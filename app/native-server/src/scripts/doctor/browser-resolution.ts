/**
 * Resolve which browsers the doctor checks should target.
 */

import { BrowserType, detectInstalledBrowsers, parseBrowserType } from '../browser-config';

export function resolveTargetBrowsers(browserArg: string | undefined): BrowserType[] | undefined {
  if (!browserArg) return undefined;
  const normalized = browserArg.toLowerCase();
  if (normalized === 'all') return [BrowserType.CHROME, BrowserType.CHROMIUM];
  if (normalized === 'detect' || normalized === 'auto') return undefined;
  const parsed = parseBrowserType(normalized);
  if (!parsed) {
    throw new Error(`Invalid browser: ${browserArg}. Use 'chrome', 'chromium', or 'all'`);
  }
  return [parsed];
}

export function resolveBrowsersToCheck(requested: BrowserType[] | undefined): BrowserType[] {
  if (requested && requested.length > 0) return requested;
  const detected = detectInstalledBrowsers();
  if (detected.length > 0) return detected;
  return [BrowserType.CHROME, BrowserType.CHROMIUM];
}
