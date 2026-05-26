#!/usr/bin/env node
/**
 * Regenerate `packages/shared/src/tool-index.snapshot.json` — the byte-stable
 * record of the IMP-0177 dispatcher description (IMP-0181).
 *
 * The snapshot is the authoritative reference for Anthropic prompt-cache
 * stability: any change to the description blob busts the 5-min cache TTL
 * for every connected client. The corresponding contract test
 * (`tool-index.snapshot.test.ts`) fails on drift so unintended edits
 * surface in CI before they ship.
 *
 * Run: `node packages/shared/scripts/regen-tool-index-snapshot.mjs`
 * Or:  `UPDATE_SNAPSHOT=1 vitest run packages/shared/src/tool-index.snapshot.test.ts`
 *
 * Requires `pnpm -w build` to have run first (loads from dist/).
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SNAPSHOT_PATH = path.resolve(HERE, '..', 'src', 'tool-index.snapshot.json');

const SNAPSHOT_COMMENT =
  'IMP-0181 byte-stability snapshot. Regenerate via packages/shared/scripts/regen-tool-index-snapshot.mjs after intentional changes to TOOL_SCHEMAS or buildDispatcherDescription. The contract test will fail if this file drifts from the live builder.';

/**
 * Build the snapshot object from the live `humanchrome-shared` export.
 * Pure — no filesystem effects. Imported by the contract test's
 * UPDATE_SNAPSHOT branch so the JSON shape lives in exactly one place.
 */
export async function buildSnapshot() {
  const { buildDispatcherDescription, knownToolNames, TOOL_SCHEMAS } = await import(
    'humanchrome-shared'
  );
  const description = buildDispatcherDescription();
  const descriptionSha256 = createHash('sha256').update(description, 'utf8').digest('hex');
  return {
    $comment: SNAPSHOT_COMMENT,
    toolCount: TOOL_SCHEMAS.length,
    descriptionLength: description.length,
    descriptionSha256,
    toolNames: knownToolNames(),
    description,
  };
}

/** Write the snapshot to disk. Returns the snapshot object. */
export async function writeSnapshot() {
  const snapshot = await buildSnapshot();
  await fs.writeFile(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
  return snapshot;
}

async function main() {
  const snapshot = await writeSnapshot();
  console.log(
    `Wrote ${SNAPSHOT_PATH}\n  toolCount=${snapshot.toolCount}\n  descriptionLength=${snapshot.descriptionLength}\n  sha256=${snapshot.descriptionSha256}`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('regen failed:', err);
    process.exit(1);
  });
}
