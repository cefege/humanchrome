// Chrome effects stay in the service worker; indexing and inference stay offscreen.
export const INDEXER_HOST_MESSAGES = {
  GET_MODEL_SETTINGS: 'contentIndexerHostGetModelSettings',
  GET_TAB: 'contentIndexerHostGetTab',
  EXTRACT_TAB_CONTENT: 'contentIndexerHostExtractTabContent',
  GET_VECTOR_METADATA: 'contentIndexerHostGetVectorMetadata',
  SET_VECTOR_METADATA: 'contentIndexerHostSetVectorMetadata',
  REMOVE_VECTOR_METADATA: 'contentIndexerHostRemoveVectorMetadata',
  TAB_UPDATED: 'contentIndexerTabUpdated',
  TAB_REMOVED: 'contentIndexerTabRemoved',
  NAVIGATION_COMMITTED: 'contentIndexerNavigationCommitted',
} as const;
