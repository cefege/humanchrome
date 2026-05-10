/**
 * CSSOM stylesheet inspection helpers (IMP-0046 slice 3).
 *
 * Five small utilities that wrap the CSSOM with the defensive try/catch
 * boundaries the cascade walk needs:
 *   - isSheetApplicable — media-query check + disabled flag
 *   - describeStyleSheet — turn href / owner node into a UI-friendly label
 *   - safeReadCssRules — cross-origin sheets throw on .cssRules access
 *   - evalMediaRule, evalSupportsRule — at-rule predicate evaluation
 *
 * Pure functions over standard CSSOM types — no shared state.
 */
import type { CssRuleSource } from '../cssom-styles-collector';

export function isSheetApplicable(sheet: CSSStyleSheet): boolean {
  if ((sheet as { disabled?: boolean }).disabled) return false;

  try {
    const mediaText = sheet.media?.mediaText?.trim() ?? '';
    if (!mediaText || mediaText.toLowerCase() === 'all') return true;
    return window.matchMedia(mediaText).matches;
  } catch {
    return true;
  }
}

export function describeStyleSheet(sheet: CSSStyleSheet, fallbackIndex: number): CssRuleSource {
  const href = typeof sheet.href === 'string' ? sheet.href : undefined;

  if (href) {
    const file = href.split('/').pop()?.split('?')[0] ?? href;
    return { url: href, label: file };
  }

  const ownerNode = sheet.ownerNode as Node | null | undefined;
  if (ownerNode && ownerNode.nodeType === Node.ELEMENT_NODE) {
    const el = ownerNode as Element;
    if (el.tagName === 'STYLE') return { label: `<style #${fallbackIndex}>` };
    if (el.tagName === 'LINK') return { label: `<link #${fallbackIndex}>` };
  }

  return { label: `<constructed #${fallbackIndex}>` };
}

/**
 * Cross-origin stylesheets throw a SecurityError on .cssRules access; return
 * null in that case so the cascade walk can record a warning and skip them.
 */
export function safeReadCssRules(sheet: CSSStyleSheet): CSSRuleList | null {
  try {
    return sheet.cssRules;
  } catch {
    return null;
  }
}

export function evalMediaRule(rule: CSSMediaRule, warnings: string[]): boolean {
  try {
    const mediaText = rule.media?.mediaText?.trim() ?? '';
    if (!mediaText || mediaText.toLowerCase() === 'all') return true;
    return window.matchMedia(mediaText).matches;
  } catch (e) {
    warnings.push(`Failed to evaluate @media rule: ${String(e)}`);
    return false;
  }
}

export function evalSupportsRule(rule: CSSSupportsRule, warnings: string[]): boolean {
  try {
    const cond = rule.conditionText?.trim() ?? '';
    if (!cond) return true;
    if (typeof CSS?.supports !== 'function') return true;
    return CSS.supports(cond);
  } catch (e) {
    warnings.push(`Failed to evaluate @supports rule: ${String(e)}`);
    return false;
  }
}
