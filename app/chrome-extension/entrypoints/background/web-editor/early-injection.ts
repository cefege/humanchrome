/**
 * Web-editor "early injection" registration.
 *
 * Registers the props-agent content script for `document_start` injection
 * in the MAIN world on a per-host basis, persisting across browser
 * sessions. Document-start is the only timing that lets us hook the React
 * DevTools `__REACT_DEVTOOLS_GLOBAL_HOOK__` before React initialises and
 * patches it; that hook is the source of the debugSource info the prompt
 * builder relies on for high-confidence file/line resolution.
 *
 * The registration is idempotent: if a script with the per-host id is
 * already registered (typical when the user re-enables the editor on the
 * same site), we keep the existing registration rather than re-register.
 */

const PROPS_AGENT_SCRIPT_PATH = 'inject-scripts/props-agent.js';

/**
 * Content script ID prefix for early injection (document_start).
 * Registered scripts persist across sessions and survive browser restarts.
 */
const PROPS_AGENT_EARLY_INJECTION_ID_PREFIX = 'mcp_we_props_early';

/**
 * Result of early injection registration. `alreadyRegistered=true` means
 * the per-host script was already in place before we tried — no native
 * registration call was made this invocation.
 */
export interface EarlyInjectionResult {
  id: string;
  host: string;
  matches: string[];
  alreadyRegistered: boolean;
}

/**
 * Sanitise a string for use in a content script ID. Allows only
 * alphanumeric, underscore, and hyphen; collapses runs of other
 * characters to a single underscore; caps length at 80; falls back to
 * "site" if the input is empty after cleaning.
 */
function sanitizeContentScriptId(input: string): string {
  const cleaned = String(input ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned.slice(0, 80) || 'site';
}

/**
 * Build match patterns for a tab URL: the host's pages over both
 * http/https. We deliberately scope to one host rather than matching all
 * URLs to keep the registered script list small and avoid injecting
 * unnecessarily.
 */
function buildEarlyInjectionPatterns(tabUrl: string): { host: string; matches: string[] } {
  let url: URL;
  try {
    url = new URL(tabUrl);
  } catch {
    throw new Error('Invalid tab URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Early injection only supports http/https pages (got ${url.protocol})`);
  }

  const host = url.hostname.trim();
  if (!host) {
    throw new Error('Unable to derive host from tab URL');
  }

  return { host, matches: [`*://${host}/*`] };
}

/**
 * Register props agent for early injection (document_start, MAIN world).
 *
 * This is what allows capturing the React DevTools hook before React
 * initialises. Per-host registration; persists across sessions.
 */
export async function registerPropsAgentEarlyInjection(
  tabUrl: string,
): Promise<EarlyInjectionResult> {
  const { host, matches } = buildEarlyInjectionPatterns(tabUrl);
  const id = `${PROPS_AGENT_EARLY_INJECTION_ID_PREFIX}_${sanitizeContentScriptId(host)}`;

  let alreadyRegistered = false;
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
    alreadyRegistered = existing.some((s) => s.id === id);
  } catch {
    // API might not be supported in all contexts (older Chrome / test).
    alreadyRegistered = false;
  }

  if (!alreadyRegistered) {
    await chrome.scripting.registerContentScripts([
      {
        id,
        js: [PROPS_AGENT_SCRIPT_PATH],
        matches,
        runAt: 'document_start',
        world: 'MAIN',
        allFrames: false,
        persistAcrossSessions: true,
      },
    ]);
    console.log(`[WebEditorV2] Registered early injection for ${host}`);
  }

  return { id, host, matches, alreadyRegistered };
}
