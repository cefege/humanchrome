/**
 * @fileoverview Vitest Global Setup
 * @description Provides global configuration and polyfills for test environment
 */

import { vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { initializeRustBindings } from 'humanchrome-shared';
import { _seedRustKernelBytesForTest } from '../shared/rust-kernel';
import type * as ClientStateModule from '../entrypoints/background/utils/client-state';

const kernelBytes = await readFile(
  resolve(import.meta.dirname, '../../../packages/shared/generated/humanchrome_wasm_bg.wasm'),
);
_seedRustKernelBytesForTest(kernelBytes);
await initializeRustBindings(kernelBytes);

// Provide IndexedDB globals (jsdom doesn't include them)
import 'fake-indexeddb/auto';

// Mock chrome API (basic placeholder)
if (typeof globalThis.chrome === 'undefined') {
  (globalThis as unknown as { chrome: object }).chrome = {
    runtime: {
      id: 'test-extension-id',
      sendMessage: vi.fn().mockResolvedValue(undefined),
      onMessage: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
      connect: vi.fn().mockReturnValue({
        onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
        onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
      }),
    },
    storage: {
      local: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      },
    },
    tabs: {
      query: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 1 }),
      update: vi.fn().mockResolvedValue({}),
      remove: vi.fn().mockResolvedValue(undefined),
      captureVisibleTab: vi.fn().mockResolvedValue('data:image/png;base64,'),
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      onCreated: { addListener: vi.fn(), removeListener: vi.fn() },
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    webRequest: {
      onBeforeRequest: { addListener: vi.fn(), removeListener: vi.fn() },
      onCompleted: { addListener: vi.fn(), removeListener: vi.fn() },
      onErrorOccurred: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    webNavigation: {
      onCommitted: { addListener: vi.fn(), removeListener: vi.fn() },
      onDOMContentLoaded: { addListener: vi.fn(), removeListener: vi.fn() },
      onCompleted: { addListener: vi.fn(), removeListener: vi.fn() },
      onHistoryStateUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    debugger: {
      onEvent: { addListener: vi.fn(), removeListener: vi.fn() },
      onDetach: { addListener: vi.fn(), removeListener: vi.fn() },
      attach: vi.fn().mockResolvedValue(undefined),
      detach: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn().mockResolvedValue({}),
    },
    commands: {
      onCommand: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    contextMenus: {
      create: vi.fn(),
      remove: vi.fn(),
      onClicked: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  };
}

const clientState = await vi.importActual<typeof ClientStateModule>(
  '../entrypoints/background/utils/client-state',
);
await clientState.ensureClientStateReady();
