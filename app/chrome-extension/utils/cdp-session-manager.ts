import { TOOL_NAMES } from 'humanchrome-shared';

type OwnerTag = string;

interface TabSessionState {
  refCount: number;
  owners: Set<OwnerTag>;
  attachedByUs: boolean;
}

const DEBUGGER_PROTOCOL_VERSION = '1.3';

// Per-CDP-command timeout. Chrome doesn't surface DevTools-attached state
// reliably via getTargets(), so a hung sendCommand is the canonical
// "DevTools is fighting us" symptom. 10s matches the per-tab JS lock
// timeout — keeping them aligned avoids confusing dual-timeout reports.
const CDP_SEND_TIMEOUT_MS = 10_000;

// Chrome's onDetach reason strings for the cases we care about.
// `target_closed` fires when the tab itself closes; `replaced_with_devtools`
// fires when the user opens DevTools on a tab the extension was driving.
type DetachReason = 'target_closed' | 'canceled_by_user' | 'replaced_with_devtools' | string;

class CDPSessionManager {
  private sessions = new Map<number, TabSessionState>();
  // Last reason Chrome detached us from a tab; used to give a precise error
  // message on the next attach (e.g., "DevTools is open on this tab").
  private lastDetachReason = new Map<number, DetachReason>();
  private detachListenerInstalled = false;

  constructor() {
    this.installDetachListener();
  }

  private installDetachListener() {
    if (this.detachListenerInstalled) return;
    if (typeof chrome === 'undefined' || !chrome.debugger?.onDetach?.addListener) return;
    chrome.debugger.onDetach.addListener((source, reason) => {
      const tabId = source.tabId;
      if (typeof tabId !== 'number') return;
      // Chrome forcibly detached us. Drop our cached state so the next
      // attach attempt is a clean reattach (or fails clearly).
      this.sessions.delete(tabId);
      this.lastDetachReason.set(tabId, reason as DetachReason);
    });
    this.detachListenerInstalled = true;
  }

  private getState(tabId: number): TabSessionState | undefined {
    return this.sessions.get(tabId);
  }

  private setState(tabId: number, state: TabSessionState) {
    this.sessions.set(tabId, state);
  }

  /**
   * Distinguish the three real attach-blocked cases so the caller sees an
   * actionable message instead of generic "DevTools appears to be
   * attached":
   *   1. The user really opened Chrome DevTools on this tab — Chrome
   *      emits `replaced_with_devtools` on detach. Only case where the
   *      "open DevTools panel" wording is correct.
   *   2. The bridge's own prior CDP session was never released cleanly
   *      (race after `detach`, SW restart leaving a stale registration,
   *      etc). Handled by `attach()` directly via defensive
   *      detach-and-retry; this error is only thrown if even that fails.
   *   3. Another CDP client (different extension, another humanchrome
   *      bridge instance, a remote debugger session) holds the tab.
   */
  private devtoolsPanelError(tabId: number): Error {
    return new Error(
      `Chrome DevTools is open on tab ${tabId}. Close the DevTools panel on that tab ` +
        `(Cmd+Option+I on macOS, F12 on Windows/Linux), then retry.`,
    );
  }

  private foreignClientError(tabId: number, raw?: unknown): Error {
    const rawMsg = raw instanceof Error ? raw.message : raw ? String(raw) : '';
    const suffix = rawMsg ? ` (raw: ${rawMsg})` : '';
    return new Error(
      `Another CDP client is attached to tab ${tabId} — could be Chrome DevTools, ` +
        `another extension, or another humanchrome bridge instance. Close DevTools or ` +
        `disconnect the other client, then retry.${suffix}`,
    );
  }

  /**
   * Error for `sendCommand` timeouts. If we have evidence DevTools is
   * involved (Chrome already detached us with `replaced_with_devtools`),
   * surface that. Otherwise treat the timeout as a slow-page signal and
   * tell the caller (LLM) it can retry with a higher `timeoutMs` — the
   * default 10s is conservative; legitimate work on heavy pages can
   * exceed it.
   */
  private timeoutErrorFor(tabId: number, method: string, timeoutMs: number): Error {
    if (this.lastDetachReason.get(tabId) === 'replaced_with_devtools') {
      return this.devtoolsPanelError(tabId);
    }
    return new Error(
      `CDP command "${method}" on tab ${tabId} did not return within ${timeoutMs}ms. ` +
        `If the page is legitimately slow, retry with a higher timeoutMs (max 120000). ` +
        `If this keeps happening, Chrome DevTools may be open on that tab — close it and retry.`,
    );
  }

  async attach(tabId: number, owner: OwnerTag = 'unknown'): Promise<void> {
    const state = this.getState(tabId);
    if (state && state.attachedByUs) {
      state.refCount += 1;
      state.owners.add(owner);
      return;
    }

    // If the previous session was forcibly detached because DevTools
    // opened, fail fast with a precise message instead of attempting an
    // attach that will hang or throw an opaque error.
    const lastReason = this.lastDetachReason.get(tabId);
    if (lastReason === 'replaced_with_devtools') {
      throw this.devtoolsPanelError(tabId);
    }

    // Check existing attachments. NOTE: for `type: 'tab'` targets the
    // `extensionId` field identifies the BEING-DEBUGGED extension (always
    // undefined for tabs), NOT the attaching client. So we can't tell
    // from getTargets() alone whether we or a foreign client own the
    // existing attachment. Strategy: attempt `chrome.debugger.detach` —
    // it only releases sessions owned by THIS extension, so success
    // means it was ours (stale from a prior SW lifecycle) and we can
    // re-attach cleanly; failure means a foreign client holds it.
    const targets = await chrome.debugger.getTargets();
    const existing = targets.find((t) => t.tabId === tabId && t.attached);
    if (existing) {
      // First, check if we already have live cached state for this tab —
      // means a prior tool in the same SW lifecycle is using it. Adopt.
      if (state?.attachedByUs) {
        this.setState(tabId, {
          refCount: state.refCount + 1,
          owners: new Set([...state.owners, owner]),
          attachedByUs: true,
        });
        return;
      }
      // No cached state but Chrome shows attached → either our own stale
      // session (SW restart, dropped state) or a foreign client. Try a
      // defensive detach; if it succeeds, we owned it.
      let releasedOurs = false;
      try {
        await chrome.debugger.detach({ tabId });
        releasedOurs = true;
      } catch {
        // Not our session; do not throw yet — fall through and let the
        // attach attempt below give Chrome's authoritative answer.
      }
      try {
        await chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION);
        this.lastDetachReason.delete(tabId);
        this.setState(tabId, { refCount: 1, owners: new Set([owner]), attachedByUs: true });
        return;
      } catch (attachErr) {
        // Attach failed too. If we managed to detach, the foreign client
        // re-attached in the race window — surface as foreign. If we
        // didn't detach, also foreign. Either way: foreignClientError.
        void releasedOurs; // silence unused-var; kept for future telemetry
        throw this.foreignClientError(tabId, attachErr);
      }
    }

    // Fresh attach. Chrome occasionally throws "Another debugger is
    // already attached" even when getTargets() shows no entry — that's
    // the bridge's own stale registration (race after a prior detach, or
    // SW restart leaving Chrome holding our name). Defensively detach
    // and retry once before treating the slot as foreign-owned.
    try {
      await chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION);
    } catch (e) {
      const rawMsg = e instanceof Error ? e.message : String(e ?? '');
      const looksAlreadyAttached = /already attached|another (debugger|client)/i.test(rawMsg);
      if (!looksAlreadyAttached) {
        throw e instanceof Error
          ? e
          : new Error(rawMsg || `Debugger attach failed for tab ${tabId}`);
      }
      try {
        await chrome.debugger.detach({ tabId });
      } catch {
        // Not attached or already released — fine. `chrome.debugger.detach`
        // only releases sessions owned by THIS extension, so it can never
        // disturb a third-party CDP client.
      }
      try {
        await chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION);
      } catch (retryErr) {
        throw this.foreignClientError(tabId, retryErr);
      }
    }
    // Successful fresh attach: clear any stale detach reason from a prior
    // DevTools session that has since been closed.
    this.lastDetachReason.delete(tabId);
    this.setState(tabId, { refCount: 1, owners: new Set([owner]), attachedByUs: true });
  }

  async detach(tabId: number, owner: OwnerTag = 'unknown'): Promise<void> {
    const state = this.getState(tabId);
    if (!state) return; // Nothing to do

    // Update ownership/refcount
    if (state.owners.has(owner)) state.owners.delete(owner);
    state.refCount = Math.max(0, state.refCount - 1);

    if (state.refCount > 0) {
      // Still in use by other owners
      return;
    }

    // We are the last owner
    try {
      if (state.attachedByUs) {
        await chrome.debugger.detach({ tabId });
      }
    } catch (e) {
      // Best-effort detach; ignore
    } finally {
      this.sessions.delete(tabId);
    }
  }

  /**
   * Convenience wrapper: ensures attach before fn, and balanced detach after.
   */
  async withSession<T>(tabId: number, owner: OwnerTag, fn: () => Promise<T>): Promise<T> {
    await this.attach(tabId, owner);
    try {
      return await fn();
    } finally {
      await this.detach(tabId, owner);
    }
  }

  /**
   * Send a CDP command with a hard timeout. If the call hangs past the
   * timeout (the canonical "DevTools is silently competing for the
   * protocol session" symptom), throw a precise error and clear cached
   * state so the next call re-checks the tab from scratch.
   */
  async sendCommand<T = any>(
    tabId: number,
    method: string,
    params?: object,
    timeoutMs: number = CDP_SEND_TIMEOUT_MS,
  ): Promise<T> {
    const state = this.getState(tabId);
    const attached = !!state && state.attachedByUs;

    const send = async (): Promise<T> => {
      if (attached) {
        return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T;
      }
      return await this.withSession<T>(tabId, `send:${method}`, async () => {
        return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T;
      });
    };

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(this.timeoutErrorFor(tabId, method, timeoutMs));
      }, timeoutMs);
    });

    try {
      return await Promise.race([send(), timeoutPromise]);
    } catch (e) {
      // The timeout path almost always means DevTools is fighting us.
      // Drop cached state so the next attempt sees a clean slate.
      this.sessions.delete(tabId);
      throw e;
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  }
}

export const cdpSessionManager = new CDPSessionManager();
