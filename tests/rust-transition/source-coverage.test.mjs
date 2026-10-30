import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifySourceCoverage } from './source-coverage.mjs';

const source = 'packages/shared/src/rust-graph.ts';
function inventory() {
  return {
    sourceRoots: ['packages/shared/src'],
    excludedFromProductionInventory: { paths: [], pathSuffixes: ['.test.ts'] },
    requiredMixedEntries: [],
    files: [
      {
        path: source,
        classification: 'rust-wasm',
        status: 'active',
        plannedOwner: 'humanchrome-core + humanchrome-wasm',
        rationale: 'Rust owns graph plans while the facade retains caller object identity.',
        provenance: {
          rustOwner: 'humanchrome-core::workflow::legacy_graph + humanchrome-wasm::legacy_graph',
          rustSymbols: ['legacy graph execution plan'],
          hostResponsibilities: ['caller object projection'],
          runtimeCallers: ['packages/shared/src/rr-graph.ts'],
        },
      },
      {
        path: 'packages/shared/src/rr-graph.ts',
        classification: 'browser-adapter',
        status: 'retained',
        plannedOwner: 'browser resource adapter',
        rationale: 'Retains caller object identity while delegating graph policy to Rust.',
      },
    ],
  };
}
const verify = (data, paths) => verifySourceCoverage({ root: '/repository', inventory: data, walk: async () => paths });

test('active ownership records the live Rust policy boundary', async () => {
  assert.deepEqual(await verify(inventory(), [source, 'packages/shared/src/rust-graph.test.ts', 'packages/shared/src/rr-graph.ts']), { files: 2, active: 1, pending: 0 });
});

test('new production source blocks coverage until explicitly classified', async () => {
  await assert.rejects(verify(inventory(), [source, 'packages/shared/src/rr-graph.ts', 'packages/shared/src/new-policy.ts']), /unclassified: packages\/shared\/src\/new-policy.ts/);
});

test('deleted production source requires removing obsolete ownership entry', async () => {
  const data = inventory();
  data.files[0].provenance.runtimeCallers = [];
  await assert.rejects(verify(data, [source]), /stale: packages\/shared\/src\/rr-graph.ts/);
});

test('mixed policy cannot drop symbol ownership or refer to deleted callsites', async () => {
  const data = inventory();
  data.requiredMixedEntries.push(source);
  await assert.rejects(verify(data, [source, 'packages/shared/src/rr-graph.ts']), /lacks symbol mapping/);
  data.files[0].mixed = { policySymbols: ['legacyExecutionPlan'], retainedEffects: ['caller object projection'], reachableCallsites: ['packages/shared/src/deleted.ts'] };
  await assert.rejects(verify(data, [source, 'packages/shared/src/rr-graph.ts']), /not a current production source/);
});

test('duplicated inventory entries cannot inflate classified coverage', async () => {
  const data = inventory();
  data.files.push({ ...data.files[0] });
  await assert.rejects(verify(data, [source]), /duplicate inventory path/);
});
