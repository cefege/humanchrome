#!/usr/bin/env node
// Drives the failing CDP sequence against a Chrome instance running with
// `--remote-debugging-port=<port>`. Prints a structured report comparing
// what CDP commands were sent vs which DOM events the page actually saw.
//
//   node repro.mjs --port 9222
//
// Expected output on Chrome for Testing 145:
//   * `keydown` and `keyup` events appear in window.__events (isTrusted:true)
//
// Observed output on stable Chrome 145:
//   * No `keydown` or `keyup` events anywhere
//   * `beforeinput` + `input` still fire from Input.insertText
//
// Implementation: connect over the WebSocket DevTools Protocol exposed by
// `--remote-debugging-port`, attach to the active tab, and issue
// Input.dispatchKeyEvent / Input.insertText / Runtime.evaluate directly.

import { parseArgs } from 'node:util';
import { WebSocket } from 'undici';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '9222' },
    char: { type: 'string', default: 'a' },
    'fixture-url-fragment': { type: 'string', default: 'fixture.html' },
  },
});
const PORT = values.port;
const CH = values.char;
const FIXTURE_URL_FRAGMENT = values['fixture-url-fragment'];

if (CH.length !== 1) {
  console.error('--char must be a single character');
  process.exit(2);
}

async function listTargets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json`);
  return res.json();
}

function makeRpc(ws) {
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
      else resolve(msg.result);
    }
  });
  return function rpc(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };
}

async function main() {
  const targets = await listTargets();
  const candidates = targets.filter(
    (t) => t.type === 'page' && t.url.includes(FIXTURE_URL_FRAGMENT),
  );
  if (candidates.length === 0) {
    console.error(
      `No tab matching "${FIXTURE_URL_FRAGMENT}" found. Open fixture.html in this Chrome first.`,
    );
    console.error('Available targets:');
    for (const t of targets) console.error(`  ${t.type} ${t.url.slice(0, 100)}`);
    process.exit(1);
  }
  const target = candidates[0];
  console.log(`[repro] connecting to ${target.url.slice(0, 100)}`);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.addEventListener('open', () => r(undefined), { once: true });
    ws.addEventListener('error', (e) => j(e), { once: true });
  });
  const rpc = makeRpc(ws);

  // Reset the fixture's capture log + focus the input.
  await rpc('Runtime.evaluate', {
    expression: `(() => { window.__events = []; document.getElementById('q').focus(); return document.activeElement?.id; })()`,
    returnByValue: true,
    awaitPromise: true,
  });

  // Issue the exact failing sequence humanchrome's typing path uses.
  const upperOrLower = CH.toUpperCase();
  const code = `Key${upperOrLower}`;
  const vk = upperOrLower.charCodeAt(0);
  const shift = CH !== CH.toLowerCase();

  console.log(`[repro] sending keyDown(${JSON.stringify({ key: CH, code, vk, shift })})`);
  await rpc('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: CH,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    unmodifiedText: CH.toLowerCase(),
    modifiers: shift ? 8 : 0,
  });
  console.log(`[repro] sending insertText(text:${JSON.stringify(CH)})`);
  await rpc('Input.insertText', { text: CH });
  console.log(`[repro] sending keyUp`);
  await rpc('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: CH,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    modifiers: shift ? 8 : 0,
  });

  // Give the renderer a beat in case anything's debounced.
  await new Promise((r) => setTimeout(r, 250));

  const observed = await rpc('Runtime.evaluate', {
    expression: `({ events: window.__events, val: document.getElementById('q')?.value })`,
    returnByValue: true,
  });
  const { events = [], val } = observed?.result?.value ?? {};

  console.log('');
  console.log('=== Observed DOM events ===');
  for (const e of events) {
    console.log(
      `  ${e.scope.padEnd(8)} ${e.type.padEnd(12)} isTrusted=${e.isTrusted} key=${JSON.stringify(e.key)}`,
    );
  }

  console.log('');
  console.log('=== Summary ===');
  console.log(`  input.value             : ${JSON.stringify(val)}`);
  console.log(`  keydown events fired    : ${events.filter((e) => e.type === 'keydown').length}`);
  console.log(`  keyup events fired      : ${events.filter((e) => e.type === 'keyup').length}`);
  console.log(`  keypress events fired   : ${events.filter((e) => e.type === 'keypress').length}`);
  console.log(`  input events fired      : ${events.filter((e) => e.type === 'input').length}`);
  console.log(`  beforeinput events fired: ${events.filter((e) => e.type === 'beforeinput').length}`);

  ws.close();
}

main().catch((e) => {
  console.error('[repro] failed:', e);
  process.exit(1);
});
