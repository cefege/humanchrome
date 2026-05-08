/**
 * Web-editor lifecycle: editor / props-agent injection, version selection,
 * context-menu wiring, and the toggle entry point.
 *
 * The web editor exists as v1 (legacy IIFE inject-script) and v2 (WXT
 * unlisted TypeScript bundle) — `USE_WEB_EDITOR_V2` selects which set of
 * scripts and `WEB_EDITOR_V?_ACTIONS` constants are wired up. Each
 * version uses a distinct ping/toggle action name so a tab that already
 * has one version injected won't respond to the other's pings.
 *
 * `toggleEditorInTab(tabId)` is the canonical entry point: ensures the
 * editor script is present, dispatches the version-correct TOGGLE
 * action, and on a successful ON/OFF transition it injects or cleans up
 * the props agent (the MAIN-world helper that the v2 editor relies on
 * for React/Vue debugSource extraction).
 */

import { WEB_EDITOR_V1_ACTIONS, WEB_EDITOR_V2_ACTIONS } from '@/common/web-editor-types';

export const CONTEXT_MENU_ID = 'web_editor_toggle';

/**
 * Web Editor version configuration
 * - v1: Legacy inject-scripts/web-editor.js (IIFE, ~850 lines)
 * - v2: New TypeScript-based web-editor-v2.js (WXT unlisted script)
 *
 * Set USE_WEB_EDITOR_V2 to true to enable v2.
 * This flag allows gradual rollout and easy rollback.
 */
const USE_WEB_EDITOR_V2 = true;

/** Script path for v1 (legacy). */
const V1_SCRIPT_PATH = 'inject-scripts/web-editor.js';

/** Script path for v2 (WXT unlisted script output). */
const V2_SCRIPT_PATH = 'web-editor-v2.js';

/** Script path for Phase 7 props agent (MAIN world). */
const PROPS_AGENT_SCRIPT_PATH = 'inject-scripts/props-agent.js';

/**
 * Get the appropriate action constants based on which editor version is
 * active. v1 and v2 use different action names to avoid conflicts (e.g.,
 * `web_editor_ping` vs `web_editor_ping_v2`) so a stale v1 instance and
 * a fresh v2 inject don't trample each other's messages.
 */
export function getActions() {
  return USE_WEB_EDITOR_V2 ? WEB_EDITOR_V2_ACTIONS : WEB_EDITOR_V1_ACTIONS;
}

/**
 * Make sure the toggle context menu entry exists. Idempotent — removes
 * any prior entry with the same ID first so a service-worker restart
 * doesn't accumulate duplicates.
 */
export async function ensureContextMenu(): Promise<void> {
  try {
    if (!(chrome as unknown as { contextMenus?: { create?: unknown } }).contextMenus?.create)
      return;
    try {
      await chrome.contextMenus.remove(CONTEXT_MENU_ID);
    } catch {}
    await chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: 'Toggle web edit mode',
      contexts: ['all'],
    });
  } catch (error) {
    console.warn('[WebEditor] Failed to ensure context menu:', error);
  }
}

/**
 * Ensure the web editor script (v1 or v2) is injected into `tabId`.
 *
 * Pings the version-specific PING action first; if a `pong` comes back,
 * an instance is already running so we no-op. Otherwise we inject the
 * script in ISOLATED world. A failed inject is logged but not thrown —
 * some pages (chrome://, web store, PDF viewers) reject scripting and
 * the toggle path will surface a sensible UI error downstream.
 */
async function ensureEditorInjected(tabId: number): Promise<void> {
  const scriptPath = USE_WEB_EDITOR_V2 ? V2_SCRIPT_PATH : V1_SCRIPT_PATH;
  const logPrefix = USE_WEB_EDITOR_V2 ? '[WebEditorV2]' : '[WebEditor]';
  const actions = getActions();

  // Try to ping existing instance using version-specific action
  try {
    const pong: { status?: string; version?: number } = await chrome.tabs.sendMessage(
      tabId,
      { action: actions.PING },
      { frameId: 0 },
    );

    if (pong?.status === 'pong') {
      // Already injected with correct version
      return;
    }
  } catch {
    // No existing instance, fallthrough to inject
  }

  // Inject the script
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [scriptPath],
      world: 'ISOLATED',
    });
    console.log(`${logPrefix} Script injected successfully`);
  } catch (error) {
    console.warn(`${logPrefix} Failed to inject editor script:`, error);
  }
}

/**
 * Inject the props agent into MAIN world for v2 Props editing. v1 has
 * no props-agent path — short-circuits so legacy callers don't trip
 * the inject. Best-effort; pages that block scripting are skipped.
 */
async function ensurePropsAgentInjected(tabId: number): Promise<void> {
  if (!USE_WEB_EDITOR_V2) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [PROPS_AGENT_SCRIPT_PATH],
      world: 'MAIN',
    });
  } catch (error) {
    // Best-effort: some pages (chrome://, extensions, PDF) block injection
    console.warn('[WebEditorV2] Failed to inject props agent:', error);
  }
}

/**
 * Tell the props agent to clean itself up by dispatching a CustomEvent
 * from ISOLATED world. The event crosses worlds and is observed by the
 * MAIN-world props agent, which removes its hooks. Pages without a
 * props agent attached just receive an event with no listeners.
 */
async function sendPropsAgentCleanup(tabId: number): Promise<void> {
  if (!USE_WEB_EDITOR_V2) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        try {
          window.dispatchEvent(new CustomEvent('web-editor-props:cleanup'));
        } catch {
          // ignore
        }
      },
      world: 'ISOLATED',
    });
  } catch (error) {
    // Best-effort cleanup; ignore failures if tab is gone or injection blocked
    console.warn('[WebEditorV2] Failed to send props agent cleanup:', error);
  }
}

/**
 * Toggle the editor in `tabId`. Ensures the editor script is injected,
 * dispatches the version-correct TOGGLE action, and pairs it with a
 * props-agent inject (on activation) or cleanup (on deactivation).
 * Returns the new active state from the editor's response, or `{}` on
 * failure (the caller treats this as "unknown").
 */
export async function toggleEditorInTab(tabId: number): Promise<{ active?: boolean }> {
  await ensureEditorInjected(tabId);
  const logPrefix = USE_WEB_EDITOR_V2 ? '[WebEditorV2]' : '[WebEditor]';
  const actions = getActions();

  try {
    const resp: { active?: boolean } = await chrome.tabs.sendMessage(
      tabId,
      { action: actions.TOGGLE },
      { frameId: 0 },
    );
    const active = typeof resp?.active === 'boolean' ? resp.active : undefined;

    // Phase 7: Inject props agent on start; cleanup on stop
    if (active === true) {
      await ensurePropsAgentInjected(tabId);
    } else if (active === false) {
      await sendPropsAgentCleanup(tabId);
    }

    return { active };
  } catch (error) {
    console.warn(`${logPrefix} Failed to toggle editor in tab:`, error);
    return {};
  }
}

/**
 * Best-effort lookup of the currently active tab's id, scoped to the
 * current window. Returns null when no active tab is queryable
 * (offscreen contexts, service-worker startup before any focus event,
 * etc.); callers should treat null as "skip".
 */
export async function getActiveTabId(): Promise<number | null> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs?.[0]?.id;
    return typeof tabId === 'number' ? tabId : null;
  } catch {
    return null;
  }
}
