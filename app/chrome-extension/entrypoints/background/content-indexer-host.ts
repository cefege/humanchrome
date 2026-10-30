import { INDEXER_HOST_MESSAGES } from '@/common/content-indexer-messages';
import { MessageTarget, TOOL_MESSAGE_TYPES } from '@/common/message-types';

type IndexerHostRequestType = (typeof INDEXER_HOST_MESSAGES)[keyof Pick<
  typeof INDEXER_HOST_MESSAGES,
  | 'GET_MODEL_SETTINGS'
  | 'GET_TAB'
  | 'EXTRACT_TAB_CONTENT'
  | 'GET_VECTOR_METADATA'
  | 'SET_VECTOR_METADATA'
  | 'REMOVE_VECTOR_METADATA'
>];

interface IndexerHostRequest {
  target?: unknown;
  type?: unknown;
  tabId?: number;
  key?: unknown;
  keys?: unknown;
  value?: unknown;
}

type IndexerHostResponse = { success: true; result: unknown } | { success: false; error: string };

const VECTOR_METADATA_PREFIX = 'hnswlib_document_mappings_';
const VECTOR_METADATA_KEYS = new Set([
  `${VECTOR_METADATA_PREFIX}tab_content_index.dat`,
  `${VECTOR_METADATA_PREFIX}content_index.dat`,
  `${VECTOR_METADATA_PREFIX}vector_index.dat`,
]);

function isVectorMetadataKey(key: unknown): key is string {
  return (
    typeof key === 'string' &&
    key.startsWith(VECTOR_METADATA_PREFIX) &&
    VECTOR_METADATA_KEYS.has(key)
  );
}

function requireVectorMetadataKey(key: unknown): string {
  if (!isVectorMetadataKey(key)) {
    throw new Error('Invalid vector metadata key');
  }
  return key;
}

function requireVectorMetadataKeys(keys: unknown): string[] {
  if (!Array.isArray(keys) || !keys.every(isVectorMetadataKey)) {
    throw new Error('Invalid vector metadata keys');
  }
  return keys;
}

function isIndexerHostRequest(message: unknown): message is IndexerHostRequest {
  if (!message || typeof message !== 'object') return false;

  const { target, type } = message as IndexerHostRequest;
  return (
    target === MessageTarget.Background &&
    (type === INDEXER_HOST_MESSAGES.GET_MODEL_SETTINGS ||
      type === INDEXER_HOST_MESSAGES.GET_TAB ||
      type === INDEXER_HOST_MESSAGES.EXTRACT_TAB_CONTENT ||
      type === INDEXER_HOST_MESSAGES.GET_VECTOR_METADATA ||
      type === INDEXER_HOST_MESSAGES.SET_VECTOR_METADATA ||
      type === INDEXER_HOST_MESSAGES.REMOVE_VECTOR_METADATA)
  );
}

function isOffscreenSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('offscreen.html');
}

async function getModelSettings(): Promise<{ selectedModel?: unknown; selectedVersion?: unknown }> {
  const stored = await chrome.storage.local.get(['selectedModel', 'selectedVersion']);
  const settings: { selectedModel?: unknown; selectedVersion?: unknown } = {};

  if (Object.prototype.hasOwnProperty.call(stored, 'selectedModel')) {
    settings.selectedModel = stored.selectedModel;
  }
  if (Object.prototype.hasOwnProperty.call(stored, 'selectedVersion')) {
    settings.selectedVersion = stored.selectedVersion;
  }

  return settings;
}

async function getVectorMetadata(key: unknown): Promise<{ value?: unknown }> {
  const storedKey = requireVectorMetadataKey(key);
  const stored = await chrome.storage.local.get(storedKey);

  return Object.prototype.hasOwnProperty.call(stored, storedKey)
    ? { value: stored[storedKey] }
    : {};
}

async function setVectorMetadata(key: unknown, value: unknown): Promise<void> {
  const storedKey = requireVectorMetadataKey(key);
  await chrome.storage.local.set({ [storedKey]: value });
}

async function removeVectorMetadata(keys: unknown): Promise<void> {
  await chrome.storage.local.remove(requireVectorMetadataKeys(keys));
}

async function extractTabContent(
  tabId: number,
): Promise<{ textContent: string; title: string } | null> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      files: ['inject-scripts/web-fetcher-helper.js'],
    });

    const response = await chrome.tabs.sendMessage(
      tabId,
      { action: TOOL_MESSAGE_TYPES.WEB_FETCHER_GET_TEXT_CONTENT },
      { frameId: 0 },
    );

    if (response.success && response.textContent) {
      return {
        textContent: response.textContent,
        title: response.title || '',
      };
    }
  } catch {
    // ContentIndexer historically treats failed injection and extraction as no content.
  }

  return null;
}

async function handleIndexerHostRequest(message: IndexerHostRequest): Promise<unknown> {
  switch (message.type as IndexerHostRequestType) {
    case INDEXER_HOST_MESSAGES.GET_MODEL_SETTINGS:
      return await getModelSettings();
    case INDEXER_HOST_MESSAGES.GET_TAB:
      return await chrome.tabs.get(message.tabId as number);
    case INDEXER_HOST_MESSAGES.EXTRACT_TAB_CONTENT:
      return await extractTabContent(message.tabId as number);
    case INDEXER_HOST_MESSAGES.GET_VECTOR_METADATA:
      return await getVectorMetadata(message.key);
    case INDEXER_HOST_MESSAGES.SET_VECTOR_METADATA:
      return await setVectorMetadata(message.key, message.value);
    case INDEXER_HOST_MESSAGES.REMOVE_VECTOR_METADATA:
      return await removeVectorMetadata(message.keys);
  }
}

async function hasOffscreenDocument(): Promise<boolean> {
  try {
    const contexts = await (
      chrome.runtime as typeof chrome.runtime & {
        getContexts: (filter: { contextTypes: string[] }) => Promise<unknown[]>;
      }
    ).getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return contexts.length > 0;
  } catch {
    return false;
  }
}

async function forwardToOffscreenIfPresent(message: Record<string, unknown>): Promise<void> {
  if (!(await hasOffscreenDocument())) return;

  await chrome.runtime.sendMessage(message).catch(() => undefined);
}

/**
 * Registers the service-worker half of the content-indexer host boundary.
 * Chrome-only effects belong here; the offscreen document owns index policy and inference.
 */
export function initContentIndexerHost(): void {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isIndexerHostRequest(message)) return false;

    if (!isOffscreenSender(sender)) {
      sendResponse({
        success: false,
        error: 'Content indexer host requests require the offscreen document',
      } satisfies IndexerHostResponse);
      return false;
    }

    handleIndexerHostRequest(message)
      .then((result) => sendResponse({ success: true, result } satisfies IndexerHostResponse))
      .catch((error) =>
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        } satisfies IndexerHostResponse),
      );
    return true;
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    void forwardToOffscreenIfPresent({
      target: MessageTarget.Offscreen,
      type: INDEXER_HOST_MESSAGES.TAB_UPDATED,
      tabId,
      changeInfo,
      tab,
    });
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    void forwardToOffscreenIfPresent({
      target: MessageTarget.Offscreen,
      type: INDEXER_HOST_MESSAGES.TAB_REMOVED,
      tabId,
    });
  });

  chrome.webNavigation.onCommitted.addListener((details) => {
    void forwardToOffscreenIfPresent({
      target: MessageTarget.Offscreen,
      type: INDEXER_HOST_MESSAGES.NAVIGATION_COMMITTED,
      details,
    });
  });
}
