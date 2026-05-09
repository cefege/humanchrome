/**
 * IMP-0059 — opt-in persistence for the extension debug log.
 *
 * Pre-fix: every logEvent call queued a 250 ms-debounced
 * chrome.storage.local.set of the entire ring buffer. During hot tool
 * streams that was ~4 writes/sec of up to 5 MB each — the dominant
 * steady-state SW CPU cost during automation runs.
 *
 * Post-fix: persistence is OFF by default and the debounce was
 * raised to 5 s. Callers explicitly opt in via setPersistEnabled
 * (or chrome_debug_dump with `persist: true`). These tests pin:
 *
 *   - default state: zero chrome.storage.local.set calls during
 *     a hot stream of logEvents
 *   - flag toggle persists itself under PERSIST_ENABLED_KEY
 *   - on→off drops the persisted blob (next SW boot starts clean)
 *   - off→on schedules a flush so backlog gets persisted
 *   - in-memory dumpLog continues to work regardless of the flag
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeStorage {
  store: Map<string, unknown>;
  setSpy: ReturnType<typeof vi.fn>;
  removeSpy: ReturnType<typeof vi.fn>;
  getSpy: ReturnType<typeof vi.fn>;
}

function installChromeStorage(): FakeStorage {
  const store = new Map<string, unknown>();
  const setSpy = vi.fn(async (kv: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(kv)) store.set(k, v);
  });
  const removeSpy = vi.fn(async (key: string | string[]) => {
    const keys = Array.isArray(key) ? key : [key];
    for (const k of keys) store.delete(k);
  });
  const getSpy = vi.fn(async (key: string | string[]) => {
    const keys = Array.isArray(key) ? key : [key];
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      if (store.has(k)) out[k] = store.get(k);
    }
    return out;
  });
  (globalThis.chrome as any).storage = {
    local: {
      get: getSpy,
      set: setSpy,
      remove: removeSpy,
    },
  };
  (globalThis.chrome as any).runtime = {
    ...(globalThis.chrome as any).runtime,
    getManifest: () => ({ version: '0.0.0-test' }),
  };
  return { store, setSpy, removeSpy, getSpy };
}

async function loadLogger() {
  vi.resetModules();
  return await import('@/utils/logger');
}

let storage: FakeStorage;

beforeEach(async () => {
  storage = installChromeStorage();
  // Use real timers — we want to assert that NO setTimeout was scheduled
  // when persistence is off, and we drive the debounce explicitly with
  // fake timers in the on-path tests.
});

afterEach(() => {
  vi.useRealTimers();
});

describe('persistence is OFF by default (IMP-0059 hot path)', () => {
  it('logEvent does not schedule a chrome.storage.local.set', async () => {
    const mod = await loadLogger();

    expect(mod.getPersistEnabled()).toBe(false);

    // Drive a burst that pre-fix would have produced ~12 storage writes
    // (3 events × 4 ticks). Post-fix: zero scheduled writes.
    for (let i = 0; i < 12; i++) {
      mod.logEvent('info', `event-${i}`, { tool: 'chrome_test' });
    }

    // Even after a long real wait, the debounce must not fire because
    // schedulePersist short-circuits on `!persistEnabled`. We use fake
    // timers to advance 60 s and assert nothing was queued.
    vi.useFakeTimers();
    vi.advanceTimersByTime(60_000);

    expect(storage.setSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ __humanchrome_log_v2: expect.anything() }),
    );

    // bufferSize is non-zero — in-memory ring still works.
    expect(mod.getBufferSize()).toBe(12);
  });

  it('dumpLog returns in-memory entries even when persistence is off', async () => {
    const mod = await loadLogger();
    mod.logEvent('info', 'hello', { tool: 'chrome_test', requestId: 'r-1' });
    mod.logEvent('warn', 'second', { tool: 'chrome_test', requestId: 'r-2' });

    const entries = await mod.dumpLog({ tool: 'chrome_test', limit: 10 });

    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.requestId).sort()).toEqual(['r-1', 'r-2']);
  });
});

describe('setPersistEnabled toggles persistence', () => {
  it('on→off drops the persisted blob and prevents further writes', async () => {
    const mod = await loadLogger();
    // Pre-seed a stale blob so we can assert it gets dropped.
    storage.store.set('__humanchrome_log_v2', [{ ts: 1, level: 'info', msg: 'old' }]);

    await mod.setPersistEnabled(false);

    expect(storage.setSpy).toHaveBeenCalledWith({
      'humanchrome:logPersistEnabled': false,
    });
    expect(storage.removeSpy).toHaveBeenCalledWith('__humanchrome_log_v2');
    expect(storage.store.has('__humanchrome_log_v2')).toBe(false);

    // Subsequent logs do not trigger persistence.
    storage.setSpy.mockClear();
    mod.logEvent('error', 'still off');
    vi.useFakeTimers();
    vi.advanceTimersByTime(10_000);
    expect(storage.setSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ __humanchrome_log_v2: expect.anything() }),
    );
  });

  it('off→on schedules a debounced flush of the in-memory backlog', async () => {
    vi.useFakeTimers();
    const mod = await loadLogger();

    // Backlog accumulated while persistence was off.
    mod.logEvent('info', 'one');
    mod.logEvent('info', 'two');

    // Toggle on (note: setPersistEnabled is async because it writes to
    // chrome.storage.local; we need to flush microtasks, not just the
    // 5 s debounce timer).
    await mod.setPersistEnabled(true);

    expect(storage.setSpy).toHaveBeenCalledWith({
      'humanchrome:logPersistEnabled': true,
    });

    // Persist write itself fires after the 5 s debounce.
    storage.setSpy.mockClear();
    await vi.advanceTimersByTimeAsync(5_000);

    const persistCalls = storage.setSpy.mock.calls.filter(
      ([arg]) => arg && Object.prototype.hasOwnProperty.call(arg, '__humanchrome_log_v2'),
    );
    expect(persistCalls.length).toBeGreaterThanOrEqual(1);
    const buffered = persistCalls[persistCalls.length - 1]?.[0]?.['__humanchrome_log_v2'] as any[];
    expect(buffered.length).toBe(2);
  });

  it('multiple logs within the 5 s debounce coalesce into ONE storage write', async () => {
    vi.useFakeTimers();
    const mod = await loadLogger();
    await mod.setPersistEnabled(true);
    storage.setSpy.mockClear();

    for (let i = 0; i < 50; i++) {
      mod.logEvent('info', `burst-${i}`);
      // Tick by 50 ms each — total elapsed under the 5 s debounce window.
      await vi.advanceTimersByTimeAsync(50);
    }

    // We're at 2.5 s elapsed (50 × 50 ms). No persist write yet.
    let persistCalls = storage.setSpy.mock.calls.filter(
      ([arg]) => arg && Object.prototype.hasOwnProperty.call(arg, '__humanchrome_log_v2'),
    );
    expect(persistCalls.length).toBe(0);

    // Push past the 5 s mark — exactly ONE persist call should fire.
    await vi.advanceTimersByTimeAsync(3_000);

    persistCalls = storage.setSpy.mock.calls.filter(
      ([arg]) => arg && Object.prototype.hasOwnProperty.call(arg, '__humanchrome_log_v2'),
    );
    expect(persistCalls.length).toBe(1);
    expect((persistCalls[0]![0]!['__humanchrome_log_v2'] as any[]).length).toBe(50);
  });
});

describe('SW restart with persistence off does not resurrect old logs', () => {
  it('skips the buffer-restore branch when the flag is off', async () => {
    // Seed both the persisted blob AND the explicit "off" state in storage,
    // simulating a previous SW life that disabled persistence.
    storage.store.set('__humanchrome_log_v2', [{ ts: 1, level: 'info', msg: 'old' }]);
    storage.store.set('humanchrome:logPersistEnabled', false);

    const mod = await loadLogger();
    // Trigger the storage restore path via dumpLog.
    const entries = await mod.dumpLog();

    expect(entries).toHaveLength(0);
    expect(mod.getPersistEnabled()).toBe(false);
  });

  it('does restore the buffer when the persisted flag was true', async () => {
    storage.store.set('__humanchrome_log_v2', [{ ts: 1, level: 'info', msg: 'survived' }]);
    storage.store.set('humanchrome:logPersistEnabled', true);

    const mod = await loadLogger();
    const entries = await mod.dumpLog();

    expect(entries).toHaveLength(1);
    expect(entries[0].msg).toBe('survived');
    expect(mod.getPersistEnabled()).toBe(true);
  });
});
