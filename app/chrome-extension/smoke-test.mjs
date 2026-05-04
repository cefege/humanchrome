#!/usr/bin/env node
/**
 * Standalone unit tests for the extension-side patches that don't need
 * a running browser:
 *
 *   T1, T2 — Patch 1 redaction toggle (rawOutput flag)
 *   T4, T5 — Patch 2 chrome_javascript expression auto-return wrapping
 *
 * Patches 4 (fill-helper React events) and 5 (intercept-response) need a
 * live Chrome session and are exercised in the live test matrix.
 *
 * Usage: node smoke-test.mjs   (from app/chrome-extension/)
 *
 * The test re-implements the patched logic inline (mirroring the source)
 * because the source is TypeScript with WXT-specific aliases that don't
 * resolve in plain Node. Each block flags drift from the source — when the
 * source changes, update both. They're tiny.
 */

let passed = 0;
let failed = 0;
const log = (label, ok, extra) => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${extra ? ' — ' + extra : ''}`);
  if (ok) passed += 1;
  else failed += 1;
};

// ---------------------------------------------------------------------------
// Patch 1 — sanitizeText with rawOutput bypass.
// Mirrors app/chrome-extension/utils/output-sanitizer.ts
// ---------------------------------------------------------------------------

let rawOutputCache = false;
function isRawOutputEnabled() {
  return rawOutputCache === true;
}
function sanitizeText(text) {
  if (isRawOutputEnabled()) {
    return { text, redacted: false };
  }
  // Stripped-down version of the upstream regex pipeline — enough to verify
  // the bypass branch. The full regex pipeline is exercised by Chrome at runtime.
  if (/^[A-Za-z0-9+/]{20,}={0,2}$/.test(text)) {
    return { text: '[BLOCKED: Base64 encoded data]', redacted: true };
  }
  let out = text;
  let redacted = false;
  const next = out.replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '<redacted_base64>');
  if (next !== out) {
    out = next;
    redacted = true;
  }
  return { text: out, redacted };
}

// T1 — with raw flag, a long base64-shaped URN comes through verbatim.
{
  rawOutputCache = true;
  const URN = 'urn:li:fsd_messagingThread:2-' + 'a'.repeat(50);
  const r = sanitizeText(URN);
  log('T1 raw flag ON: long URN preserved', r.text === URN && r.redacted === false, r.text.slice(0, 60));
  rawOutputCache = false;
}

// T2 — flag off (default): long base64 substrings get redacted.
{
  const URN = 'urn:li:fsd_messagingThread:2-' + 'a'.repeat(50);
  const r = sanitizeText(URN);
  const ok = r.text.includes('<redacted_base64>') && r.redacted === true;
  log('T2 raw flag OFF: long URN redacted', ok, r.text.slice(0, 80));
}

// ---------------------------------------------------------------------------
// Patch 2 — wrapUserCode auto-return for bare expressions.
// Mirrors app/chrome-extension/entrypoints/background/tools/browser/javascript.ts
// ---------------------------------------------------------------------------

const AsyncFunctionCtor = Object.getPrototypeOf(async function () {}).constructor;

function isExpressionForm(code) {
  const trimmed = code.trim();
  if (!trimmed) return false;
  if (/[;{}]/.test(trimmed)) return false;
  if (
    /^\s*(let|const|var|return|if|for|while|do|switch|try|throw|function|class|async\s+function)\b/.test(
      trimmed,
    )
  ) {
    return false;
  }
  try {
    new AsyncFunctionCtor(`return (${trimmed});`);
    return true;
  } catch {
    return false;
  }
}

function wrapUserCode(code) {
  if (isExpressionForm(code)) {
    return `(async () => { return (${code.trim()}); })()`;
  }
  return `(async () => {\n${code}\n})()`;
}

// Validate by actually evaluating the wrapped code. Since we wrap as
// (async () => { ... })(), each eval returns a Promise.
async function evalWrapped(code) {
  const wrapped = wrapUserCode(code);
  return await eval(wrapped);  
}

// T4 — bare expression auto-returns.
{
  const v = await evalWrapped('1+2');
  log('T4 bare expression "1+2" evaluates to 3 (was undefined)', v === 3, String(v));
}

// T5 — statement form with explicit return still works.
{
  const v = await evalWrapped('const x = 2; return x + 1;');
  log('T5 statement "const x=2; return x+1" still returns 3', v === 3, String(v));
}

// T6 — top-level await still works.
{
  const v = await evalWrapped('await new Promise(r => setTimeout(() => r(42), 30))');
  log('T6 expression form with await returns 42', v === 42, String(v));
}

// Robustness — multi-statement input falls through to statement-block.
{
  const v = await evalWrapped('let arr = [1,2,3]; return arr.length;');
  log('robustness: multi-statement still works', v === 3, String(v));
}

// Robustness — empty / whitespace returns undefined cleanly.
{
  const v = await evalWrapped('');
  log('robustness: empty input is undefined', v === undefined, String(v));
}

// ---------------------------------------------------------------------------
// Structured error envelope.
// Mirrors packages/shared/src/error-codes.ts + app/chrome-extension/common/tool-handler.ts.
// ---------------------------------------------------------------------------

const ToolErrorCode = {
  TAB_NOT_FOUND: 'TAB_NOT_FOUND',
  TAB_CLOSED: 'TAB_CLOSED',
  CDP_BUSY: 'CDP_BUSY',
  INVALID_ARGS: 'INVALID_ARGS',
  UNKNOWN: 'UNKNOWN',
};

function serializeToolError(code, message, details) {
  const env = { error: { code, message, ...(details ? { details } : {}) } };
  return JSON.stringify(env);
}

function createErrorResponseMirror(
  message = 'Unknown error, please try again',
  code = ToolErrorCode.UNKNOWN,
  details,
) {
  return {
    content: [{ type: 'text', text: serializeToolError(code, message, details) }],
    isError: true,
  };
}

// T9 — legacy single-arg call still works; defaults to UNKNOWN code.
{
  const r = createErrorResponseMirror('boom');
  const parsed = JSON.parse(r.content[0].text);
  log(
    'T9 legacy createErrorResponse(msg) → UNKNOWN envelope, isError true',
    r.isError === true && parsed.error.code === 'UNKNOWN' && parsed.error.message === 'boom',
    JSON.stringify(parsed),
  );
}

// T10 — explicit code + details serializes correctly and is parseable.
{
  const r = createErrorResponseMirror('tab gone', ToolErrorCode.TAB_CLOSED, { tabId: 42 });
  const parsed = JSON.parse(r.content[0].text);
  log(
    'T10 createErrorResponse(msg, code, details) → structured envelope',
    parsed.error.code === 'TAB_CLOSED' &&
      parsed.error.message === 'tab gone' &&
      parsed.error.details &&
      parsed.error.details.tabId === 42,
    JSON.stringify(parsed),
  );
}

// T11 — envelope text is valid JSON, code-aware, and contains the human message.
{
  const r = createErrorResponseMirror('cdp attached elsewhere', ToolErrorCode.CDP_BUSY);
  log(
    'T11 envelope text contains both message and code',
    r.content[0].text.includes('"cdp attached elsewhere"') &&
      r.content[0].text.includes('"CDP_BUSY"'),
    r.content[0].text,
  );
}

// ---------------------------------------------------------------------------
// Navigation-guard URL/document comparison.
// Mirrors the comparison primitives in app/chrome-extension/entrypoints/background/tools/base-browser.ts.
// ---------------------------------------------------------------------------

function stripHash(url) {
  const i = url.indexOf('#');
  return i === -1 ? url : url.slice(0, i);
}

function compareSnapshots(snap, current, ignoreHashOnly = true) {
  // Mirrors assertSameDocument's decision tree without chrome.* deps.
  if (snap.documentId && current.documentId && current.documentId !== snap.documentId) {
    return { navigated: true, reason: 'documentId-changed' };
  }
  if (!snap.documentId || !current.documentId) {
    const before = ignoreHashOnly ? stripHash(snap.url) : snap.url;
    const after = ignoreHashOnly ? stripHash(current.url) : current.url;
    if (before && after && before !== after) {
      return { navigated: true, reason: 'url-changed' };
    }
  }
  return { navigated: false };
}

// T12 — same documentId across calls = no navigation.
{
  const snap = { url: 'https://a.test/x', documentId: 'doc-1' };
  const cur = { url: 'https://a.test/x', documentId: 'doc-1' };
  const r = compareSnapshots(snap, cur);
  log('T12 same document = no navigation', r.navigated === false, JSON.stringify(r));
}

// T13 — documentId changed = TARGET_NAVIGATED_AWAY.
{
  const snap = { url: 'https://a.test/x', documentId: 'doc-1' };
  const cur = { url: 'https://b.test/y', documentId: 'doc-2' };
  const r = compareSnapshots(snap, cur);
  log(
    'T13 documentId change → navigated=true, reason=documentId-changed',
    r.navigated === true && r.reason === 'documentId-changed',
    JSON.stringify(r),
  );
}

// T14 — hash-only URL change (no documentId available) = NOT navigation.
{
  const snap = { url: 'https://a.test/x' }; // no documentId — fallback path
  const cur = { url: 'https://a.test/x#section-2' };
  const r = compareSnapshots(snap, cur);
  log('T14 hash-only change is not navigation', r.navigated === false, JSON.stringify(r));
}

// T15 — URL change without documentId fallback path catches navigation.
{
  const snap = { url: 'https://a.test/x' };
  const cur = { url: 'https://a.test/y' };
  const r = compareSnapshots(snap, cur);
  log(
    'T15 url-only change → navigated=true, reason=url-changed',
    r.navigated === true && r.reason === 'url-changed',
    JSON.stringify(r),
  );
}

// ---------------------------------------------------------------------------
// Per-client tab-resolution priority.
// Mirrors resolveTabIdForClient in app/chrome-extension/entrypoints/background/utils/client-state.ts.
// ---------------------------------------------------------------------------

const FAKE_STATE = new Map();

function recordClientTab(clientId, tabId) {
  if (!clientId || typeof tabId !== 'number') return;
  FAKE_STATE.set(clientId, { lastTabId: tabId, lastSeenAt: Date.now() });
}

function resolveSync(clientId, explicitTabId) {
  if (typeof explicitTabId === 'number') return explicitTabId;
  if (!clientId) return undefined;
  return FAKE_STATE.get(clientId)?.lastTabId;
}

// T16 — explicit tabId always wins, regardless of client preference.
{
  recordClientTab('client-A', 100);
  const r = resolveSync('client-A', 200);
  log('T16 explicit tabId beats stored preference', r === 200, String(r));
}

// T17 — implicit call uses client's last tab.
{
  recordClientTab('client-B', 300);
  const r = resolveSync('client-B', undefined);
  log('T17 implicit call returns stored preference', r === 300, String(r));
}

// T18 — different clients keep separate preferences (no cross-talk).
{
  recordClientTab('client-X', 400);
  recordClientTab('client-Y', 500);
  const rx = resolveSync('client-X', undefined);
  const ry = resolveSync('client-Y', undefined);
  log('T18 per-client preferences are isolated', rx === 400 && ry === 500, `${rx},${ry}`);
}

// T19 — no clientId means we never inject; caller falls back as before.
{
  const r = resolveSync(undefined, undefined);
  log('T19 no clientId → undefined (caller uses old path)', r === undefined, String(r));
}

// ---------------------------------------------------------------------------
// Per-tab FIFO lock + timeout.
// Mirrors acquireTabLock in app/chrome-extension/entrypoints/background/utils/tab-lock.ts
// without the ToolError wrapper; behavior must match to the millisecond.
// ---------------------------------------------------------------------------

class LockTimeoutError extends Error {
  constructor(tabId, timeoutMs) {
    super(`Lock for tab ${tabId} timed out after ${timeoutMs}ms`);
    this.code = 'TAB_LOCK_TIMEOUT';
  }
}

function makeLockRegistry() {
  const queues = new Map();
  async function acquire(tabId, { timeoutMs = 10000 } = {}) {
    const prev = queues.get(tabId) ?? Promise.resolve();
    let releaseNext;
    const next = new Promise((resolve) => {
      releaseNext = resolve;
    });
    queues.set(tabId, next);
    let timer;
    try {
      await Promise.race([
        prev.catch(() => undefined),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new LockTimeoutError(tabId, timeoutMs)), timeoutMs);
        }),
      ]);
    } catch (err) {
      clearTimeout(timer);
      releaseNext();
      if (queues.get(tabId) === next) queues.delete(tabId);
      throw err;
    }
    clearTimeout(timer);
    return () => {
      releaseNext();
      if (queues.get(tabId) === next) queues.delete(tabId);
    };
  }
  return { acquire, size: () => queues.size };
}

// T20 — sequential acquires on same tab are FIFO and don't overlap.
{
  const reg = makeLockRegistry();
  const order = [];
  const a = (async () => {
    const r = await reg.acquire(7);
    order.push('A-in');
    await new Promise((r2) => setTimeout(r2, 30));
    order.push('A-out');
    r();
  })();
  // Tiny delay so B is scheduled after A queued.
  const b = (async () => {
    await new Promise((r) => setTimeout(r, 5));
    const r = await reg.acquire(7);
    order.push('B-in');
    r();
  })();
  await Promise.all([a, b]);
  log(
    'T20 same-tab acquires are FIFO with no overlap',
    JSON.stringify(order) === JSON.stringify(['A-in', 'A-out', 'B-in']),
    JSON.stringify(order),
  );
}

// T21 — different tabs run in parallel.
{
  const reg = makeLockRegistry();
  const order = [];
  const a = (async () => {
    const r = await reg.acquire(1);
    order.push('A-in');
    await new Promise((r2) => setTimeout(r2, 30));
    order.push('A-out');
    r();
  })();
  const b = (async () => {
    await new Promise((r) => setTimeout(r, 5));
    const r = await reg.acquire(2);
    order.push('B-in');
    await new Promise((r2) => setTimeout(r2, 30));
    order.push('B-out');
    r();
  })();
  await Promise.all([a, b]);
  // B-in must come BEFORE A-out — proves they ran in parallel.
  const aOut = order.indexOf('A-out');
  const bIn = order.indexOf('B-in');
  log(
    'T21 different tabs run in parallel (B starts before A finishes)',
    bIn < aOut,
    JSON.stringify(order),
  );
}

// ---------------------------------------------------------------------------
// Unified truncation envelope.
// Mirrors truncateString / truncateArray in app/chrome-extension/utils/truncate.ts.
// ---------------------------------------------------------------------------

function truncateStringMirror(text, maxBytes, mode = 'preview') {
  const enc = new TextEncoder();
  const originalSize = enc.encode(text).length;
  if (mode === 'raw' || originalSize <= maxBytes) {
    return { data: text, truncated: false, originalSize, limit: maxBytes, rawAvailable: false };
  }
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (enc.encode(text.slice(0, mid)).length <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return {
    data: text.slice(0, lo),
    truncated: true,
    originalSize,
    limit: maxBytes,
    rawAvailable: true,
  };
}

function truncateArrayMirror(arr, maxItems, mode = 'preview') {
  if (mode === 'raw' || arr.length <= maxItems) {
    return {
      data: arr,
      truncated: false,
      originalSize: arr.length,
      limit: maxItems,
      rawAvailable: false,
    };
  }
  return {
    data: arr.slice(0, maxItems),
    truncated: true,
    originalSize: arr.length,
    limit: maxItems,
    rawAvailable: true,
  };
}

// T_trunc1 — under-limit string is unchanged, rawAvailable=false.
{
  const r = truncateStringMirror('hello', 100);
  log(
    'T_trunc1 under-limit string passes through',
    r.truncated === false && r.data === 'hello' && r.rawAvailable === false,
    JSON.stringify(r),
  );
}

// T_trunc2 — over-limit byte cap truncates and signals raw is available.
{
  const r = truncateStringMirror('hello world this is long', 8);
  log(
    'T_trunc2 over-limit string truncates with rawAvailable=true',
    r.truncated === true && r.rawAvailable === true && r.originalSize === 24 && r.limit === 8,
    JSON.stringify(r),
  );
}

// T_trunc3 — raw mode returns full payload regardless of cap.
{
  const r = truncateStringMirror('hello world', 3, 'raw');
  log(
    'T_trunc3 raw mode skips truncation',
    r.truncated === false && r.data === 'hello world',
    JSON.stringify(r),
  );
}

// T_trunc4 — array truncation uses item count.
{
  const r = truncateArrayMirror([1, 2, 3, 4, 5, 6], 3);
  log(
    'T_trunc4 array truncated by count, originalSize is item count',
    r.truncated === true &&
      r.originalSize === 6 &&
      r.limit === 3 &&
      r.data.length === 3 &&
      r.rawAvailable === true,
    JSON.stringify(r),
  );
}

// T_trunc5 — UTF-8 multibyte sequence isn't split.
{
  // 'é' is 2 bytes in UTF-8; cap at 3 should fit one 'é' (2 bytes), not 1.5.
  const r = truncateStringMirror('éé', 3);
  // Bisect picks the largest prefix whose byte length ≤ 3 → 'é' (2 bytes).
  log(
    'T_trunc5 multibyte UTF-8 not split mid-char',
    r.data === 'é' && r.truncated === true,
    JSON.stringify(r),
  );
}

// ---------------------------------------------------------------------------
// chrome_console truncation envelope.
// Mirrors detectArgsTruncated + buildConsoleTruncation in
// app/chrome-extension/entrypoints/background/tools/browser/console.ts.
// ---------------------------------------------------------------------------

function containsTruncationMarker(value) {
  if (value == null) return false;
  if (typeof value === 'string') return value === '[...truncated]';
  if (Array.isArray(value)) return value.some(containsTruncationMarker);
  if (typeof value === 'object') {
    if (value.__truncated__ === true) return true;
    for (const k in value) if (containsTruncationMarker(value[k])) return true;
  }
  return false;
}

function detectArgsTruncatedMirror(messages) {
  for (const m of messages) {
    if (!m.argsSerialized) continue;
    for (const a of m.argsSerialized) if (containsTruncationMarker(a)) return true;
  }
  return false;
}

function buildConsoleTruncationMirror(
  messageCount,
  droppedMessageCount,
  limitReached,
  effectiveLimit,
  argsTruncated,
  rawSupported,
) {
  const messagesTruncated = limitReached || droppedMessageCount > 0;
  return {
    truncated: messagesTruncated || argsTruncated,
    originalSize: messagesTruncated ? messageCount + droppedMessageCount : undefined,
    limit: effectiveLimit,
    rawAvailable: rawSupported && argsTruncated,
    unit: 'messages',
    argsTruncated,
  };
}

// T_console1 — clean read: no truncation flagged.
{
  const t = buildConsoleTruncationMirror(5, 0, false, 100, false, true);
  log(
    'T_console1 clean read → truncated=false, rawAvailable=false',
    t.truncated === false && t.rawAvailable === false && t.originalSize === undefined,
    JSON.stringify(t),
  );
}

// T_console2 — message cap hit: originalSize = count + dropped, raw irrelevant.
{
  const t = buildConsoleTruncationMirror(100, 42, true, 100, false, true);
  log(
    'T_console2 message cap → originalSize includes dropped, rawAvailable=false',
    t.truncated === true && t.originalSize === 142 && t.rawAvailable === false,
    JSON.stringify(t),
  );
}

// T_console3 — args truncated, raw not yet used → rawAvailable=true.
{
  const messages = [
    { argsSerialized: [{ deeply: { __truncated__: true } }] },
  ];
  const argsTruncated = detectArgsTruncatedMirror(messages);
  const t = buildConsoleTruncationMirror(3, 0, false, 100, argsTruncated, true);
  log(
    'T_console3 __truncated__ marker → argsTruncated=true, rawAvailable=true',
    t.argsTruncated === true && t.rawAvailable === true && t.truncated === true,
    JSON.stringify(t),
  );
}

// T_console4 — args truncated AND raw already in use → rawAvailable=false.
{
  const messages = [{ argsSerialized: ['hello', '[...truncated]'] }];
  const argsTruncated = detectArgsTruncatedMirror(messages);
  // rawSupported=false simulates "raw:true was set this call, no further escape hatch"
  const t = buildConsoleTruncationMirror(2, 0, false, 100, argsTruncated, false);
  log(
    'T_console4 sentinel under raw=true → argsTruncated=true, rawAvailable=false',
    t.argsTruncated === true && t.rawAvailable === false,
    JSON.stringify(t),
  );
}

// ---------------------------------------------------------------------------
// Click pre-action navigation assert + Fill withNavigationGuard wrapper.
// Mirrors the call shape in interaction.ts; the comparison primitive is
// covered by T12-T15.
// ---------------------------------------------------------------------------

class FakeToolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
  }
}

async function snapshotMirror(state) {
  return { tabId: state.tabId, url: state.url, documentId: state.documentId };
}

async function assertSameDocumentMirror(snap, currentState) {
  if (
    snap.documentId &&
    currentState.documentId &&
    currentState.documentId !== snap.documentId
  ) {
    throw new FakeToolError('TARGET_NAVIGATED_AWAY', `Tab ${snap.tabId} navigated mid-call`);
  }
}

// T_nav1 — pre-action assert catches navigation between snapshot and click send.
{
  let docId = 'doc-1';
  const snap = await snapshotMirror({ tabId: 1, url: '/a', documentId: docId });
  // Simulate user navigating between snapshot and side-effect dispatch.
  docId = 'doc-2';
  let caught = null;
  try {
    await assertSameDocumentMirror(snap, { tabId: 1, url: '/b', documentId: docId });
  } catch (e) {
    caught = e;
  }
  log(
    'T_nav1 pre-action snapshot+assert catches mid-call navigation',
    caught && caught.code === 'TARGET_NAVIGATED_AWAY',
    caught ? caught.message : 'no throw',
  );
}

// T_nav2 — withNavigationGuard wrapper: snapshot, run fn, assert; happy path returns fn result.
{
  const docId = 'doc-stable';
  const withGuard = async (state, fn) => {
    const snap = await snapshotMirror(state);
    const result = await fn();
    await assertSameDocumentMirror(snap, state);
    return result;
  };
  const result = await withGuard({ tabId: 2, url: '/x', documentId: docId }, async () => 'OK');
  log(
    'T_nav2 withNavigationGuard returns fn result on stable doc',
    result === 'OK',
    String(result),
  );
}

// T_nav3 — withNavigationGuard throws when fn ran and doc changed underneath.
{
  let docId = 'doc-A';
  const withGuard = async (state, fn) => {
    const snap = await snapshotMirror(state);
    const result = await fn();
    await assertSameDocumentMirror(snap, state);
    return result;
  };
  let caught = null;
  try {
    await withGuard({ tabId: 3, url: '/p', get documentId() { return docId; } }, async () => {
      docId = 'doc-B';
      return 'stale-result';
    });
  } catch (e) {
    caught = e;
  }
  log(
    'T_nav3 withNavigationGuard throws TARGET_NAVIGATED_AWAY when fn races a navigation',
    caught && caught.code === 'TARGET_NAVIGATED_AWAY',
    caught ? caught.message : 'no throw',
  );
}

// T22 — timeout while waiting throws TAB_LOCK_TIMEOUT and frees the chain.
{
  const reg = makeLockRegistry();
  // Hold the lock indefinitely.
  const heldRelease = await reg.acquire(99);
  let timedOut = false;
  let timedCode = null;
  try {
    await reg.acquire(99, { timeoutMs: 25 });
  } catch (e) {
    timedOut = true;
    timedCode = e.code;
  }
  // The phantom slot must not deadlock subsequent acquirers — release the
  // original holder, then a fresh acquire must succeed quickly.
  heldRelease();
  let recovered = false;
  try {
    const r = await reg.acquire(99, { timeoutMs: 100 });
    recovered = true;
    r();
  } catch {
    recovered = false;
  }
  log(
    'T22 timeout throws TAB_LOCK_TIMEOUT and chain recovers after release',
    timedOut && timedCode === 'TAB_LOCK_TIMEOUT' && recovered,
    `timedOut=${timedOut} code=${timedCode} recovered=${recovered}`,
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
