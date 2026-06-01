// click-helper.js
// This script is injected into the page to handle click operations.
// All three resolution paths (ref / coordinates / selector) feed through the
// shared `awaitActionable` primitive (inject-scripts/actionability.js) so a
// click never lands on a hidden, disabled, unstable, or occluded target —
// failures surface as `NOT_ACTIONABLE` with `details.failures` describing
// what blocked.

if (window.__CLICK_HELPER_INITIALIZED__) {
  // Already initialized, skip
} else {
  window.__CLICK_HELPER_INITIALIZED__ = true;

  // Per-action check matrix. Mirrors Playwright: click/dblclick run
  // visible+stable+enabled+hit-test before dispatch.
  const CLICK_CHECKS = ['visible', 'stable', 'enabled', 'hit-test'];

  /**
   * Click on an element matching the selector or at specific coordinates.
   * @param {string} selector
   * @param {boolean} waitForNavigation
   * @param {number} timeout
   * @param {{x:number,y:number}|null} coordinates
   * @param {string|null} ref
   * @param {boolean} double
   * @param {{button?:string, bubbles?:boolean, cancelable?:boolean, modifiers?:object, force?:boolean, actionabilityTimeoutMs?:number}} options
   */
  /**
   * When `options.cdpDispatch` is set, this helper does resolution +
   * actionability + bbox math but does NOT dispatch the click — BG sends
   * a trusted CDP `Input.dispatchMouseEvent` instead. The legacy
   * `element.dispatchEvent(new MouseEvent(...))` path is `isTrusted:false`
   * and silently no-ops on pages that gate on event trust (Ember-routed
   * nav listitems, React combobox option commits).
   */
  async function clickElement(
    selector,
    waitForNavigation = false,
    timeout = 5000,
    coordinates = null,
    ref = null,
    double = false,
    options = {},
  ) {
    try {
      let element = null;
      let elementInfo = null;
      let clickX, clickY;
      let position; // optional per-call hit-test override (coords path)

      const force = options && options.force === true;
      const actionabilityTimeoutMs =
        options && typeof options.actionabilityTimeoutMs === 'number'
          ? options.actionabilityTimeoutMs
          : 5000;

      if (ref && typeof ref === 'string') {
        // Resolve element from weak map
        let target = null;
        try {
          const map = window.__claudeElementMap;
          const weak = map && map[ref];
          target = weak && typeof weak.deref === 'function' ? weak.deref() : null;
        } catch (e) {
          // ignore
        }

        if (!target || !(target instanceof Element)) {
          return {
            error: `Element ref "${ref}" not found. Please call chrome_read_page first and ensure the ref is still valid.`,
          };
        }

        element = target;

        // actionability suite handles scrollIntoView + visibility +
        // stability + enabled + hit-test in one shot.
        const actResult = await runActionability(element, {
          checks: CLICK_CHECKS,
          timeoutMs: actionabilityTimeoutMs,
          force,
        });
        if (!actResult.ok) {
          return notActionableError(actResult.failures, 'ref', { ref });
        }

        const rect = element.getBoundingClientRect();
        clickX = rect.left + rect.width / 2;
        clickY = rect.top + rect.height / 2;
        elementInfo = {
          tagName: element.tagName,
          id: element.id,
          className: element.className,
          text: element.textContent?.trim().substring(0, 100) || '',
          href: element.href || null,
          type: element.type || null,
          isVisible: true,
          rect: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            left: rect.left,
          },
          clickMethod: 'ref',
          ref,
        };
      } else if (
        coordinates &&
        typeof coordinates.x === 'number' &&
        typeof coordinates.y === 'number'
      ) {
        clickX = coordinates.x;
        clickY = coordinates.y;

        element = document.elementFromPoint(clickX, clickY);

        if (element) {
          // Element resolved at coords — run actionability against THIS
          // element. `position` pins the hit-test to the requested point so
          // we don't drift to center (which could land on a different
          // element). IMP-0092 made coords-over-nothing fail; this makes
          // coords-over-overlay fail with a structured reason.
          position = { x: clickX, y: clickY };
          const actResult = await runActionability(element, {
            checks: CLICK_CHECKS,
            timeoutMs: actionabilityTimeoutMs,
            force,
            position,
          });
          if (!actResult.ok) {
            return notActionableError(actResult.failures, 'coordinates', {
              clickPosition: { x: clickX, y: clickY },
            });
          }
          const rect = element.getBoundingClientRect();
          elementInfo = {
            tagName: element.tagName,
            id: element.id,
            className: element.className,
            text: element.textContent?.trim().substring(0, 100) || '',
            href: element.href || null,
            type: element.type || null,
            isVisible: true,
            rect: {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
              left: rect.left,
            },
            clickMethod: 'coordinates',
            clickPosition: { x: clickX, y: clickY },
          };
        } else {
          // IMP-0092: elementFromPoint(null) means no event will fire. Surface
          // as an error envelope (not success+warning) so callers can retry or
          // fall back instead of waiting on a click that never happened.
          return {
            error: `No element at coordinates (${clickX}, ${clickY})`,
            elementInfo: {
              clickMethod: 'coordinates',
              clickPosition: { x: clickX, y: clickY },
            },
          };
        }
      } else {
        // IMP-0098: route raw-CSS through the shared strict-mode uniqueness
        // check (exposed by accessibility-tree-helper.js as
        // `window.__hcQuerySelectorUnique`). When multi-match without an
        // explicit `index`/`multi`, surface samples so the caller can re-
        // target without re-reading the page. Falls back to plain
        // querySelector when the shared probe is unavailable (helper not
        // injected — caller error, but preserve old behavior).
        const uniqueProbe =
          typeof window.__hcQuerySelectorUnique === 'function'
            ? window.__hcQuerySelectorUnique
            : null;
        const allowMultipleStrict = !!(options && options.allowMultiple);
        const indexHint =
          options && typeof options.index === 'number' && options.index >= 0
            ? Math.floor(options.index)
            : -1;
        if (indexHint >= 0) {
          // IMP-0117: explicit `index` opts out of strict mode — caller knows
          // there are multiple matches and wants the Nth. Pick directly via
          // querySelectorAll; no strict-violation envelope, no falling back
          // to first-match.
          let all;
          try {
            all = document.querySelectorAll(selector);
          } catch (err) {
            return { error: err.message || String(err) };
          }
          if (indexHint >= all.length) {
            return {
              error: `Selector "${selector}" matched ${all.length} elements; index ${indexHint} is out of range.`,
            };
          }
          element = all[indexHint];
        } else if (uniqueProbe && !allowMultipleStrict) {
          const probe = uniqueProbe(selector, false);
          if (probe.error) {
            return { error: probe.error };
          }
          if (probe.matchCount === 0) {
            return { error: `Element with selector "${selector}" not found` };
          }
          if (probe.matchCount > 1) {
            // acc-tree-helper.js is always co-injected with click-helper.js
            // (see interaction.ts ClickTool injectContentScript list), so
            // __hcCollectMatchSamples is guaranteed present here — no
            // fallback (a fake fallback would re-introduce IMP-0116 by
            // returning the probe's 2-cap as the "true" count).
            const { trueCount, samples } = window.__hcCollectMatchSamples(selector, 5);
            return {
              error: `Selector "${selector}" matched ${trueCount} elements. Please refine the selector or pass {index} / {multi:true}.`,
              strict: { matchCount: trueCount, samples },
            };
          }
          element = probe.element;
        } else {
          element = document.querySelector(selector);
        }
        if (!element) {
          return {
            error: `Element with selector "${selector}" not found`,
          };
        }

        const rect = element.getBoundingClientRect();
        elementInfo = {
          tagName: element.tagName,
          id: element.id,
          className: element.className,
          text: element.textContent?.trim().substring(0, 100) || '',
          href: element.href || null,
          type: element.type || null,
          isVisible: true,
          rect: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            left: rect.left,
          },
          clickMethod: 'selector',
        };

        // Single actionability call covers what the old code did in two
        // sequential steps (scrollIntoView + isElementVisible).
        const actResult = await runActionability(element, {
          checks: CLICK_CHECKS,
          timeoutMs: actionabilityTimeoutMs,
          force,
        });
        if (!actResult.ok) {
          elementInfo.isVisible = actResult.failures.includes('not_visible') ? false : true;
          return notActionableError(actResult.failures, 'selector', { selector, elementInfo });
        }

        const updatedRect = element.getBoundingClientRect();
        clickX = updatedRect.left + updatedRect.width / 2;
        clickY = updatedRect.top + updatedRect.height / 2;
      }

      // cdpDispatch path: hand the resolved coords back to BG, which fires
      // a trusted CDP click + handles waitForNavigation via chrome.tabs.onUpdated.
      if (options && options.cdpDispatch === true) {
        return {
          success: true,
          message: 'Click coords resolved for CDP dispatch',
          elementInfo,
          clickX,
          clickY,
          isDouble: double === true,
          cdpReady: true,
        };
      }

      // Legacy synthetic-dispatch path — no in-tree caller, kept for
      // downstream forks. Silent no-op on trust-gated handlers.
      let navigationPromise;
      if (waitForNavigation) {
        navigationPromise = new Promise((resolve) => {
          const beforeUnloadListener = () => {
            window.removeEventListener('beforeunload', beforeUnloadListener);
            resolve(true);
          };
          window.addEventListener('beforeunload', beforeUnloadListener);

          setTimeout(() => {
            window.removeEventListener('beforeunload', beforeUnloadListener);
            resolve(false);
          }, timeout);
        });
      }

      if (
        element &&
        (elementInfo.clickMethod === 'selector' || elementInfo.clickMethod === 'ref')
      ) {
        if (double) {
          dispatchClickSequence(element, clickX, clickY, options, true);
        } else {
          dispatchClickSequence(element, clickX, clickY, options, false);
        }
      } else {
        const dispatched = double
          ? simulateDoubleClick(clickX, clickY, options)
          : simulateClick(clickX, clickY, options);
        if (!dispatched) {
          return {
            error: `No element at coordinates (${clickX}, ${clickY})`,
            elementInfo: {
              clickMethod: 'coordinates',
              clickPosition: { x: clickX, y: clickY },
            },
          };
        }
      }

      let navigationOccurred = false;
      if (waitForNavigation) {
        navigationOccurred = await navigationPromise;
      }

      return {
        success: true,
        message: 'Element clicked successfully',
        elementInfo,
        navigationOccurred,
      };
    } catch (error) {
      return {
        error: `Error clicking element: ${error.message}`,
      };
    }
  }

  /**
   * Invoke the shared actionability primitive. IMP-0137: when the primitive
   * is missing (build dropped the file, CSP blocked the inject, race with
   * cleanup), hard-fail with `actionability_unavailable` rather than
   * silently degrading to a permissive force-style click. The previous
   * permissive fallback regressed every page to pre-IMP-0097 silent-click-
   * on-overlay behaviour the moment `actionability.js` failed to land —
   * caller had no signal, only a `console.warn` they'd never see.
   *
   * Explicit `force: true` short-circuits the wrapper too: the caller
   * has already opted out of the suite, so the primitive being missing
   * doesn't change anything actionable. (Without the primitive there's
   * no scrollIntoView either, but force has always been a "best effort
   * regardless" signal, so we honour it.)
   */
  function runActionability(el, opts) {
    if (opts && opts.force === true) return Promise.resolve({ ok: true });
    const api = window.__actionability;
    if (!api || typeof api.awaitActionable !== 'function') {
      return Promise.resolve({ ok: false, failures: ['actionability_unavailable'] });
    }
    return api.awaitActionable(el, opts);
  }

  /**
   * Build the NOT_ACTIONABLE response envelope. The background-side tool
   * is responsible for classifying this into `ToolErrorCode.NOT_ACTIONABLE`;
   * the inject-script just surfaces the failure list and a structured
   * field so the tool can pick it up without parsing the message.
   */
  function notActionableError(failures, method, extra) {
    const failureList = Array.isArray(failures) ? failures : [];
    const msg =
      failureList.length === 0
        ? 'Element is not actionable'
        : `Element is not actionable: ${failureList.join(', ')}`;
    return {
      error: msg,
      notActionable: true,
      failures: failureList,
      method,
      ...(extra || {}),
    };
  }

  /**
   * Simulate a mouse click at specific coordinates.
   * Returns true when events were dispatched, false when there was no element
   * at the point (IMP-0092: callers must surface the no-dispatch path as an
   * error instead of returning success).
   * @param {number} x - X coordinate relative to the viewport
   * @param {number} y - Y coordinate relative to the viewport
   * @returns {boolean}
   */
  function simulateClick(x, y, options = {}) {
    const element = document.elementFromPoint(x, y);
    if (!element) return false;
    dispatchClickSequence(element, x, y, options, false);
    return true;
  }

  /**
   * Simulate a double click sequence at specific coordinates.
   * Returns true when events were dispatched, false when there was no element
   * at the point.
   * @returns {boolean}
   */
  function simulateDoubleClick(x, y, options = {}) {
    const element = document.elementFromPoint(x, y);
    if (!element) return false;
    dispatchClickSequence(element, x, y, options, true);
    return true;
  }

  /**
   * Simulate double click using element when available
   */
  function simulateDomDoubleClick(element, x, y, options) {
    dispatchClickSequence(element, x, y, options, true);
  }

  function normalizeMouseOpts(x, y, options = {}) {
    const bubbles = options.bubbles !== false; // default true
    const cancelable = options.cancelable !== false; // default true
    const altKey = !!(options.modifiers && options.modifiers.altKey);
    const ctrlKey = !!(options.modifiers && options.modifiers.ctrlKey);
    const metaKey = !!(options.modifiers && options.modifiers.metaKey);
    const shiftKey = !!(options.modifiers && options.modifiers.shiftKey);
    const btn = String(options.button || 'left');
    const button = btn === 'right' ? 2 : btn === 'middle' ? 1 : 0;
    const buttons = btn === 'right' ? 2 : btn === 'middle' ? 4 : 1;
    return {
      bubbles,
      cancelable,
      altKey,
      ctrlKey,
      metaKey,
      shiftKey,
      button,
      buttons,
      clientX: x,
      clientY: y,
      view: window,
    };
  }

  function dispatchClickSequence(element, x, y, options = {}, isDouble = false) {
    const base = normalizeMouseOpts(x, y, options);
    const down = new MouseEvent('mousedown', base);
    const up = new MouseEvent('mouseup', base);
    const click = new MouseEvent('click', base);
    try {
      element.dispatchEvent(down);
    } catch {}
    try {
      element.dispatchEvent(up);
    } catch {}
    try {
      element.dispatchEvent(click);
    } catch {}
    if (base.button === 2) {
      // right button contextmenu
      const ctx = new MouseEvent('contextmenu', base);
      try {
        element.dispatchEvent(ctx);
      } catch {}
    }
    if (isDouble) {
      // second sequence + dblclick
      setTimeout(() => {
        try {
          element.dispatchEvent(new MouseEvent('mousedown', base));
        } catch {}
        try {
          element.dispatchEvent(new MouseEvent('mouseup', base));
        } catch {}
        try {
          element.dispatchEvent(new MouseEvent('click', base));
        } catch {}
        try {
          element.dispatchEvent(new MouseEvent('dblclick', base));
        } catch {}
      }, 30);
    }
  }

  // Listen for messages from the extension
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.action === 'clickElement') {
      clickElement(
        request.selector,
        request.waitForNavigation,
        request.timeout,
        request.coordinates,
        request.ref,
        !!request.double,
        {
          button: request.button,
          bubbles: request.bubbles,
          cancelable: request.cancelable,
          modifiers: request.modifiers,
          force: request.force === true,
          allowMultiple: request.allowMultiple === true,
          index: typeof request.index === 'number' ? request.index : undefined,
          actionabilityTimeoutMs: request.actionabilityTimeoutMs,
          cdpDispatch: request.cdpDispatch === true,
        },
      )
        .then(sendResponse)
        .catch((error) => {
          sendResponse({
            error: `Unexpected error: ${error.message}`,
          });
        });
      return true; // Indicates async response
    } else if (request.action === 'chrome_click_element_ping') {
      sendResponse({ status: 'pong' });
      return false;
    }
  });
}
