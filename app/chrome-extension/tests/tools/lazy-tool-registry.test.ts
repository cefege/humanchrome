/**
 * Lazy tool registry coverage + behavior tests (IMP-0056, revised in #216).
 *
 * Locks the dispatcher contract:
 *
 *   1. Every tool name from `humanchrome-shared`'s TOOL_NAMES is
 *      reachable through the dispatcher (eager OR lazy). This is the
 *      drift guard — if a future PR adds a TOOL_NAMES entry but
 *      forgets to register a loader, this test fails loudly instead
 *      of the call returning a runtime "Tool ... not found" error.
 *
 *   2. The remaining lazy tools (screenshot, network-capture-debugger,
 *      intercept-response, computer, gif-recorder, search_tabs_content)
 *      keep their lazy registration. Bug #216 forced JAVASCRIPT,
 *      READ_PAGE, USERSCRIPT, PERFORMANCE_*, REQUEST_ELEMENT_SELECTION
 *      back into the eager half because Chrome rejects dynamic `import()`
 *      of new module chunks from a service worker (even with
 *      `type: "module"` — see https://github.com/w3c/ServiceWorker/issues/1356).
 *      The lazy half only stays viable for tools whose chunks happen to
 *      land back in background.js, so we keep the registration but no
 *      longer assert "must be in lazy" — that invariant became a footgun.
 */

import { describe, expect, it, vi } from 'vitest';
import { TOOL_NAMES } from 'humanchrome-shared';

import {
  listRegisteredToolNames,
  _resetLazyToolCacheForTest,
} from '@/entrypoints/background/tools';

describe('lazy tool registry (IMP-0056)', () => {
  it('registers a handler for every TOOL_NAMES.BROWSER entry', () => {
    const registered = new Set(listRegisteredToolNames());
    const expected = Object.values(TOOL_NAMES.BROWSER) as string[];

    const missing = expected.filter((name) => !registered.has(name));
    expect(missing).toEqual([]);
  });

  it('registers a handler for every TOOL_NAMES.RECORD_REPLAY entry', () => {
    const registered = new Set(listRegisteredToolNames());
    const expected = Object.values(TOOL_NAMES.RECORD_REPLAY) as string[];

    const missing = expected.filter((name) => !registered.has(name));
    expect(missing).toEqual([]);
  });

  it('does not register names outside TOOL_NAMES (no orphaned loaders)', () => {
    const registered = new Set(listRegisteredToolNames());
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

describe('lazy tools — chunks that still land back in background.js', () => {
  // After bug #216, only tools whose chunks happen to fold back into
  // background.js can stay lazy. Each entry below is verified to be a
  // wrapper that either lives in background.js directly OR pulls a
  // chunk that ends up alongside it after Rolldown's hoist pass. If a
  // future build splits one of these into its own chunk (visible as a
  // separate file under .output/chrome-mv3/chunks/), promote it to the
  // eager block in tools/index.ts the same way #216 did for
  // javascript/read-page/userscript/performance/element-picker.
  const STILL_LAZY = [
    TOOL_NAMES.BROWSER.SCREENSHOT,
    // SEARCH_TABS_CONTENT was promoted to eager by IMP-0122 — its ML
    // graph (transformers + onnxruntime + hnswlib-wasm-static) now lives
    // in the offscreen page and the SW tool is a thin RPC shim that
    // statically imports cleanly.
    TOOL_NAMES.BROWSER.NETWORK_DEBUGGER_START,
    TOOL_NAMES.BROWSER.NETWORK_DEBUGGER_STOP,
    TOOL_NAMES.BROWSER.INTERCEPT_RESPONSE,
    TOOL_NAMES.BROWSER.COMPUTER,
    TOOL_NAMES.BROWSER.GIF_RECORDER,
  ];

  it('source: each still-lazy tool is wired through a lazyLoaders entry', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../entrypoints/background/tools/index.ts'),
      'utf8',
    );

    for (const toolName of STILL_LAZY) {
      const key = (Object.entries(TOOL_NAMES.BROWSER).find(([, v]) => v === toolName) ?? [])[0];
      expect(key, `no TOOL_NAMES.BROWSER key matches ${toolName}`).toBeDefined();
      const marker = `[TOOL_NAMES.BROWSER.${key}]`;
      const hasLazyEntry = new RegExp(
        `\\[TOOL_NAMES\\.BROWSER\\.${key}\\]:\\s*async\\s*\\(\\)\\s*=>`,
      ).test(src);
      expect(hasLazyEntry, `${marker} should be in lazyLoaders`).toBe(true);
    }
  });

  it('source: bug #216 promotions are statically imported (eager)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../entrypoints/background/tools/index.ts'),
      'utf8',
    );

    // Each path below got its own Rolldown chunk in the build that
    // triggered bug #216. Chrome refuses `import()` of new chunks from
    // a service worker, so these MUST be static imports — otherwise the
    // tool returns the "import() is disallowed on ServiceWorkerGlobalScope"
    // error at call time.
    const PROMOTED_PATHS = [
      './browser/javascript',
      './browser/read-page',
      './browser/userscript',
      './browser/performance',
      './browser/element-picker',
      // IMP-0122 promotion: ML graph moved to offscreen, SW import is safe.
      './browser/vector-search',
    ];

    for (const promoted of PROMOTED_PATHS) {
      const escaped = promoted.replace(/\./g, '\\.');
      // Accept both single-line (`import { foo } from './x';`) and
      // multi-line forms where the `from` is on its own line.
      const staticImport = new RegExp(`\\bfrom\\s+['"]${escaped}['"]`);
      expect(staticImport.test(src), `${promoted} must be a static import after bug #216`).toBe(
        true,
      );
      // And NOT also referenced inside an `import(...)` call — that would
      // be a leftover that confuses readers about which side wins.
      const dynamicImport = new RegExp(`import\\(['"]${escaped}['"]\\)`);
      expect(
        dynamicImport.test(src),
        `${promoted} must not also have a dynamic import() call`,
      ).toBe(false);
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
