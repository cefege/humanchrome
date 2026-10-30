// selector-engine-bundle.js
//
// Vanilla-JS port of `app/chrome-extension/shared/selector/` for use inside
// content scripts that cannot import ES modules (recorder.js, etc.).
//
// The shared TS source is the canonical implementation. Keep this bundle in
// sync — when you touch `shared/selector/strategies/*` or `generator.ts`,
// mirror the change here. The recorder tests run against the TS source so
// behavior parity is locked in.
//
// Exposes:
//   window.__rrSelectorEngine = {
//     generateSelectorTarget(el, options?): SelectorTarget,
//     generateExtendedSelectorTarget(el, options?): ExtendedSelectorTarget,
//     compareSelectorCandidates(a, b): number,
//     withStability(c): SelectorCandidate,
//     computeFingerprint(el, options?): string,
//     computeDomPath(el): number[],
//     cssEscape(value): string,
//   };

(function (root) {
  if (root.__rrSelectorEngine) return;

  // ==========================================================================
  // Utilities
  // ==========================================================================

  function cssEscape(value) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
      return CSS.escape(value);
    }
    const str = String(value);
    const len = str.length;
    if (len === 0) return '';
    let result = '';
    const firstCodeUnit = str.charCodeAt(0);
    for (let i = 0; i < len; i++) {
      const codeUnit = str.charCodeAt(i);
      if (codeUnit === 0x0000) {
        result += '�';
        continue;
      }
      if (
        (codeUnit >= 0x0001 && codeUnit <= 0x001f) ||
        codeUnit === 0x007f ||
        (i === 0 && codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
        (i === 1 && codeUnit >= 0x0030 && codeUnit <= 0x0039 && firstCodeUnit === 0x002d)
      ) {
        result += `\\${codeUnit.toString(16)} `;
        continue;
      }
      if (i === 0 && len === 1 && codeUnit === 0x002d) {
        result += `\\${str.charAt(i)}`;
        continue;
      }
      const isAsciiAlnum =
        (codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
        (codeUnit >= 0x0041 && codeUnit <= 0x005a) ||
        (codeUnit >= 0x0061 && codeUnit <= 0x007a);
      const isSafe = isAsciiAlnum || codeUnit === 0x002d || codeUnit === 0x005f;
      if (isSafe) result += str.charAt(i);
      else result += `\\${str.charAt(i)}`;
    }
    return result;
  }

  function clamp01(n) {
    if (!Number.isFinite(n)) return 0;
    return Math.min(1, Math.max(0, n));
  }

  function clampInt(value, min, max) {
    if (!Number.isFinite(value)) return min;
    return Math.min(max, Math.max(min, Math.floor(value)));
  }

  function getQueryRoot(element) {
    const root = element.getRootNode ? element.getRootNode() : null;
    if (root && typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot) return root;
    if (typeof document !== 'undefined') return document;
    throw new Error('Selector generator requires a DOM-like environment');
  }

  function safeQueryAll(root, selector) {
    try {
      return Array.from(root.querySelectorAll(selector));
    } catch {
      return [];
    }
  }

  function isUnique(root, selector) {
    try {
      return root.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  }

  // ==========================================================================
  // Composite selector helpers (mirrors shared/selector/types.ts)
  // ==========================================================================

  const COMPOSITE_SELECTOR_SEPARATOR = '|>';

  function splitCompositeSelector(selector) {
    if (typeof selector !== 'string') return null;
    const parts = selector
      .split(COMPOSITE_SELECTOR_SEPARATOR)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length < 2) return null;
    return {
      frameSelector: parts[0],
      innerSelector: parts.slice(1).join(` ${COMPOSITE_SELECTOR_SEPARATOR} `),
    };
  }

  // ==========================================================================
  // Stability scoring (mirrors shared/selector/stability.ts)
  // ==========================================================================

  const TESTID_ATTR_NAMES = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy'];

  function mergeSignals(a, b) {
    return {
      usesId: a.usesId || b.usesId || undefined,
      usesTestId: a.usesTestId || b.usesTestId || undefined,
      usesAria: a.usesAria || b.usesAria || undefined,
      usesText: a.usesText || b.usesText || undefined,
      usesNthOfType: a.usesNthOfType || b.usesNthOfType || undefined,
      usesAttributes: a.usesAttributes || b.usesAttributes || undefined,
      usesClass: a.usesClass || b.usesClass || undefined,
    };
  }

  function analyzeCssLike(selector) {
    const s = String(selector || '');
    const usesNthOfType = /:nth-of-type\(/i.test(s);
    const usesAttributes = /\[[^\]]+\]/.test(s);
    const usesAria = /\[\s*aria-[^=]+\s*=|\[\s*role\s*=|\brole\s*=\s*/i.test(s);
    const usesId = /(^|[\s>+~])#[^\s>+~.:#[]+/.test(s);
    const usesClass = /(^|[\s>+~])\.[^\s>+~.:#[]+/.test(s);
    const lower = s.toLowerCase();
    const usesTestId = TESTID_ATTR_NAMES.some((a) => lower.includes(`[${a}`));
    return {
      usesId: usesId || undefined,
      usesTestId: usesTestId || undefined,
      usesAria: usesAria || undefined,
      usesNthOfType: usesNthOfType || undefined,
      usesAttributes: usesAttributes || undefined,
      usesClass: usesClass || undefined,
    };
  }

  function baseScoreForCssSignals(signals) {
    if (signals.usesTestId) return 0.95;
    if (signals.usesId) return 0.9;
    if (signals.usesAria) return 0.8;
    if (signals.usesAttributes) return 0.75;
    if (signals.usesClass) return 0.65;
    return 0.5;
  }

  function lengthPenalty(value) {
    const len = value.length;
    if (len <= 60) return 0;
    if (len <= 120) return 0.05;
    if (len <= 200) return 0.1;
    return 0.18;
  }

  function computeSelectorStability(candidate) {
    if (candidate.type === 'css' || candidate.type === 'attr') {
      const composite = splitCompositeSelector(candidate.value);
      if (composite) {
        const a = analyzeCssLike(composite.frameSelector);
        const b = analyzeCssLike(composite.innerSelector);
        const merged = mergeSignals(a, b);
        let score = baseScoreForCssSignals(merged);
        score -= 0.05;
        if (merged.usesNthOfType) score -= 0.2;
        score -= lengthPenalty(candidate.value);
        return { score: clamp01(score), signals: merged, note: 'composite' };
      }
      const signals = analyzeCssLike(candidate.value);
      let score = baseScoreForCssSignals(signals);
      if (signals.usesNthOfType) score -= 0.2;
      score -= lengthPenalty(candidate.value);
      return { score: clamp01(score), signals };
    }
    if (candidate.type === 'xpath') {
      const s = String(candidate.value || '');
      const signals = {
        usesAttributes: /@[\w-]+\s*=/.test(s) || undefined,
        usesId: /@id\s*=/.test(s) || undefined,
        usesTestId: /@data-testid\s*=/.test(s) || undefined,
      };
      let score = 0.42;
      if (signals.usesTestId) score = 0.85;
      else if (signals.usesId) score = 0.75;
      else if (signals.usesAttributes) score = 0.55;
      score -= lengthPenalty(s);
      return { score: clamp01(score), signals };
    }
    if (candidate.type === 'aria') {
      const hasName = typeof candidate.name === 'string' && candidate.name.trim().length > 0;
      const hasRole = typeof candidate.role === 'string' && candidate.role.trim().length > 0;
      const signals = { usesAria: true };
      let score = hasName && hasRole ? 0.8 : hasName ? 0.72 : 0.6;
      score -= lengthPenalty(candidate.value);
      return { score: clamp01(score), signals };
    }
    const text = String(candidate.value || '').trim();
    const signals = { usesText: true };
    let score = 0.35;
    if (text.length >= 6 && text.length <= 48) score = 0.45;
    if (text.length > 80) score = 0.3;
    return { score: clamp01(score), signals };
  }

  function withStability(candidate) {
    if (candidate.stability) return candidate;
    return Object.assign({}, candidate, { stability: computeSelectorStability(candidate) });
  }

  function typePriority(type) {
    switch (type) {
      case 'attr':
        return 5;
      case 'css':
        return 4;
      case 'aria':
        return 3;
      case 'xpath':
        return 2;
      case 'text':
        return 1;
      default:
        return 0;
    }
  }

  function compareSelectorCandidates(a, b) {
    const aw = a.weight != null ? a.weight : 0;
    const bw = b.weight != null ? b.weight : 0;
    if (aw !== bw) return bw - aw;
    const as = a.stability ? a.stability.score : computeSelectorStability(a).score;
    const bs = b.stability ? b.stability.score : computeSelectorStability(b).score;
    if (as !== bs) return bs - as;
    const ap = typePriority(a.type);
    const bp = typePriority(b.type);
    if (ap !== bp) return bp - ap;
    const alen = String(a.value || '').length;
    const blen = String(b.value || '').length;
    return alen - blen;
  }

  // ==========================================================================
  // Strategies (mirrors shared/selector/strategies/*)
  // ==========================================================================

  // ---- testid -------------------------------------------------------------

  const FORM_ELEMENT_TAGS = new Set(['input', 'textarea', 'select', 'button']);
  const ALT_ATTRIBUTE_TAGS = new Set(['img', 'area']);
  const TITLE_ATTRIBUTE_TAGS = new Set(['img', 'a', 'abbr', 'iframe', 'link']);

  const ATTR_TAG_PREFERENCES = {
    name: FORM_ELEMENT_TAGS,
    alt: ALT_ATTRIBUTE_TAGS,
    title: TITLE_ATTRIBUTE_TAGS,
  };

  const TESTID_ATTR_WEIGHT = {
    'data-testid': 50,
    'data-test-id': 50,
    'data-testId': 50,
    'data-test': 50,
    'data-qa': 50,
    'data-cy': 50,
    alt: 20,
    title: 18,
    name: 15,
  };

  function shouldTryTagPrefix(attr, tag, element) {
    if (!tag) return false;
    if (attr.indexOf('data-') === 0) {
      return FORM_ELEMENT_TAGS.has(tag);
    }
    const pref = ATTR_TAG_PREFERENCES[attr];
    if (pref) {
      if (pref.has(tag)) return true;
      if (attr === 'alt' && tag === 'input') {
        const t = element.getAttribute('type');
        return t === 'image';
      }
      return false;
    }
    return true;
  }

  const testIdStrategy = {
    id: 'testid',
    generate(ctx) {
      const { element, options, helpers } = ctx;
      const out = [];
      const tag = (element.tagName || '').toLowerCase();
      for (const attr of options.testIdAttributes) {
        const raw = element.getAttribute(attr);
        const value = raw ? raw.trim() : '';
        if (!value) continue;
        const attrOnly = `[${attr}="${helpers.cssEscape(value)}"]`;
        const weight = TESTID_ATTR_WEIGHT[attr] != null ? TESTID_ATTR_WEIGHT[attr] : 50;
        if (helpers.isUnique(attrOnly)) {
          out.push({
            type: 'attr',
            value: attrOnly,
            weight,
            source: 'generated',
            strategy: 'testid',
          });
          continue;
        }
        if (shouldTryTagPrefix(attr, tag, element)) {
          const withTag = `${tag}${attrOnly}`;
          if (helpers.isUnique(withTag)) {
            out.push({
              type: 'attr',
              value: withTag,
              weight,
              source: 'generated',
              strategy: 'testid',
            });
          }
        }
      }
      return out;
    },
  };

  // ---- aria ---------------------------------------------------------------

  const ARIA_STRATEGY_WEIGHT = 40;

  function guessRoleByTag(tag) {
    if (tag === 'input' || tag === 'textarea') return 'textbox';
    if (tag === 'button') return 'button';
    if (tag === 'a') return 'link';
    return undefined;
  }

  function uniqStrings(items) {
    const seen = new Set();
    const out = [];
    for (const s of items) {
      const v = s.trim();
      if (!v) continue;
      if (seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
    return out;
  }

  const ariaStrategy = {
    id: 'aria',
    generate(ctx) {
      if (!ctx.options.includeAria) return [];
      const { element, helpers } = ctx;
      const out = [];
      const rawLabel = element.getAttribute('aria-label');
      const name = rawLabel ? rawLabel.trim() : '';
      if (!name) return out;
      const tag = (element.tagName || '').toLowerCase();
      const rawRole = element.getAttribute('role');
      const role = (rawRole && rawRole.trim()) || guessRoleByTag(tag);
      const qName = JSON.stringify(name);
      const selectors = [];
      if (role) selectors.push(`[role=${JSON.stringify(role)}][aria-label=${qName}]`);
      selectors.push(`[aria-label=${qName}]`);
      if (role === 'textbox') {
        selectors.unshift(
          `input[aria-label=${qName}]`,
          `textarea[aria-label=${qName}]`,
          `[role="textbox"][aria-label=${qName}]`,
        );
      } else if (role === 'button') {
        selectors.unshift(`button[aria-label=${qName}]`, `[role="button"][aria-label=${qName}]`);
      } else if (role === 'link') {
        selectors.unshift(`a[aria-label=${qName}]`, `[role="link"][aria-label=${qName}]`);
      }
      for (const sel of uniqStrings(selectors)) {
        if (helpers.isUnique(sel)) {
          out.push({
            type: 'attr',
            value: sel,
            weight: ARIA_STRATEGY_WEIGHT,
            source: 'generated',
            strategy: 'aria',
          });
        }
      }
      out.push({
        type: 'aria',
        value: `${role || 'element'}[name=${JSON.stringify(name)}]`,
        role,
        name,
        weight: ARIA_STRATEGY_WEIGHT,
        source: 'generated',
        strategy: 'aria',
      });
      return out;
    },
  };

  // ---- label --------------------------------------------------------------

  const LABEL_STRATEGY_WEIGHT = 30;
  const LABEL_FORM_TAGS = new Set(['input', 'textarea', 'select']);

  function roleForFormTag(tag, element) {
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'input') {
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
      if (type === 'range') return 'slider';
      if (type === 'search') return 'searchbox';
      return 'textbox';
    }
    return undefined;
  }

  function normalizeWhitespace(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function readElementText(el) {
    const inner = el.innerText;
    return normalizeWhitespace(typeof inner === 'string' ? inner : el.textContent || '');
  }

  function findLabelText(element) {
    const labelledByRaw = element.getAttribute('aria-labelledby');
    const labelledBy = labelledByRaw ? labelledByRaw.trim() : '';
    if (labelledBy) {
      const root = (element.getRootNode && element.getRootNode()) || document;
      const ids = labelledBy.split(/\s+/).filter(Boolean);
      const parts = [];
      for (const id of ids) {
        try {
          const ref =
            typeof root.getElementById === 'function'
              ? root.getElementById(id)
              : root.querySelector(`#${cssEscape(id)}`);
          if (ref) {
            const t = readElementText(ref);
            if (t) parts.push(t);
          }
        } catch {}
      }
      const joined = parts.join(' ').trim();
      if (joined) return joined;
    }
    const idRaw = element.id;
    const id = idRaw ? String(idRaw).trim() : '';
    if (id) {
      try {
        const root = (element.getRootNode && element.getRootNode()) || document;
        const label = root.querySelector(`label[for="${cssEscape(id)}"]`);
        if (label) {
          const t = readElementText(label);
          if (t) return t;
        }
      } catch {}
    }
    try {
      let cursor = element.parentElement;
      let depth = 0;
      while (cursor && depth < 6) {
        if ((cursor.tagName || '').toLowerCase() === 'label') {
          const clone = cursor.cloneNode(true);
          try {
            clone.querySelectorAll('input,textarea,select,button').forEach((n) => n.remove());
          } catch {}
          const t = readElementText(clone);
          if (t) return t;
          break;
        }
        cursor = cursor.parentElement;
        depth += 1;
      }
    } catch {}
    return null;
  }

  const labelStrategy = {
    id: 'label',
    generate(ctx) {
      if (!ctx.options.includeAria) return [];
      const { element } = ctx;
      const tag = (element.tagName || '').toLowerCase();
      if (!LABEL_FORM_TAGS.has(tag)) return [];
      const ariaLabelRaw = element.getAttribute('aria-label');
      if (ariaLabelRaw && ariaLabelRaw.trim()) return [];
      const name = findLabelText(element);
      if (!name) return [];
      const role = roleForFormTag(tag, element);
      return [
        {
          type: 'aria',
          value: `${role || 'element'}[name=${JSON.stringify(name)}]`,
          role,
          name,
          weight: LABEL_STRATEGY_WEIGHT,
          source: 'generated',
          strategy: 'label',
        },
      ];
    },
  };

  // ---- placeholder --------------------------------------------------------

  const PLACEHOLDER_STRATEGY_WEIGHT = 25;
  const PLACEHOLDER_TAGS = new Set(['input', 'textarea']);

  const placeholderStrategy = {
    id: 'placeholder',
    generate(ctx) {
      const { element, helpers } = ctx;
      const tag = (element.tagName || '').toLowerCase();
      if (!PLACEHOLDER_TAGS.has(tag)) return [];
      const raw = element.getAttribute('placeholder');
      const placeholder = raw ? raw.trim() : '';
      if (!placeholder) return [];
      const out = [];
      const escaped = helpers.cssEscape(placeholder);
      const attrOnly = `[placeholder="${escaped}"]`;
      const withTag = `${tag}[placeholder="${escaped}"]`;
      if (helpers.isUnique(attrOnly)) {
        out.push({
          type: 'attr',
          value: attrOnly,
          weight: PLACEHOLDER_STRATEGY_WEIGHT,
          source: 'generated',
          strategy: 'placeholder',
        });
      } else if (helpers.isUnique(withTag)) {
        out.push({
          type: 'attr',
          value: withTag,
          weight: PLACEHOLDER_STRATEGY_WEIGHT,
          source: 'generated',
          strategy: 'placeholder',
        });
      }
      return out;
    },
  };

  // ---- text ---------------------------------------------------------------

  const TEXT_STRATEGY_WEIGHT = 10;

  const textStrategy = {
    id: 'text',
    generate(ctx) {
      if (!ctx.options.includeText) return [];
      const { element, options } = ctx;
      const tag = (element.tagName || '').toLowerCase();
      if (!tag || !options.textTags.includes(tag)) return [];
      const raw = element.textContent || '';
      const text = normalizeWhitespace(raw).slice(0, options.textMaxLength);
      if (!text) return [];
      return [
        {
          type: 'text',
          value: text,
          match: 'contains',
          tagNameHint: tag,
          weight: TEXT_STRATEGY_WEIGHT,
          source: 'generated',
          strategy: 'text',
        },
      ];
    },
  };

  // ---- css-unique ---------------------------------------------------------

  const CU_MAX_CLASS_COUNT = 24;
  const CU_MAX_COMBO_CLASSES = 8;
  const CU_MAX_CANDIDATES = 6;
  const VALID_CLASS_TOKEN = /^[a-zA-Z0-9_-]+$/;

  const cssUniqueStrategy = {
    id: 'css-unique',
    generate(ctx) {
      if (!ctx.options.includeCssUnique) return [];
      const { element, helpers } = ctx;
      const out = [];
      const tag = (element.tagName || '').toLowerCase();
      const idRaw = element.id;
      const id = idRaw ? String(idRaw).trim() : '';
      if (id) {
        const sel = `#${helpers.cssEscape(id)}`;
        if (helpers.isUnique(sel)) {
          out.push({ type: 'css', value: sel, source: 'generated', strategy: 'css-unique' });
        }
      }
      if (out.length >= CU_MAX_CANDIDATES) return out;
      const classList = Array.from(element.classList || [])
        .map((c) => String(c).trim())
        .filter((c) => c.length > 0 && VALID_CLASS_TOKEN.test(c))
        .slice(0, CU_MAX_CLASS_COUNT);
      for (const cls of classList) {
        if (out.length >= CU_MAX_CANDIDATES) break;
        const sel = `.${helpers.cssEscape(cls)}`;
        if (helpers.isUnique(sel)) {
          out.push({ type: 'css', value: sel, source: 'generated', strategy: 'css-unique' });
        }
      }
      if (tag) {
        for (const cls of classList) {
          if (out.length >= CU_MAX_CANDIDATES) break;
          const sel = `${tag}.${helpers.cssEscape(cls)}`;
          if (helpers.isUnique(sel)) {
            out.push({ type: 'css', value: sel, source: 'generated', strategy: 'css-unique' });
          }
        }
      }
      if (out.length >= CU_MAX_CANDIDATES) return out;
      const comboSource = classList.slice(0, CU_MAX_COMBO_CLASSES).map((c) => helpers.cssEscape(c));
      const tryPush = (selector) => {
        if (out.length >= CU_MAX_CANDIDATES) return;
        if (!helpers.isUnique(selector)) return;
        out.push({ type: 'css', value: selector, source: 'generated', strategy: 'css-unique' });
      };
      const tryPushWithTag = (selector) => {
        tryPush(selector);
        if (tag) tryPush(`${tag}${selector}`);
      };
      for (let i = 0; i < comboSource.length && out.length < CU_MAX_CANDIDATES; i++) {
        for (let j = i + 1; j < comboSource.length && out.length < CU_MAX_CANDIDATES; j++) {
          tryPushWithTag(`.${comboSource[i]}.${comboSource[j]}`);
        }
      }
      for (let i = 0; i < comboSource.length && out.length < CU_MAX_CANDIDATES; i++) {
        for (let j = i + 1; j < comboSource.length && out.length < CU_MAX_CANDIDATES; j++) {
          for (let k = j + 1; k < comboSource.length && out.length < CU_MAX_CANDIDATES; k++) {
            tryPushWithTag(`.${comboSource[i]}.${comboSource[j]}.${comboSource[k]}`);
          }
        }
      }
      return out;
    },
  };

  // ---- css-path -----------------------------------------------------------

  const CSS_PATH_STRATEGY_WEIGHT = -30;

  const cssPathStrategy = {
    id: 'css-path',
    generate(ctx) {
      if (!ctx.options.includeCssPath) return [];
      const { element } = ctx;
      const segments = [];
      let current = element;
      while (current) {
        const tag = (current.tagName || '').toLowerCase();
        if (!tag) break;
        let segment = tag;
        const parent = current.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter((c) => c.tagName === current.tagName);
          if (siblings.length > 1) {
            const index = siblings.indexOf(current) + 1;
            if (index > 0) segment += `:nth-of-type(${index})`;
          }
        }
        segments.unshift(segment);
        if (tag === 'body') break;
        current = parent;
      }
      const selector = segments.length ? segments.join(' > ') : 'body';
      return [
        {
          type: 'css',
          value: selector,
          weight: CSS_PATH_STRATEGY_WEIGHT,
          source: 'generated',
          strategy: 'css-path',
        },
      ];
    },
  };

  // ---- anchor-relpath -----------------------------------------------------

  const ANCHOR_RELPATH_WEIGHT = -10;
  const ANCHOR_MAX_DEPTH = 20;
  const ANCHOR_DATA_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy'];

  function safeQuerySelector(root, selector) {
    try {
      return root.querySelector(selector);
    } catch {
      return null;
    }
  }

  function getSiblings(element) {
    const parent = element.parentElement;
    if (parent) return Array.from(parent.children);
    const parentNode = element.parentNode;
    if (
      parentNode &&
      ((typeof ShadowRoot !== 'undefined' && parentNode instanceof ShadowRoot) ||
        parentNode instanceof Document)
    ) {
      return Array.from(parentNode.children);
    }
    return [];
  }

  function tryAnchorSelector(element, ctx) {
    const { helpers } = ctx;
    const tag = (element.tagName || '').toLowerCase();
    const idRaw = element.id;
    const id = idRaw ? String(idRaw).trim() : '';
    if (id) {
      const idSel = `#${helpers.cssEscape(id)}`;
      if (helpers.isUnique(idSel)) return idSel;
    }
    for (const attr of ANCHOR_DATA_ATTRS) {
      const raw = element.getAttribute(attr);
      const value = raw ? raw.trim() : '';
      if (!value) continue;
      const escaped = helpers.cssEscape(value);
      const attrOnly = `[${attr}="${escaped}"]`;
      if (helpers.isUnique(attrOnly)) return attrOnly;
      const withTag = `${tag}${attrOnly}`;
      if (helpers.isUnique(withTag)) return withTag;
    }
    return null;
  }

  function buildRelativePathSelector(ancestor, target, root) {
    const segments = [];
    let current = target;
    for (let depth = 0; current && current !== ancestor && depth < ANCHOR_MAX_DEPTH; depth++) {
      const tag = (current.tagName || '').toLowerCase();
      let segment = tag;
      const siblings = getSiblings(current);
      const sameTagSiblings = siblings.filter((s) => s.tagName === current.tagName);
      if (sameTagSiblings.length > 1) {
        const index = sameTagSiblings.indexOf(current) + 1;
        segment += `:nth-of-type(${index})`;
      }
      segments.unshift(segment);
      const parentEl = current.parentElement;
      if (!parentEl) {
        const parentNode = current.parentNode;
        if (parentNode === root) break;
        break;
      }
      current = parentEl;
    }
    if (current !== ancestor) return null;
    return segments.length > 0 ? segments.join(' > ') : null;
  }

  function buildAnchorRelPathSelector(element, ctx) {
    const { root } = ctx;
    const isQueryableRoot =
      root instanceof Document || (typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot);
    if (!isQueryableRoot) return null;
    let current = element.parentElement;
    for (let depth = 0; current && depth < ANCHOR_MAX_DEPTH; depth++) {
      const tagUpper = (current.tagName || '').toUpperCase();
      if (tagUpper === 'HTML' || tagUpper === 'BODY') break;
      const anchor = tryAnchorSelector(current, ctx);
      if (!anchor) {
        current = current.parentElement;
        continue;
      }
      const relativePath = buildRelativePathSelector(current, element, root);
      if (!relativePath) {
        current = current.parentElement;
        continue;
      }
      const composed = `${anchor} ${relativePath}`;
      if (!ctx.helpers.isUnique(composed)) {
        current = current.parentElement;
        continue;
      }
      const found = safeQuerySelector(root, composed);
      if (found === element) return composed;
      current = current.parentElement;
    }
    return null;
  }

  const anchorRelpathStrategy = {
    id: 'anchor-relpath',
    generate(ctx) {
      const selector = buildAnchorRelPathSelector(ctx.element, ctx);
      if (!selector) return [];
      return [
        {
          type: 'css',
          value: selector,
          weight: ANCHOR_RELPATH_WEIGHT,
          source: 'generated',
          strategy: 'anchor-relpath',
        },
      ];
    },
  };

  // ==========================================================================
  // Generator (mirrors shared/selector/generator.ts)
  // ==========================================================================

  const DEFAULT_MAX_CANDIDATES = 8;
  const DEFAULT_TEXT_MAX_LENGTH = 64;
  const DEFAULT_TEXT_TAGS = ['button', 'a', 'summary'];
  const DEFAULT_TESTID_ATTRS = [
    'data-testid',
    'data-test-id',
    'data-testId',
    'data-test',
    'data-qa',
    'data-cy',
    'name',
    'title',
    'alt',
  ];

  function normalizeGenerationOptions(options) {
    const o = options || {};
    return {
      maxCandidates: clampInt(
        o.maxCandidates != null ? o.maxCandidates : DEFAULT_MAX_CANDIDATES,
        1,
        50,
      ),
      includeText: o.includeText !== false,
      includeAria: o.includeAria !== false,
      includeCssUnique: o.includeCssUnique !== false,
      includeCssPath: o.includeCssPath !== false,
      testIdAttributes: o.testIdAttributes || DEFAULT_TESTID_ATTRS,
      textMaxLength: clampInt(
        o.textMaxLength != null ? o.textMaxLength : DEFAULT_TEXT_MAX_LENGTH,
        1,
        256,
      ),
      textTags: o.textTags || DEFAULT_TEXT_TAGS,
    };
  }

  const DEFAULT_STRATEGIES = [
    testIdStrategy,
    ariaStrategy,
    labelStrategy,
    placeholderStrategy,
    cssUniqueStrategy,
    cssPathStrategy,
    anchorRelpathStrategy,
    textStrategy,
  ];

  function candidateKey(c) {
    if (c.type === 'text') return `text:${c.value}:${c.tagNameHint || ''}:${c.match || ''}`;
    if (c.type === 'aria') return `aria:${c.role || ''}:${c.name || ''}:${c.value}`;
    return `${c.type}:${c.value}`;
  }

  function generateSelectorTarget(element, options) {
    options = options || {};
    const normalized = normalizeGenerationOptions(options);
    const queryRoot = options.root || getQueryRoot(element);
    const helpers = {
      cssEscape,
      isUnique: (selector) => isUnique(queryRoot, selector),
      safeQueryAll: (selector) => safeQueryAll(queryRoot, selector),
    };
    const ctx = { element, root: queryRoot, options: normalized, helpers };
    const strategies = options.strategies || DEFAULT_STRATEGIES;
    const raw = [];
    for (const strategy of strategies) {
      const produced = strategy.generate(ctx) || [];
      for (const c0 of produced) {
        raw.push(
          Object.assign({}, c0, {
            source: c0.source || 'generated',
            strategy: c0.strategy || strategy.id,
          }),
        );
      }
    }
    const seen = new Set();
    const deduped = [];
    for (const c of raw) {
      const key = candidateKey(c);
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(withStability(c));
    }
    if (deduped.length === 0) {
      const fallback = withStability({
        type: 'css',
        value: 'body',
        source: 'generated',
        strategy: 'fallback',
      });
      const tagName = element.tagName ? element.tagName.toLowerCase() : undefined;
      return {
        selector: fallback.value,
        candidates: [fallback],
        tagName,
      };
    }
    const sorted = deduped
      .slice()
      .sort(compareSelectorCandidates)
      .slice(0, normalized.maxCandidates);
    // candidates[0] = highest-priority by weight+stability (Playwright ladder).
    // selector = best CSS/attr for the locator's fast-path; falls back to
    // sorted[0].value when no CSS/attr exists.
    const cssOrAttrPrimary = sorted.find((c) => c.type === 'css' || c.type === 'attr');
    const selectorValue = (cssOrAttrPrimary || sorted[0]).value;
    const tagName = element.tagName ? element.tagName.toLowerCase() : undefined;
    return {
      selector: selectorValue,
      candidates: sorted,
      tagName,
    };
  }

  // ==========================================================================
  // Fingerprint + DOM path (mirrors shared/selector/{fingerprint,dom-path}.ts)
  // ==========================================================================

  const FP_TEXT_MAX = 32;
  const FP_MAX_CLASSES = 8;
  const FP_SEPARATOR = '|';

  function normalizeFpText(text, max) {
    return text.replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function computeFingerprint(element, options) {
    const o = options || {};
    const textMax = o.textMaxLength != null ? o.textMaxLength : FP_TEXT_MAX;
    const maxClasses = o.maxClasses != null ? o.maxClasses : FP_MAX_CLASSES;
    const parts = [];
    const tag = element.tagName ? element.tagName.toLowerCase() : 'unknown';
    parts.push(tag);
    const id = element.id ? String(element.id).trim() : '';
    if (id) parts.push(`id=${id}`);
    const classes = Array.from(element.classList || []).slice(0, maxClasses);
    if (classes.length > 0) parts.push(`class=${classes.join('.')}`);
    const text = normalizeFpText(element.textContent || '', textMax);
    if (text) parts.push(`text=${text}`);
    return parts.join(FP_SEPARATOR);
  }

  function computeDomPath(element) {
    const path = [];
    let current = element;
    while (current) {
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children);
        const index = siblings.indexOf(current);
        if (index >= 0) path.unshift(index);
        current = parent;
        continue;
      }
      const parentNode = current.parentNode;
      if (
        parentNode &&
        ((typeof ShadowRoot !== 'undefined' && parentNode instanceof ShadowRoot) ||
          parentNode instanceof Document)
      ) {
        const children = Array.from(parentNode.children);
        const index = children.indexOf(current);
        if (index >= 0) path.unshift(index);
      }
      break;
    }
    return path;
  }

  // ==========================================================================
  // Shadow host chain (mirrors shared/selector/generator.ts shadow logic)
  // ==========================================================================

  function safeMatches(element, selector) {
    try {
      return element.matches(selector);
    } catch {
      return false;
    }
  }

  function pickShadowHostSelector(host, hostRoot, options) {
    const hostTarget = generateSelectorTarget(host, Object.assign({}, options, { root: hostRoot }));
    let fallback = null;
    for (const candidate of hostTarget.candidates) {
      if (candidate.type !== 'css' && candidate.type !== 'attr') continue;
      const selector = String(candidate.value || '').trim();
      if (!selector) continue;
      if (!safeMatches(host, selector)) continue;
      if (isUnique(hostRoot, selector)) return selector;
      if (!fallback) fallback = selector;
    }
    const primary = typeof hostTarget.selector === 'string' ? hostTarget.selector.trim() : '';
    if (primary && safeMatches(host, primary)) return primary;
    return fallback;
  }

  function computeShadowHostChain(element, options) {
    const chain = [];
    let current = element;
    while (true) {
      const rootNode = current.getRootNode ? current.getRootNode() : null;
      if (!(rootNode && typeof ShadowRoot !== 'undefined' && rootNode instanceof ShadowRoot)) break;
      const host = rootNode.host;
      if (!(host instanceof Element)) break;
      const hostRoot = getQueryRoot(host);
      const hostSelector = pickShadowHostSelector(host, hostRoot, options);
      if (!hostSelector) return [];
      chain.unshift(hostSelector);
      current = host;
    }
    return chain;
  }

  function generateExtendedSelectorTarget(element, options) {
    const base = generateSelectorTarget(element, options || {});
    return Object.assign({}, base, {
      fingerprint: computeFingerprint(element),
      domPath: computeDomPath(element),
      shadowHostChain: computeShadowHostChain(element, options || {}),
    });
  }

  // ==========================================================================
  // Export
  // ==========================================================================

  root.__rrSelectorEngine = {
    generateSelectorTarget,
    generateExtendedSelectorTarget,
    compareSelectorCandidates,
    withStability,
    computeSelectorStability,
    computeFingerprint,
    computeDomPath,
    cssEscape,
    // Internals exported for tests/diagnostics:
    _strategies: {
      testid: testIdStrategy,
      aria: ariaStrategy,
      label: labelStrategy,
      placeholder: placeholderStrategy,
      cssUnique: cssUniqueStrategy,
      cssPath: cssPathStrategy,
      anchorRelpath: anchorRelpathStrategy,
      text: textStrategy,
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
