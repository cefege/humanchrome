/**
 * Offscreen Document Communication for the GIF recorder (IMP-0130 split).
 *
 * The offscreen document hosts the gifenc encoder. We send frames /
 * lifecycle commands via chrome.runtime.sendMessage targeted at the
 * Offscreen surface, with a 3-attempt retry to absorb transient
 * sendMessage races during offscreen-document boot.
 */
import {
  MessageTarget,
  type OffscreenMessageType,
} from '@/common/message-types';
import { offscreenManager } from '@/utils/offscreen-manager';

type OffscreenResponseBase = { success: boolean; error?: string };

export async function sendToOffscreen<TResponse extends OffscreenResponseBase>(
  type: OffscreenMessageType,
  payload: Record<string, unknown> = {},
): Promise<TResponse> {
  await offscreenManager.ensureOffscreenDocument();

  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = (await chrome.runtime.sendMessage({
        target: MessageTarget.Offscreen,
        type,
        ...payload,
      })) as TResponse | undefined;

      if (!response) {
        throw new Error('No response received from offscreen document');
      }
      if (!response.success) {
        throw new Error(response.error || 'Unknown offscreen error');
      }

      return response;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
        continue;
      }
      throw error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
