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

  function waitFor({ text, appear = true, timeout = 5000 }) {
    return new Promise((resolve) => {
      const start = Date.now();
      let resolved = false;

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

      // Initial check
      check();
      const timer = setTimeout(
        () => {
          done({ success: false, reason: 'timeout', tookMs: Date.now() - start });
        },
        Math.max(0, timeout),
      );
    });
  }

  function resolveBySelector(selector, selectorType) {
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
  }) {
    return new Promise((resolve) => {
      const start = Date.now();
      let resolved = false;

      const wantPresent = state !== 'absent';

      const probe = () => {
        if (ref) {
          const el = resolveByRef(ref);
          return el ? el : null;
        }
        if (selector) {
          return resolveBySelector(selector, selectorType);
        }
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

      // initial check
      check();
      const timer = setTimeout(
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

      // initial check
      check();
      const timer = setTimeout(
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

      let idleTimer = setTimeout(() => {}, 0);
      reschedule();
      const deadline = setTimeout(
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
      const poller = setInterval(check, 250);
      const timer = setTimeout(
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
        const selectorType = request.selectorType === 'xpath' ? 'xpath' : 'css';
        const ref = typeof request.ref === 'string' ? String(request.ref).trim() : '';
        const state = request.state === 'absent' ? 'absent' : 'present';
        const timeout = Number(request.timeout || 15000);
        if (!selector && !ref) {
          sendResponse({ success: false, error: 'selector or ref is required' });
          return true;
        }
        waitForElement({ selector, selectorType, ref, state, timeout }).then((res) =>
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
