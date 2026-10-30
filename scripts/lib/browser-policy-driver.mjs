import assert from 'node:assert/strict';

async function connectCdp(url, onEvent) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 0;
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(String(data));
    if (message.method) {
      onEvent?.(message);
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('Owned Chrome CDP target disconnected'));
    }
    pending.clear();
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Owned Chrome CDP connection timed out')),
      30_000,
    );
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      'error',
      (event) => {
        clearTimeout(timer);
        reject(event.error ?? new Error('Owned Chrome CDP connection failed'));
      },
      { once: true },
    );
  });
  return {
    send(method, params = {}, timeoutMs = 120_000) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Owned Chrome ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try {
          socket.send(JSON.stringify({ id, method, params }));
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    },
    close() {
      socket.close();
    },
  };
}

/** Only used with the matrix's explicitly owned --launch-chrome profile. */
export async function createBrowserPolicyDriver({ cdpPort, extensionId, bridgeBase, fixtureUrl }) {
  assert(
    Number.isInteger(cdpPort) && cdpPort > 0,
    'Browser policy gates require an owned Chrome CDP port',
  );
  const cdpBase = `http://127.0.0.1:${cdpPort}`;
  let connection;
  let targetId;

  async function openPage(page = 'popup.html') {
    const url = `chrome-extension://${extensionId}/${page}`;
    const response = await fetch(`${cdpBase}/json/new?${encodeURIComponent(url)}`, {
      method: 'PUT',
    });
    assert(response.ok, `Cannot create owned extension probe page: HTTP ${response.status}`);
    const target = await response.json();
    targetId = target.id;
    let acceptContext;
    connection = await connectCdp(target.webSocketDebuggerUrl, (message) => {
      if (message.method !== 'Runtime.executionContextCreated') return;
      const context = message.params.context;
      if (context.auxData?.isDefault && context.origin === `chrome-extension://${extensionId}`) {
        acceptContext?.();
      }
    });
    // A newly created target can still be navigating out of its initial about:blank.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No extension execution context for ${page}`)), 30_000);
      acceptContext = () => {
        clearTimeout(timer);
        resolve();
      };
      connection.send('Runtime.enable').catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    await connection.send('Runtime.evaluate', {
      expression:
        'new Promise(resolve => { if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => resolve(true), {once:true}); else resolve(true); })',
      awaitPromise: true,
      returnByValue: true,
    });
  }

  async function closePage() {
    connection?.close();
    connection = undefined;
    if (targetId) {
      const id = targetId;
      targetId = undefined;
      await fetch(`${cdpBase}/json/close/${id}`).catch(() => {});
    }
  }
  async function connectTab(tabId) {
    const lookup = await connection.send('Runtime.evaluate', {
      expression: `chrome.debugger.getTargets().then(targets =>
        targets.find(target => target.tabId === ${JSON.stringify(tabId)}))`,
      awaitPromise: true,
      returnByValue: true,
    });
    const target = lookup.result?.value;
    assert(!lookup.exceptionDetails && target?.id,
      `No owned Chrome debugging target for tab ${tabId}: ${JSON.stringify(lookup)}`);
    const targets = await (await fetch(`${cdpBase}/json/list`)).json();
    const endpoint = targets.find(candidate => candidate.id === target.id);
    assert(endpoint?.webSocketDebuggerUrl, `No private CDP endpoint for tab ${tabId}`);
    return connectCdp(endpoint.webSocketDebuggerUrl);
  }


  await openPage();
  return {
    bridgeBase,
    fixtureUrl,
    extensionId,
    cdpPort,
    async evaluate(expression, timeoutMs = 120_000) {
      assert(connection, 'Owned extension probe page is closed');
      const result = await connection.send(
        'Runtime.evaluate',
        {
          expression,
          awaitPromise: true,
          returnByValue: true,
        },
        timeoutMs,
      );
      if (result.exceptionDetails) {
        throw new Error(
          result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
        );
      }
      return result.result?.value;
    },
    async evaluateTab(tabId, expression, { worldName, timeoutMs = 120_000 } = {}) {
      const tabConnection = await connectTab(tabId);
      try {
        let contextId;
        if (worldName) {
          const { frameTree } = await tabConnection.send('Page.getFrameTree');
          const world = await tabConnection.send('Page.createIsolatedWorld', {
            frameId: frameTree.frame.id,
            worldName,
          });
          contextId = world.executionContextId;
        }
        const result = await tabConnection.send(
          'Runtime.evaluate',
          {
            expression,
            ...(contextId === undefined ? {} : { contextId }),
            awaitPromise: true,
            returnByValue: true,
          },
          timeoutMs,
        );
        if (result.exceptionDetails) {
          throw new Error(
            result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
          );
        }
        return result.result?.value;
      } finally {
        tabConnection.close();
      }
    },
    async sendPageCommand(tabId, method, params = {}) {
      const tabConnection = await connectTab(tabId);
      try {
        return await tabConnection.send(method, params);
      } finally {
        tabConnection.close();
      }
    },
    async callTool(clientId, name, args = {}, timeoutMs = 120_000) {
      const response = await fetch(`${bridgeBase}/api/tools/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-client-id': clientId },
        body: JSON.stringify({ args }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const result = await response.json();
      const text = result.content?.find((item) => item.type === 'text')?.text;
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* Tool text is not necessarily JSON. */
      }
      return { ...result, parsed };
    },
    async releaseClient(clientId) {
      const response = await fetch(
        `${bridgeBase}/api/clients/${encodeURIComponent(clientId)}/release`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-client-id': clientId },
          body: '{}',
          signal: AbortSignal.timeout(30_000),
        },
      );
      assert(response.ok, `Client release failed: HTTP ${response.status}`);
      return response.json();
    },
    async restartServiceWorker() {
      const targets = await (await fetch(`${cdpBase}/json/list`)).json();
      const oldWorker = targets.find(
        (target) =>
          target.type === 'service_worker' &&
          target.url.startsWith(`chrome-extension://${extensionId}/`),
      );
      assert(oldWorker, 'Owned extension service worker is not running before restart');
      const realmToken = `owned-worker-${Date.now()}-${Math.random()}`;
      const workerConnection = await connectCdp(oldWorker.webSocketDebuggerUrl);
      let closedOffscreen;
      try {
        closedOffscreen = await workerConnection.send('Runtime.evaluate', {
          expression: `(async () => {
            globalThis.__hcPolicyRealmProbe = ${JSON.stringify(realmToken)};
            const contexts = await chrome.runtime.getContexts({contextTypes: ['OFFSCREEN_DOCUMENT']});
            if (!contexts.length) return false;
            await chrome.offscreen.closeDocument();
            return true;
          })()`,
          awaitPromise: true,
          returnByValue: true,
        });
      } finally {
        workerConnection.close();
      }
      assert.equal(closedOffscreen.result?.value, true,
        `Real offscreen index was not closed before persistence proof: ${JSON.stringify(closedOffscreen)}`);
      await connection.send('ServiceWorker.enable');
      let lifecycleResult;
      const lifecycle = (async () => {
        // This driver is restricted to the matrix-owned browser profile.
        await connection.send('ServiceWorker.stopAllWorkers', {}, 10_000);
        return this.evaluate(`chrome.runtime.sendMessage({type: 'get_server_status'})`);
      })().then(result => (lifecycleResult = { result }), error => (lifecycleResult = { error }));
      const deadline = Date.now() + 30_000;
      const httpChecks = [];
      let newWorker;
      while (Date.now() < deadline) {
        const health = await fetch(`${bridgeBase}/ping`, { signal: AbortSignal.timeout(2_000) });
        httpChecks.push(health.status);
        assert(health.ok, `Native HTTP became unavailable during SW restart: ${health.status}`);
        const current = await (await fetch(`${cdpBase}/json/list`)).json();
        if (lifecycleResult?.error) throw lifecycleResult.error;
        const candidate = current.find(target =>
          target.type === 'service_worker' &&
          target.url.startsWith(`chrome-extension://${extensionId}/`));
        if (candidate && lifecycleResult) {
          const probe = await connectCdp(candidate.webSocketDebuggerUrl);
          try {
            const realm = await probe.send('Runtime.evaluate', {
              expression: 'globalThis.__hcPolicyRealmProbe',
              returnByValue: true,
            });
            if (!realm.exceptionDetails && realm.result?.type === 'undefined') {
              newWorker = candidate;
              break;
            }
          } finally {
            probe.close();
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await lifecycle;
      assert(newWorker, 'Owned extension did not create a fresh service-worker realm after restart');
      if (lifecycleResult.error) throw lifecycleResult.error;
      const status = await this.evaluate(
        `(async () => {
        const deadline = Date.now() + 30000;
        let status;
        while (Date.now() < deadline) {
          status = await chrome.runtime.sendMessage({type: 'get_server_status'});
          if (status?.connected && status?.serverStatus?.isRunning &&
              status.serverStatus.port === ${JSON.stringify(new URL(bridgeBase).port ? Number(new URL(bridgeBase).port) : 80)}) return status;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error('Native connection not restored after SW restart: ' + JSON.stringify(status));
      })()`,
        35_000,
      );
      // A Chrome native Port can be open before its relay is attached to the bridge.
      // Probe the real read-only channel, not the cached UI server status.
      const readinessClient = 'rust-restart-readiness';
      const channelDeadline = Date.now() + 30_000;
      let nativeChannel;
      let nativeChannelAttempts = 0;
      while (Date.now() < channelDeadline) {
        nativeChannelAttempts++;
        const response = await this.callTool(readinessClient, 'chrome_owned_tabs', {}, 5_000);
        if (!response.isError) {
          nativeChannel = response.parsed;
          break;
        }
        const message = response.parsed?.error?.message;
        assert(
          message === 'Bridge has no active native-messaging source (SW reconnecting)' ||
            message === 'Native host source disconnected — request aborted',
          `Unexpected native channel readiness failure: ${JSON.stringify(response)}`,
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert(nativeChannel, 'Fresh SW native relay did not answer the read-only readiness probe');
      await this.releaseClient(readinessClient);
      return {
        previousWorkerId: oldWorker.id,
        workerId: newWorker.id,
        freshWorkerRealm: true,
        closedOffscreenForPersistence: true,
        httpChecks,
        status,
        nativeChannel,
        nativeChannelAttempts,
      };
    },
    async reopen(page = 'popup.html') {
      await closePage();
      await openPage(page);
    },
    async verifySidepanelData() {
      const fixture = `rust-csp-${Date.now()}`;
      const projectName = `${fixture}-project`;
      const sessionName = `${fixture}-session`;
      async function request(path, method = 'GET', body) {
        const response = await fetch(`${bridgeBase}${path}`, {
          method,
          headers: body === undefined ? {} : { 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(30_000),
        });
        const text = await response.text();
        assert(response.ok, `${method} ${path}: HTTP ${response.status}: ${text}`);
        return text ? JSON.parse(text) : undefined;
      }
      const workspace = await request('/agent/projects/default-root', 'POST', { projectName });
      const { project } = await request('/agent/projects', 'POST', {
        name: projectName,
        rootPath: workspace.path,
        allowCreate: true,
      });
      try {
        const { session } = await request(
          `/agent/projects/${encodeURIComponent(project.id)}/sessions`,
          'POST',
          {
            engineName: 'codex',
            name: sessionName,
          },
        );
        await this.reopen('sidepanel.html');
        const displayed = await this.evaluate(
          `(async () => {
          const projectName = ${JSON.stringify(projectName)};
          const sessionName = ${JSON.stringify(sessionName)};
          const deadline = Date.now() + 30000;
          let opened = false;
          while (Date.now() < deadline) {
            if (!opened) {
              document.querySelector('button[aria-label="Back to sessions"]')?.click();
              const card = [...document.querySelectorAll('[role="button"]')]
                .find(element => element.getAttribute('aria-label') === 'Open session ' + sessionName);
              if (card && card.getClientRects().length) {
                card.click();
                opened = true;
              }
            } else {
              const visibleText = document.body.innerText;
              if (visibleText.includes(projectName) && visibleText.includes(sessionName)) {
                return { projectName, sessionName, openedSession: true };
              }
            }
            await new Promise(resolve => setTimeout(resolve, 25));
          }
          throw new Error('Actual sidepanel did not load the persisted project/session: ' + document.body.innerText);
        })()`,
          35_000,
        );
        return { projectId: project.id, sessionId: session.id, ...displayed };
      } finally {
        await this.reopen();
        await request(`/agent/projects/${encodeURIComponent(project.id)}`, 'DELETE');
      }
    },
    async verifyRendererReadiness() {
      const realms = [];
      try {
        for (const page of [
          'popup.html',
          'options.html',
          'sidepanel.html',
          'builder.html',
          'welcome.html',
        ]) {
          await this.reopen(page);
          const result = await this.evaluate(
            `(async () => {
            const deadline = Date.now() + 30000;
            while (Date.now() < deadline) {
              if (document.querySelector('#app')?.children.length) {
                return { mounted: true };
              }
              await new Promise(resolve => setTimeout(resolve, 25));
            }
            throw new Error('Packaged renderer did not mount: ' + location.href);
          })()`,
            35_000,
          );
          realms.push({ page, ...result });
        }
      } finally {
        await this.reopen();
      }
      return realms;
    },
    close: closePage,
  };
}
