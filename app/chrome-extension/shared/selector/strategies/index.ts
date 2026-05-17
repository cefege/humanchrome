/**
 * Selector Strategies - Strategy exports and default configuration
 */

import type { SelectorStrategy } from '../types';
import { altTextStrategy } from './alt-text';
import { anchorRelpathStrategy } from './anchor-relpath';
import { ariaStrategy } from './aria';
import { cssPathStrategy } from './css-path';
import { cssUniqueStrategy } from './css-unique';
import { labelStrategy } from './label';
import { placeholderStrategy } from './placeholder';
import { roleStrategy } from './role';
import { testIdStrategy } from './testid';
import { textStrategy } from './text';
import { titleStrategy } from './title';

/**
 * Default selector strategy list (ordered by generation order).
 *
 * Strategy generation order — the FINAL candidate order in the returned
 * target is determined by weight (descending) + stability score
 * (descending), but the order here governs which strategies generate
 * first so dedupe keeps the higher-priority candidate when multiple
 * strategies produce the same selector string.
 *
 * The mirrored Playwright-style priority that recorders and replayers
 * agree on (IMP-0098 + IMP-0099):
 *   1. testid       — data-testid/cy/test/qa (configurable per-client)
 *   2. role         — implicit/explicit ARIA role + accessible name
 *   3. label        — form labels (label[for], wrapping, aria-label)
 *   4. placeholder  — getByPlaceholder
 *   5. alt-text     — img/area/input[type=image] alt
 *   6. title        — title attribute
 *   7. aria         — legacy aria-label (kept for back-compat)
 *   8. css-unique   — #id / .class combinations
 *   9. css-path     — full nth-of-type ladder
 *  10. anchor-relpath — ancestor anchor + relative descent path
 *  11. text         — text content (lowest priority)
 */
export const DEFAULT_SELECTOR_STRATEGIES: ReadonlyArray<SelectorStrategy> = [
  testIdStrategy,
  roleStrategy,
  labelStrategy,
  placeholderStrategy,
  altTextStrategy,
  titleStrategy,
  ariaStrategy,
  cssUniqueStrategy,
  cssPathStrategy,
  anchorRelpathStrategy,
  textStrategy,
];

export { altTextStrategy } from './alt-text';
export { anchorRelpathStrategy } from './anchor-relpath';
export { ariaStrategy } from './aria';
export { cssPathStrategy } from './css-path';
export { cssUniqueStrategy } from './css-unique';
export { labelStrategy } from './label';
export { placeholderStrategy } from './placeholder';
export { roleStrategy } from './role';
export { testIdStrategy } from './testid';
export { textStrategy } from './text';
export { titleStrategy } from './title';
