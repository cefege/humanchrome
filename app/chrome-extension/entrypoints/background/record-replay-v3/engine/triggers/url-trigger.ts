/**
 * @fileoverview URL Trigger Handler (P4-03)
 * @description
 * Listens to `chrome.webNavigation.onCompleted` and fires installed URL triggers.
 *
 * URL matching semantics:
 * - kind:'url' - Full URL prefix match (allows query/hash variations)
 * - kind:'domain' - Safe subdomain match (hostname === domain OR hostname.endsWith('.' + domain))
 * - kind:'path' - Pathname prefix match
 *
 * Design rationale:
 * - No regex/wildcards for performance and auditability
 * - Domain matching uses safe subdomain logic to avoid false positives (e.g. 'notexample.com')
 * - Single listener instance manages multiple triggers efficiently
 */

import { workflowPolicy } from 'humanchrome-shared';
import type { TriggerId } from '../../domain/ids';
import type { TriggerSpecByKind } from '../../domain/triggers';
import type { TriggerFireCallback, TriggerHandler, TriggerHandlerFactory } from './trigger-handler';

// ==================== Types ====================

export interface UrlTriggerHandlerDeps {
  logger?: Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;
}

type UrlTriggerSpec = TriggerSpecByKind<'url'>;

interface InstalledUrlTrigger {
  spec: UrlTriggerSpec;
  rules: workflowPolicy.RustWorkflowUrlRules;
}

// ==================== Handler Implementation ====================

/**
 * Create URL trigger handler factory
 */
export function createUrlTriggerHandlerFactory(
  deps?: UrlTriggerHandlerDeps,
): TriggerHandlerFactory<'url'> {
  return (fireCallback) => createUrlTriggerHandler(fireCallback, deps);
}

/**
 * Create URL trigger handler
 */
export function createUrlTriggerHandler(
  fireCallback: TriggerFireCallback,
  deps?: UrlTriggerHandlerDeps,
): TriggerHandler<'url'> {
  const logger = deps?.logger ?? console;

  const installed = new Map<TriggerId, InstalledUrlTrigger>();
  let listening = false;

  /**
   * Handle webNavigation.onCompleted event
   */
  const onCompleted = (details: chrome.webNavigation.WebNavigationFramedCallbackDetails): void => {
    // Only handle main frame navigations
    if (details.frameId !== 0) return;

    const urlString = details.url;


    if (installed.size === 0) return;

    // Snapshot to avoid iteration hazards during concurrent install/uninstall
    const snapshot = Array.from(installed.entries());

    for (const [triggerId, trigger] of snapshot) {
      if (!trigger.rules.matches(urlString)) continue;

      // Fire and forget: chrome event listeners should not block navigation
      Promise.resolve(
        fireCallback.onFire(triggerId, {
          sourceTabId: details.tabId,
          sourceUrl: urlString,
        }),
      ).catch((e) => {
        logger.error(`[UrlTriggerHandler] onFire failed for trigger "${triggerId}":`, e);
      });
    }
  };

  /**
   * Ensure listener is registered
   */
  function ensureListening(): void {
    if (listening) return;
    if (!chrome.webNavigation?.onCompleted?.addListener) {
      logger.warn('[UrlTriggerHandler] chrome.webNavigation.onCompleted is unavailable');
      return;
    }
    chrome.webNavigation.onCompleted.addListener(onCompleted);
    listening = true;
  }

  /**
   * Stop listening
   */
  function stopListening(): void {
    if (!listening) return;
    try {
      chrome.webNavigation.onCompleted.removeListener(onCompleted);
    } catch (e) {
      logger.debug('[UrlTriggerHandler] removeListener failed:', e);
    } finally {
      listening = false;
    }
  }

  return {
    kind: 'url',

    async install(trigger: UrlTriggerSpec): Promise<void> {
      installed.set(trigger.id, {
        spec: trigger,
        rules: new workflowPolicy.RustWorkflowUrlRules(trigger.match),
      });
      ensureListening();
    },

    async uninstall(triggerId: string): Promise<void> {
      installed.delete(triggerId as TriggerId);
      if (installed.size === 0) {
        stopListening();
      }
    },

    async uninstallAll(): Promise<void> {
      installed.clear();
      stopListening();
    },

    getInstalledIds(): string[] {
      return Array.from(installed.keys());
    },
  };
}
