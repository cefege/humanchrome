// locator-handler.js (IMP-0101)
// Auto-dismiss sticky overlays — cookie banners, GDPR consent modals, newsletter
// pop-ups, "we use cookies" interstitials — that intercept clicks and break LLM
// flows. Inspired by Playwright's `addLocatorHandler`.
//
// Architecture:
//   - One MutationObserver pinned to `document.documentElement` watches for any
//     DOM mutation in the page (childList + subtree). On every mutation tick we
//     re-evaluate every registered handler — the work per handler is cheap
//     (one querySelector + visibility check).
//   - Per registered handler we also probe on a 1s safety interval so handlers
//     fire even when the page swaps overlays without DOM mutations (e.g. a
//     pre-existing hidden modal flipped to `display:block` via CSS class
//     change that doesn't trigger MutationObserver child events).
//   - "Visible" = bbox has non-zero width & height AND CSS does not hide the
//     element via display:none / visibility:hidden / opacity:0. The
//     IntersectionObserver-style intersection check matches the spec.
//   - When a registered selector becomes visible, the handler runs its
//     dismissAction (click or keypress) on the dismissSelector and bumps the
//     handler's `dismissedCount`. If `times` is set and reached, the handler
//     is auto-removed.

(function () {
  if (window.__LOCATOR_HANDLER_INITIALIZED__) return;
  window.__LOCATOR_HANDLER_INITIALIZED__ = true;

  /**
   * @typedef {Object} Handler
   * @property {string} handlerId
   * @property {string} selector
   * @property {string} dismissSelector
   * @property {'click'|'press'} dismissAction
   * @property {string|undefined} key
   * @property {number|undefined} times  - max dismissals (undefined = unlimited)
   * @property {number} dismissedCount
   * @property {number|null} lastDismissedAt
   * @property {boolean} persistent
   * @property {number} createdAt
   */

  /** @type {Map<string, Handler>} */
  const handlers = new Map();

  let observer = null;
  let intervalTimer = null;
  let evalScheduled = false;
  let cleanupRegistered = false;

  function isVisible(el) {
    try {
      if (!(el instanceof Element) || !el.isConnected) return false;
      const style = getComputedStyle(el);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse'
      ) {
        return false;
      }
      const opacity = parseFloat(style.opacity || '1');
      if (Number.isFinite(opacity) && opacity <= 0) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      return true;
    } catch {
      return false;
    }
  }

  function findVisible(selector) {
    try {
      const els = document.querySelectorAll(selector);
      for (const el of els) {
        if (isVisible(el)) return el;
      }
    } catch {}
    return null;
  }

  function dispatchClick(el) {
    try {
      el.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
    } catch {}
    const rect = (function () {
      try {
        return el.getBoundingClientRect();
      } catch {
        return { left: 0, top: 0, width: 0, height: 0 };
      }
    })();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: cx,
      clientY: cy,
      button: 0,
      view: window,
    };
    try {
      // TODO(IMP-0097): swap to awaitActionable() before dispatch once the
      // shared actionability primitive lands. Right now we click as soon as
      // the element is "visible" (bbox + computed-style) without the stable /
      // enabled / hit-test gates.
      el.dispatchEvent(new PointerEvent('pointerdown', init));
      el.dispatchEvent(new MouseEvent('mousedown', init));
      el.dispatchEvent(new PointerEvent('pointerup', init));
      el.dispatchEvent(new MouseEvent('mouseup', init));
      el.dispatchEvent(new MouseEvent('click', init));
      // Some libraries listen on the native `click()` only; calling it covers
      // anchor activation, form submission delegation, etc.
      if (typeof el.click === 'function') {
        try {
          el.click();
        } catch {}
      }
      return { ok: true, x: Math.round(cx), y: Math.round(cy) };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  function dispatchKey(el, key) {
    try {
      el.focus();
    } catch {}
    const target = el || document.activeElement || document.body;
    const init = { bubbles: true, cancelable: true, composed: true, key, view: window };
    try {
      target.dispatchEvent(new KeyboardEvent('keydown', init));
      target.dispatchEvent(new KeyboardEvent('keypress', init));
      target.dispatchEvent(new KeyboardEvent('keyup', init));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  function applyHandler(handler) {
    // Guard against the trigger selector having been removed between mutation
    // and our re-check.
    const trigger = findVisible(handler.selector);
    if (!trigger) return false;

    // The dismiss target is queried fresh on every fire — many overlays
    // re-render after dismissal so caching the element would race.
    const dismissEl = findVisible(handler.dismissSelector);
    if (!dismissEl) return false;

    const action = handler.dismissAction === 'press' ? 'press' : 'click';
    const result =
      action === 'press'
        ? dispatchKey(dismissEl, handler.key || 'Escape')
        : dispatchClick(dismissEl);

    if (!result.ok) return false;

    handler.dismissedCount += 1;
    handler.lastDismissedAt = Date.now();

    if (typeof handler.times === 'number' && handler.dismissedCount >= handler.times) {
      handlers.delete(handler.handlerId);
    }
    return true;
  }

  function evaluateAll() {
    evalScheduled = false;
    if (handlers.size === 0) return;
    // Snapshot to a list because `applyHandler` may delete entries when their
    // `times` limit is reached.
    for (const handler of Array.from(handlers.values())) {
      try {
        applyHandler(handler);
      } catch {
        // a single broken handler should never poison the rest
      }
    }
  }

  function scheduleEval() {
    if (evalScheduled) return;
    evalScheduled = true;
    // Coalesce bursty mutations into one tick.
    Promise.resolve().then(evaluateAll);
  }

  function ensureObserver() {
    if (observer) return;
    try {
      observer = new MutationObserver(() => scheduleEval());
      observer.observe(document.documentElement || document.body || document, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['style', 'class', 'hidden', 'aria-hidden', 'open'],
      });
    } catch {}
    // Safety poll for CSS-only show/hide transitions that don't move nodes.
    if (!intervalTimer) {
      intervalTimer = setInterval(() => {
        if (handlers.size > 0) scheduleEval();
      }, 1000);
    }
  }

  function teardownObserver() {
    if (observer) {
      try {
        observer.disconnect();
      } catch {}
      observer = null;
    }
    if (intervalTimer) {
      clearInterval(intervalTimer);
      intervalTimer = null;
    }
  }

  function registerCleanupOnce() {
    if (cleanupRegistered) return;
    cleanupRegistered = true;
    // Cooperate with the inject-bridge cleanup signal so callers can fully
    // remove the helper via chrome_remove_injected_script if they ever opt
    // into that path. We're injected directly (not via the bridge) but the
    // event is broadcast on `window` so it costs nothing to listen.
    window.addEventListener('humanchrome:cleanup', () => {
      handlers.clear();
      teardownObserver();
      try {
        delete window.__LOCATOR_HANDLER_INITIALIZED__;
      } catch {}
    });
  }

  registerCleanupOnce();

  function serializeHandler(h) {
    const timesRemaining =
      typeof h.times === 'number' ? Math.max(0, h.times - h.dismissedCount) : null;
    return {
      handlerId: h.handlerId,
      selector: h.selector,
      dismissSelector: h.dismissSelector,
      dismissAction: h.dismissAction,
      key: h.key || null,
      times: typeof h.times === 'number' ? h.times : null,
      timesRemaining,
      persistent: !!h.persistent,
      dismissedCount: h.dismissedCount,
      lastDismissedAt: h.lastDismissedAt,
      createdAt: h.createdAt,
    };
  }

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    try {
      if (!request || typeof request !== 'object') return false;

      // Base browser-tool helpers ping with `${tool.name}_ping`. Accept both
      // the tool-name variant and the short helper variant so the script
      // works regardless of which pattern the caller follows.
      if (
        request.action === 'chrome_locator_handler_ping' ||
        request.action === 'locator_handler_ping'
      ) {
        sendResponse({ status: 'pong' });
        return false;
      }

      if (request.action === 'locator_handler_register') {
        const handlerId = String(request.handlerId || '').trim();
        const selector = String(request.selector || '').trim();
        const dismissSelector = String(request.dismissSelector || '').trim();
        const dismissAction = request.dismissAction === 'press' ? 'press' : 'click';
        const key = typeof request.key === 'string' ? request.key : undefined;
        const times =
          typeof request.times === 'number' && request.times > 0 ? request.times : undefined;
        const persistent = request.persistent === true;
        if (!handlerId || !selector || !dismissSelector) {
          sendResponse({
            success: false,
            error: 'handlerId, selector, and dismissSelector are required',
          });
          return false;
        }
        const handler = {
          handlerId,
          selector,
          dismissSelector,
          dismissAction,
          key,
          times,
          persistent,
          dismissedCount: 0,
          lastDismissedAt: null,
          createdAt: Date.now(),
        };
        handlers.set(handlerId, handler);
        ensureObserver();
        // Fire once immediately so already-visible overlays are dismissed
        // without waiting for the next mutation.
        scheduleEval();
        sendResponse({ success: true, handler: serializeHandler(handler) });
        return false;
      }

      if (request.action === 'locator_handler_list') {
        const items = [];
        for (const h of handlers.values()) items.push(serializeHandler(h));
        items.sort((a, b) => a.createdAt - b.createdAt);
        sendResponse({ success: true, handlers: items, count: items.length });
        return false;
      }

      if (request.action === 'locator_handler_remove') {
        const handlerId = String(request.handlerId || '').trim();
        if (!handlerId) {
          sendResponse({ success: false, error: 'handlerId is required' });
          return false;
        }
        const removed = handlers.delete(handlerId);
        if (handlers.size === 0) teardownObserver();
        sendResponse({ success: true, removed });
        return false;
      }

      if (request.action === 'locator_handler_clear') {
        const cleared = handlers.size;
        handlers.clear();
        teardownObserver();
        sendResponse({ success: true, cleared });
        return false;
      }
    } catch (err) {
      sendResponse({ success: false, error: String((err && err.message) || err) });
      return false;
    }
    return false;
  });
})();
