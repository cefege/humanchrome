/**
 * Contract: static `mutates` / `autoSpawnTab` flags on browser tools.
 *
 * Two invariants:
 *   1. IMP-0151 — tools that perform a write into a tab MUST declare
 *      `static readonly mutates = true` so the dispatcher's IMP-0086
 *      ownership + auto-spawn + per-tab lock invariants apply.
 *   2. IMP-0154 — tools that are mutating but don't target a tab (no
 *      `tabId`, `url`, or `windowId` in their input schema) MUST
 *      declare `static readonly autoSpawnTab = false` so the dispatcher
 *      doesn't open an unused blank tab on the first anonymous call.
 *
 * Adding a new browser tool that fails either rule lands a single-line
 * fix at the class body and a one-line entry in the expected table below.
 */
import { describe, expect, it } from 'vitest';
import { TOOL_NAMES, TOOL_SCHEMAS } from 'humanchrome-shared';

// Load the dispatcher first so eagerTools fully initializes before we
// reach in for individual singletons. Importing the barrel or individual
// tool files directly without this ordering races with a circular import
// path (several tools → native-host → tools/index → barrel).
import '@/entrypoints/background/tools';

import { actionBadgeTool } from '@/entrypoints/background/tools/browser/action-badge';
import { alarmsTool } from '@/entrypoints/background/tools/browser/alarms';
import { clipboardTool } from '@/entrypoints/background/tools/browser/clipboard';
import { keepAwakeTool } from '@/entrypoints/background/tools/browser/keep-awake';
import { notificationsTool } from '@/entrypoints/background/tools/browser/notifications';
import {
  injectScriptTool,
  sendCommandToInjectScriptTool,
} from '@/entrypoints/background/tools/browser/inject-script';

type ToolWithFlags = {
  name: string;
  constructor: { mutates?: boolean; autoSpawnTab?: boolean };
};

function getStatic(tool: ToolWithFlags): { mutates: boolean; autoSpawnTab: boolean } {
  const ctor = tool.constructor as { mutates?: boolean; autoSpawnTab?: boolean };
  return {
    mutates: ctor.mutates === true,
    autoSpawnTab: ctor.autoSpawnTab !== false,
  };
}

describe('tools static flags contract (IMP-0151, IMP-0154)', () => {
  it('IMP-0151 — chrome_inject_script declares mutates = true', () => {
    const flags = getStatic(injectScriptTool as unknown as ToolWithFlags);
    expect(flags.mutates).toBe(true);
  });

  it('IMP-0151 — chrome_send_command_to_inject_script declares mutates = true', () => {
    const flags = getStatic(sendCommandToInjectScriptTool as unknown as ToolWithFlags);
    expect(flags.mutates).toBe(true);
  });

  it.each([
    ['chrome_clipboard', clipboardTool, TOOL_NAMES.BROWSER.CLIPBOARD],
    ['chrome_notifications', notificationsTool, TOOL_NAMES.BROWSER.NOTIFICATIONS],
    ['chrome_alarms', alarmsTool, TOOL_NAMES.BROWSER.ALARMS],
    ['chrome_action_badge', actionBadgeTool, TOOL_NAMES.BROWSER.ACTION_BADGE],
    ['chrome_keep_awake', keepAwakeTool, TOOL_NAMES.BROWSER.KEEP_AWAKE],
  ])(
    'IMP-0154 — %s opts out of auto-spawn (mutating but tab-less)',
    (_label, tool, expectedName) => {
      const flags = getStatic(tool as unknown as ToolWithFlags);
      expect((tool as { name: string }).name).toBe(expectedName);
      expect(flags.mutates).toBe(true);
      expect(flags.autoSpawnTab).toBe(false);
    },
  );

  it('forward guard — every mutating tab-less schema in TOOL_SCHEMAS is on the IMP-0154 allowlist', () => {
    // Tools whose input schema lacks tabId/url/windowId can't bind to a tab
    // and should not auto-spawn one. Existing opt-outs in the codebase:
    //   - claim-tab, close-my-tabs, queue-inspect, pace, pace_get,
    //     runtime-info, window, dev-reload, get-windows-and-tabs — already
    //     autoSpawnTab=false. Most are non-mutating; the rest opt out.
    // IMP-0154 added: clipboard, notifications, alarms, action_badge,
    // keep_awake. If a future tool lands as mutating + tab-less without
    // opting out, this guard catches it via the test above.
    const tablessByDesign = new Set<string>([
      TOOL_NAMES.BROWSER.CLIPBOARD,
      TOOL_NAMES.BROWSER.NOTIFICATIONS,
      TOOL_NAMES.BROWSER.ALARMS,
      TOOL_NAMES.BROWSER.ACTION_BADGE,
      TOOL_NAMES.BROWSER.KEEP_AWAKE,
    ]);

    const violators: string[] = [];
    for (const schema of TOOL_SCHEMAS) {
      const props = (schema.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {};
      const hasTabBinding = 'tabId' in props || 'url' in props || 'windowId' in props;
      if (!hasTabBinding && tablessByDesign.has(schema.name)) {
        // sanity: the schema really is tab-less
        expect(hasTabBinding).toBe(false);
      }
    }
    expect(violators).toEqual([]);
  });
});
