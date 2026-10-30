import assert from 'node:assert/strict';

const QUEUE_CLIENTS = Object.freeze({
  ownerA: 'rust-queue-owner-a',
  ownerB: 'rust-queue-owner-b',
  closing: 'rust-queue-closing',
});

const POLL_INTERVAL_MS = 25;
const QUEUE_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = QUEUE_TIMEOUT_MS + 5_000;
const SETTLE_TIMEOUT_MS = CALL_TIMEOUT_MS + 5_000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function json(value) {
  return JSON.stringify(value);
}

function fixtureUrl(driver, marker) {
  const url = new URL('rust-semantic-policy.html', driver.fixtureUrl);
  url.searchParams.set('document', 'astronomy');
  url.searchParams.set('scenario', marker);
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

function observed(promise) {
  return promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason: reason instanceof Error ? reason.message : String(reason) }),
  );
}

async function eventually(label, predicate, timeoutMs = QUEUE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`${label} did not converge within ${timeoutMs}ms: ${json(last)}`);
}

async function settle(label, calls, timeoutMs = SETTLE_TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      Promise.all(calls),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle within ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function navigateOwnedFixture(driver, clientId, marker) {
  const url = fixtureUrl(driver, marker);
  const result = await driver.callTool(
    clientId,
    'chrome_navigate',
    { url, newTab: true, background: true },
    CALL_TIMEOUT_MS,
  );
  const tabId = tabIdFrom(result, `navigate ${marker}`);
  await eventually(`tab ${tabId} fixture load`, async () => {
    const tab = await driver.evaluate(`chrome.tabs.get(${json(tabId)})`);
    return tab?.status === 'complete' && tab?.url === url ? tab : null;
  });
  return { tabId, url };
}

async function queueSnapshot(driver, clientId, tabId) {
  // chrome_queue_inspect was consolidated into the read-only public diagnostics action.
  const result = await driver.callTool(
    clientId,
    'chrome_diagnostics',
    { action: 'queue', tabId },
    CALL_TIMEOUT_MS,
  );
  const body = parsedToolResult(result, `inspect queue for tab ${tabId}`);
  assert.ok(Array.isArray(body?.tabs), `Queue inspection lacks tabs[]: ${json(body)}`);
  return body.tabs;
}

function assertQueueShape(snapshot, { tabId, holderClientId, waiterClientIds }) {
  assert.equal(snapshot?.tabId, tabId, `Queue snapshot targeted the wrong tab: ${json(snapshot)}`);
  assert.equal(snapshot?.depth, waiterClientIds.length + 1, `Queue depth drifted: ${json(snapshot)}`);
  assert.equal(typeof snapshot?.servedTotal, 'number', `Queue snapshot lacks servedTotal: ${json(snapshot)}`);
  assert.equal(typeof snapshot?.meanHoldMs, 'number', `Queue snapshot lacks meanHoldMs: ${json(snapshot)}`);
  assert.equal(snapshot?.holder?.clientId, holderClientId, `Queue holder drifted: ${json(snapshot)}`);
  assert.equal(typeof snapshot?.holder?.heldMs, 'number', `Queue holder lacks heldMs: ${json(snapshot)}`);
  assert.equal(typeof snapshot?.holder?.ticket, 'number', `Queue holder lacks ticket: ${json(snapshot)}`);
  assert.deepEqual(
    snapshot?.waiters?.map((waiter) => waiter.clientId),
    waiterClientIds,
    `Queue waiter lanes drifted: ${json(snapshot)}`,
  );
  assert.deepEqual(
    snapshot?.waiters?.map((waiter) => waiter.position),
    waiterClientIds.map((_, index) => index + 2),
    `Queue waiter positions drifted: ${json(snapshot)}`,
  );
  for (const waiter of snapshot.waiters) {
    assert.equal(typeof waiter.waitedMs, 'number', `Queue waiter lacks waitedMs: ${json(waiter)}`);
    assert.equal(
      typeof waiter.expectedWaitMs,
      'number',
      `Queue waiter lacks expectedWaitMs: ${json(waiter)}`,
    );
    assert.equal(typeof waiter.ticket, 'number', `Queue waiter lacks ticket: ${json(waiter)}`);
  }
}

async function waitForQueue(driver, clientId, tabId, expected) {
  return eventually(`queue admission for tab ${tabId}`, async () => {
    const tabs = await queueSnapshot(driver, clientId, tabId);
    const snapshot = tabs.find((entry) => entry.tabId === tabId);
    if (!snapshot || snapshot.depth !== expected.waiterClientIds.length + 1) return null;
    try {
      assertQueueShape(snapshot, { tabId, ...expected });
      return snapshot;
    } catch {
      return null;
    }
  });
}

async function waitForGate(driver, tabId, gateKey) {
  return eventually(`async JavaScript holder gate for tab ${tabId}`, () =>
    driver.evaluateTab(tabId, `typeof globalThis[${json(gateKey)}] === 'function'`),
  );
}

async function releaseGate(driver, tabId, gateKey) {
  const released = await driver.evaluateTab(
    tabId,
    `(() => {
      const release = globalThis[${json(gateKey)}];
      if (typeof release !== 'function') return false;
      delete globalThis[${json(gateKey)}];
      release();
      return true;
    })()`,
  );
  assert.equal(released, true, `External CDP could not release holder on tab ${tabId}`);
}

function holderCode(sequenceKey, gateKey) {
  return `
    const sequence = globalThis[${json(sequenceKey)}] = [];
    sequence.push('holder-start');
    document.body.dataset.hcQueueSequence = JSON.stringify(sequence);
    await new Promise((resolve) => { globalThis[${json(gateKey)}] = resolve; });
    sequence.push('holder-release');
    document.body.dataset.hcQueueSequence = JSON.stringify(sequence);
    return sequence;
  `;
}

function appendSequenceScript(sequenceKey, label) {
  return `
    const sequence = globalThis[${json(sequenceKey)}];
    if (!Array.isArray(sequence)) throw new Error('queue holder sequence is unavailable');
    sequence.push(${json(label)});
    document.body.dataset.hcQueueSequence = JSON.stringify(sequence);
  `;
}

function assertSuccessfulCalls(results, label) {
  for (const result of results) {
    assert.equal(result.status, 'fulfilled', `${label} transport failed: ${json(result)}`);
    assert.equal(result.value?.isError, false, `${label} tool failed: ${json(result.value)}`);
  }
}

async function removeOwnedTab(driver, tabId) {
  if (typeof tabId !== 'number') return;
  await driver.evaluate(`chrome.tabs.remove(${json(tabId)}).catch(() => undefined)`);
}

async function releaseOwnedClients(driver, clientIds) {
  await Promise.all(clientIds.map((clientId) => driver.releaseClient(clientId).catch(() => undefined)));
}

async function runFairnessScenario(driver) {
  const fixture = await navigateOwnedFixture(driver, QUEUE_CLIENTS.ownerA, 'queue-fairness');
  const sequenceKey = `__hcQueueSequence_${fixture.tabId}`;
  const gateKey = `__hcQueueRelease_${fixture.tabId}`;
  const holder = observed(
    driver.callTool(
      QUEUE_CLIENTS.ownerA,
      'chrome_javascript',
      { tabId: fixture.tabId, code: holderCode(sequenceKey, gateKey), timeoutMs: QUEUE_TIMEOUT_MS },
      CALL_TIMEOUT_MS,
    ),
  );
  const calls = [holder];

  try {
    await waitForGate(driver, fixture.tabId, gateKey);

    const ownerAFirst = observed(
      driver.callTool(
        QUEUE_CLIENTS.ownerA,
        'chrome_inject_script',
        {
          tabId: fixture.tabId,
          type: 'MAIN',
          jsScript: appendSequenceScript(sequenceKey, 'owner-a-1'),
        },
        CALL_TIMEOUT_MS,
      ),
    );
    calls.push(ownerAFirst);
    const ownerASecond = observed(
      driver.callTool(
        QUEUE_CLIENTS.ownerA,
        'chrome_inject_script',
        {
          tabId: fixture.tabId,
          type: 'MAIN',
          jsScript: appendSequenceScript(sequenceKey, 'owner-a-2'),
        },
        CALL_TIMEOUT_MS,
      ),
    );
    calls.push(ownerASecond);

    const ownerAQueued = await waitForQueue(driver, QUEUE_CLIENTS.ownerA, fixture.tabId, {
      holderClientId: QUEUE_CLIENTS.ownerA,
      waiterClientIds: [QUEUE_CLIENTS.ownerA, QUEUE_CLIENTS.ownerA],
    });

    const handoffToB = await driver.callTool(
      QUEUE_CLIENTS.ownerB,
      'browser_claim_tab',
      { tabId: fixture.tabId, force: true },
      CALL_TIMEOUT_MS,
    );
    const handoffToBBody = parsedToolResult(handoffToB, 'force-claim queue tab for owner B');
    assert.equal(handoffToBBody.previousOwner, QUEUE_CLIENTS.ownerA, `Unexpected owner-A handoff: ${json(handoffToBBody)}`);

    const ownerB = observed(
      driver.callTool(
        QUEUE_CLIENTS.ownerB,
        'chrome_inject_script',
        {
          tabId: fixture.tabId,
          type: 'MAIN',
          jsScript: appendSequenceScript(sequenceKey, 'owner-b-1'),
        },
        CALL_TIMEOUT_MS,
      ),
    );
    calls.push(ownerB);
    const bothLanesQueued = await waitForQueue(driver, QUEUE_CLIENTS.ownerB, fixture.tabId, {
      holderClientId: QUEUE_CLIENTS.ownerA,
      waiterClientIds: [QUEUE_CLIENTS.ownerA, QUEUE_CLIENTS.ownerA, QUEUE_CLIENTS.ownerB],
    });

    // browser_claim_tab is intentionally not a mutating tab action. Return ownership before
    // release so only the already-admitted queue tickets determine execution order.
    const handoffToA = await driver.callTool(
      QUEUE_CLIENTS.ownerA,
      'browser_claim_tab',
      { tabId: fixture.tabId, force: true },
      CALL_TIMEOUT_MS,
    );
    const handoffToABody = parsedToolResult(handoffToA, 'return queue tab to owner A');
    assert.equal(handoffToABody.previousOwner, QUEUE_CLIENTS.ownerB, `Unexpected owner-B handoff: ${json(handoffToABody)}`);

    await releaseGate(driver, fixture.tabId, gateKey);
    const results = await settle('round-robin queue calls', calls);
    assertSuccessfulCalls(results, 'round-robin queue');

    const dom = await driver.evaluateTab(
      fixture.tabId,
      `({ sequence: globalThis[${json(sequenceKey)}], domSequence: document.body.dataset.hcQueueSequence })`,
    );
    const expectedSequence = ['holder-start', 'holder-release', 'owner-b-1', 'owner-a-1', 'owner-a-2'];
    assert.deepEqual(dom?.sequence, expectedSequence, `Round-robin execution order drifted: ${json(dom)}`);
    assert.equal(
      dom?.domSequence,
      JSON.stringify(expectedSequence),
      `Actual DOM sequence drifted: ${json(dom)}`,
    );

    const drained = await eventually(`queue drain for tab ${fixture.tabId}`, async () => {
      const tabs = await queueSnapshot(driver, QUEUE_CLIENTS.ownerA, fixture.tabId);
      return tabs.length === 0 ? tabs : null;
    });

    return {
      tabId: fixture.tabId,
      ownerAQueued,
      bothLanesQueued,
      handoffToB: handoffToBBody,
      handoffToA: handoffToABody,
      sequence: dom.sequence,
      domSequence: dom.domSequence,
      drained,
    };
  } finally {
    await releaseGate(driver, fixture.tabId, gateKey).catch(() => undefined);
    await removeOwnedTab(driver, fixture.tabId);
    await settle('round-robin queue cleanup', calls).catch(() => undefined);
  }
}

async function runClosedTabScenario(driver) {
  const fixture = await navigateOwnedFixture(driver, QUEUE_CLIENTS.closing, 'queue-tab-closed');
  const sequenceKey = `__hcClosedQueueSequence_${fixture.tabId}`;
  const gateKey = `__hcClosedQueueRelease_${fixture.tabId}`;
  const holder = observed(
    driver.callTool(
      QUEUE_CLIENTS.closing,
      'chrome_javascript',
      { tabId: fixture.tabId, code: holderCode(sequenceKey, gateKey), timeoutMs: QUEUE_TIMEOUT_MS },
      CALL_TIMEOUT_MS,
    ),
  );
  const calls = [holder];

  try {
    await waitForGate(driver, fixture.tabId, gateKey);
    const firstWaiter = observed(
      driver.callTool(
        QUEUE_CLIENTS.closing,
        'chrome_javascript',
        {
          tabId: fixture.tabId,
          code: appendSequenceScript(sequenceKey, 'closed-waiter-1'),
          timeoutMs: QUEUE_TIMEOUT_MS,
        },
        CALL_TIMEOUT_MS,
      ),
    );
    calls.push(firstWaiter);
    const secondWaiter = observed(
      driver.callTool(
        QUEUE_CLIENTS.closing,
        'chrome_javascript',
        {
          tabId: fixture.tabId,
          code: appendSequenceScript(sequenceKey, 'closed-waiter-2'),
          timeoutMs: QUEUE_TIMEOUT_MS,
        },
        CALL_TIMEOUT_MS,
      ),
    );
    calls.push(secondWaiter);

    const queued = await waitForQueue(driver, QUEUE_CLIENTS.closing, fixture.tabId, {
      holderClientId: QUEUE_CLIENTS.closing,
      waiterClientIds: [QUEUE_CLIENTS.closing, QUEUE_CLIENTS.closing],
    });

    await removeOwnedTab(driver, fixture.tabId);
    const [holderResult, firstResult, secondResult] = await settle('closed-tab queue calls', calls);

    for (const result of [firstResult, secondResult]) {
      assert.equal(result.status, 'fulfilled', `Closed-tab waiter transport failed: ${json(result)}`);
      assert.equal(result.value?.isError, true, `Closed-tab waiter unexpectedly succeeded: ${json(result.value)}`);
      assert.equal(
        result.value?.parsed?.error?.code,
        'TAB_CLOSED',
        `Closed-tab waiter had the wrong error envelope: ${json(result.value)}`,
      );
      assert.equal(
        result.value?.parsed?.error?.details?.tabId,
        fixture.tabId,
        `Closed-tab waiter reported the wrong tab: ${json(result.value)}`,
      );
    }

    const drained = await eventually(`closed queue cleanup for tab ${fixture.tabId}`, async () => {
      const tabs = await queueSnapshot(driver, QUEUE_CLIENTS.closing, fixture.tabId);
      return tabs.length === 0 ? tabs : null;
    });

    return {
      tabId: fixture.tabId,
      queued,
      holder: holderResult,
      waiterErrors: [firstResult.value.parsed.error, secondResult.value.parsed.error],
      drained,
    };
  } finally {
    await removeOwnedTab(driver, fixture.tabId);
    await settle('closed-tab queue cleanup', calls).catch(() => undefined);
  }
}

export async function runQueueScenario(driver) {
  try {
    const fairness = await runFairnessScenario(driver);
    const closedTab = await runClosedTabScenario(driver);
    return { kind: 'queue', fairness, closedTab };
  } finally {
    await releaseOwnedClients(driver, Object.values(QUEUE_CLIENTS));
  }
}
