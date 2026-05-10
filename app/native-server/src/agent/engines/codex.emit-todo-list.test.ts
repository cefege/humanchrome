/**
 * Unit tests for `CodexEngine.emitTodoListUpdate` (IMP-0049 slice 2).
 * Locks the phase → (messageType, isStreaming, planStatus) mapping that
 * the sidepanel UI relies on so future refactors don't silently flip
 * the contract.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { CodexEngine } from './codex';

type Dispatcher = jest.Mock<
  (
    content: string,
    metadata: Record<string, unknown>,
    messageType: 'tool_use' | 'tool_result',
    isStreaming: boolean,
  ) => void
>;

type Phase = 'started' | 'update' | 'completed';

function setup(): {
  dispatch: Dispatcher;
  emit: (record: Record<string, unknown>, phase: Phase) => void;
} {
  const engine = new CodexEngine();
  const dispatch = jest.fn() as Dispatcher;
  const emit = (record: Record<string, unknown>, phase: Phase): void => {
    (
      engine as unknown as {
        emitTodoListUpdate: (r: Record<string, unknown>, p: Phase, d: Dispatcher) => void;
      }
    ).emitTodoListUpdate(record, phase, dispatch);
  };
  return { dispatch, emit };
}

const SAMPLE_RECORD: Record<string, unknown> = {
  id: 'plan-42',
  items: [
    { text: 'first step', completed: true },
    { text: 'second step', completed: false },
    { text: 'third step', completed: false },
  ],
};

describe('CodexEngine.emitTodoListUpdate', () => {
  it('phase=started → tool_use, isStreaming=false', () => {
    const { dispatch, emit } = setup();
    emit(SAMPLE_RECORD, 'started');
    expect(dispatch).toHaveBeenCalledTimes(1);
    const [content, metadata, messageType, isStreaming] = dispatch.mock.calls[0];
    expect(messageType).toBe('tool_use');
    expect(isStreaming).toBe(false);
    expect(typeof content).toBe('string');
    expect(content.length).toBeGreaterThan(0);
    expect(metadata.planPhase).toBe('started');
    expect(metadata.planStatus).toBe('in_progress');
  });

  it('phase=update → tool_use, isStreaming=true', () => {
    const { dispatch, emit } = setup();
    emit(SAMPLE_RECORD, 'update');
    expect(dispatch).toHaveBeenCalledTimes(1);
    const [, metadata, messageType, isStreaming] = dispatch.mock.calls[0];
    expect(messageType).toBe('tool_use');
    expect(isStreaming).toBe(true);
    expect(metadata.planPhase).toBe('update');
    expect(metadata.planStatus).toBe('in_progress');
  });

  it('phase=completed → tool_result, isStreaming=false, planStatus=completed', () => {
    const { dispatch, emit } = setup();
    emit(SAMPLE_RECORD, 'completed');
    const [, metadata, messageType, isStreaming] = dispatch.mock.calls[0];
    expect(messageType).toBe('tool_result');
    expect(isStreaming).toBe(false);
    expect(metadata.planPhase).toBe('completed');
    expect(metadata.planStatus).toBe('completed');
  });

  it('forwards record.id as metadata.planId', () => {
    const { dispatch, emit } = setup();
    emit(SAMPLE_RECORD, 'started');
    expect(dispatch.mock.calls[0][1].planId).toBe('plan-42');
  });

  it('honors an explicit record.status over the phase-derived default', () => {
    const { dispatch, emit } = setup();
    emit({ ...SAMPLE_RECORD, status: 'paused' }, 'update');
    expect(dispatch.mock.calls[0][1].status).toBe('paused');
  });

  it('ships totalSteps + completedSteps derived from the items list', () => {
    const { dispatch, emit } = setup();
    emit(SAMPLE_RECORD, 'started');
    const metadata = dispatch.mock.calls[0][1];
    expect(metadata.totalSteps).toBe(3);
    expect(metadata.completedSteps).toBe(1);
    expect(Array.isArray(metadata.items)).toBe(true);
    expect((metadata.items as unknown[]).length).toBe(3);
  });

  it('handles a record with no items array (still emits with totalSteps=0)', () => {
    const { dispatch, emit } = setup();
    emit({ id: 'empty' }, 'started');
    expect(dispatch).toHaveBeenCalledTimes(1);
    const metadata = dispatch.mock.calls[0][1];
    expect(metadata.totalSteps).toBe(0);
    expect(metadata.completedSteps).toBe(0);
  });
});
