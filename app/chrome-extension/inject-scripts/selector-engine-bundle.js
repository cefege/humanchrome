"use strict";
(() => {
  // app/chrome-extension/shared/selector/types.ts
  var COMPOSITE_SELECTOR_SEPARATOR = "|>";
  function splitCompositeSelector(selector) {
    if (typeof selector !== "string") return null;
    const parts = selector.split(COMPOSITE_SELECTOR_SEPARATOR).map((s) => s.trim()).filter(Boolean);
    if (parts.length < 2) return null;
    return {
      frameSelector: parts[0],
      innerSelector: parts.slice(1).join(` ${COMPOSITE_SELECTOR_SEPARATOR} `)
    };
  }

  // app/chrome-extension/shared/selector/stability.ts
  var TESTID_ATTR_NAMES = [
    "data-testid",
    "data-test-id",
    "data-test",
    "data-qa",
    "data-cy"
  ];
  function clamp01(n) {
    if (!Number.isFinite(n)) return 0;
    return Math.min(1, Math.max(0, n));
  }
  function mergeSignals(a, b) {
    return {
      usesId: a.usesId || b.usesId || void 0,
      usesTestId: a.usesTestId || b.usesTestId || void 0,
      usesAria: a.usesAria || b.usesAria || void 0,
      usesText: a.usesText || b.usesText || void 0,
      usesNthOfType: a.usesNthOfType || b.usesNthOfType || void 0,
      usesAttributes: a.usesAttributes || b.usesAttributes || void 0,
      usesClass: a.usesClass || b.usesClass || void 0
    };
  }
  function analyzeCssLike(selector) {
    const s = String(selector || "");
    const usesNthOfType = /:nth-of-type\(/i.test(s);
    const usesAttributes = /\[[^\]]+\]/.test(s);
    const usesAria = /\[\s*aria-[^=]+\s*=|\[\s*role\s*=|\brole\s*=\s*/i.test(s);
    const usesId = /(^|[\s>+~])#[^\s>+~.:#[]+/.test(s);
    const usesClass = /(^|[\s>+~])\.[^\s>+~.:#[]+/.test(s);
    const lower = s.toLowerCase();
    const usesTestId = TESTID_ATTR_NAMES.some((a) => lower.includes(`[${a}`));
    return {
      usesId: usesId || void 0,
      usesTestId: usesTestId || void 0,
      usesAria: usesAria || void 0,
      usesNthOfType: usesNthOfType || void 0,
      usesAttributes: usesAttributes || void 0,
      usesClass: usesClass || void 0
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
    if (candidate.type === "css" || candidate.type === "attr") {
      const composite = splitCompositeSelector(candidate.value);
      if (composite) {
        const a = analyzeCssLike(composite.frameSelector);
        const b = analyzeCssLike(composite.innerSelector);
        const merged = mergeSignals(a, b);
        let score3 = baseScoreForCssSignals(merged);
        score3 -= 0.05;
        if (merged.usesNthOfType) score3 -= 0.2;
        score3 -= lengthPenalty(candidate.value);
        return { score: clamp01(score3), signals: merged, note: "composite" };
      }
      const signals2 = analyzeCssLike(candidate.value);
      let score2 = baseScoreForCssSignals(signals2);
      if (signals2.usesNthOfType) score2 -= 0.2;
      score2 -= lengthPenalty(candidate.value);
      return { score: clamp01(score2), signals: signals2 };
    }
    if (candidate.type === "xpath") {
      const s = String(candidate.value || "");
      const signals2 = {
        usesAttributes: /@[\w-]+\s*=/.test(s) || void 0,
        usesId: /@id\s*=/.test(s) || void 0,
        usesTestId: /@data-testid\s*=/.test(s) || void 0
      };
      let score2 = 0.42;
      if (signals2.usesTestId) score2 = 0.85;
      else if (signals2.usesId) score2 = 0.75;
      else if (signals2.usesAttributes) score2 = 0.55;
      score2 -= lengthPenalty(s);
      return { score: clamp01(score2), signals: signals2 };
    }
    if (candidate.type === "aria") {
      const hasName = typeof candidate.name === "string" && candidate.name.trim().length > 0;
      const hasRole = typeof candidate.role === "string" && candidate.role.trim().length > 0;
      const signals2 = { usesAria: true };
      let score2 = hasName && hasRole ? 0.8 : hasName ? 0.72 : 0.6;
      score2 -= lengthPenalty(candidate.value);
      return { score: clamp01(score2), signals: signals2 };
    }
    if (candidate.type === "role") {
      const hasName = typeof candidate.name === "string" && candidate.name.trim().length > 0;
      const signals2 = { usesAria: true };
      let score2 = hasName ? 0.88 : 0.6;
      score2 -= lengthPenalty(candidate.value);
      return { score: clamp01(score2), signals: signals2 };
    }
    if (candidate.type === "testid") {
      const signals2 = { usesTestId: true };
      let score2 = 0.95;
      score2 -= lengthPenalty(candidate.value);
      return { score: clamp01(score2), signals: signals2 };
    }
    if (candidate.type === "label" || candidate.type === "placeholder" || candidate.type === "alt" || candidate.type === "title") {
      const signals2 = { usesAttributes: true };
      const baseScore = candidate.type === "label" ? 0.82 : candidate.type === "placeholder" ? 0.7 : candidate.type === "alt" ? 0.75 : 0.6;
      let score2 = baseScore;
      score2 -= lengthPenalty(candidate.value);
      return { score: clamp01(score2), signals: signals2 };
    }
    const text = String(candidate.value || "").trim();
    const signals = { usesText: true };
    let score = 0.35;
    if (text.length >= 6 && text.length <= 48) score = 0.45;
    if (text.length > 80) score = 0.3;
    return { score: clamp01(score), signals };
  }
  function withStability(candidate) {
    if (candidate.stability) return candidate;
    return { ...candidate, stability: computeSelectorStability(candidate) };
  }
  function typePriority(type) {
    switch (type) {
      case "testid":
        return 8;
      // strongest — explicit test attribute
      case "attr":
        return 5;
      case "css":
        return 4;
      case "role":
        return 7;
      // strong — role + accessible name
      case "label":
        return 6;
      // strong — form labels are sticky
      case "placeholder":
      case "alt":
      case "title":
        return 3;
      // moderate — attribute-based
      case "aria":
        return 3;
      case "xpath":
        return 2;
      case "text":
        return 1;
      default:
        return 0;
    }
  }
  function compareSelectorCandidates(a, b) {
    const aw = a.weight ?? 0;
    const bw = b.weight ?? 0;
    if (aw !== bw) return bw - aw;
    const as = a.stability?.score ?? computeSelectorStability(a).score;
    const bs = b.stability?.score ?? computeSelectorStability(b).score;
    if (as !== bs) return bs - as;
    const ap = typePriority(a.type);
    const bp = typePriority(b.type);
    if (ap !== bp) return bp - ap;
    const alen = String(a.value || "").length;
    const blen = String(b.value || "").length;
    return alen - blen;
  }

  // app/chrome-extension/shared/selector/accessible-name.ts
  var MAX_NAME_LENGTH = 1024;
  var LABELLABLE_TAGS = /* @__PURE__ */ new Set([
    "input",
    "textarea",
    "select",
    "button",
    "output",
    "progress",
    "meter"
  ]);
  var NAME_FROM_CONTENT_ROLES = /* @__PURE__ */ new Set([
    "button",
    "cell",
    "checkbox",
    "columnheader",
    "gridcell",
    "heading",
    "link",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "radio",
    "row",
    "rowheader",
    "switch",
    "tab",
    "tooltip",
    "treeitem"
  ]);
  var NAME_FROM_CONTENT_TAGS = /* @__PURE__ */ new Set([
    "a",
    "button",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "summary",
    "option"
  ]);
  function normalize(text) {
    return text.replace(/\s+/g, " ").trim();
  }
  function isHidden(el) {
    if (el.getAttribute("aria-hidden") === "true") return true;
    if (el.hasAttribute("hidden")) return true;
    return false;
  }
  function computeFromLabelledBy(el, ids, visited) {
    const root = el.ownerDocument;
    if (!root) return null;
    const parts = [];
    for (const id of ids) {
      const trimmed = id.trim();
      if (!trimmed) continue;
      const ref = root.getElementById(trimmed);
      if (!ref || visited.has(ref)) continue;
      const name = computeAccessibleNameInternal(ref, {
        visited,
        includeHidden: true,
        // §4.3.2 step 2A.iii.b — hidden text is in scope when traversing labelledby
        // §4.3.2 step 2F.iii: when computing as part of a labelledby ref, name
        // from content applies even to elements (like <span>) whose implicit
        // role wouldn't normally allow it.
        forceContent: true
      });
      if (name) parts.push(name);
    }
    const out = parts.join(" ").trim();
    return out || null;
  }
  function nativeHostLabel(el) {
    const tag = el.tagName.toLowerCase();
    const id = el.id;
    if (id && el.ownerDocument) {
      const escaped = el.ownerDocument.defaultView?.CSS?.escape?.(id) ?? id;
      const explicitLabel = el.ownerDocument.querySelector(`label[for="${escaped}"]`);
      if (explicitLabel) {
        const text = normalize(explicitLabel.textContent || "");
        if (text) return text;
      }
    }
    if (LABELLABLE_TAGS.has(tag)) {
      let current = el.parentElement;
      while (current) {
        if (current.tagName.toLowerCase() === "label") {
          const clone = current.cloneNode(true);
          clone.querySelectorAll([...LABELLABLE_TAGS].join(",")).forEach((c) => c.remove());
          const text = normalize(clone.textContent || "");
          if (text) return text;
          break;
        }
        current = current.parentElement;
      }
    }
    if (tag === "input") {
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (type === "submit" || type === "button" || type === "reset") {
        const value = el.getAttribute("value");
        if (value) return normalize(value);
        if (type === "submit") return "Submit";
        if (type === "reset") return "Reset";
      }
      if (type === "image") {
        const alt = el.getAttribute("alt");
        if (alt) return normalize(alt);
      }
    }
    if (tag === "img" || tag === "area") {
      const alt = el.getAttribute("alt");
      if (alt !== null) return normalize(alt);
    }
    if (tag === "fieldset") {
      const legend = el.querySelector(":scope > legend");
      if (legend) {
        const text = normalize(legend.textContent || "");
        if (text) return text;
      }
    }
    if (tag === "table") {
      const caption = el.querySelector(":scope > caption");
      if (caption) {
        const text = normalize(caption.textContent || "");
        if (text) return text;
      }
    }
    if (tag === "summary") {
      const text = normalize(el.textContent || "");
      if (text) return text;
    }
    return null;
  }
  function nameFromContent(el, visited) {
    const parts = [];
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 3) {
        parts.push(child.textContent || "");
        continue;
      }
      if (child.nodeType !== 1) continue;
      const childEl = child;
      if (isHidden(childEl)) continue;
      const childName = computeAccessibleNameInternal(childEl, { visited, forceContent: true });
      if (childName) {
        parts.push(childName);
      } else {
        const text = childEl.textContent || "";
        if (text) parts.push(text);
      }
    }
    return normalize(parts.join(" "));
  }
  function computeAccessibleNameInternal(el, options = {}) {
    if (!el || !el.tagName) return "";
    const visited = options.visited ?? /* @__PURE__ */ new WeakSet();
    if (visited.has(el)) return "";
    visited.add(el);
    if (!options.includeHidden && isHidden(el)) return "";
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const ids = labelledBy.split(/\s+/);
      const fromLb = computeFromLabelledBy(el, ids, visited);
      if (fromLb) return fromLb.slice(0, MAX_NAME_LENGTH);
    }
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) {
      const trimmed = normalize(ariaLabel);
      if (trimmed) return trimmed.slice(0, MAX_NAME_LENGTH);
    }
    const native = nativeHostLabel(el);
    if (native) return native.slice(0, MAX_NAME_LENGTH);
    const role = el.getAttribute("role")?.toLowerCase();
    const tag = el.tagName.toLowerCase();
    const allowsContent = options.forceContent || role && NAME_FROM_CONTENT_ROLES.has(role) || NAME_FROM_CONTENT_TAGS.has(tag);
    if (allowsContent) {
      const fromContent = nameFromContent(el, visited);
      if (fromContent) return fromContent.slice(0, MAX_NAME_LENGTH);
    }
    const title = el.getAttribute("title");
    if (title) {
      const trimmed = normalize(title);
      if (trimmed) return trimmed.slice(0, MAX_NAME_LENGTH);
    }
    return "";
  }
  function computeAccessibleName(el) {
    if (!el) return "";
    return computeAccessibleNameInternal(el, {});
  }
  function matchesAccessibleName(computed, target, mode = "contains") {
    if (target instanceof RegExp) return target.test(computed);
    const a = normalize(computed);
    const b = normalize(target);
    if (!a || !b) return false;
    if (mode === "exact") return a === b;
    if (mode === "iexact") return a.toLowerCase() === b.toLowerCase();
    return a.toLowerCase().includes(b.toLowerCase());
  }

  // app/chrome-extension/shared/selector/strategies/alt-text.ts
  var ALT_TAGS = /* @__PURE__ */ new Set(["img", "area"]);
  function hasAlt(el) {
    const tag = el.tagName.toLowerCase();
    if (ALT_TAGS.has(tag)) return el.hasAttribute("alt");
    if (tag === "input") return (el.getAttribute("type") || "").toLowerCase() === "image";
    return false;
  }
  function resolveByAltText(scope, text, exact) {
    const target = String(text || "").trim();
    if (!target) return [];
    const mode = exact ? "exact" : "contains";
    const out = [];
    const candidates = scope.querySelectorAll('img[alt], area[alt], input[type="image"][alt]');
    for (const el of Array.from(candidates)) {
      const alt = el.getAttribute("alt") ?? "";
      if (matchesAccessibleName(alt, target, mode)) out.push(el);
    }
    return out;
  }
  var altTextStrategy = {
    id: "alt-text",
    generate(ctx) {
      const { element } = ctx;
      if (!hasAlt(element)) return [];
      const alt = element.getAttribute("alt");
      if (!alt || !alt.trim()) return [];
      const out = [
        {
          type: "alt",
          text: alt.trim(),
          value: alt.trim(),
          source: "generated",
          strategy: "alt-text"
        }
      ];
      return out;
    },
    resolve(value, scope, extras) {
      return resolveByAltText(scope, value, extras?.exact);
    }
  };

  // app/chrome-extension/shared/selector/strategies/anchor-relpath.ts
  var MAX_ANCHOR_DEPTH = 20;
  var ANCHOR_DATA_ATTRS = [
    "data-testid",
    "data-test-id",
    "data-test",
    "data-qa",
    "data-cy"
  ];
  var ANCHOR_RELPATH_WEIGHT = -10;
  function safeQuerySelector(root, selector) {
    try {
      return root.querySelector(selector);
    } catch {
      return null;
    }
  }
  function getSiblings(element) {
    const parent = element.parentElement;
    if (parent) {
      return Array.from(parent.children);
    }
    const parentNode = element.parentNode;
    if (parentNode instanceof ShadowRoot || parentNode instanceof Document) {
      return Array.from(parentNode.children);
    }
    return [];
  }
  function tryAnchorSelector(element, ctx) {
    const { helpers } = ctx;
    const tag = element.tagName.toLowerCase();
    const id = element.id?.trim();
    if (id) {
      const idSelector = `#${helpers.cssEscape(id)}`;
      if (helpers.isUnique(idSelector)) {
        return idSelector;
      }
    }
    for (const attr of ANCHOR_DATA_ATTRS) {
      const value = element.getAttribute(attr)?.trim();
      if (!value) continue;
      const escaped = helpers.cssEscape(value);
      const attrOnly = `[${attr}="${escaped}"]`;
      if (helpers.isUnique(attrOnly)) {
        return attrOnly;
      }
      const withTag = `${tag}${attrOnly}`;
      if (helpers.isUnique(withTag)) {
        return withTag;
      }
    }
    return null;
  }
  function buildRelativePathSelector(ancestor, target, root) {
    const segments = [];
    let current = target;
    for (let depth = 0; current && current !== ancestor && depth < MAX_ANCHOR_DEPTH; depth++) {
      const tag = current.tagName.toLowerCase();
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
    if (current !== ancestor) {
      return null;
    }
    return segments.length > 0 ? segments.join(" > ") : null;
  }
  function buildAnchorRelPathSelector(element, ctx) {
    const { root } = ctx;
    if (!(root instanceof Document || root instanceof ShadowRoot)) {
      return null;
    }
    let current = element.parentElement;
    for (let depth = 0; current && depth < MAX_ANCHOR_DEPTH; depth++) {
      const tagUpper = current.tagName.toUpperCase();
      if (tagUpper === "HTML" || tagUpper === "BODY") {
        break;
      }
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
      if (found === element) {
        return composed;
      }
      current = current.parentElement;
    }
    return null;
  }
  var anchorRelpathStrategy = {
    id: "anchor-relpath",
    generate(ctx) {
      const selector = buildAnchorRelPathSelector(ctx.element, ctx);
      if (!selector) {
        return [];
      }
      return [
        {
          type: "css",
          value: selector,
          weight: ANCHOR_RELPATH_WEIGHT,
          source: "generated",
          strategy: "anchor-relpath"
        }
      ];
    }
  };

  // app/chrome-extension/shared/selector/strategies/aria.ts
  var ARIA_STRATEGY_WEIGHT = 40;
  function guessRoleByTag(tag) {
    if (tag === "input" || tag === "textarea") return "textbox";
    if (tag === "button") return "button";
    if (tag === "a") return "link";
    return void 0;
  }
  function uniqStrings(items) {
    const seen = /* @__PURE__ */ new Set();
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
  var ariaStrategy = {
    id: "aria",
    generate(ctx) {
      if (!ctx.options.includeAria) return [];
      const { element, helpers } = ctx;
      const out = [];
      const name = element.getAttribute("aria-label")?.trim();
      if (!name) return out;
      const tag = element.tagName?.toLowerCase?.() ?? "";
      const role = element.getAttribute("role")?.trim() || guessRoleByTag(tag);
      const qName = JSON.stringify(name);
      const selectors = [];
      if (role) selectors.push(`[role=${JSON.stringify(role)}][aria-label=${qName}]`);
      selectors.push(`[aria-label=${qName}]`);
      if (role === "textbox") {
        selectors.unshift(
          `input[aria-label=${qName}]`,
          `textarea[aria-label=${qName}]`,
          `[role="textbox"][aria-label=${qName}]`
        );
      } else if (role === "button") {
        selectors.unshift(`button[aria-label=${qName}]`, `[role="button"][aria-label=${qName}]`);
      } else if (role === "link") {
        selectors.unshift(`a[aria-label=${qName}]`, `[role="link"][aria-label=${qName}]`);
      }
      for (const sel of uniqStrings(selectors)) {
        if (helpers.isUnique(sel)) {
          out.push({
            type: "attr",
            value: sel,
            weight: ARIA_STRATEGY_WEIGHT,
            source: "generated",
            strategy: "aria"
          });
        }
      }
      out.push({
        type: "aria",
        value: `${role ?? "element"}[name=${JSON.stringify(name)}]`,
        role,
        name,
        weight: ARIA_STRATEGY_WEIGHT,
        source: "generated",
        strategy: "aria"
      });
      return out;
    }
  };

  // app/chrome-extension/shared/selector/strategies/css-path.ts
  var CSS_PATH_STRATEGY_WEIGHT = -30;
  var cssPathStrategy = {
    id: "css-path",
    generate(ctx) {
      if (!ctx.options.includeCssPath) return [];
      const { element } = ctx;
      const segments = [];
      let current = element;
      while (current) {
        const tag = current.tagName?.toLowerCase?.() ?? "";
        if (!tag) break;
        let segment = tag;
        const parent = current.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter(
            (c) => c.tagName === current.tagName
          );
          if (siblings.length > 1) {
            const index = siblings.indexOf(current) + 1;
            if (index > 0) segment += `:nth-of-type(${index})`;
          }
        }
        segments.unshift(segment);
        if (tag === "body") break;
        current = parent;
      }
      const selector = segments.length ? segments.join(" > ") : "body";
      const out = [
        {
          type: "css",
          value: selector,
          weight: CSS_PATH_STRATEGY_WEIGHT,
          source: "generated",
          strategy: "css-path"
        }
      ];
      return out;
    }
  };

  // app/chrome-extension/shared/selector/strategies/css-unique.ts
  var MAX_CLASS_COUNT = 24;
  var MAX_COMBO_CLASSES = 8;
  var MAX_CANDIDATES = 6;
  function isValidClassToken(token) {
    return /^[a-zA-Z0-9_-]+$/.test(token);
  }
  var cssUniqueStrategy = {
    id: "css-unique",
    generate(ctx) {
      if (!ctx.options.includeCssUnique) return [];
      const { element, helpers } = ctx;
      const out = [];
      const tag = element.tagName?.toLowerCase?.() ?? "";
      const id = element.id?.trim();
      if (id) {
        const sel = `#${helpers.cssEscape(id)}`;
        if (helpers.isUnique(sel)) {
          out.push({ type: "css", value: sel, source: "generated", strategy: "css-unique" });
        }
      }
      if (out.length >= MAX_CANDIDATES) return out;
      const classList = Array.from(element.classList || []).map((c) => String(c).trim()).filter((c) => c.length > 0 && isValidClassToken(c)).slice(0, MAX_CLASS_COUNT);
      for (const cls of classList) {
        if (out.length >= MAX_CANDIDATES) break;
        const sel = `.${helpers.cssEscape(cls)}`;
        if (helpers.isUnique(sel)) {
          out.push({ type: "css", value: sel, source: "generated", strategy: "css-unique" });
        }
      }
      if (tag) {
        for (const cls of classList) {
          if (out.length >= MAX_CANDIDATES) break;
          const sel = `${tag}.${helpers.cssEscape(cls)}`;
          if (helpers.isUnique(sel)) {
            out.push({ type: "css", value: sel, source: "generated", strategy: "css-unique" });
          }
        }
      }
      if (out.length >= MAX_CANDIDATES) return out;
      const comboSource = classList.slice(0, MAX_COMBO_CLASSES).map((c) => helpers.cssEscape(c));
      const tryPush = (selector) => {
        if (out.length >= MAX_CANDIDATES) return;
        if (!helpers.isUnique(selector)) return;
        out.push({ type: "css", value: selector, source: "generated", strategy: "css-unique" });
      };
      const tryPushWithTag = (selector) => {
        tryPush(selector);
        if (tag) tryPush(`${tag}${selector}`);
      };
      for (let i = 0; i < comboSource.length && out.length < MAX_CANDIDATES; i++) {
        for (let j = i + 1; j < comboSource.length && out.length < MAX_CANDIDATES; j++) {
          tryPushWithTag(`.${comboSource[i]}.${comboSource[j]}`);
        }
      }
      for (let i = 0; i < comboSource.length && out.length < MAX_CANDIDATES; i++) {
        for (let j = i + 1; j < comboSource.length && out.length < MAX_CANDIDATES; j++) {
          for (let k = j + 1; k < comboSource.length && out.length < MAX_CANDIDATES; k++) {
            tryPushWithTag(`.${comboSource[i]}.${comboSource[j]}.${comboSource[k]}`);
          }
        }
      }
      return out;
    }
  };

  // app/chrome-extension/shared/selector/strategies/label.ts
  function resolveByLabel(scope, text, exact) {
    const out = [];
    const mode = exact ? "exact" : "contains";
    const target = String(text || "").trim();
    if (!target) return [];
    const doc = scope.ownerDocument ?? document;
    const walker = doc.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT);
    if (scope instanceof Element) checkOne(scope);
    let node;
    while (node = walker.nextNode()) {
      if (node instanceof Element) checkOne(node);
    }
    function checkOne(el) {
      const tag = el.tagName.toLowerCase();
      if (!LABELLABLE_TAGS.has(tag)) return;
      if (tag === "input" && (el.getAttribute("type") || "").toLowerCase() === "hidden") return;
      const name = computeAccessibleName(el);
      if (name && matchesAccessibleName(name, target, mode)) {
        out.push(el);
        return;
      }
    }
    return out;
  }
  var labelStrategy = {
    id: "label",
    generate(ctx) {
      const { element } = ctx;
      const tag = element.tagName.toLowerCase();
      if (!LABELLABLE_TAGS.has(tag)) return [];
      const name = computeAccessibleName(element);
      if (!name) return [];
      const out = [
        {
          type: "label",
          text: name,
          value: name,
          source: "generated",
          strategy: "label"
        }
      ];
      return out;
    },
    resolve(value, scope, extras) {
      return resolveByLabel(scope, value, extras?.exact);
    }
  };
  function recorderRoleForFormTag(tag, element) {
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag !== "input") return void 0;
    const type = (element.getAttribute("type") || "text").toLowerCase();
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "button" || type === "submit" || type === "reset") return "button";
    if (type === "range") return "slider";
    if (type === "search") return "searchbox";
    return "textbox";
  }
  function normalizeRecorderLabelWhitespace(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }
  function readRecorderLabelText(element) {
    const innerText = element.innerText;
    return normalizeRecorderLabelWhitespace(
      typeof innerText === "string" ? innerText : element.textContent || ""
    );
  }
  function findRecorderLabelText(element, cssEscape2) {
    const labelledByRaw = element.getAttribute("aria-labelledby");
    const labelledBy = labelledByRaw ? labelledByRaw.trim() : "";
    if (labelledBy) {
      const root = element.getRootNode?.() ?? document;
      const ids = labelledBy.split(/\s+/).filter(Boolean);
      const parts = [];
      for (const id2 of ids) {
        try {
          const ref = typeof root.getElementById === "function" ? root.getElementById(id2) : root.querySelector?.(`#${cssEscape2(id2)}`);
          if (ref) {
            const text = readRecorderLabelText(ref);
            if (text) parts.push(text);
          }
        } catch {
        }
      }
      const joined = parts.join(" ").trim();
      if (joined) return joined;
    }
    const id = element.id ? String(element.id).trim() : "";
    if (id) {
      try {
        const root = element.getRootNode?.() ?? document;
        const label = root.querySelector?.(`label[for="${cssEscape2(id)}"]`);
        if (label) {
          const text = readRecorderLabelText(label);
          if (text) return text;
        }
      } catch {
      }
    }
    try {
      let cursor = element.parentElement;
      for (let depth = 0; cursor && depth < 6; depth += 1, cursor = cursor.parentElement) {
        if ((cursor.tagName || "").toLowerCase() !== "label") continue;
        const clone = cursor.cloneNode(true);
        try {
          clone.querySelectorAll("input,textarea,select,button").forEach((node) => node.remove());
        } catch {
        }
        const text = readRecorderLabelText(clone);
        if (text) return text;
        break;
      }
    } catch {
    }
    return null;
  }
  var recorderLabelStrategy = {
    id: "label",
    generate(ctx) {
      if (!ctx.options.includeAria) return [];
      const { element, helpers } = ctx;
      const tag = (element.tagName || "").toLowerCase();
      if (tag !== "input" && tag !== "textarea" && tag !== "select") return [];
      const ariaLabel = element.getAttribute("aria-label");
      if (ariaLabel && ariaLabel.trim()) return [];
      const name = findRecorderLabelText(element, helpers.cssEscape);
      if (!name) return [];
      const role = recorderRoleForFormTag(tag, element);
      return [
        {
          type: "aria",
          value: `${role || "element"}[name=${JSON.stringify(name)}]`,
          role,
          name,
          weight: 30,
          source: "generated",
          strategy: "label"
        }
      ];
    }
  };

  // app/chrome-extension/shared/selector/strategies/placeholder.ts
  function resolveByPlaceholder(scope, text, exact) {
    const target = String(text || "").trim();
    if (!target) return [];
    const mode = exact ? "exact" : "contains";
    const out = [];
    const candidates = scope.querySelectorAll("input[placeholder], textarea[placeholder]");
    for (const el of Array.from(candidates)) {
      const placeholder = el.getAttribute("placeholder") ?? "";
      if (matchesAccessibleName(placeholder, target, mode)) out.push(el);
    }
    return out;
  }
  var placeholderStrategy = {
    id: "placeholder",
    generate(ctx) {
      const { element } = ctx;
      const tag = element.tagName.toLowerCase();
      if (tag !== "input" && tag !== "textarea") return [];
      const placeholder = element.getAttribute("placeholder");
      if (!placeholder || !placeholder.trim()) return [];
      const out = [
        {
          type: "placeholder",
          text: placeholder.trim(),
          value: placeholder.trim(),
          source: "generated",
          strategy: "placeholder"
        }
      ];
      return out;
    },
    resolve(value, scope, extras) {
      return resolveByPlaceholder(scope, value, extras?.exact);
    }
  };
  var recorderPlaceholderStrategy = {
    id: "placeholder",
    generate(ctx) {
      const { element, helpers } = ctx;
      const tag = (element.tagName || "").toLowerCase();
      if (tag !== "input" && tag !== "textarea") return [];
      const raw = element.getAttribute("placeholder");
      const placeholder = raw ? raw.trim() : "";
      if (!placeholder) return [];
      const escaped = helpers.cssEscape(placeholder);
      const attrOnly = `[placeholder="${escaped}"]`;
      const withTag = `${tag}[placeholder="${escaped}"]`;
      const value = helpers.isUnique(attrOnly) ? attrOnly : helpers.isUnique(withTag) ? withTag : void 0;
      if (!value) return [];
      return [
        {
          type: "attr",
          value,
          weight: 25,
          source: "generated",
          strategy: "placeholder"
        }
      ];
    }
  };

  // app/chrome-extension/shared/selector/strategies/role.ts
  var TEXTBOX_INPUT_TYPES = /* @__PURE__ */ new Set(["text", "email", "tel", "url", "password"]);
  function getImplicitRole(el) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    switch (tag) {
      case "a":
      case "area":
        return el.hasAttribute("href") ? "link" : void 0;
      case "button":
        return "button";
      case "summary":
        return "button";
      case "input":
        if (type === "button" || type === "submit" || type === "reset" || type === "image")
          return "button";
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "search") return "searchbox";
        if (type === "range") return "slider";
        if (type === "number") return "spinbutton";
        if (type === "hidden" || type === "file" || type === "color") return void 0;
        if (el.hasAttribute("list")) return "combobox";
        if (TEXTBOX_INPUT_TYPES.has(type) || type === "") return "textbox";
        return "textbox";
      case "textarea":
        return "textbox";
      case "select": {
        if (el.hasAttribute("multiple")) return "listbox";
        const size = Number(el.getAttribute("size") || "0");
        if (size > 1) return "listbox";
        return "combobox";
      }
      case "option":
        return "option";
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
        return "heading";
      case "img":
        return el.getAttribute("alt") === "" ? void 0 : "img";
      case "ul":
      case "ol":
      case "dl":
        return "list";
      case "li":
        return "listitem";
      case "nav":
        return "navigation";
      case "main":
        return "main";
      case "header":
        return isLandmarkContext(el) ? void 0 : "banner";
      case "footer":
        return isLandmarkContext(el) ? void 0 : "contentinfo";
      case "section":
        return computeAccessibleName(el) ? "region" : void 0;
      case "article":
        return "article";
      case "aside":
        return "complementary";
      case "form":
        return computeAccessibleName(el) ? "form" : void 0;
      case "table":
        return "table";
      case "tr":
        return "row";
      case "td":
        return "cell";
      case "th": {
        const scope = (el.getAttribute("scope") || "").toLowerCase();
        if (scope === "row") return "rowheader";
        if (scope === "col") return "columnheader";
        const parent = el.parentElement;
        if (parent?.parentElement?.tagName?.toLowerCase() === "thead") return "columnheader";
        return "cell";
      }
      case "dialog":
        return "dialog";
      case "hr":
        return "separator";
      case "progress":
        return "progressbar";
      case "meter":
        return "meter";
      default:
        return void 0;
    }
  }
  function isLandmarkContext(el) {
    let p = el.parentElement;
    while (p) {
      const t = p.tagName.toLowerCase();
      if (t === "article" || t === "aside" || t === "main" || t === "nav" || t === "section")
        return true;
      p = p.parentElement;
    }
    return false;
  }
  function getElementRole(el) {
    const explicit = el.getAttribute("role");
    if (explicit) {
      const first = explicit.split(/\s+/)[0];
      if (first) return first.toLowerCase();
    }
    return getImplicitRole(el);
  }
  function resolveByRole(scope, role, name, exact) {
    const targetRole = role.trim().toLowerCase();
    if (!targetRole) return [];
    const out = [];
    const walker = (scope.ownerDocument ?? document).createTreeWalker(
      scope,
      NodeFilter.SHOW_ELEMENT
    );
    let node = walker.currentNode;
    if (scope instanceof Element) {
      if (getElementRole(scope) === targetRole) {
        if (!name || matchesAccessibleName(computeAccessibleName(scope), name, exact ? "exact" : "contains")) {
          out.push(scope);
        }
      }
    }
    while (node = walker.nextNode()) {
      if (!(node instanceof Element)) continue;
      const r = getElementRole(node);
      if (r !== targetRole) continue;
      if (name) {
        const computed = computeAccessibleName(node);
        if (!matchesAccessibleName(computed, name, exact ? "exact" : "contains")) continue;
      }
      out.push(node);
    }
    return out;
  }
  var roleStrategy = {
    id: "role",
    generate(ctx) {
      const { element } = ctx;
      const role = getElementRole(element);
      if (!role) return [];
      const name = computeAccessibleName(element);
      const out = [];
      out.push({
        type: "role",
        role,
        name: name || void 0,
        value: name ? `${role}[name=${JSON.stringify(name)}]` : role,
        source: "generated",
        strategy: "role"
      });
      return out;
    },
    /**
     * Resolve a role-based selector. Accepts either a parsed `{role,name,exact}`
     * triple (preferred — produced by `parseRoleSelector`) or the legacy serialized
     * form `role[name="..."]` for backwards compat with stored candidates.
     */
    resolve(value, scope, extras) {
      const parsed = extras?.role ? { role: extras.role, name: extras.name, exact: extras.exact } : parseRoleSelector(value);
      if (!parsed.role) return [];
      return resolveByRole(scope, parsed.role, parsed.name, parsed.exact);
    }
  };
  function parseRoleSelector(value) {
    const v = String(value || "").trim();
    if (!v) return {};
    const bare = v.match(/^[a-zA-Z][a-zA-Z0-9_-]*$/);
    if (bare) return { role: v.toLowerCase() };
    const match = v.match(/^([a-zA-Z][a-zA-Z0-9_-]*)\s*\[\s*(.+?)\s*\]$/);
    if (!match) return {};
    const role = match[1].toLowerCase();
    const body = match[2];
    const tokens = [];
    let cur = "";
    let depth = 0;
    let inStr = null;
    for (const ch of body) {
      if (inStr) {
        cur += ch;
        if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inStr = ch;
        cur += ch;
        continue;
      }
      if (ch === "," && depth === 0) {
        tokens.push(cur);
        cur = "";
        continue;
      }
      if (ch === "[" || ch === "(") depth++;
      if (ch === "]" || ch === ")") depth--;
      cur += ch;
    }
    if (cur) tokens.push(cur);
    let name;
    let exact;
    for (const tok of tokens) {
      const eq = tok.indexOf("=");
      if (eq === -1) continue;
      const k = tok.slice(0, eq).trim().toLowerCase();
      let raw = tok.slice(eq + 1).trim();
      if (raw.startsWith('"') && raw.endsWith('"') || raw.startsWith("'") && raw.endsWith("'")) {
        raw = raw.slice(1, -1);
      }
      if (k === "name") name = raw;
      if (k === "exact") exact = raw === "true" || raw === "1";
    }
    return { role, name, exact };
  }

  // app/chrome-extension/shared/selector/strategies/testid.ts
  var FORM_ELEMENT_TAGS = /* @__PURE__ */ new Set(["input", "textarea", "select", "button"]);
  var ALT_ATTRIBUTE_TAGS = /* @__PURE__ */ new Set(["img", "area"]);
  var TITLE_ATTRIBUTE_TAGS = /* @__PURE__ */ new Set(["img", "a", "abbr", "iframe", "link"]);
  var ATTR_TAG_PREFERENCES = {
    name: FORM_ELEMENT_TAGS,
    alt: ALT_ATTRIBUTE_TAGS,
    title: TITLE_ATTRIBUTE_TAGS
  };
  var DEFAULT_TESTID_ATTRIBUTES = [
    "data-testid",
    "data-cy",
    "data-test",
    "data-qa"
  ];
  var ATTR_WEIGHT = {
    "data-testid": 50,
    "data-test-id": 50,
    "data-testId": 50,
    "data-test": 50,
    "data-qa": 50,
    "data-cy": 50,
    alt: 20,
    title: 18,
    name: 15
  };
  var DEFAULT_TESTID_WEIGHT = 50;
  function makeAttrSelector(attr, value, cssEscape2) {
    return `[${attr}="${cssEscape2(value)}"]`;
  }
  function shouldTryTagPrefix(attr, tag, element) {
    if (!tag) return false;
    if (attr.startsWith("data-")) {
      return FORM_ELEMENT_TAGS.has(tag);
    }
    const preferredTags = ATTR_TAG_PREFERENCES[attr];
    if (preferredTags) {
      if (preferredTags.has(tag)) return true;
      if (attr === "alt" && tag === "input") {
        const type = element.getAttribute("type");
        return type === "image";
      }
      return false;
    }
    return true;
  }
  function weightFor(attr) {
    return ATTR_WEIGHT[attr] ?? DEFAULT_TESTID_WEIGHT;
  }
  function cssEscapeBasic(v) {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(v);
    return v.replace(/(["\\])/g, "\\$1");
  }
  function resolveByTestId(value, scope, attrs = DEFAULT_TESTID_ATTRIBUTES) {
    const target = String(value || "").trim();
    if (!target) return [];
    const escaped = cssEscapeBasic(target);
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    for (const attr of attrs) {
      const a = String(attr).trim();
      if (!a) continue;
      let matches;
      try {
        matches = scope.querySelectorAll(`[${a}="${escaped}"]`);
      } catch {
        continue;
      }
      if (!matches) continue;
      for (const el of Array.from(matches)) {
        if (seen.has(el)) continue;
        seen.add(el);
        out.push(el);
      }
    }
    return out;
  }
  var testIdStrategy = {
    id: "testid",
    generate(ctx) {
      const { element, options, helpers } = ctx;
      const out = [];
      const tag = element.tagName?.toLowerCase?.() ?? "";
      for (const attr of options.testIdAttributes) {
        const raw = element.getAttribute(attr);
        const value = raw?.trim();
        if (!value) continue;
        const attrOnly = makeAttrSelector(attr, value, helpers.cssEscape);
        const weight = weightFor(attr);
        if (helpers.isUnique(attrOnly)) {
          out.push({
            type: "attr",
            value: attrOnly,
            weight,
            source: "generated",
            strategy: "testid"
          });
          continue;
        }
        if (shouldTryTagPrefix(attr, tag, element)) {
          const withTag = `${tag}${attrOnly}`;
          if (helpers.isUnique(withTag)) {
            out.push({
              type: "attr",
              value: withTag,
              weight,
              source: "generated",
              strategy: "testid"
            });
          }
        }
      }
      return out;
    },
    resolve(value, scope, extras) {
      const attr = extras?.attribute?.trim();
      if (attr) return resolveByTestId(value, scope, [attr]);
      return resolveByTestId(value, scope, DEFAULT_TESTID_ATTRIBUTES);
    }
  };

  // app/chrome-extension/shared/selector/strategies/text.ts
  var TEXT_STRATEGY_WEIGHT = 10;
  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }
  var textStrategy = {
    id: "text",
    generate(ctx) {
      if (!ctx.options.includeText) return [];
      const { element, options } = ctx;
      const tag = element.tagName?.toLowerCase?.() ?? "";
      if (!tag || !options.textTags.includes(tag)) return [];
      const raw = element.textContent || "";
      const text = normalizeText(raw).slice(0, options.textMaxLength);
      if (!text) return [];
      return [
        {
          type: "text",
          value: text,
          match: "contains",
          tagNameHint: tag,
          weight: TEXT_STRATEGY_WEIGHT,
          source: "generated",
          strategy: "text"
        }
      ];
    }
  };

  // app/chrome-extension/shared/selector/strategies/title.ts
  function resolveByTitle(scope, text, exact) {
    const target = String(text || "").trim();
    if (!target) return [];
    const mode = exact ? "exact" : "contains";
    const out = [];
    const candidates = scope.querySelectorAll("[title]");
    for (const el of Array.from(candidates)) {
      const title = el.getAttribute("title") ?? "";
      if (matchesAccessibleName(title, target, mode)) out.push(el);
    }
    return out;
  }
  var titleStrategy = {
    id: "title",
    generate(ctx) {
      const { element } = ctx;
      const title = element.getAttribute("title");
      if (!title || !title.trim()) return [];
      const out = [
        {
          type: "title",
          text: title.trim(),
          value: title.trim(),
          source: "generated",
          strategy: "title"
        }
      ];
      return out;
    },
    resolve(value, scope, extras) {
      return resolveByTitle(scope, value, extras?.exact);
    }
  };

  // app/chrome-extension/shared/selector/strategies/index.ts
  var DEFAULT_SELECTOR_STRATEGIES = [
    testIdStrategy,
    roleStrategy,
    labelStrategy,
    placeholderStrategy,
    altTextStrategy,
    titleStrategy,
    ariaStrategy,
    cssUniqueStrategy,
    cssPathStrategy,
    anchorRelpathStrategy,
    textStrategy
  ];

  // app/chrome-extension/shared/selector/dom-path.ts
  function computeDomPath(element) {
    const path = [];
    let current = element;
    while (current) {
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children);
        const index = siblings.indexOf(current);
        if (index >= 0) {
          path.unshift(index);
        }
        current = parent;
        continue;
      }
      const parentNode = current.parentNode;
      if (parentNode instanceof ShadowRoot || parentNode instanceof Document) {
        const children = Array.from(parentNode.children);
        const index = children.indexOf(current);
        if (index >= 0) {
          path.unshift(index);
        }
      }
      break;
    }
    return path;
  }

  // app/chrome-extension/shared/selector/fingerprint.ts
  var FINGERPRINT_TEXT_MAX_LENGTH = 32;
  var FINGERPRINT_MAX_CLASSES = 8;
  var FINGERPRINT_SEPARATOR = "|";
  function normalizeText2(text, maxLength) {
    return text.replace(/\s+/g, " ").trim().slice(0, maxLength);
  }
  function computeFingerprint(element, options) {
    const textMaxLength = options?.textMaxLength ?? FINGERPRINT_TEXT_MAX_LENGTH;
    const maxClasses = options?.maxClasses ?? FINGERPRINT_MAX_CLASSES;
    const parts = [];
    const tag = element.tagName?.toLowerCase() ?? "unknown";
    parts.push(tag);
    const id = element.id?.trim();
    if (id) {
      parts.push(`id=${id}`);
    }
    const classes = Array.from(element.classList).slice(0, maxClasses);
    if (classes.length > 0) {
      parts.push(`class=${classes.join(".")}`);
    }
    const text = normalizeText2(element.textContent ?? "", textMaxLength);
    if (text) {
      parts.push(`text=${text}`);
    }
    return parts.join(FINGERPRINT_SEPARATOR);
  }

  // app/chrome-extension/shared/selector/generator.ts
  var DEFAULT_MAX_CANDIDATES = 8;
  var DEFAULT_TEXT_MAX_LENGTH = 64;
  var DEFAULT_TEXT_TAGS = ["button", "a", "summary"];
  var DEFAULT_TESTID_ATTRS = [
    "data-testid",
    "data-test-id",
    "data-testId",
    "data-test",
    "data-qa",
    "data-cy",
    "name",
    "title",
    "alt"
  ];
  function clampInt(value, min, max) {
    if (!Number.isFinite(value)) return min;
    return Math.min(max, Math.max(min, Math.floor(value)));
  }
  function normalizeSelectorGenerationOptions(options) {
    return {
      maxCandidates: clampInt(options?.maxCandidates ?? DEFAULT_MAX_CANDIDATES, 1, 50),
      includeText: options?.includeText ?? true,
      includeAria: options?.includeAria ?? true,
      includeCssUnique: options?.includeCssUnique ?? true,
      includeCssPath: options?.includeCssPath ?? true,
      testIdAttributes: options?.testIdAttributes ?? DEFAULT_TESTID_ATTRS,
      textMaxLength: clampInt(options?.textMaxLength ?? DEFAULT_TEXT_MAX_LENGTH, 1, 256),
      textTags: options?.textTags ?? DEFAULT_TEXT_TAGS
    };
  }
  function cssEscape(value) {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
    const str = String(value);
    const len = str.length;
    if (len === 0) return "";
    let result = "";
    const firstCodeUnit = str.charCodeAt(0);
    for (let i = 0; i < len; i++) {
      const codeUnit = str.charCodeAt(i);
      if (codeUnit === 0) {
        result += "\uFFFD";
        continue;
      }
      if (codeUnit >= 1 && codeUnit <= 31 || codeUnit === 127 || i === 0 && codeUnit >= 48 && codeUnit <= 57 || i === 1 && codeUnit >= 48 && codeUnit <= 57 && firstCodeUnit === 45) {
        result += `\\${codeUnit.toString(16)} `;
        continue;
      }
      if (i === 0 && len === 1 && codeUnit === 45) {
        result += `\\${str.charAt(i)}`;
        continue;
      }
      const isAsciiAlnum = codeUnit >= 48 && codeUnit <= 57 || codeUnit >= 65 && codeUnit <= 90 || codeUnit >= 97 && codeUnit <= 122;
      const isSafe = isAsciiAlnum || codeUnit === 45 || codeUnit === 95;
      if (isSafe) result += str.charAt(i);
      else result += `\\${str.charAt(i)}`;
    }
    return result;
  }
  function getQueryRoot(element) {
    const root = element.getRootNode?.();
    if (root instanceof ShadowRoot) return root;
    if (typeof document !== "undefined") return document;
    throw new Error("Selector generator requires a DOM-like environment");
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
  function candidateKey(c) {
    switch (c.type) {
      case "text":
        return `text:${c.value}:${c.tagNameHint ?? ""}:${c.match ?? ""}`;
      case "aria":
        return `aria:${c.role ?? ""}:${c.name ?? ""}:${c.value}`;
      default:
        return `${c.type}:${c.value}`;
    }
  }
  function generateSelectorTarget(element, options = {}) {
    const normalized = normalizeSelectorGenerationOptions(options);
    const root = options.root ?? getQueryRoot(element);
    const helpers = {
      cssEscape,
      isUnique: (selector) => isUnique(root, selector),
      safeQueryAll: (selector) => safeQueryAll(root, selector)
    };
    const ctx = {
      element,
      root,
      options: normalized,
      helpers
    };
    const strategies = options.strategies ?? DEFAULT_SELECTOR_STRATEGIES;
    const raw = [];
    for (const strategy of strategies) {
      const produced = strategy.generate(ctx);
      for (const c0 of produced) {
        raw.push({
          ...c0,
          source: c0.source ?? "generated",
          strategy: c0.strategy ?? strategy.id
        });
      }
    }
    const seen = /* @__PURE__ */ new Set();
    const deduped = [];
    for (const c of raw) {
      const key = candidateKey(c);
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(withStability(c));
    }
    if (deduped.length === 0) {
      const fallback = withStability({
        type: "css",
        value: "body",
        source: "generated",
        strategy: "fallback"
      });
      const candidates = [fallback];
      return {
        selector: fallback.value,
        candidates,
        tagName: element.tagName?.toLowerCase?.() ?? void 0
      };
    }
    const sorted = [...deduped].sort(compareSelectorCandidates).slice(0, normalized.maxCandidates);
    const cssOrAttrPrimary = sorted.find((c) => c.type === "css" || c.type === "attr");
    const selectorValue = (cssOrAttrPrimary ?? sorted[0]).value;
    const tagName = element.tagName?.toLowerCase?.() ?? void 0;
    return {
      selector: selectorValue,
      candidates: sorted,
      tagName
    };
  }
  function safeMatches(element, selector) {
    try {
      return element.matches(selector);
    } catch {
      return false;
    }
  }
  function pickShadowHostSelector(host, hostRoot, options) {
    const hostTarget = generateSelectorTarget(host, { ...options, root: hostRoot });
    let fallback = null;
    for (const candidate of hostTarget.candidates) {
      if (candidate.type !== "css" && candidate.type !== "attr") continue;
      const selector = String(candidate.value || "").trim();
      if (!selector) continue;
      if (!safeMatches(host, selector)) continue;
      if (isUnique(hostRoot, selector)) {
        return selector;
      }
      if (!fallback) {
        fallback = selector;
      }
    }
    const primary = typeof hostTarget.selector === "string" ? hostTarget.selector.trim() : "";
    if (primary && safeMatches(host, primary)) {
      return primary;
    }
    return fallback;
  }
  function computeShadowHostChain(element, options) {
    const chain = [];
    let current = element;
    while (true) {
      const rootNode = current.getRootNode?.();
      if (!(rootNode instanceof ShadowRoot)) {
        break;
      }
      const host = rootNode.host;
      if (!(host instanceof Element)) {
        break;
      }
      const hostRoot = getQueryRoot(host);
      const hostSelector = pickShadowHostSelector(host, hostRoot, options);
      if (!hostSelector) {
        return [];
      }
      chain.unshift(hostSelector);
      current = host;
    }
    return chain;
  }
  function generateExtendedSelectorTarget(element, options = {}) {
    const base = generateSelectorTarget(element, options);
    return {
      ...base,
      fingerprint: computeFingerprint(element),
      domPath: computeDomPath(element),
      shadowHostChain: computeShadowHostChain(element, options)
    };
  }

  // app/chrome-extension/inject-scripts/selector-engine-entry.ts
  var RECORDER_STRATEGIES = [
    testIdStrategy,
    ariaStrategy,
    recorderLabelStrategy,
    recorderPlaceholderStrategy,
    cssUniqueStrategy,
    cssPathStrategy,
    anchorRelpathStrategy,
    textStrategy
  ];
  function generateSelectorTarget2(element, options) {
    return generateSelectorTarget(element, {
      ...options,
      strategies: options?.strategies ?? RECORDER_STRATEGIES
    });
  }
  function generateExtendedSelectorTarget2(element, options) {
    return generateExtendedSelectorTarget(element, {
      ...options,
      strategies: options?.strategies ?? RECORDER_STRATEGIES
    });
  }
  var realm = window;
  realm.__rrSelectorEngine ?? (realm.__rrSelectorEngine = {
    generateSelectorTarget: generateSelectorTarget2,
    generateExtendedSelectorTarget: generateExtendedSelectorTarget2,
    compareSelectorCandidates,
    withStability,
    computeFingerprint,
    computeDomPath,
    cssEscape
  });
})();
