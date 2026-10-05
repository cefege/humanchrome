/**
 * Contract: the bridge port is profile-scoped, never assumed.
 *
 * Each Chrome profile in the fleet spawns its own bridge on a different
 * port (daily Chrome = 12306, fleet p01 = 12500, ...). Consumers that
 * resolved `nativeServerPort` themselves silently hit the user's DAILY
 * Chrome. `resolveBridgePort` centralises the precedence:
 *
 *   1. live GET_SERVER_STATUS response port
 *   2. storage `serverStatus.port` (the port the bridge reported binding)
 *   3. storage `nativeServerPort`
 *   4. NATIVE_HOST.DEFAULT_PORT
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveBridgeBaseUrl, resolveBridgePort } from '@/entrypoints/background/bridge-endpoint';

const sendMessage = vi.fn();
const storageGet = vi.fn();

beforeEach(() => {
  sendMessage.mockReset();
  storageGet.mockReset();

  (globalThis as unknown as { chrome: Record<string, unknown> }).chrome = {
    runtime: { sendMessage },
    storage: { local: { get: storageGet } },
  };
});

describe('resolveBridgePort', () => {
  it('prefers the live GET_SERVER_STATUS port over everything else', async () => {
    sendMessage.mockResolvedValue({ serverStatus: { isRunning: true, port: 12500 } });
    storageGet.mockResolvedValue({ serverStatus: { port: 1 }, nativeServerPort: 2 });

    await expect(resolveBridgePort()).resolves.toBe(12500);
    expect(storageGet).not.toHaveBeenCalled();
  });

  it('falls back to storage.serverStatus.port when the live request fails', async () => {
    sendMessage.mockRejectedValue(new Error('Receiving end does not exist'));
    storageGet.mockResolvedValue({ serverStatus: { isRunning: true, port: 12501 } });

    await expect(resolveBridgePort()).resolves.toBe(12501);
  });

  it('falls back to storage.serverStatus.port when the live response carries no port', async () => {
    sendMessage.mockResolvedValue({ success: true, serverStatus: { isRunning: false } });
    storageGet.mockResolvedValue({ serverStatus: { port: 12502 }, nativeServerPort: 2 });

    await expect(resolveBridgePort()).resolves.toBe(12502);
  });

  it('falls back to storage.nativeServerPort when no serverStatus is persisted', async () => {
    sendMessage.mockResolvedValue(undefined);
    storageGet.mockResolvedValue({ nativeServerPort: 12503 });

    await expect(resolveBridgePort()).resolves.toBe(12503);
  });

  it('falls back to the default port when storage is empty', async () => {
    sendMessage.mockResolvedValue(undefined);
    storageGet.mockResolvedValue({});

    await expect(resolveBridgePort()).resolves.toBe(12306);
  });

  it('falls back to the default port when storage itself throws', async () => {
    sendMessage.mockRejectedValue(new Error('no receiver'));
    storageGet.mockRejectedValue(new Error('storage unavailable'));

    await expect(resolveBridgePort()).resolves.toBe(12306);
  });

  it('ignores out-of-range ports stored by a previous session', async () => {
    sendMessage.mockResolvedValue({ serverStatus: { port: 99999 } });
    storageGet.mockResolvedValue({ serverStatus: { port: -1 }, nativeServerPort: 0 });

    await expect(resolveBridgePort()).resolves.toBe(12306);
  });

  it('accepts a numeric string port from storage', async () => {
    sendMessage.mockRejectedValue(new Error('no receiver'));
    storageGet.mockResolvedValue({ nativeServerPort: '12504' });

    await expect(resolveBridgePort()).resolves.toBe(12504);
  });
});

describe('resolveBridgeBaseUrl', () => {
  it('builds the loopback origin from the resolved port', async () => {
    sendMessage.mockResolvedValue({ serverStatus: { port: 12500 } });

    await expect(resolveBridgeBaseUrl()).resolves.toBe('http://127.0.0.1:12500');
  });

  it('builds the loopback origin from storage when the live request fails', async () => {
    sendMessage.mockRejectedValue(new Error('no receiver'));
    storageGet.mockResolvedValue({ serverStatus: { port: 12505 } });

    await expect(resolveBridgeBaseUrl()).resolves.toBe('http://127.0.0.1:12505');
  });

  it('falls back to the default origin when nothing is known', async () => {
    sendMessage.mockRejectedValue(new Error('no receiver'));
    storageGet.mockResolvedValue({});

    await expect(resolveBridgeBaseUrl()).resolves.toBe('http://127.0.0.1:12306');
  });
});
