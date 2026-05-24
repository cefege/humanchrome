/**
 * GIF Recorder — module-scope state, constants, and types.
 *
 * Split from the 1338-LoC monolithic gif-recorder.ts (IMP-0130). The
 * recorder is a singleton (the underlying CDP screencast is a single
 * per-Chrome resource — only one gif can be recorded at a time across
 * all clients), so the state lives at module scope and is shared by
 * every helper / action handler. Keeping it in one module means every
 * importer touches the same `let` bindings — splitting state across
 * helper files would have given us two diverging singletons.
 *
 * Mutators are exported as functions (setRecordingState, etc.) so
 * sibling modules can update state without sharing `let` bindings via
 * a cyclic import — TS doesn't propagate updates to re-exported
 * `let` bindings across files reliably.
 */
import { getCurrentRequestContext } from '../../../utils/request-context';
import type { GifEnhancedRenderingConfig } from '../gif-auto-capture';

// ============================================================================
// Constants
// ============================================================================

export const DEFAULT_FPS = 5;
export const DEFAULT_DURATION_MS = 5000;
export const DEFAULT_MAX_FRAMES = 50;
export const DEFAULT_WIDTH = 800;
export const DEFAULT_HEIGHT = 600;
export const DEFAULT_MAX_COLORS = 256;
export const CDP_SESSION_KEY = 'gif-recorder';

// Maximum cache lifetime for exportable GIF (5 minutes)
export const EXPORT_CACHE_LIFETIME_MS = 5 * 60 * 1000;

export const SYSTEM_CLIENT = '__system';

// ============================================================================
// Types
// ============================================================================

export type GifRecorderAction =
  | 'start'
  | 'stop'
  | 'status'
  | 'auto_start'
  | 'capture'
  | 'clear'
  | 'export';

export interface GifRecorderParams {
  action: GifRecorderAction;
  tabId?: number;
  fps?: number;
  durationMs?: number;
  maxFrames?: number;
  width?: number;
  height?: number;
  maxColors?: number;
  filename?: string;
  // Auto-capture mode specific
  captureDelayMs?: number;
  frameDelayCs?: number;
  enhancedRendering?: GifEnhancedRenderingConfig;
  // Manual annotation for action="capture"
  annotation?: string;
  // Export action specific
  download?: boolean; // true to download, false to upload via drag&drop
  coordinates?: { x: number; y: number }; // target position for drag&drop upload
  ref?: string; // element ref for drag&drop upload (alternative to coordinates)
  selector?: string; // CSS selector for drag&drop upload (alternative to coordinates)
}

export interface RecordingState {
  isRecording: boolean;
  isStopping: boolean;
  tabId: number;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  frameIntervalMs: number;
  frameDelayCs: number;
  maxFrames: number;
  maxColors: number;
  frameCount: number;
  startTime: number;
  captureTimer: ReturnType<typeof setTimeout> | null;
  captureInProgress: Promise<void> | null;
  canvas: OffscreenCanvas;
  ctx: OffscreenCanvasRenderingContext2D;
  filename?: string;
}

export interface GifResult {
  success: boolean;
  action: GifRecorderAction;
  tabId?: number;
  frameCount?: number;
  durationMs?: number;
  byteLength?: number;
  downloadId?: number;
  filename?: string;
  fullPath?: string;
  isRecording?: boolean;
  mode?: 'fixed_fps' | 'auto_capture';
  actionsCount?: number;
  error?: string;
  // Clear action specific
  clearedAutoCapture?: boolean;
  clearedFixedFps?: boolean;
  clearedCache?: boolean;
  // Export action specific (drag&drop upload)
  uploadTarget?: {
    x: number;
    y: number;
    tagName?: string;
    id?: string;
  };
}

export interface AutoCaptureMetadata {
  tabId: number;
  filename?: string;
}

// Last recorded GIF cache for export
export interface ExportableGif {
  gifData: Uint8Array;
  width: number;
  height: number;
  frameCount: number;
  durationMs: number;
  tabId: number;
  filename?: string;
  actionsCount?: number;
  mode: 'fixed_fps' | 'auto_capture';
  createdAt: number;
}

// ============================================================================
// Recording State (singleton — see file-header comment)
// ============================================================================

let recordingState: RecordingState | null = null;
let stopPromise: Promise<GifResult> | null = null;

// IMP-0166: which client owns the in-flight singleton recording. Multi-tab-
// by-design: only one GIF recording can be active at a time because the
// underlying CDP screencast is a single per-Chrome resource — but we now
// gate it on a client identity so a second client gets a clear
// "owned by client X" error instead of silently colliding. `null` when no
// recording is active. Set when startRecording/startAutoCapture succeed;
// cleared in stopRecording / stopAutoCapture / on tab close.
let currentRecordingClientId: string | null = null;

let autoCaptureMetadata: AutoCaptureMetadata | null = null;

// IMP-0166 note: `lastRecordedGif` stays singleton for this PR — the
// per-client cache will land in a follow-up. The cross-client visibility
// leak (client B's `action:'export'` can surface client A's last gif)
// is bounded by the 5-minute EXPORT_CACHE_LIFETIME_MS and is strictly
// less impactful than the cross-client *collision* this PR's
// `currentRecordingClientId` gate prevents.
let lastRecordedGif: ExportableGif | null = null;

// ============================================================================
// Accessors (so sibling modules don't have to share `let` bindings via
// re-exports, which TS handles inconsistently across module formats)
// ============================================================================

export function getRecordingState(): RecordingState | null {
  return recordingState;
}

export function setRecordingState(state: RecordingState | null): void {
  recordingState = state;
}

export function getStopPromise(): Promise<GifResult> | null {
  return stopPromise;
}

export function setStopPromise(p: Promise<GifResult> | null): void {
  stopPromise = p;
}

export function getCurrentRecordingClientId(): string | null {
  return currentRecordingClientId;
}

export function setCurrentRecordingClientId(id: string | null): void {
  currentRecordingClientId = id;
}

export function getAutoCaptureMetadata(): AutoCaptureMetadata | null {
  return autoCaptureMetadata;
}

export function setAutoCaptureMetadata(meta: AutoCaptureMetadata | null): void {
  autoCaptureMetadata = meta;
}

export function getLastRecordedGif(): ExportableGif | null {
  return lastRecordedGif;
}

export function setLastRecordedGif(gif: ExportableGif | null): void {
  lastRecordedGif = gif;
}

export function callerClientId(): string {
  return getCurrentRequestContext()?.clientId ?? SYSTEM_CLIENT;
}
