import { describe, it, expect } from 'vitest';
import {
  DISPATCHER_TOOL_NAME,
  buildDispatcherDescription,
  buildDispatcherTool,
  knownToolNames,
  isKnownToolName,
  suggestToolName,
} from './tool-index';
import { TOOL_SCHEMAS } from './tools';

describe('tool-index — dispatcher catalog', () => {
  it('DISPATCHER_TOOL_NAME is "humanchrome" (stable contract)', () => {
    expect(DISPATCHER_TOOL_NAME).toBe('humanchrome');
  });

  it('buildDispatcherTool produces a valid Tool descriptor', () => {
    const t = buildDispatcherTool();
    expect(t.name).toBe('humanchrome');
    expect(t.description).toContain('humanchrome');
    expect(t.inputSchema.type).toBe('object');
    expect((t.inputSchema as any).properties.name).toBeDefined();
    expect((t.inputSchema as any).properties.args).toBeDefined();
    expect((t.inputSchema as any).properties.raw).toBeDefined();
    expect((t.inputSchema as any).required).toEqual(['name']);
  });

  it('description contains every TOOL_SCHEMAS entry', () => {
    const desc = buildDispatcherDescription();
    for (const t of TOOL_SCHEMAS) {
      expect(desc).toContain(`- ${t.name}:`);
    }
  });

  it('description is byte-stable across calls (IMP-0181 prereq)', () => {
    const a = buildDispatcherDescription();
    const b = buildDispatcherDescription();
    expect(a).toBe(b);
  });

  it('tools are sorted by name in the description', () => {
    const desc = buildDispatcherDescription();
    const lines = desc
      .split('\n')
      .filter((l) => l.startsWith('- '))
      .map((l) => l.slice(2).split(':')[0]);
    const sorted = [...lines].sort((a, b) => a.localeCompare(b));
    expect(lines).toEqual(sorted);
  });

  it('description shrinks the boot manifest at least 10× vs raw TOOL_SCHEMAS', () => {
    const desc = buildDispatcherDescription();
    const rawSize = JSON.stringify(TOOL_SCHEMAS).length;
    const dispatcherSize = JSON.stringify(buildDispatcherTool()).length;
    expect(dispatcherSize).toBeLessThan(rawSize / 10);
  });

  it('knownToolNames is sorted and covers all TOOL_SCHEMAS', () => {
    const names = knownToolNames();
    expect(names).toHaveLength(TOOL_SCHEMAS.length);
    expect([...names].sort()).toEqual(names);
  });

  it('isKnownToolName accepts known + rejects unknown', () => {
    const first = TOOL_SCHEMAS[0].name;
    expect(isKnownToolName(first)).toBe(true);
    expect(isKnownToolName('not_a_real_tool')).toBe(false);
  });

  it('suggestToolName returns close match', () => {
    const first = TOOL_SCHEMAS[0].name;
    const typo = first.slice(0, -1);
    expect(suggestToolName(typo)).toBe(first);
  });

  it('suggestToolName returns null for far-off input', () => {
    expect(suggestToolName('zzzzzzz_xyz_nothing')).toBeNull();
  });

  it('suggestToolName includes extra dynamic names in the search', () => {
    expect(suggestToolName('flo.checkout', ['flow.checkout'])).toBe('flow.checkout');
  });

  it('description first-sentence trim does not produce empty lines', () => {
    const desc = buildDispatcherDescription();
    const toolLines = desc.split('\n').filter((l) => l.startsWith('- '));
    for (const line of toolLines) {
      // Format: "- <name>: <first-sentence>" — sentence may be empty for
      // tools without descriptions, but the line still must start with
      // "- <name>:" (no trailing colon-newline blank).
      expect(line).toMatch(/^- [a-z_.]+:/);
    }
  });
});
