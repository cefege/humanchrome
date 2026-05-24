/**
 * Stop model — stable-identity wrapper around `GradientStop`.
 *
 * The control needs each color stop to carry an opaque ID so that selection,
 * focus, and drag/keyboard sessions survive re-rendering and reconciliation
 * with parsed CSS values. This module owns ID generation and the conversion
 * helpers between the parser shape (`GradientStop`) and the UI shape
 * (`StopModel`).
 */

import { needsColorPlaceholder } from './color-parser';
import { DEFAULT_STOP_1, DEFAULT_STOP_2, type GradientStop } from './gradient-parser';

/** Unique identifier for a gradient stop (stable across reorder/edit) */
export type StopId = string;

/** Model for a gradient stop with stable identity */
export interface StopModel {
  id: StopId;
  color: string;
  position: number;
  /** Resolved/computed color for display when color contains var() */
  placeholderColor?: string;
}

let stopIdCounter = 0;

/**
 * Generate a unique stop ID using crypto.randomUUID when available,
 * falling back to a counter-based ID.
 */
export function createStopId(): StopId {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // Fallback to counter
  }
  stopIdCounter += 1;
  return `stop_${stopIdCounter}_${Date.now()}`;
}

/** Create default stop models with unique IDs */
export function createDefaultStopModels(): StopModel[] {
  return [
    { id: createStopId(), color: DEFAULT_STOP_1.color, position: DEFAULT_STOP_1.position },
    { id: createStopId(), color: DEFAULT_STOP_2.color, position: DEFAULT_STOP_2.position },
  ];
}

/** Convert GradientStop[] to StopModel[] (assigns new IDs) */
export function toStopModels(stops: GradientStop[]): StopModel[] {
  return stops.map((s) => ({
    id: createStopId(),
    color: s.color,
    position: s.position,
    placeholderColor: s.placeholderColor,
  }));
}

/**
 * Reconcile new stops with existing models to preserve stable IDs.
 * Uses index-based matching when stop count is the same, otherwise creates new models.
 */
export function reconcileStopModels(
  prevModels: StopModel[],
  newStops: GradientStop[],
): StopModel[] {
  // If count matches, preserve IDs by index
  if (prevModels.length === newStops.length) {
    return newStops.map((stop, i) => ({
      id: prevModels[i]?.id ?? createStopId(),
      color: stop.color,
      position: stop.position,
      placeholderColor: stop.placeholderColor,
    }));
  }

  // Count mismatch: create fresh models
  return toStopModels(newStops);
}

/** Get the preview color for a stop (resolved color if contains var(), otherwise raw color) */
export function getStopPreviewColor(stop: Pick<StopModel, 'color' | 'placeholderColor'>): string {
  if (needsColorPlaceholder(stop.color)) {
    const c = stop.placeholderColor?.trim();
    return c ? c : 'transparent';
  }
  return stop.color;
}

/** Convert StopModel[] to GradientStop[] for preview rendering */
export function toPreviewStops(stops: StopModel[]): GradientStop[] {
  return stops.map((s) => ({
    color: getStopPreviewColor(s),
    position: s.position,
  }));
}
