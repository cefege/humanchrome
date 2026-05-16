// actionability.js
// Shared actionability primitive — visible/stable/enabled/editable/hit-test
// checks every interaction tool runs before dispatching the action.
//
// Mirrors the Playwright contract: a click never lands on a not-yet-painted
// or sliding-into-place element; a fill never writes into a disabled input;
// nothing dispatches onto a div that just happened to be at the right
// coordinates but is sitting under a cookie banner. Each consumer
// (click-helper, fill-helper, drag-drop shim, focus shim, computer.ts) wires
// the same `awaitActionable(el, opts)` and surfaces failures as
// `NOT_ACTIONABLE` with `details.failures` so callers can branch.
//
// The script runs in ISOLATED world alongside click-helper / fill-helper /
// accessibility-tree-helper (it shares no state — it's pure functions). It
// also exports a small test seeder used by the unit suite (jsdom).

if (window.__ACTIONABILITY_INITIALIZED__) {
  // Already initialized, skip.
} else {
  window.__ACTIONABILITY_INITIALIZED__ = true;

  // Default per-action timeout. Matches Playwright's actionability default
  // closely enough; callers can override via `awaitActionable(el, {timeoutMs})`.
  const DEFAULT_TIMEOUT_MS = 5000;
  // Hard cap on rAF iterations for the stability check. ~6 frames at 60fps
  // ≈ 100ms — long enough for slide-in animations to settle, short enough
  // that we don't hold the page indefinitely.
  const STABILITY_MAX_FRAMES = 6;

  /**
   * The full per-action check catalog. Each consumer picks the subset that
   * applies (click runs visible+stable+enabled+hit-test; fill runs
   * visible+enabled+editable; focus runs visible; etc.). The matrix lives
   * in the consumers, not here — this primitive only knows how to evaluate
   * the individual checks.
   */
  const ALL_CHECKS = ['visible', 'enabled', 'editable', 'stable', 'hit-test'];

  /**
   * Wait until every requested check passes, or timeoutMs elapses. Returns
   * `{ok: true}` on success or `{ok: false, failures: string[]}` on
   * failure. Failure tokens use Playwright-style codes:
   *   - `not_visible` (display:none, visibility:hidden, opacity:0, empty
   *     bbox, off-viewport after scrollIntoView, `pointer-events:none`)
   *   - `disabled` (disabled attr, aria-disabled, nearest fieldset[disabled])
   *   - `not_editable` (readonly, contenteditable=false, or non-fillable tag)
   *   - `unstable_bbox` (bbox kept moving past STABILITY_MAX_FRAMES rAFs)
   *   - `occluded_by:<selector>` (elementFromPoint at clickPoint resolved to
   *     a different element, identified by id/class for the failure msg)
   *   - `no_element_at_point` (elementFromPoint returned null — clickPoint
   *     outside the viewport even after scroll)
   *
   * @param {Element} el  Target element. Must already be in the DOM.
   * @param {Object}  opts
   * @param {string[]} [opts.checks]   Subset of ALL_CHECKS to run.
   * @param {number}   [opts.timeoutMs=5000] Total time budget.
   * @param {boolean}  [opts.force=false] Skip all checks (scrollIntoView still runs).
   * @param {{x:number,y:number}} [opts.position] Override the hit-test
   *   click-point. Defaults to element center.
   * @returns {Promise<{ok: true} | {ok: false, failures: string[]}>}
   */
  async function awaitActionable(el, opts = {}) {
    const force = !!opts.force;
    // Even when `force: true`, scrollIntoView still runs — actionability
    // is bypassed but the user almost always wants the target on-screen
    // (offscreen clicks land on the wrong element).
    try {
      scrollIntoViewIfNeeded(el);
    } catch {
      // ignore — scrollIntoView throwing means the element was detached;
      // the subsequent checks will catch it.
    }

    if (force) return { ok: true };

    const checks = Array.isArray(opts.checks) && opts.checks.length > 0 ? opts.checks : ALL_CHECKS;
    const timeoutMs = Math.max(0, Number(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    const deadline = Date.now() + timeoutMs;

    let lastFailures = [];

    // Poll: each iteration re-evaluates every requested check. The stable
    // check is cooperative — it runs its own rAF loop internally if invoked
    // — so this outer loop just retries on a 16ms tick for the cheaper
    // checks (visibility flips, disabled toggle, occluder dismissed).
    while (true) {
      const failures = [];

      if (checks.includes('visible')) {
        const failure = checkVisible(el);
        if (failure) failures.push(failure);
      }

      if (checks.includes('enabled')) {
        const failure = checkEnabled(el);
        if (failure) failures.push(failure);
      }

      if (checks.includes('editable')) {
        const failure = checkEditable(el);
        if (failure) failures.push(failure);
      }

      // Stability runs its own bounded inner loop so we don't burn the
      // whole outer budget on a single rAF tick.
      if (checks.includes('stable') && failures.length === 0) {
        const stable = await checkStable(el);
        if (stable) failures.push(stable);
      }

      // Hit-test depends on visible+stable; running it earlier would chase
      // a moving rect. Only evaluate if the rest of the suite passed.
      if (checks.includes('hit-test') && failures.length === 0) {
        const hit = checkHitTest(el, opts.position);
        if (hit) failures.push(hit);
      }

      if (failures.length === 0) return { ok: true };
      lastFailures = failures;

      if (Date.now() >= deadline) {
        return { ok: false, failures: lastFailures };
      }

      // Small wait before retry; longer than rAF so we don't burn cpu, short
      // enough that a freshly-dismissed overlay or enabled button unblocks
      // within one poll. 50ms is the same cadence Playwright uses.
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /**
   * scrollIntoView the element if its rect is partially or fully outside
   * the viewport. No-op when already in view. Uses 'auto' behavior so the
   * action doesn't block on smooth-scroll animations.
   */
  function scrollIntoViewIfNeeded(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    const outOfView = rect.bottom <= 0 || rect.top >= vh || rect.right <= 0 || rect.left >= vw;
    if (outOfView) {
      try {
        el.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
      } catch {
        // ignore
      }
    }
  }

  /**
   * Visibility: display/visibility/opacity, non-empty bbox, in-viewport,
   * `pointer-events:none`. Returns failure token or null when visible.
   */
  function checkVisible(el) {
    if (!el || !el.isConnected) return 'not_visible';
    let style;
    try {
      style = window.getComputedStyle(el);
    } catch {
      return 'not_visible';
    }
    if (!style) return 'not_visible';
    if (style.display === 'none') return 'not_visible';
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return 'not_visible';
    // Some libraries use opacity:0 to fade-out before removal. Treat as
    // not_visible for action purposes — Playwright does too.
    if (Number(style.opacity) === 0) return 'not_visible';
    if (style.pointerEvents === 'none') return 'not_visible';

    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return 'not_visible';

    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    if (rect.bottom <= 0 || rect.top >= vh || rect.right <= 0 || rect.left >= vw) {
      return 'not_visible';
    }
    return null;
  }

  /**
   * Enabled: not disabled (attr / property / aria-disabled=true), and not
   * inside a disabled fieldset.
   */
  function checkEnabled(el) {
    if (!el) return 'disabled';
    // HTMLInputElement / HTMLButtonElement / HTMLSelectElement /
    // HTMLTextAreaElement expose `disabled` as both attr and property; the
    // property is authoritative.
    if (/** @type {any} */ (el).disabled === true) return 'disabled';
    const aria = el.getAttribute && el.getAttribute('aria-disabled');
    if (aria === 'true') return 'disabled';
    // Bubble through ancestors looking for a disabled fieldset — Chrome and
    // Firefox apply the disabled-fieldset rule transitively, but only the
    // primary input properties light up `disabled`. We need to catch the
    // nested case (Playwright does).
    if (typeof el.closest === 'function') {
      const fieldset = el.closest('fieldset[disabled]');
      if (fieldset) return 'disabled';
    }
    return null;
  }

  /**
   * Editable: enabled + not readonly + not contenteditable=false. Used for
   * fill / clear / selectOption. (Visibility runs separately — we don't
   * re-run it here.)
   */
  function checkEditable(el) {
    // Enabled is a prerequisite for editable.
    const disabled = checkEnabled(el);
    if (disabled) return disabled === 'disabled' ? 'not_editable' : disabled;

    // readonly on inputs/textareas
    if (/** @type {any} */ (el).readOnly === true) return 'not_editable';

    // contenteditable=false on non-form elements
    const tag = el.tagName ? el.tagName.toUpperCase() : '';
    if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
      const ce = el.getAttribute && el.getAttribute('contenteditable');
      if (ce === 'false') return 'not_editable';
    }

    return null;
  }

  /**
   * Stability: same getBoundingClientRect for 2 consecutive rAFs. Bails
   * after STABILITY_MAX_FRAMES rAFs returning `unstable_bbox`. The check is
   * cheap when the element isn't animated — the first two frames match and
   * we return immediately.
   */
  function checkStable(el) {
    return new Promise((resolve) => {
      let frames = 0;
      let prev = el.getBoundingClientRect();

      function rectsEqual(a, b) {
        return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
      }

      function tick() {
        const current = el.getBoundingClientRect();
        if (rectsEqual(prev, current)) {
          resolve(null);
          return;
        }
        prev = current;
        frames += 1;
        if (frames >= STABILITY_MAX_FRAMES) {
          resolve('unstable_bbox');
          return;
        }
        // jsdom doesn't ship rAF; setTimeout(16) is the standard polyfill
        // pattern and the test suite seeds it explicitly.
        const raf =
          typeof window.requestAnimationFrame === 'function'
            ? window.requestAnimationFrame
            : (cb) => setTimeout(cb, 16);
        raf(tick);
      }

      tick();
    });
  }

  /**
   * Hit-test: the topmost element at `position` (defaults to center) must
   * be the target itself or one of its descendants. When a different
   * element wins, identify it by id/class for the failure token so the
   * agent can dismiss the right overlay.
   */
  function checkHitTest(el, position) {
    if (!el || typeof document.elementFromPoint !== 'function') {
      // No way to verify — be permissive rather than blocking real clicks
      // on test runners that don't implement elementFromPoint.
      return null;
    }
    const rect = el.getBoundingClientRect();
    const cx = position?.x ?? rect.left + rect.width / 2;
    const cy = position?.y ?? rect.top + rect.height / 2;

    let topmost;
    try {
      topmost = document.elementFromPoint(cx, cy);
    } catch {
      return null;
    }
    if (!topmost) return 'no_element_at_point';

    if (topmost === el) return null;
    if (typeof el.contains === 'function' && el.contains(topmost)) return null;
    // Reverse-contains is the click-on-inner-text-node case: the page
    // returns the inner span but we asked about the outer button. Both
    // semantics are equivalent for actionability.
    if (typeof topmost.contains === 'function' && topmost.contains(el)) return null;

    return `occluded_by:${describeOccluder(topmost)}`;
  }

  /** Build a short selector-ish description for the occluding element. */
  function describeOccluder(el) {
    if (!el) return 'unknown';
    const tag = (el.tagName || 'unknown').toLowerCase();
    if (el.id) return `${tag}#${el.id}`;
    if (typeof el.className === 'string' && el.className.trim().length > 0) {
      const first = el.className.trim().split(/\s+/)[0];
      if (first) return `${tag}.${first}`;
    }
    return tag;
  }

  // Expose to other inject-scripts running in the same ISOLATED world.
  // click-helper.js / fill-helper.js / wait-helper.js all reach through
  // `window.__actionability` rather than re-injecting this file.
  window.__actionability = { awaitActionable, ALL_CHECKS };

  // Test-only escape hatch. The jsdom test suite needs to install the
  // primitive into a fresh window without relying on the inject-script's
  // initialization guard (it runs once per page). Mirrors the `_resetX`
  // convention but the underscore lives on the exported name to keep the
  // surface stripped from production callers.
  window.installActionabilityForTest = function installActionabilityForTest(targetWindow) {
    const w = targetWindow || window;
    w.__actionability = { awaitActionable, ALL_CHECKS };
    return w.__actionability;
  };

  // Respond to ping so callers can confirm the helper is loaded before
  // dispatching their action — same convention as click-helper /
  // fill-helper / wait-helper.
  if (chrome && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
      if (request && request.action === 'actionability_ping') {
        sendResponse({ status: 'pong' });
        return false;
      }
      return false;
    });
  }
}
