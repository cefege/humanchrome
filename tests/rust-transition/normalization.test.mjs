import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalize } from './native-fixtures.mjs';

const scope = { directory: '/tmp/hc-owned', port: 14321 };
const id = '123e4567-e89b-42d3-a456-426614174000';
const second = '123e4567-e89b-42d3-a456-426614174001';

test('UUID correlation relationships and array order survive normalization', () => {
  assert.deepEqual(normalize([{ requestId: id }, { responseToRequestId: id }, { requestId: second }], scope), [
    { requestId: '<uuid-1>' }, { responseToRequestId: '<uuid-1>' }, { requestId: '<uuid-2>' },
  ]);
});

test('only owned paths, generated times and actual port fields are normalized', () => {
  assert.deepEqual(normalize({ path: '/tmp/hc-owned/data.json', other: '/tmp/not-owned/data.json', startedAt: '2026-10-29T00:00:00.000Z', port: 14321, score: 14321, catalogNumber: '14321' }, scope), {
    path: '<temporary-directory>/data.json', other: '/tmp/not-owned/data.json', startedAt: '<timestamp>', port: '<allocated-port>', score: 14321, catalogNumber: '14321',
  });
});

test('errors, catalog wording, omissions and explicit null remain evidence', () => {
  const input = { description: `Use ${id} at 2026-10-29T00:00:00Z`, result: { content: [{ type: 'text', text: `failure ${id}` }], isError: true }, absent: {}, explicit: { value: null } };
  assert.deepEqual(normalize(input, scope), input);
});
