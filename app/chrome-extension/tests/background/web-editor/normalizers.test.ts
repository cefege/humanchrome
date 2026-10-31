import { describe, expect, it } from 'vitest';

import {
  normalizeApplyBatchPayload,
  normalizeApplyPayload,
  normalizeString,
} from '@/entrypoints/background/web-editor/normalizers';

describe('web-editor apply payload normalization', () => {
  it('retains array whitespace while trimming fields and style maps by their historical rules', () => {
    expect(
      normalizeApplyPayload({
        pageUrl: ' https://example.test/path ',
        targetFile: ' src/App.tsx ',
        techStackHint: [' React ', '', 4, '  '],
        fingerprint: {
          tag: ' button ',
          id: ' save ',
          classes: ['btn', '', 5, '  '],
          text: ' Save ',
        },
        instruction: {
          type: ' update_style ',
          description: ' change color ',
          style: { color: ' red ', ' ': 'x', opacity: '', width: 0 },
        },
        selectorCandidates: ['#save', '', 1],
        debugSource: { file: ' src/App.tsx ', line: '4', column: 0, componentName: ' SaveButton ' },
        operation: {
          type: 'update_style',
          before: { color: 'blue', opacity: '' },
          after: { color: '', opacity: '0.5' },
          removed: ['color', '', 9],
        },
      }),
    ).toEqual({
      pageUrl: 'https://example.test/path',
      targetFile: 'src/App.tsx',
      fingerprint: { tag: 'button', id: 'save', classes: ['btn', '  '], text: 'Save' },
      techStackHint: [' React ', '  '],
      instruction: {
        type: 'update_style',
        description: 'change color',
        text: undefined,
        style: { color: 'red' },
      },
      selectorCandidates: ['#save'],
      debugSource: { file: 'src/App.tsx', line: 4, column: 0, componentName: 'SaveButton' },
      operation: {
        type: 'update_style',
        before: { color: 'blue', opacity: '' },
        after: { color: '', opacity: '0.5' },
        removed: ['color'],
      },
    });
  });

  it('preserves validation order and exact errors', () => {
    expect(() => normalizeApplyPayload({})).toThrow('Invalid instruction.type');
    expect(() => normalizeApplyPayload({ pageUrl: 'x', instruction: { type: 'other' } })).toThrow(
      'Invalid instruction.type',
    );
    expect(() =>
      normalizeApplyPayload({ instruction: { type: 'update_text', description: 'd' } }),
    ).toThrow('pageUrl is required');
    expect(() =>
      normalizeApplyPayload({ pageUrl: 'x', instruction: { type: 'update_text' } }),
    ).toThrow('instruction.description is required');

    expect(
      normalizeApplyPayload({
        pageUrl: 'x',
        fingerprint: {},
        instruction: { type: 'update_text', description: 'd' },
      }).fingerprint,
    ).toEqual({ tag: 'unknown', id: undefined, classes: [], text: undefined });
  });

  it('retains the batch element collection and normalizes only portable batch policy', () => {
    const elements = [{ elementKey: 'first' }];
    const normalized = normalizeApplyBatchPayload({
      tabId: '2.5',
      elements,
      excludedKeys: [' first ', '', 0, '  '],
      pageUrl: ' /page ',
    });

    expect(normalized).toEqual({
      tabId: 2.5,
      elements,
      excludedKeys: ['first'],
      pageUrl: '/page',
    });
    expect(normalized.elements).toBe(elements);
    expect(normalizeApplyBatchPayload({ tabId: Infinity })).toEqual({
      tabId: 0,
      elements: [],
      excludedKeys: [],
      pageUrl: undefined,
    });
  });

  it('keeps normalizeString available to router callers', () => {
    expect(normalizeString('value')).toBe('value');
    expect(normalizeString(null)).toBe('');
    expect(normalizeString({ value: 'value' })).toBe('');
  });
});
