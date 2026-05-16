/** Selector Locator — locates a DOM element from a list of selector candidates. */

import { TOOL_MESSAGE_TYPES } from '../../common/message-types';
import {
  composeCompositeSelector,
  isCompositeSelector,
  splitCompositeSelector,
  type LocatedElement,
  type Point,
  type SelectorCandidate,
  type SelectorLocateOptions,
  type SelectorTarget,
} from './types';
import { compareSelectorCandidates, withStability } from './stability';
import { parsePrefixedSelector, type ParsedPrefixedSelector } from './prefixed-parser';

function prefixedToCandidate(p: ParsedPrefixedSelector): SelectorCandidate | null {
  switch (p.kind) {
    case 'role':
      if (!p.role) return null;
      return {
        type: 'role',
        role: p.role,
        name: p.name,
        exact: p.exact,
        value: p.value,
        source: 'user',
        strategy: 'role',
      };
    case 'label':
      return {
        type: 'label',
        text: p.value,
        exact: p.exact,
        value: p.value,
        source: 'user',
        strategy: 'label',
      };
    case 'placeholder':
      return {
        type: 'placeholder',
        text: p.value,
        exact: p.exact,
        value: p.value,
        source: 'user',
        strategy: 'placeholder',
      };
    case 'alt':
      return {
        type: 'alt',
        text: p.value,
        exact: p.exact,
        value: p.value,
        source: 'user',
        strategy: 'alt',
      };
    case 'title':
      return {
        type: 'title',
        text: p.value,
        exact: p.exact,
        value: p.value,
        source: 'user',
        strategy: 'title',
      };
    case 'testid':
      return { type: 'testid', value: p.value, source: 'user', strategy: 'testid' };
    case 'text':
      return {
        type: 'text',
        value: p.value,
        match: p.exact ? 'exact' : 'contains',
        source: 'user',
        strategy: 'text',
      };
    default:
      return null;
  }
}

interface EnsureRefForSelectorRequest {
  action: typeof TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR;
  selector?: string;
  useText?: boolean;
  text?: string;
  isXPath?: boolean;
  tagName?: string;
  allowMultiple?: boolean;
  /**
   * Optional structured-selector dispatch (IMP-0098). When set, the helper
   * uses the supplied kind to resolve via the matching strategy rather than
   * treating `selector` as raw CSS.
   *
   *   selectorKind: 'role'        → resolve(name, role, exact)
   *   selectorKind: 'label'       → resolve(text, exact)
   *   selectorKind: 'placeholder' → resolve(text, exact)
   *   selectorKind: 'alt'         → resolve(text, exact)
   *   selectorKind: 'title'       → resolve(text, exact)
   *   selectorKind: 'testid'      → resolve(value, [attribute])
   */
  selectorKind?: 'role' | 'label' | 'placeholder' | 'alt' | 'title' | 'testid';
  role?: string;
  name?: string;
  exact?: boolean;
  attribute?: string;
  /** Zero-based index to pick when multiple matches are allowed. */
  index?: number;
}

type EnsureRefForSelectorResponse =
  | {
      success: true;
      ref: string;
      center: Point;
      href?: string;
      /** Total match count when the helper computed one (strict-mode metadata). */
      matchCount?: number;
    }
  | {
      success: false;
      error?: string;
      cancelled?: boolean;
      /** Set when the failure was caused by multiple matches in strict mode. */
      strict?: { matchCount: number; samples?: Array<{ tag?: string; text?: string }> };
    };

interface ResolveRefRequest {
  action: typeof TOOL_MESSAGE_TYPES.RESOLVE_REF;
  ref: string;
}

type ResolveRefResponse =
  | {
      success: true;
      center: Point;
      rect?: { x: number; y: number; width: number; height: number };
      selector?: string;
    }
  | { success: false; error?: string };

interface VerifyFingerprintRequest {
  action: typeof TOOL_MESSAGE_TYPES.VERIFY_FINGERPRINT;
  ref: string;
  fingerprint: string;
}

type VerifyFingerprintResponse =
  | { success: true; match: boolean }
  | { success: false; error?: string };

export interface SelectorLocatorTransport {
  sendMessage: (
    tabId: number,
    message: unknown,
    options?: { frameId?: number },
  ) => Promise<unknown>;
  getAllFrames?: (tabId: number) => Promise<ReadonlyArray<{ frameId: number; url: string }>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPoint(value: unknown): value is Point {
  if (!isRecord(value)) return false;
  return (
    typeof value.x === 'number' &&
    Number.isFinite(value.x) &&
    typeof value.y === 'number' &&
    Number.isFinite(value.y)
  );
}

function parseEnsureRefResponse(value: unknown): EnsureRefForSelectorResponse | null {
  if (!isRecord(value) || typeof value.success !== 'boolean') return null;

  if (value.success) {
    if (typeof value.ref !== 'string' || !isPoint(value.center)) return null;
    const href = typeof value.href === 'string' ? value.href : undefined;
    const matchCount =
      typeof value.matchCount === 'number' && Number.isFinite(value.matchCount)
        ? value.matchCount
        : undefined;
    return { success: true, ref: value.ref, center: value.center, href, matchCount };
  }

  const error = typeof value.error === 'string' ? value.error : undefined;
  const cancelled = typeof value.cancelled === 'boolean' ? value.cancelled : undefined;
  // Strict-mode envelope — surfaced when the helper found >1 matches with
  // allowMultiple=false. Carries matchCount + samples so the caller can
  // disambiguate without re-fetching.
  let strict: { matchCount: number; samples?: Array<{ tag?: string; text?: string }> } | undefined;
  if (isRecord(value.strict) && typeof value.strict.matchCount === 'number') {
    const samplesRaw = Array.isArray(value.strict.samples) ? value.strict.samples : [];
    const samples = samplesRaw
      .filter(isRecord)
      .map((s) => ({
        tag: typeof s.tag === 'string' ? s.tag : undefined,
        text: typeof s.text === 'string' ? s.text : undefined,
      }))
      .slice(0, 5);
    strict = { matchCount: value.strict.matchCount, samples };
  }
  return { success: false, error, cancelled, strict };
}

function parseResolveRefResponse(value: unknown): ResolveRefResponse | null {
  if (!isRecord(value) || typeof value.success !== 'boolean') return null;

  if (value.success) {
    if (!isPoint(value.center)) return null;

    const rect =
      isRecord(value.rect) &&
      typeof value.rect.x === 'number' &&
      typeof value.rect.y === 'number' &&
      typeof value.rect.width === 'number' &&
      typeof value.rect.height === 'number'
        ? {
            x: value.rect.x,
            y: value.rect.y,
            width: value.rect.width,
            height: value.rect.height,
          }
        : undefined;

    const selector = typeof value.selector === 'string' ? value.selector : undefined;
    return { success: true, center: value.center, rect, selector };
  }

  const error = typeof value.error === 'string' ? value.error : undefined;
  return { success: false, error };
}

function parseVerifyFingerprintResponse(value: unknown): VerifyFingerprintResponse | null {
  if (!isRecord(value) || typeof value.success !== 'boolean') return null;

  if (value.success) {
    if (typeof value.match !== 'boolean') return null;
    return { success: true, match: value.match };
  }

  const error = typeof value.error === 'string' ? value.error : undefined;
  return { success: false, error };
}

function deriveFrameSelector(target: SelectorTarget): string | undefined {
  if (typeof target.selector === 'string') {
    const parts = splitCompositeSelector(target.selector);
    if (parts) return parts.frameSelector;
  }
  for (const c of target.candidates) {
    const parts = splitCompositeSelector(c.value);
    if (parts) return parts.frameSelector;
  }
  return undefined;
}

function deriveTagNameHint(
  target: SelectorTarget,
  candidate: SelectorCandidate | undefined,
): string | undefined {
  if (candidate?.type === 'text' && candidate.tagNameHint) return candidate.tagNameHint;
  return target.tagName;
}

function parseAriaExpr(expr: string): { role?: string; name?: string } {
  const v = String(expr || '').trim();
  const m = v.match(/^(\w+)\s*\[\s*name\s*=\s*([^\]]+)\s*\]$/);
  if (!m) return {};
  const role = m[1]?.trim();
  const rawName = m[2]?.trim();
  const name = rawName ? rawName.replace(/^['"]|['"]$/g, '') : undefined;
  return { role: role || undefined, name: name || undefined };
}

function uniqStrings(items: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of items) {
    const v = s.trim();
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function ariaToCssSelectors(role: string | undefined, name: string | undefined): string[] {
  if (!name || !name.trim()) return [];
  const cleanRole = role?.trim();
  const cleanName = name.trim();
  const qName = JSON.stringify(cleanName);

  const out: string[] = [];

  if (cleanRole) out.push(`[role=${JSON.stringify(cleanRole)}][aria-label=${qName}]`);

  if (cleanRole === 'textbox') {
    out.unshift(
      `input[aria-label=${qName}]`,
      `textarea[aria-label=${qName}]`,
      `[role="textbox"][aria-label=${qName}]`,
    );
  } else if (cleanRole === 'button') {
    out.unshift(`button[aria-label=${qName}]`, `[role="button"][aria-label=${qName}]`);
  } else if (cleanRole === 'link') {
    out.unshift(`a[aria-label=${qName}]`, `[role="link"][aria-label=${qName}]`);
  }

  out.push(`[aria-label=${qName}]`);
  return uniqStrings(out);
}

export class SelectorLocator {
  constructor(private readonly transport: SelectorLocatorTransport) {}

  private async mapHrefToFrameId(
    tabId: number,
    href: string | undefined,
  ): Promise<number | undefined> {
    if (!href || !this.transport.getAllFrames) return undefined;
    try {
      const frames = await this.transport.getAllFrames(tabId);
      const match = frames.find((f) => f.url === href);
      return match?.frameId;
    } catch {
      return undefined;
    }
  }

  private async ensureRef(
    tabId: number,
    request: EnsureRefForSelectorRequest,
    frameId: number | undefined,
  ): Promise<{ ref: string; center: Point; href?: string; matchCount?: number } | null> {
    const selector = request.selector ?? '';
    const responseRaw = await this.transport.sendMessage(
      tabId,
      request,
      isCompositeSelector(selector) ? undefined : { frameId },
    );
    const parsed = parseEnsureRefResponse(responseRaw);
    if (!parsed || !parsed.success) {
      // Stash the latest failure shape so locate() can surface strict-mode
      // metadata to the caller without changing the public return type.
      this.lastEnsureFailure = parsed && !parsed.success ? parsed : null;
      return null;
    }
    this.lastEnsureFailure = null;
    return {
      ref: parsed.ref,
      center: parsed.center,
      href: parsed.href,
      matchCount: parsed.matchCount,
    };
  }

  /** Most-recent ensureRef failure (used to surface strict-mode metadata). */
  private lastEnsureFailure: Extract<EnsureRefForSelectorResponse, { success: false }> | null =
    null;

  /**
   * Expose the most recent ensureRef failure for callers (typically tool
   * code) that need to wrap it into a structured error envelope. Cleared
   * automatically after a successful resolution.
   */
  public consumeLastEnsureFailure(): Extract<
    EnsureRefForSelectorResponse,
    { success: false }
  > | null {
    const f = this.lastEnsureFailure;
    this.lastEnsureFailure = null;
    return f;
  }

  private async resolveRef(
    tabId: number,
    ref: string,
    frameId: number | undefined,
  ): Promise<LocatedElement | null> {
    const msg = { action: TOOL_MESSAGE_TYPES.RESOLVE_REF, ref } satisfies ResolveRefRequest;
    const responseRaw = await this.transport.sendMessage(tabId, msg, { frameId });
    const parsed = parseResolveRefResponse(responseRaw);
    if (!parsed || !parsed.success) return null;
    return { ref, center: parsed.center, frameId, resolvedBy: 'ref' };
  }

  private async verifyElementFingerprint(
    tabId: number,
    ref: string,
    fingerprint: string,
    frameId: number | undefined,
  ): Promise<boolean> {
    const msg = {
      action: TOOL_MESSAGE_TYPES.VERIFY_FINGERPRINT,
      ref,
      fingerprint,
    } satisfies VerifyFingerprintRequest;

    try {
      const responseRaw = await this.transport.sendMessage(tabId, msg, { frameId });
      const parsed = parseVerifyFingerprintResponse(responseRaw);
      if (!parsed || !parsed.success) return false;
      return parsed.match;
    } catch {
      return false;
    }
  }

  async locate(
    tabId: number,
    target: SelectorTarget,
    options: SelectorLocateOptions = {},
  ): Promise<LocatedElement | null> {
    const frameSelector = deriveFrameSelector(target);
    const allowMultiple = options.allowMultiple ?? false;

    const fingerprintToVerify =
      options.verifyFingerprint === true && typeof target.fingerprint === 'string'
        ? target.fingerprint.trim()
        : undefined;

    if (options.preferRef && target.ref) {
      const byRef = await this.resolveRef(tabId, target.ref, options.frameId);
      if (byRef) return byRef;
    }

    // 1) Fast path: try target.selector first (CSS / composite / prefixed).
    if (typeof target.selector === 'string' && target.selector.trim()) {
      const sel = target.selector.trim();

      // Prefixed selector? Re-route through the structured candidate path.
      // We split composite first so `iframe#x |> role:button[name="Y"]` keeps
      // the iframe traversal and only the inner segment gets prefix parsing.
      const composite = splitCompositeSelector(sel);
      const innerForPrefixCheck = composite ? composite.innerSelector.trim() : sel;
      const parsedPrefix = parsePrefixedSelector(innerForPrefixCheck);

      if (parsedPrefix.kind !== 'css' && parsedPrefix.kind !== 'xpath') {
        const inlineCandidate = prefixedToCandidate(parsedPrefix);
        if (inlineCandidate) {
          const resolvedViaPrefix = await this.tryCandidate(
            tabId,
            target,
            inlineCandidate,
            composite ? composite.frameSelector : undefined,
            options.frameId,
            allowMultiple,
          );
          if (resolvedViaPrefix) {
            const okFp =
              !fingerprintToVerify ||
              (await this.verifyElementFingerprint(
                tabId,
                resolvedViaPrefix.ref,
                fingerprintToVerify,
                resolvedViaPrefix.frameId ?? options.frameId,
              ));
            if (okFp) return resolvedViaPrefix;
          }
        }
      } else if (parsedPrefix.kind === 'xpath') {
        // xpath:... prefix — re-dispatch with isXPath=true (composite kept).
        const xpathSel = composite
          ? composeCompositeSelector(composite.frameSelector, parsedPrefix.value)
          : parsedPrefix.value;
        const ensured = await this.ensureRef(
          tabId,
          {
            action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
            selector: xpathSel,
            isXPath: true,
            allowMultiple,
          },
          options.frameId,
        );
        if (ensured) {
          const mappedFrameId = await this.mapHrefToFrameId(tabId, ensured.href);
          const resolvedFrameId = mappedFrameId ?? options.frameId;
          const fingerprintOk =
            !fingerprintToVerify ||
            (await this.verifyElementFingerprint(
              tabId,
              ensured.ref,
              fingerprintToVerify,
              resolvedFrameId,
            ));
          if (fingerprintOk) {
            return {
              ref: ensured.ref,
              center: ensured.center,
              frameId: resolvedFrameId,
              resolvedBy: 'xpath',
              selectorUsed: xpathSel,
            };
          }
        }
      } else {
        // Plain CSS — original fast-path behavior.
        const ensured = await this.ensureRef(
          tabId,
          { action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR, selector: sel, allowMultiple },
          options.frameId,
        );
        if (ensured) {
          const mappedFrameId = await this.mapHrefToFrameId(tabId, ensured.href);
          const resolvedFrameId = mappedFrameId ?? options.frameId;

          const fingerprintOk =
            !fingerprintToVerify ||
            (await this.verifyElementFingerprint(
              tabId,
              ensured.ref,
              fingerprintToVerify,
              resolvedFrameId,
            ));

          if (fingerprintOk) {
            return {
              ref: ensured.ref,
              center: ensured.center,
              frameId: resolvedFrameId,
              resolvedBy: 'css',
              selectorUsed: sel,
            };
          }
          // Fingerprint mismatch — fall through to the candidate list.
        }
      }
    }

    // 2) Candidate ordering (stability + weight). Keep text last by type priority.
    const candidates = [...target.candidates].map(withStability).sort(compareSelectorCandidates);

    for (const candidate of candidates) {
      const resolved = await this.tryCandidate(
        tabId,
        target,
        candidate,
        frameSelector,
        options.frameId,
        allowMultiple,
      );
      if (!resolved) continue;

      if (fingerprintToVerify) {
        const isMatch = await this.verifyElementFingerprint(
          tabId,
          resolved.ref,
          fingerprintToVerify,
          resolved.frameId ?? options.frameId,
        );
        if (!isMatch) continue;
      }

      return resolved;
    }

    // 3) Ref fallback
    if (target.ref) {
      const byRef = await this.resolveRef(tabId, target.ref, options.frameId);
      if (byRef) return byRef;
    }

    return null;
  }

  private async tryCandidate(
    tabId: number,
    target: SelectorTarget,
    candidate: SelectorCandidate,
    frameSelector: string | undefined,
    frameId: number | undefined,
    allowMultiple: boolean,
  ): Promise<LocatedElement | null> {
    const tagName = deriveTagNameHint(target, candidate);

    if (candidate.type === 'css' || candidate.type === 'attr') {
      const selectorToTry =
        frameSelector && !isCompositeSelector(candidate.value)
          ? composeCompositeSelector(frameSelector, candidate.value)
          : candidate.value;

      const ensured = await this.ensureRef(
        tabId,
        {
          action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
          selector: selectorToTry,
          allowMultiple,
        },
        frameId,
      );
      if (!ensured) return null;

      const mappedFrameId = await this.mapHrefToFrameId(tabId, ensured.href);
      return {
        ref: ensured.ref,
        center: ensured.center,
        frameId: mappedFrameId ?? frameId,
        resolvedBy: candidate.type,
        selectorUsed: selectorToTry,
      };
    }

    if (candidate.type === 'xpath') {
      const selectorToTry =
        frameSelector && !isCompositeSelector(candidate.value)
          ? composeCompositeSelector(frameSelector, candidate.value)
          : candidate.value;

      const ensured = await this.ensureRef(
        tabId,
        {
          action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
          selector: selectorToTry,
          isXPath: true,
          allowMultiple,
        },
        frameId,
      );
      if (!ensured) return null;

      const mappedFrameId = await this.mapHrefToFrameId(tabId, ensured.href);
      return {
        ref: ensured.ref,
        center: ensured.center,
        frameId: mappedFrameId ?? frameId,
        resolvedBy: 'xpath',
        selectorUsed: selectorToTry,
      };
    }

    if (candidate.type === 'aria') {
      const parsed = parseAriaExpr(candidate.value);
      const role = candidate.role ?? parsed.role;
      const name = candidate.name ?? parsed.name;
      const selectors = ariaToCssSelectors(role, name);

      for (const cssSel of selectors) {
        const selectorToTry = frameSelector
          ? composeCompositeSelector(frameSelector, cssSel)
          : cssSel;
        const ensured = await this.ensureRef(
          tabId,
          {
            action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
            selector: selectorToTry,
            allowMultiple,
          },
          frameId,
        );
        if (!ensured) continue;

        const mappedFrameId = await this.mapHrefToFrameId(tabId, ensured.href);
        return {
          ref: ensured.ref,
          center: ensured.center,
          frameId: mappedFrameId ?? frameId,
          resolvedBy: 'aria',
          selectorUsed: selectorToTry,
        };
      }
      return null;
    }

    // role / label / placeholder / alt / title / testid — Playwright-style
    // selectors (IMP-0098). Each delegates to the page-side helper which
    // runs the matching strategy against the live DOM.
    if (
      candidate.type === 'role' ||
      candidate.type === 'label' ||
      candidate.type === 'placeholder' ||
      candidate.type === 'alt' ||
      candidate.type === 'title' ||
      candidate.type === 'testid'
    ) {
      const baseRequest: EnsureRefForSelectorRequest = {
        action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
        selectorKind: candidate.type,
        allowMultiple,
      };

      if (candidate.type === 'role') {
        baseRequest.role = candidate.role;
        baseRequest.name = candidate.name;
        baseRequest.exact = candidate.exact;
        baseRequest.selector = candidate.value;
      } else if (candidate.type === 'testid') {
        baseRequest.attribute = candidate.attribute;
        baseRequest.selector = candidate.value;
        // Keep `text` populated so the helper has the search value even when
        // it ignores `selector` (testid resolution looks at attribute values,
        // not CSS).
        baseRequest.text = candidate.value;
      } else {
        baseRequest.text = candidate.text;
        baseRequest.exact = candidate.exact;
        baseRequest.selector = candidate.text;
      }

      // Iframe composite — keep the frame prefix on `selector` so the helper's
      // existing composite split picks the right contentWindow.
      if (frameSelector) {
        const inner = baseRequest.selector ?? '';
        baseRequest.selector = composeCompositeSelector(frameSelector, inner);
      }

      const ensured = await this.ensureRef(tabId, baseRequest, frameId);
      if (!ensured) return null;

      const mappedFrameId = await this.mapHrefToFrameId(tabId, ensured.href);
      return {
        ref: ensured.ref,
        center: ensured.center,
        frameId: mappedFrameId ?? frameId,
        resolvedBy: candidate.type,
        selectorUsed: baseRequest.selector ?? baseRequest.text ?? candidate.value,
      };
    }

    // text
    const textValue = candidate.value.trim();
    if (!textValue) return null;

    // NOTE: In composite mode, the helper expects the inner "selector" string to carry the text query.
    const compositeSelector = frameSelector
      ? composeCompositeSelector(frameSelector, textValue)
      : undefined;

    const ensured = await this.ensureRef(
      tabId,
      {
        action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
        selector: compositeSelector, // for iframe-text: becomes "<frame> |> <text>"
        useText: true,
        text: frameSelector ? undefined : textValue, // non-iframe: use request.text
        tagName: tagName ?? '',
        allowMultiple,
      },
      frameId,
    );

    if (!ensured) return null;

    const mappedFrameId = await this.mapHrefToFrameId(tabId, ensured.href);
    return {
      ref: ensured.ref,
      center: ensured.center,
      frameId: mappedFrameId ?? frameId,
      resolvedBy: 'text',
      selectorUsed: frameSelector ? compositeSelector : textValue,
    };
  }
}

export function createChromeSelectorLocatorTransport(): SelectorLocatorTransport {
  return {
    sendMessage: async (tabId, message, options) => {
      if (options && typeof options.frameId === 'number') {
        return await chrome.tabs.sendMessage(tabId, message, { frameId: options.frameId });
      }
      return await chrome.tabs.sendMessage(tabId, message);
    },
    getAllFrames: async (tabId) => {
      const frames = await chrome.webNavigation.getAllFrames({ tabId });
      return (frames ?? []).map((f) => ({ frameId: f.frameId, url: f.url ?? '' }));
    },
  };
}

export function createChromeSelectorLocator(): SelectorLocator {
  return new SelectorLocator(createChromeSelectorLocatorTransport());
}
