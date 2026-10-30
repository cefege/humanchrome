import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { RUST_KERNEL_ID } from 'humanchrome-shared';
import { getPackagedRustKernelBytes } from '@/shared/rust-kernel';

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

class RecorderKernelInitializationError extends Error {}

async function installRecorder(
  target: chrome.scripting.InjectionTarget,
  bytes: number[],
): Promise<void> {
  await chrome.scripting.executeScript({
    target,
    files: [SELECTOR_BUNDLE_SCRIPT],
    world: 'ISOLATED',
  });
  // Chrome serializes args as JSON. Transfer bytes, never an ArrayBuffer or Module.
  // A serialized async function can capture build-generated helpers; return the Promise directly.
  const initialized = await chrome.scripting.executeScript({
    target,
    world: 'ISOLATED',
    args: [bytes],
    func: (kernelBytes: number[]) => {
      try {
        const initialize = (
          globalThis as typeof globalThis & {
            __hcInitializeRustKernel?: (input: number[]) => Promise<void>;
          }
        ).__hcInitializeRustKernel;
        if (!initialize) throw new Error('Recorder kernel bootstrap is unavailable');
        return initialize(kernelBytes).then(
          () => ({ ready: true }) as const,
          (error: unknown) => ({ ready: false, error: String(error) }) as const,
        );
      } catch (error) {
        return { ready: false, error: String(error) } as const;
      }
    },
  });
  for (const frame of initialized) {
    if (frame.result?.ready !== true) {
      throw new RecorderKernelInitializationError(
        `Recorder Rust initialization failed in frame ${frame.frameId}: ${frame.result?.error ?? 'No readiness result returned'}`,
      );
    }
  }
  // The first recorder event must see the fully initialized selector engine.
  await chrome.scripting.executeScript({
    target,
    files: [RECORDER_JS_SCRIPT],
    world: 'ISOLATED',
  });
}

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
        if (res?.status !== 'pong') {
          needRecorder.push(frameId);
          return;
        }
        const probe = await chrome.scripting.executeScript({
          target: { tabId, frameIds: [frameId] },
          world: 'ISOLATED',
          args: [RUST_KERNEL_ID],
          func: (kernelId: string) => {
            const realm = globalThis as typeof globalThis & {
              __hcRustKernelId?: string;
              __rrSelectorEngine?: unknown;
            };
            return realm.__hcRustKernelId === kernelId && !!realm.__rrSelectorEngine;
          },
        });
        if (!probe[0]?.result) needRecorder.push(frameId);
      } catch {
        needRecorder.push(frameId);
      }
    }),
  );

  if (needRecorder.length > 0) {
    const bytes = Array.from(await getPackagedRustKernelBytes());
    try {
      await installRecorder({ tabId, frameIds: needRecorder }, bytes);
    } catch (error) {
      if (error instanceof RecorderKernelInitializationError) throw error;
      // Preserve the existing bounded fallback for frames replaced during injection.
      try {
        await installRecorder({ tabId, allFrames: true }, bytes);
      } catch (fallbackError) {
        if (fallbackError instanceof RecorderKernelInitializationError) throw fallbackError;
        // Inaccessible/removed frames remain a best-effort browser effect.
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
