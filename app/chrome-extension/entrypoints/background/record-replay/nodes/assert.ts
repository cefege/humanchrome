import { TOOL_NAMES } from 'humanchrome-shared';
import { handleCallTool } from '@/entrypoints/background/tools';
import type { StepAssert } from '../legacy-types';
import { expandTemplatesDeep } from '../rr-utils';
import type { ExecCtx, ExecResult, NodeRuntime } from './types';

interface SelectorResolveResponse {
  success?: boolean;
  center?: { x: number; y: number };
  [k: string]: unknown;
}

interface AttributeResponse {
  success?: boolean;
  value?: string | null;
  [k: string]: unknown;
}

export const assertNode: NodeRuntime<StepAssert> = {
  validate: (step: StepAssert) => {
    const ok = !!step.assert;
    if (ok && 'attribute' in step.assert) {
      const a = step.assert.attribute;
      if (!a.selector || !a.name) {
        return { ok: false, errors: ['assert.attribute: selector and name are required'] };
      }
    }
    return ok ? { ok } : { ok, errors: ['Missing assertion condition'] };
  },
  run: async (ctx: ExecCtx, step: StepAssert) => {
    const s = expandTemplatesDeep<StepAssert>(step, ctx.vars);
    const failStrategy = s.failStrategy || 'stop';
    const fail = (msg: string): ExecResult => {
      if (failStrategy === 'warn') {
        ctx.logger({ stepId: step.id, status: 'warning', message: msg });
        return { alreadyLogged: true };
      }
      throw new Error(msg);
    };
    if ('textPresent' in s.assert) {
      const text = s.assert.textPresent;
      const res = await handleCallTool({
        name: TOOL_NAMES.BROWSER.COMPUTER,
        args: { action: 'wait', text, appear: true, timeout: step.timeoutMs || 5000 },
      });
      if ((res as { isError?: boolean }).isError) return fail('assert text failed');
    } else if ('exists' in s.assert || 'visible' in s.assert) {
      const selector = 'exists' in s.assert ? s.assert.exists : s.assert.visible;
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const firstTab = tabs && tabs[0];
      const tabId = firstTab && typeof firstTab.id === 'number' ? firstTab.id : undefined;
      if (!tabId) return fail('Active tab not found');
      await handleCallTool({ name: TOOL_NAMES.BROWSER.READ_PAGE, args: {} });
      const ensured = (await chrome.tabs.sendMessage(
        tabId,
        { action: 'ensureRefForSelector', selector },
        { frameId: ctx.frameId },
      )) as SelectorResolveResponse;
      if (!ensured || !ensured.success) return fail('assert selector not found');
      if ('visible' in s.assert) {
        const rect = ensured.center ?? null;
        if (!rect) return fail('assert visible failed');
      }
    } else if ('attribute' in s.assert) {
      const { selector, name, equals, matches } = s.assert.attribute;
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const firstTab = tabs && tabs[0];
      const tabId = firstTab && typeof firstTab.id === 'number' ? firstTab.id : undefined;
      if (!tabId) return fail('Active tab not found');
      await handleCallTool({ name: TOOL_NAMES.BROWSER.READ_PAGE, args: {} });
      const resp = (await chrome.tabs.sendMessage(
        tabId,
        { action: 'getAttributeForSelector', selector, name },
        { frameId: ctx.frameId },
      )) as AttributeResponse;
      if (!resp || !resp.success) return fail('assert attribute: element not found');
      const actual: string | null = resp.value ?? null;
      if (equals !== undefined && equals !== null) {
        const expected = String(equals);
        if (String(actual) !== String(expected)) {
          return fail(
            `assert attribute equals failed: ${name} actual=${String(actual)} expected=${String(expected)}`,
          );
        }
      } else if (matches !== undefined && matches !== null) {
        try {
          const re = new RegExp(String(matches));
          if (!re.test(String(actual))) {
            return fail(
              `assert attribute matches failed: ${name} actual=${String(actual)} regex=${String(matches)}`,
            );
          }
        } catch {
          return fail(`invalid regex for attribute matches: ${String(matches)}`);
        }
      } else {
        if (actual == null) return fail(`assert attribute failed: ${name} missing`);
      }
    }
    return {} as ExecResult;
  },
};
