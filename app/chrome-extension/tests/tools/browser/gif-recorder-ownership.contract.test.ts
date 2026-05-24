/**
 * Contract: gif-recorder cross-client ownership gate (IMP-0166).
 *
 * Pre-fix, two MCP clients calling `chrome_gif_recorder action:start`
 * concurrently would both see "Recording already in progress" but with
 * no indication of which client owned the in-flight recording — leading
 * to silent collisions where one client thought it had started a
 * recording that was actually still owned by another.
 *
 * Post-fix, `startRecording` stamps `currentRecordingClientId` from the
 * caller's request context. A second client trying to start gets an
 * error naming the owner; a second client trying to stop the
 * non-owned recording is rejected.
 *
 * Tests exercise the ownership gate via the `_setRecordingOwnerForTest`
 * seam (avoids spinning up the full offscreen + CDP + capture
 * pipeline). The actual start/stop happy paths are covered by the
 * existing e2e matrix.
 *
 * Caveats / not in scope (deferred to a follow-up IMP):
 * - `lastRecordedGif` is still singleton across clients.
 * - The `__system` bucket is allowed to start/stop regardless of any
 *   prior owner (so internal cleanup paths still work).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// IMP-0166: import request-context dynamically inside the test helpers
// so the post-`vi.resetModules()` instance matches the one gif-recorder
// imports — otherwise `runWithContext` and `getCurrentRequestContext`
// touch different module-level `current` variables and the context
// never propagates.
async function withClient<T>(clientId: string, fn: () => Promise<T>): Promise<T> {
  const rc = await import('@/entrypoints/background/utils/request-context');
  return rc.runWithContext({ clientId }, fn);
}

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: {
    attach: vi.fn().mockResolvedValue(undefined),
    detach: vi.fn().mockResolvedValue(undefined),
    sendCommand: vi.fn().mockResolvedValue({}),
    withSession: vi.fn(),
  },
}));

vi.mock('@/utils/offscreen-manager', () => ({
  offscreenManager: { ensureOffscreenDocument: vi.fn().mockResolvedValue(undefined) },
}));

beforeEach(() => {
  (globalThis.chrome as any) = {
    ...((globalThis.chrome as any) ?? {}),
    tabs: {
      ...((globalThis.chrome as any)?.tabs ?? {}),
      get: vi.fn().mockResolvedValue({ id: 1, url: 'https://example.com', windowId: 1 }),
      query: vi.fn().mockResolvedValue([{ id: 1, url: 'https://example.com' }]),
      onRemoved: { addListener: vi.fn() },
    },
    runtime: { sendMessage: vi.fn().mockResolvedValue({ success: true }) },
    storage: {
      session: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) },
    },
    debugger: {
      onEvent: { addListener: vi.fn(), removeListener: vi.fn() },
      onDetach: { addListener: vi.fn() },
    },
  };
});

afterEach(() => {});

async function loadRecorder() {
  vi.resetModules();
  const mod = await import('@/entrypoints/background/tools/browser/gif-recorder');
  mod._resetRecordingOwnerForTest();
  return mod;
}

describe('gif-recorder cross-client ownership (IMP-0166)', () => {
  it('start: rejects a second client with the owner client-id in the message', async () => {
    const mod = await loadRecorder();
    mod._setRecordingOwnerForTest('alice');

    const result = await withClient('bob', () =>
      mod.gifRecorderTool.execute({
        action: 'start',
        tabId: 1,
        fps: 5,
        durationMs: 1000,
        maxFrames: 5,
        width: 640,
        height: 480,
      }),
    );
    const body = JSON.parse((result.content[0] as any).text);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/owned by client alice/);
  });

  it('start: surfaces the system bucket as owner when context-less code holds the recording', async () => {
    const mod = await loadRecorder();
    mod._setRecordingOwnerForTest(null);
    // Manually set currentRecordingClientId to null but pretend
    // recordingState is occupied (simulates the auto-capture path
    // started without request context).
    mod._setRecordingOwnerForTest('__system');

    const result = await withClient('alice', () =>
      mod.gifRecorderTool.execute({
        action: 'start',
        tabId: 1,
        fps: 5,
        durationMs: 1000,
        maxFrames: 5,
        width: 640,
        height: 480,
      }),
    );
    const body = JSON.parse((result.content[0] as any).text);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/owned by client __system/);
  });

  it('stop: rejects a non-owner client with the owner id in the message', async () => {
    const mod = await loadRecorder();
    mod._setRecordingOwnerForTest('alice');

    const result = await withClient('bob', () =>
      mod.gifRecorderTool.execute({ action: 'stop' }),
    );
    const body = JSON.parse((result.content[0] as any).text);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/owned by client alice/);
    expect(body.error).toMatch(/client bob cannot stop it/);
  });

  it('stop: system bucket can always stop (internal cleanup paths)', async () => {
    const mod = await loadRecorder();
    mod._setRecordingOwnerForTest('alice');

    // No runWithContext — caller is __system. Should NOT get the
    // "owned by alice" rejection; the stop attempt proceeds (and may
    // fail later for unrelated reasons in this mocked environment, but
    // not for the ownership gate).
    const result = await mod.gifRecorderTool.execute({ action: 'stop' });
    const body = JSON.parse((result.content[0] as any).text);
    // Either succeeds or fails for non-ownership reasons.
    if (!body.success) {
      expect(body.error).not.toMatch(/owned by client/);
    }
  });

  it('reset clears the ownership stamp so the next test starts clean', async () => {
    const mod = await loadRecorder();
    mod._setRecordingOwnerForTest('alice');
    mod._resetRecordingOwnerForTest();

    // After reset, bob's start is not blocked by alice's ownership — it
    // may fail for mocked-pipeline reasons but the failure should NOT
    // mention an owner.
    const result = await withClient('bob', () =>
      mod.gifRecorderTool.execute({
        action: 'start',
        tabId: 1,
        fps: 5,
        durationMs: 1000,
        maxFrames: 5,
        width: 640,
        height: 480,
      }),
    );
    const body = JSON.parse((result.content[0] as any).text);
    if (!body.success) {
      expect(body.error ?? '').not.toMatch(/owned by client/);
    }
  });
});
