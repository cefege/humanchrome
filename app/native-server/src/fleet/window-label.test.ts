import { mkdtempSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from '@jest/globals';
import {
  applyWindowLabel,
  closeOnboardingTabs,
  colourFor,
  LABEL_FILE,
  labelFor,
  labelHtml,
  labelUrl,
} from './window-label';
import type { CdpPipe } from './cdp';
import { EXTENSION_ID } from '../scripts/constant';

interface Call {
  method: string;
  params: Record<string, unknown>;
}

interface FakeTarget {
  targetId: string;
  url: string;
  type?: string;
}

function pipe(targets: FakeTarget[] = []): {
  cdp: CdpPipe;
  calls: Call[];
} {
  const calls: Call[] = [];
  let counter = 0;
  const cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      if (method === 'Target.getTargets') {
        return {
          result: {
            targetInfos: targets.map((target) => ({ type: 'page', ...target })),
          },
        };
      }
      if (method === 'Target.createTarget') {
        counter += 1;
        return { result: { targetId: `new-${counter}` } };
      }
      return { result: {} };
    },
  } as unknown as CdpPipe;
  return { cdp, calls };
}

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(tmpdir(), 'hc-label-'));
}

describe('labelFor', () => {
  test('prefers the purpose so a tagged browser is named for its job', () => {
    expect(labelFor({ name: 'work-2', purpose: 'linkedin' })).toBe('linkedin');
  });

  test('falls back to the profile name so every browser is identifiable', () => {
    expect(labelFor({ name: 'p01' })).toBe('p01');
    expect(labelFor({ name: 'p01', purpose: undefined })).toBe('p01');
  });
});

describe('colourFor', () => {
  test('is stable for the same label, so a tag looks the same on every machine', () => {
    expect(colourFor('linkedin')).toBe(colourFor('linkedin'));
  });

  test('is a dark six-digit hex that white text can sit on, for any tag', () => {
    const labels = [
      'a',
      'linkedin',
      'whatsapp',
      'tinder',
      'p01',
      'x'.repeat(40),
      // A wide sweep, so the lightness bound is a property of the mapping and
      // not of the handful of labels someone thought to check.
      ...Array.from({ length: 200 }, (_, index) => `tag${index}`),
    ];
    for (const label of labels) {
      const hex = colourFor(label);
      expect(hex).toMatch(/^#[0-9a-f]{6}$/);
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      expect((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255).toBeLessThan(0.5);
    }
  });

  test('separates different labels', () => {
    const labels = ['linkedin', 'whatsapp', 'tinder', 'banking', 'p01', 'p02'];
    expect(new Set(labels.map(colourFor)).size).toBe(labels.length);
  });
});

describe('labelHtml', () => {
  test('carries the title the window will show and the theme colour for the tab', () => {
    const html = labelHtml('tinder', '#ff8800');
    expect(html).toContain('<title>tinder</title>');
    expect(html).toContain('name="theme-color" content="#ff8800"');
  });

  test('escapes a label rather than trusting it', () => {
    expect(labelHtml('<script>x</script>', '#000000')).not.toContain('<script>');
    expect(labelHtml('a&b', '#000000')).toContain('a&amp;b');
  });
});

describe('applyWindowLabel', () => {
  test('writes the label file and focuses a new tab', async () => {
    const dir = await tempDir();
    const { cdp, calls } = pipe();
    expect(await applyWindowLabel(cdp, dir, 'tinder')).toBe(true);
    const written = await fs.readFile(path.join(dir, LABEL_FILE), 'utf8');
    expect(written).toContain('<title>tinder</title>');
    expect(calls.map((call) => call.method)).toEqual([
      'Target.createTarget',
      'Target.getTargets',
      'Target.activateTarget',
    ]);
    expect(calls[0].params.url).toBe(labelUrl(dir));
    expect(calls[2].params).toEqual({ targetId: 'new-1' });
  });

  test('keeps the old label when creating the replacement fails', async () => {
    const dir = await tempDir();
    const calls: Call[] = [];
    const cdp = {
      send: async (method: string, params: Record<string, unknown> = {}) => {
        calls.push({ method, params });
        if (method === 'Target.createTarget') return { error: { message: 'target limit' } };
        return { result: { targetInfos: [{ targetId: 'old', url: labelUrl(dir) }] } };
      },
    } as unknown as CdpPipe;
    await expect(applyWindowLabel(cdp, dir, 'tinder')).rejects.toThrow(/target limit/);
    // The browser keeps the label it already had rather than losing it.
    expect(calls.some((call) => call.method === 'Target.closeTarget')).toBe(false);
  });

  test('closes a previous label tab instead of stacking one per change', async () => {
    const dir = await tempDir();
    const { cdp, calls } = pipe([
      { targetId: 'old-1', url: labelUrl(dir) },
      { targetId: 'real', url: 'https://example.test/' },
    ]);
    await applyWindowLabel(cdp, dir, 'tinder');
    const closes = calls.filter((call) => call.method === 'Target.closeTarget');
    expect(closes).toEqual([{ method: 'Target.closeTarget', params: { targetId: 'old-1' } }]);
    expect(calls.some((call) => call.params.targetId === 'real')).toBe(false);
  });

  test('reports failure rather than throwing when no target comes back', async () => {
    const dir = await tempDir();
    const cdp = {
      send: async (method: string) =>
        method === 'Target.getTargets' ? { result: { targetInfos: [] } } : { result: {} },
    } as unknown as CdpPipe;
    expect(await applyWindowLabel(cdp, dir, 'tinder')).toBe(false);
  });
});

describe('closeOnboardingTabs', () => {
  test('closes the extension welcome page and leaves everything else alone', async () => {
    const { cdp, calls } = pipe([
      { targetId: 'welcome', url: `chrome-extension://${EXTENSION_ID}/` },
      { targetId: 'welcome-2', url: `chrome-extension://${EXTENSION_ID}/welcome.html` },
      { targetId: 'label', url: labelUrl('/tmp/x') },
      { targetId: 'other', url: 'https://example.test/' },
    ]);
    expect(await closeOnboardingTabs(cdp)).toBe(2);
    expect(calls.filter((call) => call.method === 'Target.closeTarget')).toEqual([
      { method: 'Target.closeTarget', params: { targetId: 'welcome' } },
      { method: 'Target.closeTarget', params: { targetId: 'welcome-2' } },
    ]);
  });

  test('never closes an extension worker under the same origin', async () => {
    const { cdp, calls } = pipe([
      { targetId: 'sw', url: `chrome-extension://${EXTENSION_ID}/`, type: 'service_worker' },
    ]);
    expect(await closeOnboardingTabs(cdp)).toBe(0);
    expect(calls.some((call) => call.method === 'Target.closeTarget')).toBe(false);
  });

  test('is a no-op on a browser that never opened one', async () => {
    const { cdp, calls } = pipe([{ targetId: 'label', url: labelUrl('/tmp/x') }]);
    expect(await closeOnboardingTabs(cdp)).toBe(0);
    expect(calls.some((call) => call.method === 'Target.closeTarget')).toBe(false);
  });
});
