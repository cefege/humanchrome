import { TOOL_NAMES } from 'humanchrome-shared';
import { handleCallTool } from '@/entrypoints/background/tools';
import type { ExecCtx, ExecResult, NodeRuntime } from './types';
import { expandTemplatesDeep } from '../rr-utils';
import type {
  StepHandleDownload,
  StepLoopElements,
  StepScreenshot,
  StepSetAttribute,
  StepSwitchFrame,
  StepTriggerEvent,
} from '../legacy-types';
import { locateElement } from '../selector-engine';

interface ResolveRefResponse {
  selector?: string;
  [k: string]: unknown;
}

function getFirstTextContent(res: unknown): string | undefined {
  const r = res as { content?: Array<{ type?: string; text?: string }> };
  return r?.content?.find((c) => c.type === 'text')?.text;
}

export const handleDownloadNode: NodeRuntime<StepHandleDownload> = {
  run: async (ctx: ExecCtx, step: StepHandleDownload) => {
    const s = expandTemplatesDeep<StepHandleDownload>(step, ctx.vars);
    const args = {
      filenameContains: s.filenameContains || undefined,
      timeoutMs: Math.max(1000, Math.min(Number(s.timeoutMs ?? 60000), 300000)),
      waitForComplete: s.waitForComplete !== false,
    };
    const res = await handleCallTool({ name: TOOL_NAMES.BROWSER.HANDLE_DOWNLOAD, args });
    const text = getFirstTextContent(res);
    try {
      const payload = text ? JSON.parse(text) : null;
      if (s.saveAs && payload && payload.download) ctx.vars[s.saveAs] = payload.download;
    } catch {}
    return {} as ExecResult;
  },
};

export const screenshotNode: NodeRuntime<StepScreenshot> = {
  run: async (ctx: ExecCtx, step: StepScreenshot) => {
    const s = expandTemplatesDeep<StepScreenshot>(step, ctx.vars);
    const args: Record<string, unknown> = { name: 'workflow', storeBase64: true };
    if (s.fullPage) args.fullPage = true;
    if (s.selector && typeof s.selector === 'string' && s.selector.trim()) {
      args.selector = s.selector;
    }
    const res = await handleCallTool({ name: TOOL_NAMES.BROWSER.SCREENSHOT, args });
    const text = getFirstTextContent(res);
    try {
      const payload = text ? JSON.parse(text) : null;
      if (s.saveAs && payload && payload.base64Data) ctx.vars[s.saveAs] = payload.base64Data;
    } catch {}
    return {} as ExecResult;
  },
};

export const triggerEventNode: NodeRuntime<StepTriggerEvent> = {
  validate: (step: StepTriggerEvent) => {
    const ok =
      !!step?.target?.candidates?.length && typeof step?.event === 'string' && !!step.event;
    return ok ? { ok } : { ok, errors: ['Missing target selector or event type'] };
  },
  run: async (ctx: ExecCtx, step: StepTriggerEvent) => {
    const s = expandTemplatesDeep<StepTriggerEvent>(step, ctx.vars);
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs?.[0]?.id;
    if (typeof tabId !== 'number') throw new Error('Active tab not found');
    await handleCallTool({ name: TOOL_NAMES.BROWSER.READ_PAGE, args: {} });
    const located = await locateElement(tabId, s.target, ctx.frameId);
    const cssSelector = !located?.ref
      ? s.target.candidates?.find((c) => c.type === 'css' || c.type === 'attr')?.value
      : undefined;
    let sel = cssSelector;
    if (!sel && located?.ref) {
      try {
        const resolved = (await chrome.tabs.sendMessage(
          tabId,
          { action: 'resolveRef', ref: located.ref },
          { frameId: ctx.frameId },
        )) as ResolveRefResponse;
        sel = resolved?.selector;
      } catch {}
    }
    if (!sel) throw new Error('triggerEvent: selector not resolved');
    const ev = String(s.event || '').trim();
    const bubbles = s.bubbles !== false;
    const cancelable = s.cancelable === true;
    await chrome.scripting.executeScript({
      target: {
        tabId,
        frameIds: typeof ctx.frameId === 'number' ? [ctx.frameId] : undefined,
      },
      world: 'MAIN',
      func: (selector: string, type: string, b: boolean, c: boolean) => {
        try {
          const el = document.querySelector(selector);
          if (!el) return false;
          const e = new Event(type, { bubbles: b, cancelable: c });
          el.dispatchEvent(e);
          return true;
        } catch {
          return false;
        }
      },
      args: [sel, ev, bubbles, cancelable],
    });
    return {} as ExecResult;
  },
};

export const setAttributeNode: NodeRuntime<StepSetAttribute> = {
  validate: (step: StepSetAttribute) => {
    const ok = !!step?.target?.candidates?.length && typeof step?.name === 'string' && !!step.name;
    return ok ? { ok } : { ok, errors: ['Target selector and attribute name are required'] };
  },
  run: async (ctx: ExecCtx, step: StepSetAttribute) => {
    const s = expandTemplatesDeep<StepSetAttribute>(step, ctx.vars);
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs?.[0]?.id;
    if (typeof tabId !== 'number') throw new Error('Active tab not found');
    await handleCallTool({ name: TOOL_NAMES.BROWSER.READ_PAGE, args: {} });
    const located = await locateElement(tabId, s.target, ctx.frameId);
    const frameId = located?.frameId ?? ctx.frameId;
    const cssSelector = !located?.ref
      ? s.target.candidates?.find((c) => c.type === 'css' || c.type === 'attr')?.value
      : undefined;
    let sel = cssSelector;
    if (!sel && located?.ref) {
      try {
        const resolved = (await chrome.tabs.sendMessage(
          tabId,
          { action: 'resolveRef', ref: located.ref },
          { frameId },
        )) as ResolveRefResponse;
        sel = resolved?.selector;
      } catch {}
    }
    if (!sel) throw new Error('setAttribute: selector not resolved');
    const name = String(s.name || '');
    const value = s.value;
    const remove = s.remove === true;
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: typeof frameId === 'number' ? [frameId] : undefined },
      world: 'MAIN',
      func: (
        selector: string,
        attrName: string,
        attrValue: string | undefined,
        doRemove: boolean,
      ) => {
        try {
          const el = document.querySelector(selector);
          if (!el) return false;
          if (doRemove) el.removeAttribute(attrName);
          else el.setAttribute(attrName, String(attrValue ?? ''));
          return true;
        } catch {
          return false;
        }
      },
      args: [sel, name, value, remove],
    });
    return {} as ExecResult;
  },
};

export const switchFrameNode: NodeRuntime<StepSwitchFrame> = {
  run: async (ctx: ExecCtx, step: StepSwitchFrame) => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs?.[0]?.id;
    if (typeof tabId !== 'number') throw new Error('Active tab not found');
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    if (!Array.isArray(frames) || frames.length === 0) {
      ctx.frameId = undefined;
      return {} as ExecResult;
    }
    let target: chrome.webNavigation.GetAllFrameResultDetails | undefined;
    const idx = Number(step?.frame?.index ?? NaN);
    if (Number.isFinite(idx)) {
      const list = frames.filter((f) => f.frameId !== 0);
      target = list[Math.max(0, Math.min(list.length - 1, idx))];
    }
    const urlContains = String(step?.frame?.urlContains || '').trim();
    if (!target && urlContains) {
      target = frames.find((f) => typeof f.url === 'string' && f.url.includes(urlContains));
    }
    if (!target) ctx.frameId = undefined;
    else ctx.frameId = target.frameId;
    try {
      await handleCallTool({ name: TOOL_NAMES.BROWSER.READ_PAGE, args: {} });
    } catch {}
    ctx.logger({
      stepId: step.id,
      status: 'success',
      message: `frameId=${String(ctx.frameId ?? 'top')}`,
    });
    return {} as ExecResult;
  },
};

export const loopElementsNode: NodeRuntime<StepLoopElements> = {
  validate: (step: StepLoopElements) => {
    const ok =
      typeof step?.selector === 'string' &&
      !!step.selector &&
      typeof step?.subflowId === 'string' &&
      !!step.subflowId;
    return ok ? { ok } : { ok, errors: ['selector and subflowId are required'] };
  },
  run: async (ctx: ExecCtx, step: StepLoopElements) => {
    const s = expandTemplatesDeep<StepLoopElements>(step, ctx.vars);
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs?.[0]?.id;
    if (typeof tabId !== 'number') throw new Error('Active tab not found');
    const selector = String(s.selector || '');
    const res = await chrome.scripting.executeScript({
      target: {
        tabId,
        frameIds: typeof ctx.frameId === 'number' ? [ctx.frameId] : undefined,
      },
      world: 'MAIN',
      func: (sel: string) => {
        try {
          const list = Array.from(document.querySelectorAll(sel));
          const toCss = (node: Element): string => {
            try {
              if ((node as HTMLElement).id) {
                const idSel = `#${CSS.escape((node as HTMLElement).id)}`;
                if (document.querySelectorAll(idSel).length === 1) return idSel;
              }
            } catch {}
            let path = '';
            let current: Element | null = node;
            while (current && current.tagName !== 'BODY') {
              let part = current.tagName.toLowerCase();
              const parentEl: Element | null = current.parentElement;
              if (parentEl) {
                const siblings = Array.from(parentEl.children).filter(
                  (c) => c.tagName === current!.tagName,
                );
                if (siblings.length > 1) {
                  const idx = siblings.indexOf(current) + 1;
                  part += `:nth-of-type(${idx})`;
                }
              }
              path = path ? `${part} > ${path}` : part;
              current = parentEl;
            }
            return path ? `body > ${path}` : 'body';
          };
          return list.map(toCss);
        } catch {
          return [];
        }
      },
      args: [selector],
    });
    const arr: string[] = res && Array.isArray(res[0]?.result) ? (res[0].result as string[]) : [];
    const listVar = String(s.saveAs || 'elements');
    const itemVar = String(s.itemVar || 'item');
    ctx.vars[listVar] = arr;
    return {
      control: { kind: 'foreach', listVar, itemVar, subflowId: String(s.subflowId) },
    };
  },
};
