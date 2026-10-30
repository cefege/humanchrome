/**
 * Snap Engine (Phase 4.2)
 *
 * Computes snapping and alignment guide lines for interactive resize operations.
 *
 * Architecture:
 * - Anchor collection (DOM reads) - called once per gesture to avoid layout thrash
 * - Pure geometry computation (called every frame) - no DOM access
 *
 * Performance considerations:
 * - Siblings are collected once when gesture threshold is exceeded
 * - Distance-based filtering limits anchor count to nearest N elements
 * - Lock/hysteresis mechanism prevents flicker at threshold boundaries
 */

import {
  computeEditorSnap,
  computeEditorSnapDistanceLabels,
} from 'humanchrome-shared';
import {
  WEB_EDITOR_V2_SNAP_MAX_ANCHOR_ELEMENTS,
  WEB_EDITOR_V2_SNAP_MAX_SIBLINGS_SCAN,
} from '../constants';
import type { DistanceLabel, ViewportLine, ViewportRect } from '../overlay/canvas-overlay';

// =============================================================================
// Types
// =============================================================================

/** Source of a snap anchor */
export type SnapAnchorSource = 'sibling' | 'viewport';

/** X-axis anchor types (edges and center) */
export type SnapAnchorXType = 'left' | 'center' | 'right';

/** Y-axis anchor types (edges and center) */
export type SnapAnchorYType = 'top' | 'middle' | 'bottom';

/** Union of all anchor types */
export type SnapAnchorType = SnapAnchorXType | SnapAnchorYType;

/** Base interface for snap anchors */
interface SnapAnchorBase<TType extends SnapAnchorType> {
  /** Anchor coordinate in viewport space */
  readonly value: number;
  /** Type of anchor (which edge or center) */
  readonly type: TType;
  /** Where this anchor came from */
  readonly source: SnapAnchorSource;
  /** Source element rect (for guide line extent calculation) */
  readonly sourceRect?: ViewportRect;
}

/** X-axis snap anchor */
export type SnapAnchorX = SnapAnchorBase<SnapAnchorXType>;

/** Y-axis snap anchor */
export type SnapAnchorY = SnapAnchorBase<SnapAnchorYType>;

/** Collection of anchors for both axes */
export interface SnapAnchors {
  readonly x: readonly SnapAnchorX[];
  readonly y: readonly SnapAnchorY[];
}

/** Active snap lock state for X axis */
export interface SnapLockX {
  readonly type: SnapAnchorXType;
  readonly value: number;
  readonly source: SnapAnchorSource;
  readonly sourceRect: ViewportRect | null;
}

/** Active snap lock state for Y axis */
export interface SnapLockY {
  readonly type: SnapAnchorYType;
  readonly value: number;
  readonly source: SnapAnchorSource;
  readonly sourceRect: ViewportRect | null;
}

/** Result of snap computation */
export interface SnapResult {
  /** Rectangle after snapping applied */
  readonly snappedRect: ViewportRect;
  /** Guide lines to render */
  readonly guideLines: readonly ViewportLine[];
  /** Active X-axis lock (for hysteresis) */
  readonly lockX: SnapLockX | null;
  /** Active Y-axis lock (for hysteresis) */
  readonly lockY: SnapLockY | null;
}

/** Resize direction info for snap computation */
export interface ResizeDirection {
  readonly hasWest: boolean;
  readonly hasEast: boolean;
  readonly hasNorth: boolean;
  readonly hasSouth: boolean;
}

/** Viewport dimensions for guide line calculation */
export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

/** Parameters for computeResizeSnap */
export interface ComputeResizeSnapParams {
  /** Current proposed rectangle (before snapping) */
  readonly rect: ViewportRect;
  /** Which directions are being resized */
  readonly resize: ResizeDirection;
  /** Available snap anchors */
  readonly anchors: SnapAnchors;
  /** Distance threshold for snap activation (px) */
  readonly thresholdPx: number;
  /** Additional distance to maintain lock once snapped (px) */
  readonly hysteresisPx: number;
  /** Minimum allowed element size (px) */
  readonly minSizePx: number;
  /** Current X-axis lock from previous frame */
  readonly lockX: SnapLockX | null;
  /** Current Y-axis lock from previous frame */
  readonly lockY: SnapLockY | null;
  /** Viewport dimensions for guide line extent calculation */
  readonly viewport: ViewportSize;
}

/** Parameters for computeDistanceLabels (Phase 4.3) */
export interface ComputeDistanceLabelsParams {
  /** Current rectangle (typically snappedRect from computeResizeSnap) */
  readonly rect: ViewportRect;
  /** Active X-axis lock (from snap result) */
  readonly lockX: SnapLockX | null;
  /** Active Y-axis lock (from snap result) */
  readonly lockY: SnapLockY | null;
  /** Viewport dimensions */
  readonly viewport: ViewportSize;
  /** Minimum gap (px) to display label - hides 0 and sub-pixel gaps */
  readonly minGapPx: number;
}

// =============================================================================
// Internal Types
// =============================================================================

/** Fixed edge during resize (opposite to drag direction) */
type FixedEdgeX = 'left' | 'right' | null;
type FixedEdgeY = 'top' | 'bottom' | null;

/** Candidate for best snap match */
interface SnapCandidate<TAnchor> {
  readonly distance: number;
  readonly anchor: TAnchor;
  readonly snappedRect: ViewportRect;
}

// =============================================================================
// Utility Functions
// =============================================================================

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isValidRect(rect: ViewportRect | null): rect is ViewportRect {
  if (!rect) return false;
  return (
    isFiniteNumber(rect.left) &&
    isFiniteNumber(rect.top) &&
    isFiniteNumber(rect.width) &&
    isFiniteNumber(rect.height) &&
    rect.width > 0.5 &&
    rect.height > 0.5
  );
}

function readElementRect(element: Element): ViewportRect | null {
  try {
    const r = element.getBoundingClientRect();
    const rect: ViewportRect = {
      left: r.left,
      top: r.top,
      width: r.width,
      height: r.height,
    };
    return isValidRect(rect) ? rect : null;
  } catch {
    return null;
  }
}

// Rectangle edge/center accessors
function rectRight(r: ViewportRect): number {
  return r.left + r.width;
}

function rectBottom(r: ViewportRect): number {
  return r.top + r.height;
}

function rectCenterX(r: ViewportRect): number {
  return r.left + r.width / 2;
}

function rectCenterY(r: ViewportRect): number {
  return r.top + r.height / 2;
}

/** Get X coordinate for a specific anchor type from a rect */
function getRectXValue(rect: ViewportRect, type: SnapAnchorXType): number {
  switch (type) {
    case 'left':
      return rect.left;
    case 'center':
      return rectCenterX(rect);
    case 'right':
      return rectRight(rect);
  }
}

/** Get Y coordinate for a specific anchor type from a rect */
function getRectYValue(rect: ViewportRect, type: SnapAnchorYType): number {
  switch (type) {
    case 'top':
      return rect.top;
    case 'middle':
      return rectCenterY(rect);
    case 'bottom':
      return rectBottom(rect);
  }
}

// =============================================================================
// Anchor Collection
// =============================================================================

function createEmptyAnchors(): SnapAnchors {
  return { x: [], y: [] };
}

/**
 * Collect snap anchors from sibling elements.
 *
 * Strategy:
 * 1. Find target's index in parent.children
 * 2. Scan outward from target (windowed scan) to avoid missing nearby siblings
 *    when target is in the middle/end of a large children list
 * 3. Read bounding rects (single layout pass per element)
 * 4. Sort by distance to target center
 * 5. Take nearest N elements
 * 6. Extract left/center/right and top/middle/bottom anchors
 *
 * Uses a bidirectional windowed scan from the target's index outward so that
 * when the target sits late in a large children list we still find nearby
 * siblings instead of running off the start of the list.
 */
export function collectSiblingAnchors(target: Element): SnapAnchors {
  const parent = target.parentElement;
  if (!parent) return createEmptyAnchors();

  const targetRect = readElementRect(target);
  const refX = targetRect ? rectCenterX(targetRect) : 0;
  const refY = targetRect ? rectCenterY(targetRect) : 0;

  const children = parent.children;
  const childCount = children.length;

  // Find target index for windowed scan
  let targetIndex = -1;
  for (let i = 0; i < childCount; i++) {
    if (children[i] === target) {
      targetIndex = i;
      break;
    }
  }
  if (targetIndex === -1) return createEmptyAnchors();

  // Windowed scan: expand outward from target index
  // This ensures we scan nearby siblings first regardless of target position
  const candidates: Array<{ rect: ViewportRect; distanceSquared: number }> = [];
  let scanned = 0;
  let leftOffset = 1;
  let rightOffset = 1;

  while (scanned < WEB_EDITOR_V2_SNAP_MAX_SIBLINGS_SCAN) {
    const leftIndex = targetIndex - leftOffset;
    const rightIndex = targetIndex + rightOffset;
    const canGoLeft = leftIndex >= 0;
    const canGoRight = rightIndex < childCount;

    if (!canGoLeft && !canGoRight) break;

    // Scan left
    if (canGoLeft) {
      const child = children[leftIndex];
      const rect = readElementRect(child);
      if (rect) {
        const dx = rectCenterX(rect) - refX;
        const dy = rectCenterY(rect) - refY;
        candidates.push({ rect, distanceSquared: dx * dx + dy * dy });
      }
      scanned++;
      leftOffset++;
    }

    // Scan right
    if (canGoRight && scanned < WEB_EDITOR_V2_SNAP_MAX_SIBLINGS_SCAN) {
      const child = children[rightIndex];
      const rect = readElementRect(child);
      if (rect) {
        const dx = rectCenterX(rect) - refX;
        const dy = rectCenterY(rect) - refY;
        candidates.push({ rect, distanceSquared: dx * dx + dy * dy });
      }
      scanned++;
      rightOffset++;
    }
  }

  // Sort by distance and take nearest
  candidates.sort((a, b) => a.distanceSquared - b.distanceSquared);
  const selected = candidates.slice(0, WEB_EDITOR_V2_SNAP_MAX_ANCHOR_ELEMENTS);

  // Build anchor arrays
  const xAnchors: SnapAnchorX[] = [];
  const yAnchors: SnapAnchorY[] = [];

  for (const { rect } of selected) {
    // X-axis anchors
    xAnchors.push({ type: 'left', value: rect.left, source: 'sibling', sourceRect: rect });
    xAnchors.push({
      type: 'center',
      value: rectCenterX(rect),
      source: 'sibling',
      sourceRect: rect,
    });
    xAnchors.push({ type: 'right', value: rectRight(rect), source: 'sibling', sourceRect: rect });

    // Y-axis anchors
    yAnchors.push({ type: 'top', value: rect.top, source: 'sibling', sourceRect: rect });
    yAnchors.push({
      type: 'middle',
      value: rectCenterY(rect),
      source: 'sibling',
      sourceRect: rect,
    });
    yAnchors.push({ type: 'bottom', value: rectBottom(rect), source: 'sibling', sourceRect: rect });
  }

  return { x: xAnchors, y: yAnchors };
}

/**
 * Collect snap anchors from viewport boundaries.
 *
 * Provides left/center/right edges at x=0, x=viewport/2, x=viewport
 * and top/middle/bottom edges at corresponding y positions.
 */
export function collectViewportAnchors(): SnapAnchors {
  const viewportWidth = Math.max(1, window.innerWidth || 1);
  const viewportHeight = Math.max(1, window.innerHeight || 1);

  return {
    x: [
      { type: 'left', value: 0, source: 'viewport' },
      { type: 'center', value: viewportWidth / 2, source: 'viewport' },
      { type: 'right', value: viewportWidth, source: 'viewport' },
    ],
    y: [
      { type: 'top', value: 0, source: 'viewport' },
      { type: 'middle', value: viewportHeight / 2, source: 'viewport' },
      { type: 'bottom', value: viewportHeight, source: 'viewport' },
    ],
  };
}

/**
 * Merge multiple anchor collections into one.
 */
export function mergeAnchors(...collections: SnapAnchors[]): SnapAnchors {
  const x: SnapAnchorX[] = [];
  const y: SnapAnchorY[] = [];

  for (const collection of collections) {
    x.push(...collection.x);
    y.push(...collection.y);
  }

  return { x, y };
}

// =============================================================================
// Rust-owned snap policy
// =============================================================================

/**
 * Computes snapping for one resize frame. Candidate ranking, geometry, guide extents, and
 * hysteresis all execute in the Rust policy kernel; this compatibility wrapper preserves the
 * original CSSOM-facing surface.
 */
export function computeResizeSnap(params: ComputeResizeSnapParams): SnapResult {
  return computeEditorSnap(params as Parameters<typeof computeEditorSnap>[0]) as SnapResult;
}

/**
 * Computes active-lock distance labels in the Rust policy kernel.
 */
export function computeDistanceLabels(params: ComputeDistanceLabelsParams): DistanceLabel[] {
  return computeEditorSnapDistanceLabels(
    params as Parameters<typeof computeEditorSnapDistanceLabels>[0],
  ) as DistanceLabel[];
}
