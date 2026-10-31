import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Frozen pre-port executable; never regenerated from the Rust-backed implementation.
const selectorOracleSource = await readFile(
  new URL('../../tests/rust-transition/fixtures/selector-engine.original.js', import.meta.url),
  'utf8',
);

const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 75;

function expression(body) {
  return `(async () => { ${body} })()`;
}

function json(value) {
  return JSON.stringify(value);
}

async function sendRuntimeMessage(driver, message) {
  return driver.evaluate(
    expression(`
      return await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(${json(message)}, (response) => {
          const error = chrome.runtime.lastError;
          if (error) reject(new Error(error.message));
          else resolve(response);
        });
      });
    `),
    DEFAULT_TIMEOUT_MS,
  );
}

async function findFixtureTab(driver) {
  assert.equal(typeof driver.fixtureUrl, 'string', 'browser policy driver must expose fixtureUrl');
  const fixture = await driver.evaluate(
    expression(`
      const fixtureUrl = new URL(${json(driver.fixtureUrl)});
      fixtureUrl.searchParams.set('rustFixture', crypto.randomUUID());
      // Never steal the matrix client's existing owned fixture tab.
      const tab = await chrome.tabs.create({ url: fixtureUrl.href, active: false });
      if (typeof tab.id !== 'number') throw new Error('chrome.tabs.create returned no tab id');
      const waitForComplete = async () => {
        const deadline = Date.now() + 15_000;
        for (;;) {
          const current = await chrome.tabs.get(tab.id);
          if (current.status === 'complete' && current.url === fixtureUrl.href) return current;
          if (Date.now() >= deadline) throw new Error('fixture tab did not finish loading');
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      };
      const loaded = await waitForComplete();
      return {
        tabId: tab.id,
        url: loaded.url,
        windowId: loaded.windowId,
        created: true,
      };
    `),
    DEFAULT_TIMEOUT_MS,
  );

  assert.equal(typeof fixture.tabId, 'number', 'fixture tab is missing tabId');
  return fixture;
}

async function claimAndForegroundFixture(driver, clientId) {
  const fixture = await findFixtureTab(driver);
  const claim = await driver.callTool(clientId, 'browser_claim_tab', { tabId: fixture.tabId });
  assert(!claim.isError, `browser_claim_tab failed: ${JSON.stringify(claim.parsed ?? claim)}`);

  const foreground = await driver.callTool(clientId, 'chrome_switch_tab', { tabId: fixture.tabId });
  assert(
    !foreground.isError,
    `chrome_switch_tab failed: ${JSON.stringify(foreground.parsed ?? foreground)}`,
  );
  return fixture;
}

async function cleanupFixtureTab(driver, fixture) {
  if (!fixture.created) return;
  await driver.evaluate(`chrome.tabs.remove(${json(fixture.tabId)})`);
}

async function probeInjectedRealms(driver, tabId) {
  return driver.evaluate(
    expression(`
      const tabId = ${json(tabId)};
      const frames = await chrome.webNavigation.getAllFrames({ tabId });
      const frameIds = (Array.isArray(frames) && frames.length ? frames : [{ frameId: 0 }])
        .map((frame) => frame.frameId ?? 0);
      const results = await chrome.scripting.executeScript({
        target: { tabId, frameIds },
        world: 'ISOLATED',
        func: () => ({
          selectorEngine: typeof globalThis.__rrSelectorEngine?.generateExtendedSelectorTarget === 'function',
          recorderInstalled: globalThis.__RR_RECORDER_INSTALLED__ === true,
          restrictiveCsp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? null,
          cspFixtureTarget: document.querySelector('#rr-csp-target') !== null,
        }),
      });
      return results.map((result) => ({ frameId: result.frameId, ...result.result }));
    `),
    DEFAULT_TIMEOUT_MS,
  );
}

async function readFixtureState(driver, tabId) {
  return driver.evaluate(
    expression(`
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: ${json(tabId)} },
        world: 'MAIN',
        func: () => ({
          recorderClicks: Number(document.querySelector('#rr-recorder-count')?.textContent ?? '0'),
          workflowClicks: Number(document.querySelector('#rr-workflow-count')?.textContent ?? '0'),
        }),
      });
      return result;
    `),
    DEFAULT_TIMEOUT_MS,
  );
}

async function resetFixtureState(driver, tabId) {
  return driver.evaluate(
    expression(`
      await chrome.scripting.executeScript({
        target: { tabId: ${json(tabId)} },
        world: 'MAIN',
        func: () => {
          const recorder = document.querySelector('#rr-recorder-count');
          const workflow = document.querySelector('#rr-workflow-count');
          if (recorder) recorder.textContent = '0';
          if (workflow) workflow.textContent = '0';
        },
      });
    `),
    DEFAULT_TIMEOUT_MS,
  );
}

function recordedClick(flow) {
  return flow?.nodes?.find((node) => node?.type === 'click') ?? null;
}

function cssCandidate(target) {
  return target?.candidates?.find(
    (candidate) => candidate?.type === 'css' || candidate?.type === 'attr',
  );
}

/**
 * Records and replays a click entirely through the extension's public runtime
 * message entrypoints and browser tools. The isolated-world probes only observe
 * state installed by the production injection path; they never import a source
 * module or call the kernel directly.
 */
export async function runRecorderScenario(driver) {
  const clientId = 'rust-recorder-policy';
  const fixture = await claimAndForegroundFixture(driver, clientId);
  const { tabId, url } = fixture;
  await resetFixtureState(driver, tabId);
  const oracleSelectors = [
    '#rr-recorder-target',
    '#rr-workflow-target',
    '#email-in',
    '#username-in',
    '#search-in',
    '#type-target',
  ];
  const referenceTargets = await driver.evaluateTab(
    tabId,
    `(() => {
    ${selectorOracleSource}
    return ${json(oracleSelectors)}.map(selector => ({
      selector,
      target: globalThis.__rrSelectorEngine.generateExtendedSelectorTarget(
        document.querySelector(selector)
      ),
    }));
  })()`,
    { worldName: 'humanchrome-selector-original-oracle' },
  );
  const referenceTarget = referenceTargets[0].target;

  const started = await sendRuntimeMessage(driver, {
    type: 'rr_start_recording',
    meta: { name: 'Rust recorder policy live scenario' },
  });
  assert.equal(started?.success, true, `rr_start_recording failed: ${JSON.stringify(started)}`);

  const injectedFrames = await probeInjectedRealms(driver, tabId);
  const topFrame = injectedFrames.find((frame) => frame.frameId === 0);
  assert(
    topFrame?.selectorEngine,
    `top recorder realm has no selector engine: ${JSON.stringify(injectedFrames)}`,
  );
  assert(
    topFrame?.recorderInstalled,
    `top recorder realm has no recorder: ${JSON.stringify(injectedFrames)}`,
  );

  const cspFrame = injectedFrames.find((frame) => frame.cspFixtureTarget);
  assert(
    cspFrame?.selectorEngine && cspFrame?.restrictiveCsp?.includes("default-src 'none'"),
    `restrictive-CSP fixture has no initialized selector engine: ${JSON.stringify(injectedFrames)}`,
  );

  const click = await driver.callTool(clientId, 'chrome_click_element', {
    tabId,
    selector: '#rr-recorder-target',
  });
  assert(!click.isError, `recorded click failed: ${JSON.stringify(click.parsed ?? click)}`);

  // recorder.js holds a single click briefly to distinguish it from dblclick;
  // its stop barrier then flushes that pending event before persistence.
  const stopped = await sendRuntimeMessage(driver, { type: 'rr_stop_recording' });
  assert.equal(stopped?.success, true, `rr_stop_recording failed: ${JSON.stringify(stopped)}`);
  const flow = stopped?.flow;
  assert(flow?.id, `rr_stop_recording returned no persisted flow: ${JSON.stringify(stopped)}`);

  const clickNode = recordedClick(flow);
  assert(clickNode, `recorded flow contains no click node: ${JSON.stringify(flow?.nodes)}`);
  const target = clickNode.config?.target;
  const primary = cssCandidate(target);
  assert(primary?.value, `recorded click has no CSS/attr primary: ${JSON.stringify(target)}`);
  assert.equal(
    target?.selector,
    primary.value,
    `recorded click CSS primary drifted from its selector: ${JSON.stringify(target)}`,
  );
  assert.equal(primary.type, 'css', `recorded click primary is not CSS: ${JSON.stringify(target)}`);
  assert(target?.fingerprint, `recorded click has no fingerprint: ${JSON.stringify(target)}`);
  assert(
    Array.isArray(target?.candidates) && target.candidates.length > 0,
    `recorded click has no selector candidates: ${JSON.stringify(target)}`,
  );
  const [{ result: rawTargets }] = await driver.evaluate(
    expression(`
    return chrome.scripting.executeScript({
      target: { tabId: ${json(tabId)}, frameIds: [0] },
      world: 'ISOLATED',
      func: (selectors) => selectors.map(selector => ({
        selector,
        target: globalThis.__rrSelectorEngine.generateExtendedSelectorTarget(
          document.querySelector(selector)
        ),
      })),
      args: [${json(oracleSelectors)}],
    });
  `),
  );
  assert.deepEqual(
    rawTargets,
    referenceTargets,
    'Generated recorder targets differ from the executable pre-port oracle',
  );
  const projection = (value) =>
    Object.fromEntries(
      ['selector', 'candidates', 'fingerprint', 'domPath', 'shadowHostChain'].map((key) => [
        key,
        value?.[key],
      ]),
    );
  const recordedReference = projection(referenceTarget);
  // recorder.js omits an empty host chain when it serializes the generated target.
  if (!recordedReference.shadowHostChain.length) recordedReference.shadowHostChain = undefined;
  assert.deepEqual(
    projection(target),
    recordedReference,
    'Recorded selector/candidate/fingerprint/path output differs from the executable pre-port oracle',
  );

  const afterRecordedClick = await readFixtureState(driver, tabId);
  assert.equal(
    afterRecordedClick.recorderClicks,
    1,
    `recorded click did not change fixture state: ${JSON.stringify(afterRecordedClick)}`,
  );

  await resetFixtureState(driver, tabId);
  await driver.releaseClient(clientId);
  const releaseDeadline = Date.now() + 15_000;
  while ((await driver.callTool(clientId, 'chrome_owned_tabs')).parsed?.ownedTabs?.length !== 0) {
    assert(
      Date.now() < releaseDeadline,
      'Recorder fixture ownership was not released before UI replay',
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await driver.evaluate(`chrome.windows.update(${json(fixture.windowId)}, { focused: true })
    .then(() => chrome.tabs.update(${json(tabId)}, { active: true }))`);
  const replayed = await sendRuntimeMessage(driver, {
    type: 'rr_run_flow',
    flowId: flow.id,
    options: { tabTarget: 'current', returnLogs: true },
  });
  assert.equal(
    replayed?.success,
    true,
    `rr_run_flow transport failed: ${JSON.stringify(replayed)}`,
  );
  assert.equal(
    replayed?.result?.success,
    true,
    `recorded flow replay failed: ${JSON.stringify(replayed)}`,
  );

  const afterReplay = await readFixtureState(driver, tabId);
  assert.equal(
    afterReplay.recorderClicks,
    1,
    `recorded flow replay did not click fixture: ${JSON.stringify(afterReplay)}`,
  );

  // The legacy flow is no longer needed. Keep V3 workflow records for the
  // parent-owned service-worker restart check instead.
  const deleted = await sendRuntimeMessage(driver, { type: 'rr_delete_flow', flowId: flow.id });
  assert.equal(deleted?.success, true, `recorded flow cleanup failed: ${JSON.stringify(deleted)}`);
  await cleanupFixtureTab(driver, fixture);

  return {
    tabId,
    fixtureUrl: url,
    flowId: flow.id,
    recordedClick: {
      candidateCount: target.candidates.length,
      cssPrimary: primary.value,
      hasFingerprint: true,
    },
    injectedFrames,
    cspFrameSelectorReady: Boolean(cspFrame?.selectorEngine),
    bootstrapTransport: 'Production selector bootstrap completed in the restrictive-CSP fixture',
    prePortFixtureComparison: {
      reference: 'tests/rust-transition/fixtures/selector-engine.original.js',
      sha256: '1de56fe86785c36ed4fb6b02cbcb6eb95d8f97a2be524cd8fb8682635ead628b',
      selectors: oracleSelectors,
      matched: projection(target),
    },
    replayCount: afterReplay.recorderClicks,
  };
}

function v3WorkflowExpression(tabId) {
  return expression(`
    const tabId = ${json(tabId)};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const port = chrome.runtime.connect({ name: 'rr_v3' });
    let requestNumber = 0;
    const request = (method, params = {}) => new Promise((resolve, reject) => {
      const requestId = 'rust-live-' + (++requestNumber);
      const timer = setTimeout(() => reject(new Error(method + ' timed out')), ${json(POLL_TIMEOUT_MS)});
      const listener = (message) => {
        if (message?.type !== 'rr_v3.response' || message.requestId !== requestId) return;
        clearTimeout(timer);
        port.onMessage.removeListener(listener);
        if (message.ok) resolve(message.result);
        else reject(new Error(method + ': ' + message.error));
      };
      port.onMessage.addListener(listener);
      port.postMessage({ type: 'rr_v3.request', requestId, method, params });
    });
    const eventually = async (runId, wantedStatuses) => {
      const deadline = Date.now() + ${json(POLL_TIMEOUT_MS)};
      for (;;) {
        const run = await request('rr_v3.getRun', { runId });
        if (run && wantedStatuses.includes(run.status)) return run;
        if (Date.now() >= deadline) {
          throw new Error('run did not reach ' + wantedStatuses.join(',') + ': ' + runId);
        }
        await sleep(${json(POLL_INTERVAL_MS)});
      }
    };
    const eventuallyTerminal = (runId) => eventually(runId, ['succeeded', 'failed', 'canceled']);
    const ids = {
      main: 'rust-live-main-' + Date.now(),
      retry: 'rust-live-retry-' + Date.now(),
      cycle: 'rust-live-cycle-' + Date.now(),
      pause: 'rust-live-pause-' + Date.now(),
      cancel: 'rust-live-cancel-' + Date.now(),
    };
    const triggerId = (flowId) => 'rust-live-trigger-' + flowId;
    const save = (flow) => request('rr_v3.saveFlow', { flow });
    const createAndFire = async (flowId, args = { choice: 'go' }) => {
      const trigger = await request('rr_v3.createTrigger', {
        trigger: { id: triggerId(flowId), kind: 'manual', flowId, args },
      });
      const queued = await request('rr_v3.fireTrigger', {
        triggerId: trigger.id,
        sourceTabId: tabId,
      });
      return { trigger, queued };
    };

    const main = await save({
      id: ids.main,
      name: 'Rust live V3 branching variable workflow',
      entryNodeId: 'branch',
      variables: [{ name: 'choice', default: 'stop' }],
      nodes: [
        {
          id: 'branch', kind: 'if', config: {
            mode: 'binary',
            condition: { kind: 'compare', left: { kind: 'var', ref: { name: 'choice' } }, op: 'eq', right: 'go' },
            trueLabel: 'true', falseLabel: 'false',
          },
        },
        {
          id: 'click', kind: 'click', config: {
            target: { selector: '#rr-workflow-target', candidates: [{ type: 'css', selector: '#rr-workflow-target' }] },
          },
        },
        { id: 'skip', kind: 'delay', config: { sleep: 1 } },
      ],
      edges: [
        { id: 'branch-click', from: 'branch', to: 'click', label: 'true' },
        { id: 'branch-skip', from: 'branch', to: 'skip', label: 'false' },
      ],
    });
    const mainStart = await createAndFire(main.id);
    const mainRun = await eventuallyTerminal(mainStart.queued.runId);

    const retry = await save({
      id: ids.retry,
      name: 'Rust live V3 retry workflow',
      entryNodeId: 'missing',
      nodes: [{
        id: 'missing', kind: 'click',
        config: { target: { selector: '#does-not-exist', candidates: [{ type: 'css', selector: '#does-not-exist' }] } },
        policy: { onError: { kind: 'retry', override: { retries: 1, intervalMs: 0 } } },
      }],
      edges: [],
    });
    const retryStart = await createAndFire(retry.id);
    const retryRun = await eventuallyTerminal(retryStart.queued.runId);
    const retryEvents = await request('rr_v3.getEvents', { runId: retryStart.queued.runId });

    const cycle = await save({
      id: ids.cycle,
      name: 'Rust live V3 cycle rejection',
      entryNodeId: 'first',
      nodes: [
        { id: 'first', kind: 'delay', config: { sleep: 1 } },
        { id: 'second', kind: 'delay', config: { sleep: 1 } },
      ],
      edges: [
        { id: 'first-second', from: 'first', to: 'second' },
        { id: 'second-first', from: 'second', to: 'first' },
      ],
    });
    const cycleStart = await createAndFire(cycle.id);
    const cycleRun = await eventuallyTerminal(cycleStart.queued.runId);

    const pause = await save({
      id: ids.pause,
      name: 'Rust live V3 pause resume',
      entryNodeId: 'delay',
      nodes: [{ id: 'delay', kind: 'delay', config: { sleep: 600 } }],
      edges: [],
    });
    const pauseStart = { queued: await request('rr_v3.enqueueRun', {
      flowId: pause.id, debug: { pauseOnStart: true },
    }) };
    await eventually(pauseStart.queued.runId, ['paused']);
    const paused = await request('rr_v3.pauseRun', { runId: pauseStart.queued.runId });
    const resumed = await request('rr_v3.resumeRun', { runId: pauseStart.queued.runId });
    const pauseRun = await eventuallyTerminal(pauseStart.queued.runId);

    const cancel = await save({
      id: ids.cancel,
      name: 'Rust live V3 cancellation',
      entryNodeId: 'delay',
      nodes: [{ id: 'delay', kind: 'delay', config: { sleep: 3000 } }],
      edges: [],
    });
    const cancelStart = { queued: await request('rr_v3.enqueueRun', {
      flowId: cancel.id, debug: { pauseOnStart: true },
    }) };
    await eventually(cancelStart.queued.runId, ['paused']);
    await request('rr_v3.pauseRun', { runId: cancelStart.queued.runId });
    const canceled = await request('rr_v3.cancelRun', {
      runId: cancelStart.queued.runId,
      reason: 'rust live scenario cancellation',
    });
    const cancelRun = await eventuallyTerminal(cancelStart.queued.runId);

    const mainEvents = await request('rr_v3.getEvents', { runId: mainStart.queued.runId });
    const liveFlows = await request('rr_v3.listFlows');
    port.disconnect();
    return {
      ids,
      mainStart, mainRun, mainEvents,
      retryStart, retryRun, retryEvents,
      cycleStart, cycleRun,
      pauseStart, paused, resumed, pauseRun,
      cancelStart, canceled, cancelRun,
      persistedFlowIds: liveFlows.filter((flow) => Object.values(ids).includes(flow.id)).map((flow) => flow.id),
    };
  `);
}

async function runLegacyCycleScenario(driver) {
  const flowId = `rust-live-legacy-cycle-${Date.now()}`;
  const now = new Date().toISOString();
  const flow = {
    id: flowId,
    name: 'Rust live legacy cycle order',
    version: 1,
    meta: { createdAt: now, updatedAt: now },
    nodes: [
      { id: 'first', type: 'delay', config: { sleep: 1 } },
      { id: 'second', type: 'delay', config: { sleep: 1 } },
    ],
    edges: [
      { id: 'first-second', from: 'first', to: 'second' },
      { id: 'second-first', from: 'second', to: 'first' },
    ],
  };
  const saved = await sendRuntimeMessage(driver, { type: 'rr_save_flow', flow });
  assert.equal(saved?.success, true, `legacy cycle save failed: ${JSON.stringify(saved)}`);
  const run = await sendRuntimeMessage(driver, { type: 'rr_run_flow', flowId });
  assert.equal(run?.success, true, `legacy cycle transport failed: ${JSON.stringify(run)}`);
  assert.equal(
    run?.result?.success,
    false,
    `legacy cycle was not rejected: ${JSON.stringify(run)}`,
  );
  assert(
    run.result?.logs?.some((entry) => /contains a cycle/i.test(String(entry?.message))),
    `legacy cycle result omitted its cycle error: ${JSON.stringify(run)}`,
  );
  const deleted = await sendRuntimeMessage(driver, { type: 'rr_delete_flow', flowId });
  assert.equal(deleted?.success, true, `legacy cycle cleanup failed: ${JSON.stringify(deleted)}`);
  return { flowId, result: run.result };
}

async function runLegacyImportScenario(driver) {
  const flowId = `rust-live-legacy-import-${Date.now()}`;
  const now = new Date().toISOString();
  const imported = await sendRuntimeMessage(driver, {
    type: 'rr_import_flow',
    json: JSON.stringify({
      id: flowId,
      name: 'Rust live tied-coordinate roots import',
      version: 1,
      meta: { createdAt: now, updatedAt: now },
      nodes: [
        { id: 'trigger', type: 'trigger', config: {}, ui: { x: 0, y: 0 } },
        { id: 'root-a', type: 'delay', config: { sleep: 1 }, ui: { x: 100, y: 100 } },
        { id: 'root-b', type: 'delay', config: { sleep: 1 }, ui: { x: 100, y: 100 } },
      ],
      edges: [],
    }),
  });
  assert.equal(
    imported?.success,
    true,
    `legacy RR_IMPORT_FLOW failed: ${JSON.stringify(imported)}`,
  );
  assert.equal(imported?.imported, 1, `legacy import count drifted: ${JSON.stringify(imported)}`);
  const persisted = await sendRuntimeMessage(driver, { type: 'rr_get_flow', flowId });
  assert.equal(
    persisted?.success,
    true,
    `legacy imported flow did not persist: ${JSON.stringify(persisted)}`,
  );
  const deleted = await sendRuntimeMessage(driver, { type: 'rr_delete_flow', flowId });
  assert.equal(deleted?.success, true, `legacy import cleanup failed: ${JSON.stringify(deleted)}`);
  return {
    flowId,
    persistedNodeIds: persisted.flow?.nodes?.map((node) => node.id) ?? [],
    warning: imported?.warning ?? null,
  };
}

async function runBuilderImportScenario(driver) {
  const flowId = `rust-live-builder-import-${Date.now()}`;
  const now = new Date().toISOString();
  const flow = {
    id: flowId,
    name: 'Rust live builder tied roots',
    version: 1,
    meta: { createdAt: now, updatedAt: now },
    nodes: [
      { id: 'trigger', type: 'trigger', config: {}, ui: { x: 0, y: 0 } },
      { id: 'root-b', type: 'delay', config: { sleep: 1 }, ui: { x: 100, y: 100 } },
      { id: 'root-a', type: 'delay', config: { sleep: 1 }, ui: { x: 100, y: 100 } },
    ],
    edges: [{ id: 'trigger-root-a', from: 'trigger', to: 'root-a' }],
  };
  await driver.reopen('builder.html');
  try {
    const result = await driver.evaluate(
      expression(`
      const deadline = Date.now() + 30000;
      let input;
      while (!(input = document.querySelector('input[type="file"][accept="application/json"]'))) {
        if (Date.now() >= deadline) throw new Error('Actual builder import control did not mount');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      const warnings = new Set();
      const collect = () => document.querySelectorAll('.rr-toast').forEach(toast => {
        if (toast.dataset.level === 'warn') warnings.add(toast.textContent.trim());
      });
      const observer = new MutationObserver(collect);
      observer.observe(document.querySelector('.rr-toast-container'), {
        childList: true, subtree: true, characterData: true,
      });
      const port = chrome.runtime.connect({ name: 'rr_v3' });
      let number = 0;
      const request = (method, params) => new Promise((resolve, reject) => {
        const requestId = 'rust-builder-' + (++number);
        const timer = setTimeout(() => reject(new Error(method + ' timed out')), 15000);
        const listener = message => {
          if (message?.type !== 'rr_v3.response' || message.requestId !== requestId) return;
          clearTimeout(timer);
          port.onMessage.removeListener(listener);
          if (message.ok) resolve(message.result);
          else reject(new Error(method + ': ' + message.error));
        };
        port.onMessage.addListener(listener);
        port.postMessage({ type: 'rr_v3.request', requestId, method, params });
      });
      try {
        const transfer = new DataTransfer();
        transfer.items.add(new File([${json(JSON.stringify(flow))}], 'rust-tied-roots.json', {
          type: 'application/json',
        }));
        input.files = transfer.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        let saved;
        while (!(saved = await request('rr_v3.getFlow', { flowId: ${json(flowId)} }))) {
          if (Date.now() >= deadline) {
            throw new Error('Builder import/save did not persist: ' + document.body.innerText);
          }
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        collect();
        await request('rr_v3.deleteFlow', { flowId: ${json(flowId)} });
        return { flow: saved, warnings: [...warnings] };
      } finally {
        observer.disconnect();
        port.disconnect();
      }
    `),
      40_000,
    );
    assert.equal(
      result.flow.entryNodeId,
      'root-a',
      'Builder import did not exclude the trigger and break tied roots by ID',
    );
    assert(
      result.warnings.some(
        (warning) =>
          warning.includes('root-a, root-b') &&
          warning.includes('selected "root-a" by ui(x=100, y=100)'),
      ),
      `Actual builder omitted the coordinate-root warning: ${json(result.warnings)}`,
    );
    return { flowId, entryNodeId: result.flow.entryNodeId, warnings: result.warnings };
  } finally {
    await driver.reopen();
  }
}

/** Exercises the public V3 port over a real extension page against persisted IndexedDB state. */
export async function runWorkflowScenario(driver) {
  const fixture = await findFixtureTab(driver);
  await driver.evaluate(`chrome.tabs.update(${json(fixture.tabId)}, { active: true })`);
  const { tabId, url } = fixture;
  await resetFixtureState(driver, tabId);
  const legacyCycle = await runLegacyCycleScenario(driver);
  const legacyImport = await runLegacyImportScenario(driver);
  const builderImport = await runBuilderImportScenario(driver);
  const evidence = await driver.evaluate(v3WorkflowExpression(tabId), DEFAULT_TIMEOUT_MS);
  assert.equal(
    evidence.mainRun?.status,
    'succeeded',
    `branching V3 run failed: ${JSON.stringify(evidence.mainRun)}`,
  );
  assert.equal(
    evidence.retryRun?.status,
    'failed',
    `retry V3 run did not fail after retries: ${JSON.stringify(evidence.retryRun)}`,
  );
  assert.equal(
    evidence.cycleRun?.status,
    'failed',
    `cyclic V3 flow was not rejected: ${JSON.stringify(evidence.cycleRun)}`,
  );
  assert.equal(
    evidence.cycleRun?.error?.code,
    'DAG_CYCLE',
    `cycle rejection code drifted: ${JSON.stringify(evidence.cycleRun)}`,
  );
  assert.equal(
    evidence.pauseRun?.status,
    'succeeded',
    `pause/resume V3 run failed: ${JSON.stringify(evidence.pauseRun)}`,
  );
  assert.equal(
    evidence.paused?.ok,
    true,
    `rr_v3.pauseRun failed: ${JSON.stringify(evidence.paused)}`,
  );
  assert.equal(
    evidence.resumed?.ok,
    true,
    `rr_v3.resumeRun failed: ${JSON.stringify(evidence.resumed)}`,
  );
  assert.equal(
    evidence.cancelRun?.status,
    'canceled',
    `canceled V3 run did not persist cancellation: ${JSON.stringify(evidence.cancelRun)}`,
  );
  assert.equal(
    evidence.canceled?.ok,
    true,
    `rr_v3.cancelRun failed: ${JSON.stringify(evidence.canceled)}`,
  );

  const retryAttempts = evidence.retryEvents.filter(
    (event) => event.type === 'node.started' && event.nodeId === 'missing',
  );
  assert.equal(
    retryAttempts.length,
    2,
    `retry workflow did not execute exactly twice: ${JSON.stringify(evidence.retryEvents)}`,
  );
  assert(
    evidence.persistedFlowIds.includes(evidence.ids.main),
    `saved workflow is absent from persistent V3 flow listing: ${JSON.stringify(evidence.persistedFlowIds)}`,
  );

  const fixtureState = await readFixtureState(driver, tabId);
  assert.equal(
    fixtureState.workflowClicks,
    1,
    `branching variable workflow did not click fixture: ${JSON.stringify(fixtureState)}`,
  );

  const mainEventSequences = evidence.mainEvents.map((event) => event.seq);
  assert(mainEventSequences.length > 0, 'main V3 run persisted no events');
  assert.deepEqual(
    mainEventSequences,
    [...mainEventSequences].sort((left, right) => left - right),
    `V3 event sequences are not monotonic: ${JSON.stringify(evidence.mainEvents)}`,
  );
  await cleanupFixtureTab(driver, fixture);

  return {
    tabId,
    fixtureUrl: url,
    ...evidence,
    legacyCycle,
    legacyImport,
    builderImport,
    workflowClicks: fixtureState.workflowClicks,
  };
}

/**
 * Called by the parent after its service-worker restart case. It proves that
 * the saved V3 records, run events and nextSeq survive the actual restart, then
 * removes only the records this scenario created.
 */
export async function verifyWorkflowAfterRestart(driver, evidence) {
  assert(evidence?.ids, 'workflow evidence with V3 IDs is required after restart');
  const result = await driver.evaluate(
    expression(`
      const ids = ${json(evidence.ids)};
      const port = chrome.runtime.connect({ name: 'rr_v3' });
      let number = 0;
      const request = (method, params = {}) => new Promise((resolve, reject) => {
        const requestId = 'rust-restart-' + (++number);
        const timer = setTimeout(() => reject(new Error(method + ' timed out')), ${json(POLL_TIMEOUT_MS)});
        const listener = (message) => {
          if (message?.type !== 'rr_v3.response' || message.requestId !== requestId) return;
          clearTimeout(timer);
          port.onMessage.removeListener(listener);
          if (message.ok) resolve(message.result);
          else reject(new Error(method + ': ' + message.error));
        };
        port.onMessage.addListener(listener);
        port.postMessage({ type: 'rr_v3.request', requestId, method, params });
      });
      const run = await request('rr_v3.getRun', { runId: ${json(evidence.mainStart.queued.runId)} });
      const events = await request('rr_v3.getEvents', { runId: ${json(evidence.mainStart.queued.runId)} });
      const flows = await Promise.all(Object.values(ids).map((flowId) => request('rr_v3.getFlow', { flowId })));
      const triggers = await request('rr_v3.listTriggers');
      for (const trigger of triggers.filter((item) => Object.values(ids).includes(item?.flowId))) {
        await request('rr_v3.deleteTrigger', { triggerId: trigger.id });
      }
      for (const flowId of Object.values(ids)) await request('rr_v3.deleteFlow', { flowId });
      port.disconnect();
      return { run, events, survivingFlows: flows.filter(Boolean).map((flow) => flow.id) };
    `),
    DEFAULT_TIMEOUT_MS,
  );

  assert.equal(
    result.run?.status,
    'succeeded',
    `main V3 run disappeared or changed after restart: ${JSON.stringify(result.run)}`,
  );
  assert(
    result.survivingFlows.includes(evidence.ids.main),
    `main V3 flow disappeared after restart: ${JSON.stringify(result.survivingFlows)}`,
  );
  assert(result.events.length > 0, 'persisted V3 events disappeared after restart');
  const maxSequence = Math.max(...result.events.map((event) => event.seq));
  assert.equal(
    result.run.nextSeq,
    maxSequence + 1,
    `nextSeq continuity failed after restart: ${JSON.stringify(result.run)}`,
  );

  return {
    mainRunId: evidence.mainStart.queued.runId,
    eventCount: result.events.length,
    nextSeq: result.run.nextSeq,
    survivingFlowIds: result.survivingFlows,
  };
}
