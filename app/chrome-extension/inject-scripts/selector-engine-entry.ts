import { initializeRustBindings, RUST_KERNEL_ID } from 'humanchrome-shared';
import {
  generateSelectorTarget as generateSharedSelectorTarget,
  generateExtendedSelectorTarget as generateSharedExtendedSelectorTarget,
  cssEscape,
} from '../shared/selector/generator';
import type { GenerateSelectorTargetOptions } from '../shared/selector/generator';
import {
  testIdStrategy,
  ariaStrategy,
  cssUniqueStrategy,
  cssPathStrategy,
  anchorRelpathStrategy,
  textStrategy,
} from '../shared/selector/strategies';
import { recorderLabelStrategy } from '../shared/selector/strategies/label';
import { recorderPlaceholderStrategy } from '../shared/selector/strategies/placeholder';
import { compareSelectorCandidates, withStability } from '../shared/selector/stability';
import { computeFingerprint } from '../shared/selector/fingerprint';
import { computeDomPath } from '../shared/selector/dom-path';

const RECORDER_STRATEGIES = [
  testIdStrategy,
  ariaStrategy,
  recorderLabelStrategy,
  recorderPlaceholderStrategy,
  cssUniqueStrategy,
  cssPathStrategy,
  anchorRelpathStrategy,
  textStrategy,
];

function generateSelectorTarget(element: Element, options?: GenerateSelectorTargetOptions) {
  return generateSharedSelectorTarget(element, {
    ...options,
    strategies: options?.strategies ?? RECORDER_STRATEGIES,
  });
}

function generateExtendedSelectorTarget(element: Element, options?: GenerateSelectorTargetOptions) {
  return generateSharedExtendedSelectorTarget(element, {
    ...options,
    strategies: options?.strategies ?? RECORDER_STRATEGIES,
  });
}

interface RecorderSelectorEngine {
  generateSelectorTarget: typeof generateSelectorTarget;
  generateExtendedSelectorTarget: typeof generateExtendedSelectorTarget;
  compareSelectorCandidates: typeof compareSelectorCandidates;
  withStability: typeof withStability;
  computeFingerprint: typeof computeFingerprint;
  computeDomPath: typeof computeDomPath;
  cssEscape: typeof cssEscape;
}

type RecorderKernelRealm = typeof globalThis & {
  __rrSelectorEngine?: RecorderSelectorEngine;
  __hcRustReady?: Promise<void>;
  __hcRustKernelId?: string;
  __hcGetRustKernelModule?: (bytes: number[]) => Promise<WebAssembly.Module>;
  __hcInitializeRustKernel?: (bytes: number[]) => Promise<void>;
};

const realm = globalThis as RecorderKernelRealm;

if (realm.__hcRustKernelId !== RUST_KERNEL_ID) {
  delete realm.__hcRustReady;
  delete realm.__rrSelectorEngine;
  delete realm.__hcGetRustKernelModule;
}
realm.__hcRustKernelId = RUST_KERNEL_ID;

// srcdoc CSP can block compilation even in an isolated world. Same-origin extension worlds
// can privately reuse an ancestor's compiled module without page messaging or a CSP override.
if (!realm.__hcGetRustKernelModule) {
  let module: Promise<WebAssembly.Module> | undefined;
  realm.__hcGetRustKernelModule = (bytes) => {
    if (!module) {
      try {
        const parent = realm.parent as unknown as RecorderKernelRealm;
        if (parent !== realm && parent.__hcRustKernelId === RUST_KERNEL_ID) {
          module = parent.__hcGetRustKernelModule?.(bytes);
        }
      } catch {
        // A cross-origin parent is not accessible; this realm compiles its own packaged bytes.
      }
      module ??= WebAssembly.compile(Uint8Array.from(bytes));
    }
    return module;
  };
}

realm.__hcInitializeRustKernel = (bytes) => {
  if (realm.__hcRustKernelId === RUST_KERNEL_ID && realm.__hcRustReady) {
    return realm.__hcRustReady;
  }
  realm.__hcRustKernelId = RUST_KERNEL_ID;
  delete realm.__rrSelectorEngine;
  realm.__hcRustReady = realm.__hcGetRustKernelModule!(bytes)
    .then(initializeRustBindings)
    .then(() => {
      realm.__rrSelectorEngine = {
        generateSelectorTarget,
        generateExtendedSelectorTarget,
        compareSelectorCandidates,
        withStability,
        computeFingerprint,
        computeDomPath,
        cssEscape,
      };
    });
  return realm.__hcRustReady;
};
