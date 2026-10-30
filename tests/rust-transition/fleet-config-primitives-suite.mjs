import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';

import { ROOT, captureProcess, isolatedRun } from './process-host.mjs';
import { normalize } from './native-fixtures.mjs';

const rustFixture = join(ROOT, 'target/release/examples', `fleet-config-primitives${process.platform === 'win32' ? '.exe' : ''}`);

await requireFile(rustFixture, 'cargo build -p humanchrome-native --release --example fleet-config-primitives', constants.X_OK);

const cases = [
  {
    name: 'missing-file',
    scenario: { operations: [{ op: 'load' }] },
  },
  {
    name: 'malformed-json',
    fleetJson: '{"version":',
    scenario: { operations: [{ op: 'load' }] },
  },
  {
    name: 'floating-version-one',
    fleetJson: configJson({ version: '1.0' }),
    scenario: { operations: [{ op: 'load' }] },
  },
  {
    name: 'invalid-version',
    fleetJson: configJson({ version: '2' }),
    scenario: { operations: [{ op: 'load' }] },
  },
  {
    name: 'profiles-must-be-an-array',
    fleetJson: configJson({ profiles: '{}' }),
    scenario: { operations: [{ op: 'load' }] },
  },
  {
    name: 'profile-name-precedes-earlier-duplicate-purpose',
    fleetJson: configJson({
      profiles: '[{"name":"first","purpose":"shared"},{"name":"Bad_Name","purpose":"shared"}]',
    }),
    scenario: { operations: [{ op: 'load' }] },
  },
  {
    name: 'duplicate-purpose',
    fleetJson: configJson({
      profiles: '[{"name":"first","purpose":"shared"},{"name":"second","purpose":"shared"}]',
    }),
    scenario: { operations: [{ op: 'load' }] },
  },
  {
    name: 'invalid-purpose-name',
    fleetJson: configJson({ profiles: '[{"name":"bound","purpose":"Bad"}]' }),
    scenario: { operations: [{ op: 'load' }] },
  },
  {
    name: 'non-string-purpose-coercion',
    fleetJson: configJson({ profiles: '[{"name":"bound","purpose":1}]' }),
    scenario: { operations: [{ op: 'load' }] },
  },
  {
    name: 'gateway-url-coerces-truthy-json-values',
    fleetJson: configJson({ gateway: '{"host":{},"port":[1]}' }),
    scenario: { operations: [{ op: 'gateway-url' }] },
  },
  {
    name: 'non-array-nodes',
    fleetJson: configJson({ nodes: '{}' }),
    scenario: { operations: [{ op: 'load' }] },
  },
  {
    name: 'node-collision',
    fleetJson: configJson({ nodeId: '"node-a"', nodes: '[{"id":"node-a"}]' }),
    scenario: { operations: [{ op: 'load' }] },
  },
  {
    name: 'required-field-order',
    fleetJson: configJson({ gateway: '{}', bridgeToken: 'null', chromePath: 'null' }),
    scenario: { operations: [{ op: 'load' }] },
  },
  {
    name: 'load-save-preserves-defaults-order-and-mode',
    fleetJson: configJson({
      version: '1.0',
      profiles: '[{"name":"bound","purpose":1},{"name":"seed","seededFrom":{"from":"template"}}]',
      extra: '"retained"',
      numericProperties: '{"10":"ten","2":"two","tail":true}',
    }),
    scenario: { operations: [{ op: 'load-save' }, { op: 'gateway-url' }] },
  },
  {
    name: 'purpose-guard',
    scenario: {
      operations: [
        { op: 'evaluate', toolName: 'chrome_clear_browsing_data', protection: 'bound to purpose "work"' },
        { op: 'evaluate', toolName: 'chrome_clear_browsing_data', args: null, protection: 'bound to purpose "work"' },
        { op: 'evaluate', toolName: 'chrome_clear_browsing_data', args: { confirmProfileWipe: false }, protection: 'bound to purpose "work"' },
        { op: 'evaluate', toolName: 'chrome_clear_browsing_data', args: { confirmProfileWipe: true, retained: 1 }, protection: 'bound to purpose "work"' },
        { op: 'evaluate', toolName: 'chrome_clear_browsing_data', args: { origins: ['https://example.test'], confirmProfileWipe: false }, protection: 'seeded from source' },
        { op: 'evaluate', toolName: 'chrome_get_windows_and_tabs', args: { confirmProfileWipe: true }, protection: 'seeded from source' },
        { op: 'evaluate', toolName: 'chrome_clear_browsing_data', args: { confirmProfileWipe: true }, protection: null },
      ],
    },
  },
];

const reference = JSON.parse(await readFile(join(ROOT, 'tests/rust-transition/fleet-config-primitives-reference.json'), 'utf8'));
// Parameterize the recorded system hostname; never rewrite the actual wire or persisted results.
const expected = JSON.parse(JSON.stringify(reference.observations)
  .replaceAll(JSON.stringify(reference.hostname), JSON.stringify(hostname())));
const results = [];
for (const fixture of cases) {
  const rust = await observe(fixture);
  const original = expected.find((entry) => entry.name === fixture.name);
  assert(original, `missing original process reference for ${fixture.name}`);
  assert.deepEqual(rust.output, original.output, `${fixture.name}: original process contract changed`);
  results.push({ name: fixture.name, output: rust.output });
}
process.stdout.write(`${JSON.stringify(results)}\n`);

async function observe(fixture) {
  return isolatedRun(async (scope) => {
    const root = scope.env.HC_FLEET_ROOT;
    if (fixture.fleetJson !== undefined) {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, 'fleet.json'), fixture.fleetJson);
    }
    const scenarioPath = join(scope.directory, 'scenario.json');
    await writeFile(scenarioPath, JSON.stringify(fixture.scenario));
    const output = JSON.parse(await captureProcess(rustFixture, [scenarioPath], scope));
    const observed = normalize(output, { directory: scope.directory, port: scope.port });
    // Compare persisted bytes unchanged except for the owned temporary prefix,
    // which is JSON-escaped inside this snapshot rather than a standalone path.
    const encodedDirectory = JSON.stringify(scope.directory).slice(1, -1);
    for (const operation of observed.operations) {
      if (typeof operation.file === 'string') {
        operation.file = operation.file.replaceAll(encodedDirectory, '<temporary-directory>');
      }
    }
    return { output: observed };
  });
}

function configJson(overrides = {}) {
  const fields = {
    version: '1',
    gateway: '{"host":"0.0.0.0","port":12300}',
    token: 'null',
    bridgeToken: '"bridge-token"',
    chromePath: '"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"',
    extensionDir: '"/tmp/extension"',
    basePort: '12500',
    profiles: '[]',
    ...overrides,
  };
  return `{${Object.entries(fields).map(([key, value]) => `${JSON.stringify(key)}:${value}`).join(',')}}`;
}

async function requireFile(path, command, mode = constants.R_OK) {
  try {
    await access(path, mode);
  } catch {
    throw new Error(`missing prerequisite ${path}; run ${command}`);
  }
}
