import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { TargetLocator, SelectorCandidate } from './types';
import { selectorPolicy } from 'humanchrome-shared';


// design note: minimal selector engine that tries ref then candidates

export interface LocatedElement {
  ref?: string;
  center?: { x: number; y: number };
  resolvedBy?: 'ref' | SelectorCandidate['type'];
  frameId?: number;
}

// Composite syntax and candidate ordering are portable policy owned by Rust.
function isCompositeSelector(sel: string): boolean {
  return selectorPolicy.isRustCompositeSelector(sel);
}

interface SelectorResponse {
  success: boolean;
  ref?: string;
  center?: { x: number; y: number };
  href?: string;
}

// Unscoped selectors start in the main frame; composite selectors bridge from there.
async function sendToTab(
  tabId: number,
  message: unknown,
  frameId = 0,
): Promise<SelectorResponse> {
  return chrome.tabs.sendMessage<unknown, SelectorResponse>(tabId, message, { frameId });
}

// Helper: ensure ref for a selector, handling composite selectors and mapping frameId
async function ensureRefForSelector(
  tabId: number,
  selector: string,
  frameId?: number,
): Promise<{ ref: string; center: { x: number; y: number }; frameId?: number } | null> {
  try {
    let ensured: any = null;
    if (isCompositeSelector(selector)) {
      // Always query top for composite; helper will bridge to child and return href
      ensured = await sendToTab(tabId, {
        action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
        selector,
      });
    } else {
      ensured = await sendToTab(
        tabId,
        { action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR, selector },
        frameId,
      );
    }
    if (!ensured || !ensured.success || !ensured.ref || !ensured.center) return null;
    // Map frameId when composite via returned href
    let locFrameId: number | undefined = undefined;
    if (isCompositeSelector(selector) && ensured.href) {
      try {
        const frames = (await chrome.webNavigation.getAllFrames({ tabId })) as any[];
        const match = frames?.find((f) => typeof f.url === 'string' && f.url === ensured.href);
        if (match) locFrameId = match.frameId;
      } catch {}
    }
    return { ref: ensured.ref, center: ensured.center, frameId: locFrameId };
  } catch {
    return null;
  }
}

/**
 * Try to resolve an element using ref or candidates via content scripts
 */
export async function locateElement(
  tabId: number,
  target: TargetLocator,
  frameId?: number,
): Promise<LocatedElement | null> {
  // 0) Fast path: try primary selector if provided
  const primarySel = (target as any)?.selector ? String((target as any).selector).trim() : '';
  if (primarySel) {
    const ensured = await ensureRefForSelector(tabId, primarySel, frameId);
    if (ensured) return { ...ensured, resolvedBy: 'css' };
  }

  // Rank the complete recorded batch once in Rust, retaining content-script transport in JS.
  const ranked = selectorPolicy.sortSelectorCandidateEntries(
    (target.candidates || []) as unknown as Parameters<
      typeof selectorPolicy.sortSelectorCandidateEntries
    >[0],
  ).map(({ candidate }) => candidate as unknown as SelectorCandidate);
  const nonText = ranked.filter((candidate) => candidate.type !== 'text');
  for (const c of nonText) {
    try {
      if (c.type === 'css' || c.type === 'attr') {
        const ensured = await ensureRefForSelector(tabId, String(c.value || ''), frameId);
        if (ensured) return { ...ensured, resolvedBy: c.type };
      } else if (c.type === 'aria') {
        const ariaSelectors = selectorPolicy.legacyAriaSelectors(String(c.value || '').trim());
        for (const sel of ariaSelectors) {
          const ensured = await sendToTab(
            tabId,
            { action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR, selector: sel } as any,
            frameId,
          );
          if (ensured && ensured.success && ensured.ref && ensured.center) {
            return { ref: ensured.ref, center: ensured.center, resolvedBy: c.type, frameId };
          }
        }
      } else if (c.type === 'xpath') {
        // Minimal xpath support via document.evaluate through injected helper
        const ensured = await sendToTab(
          tabId,
          {
            action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
            selector: c.value,
            isXPath: true,
          } as any,
          frameId,
        );
        if (ensured && ensured.success && ensured.ref && ensured.center) {
          return { ref: ensured.ref, center: ensured.center, resolvedBy: c.type, frameId };
        }
      }
    } catch (e) {
      // continue to next candidate
    }
  }
  const textCands = ranked.filter((candidate) => candidate.type === 'text');
  const tagName = ((target as any)?.tag || '').toString();
  for (const c of textCands) {
    try {
      const ensured = await sendToTab(
        tabId,
        {
          action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
          useText: true,
          text: c.value,
          tagName,
        } as any,
        frameId,
      );
      if (ensured && ensured.success && ensured.ref && ensured.center) {
        return { ref: ensured.ref, center: ensured.center, resolvedBy: c.type };
      }
    } catch {}
  }
  // Fallback: try ref (works when ref was produced in the same page lifecycle)
  if (target.ref) {
    try {
      const res = await sendToTab(
        tabId,
        { action: TOOL_MESSAGE_TYPES.RESOLVE_REF, ref: target.ref } as any,
        frameId,
      );
      if (res && res.success && res.center) {
        return { ref: target.ref, center: res.center, resolvedBy: 'ref' };
      }
    } catch (e) {
      // ignore
    }
  }
  return null;
}

/**
 * Ensure screenshot context hostname is still valid for coordinate-based actions
 */
// Note: screenshot hostname validation is handled elsewhere; removed legacy stub.
