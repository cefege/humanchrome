/**
 * chrome_pace_get tests (IMP-0015).
 *
 * Read-only counterpart of chrome_pace. Verifies the tool returns the
 * pacing profile that `chrome_pace` previously installed for the same
 * client (via `runWithContext`), defaults to `{profile: 'off'}` when
 * none is set, and rejects when no clientId is bound to the context.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { paceTool, paceGetTool } from '@/entrypoints/background/tools/browser/pace';
import { runWithContext } from '@/entrypoints/background/utils/request-context';

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

beforeEach(() => {
  // No-op — client-state lives in the module-scoped Map. Each test uses a
  // unique clientId so they don't cross-contaminate; if a future test
  // wants global isolation, expose a `_resetClientStateForTest` helper.
});

afterEach(() => {});

describe('chrome_pace_get', () => {
  it('returns profile=off when no pacing has been set for the client', async () => {
    const body = await runWithContext({ clientId: 'fresh-client-1' }, async () => {
      const res = await paceGetTool.execute();
      expect(res.isError).toBe(false);
      return parseBody(res);
    });
    expect(body).toEqual({
      clientId: 'fresh-client-1',
      profile: 'off',
      minGapMs: 0,
      jitterMs: 0,
    });
  });

  it('returns the profile + resolved gap/jitter after chrome_pace sets one', async () => {
    await runWithContext({ clientId: 'paced-client-1' }, async () => {
      const setRes = await paceTool.execute({ profile: 'careful' });
      expect(setRes.isError).toBe(false);

      const getRes = await paceGetTool.execute();
      const body = parseBody(getRes);
      expect(body.clientId).toBe('paced-client-1');
      expect(body.profile).toBe('careful');
      expect(typeof body.minGapMs).toBe('number');
      expect(body.minGapMs).toBeGreaterThan(0);
      expect(typeof body.jitterMs).toBe('number');
      expect(body.jitterMs).toBeGreaterThanOrEqual(0);
    });
  });

  it('honors explicit minGapMs / jitterMs overrides set by chrome_pace', async () => {
    await runWithContext({ clientId: 'paced-client-2' }, async () => {
      await paceTool.execute({ profile: 'human', minGapMs: 1500, jitterMs: 250 });

      const body = parseBody(await paceGetTool.execute());
      expect(body.profile).toBe('human');
      expect(body.minGapMs).toBe(1500);
      expect(body.jitterMs).toBe(250);
    });
  });

  it('reflects a profile change made by a subsequent chrome_pace call', async () => {
    await runWithContext({ clientId: 'paced-client-3' }, async () => {
      await paceTool.execute({ profile: 'fast' });
      const before = parseBody(await paceGetTool.execute());
      expect(before.profile).toBe('fast');

      await paceTool.execute({ profile: 'careful' });
      const after = parseBody(await paceGetTool.execute());
      expect(after.profile).toBe('careful');
    });
  });

  it('returns INVALID_ARGS when no clientId is bound to the context', async () => {
    const res = await paceGetTool.execute();
    expect(res.isError).toBe(true);
    const text = (res.content[0] as any).text as string;
    expect(text).toContain('INVALID_ARGS');
    expect(text).toContain('client id');
  });

  it("does not mutate other clients' pacing state", async () => {
    await runWithContext({ clientId: 'client-A' }, async () => {
      await paceTool.execute({ profile: 'fast' });
    });
    await runWithContext({ clientId: 'client-B' }, async () => {
      const body = parseBody(await paceGetTool.execute());
      expect(body.profile).toBe('off');
    });
    // Confirm A is still 'fast' after B's read
    await runWithContext({ clientId: 'client-A' }, async () => {
      const body = parseBody(await paceGetTool.execute());
      expect(body.profile).toBe('fast');
    });
  });

  it('multiple consecutive get calls return identical state (read-only)', async () => {
    await runWithContext({ clientId: 'client-RO' }, async () => {
      await paceTool.execute({ profile: 'human' });
      const a = parseBody(await paceGetTool.execute());
      const b = parseBody(await paceGetTool.execute());
      const c = parseBody(await paceGetTool.execute());
      expect(b).toEqual(a);
      expect(c).toEqual(a);
    });
  });
});
