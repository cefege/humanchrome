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
   *   - `unstable_bbox` (bbox kept changing across the stability sampler's
   *     three 50ms-spaced samples — caller is mid-animation)
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
    // One-shot recovery: an element in a scroll container the orchestrator
    // entry didn't address can still come into view via a centered scroll +
    // rAF flush. Playwright's contract is to retry once before failing.
    let triedScrollRecovery = false;

    // Poll: each iteration re-evaluates every requested check. The stable
    // check is cooperative — it runs its own bounded inner loop, and IMP-0155
    // plumbs the outer `deadline` through so that loop bails when the budget
    // is gone (without the plumb, a 4s-infinite-translate animation kept the
    // sampler resampling forever and the matrix runner saw 15s HTTP timeouts
    // instead of the expected unstable_bbox envelope).
    //
    // Every blocking sub-call (checkStable, the scroll-recovery waitOneFrame,
    // the inter-iteration 50ms sleep) is bounded by `deadline` so the worst-
    // case total wall time is `timeoutMs + one-iteration-of-cheap-checks`
    // — never the 15s transport ceiling above us.
    while (true) {
      const failures = [];

      if (checks.includes('visible')) {
        let failure = checkVisible(el);
        if (failure === 'not_visible' && !triedScrollRecovery && isOffscreenButPresent(el)) {
          triedScrollRecovery = true;
          scrollCenter(el);
          // Race the rAF against the remaining deadline. Background-tab
          // throttling can stretch a single rAF tick well past its nominal
          // 16ms, so without the race the recovery branch alone could
          // burn the entire outer budget.
          await waitOneFrameOrDeadline(deadline);
          failure = checkVisible(el);
        }
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
      // whole outer budget on a single rAF tick. The inner loop now
      // shares `deadline` (IMP-0155): if it expires mid-sample the
      // sampler returns `unstable_bbox` immediately rather than scheduling
      // another setTimeout. checkStable's own fast-path (no active
      // animation) still returns null instantly so static elements
      // don't pay the deadline cost — guarding the call with an outer
      // `Date.now() >= deadline` here would mis-classify them as
      // unstable_bbox just because a sibling section took the whole
      // budget to evaluate.
      if (checks.includes('stable') && failures.length === 0) {
        const stable = await checkStable(el, deadline);
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
      // within one poll. 50ms is the same cadence Playwright uses. Clip to
      // the remaining budget so we don't overshoot the deadline.
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return { ok: false, failures: lastFailures };
      }
      await new Promise((r) => setTimeout(r, Math.min(50, remaining)));
    }
  }

  function getViewport() {
    return {
      vw: window.innerWidth || document.documentElement.clientWidth || 0,
      vh: window.innerHeight || document.documentElement.clientHeight || 0,
    };
  }

  function isOutOfViewport(rect, vw, vh) {
    return rect.bottom <= 0 || rect.top >= vh || rect.right <= 0 || rect.left >= vw;
  }

  /**
   * Returns true when computed style makes the element unactionable
   * regardless of position (display:none, visibility:hidden|collapse,
   * opacity:0, pointer-events:none). Throws-as-hidden so detached / broken
   * style calls don't crash the caller.
   */
  function isCssHidden(el) {
    try {
      const style = window.getComputedStyle(el);
      if (!style) return true;
      if (style.display === 'none') return true;
      if (style.visibility === 'hidden' || style.visibility === 'collapse') return true;
      if (Number(style.opacity) === 0) return true;
      if (style.pointerEvents === 'none') return true;
      return false;
    } catch {
      return true;
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
    const { vw, vh } = getViewport();
    if (isOutOfViewport(rect, vw, vh)) {
      try {
        el.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
      } catch {
        // ignore
      }
    }
  }

  /**
   * One-shot centered scroll used by the recovery branch. `behavior:'instant'`
   * landed in the spec in 2022; older engines reject it, so fall back to the
   * default behavior. Detached elements throw — swallow; the post-rAF re-check
   * will report `not_visible`.
   */
  function scrollCenter(el) {
    try {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    } catch {
      try {
        el.scrollIntoView({ block: 'center', inline: 'center' });
      } catch {
        // ignore
      }
    }
  }

  /**
   * True when the element is in the DOM, not CSS-hidden, has a non-zero
   * bbox, but is outside the viewport — i.e. a scrollIntoView retry might
   * recover it. Returning false for CSS-hidden / zero-area / detached lets
   * the polling loop skip a wasted rAF tick.
   */
  function isOffscreenButPresent(el) {
    if (!el || !el.isConnected) return false;
    if (isCssHidden(el)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const { vw, vh } = getViewport();
    return isOutOfViewport(rect, vw, vh);
  }

  /**
   * Resolve on the next animation frame. Used after scrollIntoView so the
   * synchronous layout flush has a chance to land before re-checking. Falls
   * back to a setTimeout(0) when rAF is unavailable (jsdom, very old browsers).
   *
   * IMP-0155: race against an optional absolute `deadline`. Chrome throttles
   * rAF for backgrounded / hidden tabs (and even foreground tabs can stall
   * one frame under heavy GC), so without the race the recovery branch could
   * burn the whole outer actionability budget on a single rAF tick. When the
   * deadline is already past, resolve on the next microtask so the caller
   * proceeds to its own deadline check.
   */
  function waitOneFrameOrDeadline(deadline) {
    return new Promise((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        resolve(undefined);
      };
      if (typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(() => settle());
      } else {
        setTimeout(() => settle(), 0);
      }
      if (typeof deadline === 'number') {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          // Already past the deadline — settle on the next tick so the
          // caller's next `Date.now() >= deadline` check fires.
          setTimeout(settle, 0);
        } else {
          setTimeout(settle, remaining);
        }
      }
    });
  }

  /**
   * Visibility: display/visibility/opacity, non-empty bbox, in-viewport,
   * `pointer-events:none`. Returns failure token or null when visible.
   */
  function checkVisible(el) {
    if (!el || !el.isConnected) return 'not_visible';
    if (isCssHidden(el)) return 'not_visible';

    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return 'not_visible';

    const { vw, vh } = getViewport();
    if (isOutOfViewport(rect, vw, vh)) return 'not_visible';
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

  // Fixed-interval sampler instead of rAF — under Chrome's SW lifecycle, rAF
  // was throttling-fragile and caused matrix hangs. setTimeout keeps the
  // fast-path skip when Element.getAnimations reports no running animation,
  // and the transform-string comparison catches sub-pixel motion that rounds
  // to identical bbox.
  const STABILITY_SAMPLE_MS = 50;
  const REQUIRED_SAMPLES = 4;

  function rectsEqual(a, b) {
    return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
  }

  /**
   * Returns the computed transform as a string (`matrix(...)`, `matrix3d(...)`
   * or `none`). The engine normalizes to one of these forms, so direct
   * string comparison is sufficient for change-detection.
   */
  function readTransform(el) {
    try {
      const style = window.getComputedStyle(el);
      return (style && style.transform) || 'none';
    } catch {
      return 'none';
    }
  }

  function hasActiveAnimation(el) {
    if (typeof el.getAnimations !== 'function') return false;
    try {
      // `subtree: true` catches transforms on parents that shift the child's
      // bbox. Filter on `playState === 'running'` so finished/paused
      // animations (post-fade-in, etc) don't trip the slow sampler forever.
      return el.getAnimations({ subtree: true }).some((a) => a.playState === 'running');
    } catch {
      // getAnimations throws on cross-origin iframe descendants (spec:
      // InvalidStateError). Assume animated and let the sampler decide —
      // a false-positive sampler run is cheap; a false-positive "stable"
      // re-introduces IMP-0118 against cross-origin targets.
      return true;
    }
  }

  /**
   * Sample bbox + transform at fixed intervals; resolves `unstable_bbox`
   * the moment any sample differs from the baseline, `null` after
   * REQUIRED_SAMPLES consecutive matches.
   *
   * IMP-0155: when the outer `awaitActionable` deadline expires mid-sample
   * (e.g. an `infinite alternate` animation whose bbox+transform happen to
   * align across the entire sampler window — vanishingly rare in practice
   * but the previous code had no guard), bail out with `unstable_bbox`
   * rather than scheduling another setTimeout that would extend wall time
   * past the caller's budget. Without this, the matrix runner saw 15s HTTP
   * timeouts on the #sliding-btn fixture instead of the expected envelope.
   *
   * `deadline` is the absolute Date.now() ceiling; pass `undefined` when no
   * outer deadline applies (tests that exercise the sampler in isolation
   * via `timeoutMs:1000+` rely on the legacy ~200ms unconditional behaviour).
   */
  function checkStable(el, deadline) {
    if (!hasActiveAnimation(el)) return Promise.resolve(null);
    const baselineRect = el.getBoundingClientRect();
    const baselineTransform = readTransform(el);
    let taken = 1;
    return new Promise((resolve) => {
      function takeSample() {
        if (
          !rectsEqual(baselineRect, el.getBoundingClientRect()) ||
          readTransform(el) !== baselineTransform
        ) {
          resolve('unstable_bbox');
          return;
        }
        taken += 1;
        if (taken >= REQUIRED_SAMPLES) {
          resolve(null);
          return;
        }
        if (typeof deadline === 'number' && Date.now() >= deadline) {
          // Active animation reported by getAnimations() AND we've burned
          // the budget. The element is by definition still animating —
          // failing closed (unstable_bbox) is the safe answer; the
          // alternative would be claiming stable on a still-moving target.
          resolve('unstable_bbox');
          return;
        }
        scheduleNextSample();
      }
      function scheduleNextSample() {
        if (typeof deadline === 'number') {
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            resolve('unstable_bbox');
            return;
          }
          setTimeout(takeSample, Math.min(STABILITY_SAMPLE_MS, remaining));
        } else {
          setTimeout(takeSample, STABILITY_SAMPLE_MS);
        }
      }
      scheduleNextSample();
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
