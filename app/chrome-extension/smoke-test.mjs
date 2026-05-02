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
  return await eval(wrapped); // eslint-disable-line no-eval
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
