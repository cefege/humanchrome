/**
 * Frame capture primitives for the GIF recorder (IMP-0130 split).
 *
 * captureFrame — CDP screenshot → scaled ImageData
 * captureAndEncodeFrame — captureFrame → offscreen GIF_ADD_FRAME
 *
 * The fixed-FPS tick loop (`captureTick`) lives in fixed-fps.ts because
 * it depends on `stopRecording` and would otherwise create a cyclic
 * top-level import between the two modules.
 */
import { OFFSCREEN_MESSAGE_TYPES } from '@/common/message-types';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { createImageBitmapFromUrl } from '@/utils/image-utils';
import { sendToOffscreen } from './offscreen';
import { getRecordingState, type RecordingState } from './state';

export async function captureFrame(
  tabId: number,
  width: number,
  height: number,
  ctx: OffscreenCanvasRenderingContext2D,
): Promise<Uint8ClampedArray> {
  // Get viewport metrics
  const metrics: { layoutViewport?: { clientWidth: number; clientHeight: number } } =
    await cdpSessionManager.sendCommand(tabId, 'Page.getLayoutMetrics', {});

  const viewportWidth = metrics.layoutViewport?.clientWidth || width;
  const viewportHeight = metrics.layoutViewport?.clientHeight || height;

  // Capture screenshot
  const screenshot: { data: string } = await cdpSessionManager.sendCommand(
    tabId,
    'Page.captureScreenshot',
    {
      format: 'png',
      clip: {
        x: 0,
        y: 0,
        width: viewportWidth,
        height: viewportHeight,
        scale: 1,
      },
    },
  );

  const imageBitmap = await createImageBitmapFromUrl(`data:image/png;base64,${screenshot.data}`);

  // Scale image to target dimensions
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(imageBitmap, 0, 0, width, height);
  imageBitmap.close();

  const imageData = ctx.getImageData(0, 0, width, height);
  return imageData.data;
}

export async function captureAndEncodeFrame(state: RecordingState): Promise<void> {
  const frameData = await captureFrame(state.tabId, state.width, state.height, state.ctx);

  await sendToOffscreen(OFFSCREEN_MESSAGE_TYPES.GIF_ADD_FRAME, {
    imageData: Array.from(frameData),
    width: state.width,
    height: state.height,
    delay: state.frameDelayCs,
    maxColors: state.maxColors,
  });

  if (getRecordingState() === state && state.isRecording && !state.isStopping) {
    state.frameCount += 1;
  }
}
