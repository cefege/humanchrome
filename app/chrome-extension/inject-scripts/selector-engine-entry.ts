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

// Keep the recorder's frozen strategy set, candidate shape, and weight order.
// These differ intentionally from the generic selector API used by tools.
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

type RecorderRealm = Window & {
  __rrSelectorEngine?: RecorderSelectorEngine;
};

const realm = window as RecorderRealm;

// executeScript files are classic scripts. Publish synchronously so the next
// recorder injection observes a fully usable DOM-only selector engine.
realm.__rrSelectorEngine ??= {
  generateSelectorTarget,
  generateExtendedSelectorTarget,
  compareSelectorCandidates,
  withStability,
  computeFingerprint,
  computeDomPath,
  cssEscape,
};
