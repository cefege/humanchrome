import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageTarget, SendMessageType } from '@/common/message-types';

const model = vi.hoisted(() => ({
  gate: Promise.resolve(),
  created: () => {},
  failure: false,
}));

vi.mock('@/entrypoints/offscreen/rr-keepalive', () => ({ initKeepalive: () => {} }));
vi.mock('@/utils/semantic-similarity-engine', () => ({
  SemanticSimilarityEngine: class {
    isInitialized = false;
    disposed = false;
    constructor() {
      model.created();
    }
    async initializeWithProgress() {
      await model.gate;
      if (this.disposed) throw new Error('Model disposed during initialization');
      if (model.failure) throw new Error('Model initialization failed');
      this.isInitialized = true;
    }
    async dispose() {
      this.disposed = true;
      this.isInitialized = false;
    }
  },
}));

type Response = { success: boolean; error?: string };
type Listener = (message: unknown, sender: unknown, reply: (response: Response) => void) => unknown;
let listeners: Listener[];
let release: () => void;
let created: Promise<void>;
let originalRuntime: typeof chrome.runtime;

beforeEach(() => {
  vi.resetModules();
  listeners = [];
  model.failure = false;
  model.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  created = new Promise<void>((resolve) => {
    model.created = resolve;
  });
  originalRuntime = chrome.runtime;
  (globalThis.chrome as any).runtime = {
    ...originalRuntime,
    onMessage: { addListener: (listener: Listener) => listeners.push(listener) },
    sendMessage: vi.fn().mockResolvedValue({ success: true }),
  };
});

afterEach(() => {
  (globalThis.chrome as any).runtime = originalRuntime;
});

function initialize(): Promise<Response> {
  return new Promise((resolve) => {
    listeners[0](
      {
        target: MessageTarget.Offscreen,
        type: SendMessageType.SimilarityEngineInit,
        config: { modelPreset: 'multilingual-e5-small', modelVersion: 'quantized' },
      },
      {},
      resolve,
    );
  });
}

describe('offscreen model lifecycle', () => {
  it('preserves a ready engine when cached startup and an explicit request overlap', async () => {
    const { getCurrentSimilarityEngine } = await import('@/entrypoints/offscreen/main');
    const cachedStartup = initialize();
    await created;
    const explicitRequest = initialize();
    // Drain the already-enqueued continuation, without guessing a wall-clock delay.
    await Promise.resolve();
    release();

    const [cachedResponse, explicitResponse] = await Promise.all([cachedStartup, explicitRequest]);
    expect(cachedResponse).toEqual({ success: true });
    expect(explicitResponse).toEqual({ success: true });
    expect(getCurrentSimilarityEngine()?.isInitialized).toBe(true);
  });

  it('allows a new explicit initialization after a previous request fails', async () => {
    const { getCurrentSimilarityEngine } = await import('@/entrypoints/offscreen/main');
    model.failure = true;
    const failed = initialize();
    await created;
    release();
    expect(await failed).toEqual({ success: false, error: 'Model initialization failed' });
    expect(getCurrentSimilarityEngine()).toBeNull();

    model.failure = false;
    expect(await initialize()).toEqual({ success: true });
    expect(getCurrentSimilarityEngine()?.isInitialized).toBe(true);
  });
});
