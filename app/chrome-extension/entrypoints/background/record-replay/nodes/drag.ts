import { TOOL_NAMES } from 'humanchrome-shared';
import { handleCallTool } from '@/entrypoints/background/tools';
import type { StepDrag } from '../legacy-types';
import { locateElement } from '../selector-engine';
import type { ExecCtx, ExecResult, NodeRuntime } from './types';

export const dragNode: NodeRuntime<StepDrag> = {
  run: async (_ctx: ExecCtx, step: StepDrag) => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs?.[0]?.id;
    let startRef: string | undefined;
    let endRef: string | undefined;
    try {
      if (typeof tabId === 'number') {
        const locatedStart = await locateElement(tabId, step.start);
        const locatedEnd = await locateElement(tabId, step.end);
        startRef = locatedStart?.ref || step.start.ref;
        endRef = locatedEnd?.ref || step.end.ref;
      }
    } catch {}
    let startCoordinates: { x: number; y: number } | undefined;
    let endCoordinates: { x: number; y: number } | undefined;
    if ((!startRef || !endRef) && Array.isArray(step.path) && step.path.length >= 2) {
      startCoordinates = { x: Number(step.path[0].x), y: Number(step.path[0].y) };
      const last = step.path[step.path.length - 1];
      endCoordinates = { x: Number(last.x), y: Number(last.y) };
    }
    const res = await handleCallTool({
      name: TOOL_NAMES.BROWSER.COMPUTER,
      args: {
        action: 'left_click_drag',
        startRef,
        ref: endRef,
        startCoordinates,
        coordinates: endCoordinates,
      },
    });
    if ((res as { isError?: boolean }).isError) throw new Error('drag failed');
    return {} as ExecResult;
  },
};
