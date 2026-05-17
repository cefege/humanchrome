import { TOOL_MESSAGE_TYPES } from '@/common/message-types';

// Avoid magic strings for recorder control commands
export type RecorderCmd = 'start' | 'stop' | 'pause' | 'resume';
export const REC_CMD = {
  START: 'start',
  STOP: 'stop',
  PAUSE: 'pause',
  RESUME: 'resume',
} as const satisfies Record<string, RecorderCmd>;

const SELECTOR_BUNDLE_SCRIPT = 'inject-scripts/selector-engine-bundle.js';
const RECORDER_JS_SCRIPT = 'inject-scripts/recorder.js';

/**
 * Files injected for recording, in order. The selector-engine bundle MUST
 * land before recorder.js so the SelectorEngine shim can read
 * `window.__rrSelectorEngine`. Both files self-guard against double-install
 * (selector bundle: idempotent assignment; recorder: __RR_RECORDER_INSTALLED__).
 */
const RECORDER_FILES: ReadonlyArray<string> = [SELECTOR_BUNDLE_SCRIPT, RECORDER_JS_SCRIPT];

export async function ensureRecorderInjected(tabId: number): Promise<void> {
  // Discover frames (top + subframes)
  let frames: Array<{ frameId: number } & Record<string, any>> = [];
  try {
    const res = (await chrome.webNavigation.getAllFrames({ tabId })) as
      | Array<{ frameId: number } & Record<string, any>>
      | null
      | undefined;
    frames = Array.isArray(res) ? res : [];
  } catch {
    // ignore and fallback to top frame only
  }
  if (frames.length === 0) frames = [{ frameId: 0 }];

  const needRecorder: number[] = [];
  await Promise.all(
    frames.map(async (f) => {
      const frameId = f.frameId ?? 0;
      try {
        const res = await chrome.tabs.sendMessage(
          tabId,
          { action: 'rr_recorder_ping' },
          { frameId },
        );
        const pong = res?.status === 'pong';
        if (!pong) needRecorder.push(frameId);
      } catch {
        needRecorder.push(frameId);
      }
    }),
  );

  if (needRecorder.length > 0) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: needRecorder },
        files: [...RECORDER_FILES],
        world: 'ISOLATED',
      });
    } catch {
      // Fallback: try allFrames to cover dynamic/subframe changes; safe due to idempotent guard in recorder.js
      try {
        await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          files: [...RECORDER_FILES],
          world: 'ISOLATED',
        });
      } catch {
        // ignore injection failures per-tab
      }
    }
  }
}

export async function broadcastControlToTab(
  tabId: number,
  cmd: RecorderCmd,
  meta?: unknown,
): Promise<void> {
  try {
    const res = (await chrome.webNavigation.getAllFrames({ tabId })) as
      | Array<{ frameId: number } & Record<string, any>>
      | null
      | undefined;
    const targets = Array.isArray(res) && res.length ? res : [{ frameId: 0 }];
    await Promise.all(
      targets.map(async (f) => {
        try {
          await chrome.tabs.sendMessage(
            tabId,
            { action: TOOL_MESSAGE_TYPES.RR_RECORDER_CONTROL, cmd, meta },
            { frameId: f.frameId },
          );
        } catch {
          // ignore per-frame send failure
        }
      }),
    );
  } catch {
    // ignore
  }
}
