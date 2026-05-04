/**
 * Test-side assertion helpers. Tests record outcomes via `record(...)`;
 * they don't throw — the runner aggregates pass/fail and writes JSONL.
 */

export const PASS = 'pass';
export const FAIL = 'fail';
export const SKIP = 'skip';

/**
 * Build a test outcome record. The runner will enrich it with a debug-dump
 * before writing to JSONL when `status === 'fail'`.
 */
export function outcome({ name, status, expected, got, args, tool, client, requestId, note }) {
  return {
    name,
    status,
    expected: expected ?? null,
    got: got ?? null,
    args: args ?? null,
    tool: tool ?? null,
    client: client ?? null,
    requestId: requestId ?? null,
    note: note ?? null,
  };
}

/** True when the response shape says "no error" (isError === false). */
export function isOk(toolResult) {
  return !!toolResult && toolResult.isError === false;
}

/**
 * Assert a tool succeeded. Returns an outcome — pass when ok, fail otherwise.
 */
export function expectOk(name, toolResult, ctx = {}) {
  if (isOk(toolResult)) {
    return outcome({ name, status: PASS, expected: 'isError:false', got: 'isError:false', ...ctx });
  }
  return outcome({
    name,
    status: FAIL,
    expected: 'isError:false',
    got: { isError: !!toolResult?.isError, content: toolResult?.content },
    ...ctx,
  });
}

/**
 * Assert a tool failed with the given structured-error code.
 */
export function expectErrorCode(name, toolResult, code, ctx = {}) {
  if (!toolResult?.isError) {
    return outcome({
      name,
      status: FAIL,
      expected: { isError: true, code },
      got: { isError: false, content: toolResult?.content },
      ...ctx,
    });
  }
  const block = toolResult.content?.find?.((c) => c.type === 'text');
  let envelope = null;
  try {
    envelope = block?.text ? JSON.parse(block.text)?.error : null;
  } catch {
    envelope = null;
  }
  if (envelope?.code === code) {
    return outcome({ name, status: PASS, expected: code, got: envelope, ...ctx });
  }
  return outcome({
    name,
    status: FAIL,
    expected: { code },
    got: envelope ?? { rawText: block?.text ?? null },
    note: envelope ? `expected ${code}, got ${envelope.code}` : 'response was not a structured envelope',
    ...ctx,
  });
}

/**
 * Assert a payload field deep-equals an expected value.
 */
export function expectField(name, payload, fieldPath, expected, ctx = {}) {
  const got = fieldPath.split('.').reduce((v, k) => (v == null ? undefined : v[k]), payload);
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  return outcome({
    name,
    status: ok ? PASS : FAIL,
    expected: { [fieldPath]: expected },
    got: { [fieldPath]: got },
    ...ctx,
  });
}

/**
 * Assert that a payload contains a `truncation` envelope of the expected shape.
 */
export function expectTruncation(name, payload, { truncated, rawAvailable }, ctx = {}) {
  const t = payload?.truncation;
  if (!t) {
    return outcome({
      name,
      status: FAIL,
      expected: { truncation: { truncated, rawAvailable } },
      got: { truncation: null },
      note: 'response did not include a truncation envelope',
      ...ctx,
    });
  }
  const ok = t.truncated === truncated && t.rawAvailable === rawAvailable;
  return outcome({
    name,
    status: ok ? PASS : FAIL,
    expected: { truncated, rawAvailable },
    got: { truncated: t.truncated, rawAvailable: t.rawAvailable, originalSize: t.originalSize, limit: t.limit },
    ...ctx,
  });
}
