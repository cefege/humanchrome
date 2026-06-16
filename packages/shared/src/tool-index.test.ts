import { describe, it, expect } from 'vitest';
import {
  DISPATCHER_TOOL_NAME,
  buildDispatcherDescription,
  buildDispatcherTool,
  buildToolHelp,
  knownToolNames,
  isKnownToolName,
  resolveToolName,
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
      expect(desc).toContain(`- ${t.name}`);
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
      .map((l) => l.slice(2).trim());
    const sorted = [...lines].sort((a, b) => a.localeCompare(b));
    expect(lines).toEqual(sorted);
  });

  it('description shrinks the boot manifest at least 10× vs raw TOOL_SCHEMAS', () => {
    const rawSize = JSON.stringify(TOOL_SCHEMAS).length;
    const dispatcherSize = JSON.stringify(buildDispatcherTool()).length;
    expect(dispatcherSize).toBeLessThan(rawSize / 10);
  });

  it('description fits inside common MCP-client display caps (BUG-003)', () => {
    // Claude Code's tool-list renderer truncates around ~2 KB. The previous
    // verb-phrase catalog was ~11 KB and hid ~80% of the catalog. Hold the
    // names-only catalog under 3 KB so future growth fails CI before it
    // silently disappears from clients again.
    const desc = buildDispatcherDescription();
    expect(desc.length).toBeLessThan(3000);
  });

  it('chrome_help is part of the catalog', () => {
    const desc = buildDispatcherDescription();
    expect(desc).toContain('- chrome_help');
    expect(desc).toContain('chrome_help(');
  });

  it('buildToolHelp() returns one summary per TOOL_SCHEMAS entry, sorted', () => {
    const help = buildToolHelp() as { tools: { name: string; summary: string }[] };
    expect(Array.isArray(help.tools)).toBe(true);
    expect(help.tools).toHaveLength(TOOL_SCHEMAS.length);
    const names = help.tools.map((t) => t.name);
    expect([...names].sort()).toEqual(names);
    // Every entry has a non-empty summary (verb-phrase recovered from the
    // original first-sentence trimming).
    for (const t of help.tools) {
      expect(typeof t.summary).toBe('string');
      expect(t.summary.length).toBeGreaterThan(0);
    }
  });

  it('buildToolHelp(name) returns the full description for a known tool', () => {
    const target = TOOL_SCHEMAS[0];
    const help = buildToolHelp(target.name) as {
      name: string;
      summary: string;
      description: string;
    };
    expect(help.name).toBe(target.name);
    expect(help.description).toBe(target.description);
    expect(help.summary.length).toBeGreaterThan(0);
  });

  it('buildToolHelp(unknown) reports found:false', () => {
    const help = buildToolHelp('not_a_real_tool') as { name: string; found: boolean };
    expect(help.found).toBe(false);
    expect(help.name).toBe('not_a_real_tool');
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

  it('resolveToolName accepts canonical names verbatim (idempotent)', () => {
    expect(resolveToolName('chrome_get_windows_and_tabs')).toBe('chrome_get_windows_and_tabs');
    expect(resolveToolName('browser_claim_tab')).toBe('browser_claim_tab');
  });

  it('resolveToolName expands chrome_-prefix legacy short names', () => {
    expect(resolveToolName('get_windows_and_tabs')).toBe('chrome_get_windows_and_tabs');
    expect(resolveToolName('javascript')).toBe('chrome_javascript');
    expect(resolveToolName('read_page')).toBe('chrome_read_page');
  });

  it('resolveToolName expands browser_-prefix legacy short names', () => {
    expect(resolveToolName('claim_tab')).toBe('browser_claim_tab');
    expect(resolveToolName('close_my_tabs')).toBe('browser_close_my_tabs');
    expect(resolveToolName('alias_tab')).toBe('browser_alias_tab');
  });

  it('resolveToolName returns null for far-off input', () => {
    expect(resolveToolName('zzzz_unknown_tool_xyz')).toBeNull();
  });

  it('resolveToolName returns null for empty or non-string input', () => {
    expect(resolveToolName('')).toBeNull();
    expect(resolveToolName(undefined as unknown as string)).toBeNull();
  });

  it('resolveToolName considers dynamic extras', () => {
    expect(resolveToolName('flow.foo', ['flow.foo'])).toBe('flow.foo');
    expect(resolveToolName('foo', ['flow.foo'])).toBeNull();
  });

  it('buildToolHelp({query}) ranks click-like names ahead of unrelated tools', () => {
    const out = buildToolHelp({ query: 'click' }) as {
      query: string;
      matches: Array<{ name: string; summary: string; score: number }>;
    };
    expect(out.query).toBe('click');
    expect(out.matches.length).toBeGreaterThan(0);
    // chrome_click_element has "click" as a name token, so it must rank first.
    expect(out.matches[0].name).toBe('chrome_click_element');
    // Scores are descending.
    for (let i = 1; i < out.matches.length; i++) {
      expect(out.matches[i].score).toBeLessThanOrEqual(out.matches[i - 1].score);
    }
  });

  it('buildToolHelp({query}) tolerates short typos via edit-distance bonus', () => {
    const out = buildToolHelp({ query: 'clik' }) as {
      matches: Array<{ name: string; score: number }>;
    };
    expect(out.matches.length).toBeGreaterThan(0);
    expect(out.matches.some((m) => m.name === 'chrome_click_element')).toBe(true);
  });

  it('buildToolHelp({query, limit}) caps results', () => {
    const out = buildToolHelp({ query: 'tab', limit: 3 }) as {
      matches: Array<{ name: string }>;
    };
    expect(out.matches.length).toBeLessThanOrEqual(3);
  });

  it('buildToolHelp({query}) ranks the canonical humanchrome tool first for Playwright vocabulary', () => {
    const cases: Array<[string, string]> = [
      ['browser_click', 'chrome_click_element'],
      ['page.click', 'chrome_click_element'],
      ['page.goto', 'chrome_navigate'],
      ['browser_navigate', 'chrome_navigate'],
      ['browser_snapshot', 'chrome_aria_snapshot'],
      ['browser_press_key', 'chrome_keyboard'],
      ['locator.fill', 'chrome_fill_or_select'],
      ['browser_take_screenshot', 'chrome_screenshot'],
      ['browser_console_messages', 'chrome_console'],
      ['page.hover', 'chrome_hover'],
      ['page.pdf', 'chrome_print_to_pdf'],
      ['browser_file_upload', 'chrome_upload_file'],
      ['browser_handle_dialog', 'chrome_handle_dialog'],
      ['browser_select_option', 'chrome_combobox_select'],
    ];
    for (const [query, expected] of cases) {
      const out = buildToolHelp({ query }) as {
        matches: Array<{ name: string }>;
      };
      expect(out.matches[0]?.name, `query "${query}" should rank "${expected}" first`).toBe(
        expected,
      );
    }
  });

  it('buildToolHelp({query}) returns empty matches for a query that hits nothing', () => {
    const out = buildToolHelp({ query: 'zzzzz_no_such_thing_xyz' }) as {
      matches: unknown[];
    };
    expect(out.matches).toEqual([]);
  });

  it('buildToolHelp({name}) still returns full description for a known tool', () => {
    const out = buildToolHelp({ name: 'chrome_help' }) as Record<string, unknown>;
    expect(out.name).toBe('chrome_help');
    expect(typeof out.description).toBe('string');
    expect((out.description as string).length).toBeGreaterThan(0);
  });

  it('buildToolHelp({}) returns the full sorted catalog', () => {
    const out = buildToolHelp({}) as { tools: Array<{ name: string }> };
    expect(out.tools.length).toBe(TOOL_SCHEMAS.length);
    const names = out.tools.map((t) => t.name);
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
  });

  it('resolveToolName has no ambiguous chrome_/browser_ collisions today', () => {
    // Guard for future drift: if a short name ever exists with both prefixes,
    // this test fails and forces an explicit policy choice (hard-coded alias
    // map) rather than silently preferring chrome_*.
    const names = knownToolNames();
    const chromeShorts = new Set(
      names.filter((n) => n.startsWith('chrome_')).map((n) => n.slice('chrome_'.length)),
    );
    const browserShorts = new Set(
      names.filter((n) => n.startsWith('browser_')).map((n) => n.slice('browser_'.length)),
    );
    const overlap = [...chromeShorts].filter((s) => browserShorts.has(s));
    expect(overlap).toEqual([]);
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

  it('every catalog line is a clean "- <name>" with no trailing colon or blank tail', () => {
    // BUG-003: catalog is names-only now. Lines must be exactly "- <name>"
    // (no trailing colon, no leftover verb-phrase whitespace). Verb-phrases
    // are recovered on demand via `chrome_help`.
    const desc = buildDispatcherDescription();
    const toolLines = desc.split('\n').filter((l) => l.startsWith('- '));
    for (const line of toolLines) {
      expect(line).toMatch(/^- [a-z_.]+$/);
    }
  });
});
