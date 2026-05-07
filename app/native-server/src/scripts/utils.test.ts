/**
 * Regression test for the macOS Tahoe TCC guard added to `getMainPath()`.
 *
 * Background: Chrome with Full Disk Access can READ files in TCC-protected
 * directories like `~/Documents` but cannot EXEC scripts located inside them.
 * `chrome.runtime.connectNative()` succeeds, the host process spawn silently
 * fails with "Operation not permitted", and the user only sees the generic
 * `lastError: "Native host has exited."`.
 *
 * `tccProtectedRootContaining()` flags such paths so `getMainPath()` can
 * refuse registration with a helpful relocation message instead of writing
 * a manifest that will fail at runtime.
 */
import { describe, test, expect } from '@jest/globals';
import * as os from 'os';
import * as path from 'path';
import { getSystemManifestPath, tccProtectedRootContaining } from './utils';
import { BrowserType } from './browser-config';
import { HOST_NAME } from './constant';

const home = os.homedir();
const isDarwin = os.platform() === 'darwin';

describe('tccProtectedRootContaining', () => {
  test('flags paths inside ~/Documents on macOS', () => {
    if (!isDarwin) {
      // Helper is a darwin-only no-op; nothing to assert on other platforms.
      expect(tccProtectedRootContaining(path.join(home, 'Documents', 'x.sh'))).toBeUndefined();
      return;
    }
    expect(tccProtectedRootContaining(path.join(home, 'Documents', 'Code', 'app', 'run.sh'))).toBe(
      path.join(home, 'Documents'),
    );
  });

  test('flags paths inside other classic TCC roots', () => {
    if (!isDarwin) return;
    expect(tccProtectedRootContaining(path.join(home, 'Desktop', 'foo.sh'))).toBe(
      path.join(home, 'Desktop'),
    );
    expect(tccProtectedRootContaining(path.join(home, 'Downloads', 'bar.sh'))).toBe(
      path.join(home, 'Downloads'),
    );
  });

  test('flags iCloud Drive paths (~/Library/Mobile Documents)', () => {
    if (!isDarwin) return;
    const icloud = path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'foo.sh');
    expect(tccProtectedRootContaining(icloud)).toBe(path.join(home, 'Library', 'Mobile Documents'));
  });

  test('allows ~/Library/Application Support (the recommended install location)', () => {
    if (!isDarwin) return;
    const safe = path.join(
      home,
      'Library',
      'Application Support',
      'humanchrome-bridge',
      'dist',
      'run_host.sh',
    );
    expect(tccProtectedRootContaining(safe)).toBeUndefined();
  });

  test('allows /opt/homebrew and /usr/local installs', () => {
    if (!isDarwin) return;
    expect(
      tccProtectedRootContaining(
        '/opt/homebrew/lib/node_modules/humanchrome-bridge/dist/run_host.sh',
      ),
    ).toBeUndefined();
    expect(
      tccProtectedRootContaining('/usr/local/lib/node_modules/humanchrome-bridge/dist/run_host.sh'),
    ).toBeUndefined();
  });

  test('does NOT flag a directory that merely starts with a TCC root prefix', () => {
    if (!isDarwin) return;
    // ~/Documents-archive is NOT inside ~/Documents, even though the string
    // shares a prefix. path.relative correctly handles this — guard against
    // a future regression where someone replaces it with startsWith().
    const sibling = path.join(home, 'Documents-archive', 'run.sh');
    expect(tccProtectedRootContaining(sibling)).toBeUndefined();
  });
});

/**
 * Regression test for IMP-0037: `registerWithElevatedPermissions` previously
 * called `getSystemManifestPath()` with no args, which always returned Chrome's
 * system path on every platform. A `sudo humanchrome-bridge register --browser
 * chromium --system` thus wrote Chrome's manifest path even when targeting
 * Chromium. The function now accepts a `BrowserType` and routes to the
 * matching system path; verify here that Chromium and Chrome resolve to
 * different, browser-specific paths and that the Chrome default is preserved.
 */
describe('getSystemManifestPath', () => {
  const platform = os.platform();

  test('Chrome and Chromium resolve to different system paths', () => {
    const chromePath = getSystemManifestPath(BrowserType.CHROME);
    const chromiumPath = getSystemManifestPath(BrowserType.CHROMIUM);
    expect(chromePath).not.toBe(chromiumPath);
    expect(chromePath.endsWith(`${HOST_NAME}.json`)).toBe(true);
    expect(chromiumPath.endsWith(`${HOST_NAME}.json`)).toBe(true);
  });

  test('default (no arg) preserves historic Chrome behaviour', () => {
    expect(getSystemManifestPath()).toBe(getSystemManifestPath(BrowserType.CHROME));
  });

  test('returns the platform-correct Chromium path', () => {
    const chromiumPath = getSystemManifestPath(BrowserType.CHROMIUM);
    if (platform === 'darwin') {
      expect(chromiumPath).toBe(
        path.join(
          '/Library',
          'Application Support',
          'Chromium',
          'NativeMessagingHosts',
          `${HOST_NAME}.json`,
        ),
      );
    } else if (platform === 'win32') {
      const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
      expect(chromiumPath).toBe(
        path.join(programFiles, 'Chromium', 'NativeMessagingHosts', `${HOST_NAME}.json`),
      );
    } else {
      expect(chromiumPath).toBe(
        path.join('/etc', 'chromium', 'native-messaging-hosts', `${HOST_NAME}.json`),
      );
    }
  });

  test('returns the platform-correct Chrome path', () => {
    const chromePath = getSystemManifestPath(BrowserType.CHROME);
    if (platform === 'darwin') {
      expect(chromePath).toBe(
        path.join('/Library', 'Google', 'Chrome', 'NativeMessagingHosts', `${HOST_NAME}.json`),
      );
    } else if (platform === 'win32') {
      const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
      expect(chromePath).toBe(
        path.join(programFiles, 'Google', 'Chrome', 'NativeMessagingHosts', `${HOST_NAME}.json`),
      );
    } else {
      expect(chromePath).toBe(
        path.join('/etc', 'opt', 'chrome', 'native-messaging-hosts', `${HOST_NAME}.json`),
      );
    }
  });
});
