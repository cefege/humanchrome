// fill-helper.js
// This script is injected into the page to handle form filling operations.
// Pre-action checks (visible + enabled + editable) flow through the shared
// `awaitActionable` primitive in inject-scripts/actionability.js — same
// matrix Playwright applies before fill/clear/selectOption. Failures
// surface as `notActionable: true` so the background tool can classify
// them into `ToolErrorCode.NOT_ACTIONABLE`.

if (window.__FILL_HELPER_INITIALIZED__) {
  // Already initialized, skip
} else {
  window.__FILL_HELPER_INITIALIZED__ = true;

  // Per-action check matrix. Mirrors Playwright: fill/clear/selectOption
  // run visible+enabled+editable. Stability and hit-test are unnecessary
  // — fill writes via the native setter, not via pointer events.
  const FILL_CHECKS = ['visible', 'enabled', 'editable'];

  /**
   * Set `el.value` (or `.checked`) in a way that React's controlled-component
   * reconciliation actually notices. Plain `el.value = x` writes to the DOM
   * but React's _valueTracker compares against its own cached value and
   * silently skips the change. The canonical fix is to call the native
   * HTMLInputElement.prototype.value setter, which bypasses React's setter
   * shim and forces _valueTracker to register a real change.
   *
   * Safe outside React: vanilla pages get the same observable assignment
   * they would have gotten from `el.value = x`.
   */
  function setNativeValue(element, value) {
    const proto =
      element.tagName === 'TEXTAREA'
        ? HTMLTextAreaElement.prototype
        : element.tagName === 'SELECT'
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && typeof desc.set === 'function') {
      desc.set.call(element, value);
    } else {
      element.value = value;
    }
  }

  function setNativeChecked(element, checked) {
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
    if (desc && typeof desc.set === 'function') {
      desc.set.call(element, checked);
    } else {
      element.checked = checked;
    }
  }

  /**
   * Fill an input element with the specified value
   * @param {string} selector - CSS selector for the element to fill
   * @param {string} value - Value to fill into the element
   * @param {string|null} ref - element ref from chrome_read_page
   * @param {{force?:boolean, actionabilityTimeoutMs?:number}} [opts]
   * @returns {Promise<Object>} - Result of the fill operation
   */
  async function fillElement(selector, value, ref = null, opts = {}) {
    const force = opts && opts.force === true;
    const actionabilityTimeoutMs =
      opts && typeof opts.actionabilityTimeoutMs === 'number' ? opts.actionabilityTimeoutMs : 5000;
    const allowMultipleStrict = !!(opts && opts.allowMultiple);
    const indexHint =
      opts && typeof opts.index === 'number' && opts.index >= 0 ? Math.floor(opts.index) : -1;
    try {
      // Find the element
      let element = null;
      if (ref && typeof ref === 'string') {
        try {
          const map = window.__claudeElementMap;
          const weak = map && map[ref];
          element = weak && typeof weak.deref === 'function' ? weak.deref() : null;
        } catch (e) {
          // ignore
        }
        if (!element || !(element instanceof Element)) {
          return {
            error: `Element ref "${ref}" not found. Please call chrome_read_page first and ensure the ref is still valid.`,
          };
        }
      } else if (indexHint >= 0) {
        // IMP-0117: explicit `index` opts out of strict mode for the fill
        // path — pick the Nth match directly.
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
      } else {
        const uniqueProbe =
          typeof window.__hcQuerySelectorUnique === 'function'
            ? window.__hcQuerySelectorUnique
            : null;
        if (uniqueProbe && !allowMultipleStrict) {
          const probe = uniqueProbe(selector, false);
          if (probe.error) return { error: probe.error };
          if (probe.matchCount === 0) {
            return { error: `Element with selector "${selector}" not found` };
          }
          if (probe.matchCount > 1) {
            // acc-tree-helper.js always co-injected — see IMP-0117 inject
            // list in interaction.ts. No fallback (a fake fallback would
            // re-introduce IMP-0116 by reporting the probe's 2-cap).
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
      }
      if (!element) {
        return {
          error: selector
            ? `Element with selector "${selector}" not found`
            : `Element for ref not found`,
        };
      }

      // Get element information. `isVisible` will be re-asserted via the
      // shared actionability suite below once we've narrowed to the final
      // (possibly post-shadow-root) target.
      const rect = element.getBoundingClientRect();
      const elementInfo = {
        tagName: element.tagName,
        id: element.id,
        className: element.className,
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
      };

      // Check if element is an input, textarea, or select
      const validTags = ['INPUT', 'TEXTAREA', 'SELECT'];
      // Keep a permissive list to allow type-specific branches below to handle behavior
      const validInputTypes = [
        'text',
        'email',
        'password',
        'number',
        'search',
        'tel',
        'url',
        'date',
        'datetime-local',
        'month',
        'time',
        'week',
        'color',
        'checkbox',
        'radio',
        'range',
      ];

      if (!validTags.includes(element.tagName)) {
        // If the element is a custom element with open shadow root, try to find a fillable inner control
        try {
          const anyEl = /** @type {any} */ (element);
          const sr = anyEl && anyEl.shadowRoot ? anyEl.shadowRoot : null;
          if (sr) {
            // Search common fillable targets inside shadow root (breadth-first)
            const queue = Array.from(sr.children || []);
            const isFillable = (el) =>
              !!el &&
              (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
            while (queue.length) {
              const cur = queue.shift();
              if (!cur) continue;
              if (isFillable(cur)) {
                element = cur;
                break;
              }
              try {
                const children = cur.children || [];
                for (let i = 0; i < children.length; i++) queue.push(children[i]);
                const innerSr = /** @type {any} */ (cur).shadowRoot;
                if (innerSr && innerSr.children) {
                  for (let i = 0; i < innerSr.children.length; i++) queue.push(innerSr.children[i]);
                }
              } catch (_) {}
            }
            if (!validTags.includes(element.tagName)) {
              return {
                error: `Element with selector "${selector}" is not a fillable element (must be INPUT, TEXTAREA, or SELECT)`,
                elementInfo,
              };
            }
          } else {
            return {
              error: `Element with selector "${selector}" is not a fillable element (must be INPUT, TEXTAREA, or SELECT)`,
              elementInfo,
            };
          }
        } catch (_) {
          return {
            error: `Element with selector "${selector}" is not a fillable element (must be INPUT, TEXTAREA, or SELECT)`,
            elementInfo,
          };
        }
      }

      // For input elements, check if the type is valid (allow type-specific branches below)
      if (
        element.tagName === 'INPUT' &&
        !validInputTypes.includes(element.type) &&
        element.type !== null
      ) {
        return {
          error: `Input element with selector "${selector}" has type "${element.type}" which is not fillable`,
          elementInfo,
        };
      }

      // Shared actionability suite — visible+enabled+editable. Replaces the
      // legacy isElementVisible early-exit and the standalone scrollIntoView
      // wait (the primitive scrolls internally before evaluating checks).
      const actResult = await runActionability(element, {
        checks: FILL_CHECKS,
        timeoutMs: actionabilityTimeoutMs,
        force,
      });
      if (!actResult.ok) {
        elementInfo.isVisible = !actResult.failures.includes('not_visible');
        return notActionableError(actResult.failures, selector || (ref ? `ref:${ref}` : ''), {
          elementInfo,
        });
      }

      // Focus the element
      element.focus();

      // Type-specific handling for tricky inputs first
      if (element.tagName === 'INPUT' && element.type === 'checkbox') {
        // Accept boolean or string-like boolean
        let checkedVal;
        if (typeof value === 'boolean') {
          checkedVal = value;
        } else if (typeof value === 'string') {
          const v = value.trim().toLowerCase();
          if (['true', '1', 'yes', 'on'].includes(v)) checkedVal = true;
          else if (['false', '0', 'no', 'off'].includes(v)) checkedVal = false;
        }
        if (typeof checkedVal !== 'boolean') {
          return {
            error:
              'Checkbox requires a boolean (true/false) or a boolean-like string ("true"/"false"/"on"/"off").',
            elementInfo,
          };
        }
        const previous = element.checked;
        setNativeChecked(element, checkedVal);
        element.focus();
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        element.blur();
        return {
          success: true,
          message: `Checkbox set to ${element.checked}`,
          elementInfo: { ...elementInfo, checked: element.checked, previousChecked: previous },
        };
      }

      if (element.tagName === 'INPUT' && element.type === 'radio') {
        // For radios, the selector/ref should target the specific input to select
        const previous = element.checked;
        setNativeChecked(element, true);
        element.focus();
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        element.blur();
        return {
          success: true,
          message: 'Radio selected',
          elementInfo: {
            ...elementInfo,
            checked: element.checked,
            previousChecked: previous,
            name: element.name || null,
          },
        };
      }

      if (element.tagName === 'INPUT' && element.type === 'range') {
        const numericValue = typeof value === 'number' ? value : Number(value);
        if (Number.isNaN(numericValue)) {
          return { error: 'Range input requires a numeric value', elementInfo };
        }
        const previous = element.value;
        setNativeValue(element, String(numericValue));
        element.focus();
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        element.blur();
        return {
          success: true,
          message: `Set range to ${element.value} (min: ${element.min}, max: ${element.max})`,
          elementInfo: { ...elementInfo, value: element.value },
        };
      }

      if (element.tagName === 'INPUT' && element.type === 'number') {
        if (value !== '' && value !== null && value !== undefined && Number.isNaN(Number(value))) {
          return { error: 'Number input requires a numeric value', elementInfo };
        }
        const previous = element.value;
        setNativeValue(element, String(value ?? ''));
        element.focus();
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        element.blur();
        return {
          success: true,
          message: `Set number input to ${element.value} (previous: ${previous})`,
          elementInfo: { ...elementInfo, value: element.value },
        };
      }

      // Fill the element based on its type
      if (element.tagName === 'SELECT') {
        // For select elements, find the option with matching value or text
        let optionFound = false;
        for (const option of element.options) {
          if (option.value === value || option.text === value) {
            setNativeValue(element, option.value);
            optionFound = true;
            break;
          }
        }

        if (!optionFound) {
          return {
            error: `No option with value or text "${value}" found in select element`,
            elementInfo,
          };
        }

        // Trigger input + change so React/Ember controlled selects observe it.
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        // For input and textarea elements
        // Clear the current value then set new value, both via native setter
        // so React's _valueTracker actually records the change.
        setNativeValue(element, '');
        element.dispatchEvent(new Event('input', { bubbles: true }));

        setNativeValue(element, String(value));

        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }

      // Blur the element
      element.blur();

      return {
        success: true,
        message: 'Element filled successfully',
        elementInfo: {
          ...elementInfo,
          value: element.value, // Include the final value in the response
        },
      };
    } catch (error) {
      return {
        error: `Error filling element: ${error.message}`,
      };
    }
  }

  /**
   * Run the shared actionability primitive. IMP-0137: when the primitive
   * is missing, hard-fail with `actionability_unavailable` so the tool can
   * surface NOT_ACTIONABLE rather than silently degrading to a permissive
   * fill (a value-write into a disabled/readonly/hidden field). Comment
   * used to say "production callers always inject it alongside fill-
   * helper" — that's a hope, not a guarantee, and the silent-degrade was
   * exactly the bug that removed the guarantee from the contract.
   *
   * Explicit `force: true` short-circuits the wrapper: the caller has
   * already opted out of the actionability suite, so the primitive
   * being missing doesn't change anything actionable for them.
   */
  function runActionability(el, opts) {
    if (opts && opts.force === true) return Promise.resolve({ ok: true });
    const api = window.__actionability;
    if (!api || typeof api.awaitActionable !== 'function') {
      return Promise.resolve({ ok: false, failures: ['actionability_unavailable'] });
    }
    return api.awaitActionable(el, opts);
  }

  /** Structured envelope the background tool maps to NOT_ACTIONABLE. */
  function notActionableError(failures, selectorRef, extra) {
    const list = Array.isArray(failures) ? failures : [];
    const msg =
      list.length === 0
        ? 'Element is not actionable'
        : `Element is not actionable: ${list.join(', ')}`;
    return {
      error: msg,
      notActionable: true,
      failures: list,
      selectorOrRef: selectorRef,
      ...(extra || {}),
    };
  }

  // Listen for messages from the extension
  chrome.runtime?.onMessage?.addListener((request, _sender, sendResponse) => {
    if (request.action === 'fillElement') {
      fillElement(request.selector, request.value, request.ref, {
        force: request.force === true,
        actionabilityTimeoutMs: request.actionabilityTimeoutMs,
        allowMultiple: request.allowMultiple === true,
        index: typeof request.index === 'number' ? request.index : undefined,
      })
        .then(sendResponse)
        .catch((error) => {
          sendResponse({
            error: `Unexpected error: ${error.message}`,
          });
        });
      return true; // Indicates async response
    } else if (request.action === 'chrome_fill_or_select_ping') {
      sendResponse({ status: 'pong' });
      return false;
    }
  });
}
