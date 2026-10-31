import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE_SECTION = 'rust-6-editor';
const FIXTURE_TARGET = 'rust-editor-target';
const SHADOW_HOST_SELECTOR = '[data-mcp-web-editor="v2"]';
const OPACITY_VALUE = '0.42';
const POLL_INTERVAL_MS = 75;
const POLL_TIMEOUT_MS = 15_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (value) => JSON.stringify(value);

function fixtureUrl(driver) {
  const url = new URL(driver.fixtureUrl);
  url.hash = FIXTURE_SECTION;
  return url.toString();
}

async function waitFor(label, probe, predicate = (value) => Boolean(value)) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let last;
  while (Date.now() < deadline) {
    last = await probe();
    if (predicate(last)) return last;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`${label} did not become ready: ${json(last)}`);
}

async function createAndForegroundFixture(driver, url) {
  const fixture = await driver.evaluate(`
    (async () => {
      const url = ${json(url)};
      const tab = await chrome.tabs.create({ url, active: false });
      if (typeof tab.id !== 'number' || typeof tab.windowId !== 'number') {
        throw new Error('chrome.tabs.create did not return an owned tab and window id');
      }
      const deadline = Date.now() + 15_000;
      let current = tab;
      while (Date.now() < deadline) {
        current = await chrome.tabs.get(tab.id);
        if (current.status === 'complete' && current.url === url) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (current.status !== 'complete' || current.url !== url) {
        throw new Error('owned editor fixture did not finish loading: ' + JSON.stringify(current));
      }
      await chrome.windows.update(tab.windowId, { focused: true });
      const foreground = await chrome.tabs.update(tab.id, { active: true });
      const active = await chrome.tabs.query({ active: true, currentWindow: true });
      if (active[0]?.id !== tab.id || foreground.id !== tab.id) {
        throw new Error('owned editor fixture was not foregrounded before toggle: ' + JSON.stringify(active));
      }
      return { tabId: tab.id, windowId: tab.windowId, url: current.url };
    })()
  `);
  assert.equal(typeof fixture?.tabId, 'number', `owned fixture missing tab id: ${json(fixture)}`);
  return fixture;
}

async function toggleEditor(driver, expectedActive) {
  const response = await driver.evaluate(`
    chrome.runtime.sendMessage({ type: 'web_editor_toggle' })
  `);
  assert.equal(
    response?.success,
    true,
    `web_editor_toggle did not reach the active fixture: ${json(response)}`,
  );
  assert.equal(
    response?.active,
    expectedActive,
    `web_editor_toggle active state was not ${expectedActive}: ${json(response)}`,
  );
  return response;
}

async function foreground(driver, fixture) {
  await driver.evaluate(`
    (async () => {
      await chrome.windows.update(${json(fixture.windowId)}, { focused: true });
      await chrome.tabs.update(${json(fixture.tabId)}, { active: true });
      const active = await chrome.tabs.query({ active: true, currentWindow: true });
      if (active[0]?.id !== ${json(fixture.tabId)}) {
        throw new Error('fixture tab is no longer active: ' + JSON.stringify(active));
      }
    })()
  `);
}

async function editorSurface(driver, tabId, { scrollTarget = false } = {}) {
  return driver.evaluateTab(
    tabId,
    `(() => {
      const target = document.querySelector(${json(`#${FIXTURE_TARGET}`)});
      if (target && ${scrollTarget}) target.scrollIntoView({ block: 'center', inline: 'center' });
      const host = document.querySelector(${json(SHADOW_HOST_SELECTOR)});
      const shadow = host?.shadowRoot ?? null;
      const panel = shadow?.querySelector('.we-prop-panel') ?? null;
      const opacity = shadow?.querySelector('input[aria-label="Opacity value"]') ?? null;
      if (opacity && ${scrollTarget}) opacity.scrollIntoView({ block: 'center', inline: 'nearest' });
      const targetRect = target?.getBoundingClientRect();
      const opacityRect = opacity?.getBoundingClientRect();
      return {
        host: !!host,
        openShadowRoot: !!shadow,
        toolbar: !!shadow?.querySelector('[role="toolbar"][aria-label="Web Editor Toolbar"]'),
        panel: !!panel,
        panelEmpty: panel?.dataset.empty ?? null,
        selectedLabel: shadow?.querySelector('.we-prop-target')?.textContent ?? null,
        opacityDisabled: opacity instanceof HTMLInputElement ? opacity.disabled : null,
        opacityValue: opacity instanceof HTMLInputElement ? opacity.value : null,
        targetStyleOpacity: target instanceof HTMLElement ? target.style.opacity : null,
        targetComputedOpacity: target ? getComputedStyle(target).opacity : null,
        targetPoint: targetRect
          ? { x: targetRect.left + targetRect.width / 2, y: targetRect.top + targetRect.height / 2 }
          : null,
        opacityPoint: opacityRect
          ? { x: opacityRect.left + opacityRect.width / 2, y: opacityRect.top + opacityRect.height / 2 }
          : null,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        platform: navigator.platform,
      };
    })()`,
  );
}

function assertVisiblePoint(point, label, surface) {
  assert(
    point &&
      Number.isFinite(point.x) &&
      Number.isFinite(point.y) &&
      point.x >= 0 &&
      point.y >= 0 &&
      point.x <= surface.viewport?.width &&
      point.y <= surface.viewport?.height,
    `${label} has no visible interaction point: ${json(surface)}`,
  );
}

async function dispatchPointerClick(driver, tabId, point) {
  const params = { x: point.x, y: point.y, button: 'left', clickCount: 1 };
  await driver.sendPageCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: point.x,
    y: point.y,
    button: 'none',
    buttons: 0,
  });
  await driver.sendPageCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    buttons: 1,
    ...params,
  });
  await driver.sendPageCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    buttons: 0,
    ...params,
  });
}

async function editOpacity(driver, tabId, point, platform) {
  await dispatchPointerClick(driver, tabId, point);
  const selectAllModifiers = String(platform).includes('Mac') ? 4 : 2;
  await driver.sendPageCommand(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
    modifiers: selectAllModifiers,
    commands: ['selectAll'],
  });
  await driver.sendPageCommand(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
    modifiers: selectAllModifiers,
  });
  await driver.sendPageCommand(tabId, 'Input.insertText', { text: OPACITY_VALUE });
  await driver.sendPageCommand(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
  });
  await driver.sendPageCommand(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
  });
}

async function captureEditorScreenshot(driver, tabId) {
  const screenshot = await driver.sendPageCommand(tabId, 'Page.captureScreenshot', {
    format: 'png',
  });
  assert.equal(typeof screenshot?.data, 'string', `CDP did not return an editor screenshot: ${json(screenshot)}`);
  return Buffer.from(screenshot.data, 'base64');
}

function persistScreenshot(bytes) {
  const evidenceDir = process.env.HC_E2E_EVIDENCE_DIR || resolve(REPO_ROOT, 'target/rust-transition');
  const path = resolve(evidenceDir, 'browser-rust-6-editor.png');
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(path, bytes);
  return {
    path,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

async function closeFixtureEditor(driver, fixture) {
  await foreground(driver, fixture);
  const surface = await editorSurface(driver, fixture.tabId);
  if (surface.host) {
    await toggleEditor(driver, false);
    await waitFor(
      'web editor overlay cleanup',
      () => editorSurface(driver, fixture.tabId),
      (state) => state.host === false,
    );
  }
}

/**
 * Exercises the shipped Web Editor V2 surface through its public background
 * toggle route and real Chrome pointer/keyboard CDP input. DOM reads only
 * observe the independently mounted overlay and fixture target.
 */
export async function runEditorScenario(driver) {
  const url = fixtureUrl(driver);
  let fixture;
  let editorStarted = false;
  try {
    fixture = await createAndForegroundFixture(driver, url);
    const toggle = await toggleEditor(driver, true);
    editorStarted = true;

    const mounted = await waitFor(
      'Web Editor V2 open shadow overlay',
      () => editorSurface(driver, fixture.tabId),
      (state) => state.host && state.openShadowRoot && state.toolbar && state.panel,
    );

    const targetSurface = await editorSurface(driver, fixture.tabId, { scrollTarget: true });
    assertVisiblePoint(targetSurface.targetPoint, 'fixture editor target', targetSurface);
    await dispatchPointerClick(driver, fixture.tabId, targetSurface.targetPoint);

    const selected = await waitFor(
      'fixture target selection through pointer interaction',
      () => editorSurface(driver, fixture.tabId, { scrollTarget: true }),
      (state) =>
        state.panelEmpty === 'false' &&
        state.selectedLabel === `button#${FIXTURE_TARGET}` &&
        state.opacityDisabled === false,
    );
    assertVisiblePoint(selected.opacityPoint, 'opacity editor input', selected);

    await editOpacity(driver, fixture.tabId, selected.opacityPoint, selected.platform);
    const edited = await waitFor(
      'opacity style edit through Web Editor property input',
      () => editorSurface(driver, fixture.tabId),
      (state) => state.targetStyleOpacity === OPACITY_VALUE && state.opacityValue === OPACITY_VALUE,
    );
    const screenshot = persistScreenshot(await captureEditorScreenshot(driver, fixture.tabId));

    await closeFixtureEditor(driver, fixture);
    editorStarted = false;
    const fixtureEvidence = {
      tabId: fixture.tabId,
      url: fixture.url,
      selector: `#${FIXTURE_TARGET}`,
    };
    await driver.evaluate(`chrome.tabs.remove(${json(fixture.tabId)})`);
    fixture = undefined;

    return {
      fixture: fixtureEvidence,
      toggle,
      mounted,
      selected,
      edited,
      screenshot,
    };
  } finally {
    if (fixture) {
      try {
        if (editorStarted) await closeFixtureEditor(driver, fixture);
      } finally {
        await driver.evaluate(`chrome.tabs.remove(${json(fixture.tabId)}).catch(() => {})`);
      }
    }
  }
}
