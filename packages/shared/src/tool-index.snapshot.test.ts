/**
 * IMP-0181 — byte-stability contract for the dispatcher description.
 *
 * Anthropic's prompt cache has a 5-min TTL and is invalidated by ANY byte
 * change in the system prompt or tools manifest. The IMP-0177 dispatcher
 * pays off across multi-turn sessions only if the description is byte-
 * stable across server starts. This test pins the canonical bytes to a
 * snapshot file (`tool-index.snapshot.json`) and fails CI on drift —
 * intentional or otherwise — so the invariant is structural, not
 * incidental.
 *
 * Workflow:
 *   - Tool surface changes? Regenerate intentionally:
 *       UPDATE_SNAPSHOT=1 npx vitest run src/tool-index.snapshot.test.ts
 *     or
 *       node scripts/regen-tool-index-snapshot.mjs
 *   - Unintended description change? CI fails; revert or rebuild
 *     `TOOL_SCHEMAS` until the test passes again.
 *
 * Banned-patterns assertions catch the silent failure mode: someone
 * inadvertently injects a timestamp / hostname / version into a tool
 * description, the snapshot regenerates "cleanly," and the prompt cache
 * busts on every server restart.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';

import { describe, it, expect, beforeAll } from 'vitest';
import { TOOL_SCHEMAS } from './tools';
import { buildDispatcherDescription, knownToolNames } from './tool-index';
import { SNAPSHOT_PATH, writeSnapshot } from '../scripts/regen-tool-index-snapshot.mjs';

type Snapshot = {
  toolCount: number;
  descriptionLength: number;
  descriptionSha256: string;
  toolNames: string[];
  description: string;
};

let snapshot: Snapshot;
let liveDescription: string;
let liveSha: string;

const updateMode = process.env.UPDATE_SNAPSHOT === '1';

beforeAll(async () => {
  liveDescription = buildDispatcherDescription();
  liveSha = createHash('sha256').update(liveDescription, 'utf8').digest('hex');

  if (updateMode) {
    await writeSnapshot();
  }
  const raw = await fs.readFile(SNAPSHOT_PATH, 'utf8');
  snapshot = JSON.parse(raw);
});

describe('IMP-0181 dispatcher description byte-stability', () => {
  it('snapshot file exists and is parseable JSON', () => {
    expect(snapshot).toBeDefined();
    expect(typeof snapshot.description).toBe('string');
    expect(typeof snapshot.descriptionSha256).toBe('string');
    expect(Array.isArray(snapshot.toolNames)).toBe(true);
  });

  it('live description matches snapshot byte-for-byte', () => {
    if (liveDescription !== snapshot.description) {
      throw new Error(
        [
          'Dispatcher description drifted from the snapshot.',
          'This busts Anthropic prompt cache on every server restart.',
          'If the change was intentional, regenerate with:',
          '  UPDATE_SNAPSHOT=1 npx vitest run src/tool-index.snapshot.test.ts',
          'or:',
          '  node scripts/regen-tool-index-snapshot.mjs',
          `Live length=${liveDescription.length}, snapshot length=${snapshot.description.length}`,
        ].join('\n'),
      );
    }
    expect(liveDescription).toBe(snapshot.description);
  });

  it('live SHA-256 matches snapshot', () => {
    expect(liveSha).toBe(snapshot.descriptionSha256);
  });

  it('live tool count matches snapshot', () => {
    expect(TOOL_SCHEMAS.length).toBe(snapshot.toolCount);
  });

  it('live tool name set matches snapshot (sorted)', () => {
    expect(knownToolNames()).toEqual(snapshot.toolNames);
  });

  it('description is byte-stable across multiple builder calls', () => {
    const a = buildDispatcherDescription();
    const b = buildDispatcherDescription();
    const c = buildDispatcherDescription();
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});

describe('IMP-0181 banned-patterns invariant', () => {
  /**
   * Patterns whose presence in the description would silently bust the
   * prompt cache across server restarts. Each pattern includes a remark
   * documenting why it's banned so the failure mode is legible.
   */
  const bannedPatterns: Array<{ name: string; re: RegExp }> = [
    {
      name: 'ISO-8601 timestamp',
      re: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    },
    {
      name: 'unix epoch (seconds, 10 digits)',
      re: /\b1[6-9]\d{8}\b/,
    },
    {
      name: 'unix epoch (millis, 13 digits)',
      re: /\b1[6-9]\d{11}\b/,
    },
    {
      name: 'env-var interpolation marker ($VAR or ${VAR})',
      re: /\$\{?[A-Z_][A-Z0-9_]+\}?/,
    },
    {
      name: 'hostname-like string (.local / .internal / *.com path)',
      re: /[a-z0-9][a-z0-9-]*\.(local|internal)\b/,
    },
    {
      name: 'semver build metadata (+build.<n>)',
      re: /\+build\.[a-z0-9]+/,
    },
  ];

  for (const { name, re } of bannedPatterns) {
    it(`description contains no ${name}`, () => {
      const desc = buildDispatcherDescription();
      const m = desc.match(re);
      if (m) {
        throw new Error(
          `Description contains banned pattern "${name}" at offset ${m.index}: "${m[0]}". ` +
            'This silently invalidates the Anthropic prompt cache on every restart. ' +
            'Either remove the dynamic text from the offending tool description, ' +
            'or weaken the regex if this is a false positive on a stable substring.',
        );
      }
    });
  }
});
