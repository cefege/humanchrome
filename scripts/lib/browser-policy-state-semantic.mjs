import assert from 'node:assert/strict';

const OFFSCREEN = Object.freeze({
  INDEX_TAB: 'contentIndexerIndexTab',
  REINITIALIZE: 'contentIndexerReinitialize',
  SEARCH: 'contentIndexerSearch',
  START_INIT: 'contentIndexerStartInit',
  STATUS: 'contentIndexerStatus',
  STATS: 'contentIndexerStats',
});

const ENGINE_INIT = 'initialize_semantic_engine';
const OWNERSHIP_ALIAS = 'rustpolicy';
const SEMANTIC_CLIENTS = Object.freeze({
  astronomy: 'rust-semantic-astronomy',
  baking: 'rust-semantic-baking',
});
const OWNERSHIP_CLIENTS = Object.freeze({
  primary: 'rust-ownership-primary',
  secondary: 'rust-ownership-secondary',
  released: 'rust-ownership-release',
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function json(value) {
  return JSON.stringify(value);
}

function fixtureUrl(driver, document, marker) {
  const url = new URL('rust-semantic-policy.html', driver.fixtureUrl);
  url.searchParams.set('document', document);
  if (marker) url.searchParams.set('scenario', marker);
  return url.toString();
}

function parsedToolResult(result, label) {
  assert.equal(result?.isError, false, `${label} failed: ${json(result)}`);
  assert.notEqual(result?.parsed, undefined, `${label} returned non-JSON text: ${json(result)}`);
  return result.parsed;
}

function tabIdFrom(result, label) {
  const body = parsedToolResult(result, label);
  const tabId = body?.tabId ?? body?.tab?.id;
  assert.equal(typeof tabId, 'number', `${label} did not return a tabId: ${json(result)}`);
  return tabId;
}

async function rpc(driver, type, payload = {}, timeoutMs = 60_000) {
  const message = { target: 'offscreen', type, ...payload };
  const startedAt = Date.now();
  try {
    return await driver.evaluate(
      `
        (async () => {
          const response = await chrome.runtime.sendMessage(${json(message)});
          if (!response || response.success !== true) {
            throw new Error('Offscreen ${type} failed: ' + JSON.stringify(response));
          }
          return response.result;
        })()
      `,
      timeoutMs,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Offscreen ${type} RPC failed after ${Date.now() - startedAt}ms: ${message}`,
    );
  }
}

async function phase(label, operation) {
  const startedAt = Date.now();
  try {
    return await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} failed after ${Date.now() - startedAt}ms: ${message}`);
  }
}

async function modelState(driver) {
  return driver.evaluate(
    `
      (async () => {
        const stored = await chrome.storage.local.get('modelState');
        return stored.modelState ?? null;
      })()
    `,
    15_000,
  );
}

async function modelCacheEvidence(driver) {
  return driver.evaluate(
    `
      (async () => {
        try {
          const cache = await caches.open('onnx-model-cache-v1');
          const entries = await cache.keys();
          return {
            cacheNames: await caches.keys(),
            entryCount: entries.filter((entry) => !entry.url.startsWith('https://cache-metadata.local/')).length,
            urls: entries.map((entry) => entry.url),
          };
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
      })()
    `,
    15_000,
  );
}

async function persistenceEvidence(driver) {
  try {
    return await driver.evaluate(
      `
        (async () => {
          const timeoutMs = 5_000;
          const bounded = (promise, label) => new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(label + ' timed out after ' + timeoutMs + 'ms')), timeoutMs);
            Promise.resolve(promise).then(
              (value) => {
                clearTimeout(timer);
                resolve(value);
              },
              (error) => {
                clearTimeout(timer);
                reject(error);
              },
            );
          });
          const openExisting = (name) => new Promise((resolve, reject) => {
            let settled = false;
            const request = indexedDB.open(name);
            const timer = setTimeout(() => {
              settled = true;
              reject(new Error('opening ' + name + ' timed out after ' + timeoutMs + 'ms'));
            }, timeoutMs);
            request.onsuccess = () => {
              const db = request.result;
              if (settled) {
                db.close();
                return;
              }
              settled = true;
              clearTimeout(timer);
              resolve(db);
            };
            request.onerror = () => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              reject(request.error);
            };
          });
          const databaseNames = typeof indexedDB.databases === 'function'
            ? (await bounded(indexedDB.databases(), 'listing IndexedDB databases'))
                .map(({ name }) => name)
                .filter(Boolean)
            : [];
          const inspect = async (name, storeName, key) => {
            if (!databaseNames.includes(name)) return { databasePresent: false };
            try {
              const db = await openExisting(name);
              try {
                if (!db.objectStoreNames.contains(storeName)) {
                  return {
                    databasePresent: true,
                    stores: [...db.objectStoreNames],
                    storePresent: false,
                  };
                }
                const transaction = db.transaction(storeName, 'readonly');
                const store = transaction.objectStore(storeName);
                const request = key === undefined ? store.getAllKeys() : store.get(key);
                const value = await bounded(
                  new Promise((resolve, reject) => {
                    request.onsuccess = () => resolve(request.result);
                    request.onerror = () => reject(request.error);
                  }),
                  'reading ' + name + '/' + storeName,
                );
                if (key === undefined) {
                  return {
                    databasePresent: true,
                    stores: [...db.objectStoreNames],
                    storePresent: true,
                    keys: value.map(String),
                  };
                }
                const mapping = value?.data ?? value;
                return {
                  databasePresent: true,
                  stores: [...db.objectStoreNames],
                  storePresent: true,
                  recordPresent: value !== undefined,
                  recordWrapped: mapping !== value,
                  documentCount: Array.isArray(mapping?.documents) ? mapping.documents.length : null,
                  tabCount: Array.isArray(mapping?.tabDocuments) ? mapping.tabDocuments.length : null,
                  nextLabel: typeof mapping?.nextLabel === 'number' ? mapping.nextLabel : null,
                };
              } finally {
                db.close();
              }
            } catch (error) {
              return {
                databasePresent: true,
                error: error instanceof Error ? error.message : String(error),
              };
            }
          };
          return {
            databases: databaseNames,
            mappings: await inspect('VectorDatabaseStorage', 'documentMappings', 'tab_content_index.dat'),
            hnsw: await inspect('/hnswlib-index', 'FILE_DATA'),
          };
        })()
      `,
      15_000,
    );
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function initializeSemanticEngine(driver) {
  const startedAt = Date.now();
  let response;
  try {
    response = await driver.evaluate(
      `chrome.runtime.sendMessage({ type: ${json(ENGINE_INIT)} })`,
      115_000,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Semantic engine initialization RPC failed after ${Date.now() - startedAt}ms: ${message}`,
    );
  }
  assert.equal(
    response?.success,
    true,
    `Semantic engine initialization message failed: ${json(response)}`,
  );
}

async function waitForIndexer(driver, label, timeoutMs = 120_000) {
  const startedAt = Date.now();
  let lastStatus;
  let lastModelState;
  while (Date.now() - startedAt < timeoutMs) {
    lastStatus = await rpc(driver, OFFSCREEN.STATUS, {}, 15_000);
    lastModelState = await modelState(driver);
    if (lastModelState?.status === 'error') {
      throw new Error(
        `${label}: model initialization failed: ${json({
          modelState: lastModelState,
          indexerStatus: lastStatus,
          modelCache: await modelCacheEvidence(driver),
        })}`,
      );
    }
    if (lastStatus?.semanticEngineReady === true && lastStatus?.isInitialized === true) {
      return { status: lastStatus, modelState: lastModelState };
    }
    await delay(250);
  }
  throw new Error(
    `${label}: timed out waiting for real semantic engine/indexer readiness: ${json({
      modelState: lastModelState,
      indexerStatus: lastStatus,
      modelCache: await modelCacheEvidence(driver),
    })}`,
  );
}

async function prepareIndexer(driver, label, { reinitialize }) {
  await phase(`${label}: initialize semantic engine`, () => initializeSemanticEngine(driver));
  await phase(`${label}: start indexer`, () => rpc(driver, OFFSCREEN.START_INIT));
  await phase(`${label}: await initial indexer readiness`, () =>
    waitForIndexer(driver, `${label} initial startup`),
  );
  if (reinitialize) {
    await phase(`${label}: reinitialize corpus`, () => rpc(driver, OFFSCREEN.REINITIALIZE));
  }
  return phase(`${label}: await indexer readiness`, () =>
    waitForIndexer(driver, `${label} indexer readiness`),
  );
}

async function waitForCompleteTab(driver, tabId, expectedUrl) {
  const startedAt = Date.now();
  let tab;
  while (Date.now() - startedAt < 30_000) {
    tab = await driver.evaluate(`chrome.tabs.get(${tabId})`);
    if (tab?.status === 'complete' && tab?.url === expectedUrl) return tab;
    await delay(100);
  }
  throw new Error(`Tab ${tabId} did not complete the requested fixture navigation: ${json(tab)}`);
}

async function navigateOwnedFixture(driver, clientId, document, marker) {
  const url = fixtureUrl(driver, document, marker);
  const result = await driver.callTool(clientId, 'chrome_navigate', {
    url,
    newTab: true,
    background: true,
  });
  const tabId = tabIdFrom(result, `navigate ${document}`);
  await waitForCompleteTab(driver, tabId, url);
  return { tabId, url, result: result.parsed };
}

function resultProjection(results) {
  return results.map((result) => ({
    documentId: result.document?.id,
    tabId: result.document?.tabId,
    title: result.document?.title,
    distance: result.distance,
    similarity: result.similarity,
    snippet: result.document?.chunk?.text,
  }));
}

function assertSearchResults(results, expectedTabId, expectedTerms, label) {
  assert.ok(Array.isArray(results), `${label} did not return result rows: ${json(results)}`);
  assert.ok(results.length > 0, `${label} returned no semantic matches`);
  assert.equal(
    results[0]?.document?.tabId,
    expectedTabId,
    `${label} did not rank its fixture first: ${json(results)}`,
  );
  for (const result of results) {
    const document = result?.document;
    assert.equal(typeof document?.id, 'string', `${label} row has no document id: ${json(result)}`);
    assert.equal(typeof document?.tabId, 'number', `${label} row has no tabId: ${json(result)}`);
    assert.equal(typeof result.distance, 'number', `${label} row has no distance: ${json(result)}`);
    assert.ok(Number.isFinite(result.distance), `${label} distance is not finite: ${json(result)}`);
    assert.equal(typeof result.similarity, 'number', `${label} row has no similarity: ${json(result)}`);
    assert.ok(Number.isFinite(result.similarity), `${label} similarity is not finite: ${json(result)}`);
    assert.equal(typeof document?.chunk?.text, 'string', `${label} row has no chunk snippet: ${json(result)}`);
  }
  assert.match(
    results[0].document.chunk.text.toLowerCase(),
    expectedTerms,
    `${label} primary snippet does not contain fixture evidence: ${json(results[0])}`,
  );
}

async function waitForReleasedOwnership(driver, clientId) {
  const startedAt = Date.now();
  let result;
  while (Date.now() - startedAt < 15_000) {
    result = await driver.callTool(clientId, 'chrome_owned_tabs');
    const body = parsedToolResult(result, `ownership after releasing ${clientId}`);
    if (body.count === 0 && Array.isArray(body.ownedTabs) && body.ownedTabs.length === 0)
      return body;
    await delay(100);
  }
  throw new Error(`Released client still owns tabs: ${json(result)}`);
}

export async function runSemanticScenario(driver) {
  const readiness = await phase('semantic scenario: prepare indexer', () =>
    prepareIndexer(driver, 'semantic scenario', { reinitialize: true }),
  );
  const astronomy = await phase('semantic scenario: navigate astronomy fixture', () =>
    navigateOwnedFixture(
      driver,
      SEMANTIC_CLIENTS.astronomy,
      'astronomy',
      'semantic-astronomy',
    ),
  );
  const baking = await phase('semantic scenario: navigate baking fixture', () =>
    navigateOwnedFixture(driver, SEMANTIC_CLIENTS.baking, 'baking', 'semantic-baking'),
  );

  // These are direct production offscreen RPCs. No model, embedding, or ANN substitute is injected.
  await phase('semantic scenario: index astronomy fixture', () =>
    rpc(driver, OFFSCREEN.INDEX_TAB, { tabId: astronomy.tabId }, 75_000),
  );
  await phase('semantic scenario: index baking fixture', () =>
    rpc(driver, OFFSCREEN.INDEX_TAB, { tabId: baking.tabId }, 75_000),
  );
  const stats = await phase('semantic scenario: read index stats', () =>
    rpc(driver, OFFSCREEN.STATS),
  );
  const persistence = await phase('semantic scenario: collect persistence diagnostics', () =>
    persistenceEvidence(driver),
  );
  assert.ok(
    stats?.totalDocuments >= 10,
    `Indexer did not create a persistable HNSW corpus: ${json({ stats, persistence })}`,
  );
  assert.ok(
    stats?.totalTabs >= 2,
    `Indexer did not record both fixture tabs: ${json({ stats, persistence })}`,
  );

  const astronomyResults = await phase('semantic scenario: search astronomy corpus', () =>
    rpc(driver, OFFSCREEN.SEARCH, {
      query: 'astronomy telescope exoplanet transit stellar spectrum',
      topK: 2,
    }),
  );
  assertSearchResults(
    astronomyResults,
    astronomy.tabId,
    /telescope|exoplanet|astronom/,
    'astronomy search',
  );

  const bakingResults = await phase('semantic scenario: search baking corpus', () =>
    rpc(driver, OFFSCREEN.SEARCH, {
      query: 'sourdough bakery bread fermentation starter',
      topK: 2,
    }),
  );
  assertSearchResults(
    bakingResults,
    baking.tabId,
    /sourdough|bakery|ferment|bread/,
    'baking search',
  );

  return {
    kind: 'semantic-index',
    fixture: 'rust-semantic-policy.html',
    modelState: readiness.modelState,
    initialStatus: readiness.status,
    tabs: { astronomy: astronomy.tabId, baking: baking.tabId },
    stats,
    persistence,
    astronomyBaseline: resultProjection(astronomyResults),
    bakingBaseline: resultProjection(bakingResults),
  };
}

/**
 * Called by the parent only after it has restarted the extension service worker and invoked
 * driver.reopen(). Recreating the indexer must reload the persisted HNSW/document mappings,
 * not construct replacement vectors or a second ANN implementation.
 */
export async function verifySemanticAfterRestart(driver, evidence) {
  assert.equal(
    evidence?.kind,
    'semantic-index',
    `Invalid semantic restart evidence: ${json(evidence)}`,
  );
  const readiness = await phase('semantic restart: prepare indexer', () =>
    prepareIndexer(driver, 'semantic restart', { reinitialize: false }),
  );
  const restartStats = await phase('semantic restart: read index stats', () =>
    rpc(driver, OFFSCREEN.STATS),
  );
  const restartedPersistence = await phase('semantic restart: collect persistence diagnostics', () =>
    persistenceEvidence(driver),
  );
  assert.deepEqual(
    {
      totalDocuments: restartStats.totalDocuments,
      totalTabs: restartStats.totalTabs,
      indexSize: restartStats.indexSize,
    },
    {
      totalDocuments: evidence.stats.totalDocuments,
      totalTabs: evidence.stats.totalTabs,
      indexSize: evidence.stats.indexSize,
    },
    `Persisted HNSW corpus drifted after offscreen/SW recreation: ${json({
      before: { stats: evidence.stats, persistence: evidence.persistence },
      after: { stats: restartStats, persistence: restartedPersistence },
    })}`,
  );
  const astronomyResults = await phase('semantic restart: search astronomy corpus', () =>
    rpc(driver, OFFSCREEN.SEARCH, {
      query: 'astronomy telescope exoplanet transit stellar spectrum',
      topK: 2,
    }),
  );
  const bakingResults = await phase('semantic restart: search baking corpus', () =>
    rpc(driver, OFFSCREEN.SEARCH, {
      query: 'sourdough bakery bread fermentation starter',
      topK: 2,
    }),
  );
  const expectedAstronomyTabId = evidence.tabs?.astronomy;
  const expectedBakingTabId = evidence.tabs?.baking;
  assert.equal(
    typeof expectedAstronomyTabId,
    'number',
    `Semantic restart evidence lacks astronomy tab: ${json(evidence)}`,
  );
  assert.equal(
    typeof expectedBakingTabId,
    'number',
    `Semantic restart evidence lacks baking tab: ${json(evidence)}`,
  );
  assertSearchResults(
    astronomyResults,
    expectedAstronomyTabId,
    /telescope|exoplanet|astronom/,
    'persisted astronomy search',
  );
  assertSearchResults(
    bakingResults,
    expectedBakingTabId,
    /sourdough|bakery|ferment|bread/,
    'persisted baking search',
  );
  const restartedAstronomyResults = resultProjection(astronomyResults);
  const restartedBakingResults = resultProjection(bakingResults);
  assert.deepEqual(
    restartedAstronomyResults,
    evidence.astronomyBaseline,
    `Persisted astronomy HNSW search drifted after offscreen/SW recreation: ${json({
      before: evidence.astronomyBaseline,
      after: restartedAstronomyResults,
      beforePersistence: evidence.persistence,
      afterPersistence: restartedPersistence,
    })}`,
  );
  assert.deepEqual(
    restartedBakingResults,
    evidence.bakingBaseline,
    `Persisted baking HNSW search drifted after offscreen/SW recreation: ${json({
      before: evidence.bakingBaseline,
      after: restartedBakingResults,
      beforePersistence: evidence.persistence,
      afterPersistence: restartedPersistence,
    })}`,
  );
  const coldResetRestart = await phase('cold vector reset: restart before loading a model', () =>
    driver.restartServiceWorker(),
  );
  await driver.evaluate(`(async () => {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (!contexts.length) await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: 'Verify persisted vector reset before model initialization',
    });
  })()`);
  const coldStatus = await rpc(driver, OFFSCREEN.STATUS);
  assert.equal(coldStatus.semanticEngineReady, false,
    `Cold reset unexpectedly initialized the model: ${json(coldStatus)}`);
  await phase('cold vector reset: clear existing persisted vectors', () =>
    rpc(driver, 'contentIndexerClearVectorData'),
  );
  const clearedRestart = await driver.restartServiceWorker();
  await phase('cold vector reset: reopen the cleared persisted index', () =>
    prepareIndexer(driver, 'cold vector reset reopen', { reinitialize: false }),
  );
  const clearedStats = await rpc(driver, OFFSCREEN.STATS);
  assert.equal(clearedStats.totalDocuments, 0, 'Cold reset retained persisted documents');
  assert.equal(clearedStats.totalTabs, 0, 'Cold reset retained persisted tab mappings');
  const clearedSearch = await rpc(driver, OFFSCREEN.SEARCH, {
    query: 'astronomy telescope exoplanet transit stellar spectrum',
    topK: 2,
  });
  assert.deepEqual(clearedSearch, [], 'Cold reset restored stale ANN matches after realm recreation');
  return {
    ...evidence,
    restartStatus: readiness.status,
    restartStats,
    restartedPersistence,
    restartedAstronomyResults,
    restartedBakingResults,
    coldReset: { restart: coldResetRestart, clearedRestart, coldStatus, clearedStats, clearedSearch },
  };
}

export async function runOwnershipScenario(driver) {
  const primary = await navigateOwnedFixture(
    driver,
    OWNERSHIP_CLIENTS.primary,
    'astronomy',
    'ownership-primary',
  );
  const secondary = await navigateOwnedFixture(
    driver,
    OWNERSHIP_CLIENTS.secondary,
    'baking',
    'ownership-secondary',
  );
  assert.notEqual(
    primary.tabId,
    secondary.tabId,
    `Distinct clients received the same owned tab: ${json({ primary, secondary })}`,
  );

  const crossClient = await driver.callTool(OWNERSHIP_CLIENTS.secondary, 'chrome_navigate', {
    tabId: primary.tabId,
    url: fixtureUrl(driver, 'ocean', 'ownership-cross-client'),
    reload: true,
  });
  assert.equal(
    crossClient?.isError,
    true,
    `Cross-client mutation unexpectedly succeeded: ${json(crossClient)}`,
  );
  assert.equal(
    crossClient?.parsed?.error?.code,
    'TAB_NOT_OWNED',
    `Cross-client mutation returned the wrong failure: ${json(crossClient)}`,
  );

  const alias = await driver.callTool(OWNERSHIP_CLIENTS.primary, 'browser_alias_tab', {
    alias: OWNERSHIP_ALIAS,
    tabId: primary.tabId,
  });
  const aliasBody = parsedToolResult(alias, 'set primary alias');
  assert.equal(
    aliasBody.alias,
    OWNERSHIP_ALIAS,
    `Alias response was malformed: ${json(aliasBody)}`,
  );
  assert.equal(aliasBody.tabId, primary.tabId, `Alias resolved the wrong tab: ${json(aliasBody)}`);

  const aliasTarget = primary.url;
  const viaAlias = await driver.callTool(OWNERSHIP_CLIENTS.primary, 'chrome_navigate', {
    tabAlias: OWNERSHIP_ALIAS,
    refresh: true,
  });
  assert.equal(
    tabIdFrom(viaAlias, 'navigate through alias'),
    primary.tabId,
    `Alias did not target its owned tab: ${json(viaAlias)}`,
  );
  await waitForCompleteTab(driver, primary.tabId, aliasTarget);

  const paced = await driver.callTool(OWNERSHIP_CLIENTS.primary, 'chrome_pace', {
    profile: 'human',
    minGapMs: 0,
    jitterMs: 0,
  });
  const paceBody = parsedToolResult(paced, 'set deterministic human pacing');
  assert.equal(paceBody.profile, 'human', `Pacing profile was not set: ${json(paceBody)}`);
  assert.equal(paceBody.minGapMs, 0, `Pacing gap was not overridden: ${json(paceBody)}`);
  assert.equal(paceBody.jitterMs, 0, `Pacing jitter was not overridden: ${json(paceBody)}`);

  const released = await navigateOwnedFixture(
    driver,
    OWNERSHIP_CLIENTS.released,
    'ocean',
    'ownership-release',
  );
  const releaseResponse = await driver.releaseClient(OWNERSHIP_CLIENTS.released);
  assert.equal(
    releaseResponse?.released,
    OWNERSHIP_CLIENTS.released,
    `Release endpoint returned the wrong client: ${json(releaseResponse)}`,
  );
  const releasedOwnership = await waitForReleasedOwnership(driver, OWNERSHIP_CLIENTS.released);
  const releasedTab = await driver.evaluate(`chrome.tabs.get(${released.tabId})`);
  assert.equal(
    releasedTab?.id,
    released.tabId,
    `Client release closed its tab instead of leaving it open: ${json(releasedTab)}`,
  );

  // The Rust ownership snapshot is debounced; wait until it is eligible for the one parent-owned SW restart.
  await delay(100);
  return {
    kind: 'ownership',
    primary: {
      clientId: OWNERSHIP_CLIENTS.primary,
      alias: OWNERSHIP_ALIAS,
      tabId: primary.tabId,
      aliasTarget,
    },
    secondary: { clientId: OWNERSHIP_CLIENTS.secondary, tabId: secondary.tabId },
    released: {
      clientId: OWNERSHIP_CLIENTS.released,
      tabId: released.tabId,
      releaseResponse,
      ownershipAfterRelease: releasedOwnership,
    },
    crossClientError: crossClient.parsed.error,
    pacingBeforeRestart: paceBody,
  };
}

export async function verifyOwnershipAfterRestart(driver, evidence) {
  assert.equal(
    evidence?.kind,
    'ownership',
    `Invalid ownership restart evidence: ${json(evidence)}`,
  );
  const primary = evidence.primary;
  assert.equal(
    typeof primary?.tabId,
    'number',
    `Ownership restart evidence lacks a retained tab: ${json(evidence)}`,
  );

  const owned = await driver.callTool(primary.clientId, 'chrome_owned_tabs');
  const ownedBody = parsedToolResult(owned, 'owned tabs after restart');
  assert.ok(
    ownedBody.ownedTabs?.some((tab) => tab.tabId === primary.tabId),
    `Persisted ownership did not restore the retained tab: ${json(ownedBody)}`,
  );

  const aliasTarget = primary.aliasTarget;
  const viaAlias = await driver.callTool(primary.clientId, 'chrome_navigate', {
    tabAlias: primary.alias,
    refresh: true,
  });
  assert.equal(
    tabIdFrom(viaAlias, 'navigate through restored alias'),
    primary.tabId,
    `Restored alias did not target its tab: ${json(viaAlias)}`,
  );
  await waitForCompleteTab(driver, primary.tabId, aliasTarget);

  const pacing = await driver.callTool(primary.clientId, 'chrome_pace');
  const pacingBody = parsedToolResult(pacing, 'pacing after restart');
  assert.deepEqual(
    { profile: pacingBody.profile, minGapMs: pacingBody.minGapMs, jitterMs: pacingBody.jitterMs },
    { profile: 'off', minGapMs: 0, jitterMs: 0 },
    `Pacing persisted across a service-worker restart: ${json(pacingBody)}`,
  );

  return {
    ...evidence,
    restoredOwnedTabs: ownedBody.ownedTabs,
    restoredAliasTabId: primary.tabId,
    pacingAfterRestart: pacingBody,
  };
}
