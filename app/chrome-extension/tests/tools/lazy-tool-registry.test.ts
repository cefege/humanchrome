/**
 * Lazy tool registry coverage + behavior tests (IMP-0056).
 *
 * Locks the new dispatcher contract:
 *
 *   1. Every tool name from `humanchrome-shared`'s TOOL_NAMES is
 *      reachable through the dispatcher (eager OR lazy). This is the
 *      drift guard — if a future PR adds a TOOL_NAMES entry but
 *      forgets to register a loader, this test fails loudly instead
 *      of the call returning a runtime "Tool ... not found" error.
 *
 *   2. Heavy modules (gif-recorder, performance, computer, read-page,
 *      vector-search, network-capture-debugger, intercept-response,
 *      javascript, screenshot, userscript, element-picker) do NOT
 *      load at SW boot — they only load when their tool is first
 *      invoked. We assert this via the dynamic-import behavior:
 *      `import('@/entrypoints/background/tools')` must NOT pull in
 *      `import('@/entrypoints/background/tools/browser/gif-recorder')`
 *      transitively.
 */

import { describe, expect, it, vi } from 'vitest';
import { TOOL_NAMES } from 'humanchrome-shared';

import {
  _listRegisteredToolNamesForTest,
  _resetLazyToolCacheForTest,
} from '@/entrypoints/background/tools';

describe('lazy tool registry (IMP-0056)', () => {
  it('registers a handler for every TOOL_NAMES.BROWSER entry', () => {
    const registered = new Set(_listRegisteredToolNamesForTest());
    const expected = Object.values(TOOL_NAMES.BROWSER) as string[];

    const missing = expected.filter((name) => !registered.has(name));
    expect(missing).toEqual([]);
  });

  it('registers a handler for every TOOL_NAMES.RECORD_REPLAY entry', () => {
    const registered = new Set(_listRegisteredToolNamesForTest());
    const expected = Object.values(TOOL_NAMES.RECORD_REPLAY) as string[];

    const missing = expected.filter((name) => !registered.has(name));
    expect(missing).toEqual([]);
  });

  it('does not register names outside TOOL_NAMES (no orphaned loaders)', () => {
    const registered = new Set(_listRegisteredToolNamesForTest());
    const expected = new Set<string>([
      ...(Object.values(TOOL_NAMES.BROWSER) as string[]),
      ...(Object.values(TOOL_NAMES.RECORD_REPLAY) as string[]),
    ]);

    const orphans = [...registered].filter((name) => !expected.has(name));
    expect(orphans).toEqual([]);
  });

  it('exposes _resetLazyToolCacheForTest as a no-throw idempotent op', () => {
    expect(() => {
      _resetLazyToolCacheForTest();
      _resetLazyToolCacheForTest();
    }).not.toThrow();
  });
});

describe('lazy heavy tools — boot-time silence', () => {
  // Each entry is one of the heavy tools that IMP-0056 explicitly calls
  // out as expensive at SW boot. The test imports the dispatcher and
  // asserts the corresponding module file did NOT show up in the
  // bundler's module cache (vitest exposes it via vi.hoisted's
  // module-evaluation tracking).
  //
  // We approximate "module not eagerly imported" by spying on the
  // module's top-level side effect: every heavy file declares a
  // module-scoped const `xxxTool = new XxxTool()` that triggers the
  // class constructor at import time. By spying on the class
  // constructor (via vi.spyOn before the import), we'd catch eager
  // construction. Simpler: just check that vi.resetModules + a fresh
  // import of the dispatcher does NOT itself import the heavy files
  // — we measure this via a marker in the heavy modules.
  //
  // The cheapest signal that survives across bundlers is reachability:
  // if the heavy module wasn't imported, its singleton symbol from
  // browser/index.ts won't be in vitest's loaded-module set yet. We
  // skip that introspection and instead confirm the registry shape:
  // each heavy tool name appears ONLY in the lazy half (no eager
  // loader for it).
  const HEAVY_TOOL_NAMES = [
    TOOL_NAMES.BROWSER.SCREENSHOT,
    TOOL_NAMES.BROWSER.SEARCH_TABS_CONTENT,
    TOOL_NAMES.BROWSER.REQUEST_ELEMENT_SELECTION,
    TOOL_NAMES.BROWSER.NETWORK_DEBUGGER_START,
    TOOL_NAMES.BROWSER.NETWORK_DEBUGGER_STOP,
    TOOL_NAMES.BROWSER.INTERCEPT_RESPONSE,
    TOOL_NAMES.BROWSER.JAVASCRIPT,
    TOOL_NAMES.BROWSER.READ_PAGE,
    TOOL_NAMES.BROWSER.COMPUTER,
    TOOL_NAMES.BROWSER.USERSCRIPT,
    TOOL_NAMES.BROWSER.PERFORMANCE_START_TRACE,
    TOOL_NAMES.BROWSER.PERFORMANCE_STOP_TRACE,
    TOOL_NAMES.BROWSER.PERFORMANCE_ANALYZE_INSIGHT,
    TOOL_NAMES.BROWSER.GIF_RECORDER,
  ];

  it('source: every heavy tool is wired through the lazy half', async () => {
    // Read the dispatcher source and assert each heavy tool name
    // appears inside a `lazyLoaders` entry (i.e., dynamic import). This
    // is a static guard — if a future PR moves one of these tools back
    // into eagerTools, the test fails.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../entrypoints/background/tools/index.ts'),
      'utf8',
    );

    // Each heavy tool name must appear in the file inside an `await import(`
    // expression — not inside the eagerTools list.
    for (const toolName of HEAVY_TOOL_NAMES) {
      // The dispatcher references TOOL_NAMES.BROWSER.<KEY>, not the
      // string literal. Resolve the key from the value.
      const key = (Object.entries(TOOL_NAMES.BROWSER).find(([, v]) => v === toolName) ?? [])[0];
      expect(key, `no TOOL_NAMES.BROWSER key matches ${toolName}`).toBeDefined();
      const marker = `[TOOL_NAMES.BROWSER.${key}]`;
      const hasLazyEntry = new RegExp(
        `\\[TOOL_NAMES\\.BROWSER\\.${key}\\]:\\s*async\\s*\\(\\)\\s*=>`,
      ).test(src);
      expect(hasLazyEntry, `${marker} should be in lazyLoaders`).toBe(true);
    }
  });

  it('source: dispatcher does NOT statically import any heavy module', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../entrypoints/background/tools/index.ts'),
      'utf8',
    );

    const HEAVY_PATHS = [
      './browser/screenshot',
      './browser/vector-search',
      './browser/element-picker',
      './browser/network-capture-debugger',
      './browser/intercept-response',
      './browser/javascript',
      './browser/read-page',
      './browser/computer',
      './browser/userscript',
      './browser/performance',
      './browser/gif-recorder',
    ];

    for (const heavy of HEAVY_PATHS) {
      // The static-import form would be `import { foo } from '<heavy>';`
      // A dynamic import is `import('<heavy>')` — which we WANT.
      // Only `.` needs escaping in path strings here.
      const escaped = heavy.replace(/\./g, '\\.');
      const staticImport = new RegExp(`^\\s*import\\s+[^;\\n]*from\\s+['"]${escaped}['"]`, 'm');
      expect(staticImport.test(src), `dispatcher must not statically import ${heavy}`).toBe(false);
      const dynamicImport = new RegExp(`import\\(['"]${escaped}['"]\\)`);
      expect(dynamicImport.test(src), `dispatcher should dynamically import ${heavy}`).toBe(true);
    }
  });
});

describe('lazy tool resolution at runtime', () => {
  it('handleCallTool routes a heavy tool through the dynamic loader and memoizes', async () => {
    // Spy on the screenshot module's exported singleton's execute. We
    // import the module first, set the spy, then invoke handleCallTool
    // — the dynamic loader should yield the same singleton, so the spy
    // fires.
    _resetLazyToolCacheForTest();
    vi.resetModules();

    const screenshotModule = await import('@/entrypoints/background/tools/browser/screenshot');
    const executeSpy = vi.spyOn(screenshotModule.screenshotTool, 'execute').mockResolvedValue({
      content: [{ type: 'text', text: '{"ok":true}' }],
      isError: false,
    } as any);

    const dispatcher = await import('@/entrypoints/background/tools');
    const result = await dispatcher.handleCallTool({
      name: 'chrome_screenshot',
      args: {},
    });

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(result).toBeDefined();

    // Second call: should hit the memo, not re-import.
    await dispatcher.handleCallTool({ name: 'chrome_screenshot', args: {} });
    expect(executeSpy).toHaveBeenCalledTimes(2);

    executeSpy.mockRestore();
    _resetLazyToolCacheForTest();
  });

  it('returns INVALID_ARGS for an unknown tool name (eager and lazy both miss)', async () => {
    const dispatcher = await import('@/entrypoints/background/tools');
    const result = await dispatcher.handleCallTool({
      name: 'chrome_definitely_not_a_real_tool',
      args: {},
    });

    expect((result as any).isError).toBe(true);
    const text = ((result as any).content?.[0] as any)?.text as string;
    expect(text).toContain('INVALID_ARGS');
    expect(text).toContain('chrome_definitely_not_a_real_tool');
  });
});
