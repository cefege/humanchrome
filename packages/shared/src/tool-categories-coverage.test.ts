import { describe, expect, it } from 'vitest';
import { TOOL_CATEGORIES, TOOL_CATEGORY_ORDER, TOOL_SCHEMAS } from './tools';

describe('tool categories contract', () => {
  it('maps every declared tool exactly once to a declared category', () => {
    const toolNames = TOOL_SCHEMAS.map(({ name }) => name);
    expect(new Set(toolNames)).toHaveLength(toolNames.length);
    expect(Object.keys(TOOL_CATEGORIES).sort()).toEqual([...toolNames].sort());
    expect(Object.values(TOOL_CATEGORIES).every((category) => TOOL_CATEGORY_ORDER.includes(category))).toBe(true);
  });
});
