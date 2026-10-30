import { describe, expect, it } from 'vitest';
import { rankSelectorCandidates, sortSelectorCandidates, type SelectorCandidate } from './rust-selector';

describe('Rust selector host resource boundary', () => {
  it('ranks declared policy fields without serializing cyclic host metadata', () => {
    const host: { self?: unknown } = {};
    host.self = host;
    const buffer = new Float32Array([1, 2]);
    const stability = { score: 0.9, note: 'supplied', host };
    const candidate = { type: 'css', value: '#opaque', stability, host, buffer } satisfies SelectorCandidate & { host: object; buffer: Float32Array };
    const options = { maxCandidates: 1, root: host };
    const ranked = rankSelectorCandidates([candidate], options);
    expect(ranked.selector).toBe('#opaque');
    expect(ranked.candidates[0].host).toBe(host);
    expect(ranked.candidates[0].buffer).toBe(buffer);
    expect(ranked.candidates[0].stability).toBe(stability);
    const sorted = sortSelectorCandidates(ranked.candidates);
    expect(sorted[0]?.host).toBe(host);
    expect(sorted[0]?.stability).toBe(stability);
  });
});
