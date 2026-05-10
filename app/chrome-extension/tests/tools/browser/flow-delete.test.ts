/**
 * record_replay_flow_delete tests (IMP-0018).
 *
 * Locks the contract: rejects without a flowId, rejects when the flow
 * doesn't exist, always unpublishes before deleting (no orphaned
 * dynamic flow.<slug> tool), reports `unpublished:true` only when the
 * flow was published before deletion. Survives a publish-list failure
 * mid-call (proceeds with delete; reports unpublished:false).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/entrypoints/background/record-replay/flow-store', () => ({
  listPublished: vi.fn(),
  getFlow: vi.fn(),
  deleteFlow: vi.fn(),
  unpublishFlow: vi.fn(),
}));

vi.mock('@/entrypoints/background/record-replay/flow-runner', () => ({
  runFlow: vi.fn(),
}));

import { flowDeleteTool } from '@/entrypoints/background/tools/record-replay';
import {
  listPublished,
  getFlow,
  deleteFlow,
  unpublishFlow,
} from '@/entrypoints/background/record-replay/flow-store';

const mockListPublished = vi.mocked(listPublished);
const mockGetFlow = vi.mocked(getFlow);
const mockDeleteFlow = vi.mocked(deleteFlow);
const mockUnpublishFlow = vi.mocked(unpublishFlow);

beforeEach(() => {
  mockListPublished.mockReset().mockResolvedValue([]);
  mockGetFlow.mockReset().mockResolvedValue(undefined);
  mockDeleteFlow.mockReset().mockResolvedValue(undefined);
  mockUnpublishFlow.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

describe('record_replay_flow_delete', () => {
  it('rejects when flowId is missing', async () => {
    const res = await flowDeleteTool.execute({});
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('INVALID_ARGS');
    expect((res.content[0] as any).text).toContain('flowId');
  });

  it('rejects when flowId is whitespace-only (treated as missing)', async () => {
    const res = await flowDeleteTool.execute({ flowId: '   ' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('INVALID_ARGS');
  });

  it('rejects when the flow does not exist', async () => {
    mockGetFlow.mockResolvedValueOnce(undefined);
    const res = await flowDeleteTool.execute({ flowId: 'gone' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('Flow not found');
    expect((res.content[0] as any).text).toContain('gone');
    expect(mockDeleteFlow).not.toHaveBeenCalled();
    expect(mockUnpublishFlow).not.toHaveBeenCalled();
  });

  it('unpublishes then deletes when the flow is published, reports unpublished:true', async () => {
    mockGetFlow.mockResolvedValueOnce({ id: 'f1', name: 'flow-1' } as any);
    mockListPublished.mockResolvedValueOnce([
      { id: 'f1', slug: 'flow-1', version: 1, name: 'flow-1' },
    ]);

    const body = parseBody(await flowDeleteTool.execute({ flowId: 'f1' }));
    expect(body).toEqual({ deleted: true, unpublished: true, flowId: 'f1' });
    expect(mockUnpublishFlow).toHaveBeenCalledWith('f1');
    expect(mockDeleteFlow).toHaveBeenCalledWith('f1');
    // Order: unpublish must happen before delete (no orphaned flow.<slug>).
    const unpubOrder = mockUnpublishFlow.mock.invocationCallOrder[0];
    const delOrder = mockDeleteFlow.mock.invocationCallOrder[0];
    expect(unpubOrder).toBeLessThan(delOrder);
  });

  it('reports unpublished:false when the flow exists but is not published', async () => {
    mockGetFlow.mockResolvedValueOnce({ id: 'f2', name: 'unpub' } as any);
    mockListPublished.mockResolvedValueOnce([]);

    const body = parseBody(await flowDeleteTool.execute({ flowId: 'f2' }));
    expect(body).toEqual({ deleted: true, unpublished: false, flowId: 'f2' });
    // unpublishFlow is still called (idempotent) — covers the no-op case
    // for storage backends that silently succeed.
    expect(mockUnpublishFlow).toHaveBeenCalledWith('f2');
    expect(mockDeleteFlow).toHaveBeenCalledWith('f2');
  });

  it('proceeds with delete when listPublished throws (reports unpublished:false)', async () => {
    mockGetFlow.mockResolvedValueOnce({ id: 'f3', name: 'storm' } as any);
    mockListPublished.mockRejectedValueOnce(new Error('storage temporarily unavailable'));

    const body = parseBody(await flowDeleteTool.execute({ flowId: 'f3' }));
    expect(body.deleted).toBe(true);
    expect(body.unpublished).toBe(false);
    expect(mockDeleteFlow).toHaveBeenCalledWith('f3');
  });

  it('proceeds with delete when unpublishFlow throws (the IndexedDB delete is the source of truth)', async () => {
    mockGetFlow.mockResolvedValueOnce({ id: 'f4', name: 'broken' } as any);
    mockListPublished.mockResolvedValueOnce([
      { id: 'f4', slug: 'broken', version: 1, name: 'broken' },
    ]);
    mockUnpublishFlow.mockRejectedValueOnce(new Error('publish key not found'));

    const body = parseBody(await flowDeleteTool.execute({ flowId: 'f4' }));
    expect(body.deleted).toBe(true);
    // wasPublished is determined BEFORE the failing unpublish call, so it
    // still reports the truth.
    expect(body.unpublished).toBe(true);
    expect(mockDeleteFlow).toHaveBeenCalledWith('f4');
  });

  it('classifies a deleteFlow rejection as UNKNOWN', async () => {
    mockGetFlow.mockResolvedValueOnce({ id: 'f5', name: 'die' } as any);
    mockDeleteFlow.mockRejectedValueOnce(new Error('IndexedDB quota exceeded'));

    const res = await flowDeleteTool.execute({ flowId: 'f5' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('UNKNOWN');
    expect((res.content[0] as any).text).toContain('quota exceeded');
  });
});
