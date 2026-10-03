/**
 * The self-update watcher reloads the extension when the build on disk is not
 * the build that is running. A fleet browser restarted after a deploy kept an
 * older service worker forever, so "not the running build" is measured
 * against the identity baked into the bundle, never against an earlier read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkAndReload } from '@/entrypoints/background/self-update-watcher';

const RUNNING = '2026-10-03T22:00:00.000Z';
let stored: Record<string, unknown>;
let reload: ReturnType<typeof vi.fn>;

function onDisk(builtAt: string | null) {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        builtAt === null
          ? { ok: false }
          : { ok: true, json: async () => ({ buildHash: 'h', builtAt }) },
      ),
  );
}

async function check() {
  vi.useFakeTimers();
  await checkAndReload();
  vi.runAllTimers();
  vi.useRealTimers();
}

beforeEach(() => {
  vi.stubGlobal('__HC_BUILT_AT__', RUNNING);
  stored = {};
  reload = vi.fn();
  const chromeMock = globalThis.chrome as unknown as Record<string, any>;
  chromeMock.runtime = { ...chromeMock.runtime, getURL: (p: string) => p, reload };
  chromeMock.storage = {
    ...chromeMock.storage,
    local: {
      get: vi.fn(async (key: string) => ({ [key]: stored[key] })),
      set: vi.fn(async (items: Record<string, unknown>) => Object.assign(stored, items)),
    },
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('self-update watcher', () => {
  it('leaves the running build alone when it is the one on disk', async () => {
    onDisk(RUNNING);
    await check();
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads when the build on disk is not the running one, even on its first look', async () => {
    // The restarted-profile case: there is no earlier poll to compare with.
    onDisk('2026-10-03T22:13:15.572Z');
    await check();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads once per build on disk, not every poll', async () => {
    onDisk('2026-10-03T22:13:15.572Z');
    await check();
    await check();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads again for the next build', async () => {
    onDisk('2026-10-03T22:13:15.572Z');
    await check();
    onDisk('2026-10-03T23:00:00.000Z');
    await check();
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('does nothing when the build info cannot be read', async () => {
    onDisk(null);
    await check();
    expect(reload).not.toHaveBeenCalled();
  });
});
