import { isAbsolute, resolve, sep } from 'node:path';

const CLASSIFICATIONS = new Set([
  'rust-native',
  'browser-policy',
  'browser-adapter',
  'third-party-adapter',
  'contract',
  'build-tooling',
]);

const EXPECTED_STATUSES = {
  'rust-native': new Set(['active', 'pending']),
  'browser-policy': new Set(['retained']),
  'browser-adapter': new Set(['retained']),
  'third-party-adapter': new Set(['retained']),
  contract: new Set(['contract-source']),
  'build-tooling': new Set(['retained']),
};
const STATUSES = new Set(['active', 'pending', 'retained', 'contract-source']);

function fail(message) {
  throw new Error(`Rust transition source coverage: ${message}`);
}

function normalizedRelativePath(value, field) {
  if (typeof value !== 'string' || !value) fail(`${field} must be a non-empty string`);
  if (isAbsolute(value)) fail(`${field} must be repository-relative`);
  const normalized = value.replaceAll('\\', '/');
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    fail(`${field} must not escape the repository`);
  }
  return normalized;
}

function isInsideSourceRoot(path, sourceRoots) {
  return sourceRoots.some((sourceRoot) => path === sourceRoot || path.startsWith(`${sourceRoot}/`));
}

function validateStringArray(value, field) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item)) {
    fail(`${field} must be an array of non-empty strings`);
  }
}

/**
 * Verifies that source-map.json is an exhaustive, path-by-path ownership map.
 * `walk` is injected by the transition driver so this module has no filesystem
 * traversal convention of its own.
 */
export async function verifySourceCoverage({ root, inventory, walk }) {
  if (!inventory || typeof inventory !== 'object') fail('inventory must be an object');
  if (typeof root !== 'string' || !root) fail('root must be a non-empty path');
  if (typeof walk !== 'function') fail('walk must be a function');

  validateStringArray(inventory.sourceRoots, 'sourceRoots');
  const sourceRoots = inventory.sourceRoots.map((entry, index) =>
    normalizedRelativePath(entry, `sourceRoots[${index}]`),
  );
  if (new Set(sourceRoots).size !== sourceRoots.length) fail('sourceRoots contains duplicates');

  const exclusions = inventory.excludedFromProductionInventory;
  if (!exclusions || typeof exclusions !== 'object') fail('excludedFromProductionInventory must be an object');
  validateStringArray(exclusions.pathSuffixes, 'excludedFromProductionInventory.pathSuffixes');
  validateStringArray(exclusions.paths, 'excludedFromProductionInventory.paths');
  const excludedPaths = new Set(
    exclusions.paths.map((entry, index) => normalizedRelativePath(entry, `excludedFromProductionInventory.paths[${index}]`)),
  );
  const excludedSuffixes = exclusions.pathSuffixes;

  const discovered = new Set();
  for (const sourceRoot of sourceRoots) {
    const absoluteRoot = resolve(root, sourceRoot);
    const files = await walk(absoluteRoot);
    if (!Array.isArray(files)) fail(`walk(${sourceRoot}) must return an array`);
    for (const file of files) {
      const path = normalizedRelativePath(file, `walk(${sourceRoot}) result`);
      const absolutePath = resolve(root, path);
      const rootWithSeparator = absoluteRoot.endsWith(sep) ? absoluteRoot : `${absoluteRoot}${sep}`;
      if (absolutePath !== absoluteRoot && !absolutePath.startsWith(rootWithSeparator)) {
        fail(`walk(${sourceRoot}) returned out-of-root path ${path}`);
      }
      if (!isInsideSourceRoot(path, sourceRoots)) fail(`walk returned out-of-scope path ${path}`);
      if (!excludedPaths.has(path) && !excludedSuffixes.some((suffix) => path.endsWith(suffix))) {
        discovered.add(path);
      }
    }
  }

  if (!Array.isArray(inventory.files)) fail('files must be an array');
  const mapped = new Map();
  let pending = 0;
  let active = 0;
  let browserPolicy = 0;
  for (const [index, entry] of inventory.files.entries()) {
    if (!entry || typeof entry !== 'object') fail(`files[${index}] must be an object`);
    const path = normalizedRelativePath(entry.path, `files[${index}].path`);
    if (!isInsideSourceRoot(path, sourceRoots)) fail(`files[${index}].path is outside sourceRoots: ${path}`);
    if (excludedPaths.has(path) || excludedSuffixes.some((suffix) => path.endsWith(suffix))) {
      fail(`files[${index}].path is excluded from the production denominator: ${path}`);
    }
    if (mapped.has(path)) fail(`duplicate inventory path ${path}`);
    if (!CLASSIFICATIONS.has(entry.classification)) {
      fail(`files[${index}].classification is invalid for ${path}`);
    }
    if (!STATUSES.has(entry.status)) fail(`files[${index}].status is invalid for ${path}`);
    if (typeof entry.plannedOwner !== 'string' || !entry.plannedOwner) {
      fail(`files[${index}].plannedOwner is required for ${path}`);
    }
    if (typeof entry.rationale !== 'string' || !entry.rationale) {
      fail(`files[${index}].rationale is required for ${path}`);
    }
    const expectedStatuses = EXPECTED_STATUSES[entry.classification];
    if (!expectedStatuses.has(entry.status)) {
      fail(`files[${index}].status must be one of ${[...expectedStatuses].join(', ')} for ${path}`);
    }
    if (entry.classification === 'browser-policy') browserPolicy++;
    if (entry.status === 'pending') pending++;
    if (entry.status === 'active') {
      active++;
      if (entry.classification !== 'rust-native') {
        fail(`files[${index}].active status requires a Rust owner for ${path}`);
      }
      const provenance = entry.provenance;
      if (!provenance || typeof provenance !== 'object') {
        fail(`files[${index}].provenance is required for active Rust ownership: ${path}`);
      }
      if (typeof provenance.rustOwner !== 'string' || !provenance.rustOwner) {
        fail(`files[${index}].provenance.rustOwner is required for ${path}`);
      }
      validateStringArray(provenance.rustSymbols, `files[${index}].provenance.rustSymbols for ${path}`);
      validateStringArray(provenance.hostResponsibilities, `files[${index}].provenance.hostResponsibilities for ${path}`);
      validateStringArray(provenance.runtimeCallers, `files[${index}].provenance.runtimeCallers for ${path}`);
      for (const caller of provenance.runtimeCallers) {
        const normalizedCaller = normalizedRelativePath(caller, `provenance caller for ${path}`);
        if (!discovered.has(normalizedCaller)) {
          fail(`provenance caller for ${path} is not a current production source: ${normalizedCaller}`);
        }
      }
    }
    if (entry.mixed !== undefined) {
      if (!entry.mixed || typeof entry.mixed !== 'object') fail(`files[${index}].mixed must be an object for ${path}`);
      validateStringArray(entry.mixed.policySymbols, `files[${index}].mixed.policySymbols for ${path}`);
      if (entry.mixed.policySymbols.length === 0) fail(`mixed policy entry needs symbols for ${path}`);
      validateStringArray(entry.mixed.retainedEffects, `files[${index}].mixed.retainedEffects for ${path}`);
      validateStringArray(entry.mixed.reachableCallsites, `files[${index}].mixed.reachableCallsites for ${path}`);
      for (const callsite of entry.mixed.reachableCallsites) {
        const normalizedCallsite = normalizedRelativePath(callsite, `mixed callsite for ${path}`);
        if (!discovered.has(normalizedCallsite)) {
          fail(`mixed callsite for ${path} is not a current production source: ${normalizedCallsite}`);
        }
      }
    }
    mapped.set(path, entry);
  }

  validateStringArray(inventory.requiredMixedEntries, 'requiredMixedEntries');
  const requiredMixedEntries = new Set(
    inventory.requiredMixedEntries.map((entry, index) =>
      normalizedRelativePath(entry, `requiredMixedEntries[${index}]`),
    ),
  );
  if (requiredMixedEntries.size !== inventory.requiredMixedEntries.length) {
    fail('requiredMixedEntries contains duplicates');
  }
  const actualMixedEntries = new Set(
    [...mapped].filter(([, entry]) => entry.mixed !== undefined).map(([path]) => path),
  );
  for (const path of requiredMixedEntries) {
    const entry = mapped.get(path);
    if (!entry) fail(`required mixed entry is absent from files: ${path}`);
    if (entry.mixed === undefined) fail(`required mixed entry lacks symbol mapping: ${path}`);
    if (entry.classification !== 'rust-native' && entry.classification !== 'browser-policy') {
      fail(`required mixed entry must have a policy classification: ${path}`);
    }
  }
  for (const path of actualMixedEntries) {
    if (!requiredMixedEntries.has(path)) fail(`mixed entry is missing from requiredMixedEntries: ${path}`);
  }

  const unclassified = [...discovered].filter((path) => !mapped.has(path)).sort();
  const stale = [...mapped].filter(([path]) => !discovered.has(path)).map(([path]) => path).sort();
  if (unclassified.length || stale.length) {
    const parts = [];
    if (unclassified.length) parts.push(`unclassified: ${unclassified.join(', ')}`);
    if (stale.length) parts.push(`stale: ${stale.join(', ')}`);
    fail(parts.join('; '));
  }

  return { files: discovered.size, active, pending, browserPolicy };
}
