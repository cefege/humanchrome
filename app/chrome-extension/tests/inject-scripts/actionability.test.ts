/**
 * Actionability primitive tests (IMP-0097).
 *
 * The script lives in `inject-scripts/actionability.js` and runs in the
 * ISOLATED content-script world at runtime. For unit tests we read the
 * file from disk, eval it into jsdom, and exercise the exported
 * `awaitActionable` directly. Per-check coverage:
 *   - visible (display, visibility, opacity, empty rect, off-viewport,
 *     pointer-events:none)
 *   - enabled (disabled property, aria-disabled, fieldset[disabled])
 *   - editable (readonly, contenteditable=false)
 *   - stable (bbox-moving → bail with unstable_bbox)
 *   - hit-test (occluder identified by id/class)
 *   - scrollIntoView triggered when off-viewport
 *   - `force: true` bypass
 *   - `actionabilityTimeoutMs` honored (eventually-passes case)
 */

import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const SCRIPT_PATH = resolvePath(__dirname, '..', '..', 'inject-scripts', 'actionability.js');
const SCRIPT_SOURCE = readFileSync(SCRIPT_PATH, 'utf-8');

interface ActionabilityApi {
  awaitActionable: (
    el: Element,
    opts?: {
      checks?: string[];
      timeoutMs?: number;
      force?: boolean;
      position?: { x: number; y: number };
    },
  ) => Promise<{ ok: true } | { ok: false; failures: string[] }>;
  ALL_CHECKS: string[];
}

function loadActionability(): ActionabilityApi {
  // Reset the init guard so the script re-evaluates against the current
  // jsdom window. Vitest's test isolation gives us a fresh document per
  // test (clearMocks+restoreMocks), but window persists across tests in
  // the same module — clear the guard explicitly to be safe.

  (window as any).__ACTIONABILITY_INITIALIZED__ = false;
  // The script self-installs `window.__actionability` and also exposes
  // `window.installActionabilityForTest`. Eval'ing it in the global scope
  // is the simplest way to mirror how chrome.scripting injects it at
  // runtime — no module wrapper, no module exports.

  new Function(SCRIPT_SOURCE).call(window);

  const api = (window as any).__actionability as ActionabilityApi;
  expect(api).toBeTruthy();
  expect(typeof api.awaitActionable).toBe('function');
  return api;
}

// Stub a rect on an element so checkVisible / checkHit see what we want.
function stubRect(el: Element, rect: Partial<DOMRect>): void {
  const merged: DOMRect = {
    x: rect.x ?? 0,
    y: rect.y ?? 0,
    width: rect.width ?? 100,
    height: rect.height ?? 50,
    top: rect.top ?? rect.y ?? 0,
    left: rect.left ?? rect.x ?? 0,
    right: (rect.x ?? 0) + (rect.width ?? 100),
    bottom: (rect.y ?? 0) + (rect.height ?? 50),
    toJSON: () => merged,
  };
  el.getBoundingClientRect = () => merged;
}

beforeEach(() => {
  // Fresh DOM body per test.
  document.body.innerHTML = '';
  // Default viewport so checkVisible's in-viewport branch fires the way
  // tests expect (jsdom defaults to 1024x768 already, but pinning makes
  // the assertions readable).
  Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true });
});

describe('actionability: visible check', () => {
  it('passes for a fully-visible element', async () => {
    const api = loadActionability();
    const el = document.createElement('button');
    el.textContent = 'Click me';
    document.body.appendChild(el);
    stubRect(el, { x: 10, y: 10, width: 100, height: 30 });
    // mock elementFromPoint to return our element so the hit-test passes
    document.elementFromPoint = vi.fn(() => el);
    const r = await api.awaitActionable(el, { checks: ['visible'], timeoutMs: 200 });
    expect(r.ok).toBe(true);
  });

  it('fails with not_visible when display:none', async () => {
    const api = loadActionability();
    const el = document.createElement('button');
    el.style.display = 'none';
    document.body.appendChild(el);
    stubRect(el, { x: 0, y: 0, width: 100, height: 30 });
    const r = await api.awaitActionable(el, { checks: ['visible'], timeoutMs: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failures).toContain('not_visible');
  });

  it('fails with not_visible when visibility:hidden', async () => {
    const api = loadActionability();
    const el = document.createElement('button');
    el.style.visibility = 'hidden';
    document.body.appendChild(el);
    stubRect(el, { x: 0, y: 0, width: 100, height: 30 });
    const r = await api.awaitActionable(el, { checks: ['visible'], timeoutMs: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failures).toContain('not_visible');
  });

  it('fails with not_visible when opacity:0', async () => {
    const api = loadActionability();
    const el = document.createElement('button');
    el.style.opacity = '0';
    document.body.appendChild(el);
    stubRect(el, { x: 0, y: 0, width: 100, height: 30 });
    const r = await api.awaitActionable(el, { checks: ['visible'], timeoutMs: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failures).toContain('not_visible');
  });

  it('fails with not_visible when pointer-events:none', async () => {
    const api = loadActionability();
    const el = document.createElement('button');
    el.style.pointerEvents = 'none';
    document.body.appendChild(el);
    stubRect(el, { x: 0, y: 0, width: 100, height: 30 });
    const r = await api.awaitActionable(el, { checks: ['visible'], timeoutMs: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failures).toContain('not_visible');
  });

  it('fails with not_visible for an empty bbox', async () => {
    const api = loadActionability();
    const el = document.createElement('button');
    document.body.appendChild(el);
    stubRect(el, { x: 0, y: 0, width: 0, height: 0 });
    const r = await api.awaitActionable(el, { checks: ['visible'], timeoutMs: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failures).toContain('not_visible');
  });

  it('fails with not_visible for an offscreen element when scrollIntoView is mocked-out', async () => {
    const api = loadActionability();
    const el = document.createElement('button');
    document.body.appendChild(el);
    // far below the viewport AND scrollIntoView is a no-op
    stubRect(el, { x: 100, y: 10000, width: 100, height: 30 });
    el.scrollIntoView = vi.fn();
    const r = await api.awaitActionable(el, { checks: ['visible'], timeoutMs: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failures).toContain('not_visible');
  });
});

describe('actionability: enabled check', () => {
  it('passes for an enabled button', async () => {
    const api = loadActionability();
    const el = document.createElement('button');
    document.body.appendChild(el);
    stubRect(el, { x: 10, y: 10, width: 100, height: 30 });
    const r = await api.awaitActionable(el, { checks: ['enabled'], timeoutMs: 100 });
    expect(r.ok).toBe(true);
  });

  it('fails with disabled when the property is true', async () => {
    const api = loadActionability();
    const el = document.createElement('button');
    el.disabled = true;
    document.body.appendChild(el);
    stubRect(el, { x: 10, y: 10, width: 100, height: 30 });
    const r = await api.awaitActionable(el, { checks: ['enabled'], timeoutMs: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failures).toContain('disabled');
  });

  it('fails with disabled when aria-disabled=true', async () => {
    const api = loadActionability();
    const el = document.createElement('div');
    el.setAttribute('aria-disabled', 'true');
    document.body.appendChild(el);
    stubRect(el, { x: 10, y: 10, width: 100, height: 30 });
    const r = await api.awaitActionable(el, { checks: ['enabled'], timeoutMs: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failures).toContain('disabled');
  });

  it('fails with disabled when nearest fieldset is disabled', async () => {
    const api = loadActionability();
    const fs = document.createElement('fieldset');
    fs.setAttribute('disabled', '');
    const el = document.createElement('input');
    fs.appendChild(el);
    document.body.appendChild(fs);
    stubRect(el, { x: 10, y: 10, width: 100, height: 30 });
    const r = await api.awaitActionable(el, { checks: ['enabled'], timeoutMs: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failures).toContain('disabled');
  });
});

describe('actionability: editable check', () => {
  it('passes for a normal input', async () => {
    const api = loadActionability();
    const el = document.createElement('input');
    document.body.appendChild(el);
    stubRect(el, { x: 10, y: 10, width: 100, height: 30 });
    const r = await api.awaitActionable(el, { checks: ['editable'], timeoutMs: 100 });
    expect(r.ok).toBe(true);
  });

  it('fails with not_editable when readonly', async () => {
    const api = loadActionability();
    const el = document.createElement('input');
    el.readOnly = true;
    document.body.appendChild(el);
    stubRect(el, { x: 10, y: 10, width: 100, height: 30 });
    const r = await api.awaitActionable(el, { checks: ['editable'], timeoutMs: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failures).toContain('not_editable');
  });

  it('fails with not_editable when div is contenteditable=false', async () => {
    const api = loadActionability();
    const el = document.createElement('div');
    el.setAttribute('contenteditable', 'false');
    document.body.appendChild(el);
    stubRect(el, { x: 10, y: 10, width: 100, height: 30 });
    const r = await api.awaitActionable(el, { checks: ['editable'], timeoutMs: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failures).toContain('not_editable');
  });

  it('propagates disabled into not_editable', async () => {
    const api = loadActionability();
    const el = document.createElement('input');
    el.disabled = true;
    document.body.appendChild(el);
    stubRect(el, { x: 10, y: 10, width: 100, height: 30 });
    const r = await api.awaitActionable(el, { checks: ['editable'], timeoutMs: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failures).toContain('not_editable');
  });
});

describe('actionability: stable check', () => {
  it('passes when bbox is stable across two frames', async () => {
    const api = loadActionability();
    const el = document.createElement('div');
    document.body.appendChild(el);
    stubRect(el, { x: 10, y: 10, width: 100, height: 30 });
    const r = await api.awaitActionable(el, { checks: ['stable'], timeoutMs: 1000 });
    expect(r.ok).toBe(true);
  });

  it('fails with unstable_bbox when rect keeps moving', async () => {
    const api = loadActionability();
    const el = document.createElement('div');
    document.body.appendChild(el);

    // Move the rect by 5px on every call.
    let xOffset = 10;
    el.getBoundingClientRect = () => {
      xOffset += 5;
      return {
        x: xOffset,
        y: 10,
        width: 100,
        height: 30,
        top: 10,
        left: xOffset,
        right: xOffset + 100,
        bottom: 40,
        toJSON: () => ({}),
      } as DOMRect;
    };

    const r = await api.awaitActionable(el, { checks: ['stable'], timeoutMs: 1000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failures).toContain('unstable_bbox');
  });
});

describe('actionability: hit-test check', () => {
  it('passes when elementFromPoint resolves to the target', async () => {
    const api = loadActionability();
    const el = document.createElement('button');
    document.body.appendChild(el);
    stubRect(el, { x: 10, y: 10, width: 100, height: 30 });
    document.elementFromPoint = vi.fn(() => el);
    const r = await api.awaitActionable(el, { checks: ['hit-test'], timeoutMs: 100 });
    expect(r.ok).toBe(true);
  });

  it('passes when elementFromPoint resolves to a descendant', async () => {
    const api = loadActionability();
    const button = document.createElement('button');
    const inner = document.createElement('span');
    button.appendChild(inner);
    document.body.appendChild(button);
    stubRect(button, { x: 10, y: 10, width: 100, height: 30 });
    document.elementFromPoint = vi.fn(() => inner);
    const r = await api.awaitActionable(button, { checks: ['hit-test'], timeoutMs: 100 });
    expect(r.ok).toBe(true);
  });

  it('fails with occluded_by:#cookie-banner when an overlay is on top', async () => {
    const api = loadActionability();
    const target = document.createElement('button');
    document.body.appendChild(target);
    stubRect(target, { x: 10, y: 10, width: 100, height: 30 });
    const overlay = document.createElement('div');
    overlay.id = 'cookie-banner';
    document.body.appendChild(overlay);
    document.elementFromPoint = vi.fn(() => overlay);

    const r = await api.awaitActionable(target, { checks: ['hit-test'], timeoutMs: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const occluded = r.failures.find((f) => f.startsWith('occluded_by:'));
      expect(occluded).toBe('occluded_by:div#cookie-banner');
    }
  });

  it('fails with occluded_by:<tag>.<class> when the occluder has only a class', async () => {
    const api = loadActionability();
    const target = document.createElement('button');
    document.body.appendChild(target);
    stubRect(target, { x: 10, y: 10, width: 100, height: 30 });
    const overlay = document.createElement('aside');
    overlay.className = 'modal-overlay primary';
    document.body.appendChild(overlay);
    document.elementFromPoint = vi.fn(() => overlay);

    const r = await api.awaitActionable(target, { checks: ['hit-test'], timeoutMs: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const occluded = r.failures.find((f) => f.startsWith('occluded_by:'));
      expect(occluded).toBe('occluded_by:aside.modal-overlay');
    }
  });

  it('fails with no_element_at_point when elementFromPoint returns null', async () => {
    const api = loadActionability();
    const target = document.createElement('button');
    document.body.appendChild(target);
    stubRect(target, { x: 10, y: 10, width: 100, height: 30 });
    document.elementFromPoint = vi.fn(() => null);
    const r = await api.awaitActionable(target, { checks: ['hit-test'], timeoutMs: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failures).toContain('no_element_at_point');
  });

  it('honours a per-call `position` override for hit-test', async () => {
    const api = loadActionability();
    const target = document.createElement('button');
    document.body.appendChild(target);
    stubRect(target, { x: 0, y: 0, width: 200, height: 100 });
    const efp = vi.fn(() => target);
    document.elementFromPoint = efp;
    const r = await api.awaitActionable(target, {
      checks: ['hit-test'],
      timeoutMs: 100,
      position: { x: 5, y: 5 },
    });
    expect(r.ok).toBe(true);
    expect(efp).toHaveBeenCalledWith(5, 5);
  });
});

describe('actionability: scrollIntoView pre-check', () => {
  it('triggers scrollIntoView when the element is off-viewport', async () => {
    const api = loadActionability();
    const el = document.createElement('button');
    document.body.appendChild(el);
    // Way below the viewport.
    stubRect(el, { x: 10, y: 10000, width: 100, height: 30 });
    const scroll = vi.fn();
    el.scrollIntoView = scroll;

    // Run with `force: true` so the suite is skipped — proves scrollIntoView
    // is called BEFORE the checks.
    await api.awaitActionable(el, { force: true, timeoutMs: 100 });
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it('skips scrollIntoView when the element is already in viewport', async () => {
    const api = loadActionability();
    const el = document.createElement('button');
    document.body.appendChild(el);
    stubRect(el, { x: 10, y: 10, width: 100, height: 30 });
    const scroll = vi.fn();
    el.scrollIntoView = scroll;
    await api.awaitActionable(el, { force: true, timeoutMs: 100 });
    expect(scroll).not.toHaveBeenCalled();
  });
});

describe('actionability: force bypass', () => {
  it('returns ok:true even when every check would fail', async () => {
    const api = loadActionability();
    const el = document.createElement('button');
    el.style.display = 'none';
    el.disabled = true;
    document.body.appendChild(el);
    stubRect(el, { x: 0, y: 0, width: 0, height: 0 });

    const r = await api.awaitActionable(el, {
      force: true,
      checks: api.ALL_CHECKS,
      timeoutMs: 100,
    });
    expect(r.ok).toBe(true);
  });
});

describe('actionability: timeout window', () => {
  it('eventually passes when an occluder is removed before the deadline', async () => {
    const api = loadActionability();
    const target = document.createElement('button');
    document.body.appendChild(target);
    stubRect(target, { x: 10, y: 10, width: 100, height: 30 });

    const overlay = document.createElement('div');
    overlay.id = 'banner';
    document.body.appendChild(overlay);

    let resolved = overlay as Element;
    document.elementFromPoint = vi.fn(() => resolved);

    // Remove the overlay after 100ms — well inside the 1s timeout.
    setTimeout(() => {
      resolved = target;
    }, 100);

    const r = await api.awaitActionable(target, {
      checks: ['hit-test'],
      timeoutMs: 1000,
    });
    expect(r.ok).toBe(true);
  });

  it('returns the latest failures after the deadline elapses', async () => {
    const api = loadActionability();
    const el = document.createElement('button');
    el.disabled = true;
    document.body.appendChild(el);
    stubRect(el, { x: 10, y: 10, width: 100, height: 30 });
    const start = Date.now();
    const r = await api.awaitActionable(el, { checks: ['enabled'], timeoutMs: 120 });
    const elapsed = Date.now() - start;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failures).toContain('disabled');
    // Sanity check — we waited at least roughly the configured timeout.
    expect(elapsed).toBeGreaterThanOrEqual(100);
  });
});

describe('actionability: combined matrix (click default)', () => {
  it('passes when all checks pass', async () => {
    const api = loadActionability();
    const el = document.createElement('button');
    document.body.appendChild(el);
    stubRect(el, { x: 10, y: 10, width: 100, height: 30 });
    document.elementFromPoint = vi.fn(() => el);
    const r = await api.awaitActionable(el, {
      checks: ['visible', 'stable', 'enabled', 'hit-test'],
      timeoutMs: 500,
    });
    expect(r.ok).toBe(true);
  });

  it('surfaces the first failing check (visible) without evaluating stable/hit-test', async () => {
    const api = loadActionability();
    const el = document.createElement('button');
    el.style.display = 'none';
    document.body.appendChild(el);
    stubRect(el, { x: 10, y: 10, width: 100, height: 30 });

    const r = await api.awaitActionable(el, {
      checks: ['visible', 'stable', 'enabled', 'hit-test'],
      timeoutMs: 100,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failures).toContain('not_visible');
      // stable + hit-test gated behind visible+enabled passing — should be
      // absent from the failure list.
      expect(r.failures.find((f) => f === 'unstable_bbox')).toBeUndefined();
      expect(r.failures.find((f) => f.startsWith('occluded_by:'))).toBeUndefined();
    }
  });
});

describe('actionability: installActionabilityForTest seeder', () => {
  it('exposes the API on a target window', () => {
    loadActionability();

    const installer = (window as any).installActionabilityForTest as (
      target?: Window,
    ) => ActionabilityApi;
    expect(typeof installer).toBe('function');

    const other: any = { __actionability: undefined };
    const api = installer(other as Window);
    expect(other.__actionability).toBe(api);
    expect(typeof api.awaitActionable).toBe('function');
    expect(Array.isArray(api.ALL_CHECKS)).toBe(true);
  });
});
