/**
 * Coverage guard for `TOOL_CATEGORIES`.
 *
 * The doc generator (`app/native-server/scripts/generate-tools-doc.mjs`)
 * groups tools into category sections in `docs/TOOLS.md`. If a new tool is
 * added to `TOOL_SCHEMAS` without a matching entry in `TOOL_CATEGORIES`,
 * the generator exits non-zero and the doc never ships incomplete — but
 * we want the failure to surface inside CI long before someone runs the
 * generator. This test asserts the invariant directly.
 *
 * Note: imports the BUILT shared package, matching how the generator loads
 * it. `pnpm -w build` must be green before this test runs (jest's ts-jest
 * pipeline doesn't recompile `packages/shared`).
 */
import { describe, test, expect } from '@jest/globals';
import { TOOL_SCHEMAS, TOOL_CATEGORIES, TOOL_CATEGORY_ORDER } from 'humanchrome-shared';

describe('TOOL_CATEGORIES coverage', () => {
  test('every tool in TOOL_SCHEMAS has a TOOL_CATEGORIES entry', () => {
    const missing = TOOL_SCHEMAS.map((tool) => tool.name).filter(
      (name) => !Object.prototype.hasOwnProperty.call(TOOL_CATEGORIES, name),
    );
    expect(missing).toEqual([]);
  });

  test('every category referenced in TOOL_CATEGORIES appears in TOOL_CATEGORY_ORDER', () => {
    const known = new Set(TOOL_CATEGORY_ORDER);
    const orphan = Array.from(new Set(Object.values(TOOL_CATEGORIES))).filter(
      (cat) => !known.has(cat),
    );
    // If this fails, either add the new category to TOOL_CATEGORY_ORDER (so
    // the doc generator places it in a stable position) or rename the
    // category in TOOL_CATEGORIES to one of the known labels.
    expect(orphan).toEqual([]);
  });

  test('TOOL_CATEGORIES does not list tools that are absent from TOOL_SCHEMAS', () => {
    // Stale entries here mean the map drifted out of sync with the schemas
    // (e.g. a tool was renamed/removed). Catch it so the generator output
    // stays clean.
    const schemaNames = new Set(TOOL_SCHEMAS.map((t) => t.name));
    const stale = Object.keys(TOOL_CATEGORIES).filter((name) => !schemaNames.has(name));
    expect(stale).toEqual([]);
  });
});
