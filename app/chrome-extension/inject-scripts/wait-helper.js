/* eslint-disable */
// wait-helper.js
// Listen for text appearance/disappearance in the current document using MutationObserver.
// Returns a stable ref (compatible with accessibility-tree-helper) for the first matching element.

(function () {
  if (window.__WAIT_HELPER_INITIALIZED__) return;
  window.__WAIT_HELPER_INITIALIZED__ = true;

  // Ensure ref mapping infra exists (compatible with accessibility-tree-helper.js)
  if (!window.__claudeElementMap) window.__claudeElementMap = {};
  if (!window.__claudeRefCounter) window.__claudeRefCounter = 0;

  function isVisible(el) {
    try {
      if (!(el instanceof Element)) return false;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')
        return false;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      return true;
    } catch {
      return false;
    }
  }

  function normalize(str) {
    return String(str || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function matchesText(el, needle) {
    const t = normalize(needle);
    if (!t) return false;
    try {
      if (!isVisible(el)) return false;
      const aria = el.getAttribute('aria-label');
      if (aria && normalize(aria).includes(t)) return true;
      const title = el.getAttribute('title');
      if (title && normalize(title).includes(t)) return true;
      const alt = el.getAttribute('alt');
      if (alt && normalize(alt).includes(t)) return true;
      const placeholder = el.getAttribute('placeholder');
      if (placeholder && normalize(placeholder).includes(t)) return true;
      // input/textarea value
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        const value = el.value || el.getAttribute('value');
        if (value && normalize(value).includes(t)) return true;
      }
      const text = el.innerText || el.textContent || '';
      if (normalize(text).includes(t)) return true;
    } catch {}
    return false;
  }

  function findElementByText(text) {
    // Fast path: query common interactive elements first
    const prioritized = Array.from(
      document.querySelectorAll('a,button,input,textarea,select,label,summary,[role]'),
    );
    for (const el of prioritized) if (matchesText(el, text)) return el;

    // Fallback: broader scan with cap to avoid blocking on huge pages
    const walker = document.createTreeWalker(
      document.body || document.documentElement,
      NodeFilter.SHOW_ELEMENT,
    );
    let count = 0;
    while (walker.nextNode()) {
      const el = /** @type {Element} */ (walker.currentNode);
      if (matchesText(el, text)) return el;
      if (++count > 5000) break; // Hard cap to avoid long scans
    }
    return null;
  }

  function ensureRefForElement(el) {
    // Try to reuse an existing ref
    for (const k in window.__claudeElementMap) {
      const weak = window.__claudeElementMap[k];
      if (weak && typeof weak.deref === 'function' && weak.deref() === el) return k;
    }
    const refId = `ref_${++window.__claudeRefCounter}`;
    window.__claudeElementMap[refId] = new WeakRef(el);
    return refId;
  }

  function centerOf(el) {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }

  // IMP-0138: every executor below hoists its `setTimeout`/`setInterval`
  // handles (`timer`, `poller`, `idleTimer`, `deadline`) with `let` BEFORE
  // declaring `done()` and running the initial synchronous `check()`. If the
  // predicate is already satisfied on first poll, `check()` invokes `done()`,
  // which clears those handles — and a `const` declared further down would
  // still be in TDZ at that moment. The resulting ReferenceError escapes the
  // Promise executor, the Promise rejects with no payload, the SW message
  // router gets nothing back, and the caller hits the 120s MCP transport
  // timeout instead of the requested timeoutMs. `clearTimeout(undefined)` /
  // `clearInterval(undefined)` are no-ops, so the early-done() path is safe
  // before the handles are assigned.
  function waitFor({ text, appear = true, timeout = 5000 }) {
    return new Promise((resolve) => {
      const start = Date.now();
      let resolved = false;
      let timer;

      const check = () => {
        try {
          const match = findElementByText(text);
          if (appear) {
            if (match) {
              const ref = ensureRefForElement(match);
              const center = centerOf(match);
              done({ success: true, matched: { ref, center }, tookMs: Date.now() - start });
            }
          } else {
            // wait for disappearance
            if (!match) {
              done({ success: true, matched: null, tookMs: Date.now() - start });
            }
          }
        } catch {}
      };

      const done = (result) => {
        if (resolved) return;
        resolved = true;
        obs && obs.disconnect();
        clearTimeout(timer);
        resolve(result);
      };

      const obs = new MutationObserver(() => check());
      try {
        obs.observe(document.documentElement || document.body, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
        });
      } catch {}

      check();
      timer = setTimeout(
        () => {
          done({ success: false, reason: 'timeout', tookMs: Date.now() - start });
        },
        Math.max(0, timeout),
      );
    });
  }

  /**
   * Resolve a selector. Supports:
   *   - 'css' (default)
   *   - 'xpath'
   *   - 'role' / 'label' / 'placeholder' / 'alt' / 'title' / 'testid'
   *     when the accessibility-tree-helper has been injected first (exposes
   *     `window.__hcResolveByKind`). Without that helper, structured
   *     selectors degrade to CSS so existing flows don't break.
   *
   * IMP-0098: extended payload — `extras` carries role/name/text/exact/index
   * for structured selector kinds. The shape mirrors the message-helper
   * payload in accessibility-tree-helper.js for symmetry.
   */
  function resolveBySelector(selector, selectorType, extras) {
    extras = extras || {};
    try {
      if (selectorType === 'xpath') {
        const result = document.evaluate(
          selector,
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null,
        );
        const node = result && result.singleNodeValue;
        return node instanceof Element ? node : null;
      }
      const structured = ['role', 'label', 'placeholder', 'alt', 'title', 'testid'];
      if (selectorType && structured.indexOf(selectorType) !== -1) {
        if (typeof window.__hcResolveByKind === 'function') {
          const req = {
            role: extras.role,
            name: extras.name,
            text: extras.text || selector,
            exact: !!extras.exact,
            attribute: extras.attribute,
            selector,
            index: typeof extras.index === 'number' ? extras.index : undefined,
          };
          const result = window.__hcResolveByKind(selectorType, req);
          if (result && result.element instanceof Element) return result.element;
        }
        // Fallback — best-effort CSS only when the structured resolver
        // hasn't been injected. Surfaces missing-helper as "not found".
        return null;
      }
      return document.querySelector(selector);
    } catch {
      return null;
    }
  }

  function resolveByRef(ref) {
    try {
      const map = window.__claudeElementMap || {};
      const weak = map[ref];
      const el = weak && typeof weak.deref === 'function' ? weak.deref() : null;
      // Confirm the element is still attached to the DOM. WeakRef may
      // resolve to a detached node which counts as "absent" for our predicate.
      if (el && el.isConnected) return el;
      return null;
    } catch {
      return null;
    }
  }

  function waitForElement({
    selector,
    selectorType = 'css',
    ref,
    state = 'present',
    timeout = 15000,
    extras,
  }) {
    return new Promise((resolve) => {
      const start = Date.now();
      let resolved = false;
      let timer; // see IMP-0138 note above `waitFor`

      const wantPresent = state !== 'absent';

      const probe = () => {
        if (ref) {
          const el = resolveByRef(ref);
          return el ? el : null;
        }
        if (selector) {
          return resolveBySelector(selector, selectorType, extras);
        }
        // Structured selector kinds can match without a CSS-shaped `selector`
        // string when role/name was supplied directly in extras.
        if (extras && extras.role) return resolveBySelector('', 'role', extras);
        if (extras && extras.text && extras.kind) return resolveBySelector('', extras.kind, extras);
        return null;
      };

      const isGoalReached = () => {
        const found = probe();
        if (wantPresent) return found ? found : null;
        // For state==='absent' we want absence — treat null as goal-met,
        // but we still need a sentinel value, so return a synthetic marker.
        return found ? null : true;
      };

      const done = (result) => {
        if (resolved) return;
        resolved = true;
        try {
          obs && obs.disconnect();
        } catch {}
        clearTimeout(timer);
        resolve(result);
      };

      const check = () => {
        try {
          const goal = isGoalReached();
          if (goal !== null) {
            const matched =
              wantPresent && goal instanceof Element
                ? { ref: ensureRefForElement(goal), center: centerOf(goal) }
                : null;
            done({
              success: true,
              found: true,
              matched,
              tookMs: Date.now() - start,
            });
          }
        } catch {}
      };

      const obs = new MutationObserver(check);
      try {
        obs.observe(document.documentElement || document.body, {
          subtree: true,
          childList: true,
          characterData: false,
          attributes: true,
        });
      } catch {}

      check();
      timer = setTimeout(
        () =>
          done({
            success: false,
            reason: 'timeout',
            found: false,
            tookMs: Date.now() - start,
          }),
        Math.max(0, timeout),
      );
    });
  }

  function waitForSelector({ selector, visible = true, timeout = 5000 }) {
    return new Promise((resolve) => {
      const start = Date.now();
      let resolved = false;
      let timer; // see IMP-0138 note above `waitFor`

      const isMatch = () => {
        try {
          const el = document.querySelector(selector);
          if (!el) return null;
          if (!visible) return el;
          return isVisible(el) ? el : null;
        } catch {
          return null;
        }
      };

      const done = (result) => {
        if (resolved) return;
        resolved = true;
        obs && obs.disconnect();
        clearTimeout(timer);
        resolve(result);
      };

      const check = () => {
        const el = isMatch();
        if (el) {
          const ref = ensureRefForElement(el);
          const center = centerOf(el);
          done({ success: true, matched: { ref, center }, tookMs: Date.now() - start });
        }
      };

      const obs = new MutationObserver(check);
      try {
        obs.observe(document.documentElement || document.body, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
        });
      } catch {}

      check();
      timer = setTimeout(
        () => done({ success: false, reason: 'timeout', tookMs: Date.now() - start }),
        Math.max(0, timeout),
      );
    });
  }

  // Resolve when no fetch / XHR / resource-timing entry has fired for `quietMs`.
  // Uses PerformanceObserver to avoid hooking fetch/XHR explicitly. The first
  // resource entry resets the quiet window; if `quietMs` elapses without a
  // new entry, we resolve as idle. Edge case: a page that has been quiet
  // since load triggers an immediate-idle resolution after `quietMs` from start.
  function waitForNetworkIdle({ quietMs, timeout }) {
    return new Promise((resolve) => {
      const start = Date.now();
      let resolved = false;
      let lastActivity = Date.now();
      let observer = null;
      // see IMP-0138 note above `waitFor`. PerformanceObserver's buffered=true
      // flush is a microtask today (post-executor), so this is defensive only —
      // but the same shape killed `waitForJs` and a future refactor that routes
      // a synchronous resolution through `done()` would otherwise reintroduce
      // it.
      let idleTimer;
      let deadline;

      const done = (result) => {
        if (resolved) return;
        resolved = true;
        try {
          observer && observer.disconnect();
        } catch {}
        clearTimeout(idleTimer);
        clearTimeout(deadline);
        resolve(result);
      };

      const reschedule = () => {
        clearTimeout(idleTimer);
        const remaining = Math.max(0, lastActivity + quietMs - Date.now());
        idleTimer = setTimeout(
          () =>
            done({
              success: true,
              quietForMs: Date.now() - lastActivity,
              tookMs: Date.now() - start,
            }),
          remaining,
        );
      };

      try {
        observer = new PerformanceObserver(() => {
          lastActivity = Date.now();
          reschedule();
        });
        observer.observe({ type: 'resource', buffered: true });
      } catch {
        // PerformanceObserver unavailable — fall back to a single timer
      }

      reschedule();
      deadline = setTimeout(
        () =>
          done({
            success: false,
            reason: 'timeout',
            quietForMs: Date.now() - lastActivity,
            tookMs: Date.now() - start,
          }),
        Math.max(0, timeout),
      );
    });
  }

  // Repeatedly evaluate `expression` until it returns truthy or `timeout` ms
  // elapses. Re-eval triggers: (a) any DOM mutation via MutationObserver,
  // (b) a 250ms safety poll for non-DOM state changes (e.g. window globals
  // updated by setTimeout). Eval errors count as falsy and don't abort.
  function waitForJs({ expression, timeout }) {
    return new Promise((resolve) => {
      const start = Date.now();
      let resolved = false;
      // see IMP-0138 note above `waitFor` — this is the executor that was
      // observed hitting the TDZ in production (`document.readyState ===
      // 'complete'` on an already-loaded page).
      let poller;
      let timer;

      let evalFn;
      try {
        evalFn = new Function(`return (${expression});`);
      } catch (err) {
        resolve({
          success: false,
          reason: 'compile-error',
          error: String((err && err.message) || err),
          tookMs: Date.now() - start,
        });
        return;
      }

      const done = (result) => {
        if (resolved) return;
        resolved = true;
        try {
          obs && obs.disconnect();
        } catch {}
        clearInterval(poller);
        clearTimeout(timer);
        resolve(result);
      };

      const check = () => {
        try {
          if (evalFn()) done({ success: true, tookMs: Date.now() - start });
        } catch {
          // eval threw — treat as falsy and keep waiting
        }
      };

      const obs = new MutationObserver(check);
      try {
        obs.observe(document.documentElement || document.body, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
      } catch {}

      check();
      poller = setInterval(check, 250);
      timer = setTimeout(
        () => done({ success: false, reason: 'timeout', tookMs: Date.now() - start }),
        Math.max(0, timeout),
      );
    });
  }

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    try {
      if (request && request.action === 'wait_helper_ping') {
        sendResponse({ status: 'pong' });
        return false;
      }
      if (request && request.action === 'waitForText') {
        const text = String(request.text || '').trim();
        const appear = request.appear !== false; // default true
        const timeout = Number(request.timeout || 5000);
        if (!text) {
          sendResponse({ success: false, error: 'text is required' });
          return true;
        }
        waitFor({ text, appear, timeout }).then((res) => sendResponse(res));
        return true; // async
      }
      if (request && request.action === 'waitForElement') {
        const selector =
          typeof request.selector === 'string' ? String(request.selector).trim() : '';
        const rawType = String(request.selectorType || 'css');
        const structured = ['role', 'label', 'placeholder', 'alt', 'title', 'testid'];
        let selectorType;
        if (rawType === 'xpath') selectorType = 'xpath';
        else if (structured.indexOf(rawType) !== -1) selectorType = rawType;
        else selectorType = 'css';
        const ref = typeof request.ref === 'string' ? String(request.ref).trim() : '';
        const state = request.state === 'absent' ? 'absent' : 'present';
        const timeout = Number(request.timeout || 15000);
        // IMP-0098: structured kinds can supply payload via top-level fields
        // (role/name/text/exact/attribute/index) — forward via `extras`.
        const extras =
          selectorType !== 'css' && selectorType !== 'xpath'
            ? {
                kind: selectorType,
                role: request.role,
                name: request.name,
                text: request.text,
                exact: !!request.exact,
                attribute: request.attribute,
                index: typeof request.index === 'number' ? request.index : undefined,
              }
            : undefined;
        if (!selector && !ref && !(extras && (extras.role || extras.text))) {
          sendResponse({ success: false, error: 'selector or ref is required' });
          return true;
        }
        waitForElement({ selector, selectorType, ref, state, timeout, extras }).then((res) =>
          sendResponse(res),
        );
        return true; // async
      }
      if (request && request.action === 'waitForSelector') {
        const selector = String(request.selector || '').trim();
        const visible = request.visible !== false; // default true
        const timeout = Number(request.timeout || 5000);
        if (!selector) {
          sendResponse({ success: false, error: 'selector is required' });
          return true;
        }
        waitForSelector({ selector, visible, timeout }).then((res) => sendResponse(res));
        return true; // async
      }
      if (request && request.action === 'waitForNetworkIdle') {
        const quietMs = Math.max(0, Number(request.quietMs || 500));
        const timeout = Math.max(0, Number(request.timeout || 15000));
        waitForNetworkIdle({ quietMs, timeout }).then((res) => sendResponse(res));
        return true; // async
      }
      if (request && request.action === 'waitForJs') {
        const expression = typeof request.expression === 'string' ? request.expression.trim() : '';
        const timeout = Math.max(0, Number(request.timeout || 15000));
        if (!expression) {
          sendResponse({ success: false, error: 'expression is required' });
          return true;
        }
        waitForJs({ expression, timeout }).then((res) => sendResponse(res));
        return true; // async
      }
    } catch (e) {
      sendResponse({ success: false, error: String(e && e.message ? e.message : e) });
      return true;
    }
    return false;
  });
})();
