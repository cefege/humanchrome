/**
 * Selector Engine - Unified selector generation and element location
 *
 * Modules:
 * - types: Type definitions
 * - stability: Stability scoring
 * - strategies: Selector generation strategies
 * - generator: Selector target generation
 * - locator: Element location
 * - fingerprint: Element fingerprinting (Phase 1.2)
 * - dom-path: DOM path computation (Phase 1.2)
 * - shadow-dom: Shadow DOM utilities (Phase 1.2)
 */

// Type exports
export * from './types';

// Stability scoring
export { computeSelectorStability, withStability, compareSelectorCandidates } from './stability';

// Selector strategies
export { DEFAULT_SELECTOR_STRATEGIES } from './strategies';
export { altTextStrategy, resolveByAltText } from './strategies/alt-text';
export { anchorRelpathStrategy } from './strategies/anchor-relpath';
export { ariaStrategy } from './strategies/aria';
export { cssPathStrategy } from './strategies/css-path';
export { cssUniqueStrategy } from './strategies/css-unique';
export { labelStrategy, resolveByLabel } from './strategies/label';
export { placeholderStrategy, resolveByPlaceholder } from './strategies/placeholder';
export {
  roleStrategy,
  getElementRole,
  getImplicitRole,
  resolveByRole,
  parseRoleSelector,
} from './strategies/role';
export {
  testIdStrategy,
  resolveByTestId,
  setTestIdAttributes,
  getTestIdAttributes,
  DEFAULT_TESTID_ATTRIBUTES,
} from './strategies/testid';
export { textStrategy } from './strategies/text';
export { titleStrategy, resolveByTitle } from './strategies/title';

// Accessible-name compute (W3C accname-1.2 subset)
export {
  computeAccessibleName,
  matchesAccessibleName,
  type NameMatchMode,
} from './accessible-name';

// Prefixed selector parsing
export {
  parsePrefixedSelector,
  type ParsedPrefixedSelector,
  type PrefixedSelectorKind,
} from './prefixed-parser';

// Selector generation
export {
  generateSelectorTarget,
  generateExtendedSelectorTarget,
  normalizeSelectorGenerationOptions,
  cssEscape,
  type GenerateSelectorTargetOptions,
} from './generator';

// Element location
export {
  SelectorLocator,
  createChromeSelectorLocator,
  createChromeSelectorLocatorTransport,
  type SelectorLocatorTransport,
} from './locator';

// Fingerprint utilities (Phase 1.2)
export {
  computeFingerprint,
  parseFingerprint,
  verifyFingerprint,
  fingerprintSimilarity,
  fingerprintMatches,
  type ElementFingerprint,
  type FingerprintOptions,
} from './fingerprint';

// DOM path utilities (Phase 1.2)
export {
  computeDomPath,
  locateByDomPath,
  compareDomPaths,
  isAncestorPath,
  getRelativePath,
  type DomPath,
} from './dom-path';

// Shadow DOM utilities (Phase 1.2)
export {
  traverseShadowDom,
  traverseShadowDomWithDetails,
  queryInShadowDom,
  queryAllInShadowDom,
  isUniqueInShadowDom,
  type ShadowTraversalResult,
  type ShadowTraversalFailureReason,
} from './shadow-dom';
