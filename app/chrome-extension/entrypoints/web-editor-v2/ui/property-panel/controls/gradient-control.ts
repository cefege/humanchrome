/**
 * Gradient Control
 *
 * Edits inline `background-image` gradients:
 * - linear-gradient(<angle>deg, <stop1>, <stop2>, ...)
 * - radial-gradient([<shape>] [at <x>% <y>%], <stop1>, <stop2>, ...)
 *
 * Supports:
 * - Multiple color stops (2+)
 * - Numeric angles (deg) and percent positions
 *
 * Current UI Limitation:
 * - UI currently edits only the first 2 stops (parser supports N stops)
 *
 * Structure (split per IMP-0147):
 * - `gradient-control/color-parser.ts` — hex/rgb parsing, RGBA math, interpolation
 * - `gradient-control/gradient-parser.ts` — CSS gradient string → structured shape
 * - `gradient-control/stop-model.ts` — stable-identity stop models
 * - this file — the DesignControl factory + Vue/DOM wiring
 */

import { Disposer } from '../../../utils/disposables';
import type { StyleTransactionHandle, TransactionManager } from '../../../core/transaction-manager';
import type { DesignTokensService } from '../../../core/design-tokens';
import { createColorField, type ColorField } from './color-field';
import { wireNumberStepping } from './number-stepping';
import type { DesignControl } from '../types';
import { isFieldFocused, readComputedValue, readInlineValue } from './css-helpers';
import {
  clampNumber,
  interpolateRgba,
  needsColorPlaceholder,
  parseHexColorToRgba,
  parseRgbColorToRgba,
  rgbaToCss,
  type RgbaColor,
} from './gradient-control/color-parser';
import {
  buildPlaceholderMapping,
  clampAngle,
  clampPercent,
  DEFAULT_LINEAR_ANGLE,
  DEFAULT_POSITION,
  DEFAULT_STOP_1,
  DEFAULT_STOP_2,
  GRADIENT_TYPES,
  type GradientStop,
  type GradientType,
  isNoneValue,
  parseGradient,
  parseNumber,
  type ParsedGradient,
  RADIAL_SHAPES,
  type RadialShape,
} from './gradient-control/gradient-parser';
import {
  createDefaultStopModels,
  createStopId,
  getStopPreviewColor,
  reconcileStopModels,
  type StopId,
  type StopModel,
} from './gradient-control/stop-model';

// =============================================================================
// UI-only types (drag/keyboard sessions)
// =============================================================================

/**
 * Drag session state for thumb dragging.
 * Tracks the active drag operation with all data needed for
 * real-time preview and rollback on cancel.
 */
interface ThumbDragSession {
  /** ID of the stop being dragged */
  stopId: StopId;
  /** Pointer identifier for the drag gesture (used to filter multi-touch) */
  pointerId: number;
  /** Position snapshot before drag started (for rollback on Escape) */
  initialPositions: Map<StopId, number>;
  /** The thumb element being dragged (for pointer capture) */
  thumbElement: HTMLElement;
}

/**
 * Keyboard session state for thumb stepping (Arrow keys).
 * Maintains a snapshot for Escape rollback and keeps thumbs stable during stepping.
 */
interface ThumbKeyboardSession {
  /** ID of the stop being adjusted */
  stopId: StopId;
  /** Position snapshot before stepping started (for rollback on Escape) */
  initialPositions: Map<StopId, number>;
  /** The thumb element being adjusted (focus anchor) */
  thumbElement: HTMLElement;
}

// =============================================================================
// Factory
// =============================================================================

export interface GradientControlOptions {
  container: HTMLElement;
  transactionManager: TransactionManager;
  /** Optional: Design tokens service for TokenPill/TokenPicker integration (Phase 5.3) */
  tokensService?: DesignTokensService;
  /**
   * CSS property to write the gradient value to.
   * Defaults to 'background-image'.
   * Use 'border-image-source' for border gradient support.
   */
  property?: string;
  /**
   * Whether to show the 'None' option in the gradient type selector.
   * Defaults to true.
   * Set to false for text gradient mode where 'none' would make text invisible.
   */
  allowNone?: boolean;
}

export function createGradientControl(options: GradientControlOptions): DesignControl {
  const {
    container,
    transactionManager,
    tokensService,
    property: cssProperty = 'background-image',
    allowNone = true,
  } = options;
  const disposer = new Disposer();

  let currentTarget: Element | null = null;
  // Default type is 'linear' when allowNone is false, otherwise 'none'
  let currentType: GradientType = allowNone ? 'none' : 'linear';

  // Current stops array - supports N stops with stable identity
  let currentStops: StopModel[] = createDefaultStopModels();
  let selectedStopId: StopId | null = currentStops[0]?.id ?? null;

  // Active thumb drag session (null when not dragging)
  let thumbDrag: ThumbDragSession | null = null;

  // Active thumb keyboard session (null when not stepping via arrow keys)
  let thumbKeyboard: ThumbKeyboardSession | null = null;

  let backgroundHandle: StyleTransactionHandle | null = null;

  // Root container
  const root = document.createElement('div');
  root.className = 'we-field-group';

  // -------------------------------------------------------------------------
  // DOM Construction Helpers
  // -------------------------------------------------------------------------

  function createInputRow(
    labelText: string,
    ariaLabel: string,
  ): { row: HTMLDivElement; input: HTMLInputElement } {
    const row = document.createElement('div');
    row.className = 'we-field';

    const label = document.createElement('span');
    label.className = 'we-field-label';
    label.textContent = labelText;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'we-input';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.inputMode = 'decimal';
    input.setAttribute('aria-label', ariaLabel);

    row.append(label, input);
    return { row, input };
  }

  function createSelectRow(
    labelText: string,
    ariaLabel: string,
    values: readonly { value: string; label: string }[],
  ): { row: HTMLDivElement; select: HTMLSelectElement } {
    const row = document.createElement('div');
    row.className = 'we-field';

    const label = document.createElement('span');
    label.className = 'we-field-label';
    label.textContent = labelText;

    const select = document.createElement('select');
    select.className = 'we-select';
    select.setAttribute('aria-label', ariaLabel);

    for (const v of values) {
      const opt = document.createElement('option');
      opt.value = v.value;
      opt.textContent = v.label;
      select.append(opt);
    }

    row.append(label, select);
    return { row, select };
  }

  // -------------------------------------------------------------------------
  // Create UI Elements
  // -------------------------------------------------------------------------

  // Build gradient type options based on allowNone parameter
  const gradientTypeOptions = allowNone
    ? GRADIENT_TYPES
    : GRADIENT_TYPES.filter((t) => t.value !== 'none');

  const { row: typeRow, select: typeSelect } = createSelectRow(
    'Type',
    'Gradient Type',
    gradientTypeOptions,
  );

  // Gradient preview bar
  const gradientBarRow = document.createElement('div');
  gradientBarRow.className = 'we-gradient-bar-row';

  const gradientBar = document.createElement('div');
  gradientBar.className = 'we-gradient-bar';
  gradientBar.setAttribute('aria-label', 'Gradient preview');

  // Thumb container layer (Phase 4C) - positioned over gradient
  const gradientThumbs = document.createElement('div');
  gradientThumbs.className = 'we-gradient-bar-thumbs';
  gradientBar.append(gradientThumbs);

  gradientBarRow.append(gradientBar);

  const { row: angleRow, input: angleInput } = createInputRow('Angle', 'Gradient Angle (deg)');
  angleInput.placeholder = String(DEFAULT_LINEAR_ANGLE);

  const { row: shapeRow, select: shapeSelect } = createSelectRow(
    'Shape',
    'Radial Gradient Shape',
    RADIAL_SHAPES,
  );

  const { row: posXRow, input: posXInput } = createInputRow('Position X', 'Radial Position X (%)');
  const { row: posYRow, input: posYInput } = createInputRow('Position Y', 'Radial Position Y (%)');

  // Stops list header + list (Phase 4D) - read-only + selection sync
  const stopsHeaderRow = document.createElement('div');
  stopsHeaderRow.className = 'we-gradient-stops-header';

  const stopsHeaderLabel = document.createElement('span');
  stopsHeaderLabel.className = 'we-gradient-stops-title';
  stopsHeaderLabel.textContent = 'Stops';

  const stopsAddBtn = document.createElement('button');
  stopsAddBtn.type = 'button';
  stopsAddBtn.className = 'we-icon-btn we-gradient-stops-add';
  stopsAddBtn.setAttribute('aria-label', 'Add stop');
  stopsAddBtn.disabled = false;
  stopsAddBtn.textContent = '+';

  stopsHeaderRow.append(stopsHeaderLabel, stopsAddBtn);

  const stopsList = document.createElement('div');
  stopsList.className = 'we-gradient-stops-list';
  stopsList.setAttribute('role', 'list');

  root.append(
    typeRow,
    gradientBarRow,
    angleRow,
    shapeRow,
    posXRow,
    posYRow,
    stopsHeaderRow,
    stopsList,
  );
  container.append(root);
  disposer.add(() => root.remove());

  // Wire keyboard stepping for numeric inputs
  wireNumberStepping(disposer, angleInput, {
    mode: 'number',
    min: 0,
    max: 360,
    step: 1,
    shiftStep: 15,
    altStep: 0.1,
  });
  wireNumberStepping(disposer, posXInput, {
    mode: 'number',
    min: 0,
    max: 100,
    step: 1,
    shiftStep: 10,
    altStep: 0.1,
  });
  wireNumberStepping(disposer, posYInput, {
    mode: 'number',
    min: 0,
    max: 100,
    step: 1,
    shiftStep: 10,
    altStep: 0.1,
  });

  // ---------------------------------------------------------------------------
  // Single Position Input bound to selectedStopId (Phase 7)
  // Host is re-parented into the selected row's position editor slot.
  // ---------------------------------------------------------------------------
  const selectedStopPosHost = document.createElement('div');

  const selectedStopPosInput = document.createElement('input');
  selectedStopPosInput.type = 'text';
  selectedStopPosInput.className = 'we-gradient-stop-pos-input';
  selectedStopPosInput.autocomplete = 'off';
  selectedStopPosInput.spellcheck = false;
  selectedStopPosInput.inputMode = 'decimal';
  selectedStopPosInput.placeholder = '0';
  selectedStopPosInput.setAttribute('aria-label', 'Selected Stop Position (%)');
  selectedStopPosHost.append(selectedStopPosInput);

  // Enable keyboard stepping (↑/↓ to increment/decrement)
  wireNumberStepping(disposer, selectedStopPosInput, {
    mode: 'number',
    min: 0,
    max: 100,
    step: 1,
    shiftStep: 10,
  });

  /**
   * Commit the position edit: sort stops and finalize the transaction.
   * Called on blur or Enter key.
   */
  function commitSelectedStopPosition(): void {
    // Commit-time sort ensures CSS output is monotonically ordered
    sortCurrentStopsByPosition();

    // Only commit if we have an active transaction
    if (backgroundHandle) {
      previewGradient();
      commitTransaction();
    }
    syncAllFields();
  }

  /**
   * Cancel the position edit and rollback to the original value.
   * Called on Escape key.
   */
  function cancelSelectedStopPosition(): void {
    rollbackTransaction();
    syncAllFields(true);
  }

  // Handle input changes - update model and preview in real-time
  disposer.listen(selectedStopPosInput, 'input', () => {
    const id = selectedStopId;
    if (!id) return;

    const parsed = parseNumber(selectedStopPosInput.value);
    if (parsed === null) return;

    // Update model and preview in real-time
    setStopPositionById(id, parsed);
    previewGradient();
  });

  // Commit on blur
  disposer.listen(selectedStopPosInput, 'blur', commitSelectedStopPosition);

  // Handle Enter/Escape keys
  disposer.listen(selectedStopPosInput, 'keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitSelectedStopPosition();
      selectedStopPosInput.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelSelectedStopPosition();
    }
  });

  // Single ColorField bound to selectedStopId (Phase 4E)
  // Host is re-parented into the selected row's editor slot.
  const selectedStopColorHost = document.createElement('div');

  const selectedStopColorField: ColorField = createColorField({
    container: selectedStopColorHost,
    ariaLabel: 'Selected Stop Color',
    tokensService,
    getTokenTarget: () => currentTarget,
    onInput: (value) => {
      const id = selectedStopId;
      if (!id) return;

      const index = currentStops.findIndex((s) => s.id === id);
      if (index < 0) return;

      // Update model
      currentStops[index]!.color = value;

      // Update placeholder when switching away from var()
      selectedStopColorField.setPlaceholder(
        needsColorPlaceholder(value) ? (currentStops[index]!.placeholderColor ?? '') : '',
      );

      previewGradient();
    },
    onCommit: () => {
      commitTransaction();
      syncAllFields();
    },
    onCancel: () => {
      rollbackTransaction();
      syncAllFields(true);
    },
  });
  disposer.add(() => selectedStopColorField.dispose());

  // -------------------------------------------------------------------------
  // Transaction Management
  // -------------------------------------------------------------------------

  function beginTransaction(): StyleTransactionHandle | null {
    if (disposer.isDisposed) return null;

    const target = currentTarget;
    if (!target || !target.isConnected) return null;

    if (backgroundHandle) return backgroundHandle;

    backgroundHandle = transactionManager.beginStyle(target, cssProperty);
    return backgroundHandle;
  }

  function commitTransaction(): void {
    const handle = backgroundHandle;
    backgroundHandle = null;
    if (handle) handle.commit({ merge: true });
  }

  function rollbackTransaction(): void {
    const handle = backgroundHandle;
    backgroundHandle = null;
    if (handle) handle.rollback();
  }

  // -------------------------------------------------------------------------
  // Thumb Drag Helpers (Phase 5)
  // -------------------------------------------------------------------------

  /**
   * Update a stop's position by its ID.
   * Used during drag to update the model in real-time.
   */
  function setStopPositionById(stopId: StopId, position: number): void {
    const index = currentStops.findIndex((s) => s.id === stopId);
    if (index < 0) return;

    const clamped = clampPercent(position);
    currentStops[index]!.position = clamped;
  }

  /**
   * Restore all stop positions from a snapshot map.
   * Used when canceling a drag operation (Escape key).
   */
  function restoreStopPositions(snapshot: Map<StopId, number>): void {
    for (const stop of currentStops) {
      const savedPos = snapshot.get(stop.id);
      if (savedPos !== undefined) {
        stop.position = savedPos;
      }
    }
  }

  /**
   * End the current thumb drag session and clean up.
   * Commits or rolls back the transaction based on the outcome.
   *
   * @param commit - If true, commit changes; if false, rollback to initial state
   */
  function endThumbDrag(commit: boolean): void {
    const session = thumbDrag;
    if (!session) return;

    thumbDrag = null;

    // Remove dragging visual state
    gradientBar.classList.remove('we-gradient-bar--dragging');
    session.thumbElement.classList.remove('we-gradient-thumb--dragging');

    // Best-effort: release capture (e.g., Escape cancel while pointer is still down)
    try {
      session.thumbElement.releasePointerCapture(session.pointerId);
    } catch {
      // Pointer capture may already be released or never set
    }

    if (commit) {
      // Commit-time sort ensures CSS output is monotonically ordered
      sortCurrentStopsByPosition();

      // Update preview with sorted positions before committing
      previewGradient();
      commitTransaction();
      syncAllFields();
    } else {
      // Restore positions before rolling back
      restoreStopPositions(session.initialPositions);
      rollbackTransaction();
      syncAllFields(true);
    }
  }

  /**
   * Calculate the position percentage from a pointer event relative to the gradient bar.
   * Returns a value clamped to 0-100.
   */
  function calculatePositionFromPointer(clientX: number): number {
    const rect = gradientBar.getBoundingClientRect();
    if (rect.width <= 0) return 0;

    const relativeX = clientX - rect.left;
    const rawPercent = (relativeX / rect.width) * 100;
    return clampPercent(rawPercent);
  }

  // -------------------------------------------------------------------------
  // Thumb Keyboard Stepping (Phase 9)
  // -------------------------------------------------------------------------

  /**
   * Start a keyboard stepping session for a thumb.
   * Similar to drag session but triggered by arrow keys.
   */
  function startThumbKeyboardSession(stopId: StopId, thumbElement: HTMLElement): void {
    if (thumbDrag) return;
    if (currentType === 'none') return;
    if (typeSelect.disabled) return;

    // If session already exists for this stop, don't restart
    if (thumbKeyboard?.stopId === stopId) return;

    // If switching stops, commit previous session first
    if (thumbKeyboard) {
      endThumbKeyboard(true);
    }

    // Snapshot all positions for potential rollback
    const initialPositions = new Map<StopId, number>();
    for (const stop of currentStops) {
      initialPositions.set(stop.id, stop.position);
    }

    thumbKeyboard = { stopId, initialPositions, thumbElement };
    beginTransaction();
  }

  /**
   * End the keyboard stepping session.
   * @param commit - If true, commit changes; if false, rollback to initial state
   */
  function endThumbKeyboard(commit: boolean): void {
    const session = thumbKeyboard;
    if (!session) return;
    thumbKeyboard = null;

    if (commit) {
      // Commit-time sort keeps CSS output monotonic
      sortCurrentStopsByPosition();
      previewGradient();
      commitTransaction();
      syncAllFields();
    } else {
      restoreStopPositions(session.initialPositions);
      rollbackTransaction();
      syncAllFields(true);
    }
  }

  /**
   * Handle focus on a thumb - select the corresponding stop.
   */
  function handleThumbFocus(event: FocusEvent): void {
    if (thumbDrag) return;
    if (currentType === 'none') return;
    if (typeSelect.disabled) return;

    const thumb = event.currentTarget as HTMLElement;
    const stopId = thumb.dataset.stopId;
    if (!stopId) return;

    if (selectedStopId !== stopId) {
      selectedStopId = stopId;
      // Preserve thumbs to avoid focus loss during selection sync
      updateGradientBar({ preserveThumbs: true });
    }
  }

  /**
   * Handle blur on a thumb - commit any active keyboard session.
   */
  function handleThumbBlur(event: FocusEvent): void {
    const session = thumbKeyboard;
    if (!session) return;

    // Only commit if blur is from the session's thumb
    const thumb = event.currentTarget as HTMLElement;
    if (thumb !== session.thumbElement) return;

    // Commit on blur (similar to input field behavior)
    endThumbKeyboard(true);
  }

  /**
   * Handle keydown on a thumb - arrow keys for stepping, Escape for cancel.
   */
  function handleThumbKeyDown(event: KeyboardEvent): void {
    // Preserve navigation shortcuts (Cmd/Ctrl + Arrow for cursor movement)
    if (event.metaKey || event.ctrlKey) return;
    if (thumbDrag) return;
    if (currentType === 'none') return;
    if (typeSelect.disabled) return;

    const thumb = event.currentTarget as HTMLElement;
    const stopId = thumb.dataset.stopId;
    if (!stopId) return;

    // Escape cancels the keyboard session
    if (event.key === 'Escape') {
      const session = thumbKeyboard;
      if (!session || session.stopId !== stopId) return;
      event.preventDefault();
      event.stopPropagation();
      endThumbKeyboard(false);
      return;
    }

    // Handle arrow keys for position adjustment
    const isArrow =
      event.key === 'ArrowLeft' ||
      event.key === 'ArrowRight' ||
      event.key === 'ArrowUp' ||
      event.key === 'ArrowDown';
    if (!isArrow) return;

    event.preventDefault();
    event.stopPropagation();

    // ArrowLeft/ArrowDown: decrease, ArrowRight/ArrowUp: increase
    // Shift modifier: step by 10 instead of 1
    const sign = event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 1;
    const step = event.shiftKey ? 10 : 1;
    const delta = sign * step;

    // Ensure stop is selected and session is active
    selectedStopId = stopId;
    startThumbKeyboardSession(stopId, thumb);

    const idx = currentStops.findIndex((s) => s.id === stopId);
    if (idx < 0) return;

    setStopPositionById(stopId, currentStops[idx]!.position + delta);
    previewGradient();
  }

  /**
   * Sync slider ARIA attributes on a thumb element.
   * Provides accessible name and value for screen readers.
   */
  function syncThumbSliderAria(thumb: HTMLElement, position: number): void {
    const clamped = clampPercent(position);
    const rounded = Math.round(clamped * 100) / 100;
    const value = Object.is(rounded, -0) ? 0 : rounded;

    thumb.setAttribute('role', 'slider');
    thumb.setAttribute('aria-label', 'Gradient stop position');
    thumb.setAttribute('aria-valuemin', '0');
    thumb.setAttribute('aria-valuemax', '100');
    thumb.setAttribute('aria-valuenow', String(value));
    thumb.setAttribute('aria-valuetext', `${value}%`);
    thumb.setAttribute('aria-orientation', 'horizontal');
  }

  // -------------------------------------------------------------------------
  // Stop Add/Delete (Phase 6)
  // -------------------------------------------------------------------------

  // Hidden probe element used to resolve CSS colors for interpolation
  const stopColorProbe = document.createElement('div');
  stopColorProbe.style.cssText =
    'position:fixed;left:-9999px;top:0;width:1px;height:1px;pointer-events:none;opacity:0';
  root.append(stopColorProbe);
  disposer.add(() => stopColorProbe.remove());

  /**
   * Resolve any CSS color string to RGBA using browser color parsing.
   * Handles hex, rgb(), rgba(), named colors, currentColor, etc.
   */
  function resolveCssColorToRgba(raw: string): RgbaColor | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;

    const lower = trimmed.toLowerCase();
    if (lower === 'transparent') {
      return { r: 0, g: 0, b: 0, a: 0 };
    }

    // Try direct parsing first (faster for common formats)
    const fromHex = parseHexColorToRgba(trimmed);
    if (fromHex) return fromHex;

    const fromRgb = parseRgbColorToRgba(trimmed);
    if (fromRgb) return fromRgb;

    // Fall back to browser color parsing via computed style
    try {
      stopColorProbe.style.color = '';
      stopColorProbe.style.color = trimmed;
      if (!stopColorProbe.style.color) return null;
      const computed = getComputedStyle(stopColorProbe).color;
      return parseRgbColorToRgba(computed);
    } catch {
      return null;
    }
  }

  /**
   * Keep stop order monotonic by position for correct CSS output.
   * CSS gradients do not reorder stops; out-of-order positions get clamped.
   * Tie-breaks by original insertion order (array index) for stability.
   */
  function sortCurrentStopsByPosition(): void {
    if (currentStops.length <= 1) return;
    const indexed = currentStops.map((stop, index) => ({ stop, index }));
    indexed.sort((a, b) => a.stop.position - b.stop.position || a.index - b.index);
    currentStops = indexed.map((entry) => entry.stop);
  }

  /**
   * Interpolate a new stop's color based on its position.
   * Finds the left and right bounding stops and linearly interpolates.
   */
  function interpolateNewStopColor(position: number): string {
    const clamped = clampPercent(position);
    const models = currentStops.length >= 2 ? currentStops : createDefaultStopModels();
    if (models.length === 0) return DEFAULT_STOP_1.color;

    // Sort by position to find bounding stops
    const sorted = models.slice().sort((a, b) => a.position - b.position);
    let left = sorted[0]!;
    let right = sorted[sorted.length - 1]!;

    for (const stop of sorted) {
      if (stop.position <= clamped) left = stop;
      if (stop.position >= clamped) {
        right = stop;
        break;
      }
    }

    // Resolve preview colors (handles var() references)
    const leftRgba = resolveCssColorToRgba(getStopPreviewColor(left));
    const rightRgba = resolveCssColorToRgba(getStopPreviewColor(right));

    if (!leftRgba && !rightRgba) {
      return left.color.trim() || DEFAULT_STOP_1.color;
    }
    if (!leftRgba) return rgbaToCss(rightRgba!);
    if (!rightRgba) return rgbaToCss(leftRgba);

    const span = right.position - left.position;
    if (!Number.isFinite(span) || span <= 0) {
      return rgbaToCss(leftRgba);
    }

    const t = clampNumber((clamped - left.position) / span, 0, 1);
    return rgbaToCss(interpolateRgba(leftRgba, rightRgba, t));
  }

  /**
   * Get a suggested position for adding a new stop.
   * Returns the midpoint between the selected stop and its next neighbor.
   */
  function getSuggestedAddStopPosition(): number {
    const selectedId = selectedStopId;
    if (!selectedId) return DEFAULT_POSITION;

    const models = currentStops.length >= 2 ? currentStops : createDefaultStopModels();
    const sorted = models.slice().sort((a, b) => a.position - b.position);
    const index = sorted.findIndex((s) => s.id === selectedId);
    if (index < 0) return DEFAULT_POSITION;

    const current = sorted[index]!;
    const next = sorted[index + 1];
    const prev = sorted[index - 1];

    // Prefer midpoint toward the right (next), then toward the left (prev)
    if (next) return clampPercent((current.position + next.position) / 2);
    if (prev) return clampPercent((prev.position + current.position) / 2);
    return DEFAULT_POSITION;
  }

  /**
   * Find the stop ID closest to a given position.
   * Used to select a neighbor after deletion.
   * Tie-breaks toward the right (higher position).
   */
  function pickClosestStopId(position: number): StopId | null {
    if (currentStops.length === 0) return null;

    let best = currentStops[0]!;
    let bestDistance = Math.abs(best.position - position);

    for (let i = 1; i < currentStops.length; i++) {
      const candidate = currentStops[i]!;
      const distance = Math.abs(candidate.position - position);

      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
        continue;
      }

      // Tie-break: prefer stop on the right side
      if (distance === bestDistance) {
        const candidateOnRight = candidate.position >= position;
        const bestOnRight = best.position >= position;
        if (candidateOnRight && !bestOnRight) {
          best = candidate;
        }
      }
    }

    return best.id;
  }

  /**
   * Add a new stop at the specified position with interpolated color.
   * Auto-selects the new stop after adding.
   */
  function addStopAtPosition(position: number, opts: { focusColor?: boolean } = {}): void {
    if (currentType === 'none') return;
    if (typeSelect.disabled) return;

    const clamped = clampPercent(position);
    const newStop: StopModel = {
      id: createStopId(),
      position: clamped,
      color: interpolateNewStopColor(clamped),
    };

    currentStops.push(newStop);
    selectedStopId = newStop.id;
    sortCurrentStopsByPosition();

    previewGradient();
    commitTransaction();

    if (opts.focusColor) {
      queueMicrotask(() => {
        const input = selectedStopColorHost.querySelector<HTMLInputElement>('input.we-color-text');
        input?.focus();
      });
    }
  }

  /**
   * Remove a stop by its ID.
   * Enforces minimum 2 stops constraint.
   * Auto-selects the closest neighbor after deletion.
   */
  function removeStopById(stopId: StopId): void {
    if (currentType === 'none') return;
    if (typeSelect.disabled) return;

    // Enforce minimum 2 stops constraint
    if (currentStops.length <= 2) return;

    const index = currentStops.findIndex((s) => s.id === stopId);
    if (index < 0) return;

    const removed = currentStops[index]!;
    currentStops.splice(index, 1);

    // Auto-select closest neighbor if we deleted the selected stop
    if (selectedStopId === stopId) {
      selectedStopId = pickClosestStopId(removed.position);
      if (!selectedStopId) {
        selectedStopId = currentStops[0]?.id ?? null;
      }
    }

    sortCurrentStopsByPosition();
    previewGradient();
    commitTransaction();
  }

  /**
   * Check if an event target is a text input-like element.
   * Used to avoid capturing Delete/Backspace when user is editing text.
   */
  function isTextInputLike(target: EventTarget | null): boolean {
    return (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    );
  }

  /**
   * Update the gradient preview bar background and thumb elements.
   * Uses buildPreviewBarCss() to render a horizontal (90deg) gradient.
   * Reads from current UI state (inputs) to ensure real-time sync during editing.
   *
   * @param options.refreshStopsList - Set to false to skip stops list refresh (avoid re-mounting color field during editing)
   * @param options.preserveThumbs - Set to true to only update thumb positions without recreating elements (used during drag)
   */
  function updateGradientBar(
    options: { refreshStopsList?: boolean; preserveThumbs?: boolean } = {},
  ): void {
    const refreshStopsList = options.refreshStopsList ?? true;
    const preserveThumbs = options.preserveThumbs ?? false;

    if (currentType === 'none') {
      gradientBar.style.backgroundImage = 'none';
      gradientThumbs.textContent = '';
      if (refreshStopsList) updateStopsList([], [], []);
      return;
    }

    // Use collectCurrentStops() to get stops based on current UI input values.
    // This ensures the preview bar updates in real-time while editing stop1/stop2.
    const stops = collectCurrentStops();
    if (stops.length === 0) {
      gradientBar.style.backgroundImage = 'none';
      gradientThumbs.textContent = '';
      if (refreshStopsList) updateStopsList([], [], []);
      return;
    }

    // Resolve placeholder colors for var() values from currentStops model
    const previewStops: GradientStop[] = stops.map((stop, i) => {
      const model = currentStops[i];
      const previewColor = needsColorPlaceholder(stop.color)
        ? model?.placeholderColor?.trim() || 'transparent'
        : stop.color;
      return { color: previewColor, position: stop.position };
    });

    gradientBar.style.backgroundImage = buildPreviewBarCss(previewStops);

    // -------------------------------------------------------------------------
    // Thumbs (Phase 4C + Phase 5 drag support)
    // -------------------------------------------------------------------------

    const models = currentStops.length >= 2 ? currentStops : createDefaultStopModels();

    // Ensure selectedStopId points to a valid model
    if (!selectedStopId || !models.some((s) => s.id === selectedStopId)) {
      selectedStopId = models[0]?.id ?? null;
    }

    // When preserveThumbs is true (during drag), update existing thumbs in place
    // to maintain pointer capture. Otherwise, rebuild all thumbs.
    if (preserveThumbs) {
      // Update existing thumb positions and colors without recreating elements
      const existingThumbs = gradientThumbs.querySelectorAll<HTMLElement>('.we-gradient-thumb');
      for (const thumb of existingThumbs) {
        const stopId = thumb.dataset.stopId;
        if (!stopId) continue;

        const modelIndex = models.findIndex((m) => m.id === stopId);
        if (modelIndex < 0) continue;

        const stop = stops[modelIndex];
        const preview = previewStops[modelIndex];
        if (!stop || !preview) continue;

        // Update position and color
        thumb.style.left = `${clampPercent(stop.position)}%`;
        thumb.style.backgroundColor = preview.color;
        syncThumbSliderAria(thumb, stop.position);

        // Update active state
        const isActive = stopId === selectedStopId;
        thumb.classList.toggle('we-gradient-thumb--active', isActive);
      }
    } else {
      // Full rebuild: clear and recreate all thumbs
      gradientThumbs.textContent = '';

      for (let i = 0; i < stops.length; i++) {
        const model = models[i];
        const stop = stops[i];
        const preview = previewStops[i];
        if (!model || !stop || !preview) continue;

        const thumb = document.createElement('button');
        thumb.type = 'button';
        thumb.className =
          model.id === selectedStopId
            ? 'we-gradient-thumb we-gradient-thumb--active'
            : 'we-gradient-thumb';
        thumb.dataset.stopId = model.id;
        thumb.style.left = `${clampPercent(stop.position)}%`;
        thumb.style.backgroundColor = preview.color;
        syncThumbSliderAria(thumb, stop.position);

        // Pointer event handlers for drag (Phase 5)
        thumb.addEventListener('pointerdown', handleThumbPointerDown);

        // Keyboard and focus handlers (Phase 9)
        thumb.addEventListener('keydown', handleThumbKeyDown);
        thumb.addEventListener('focus', handleThumbFocus);
        thumb.addEventListener('blur', handleThumbBlur);

        gradientThumbs.append(thumb);
      }
    }

    // Stops list (Phase 4D) - skip during drag to avoid UI thrashing
    if (refreshStopsList && !preserveThumbs) {
      updateStopsList(models, stops, previewStops);
    }
  }

  // -------------------------------------------------------------------------
  // Thumb Drag Event Handlers (Phase 5)
  // -------------------------------------------------------------------------

  /**
   * Handle pointerdown on a thumb to start drag.
   * Sets up pointer capture and initializes the drag session.
   */
  function handleThumbPointerDown(event: PointerEvent): void {
    // Prevent re-entry if drag is already in progress
    if (thumbDrag) return;

    // Defensive: don't allow drag when disabled or none type
    if (currentType === 'none') return;
    if (typeSelect.disabled) return;

    // Only respond to primary button (left click) and primary pointer
    if (event.button !== 0) return;
    if (!event.isPrimary) return;

    const thumb = event.currentTarget as HTMLElement;
    const stopId = thumb.dataset.stopId;
    if (!stopId) return;

    // If a keyboard stepping session is active, transition to drag
    // (share the same transaction handle)
    if (thumbKeyboard) {
      thumbKeyboard = null;
    }

    // Prevent default to avoid text selection, button activation, etc.
    event.preventDefault();
    event.stopPropagation();

    // Select this stop
    selectedStopId = stopId;

    // Snapshot all positions for potential rollback
    const initialPositions = new Map<StopId, number>();
    for (const stop of currentStops) {
      initialPositions.set(stop.id, stop.position);
    }

    // Start the drag session
    thumbDrag = {
      stopId,
      pointerId: event.pointerId,
      initialPositions,
      thumbElement: thumb,
    };

    // Add visual feedback - dragging thumb raised above others
    gradientBar.classList.add('we-gradient-bar--dragging');
    thumb.classList.add('we-gradient-thumb--dragging');

    // Capture pointer for reliable tracking outside element bounds
    try {
      thumb.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture may fail on some elements/browsers
    }

    // Begin transaction for live preview
    beginTransaction();

    // Update UI to show selected state
    updateGradientBar({ preserveThumbs: true, refreshStopsList: false });
  }

  /**
   * Handle pointermove during drag to update stop position.
   * Called on window (capture phase) to ensure we capture all movement.
   */
  function handleThumbPointerMove(event: PointerEvent): void {
    const session = thumbDrag;
    if (!session) return;
    if (event.pointerId !== session.pointerId) return;

    // Calculate new position from pointer location
    const newPosition = calculatePositionFromPointer(event.clientX);

    // Update model
    setStopPositionById(session.stopId, newPosition);

    // Live preview to element (updateGradientBar is called inside previewGradient)
    previewGradient();
  }

  /**
   * Handle pointerup to end drag and commit changes.
   */
  function handleThumbPointerUp(event: PointerEvent): void {
    const session = thumbDrag;
    if (!session) return;
    if (event.pointerId !== session.pointerId) return;

    // Commit the drag
    endThumbDrag(true);
  }

  /**
   * Handle pointercancel (e.g., touch interrupted) to cancel drag.
   */
  function handleThumbPointerCancel(event: PointerEvent): void {
    const session = thumbDrag;
    if (!session) return;
    if (event.pointerId !== session.pointerId) return;

    // Rollback the drag
    endThumbDrag(false);
  }

  /**
   * Handle keydown during drag to support Escape cancellation.
   */
  function handleDragKeyDown(event: KeyboardEvent): void {
    if (!thumbDrag) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();
      endThumbDrag(false);
    }
  }

  // Wire up window-level capture listeners for drag handling.
  // UI events are stopped at the ShadowHost root, so these must be capture-phase.
  const DRAG_LISTENER_OPTIONS: AddEventListenerOptions = { capture: true, passive: false };
  disposer.listen(window, 'pointermove', handleThumbPointerMove, DRAG_LISTENER_OPTIONS);
  disposer.listen(window, 'pointerup', handleThumbPointerUp, DRAG_LISTENER_OPTIONS);
  disposer.listen(window, 'pointercancel', handleThumbPointerCancel, DRAG_LISTENER_OPTIONS);
  disposer.listen(window, 'keydown', handleDragKeyDown, DRAG_LISTENER_OPTIONS);

  /**
   * Render stops list and sync selection with selectedStopId.
   * Clicking a row selects the stop and refreshes thumbs via updateGradientBar().
   */
  function updateStopsList(
    models: StopModel[],
    stops: GradientStop[],
    previewStops: GradientStop[],
  ): void {
    stopsList.textContent = '';
    if (currentType === 'none') return;
    if (models.length === 0 || stops.length === 0) return;

    /**
     * Format position value for display (e.g., "50%")
     */
    const formatPercentValue = (value: number): number => {
      const clamped = clampPercent(value);
      const rounded = Math.round(clamped * 100) / 100;
      return Object.is(rounded, -0) ? 0 : rounded;
    };

    const formatPercentLabel = (value: number): string => `${formatPercentValue(value)}%`;

    // Build rows with original index for stable ordering
    const rows = stops
      .map((stop, index) => ({
        index,
        stop,
        model: models[index],
        preview: previewStops[index],
      }))
      .filter((r) => Boolean(r.model && r.preview))
      .sort((a, b) => a.stop.position - b.stop.position || a.index - b.index);

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const r = rows[rowIndex]!;
      const model = r.model!;
      const stop = r.stop;
      const preview = r.preview!;
      const isActive = model.id === selectedStopId;

      const row = document.createElement('div');
      row.className = isActive
        ? 'we-gradient-stop-row we-gradient-stop-row--active'
        : 'we-gradient-stop-row';
      row.dataset.stopId = model.id;
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      row.setAttribute('aria-label', `Select stop at ${formatPercentLabel(stop.position)}`);

      // Position column (Phase 7: static + editor dual-mode)
      const pos = document.createElement('div');
      pos.className = 'we-gradient-stop-pos';

      // Static display (shown when not selected)
      const posStatic = document.createElement('span');
      posStatic.className = 'we-gradient-stop-pos-static';
      posStatic.textContent = formatPercentLabel(stop.position);

      // Position editor slot (shown when selected)
      const posEditor = document.createElement('div');
      posEditor.className = 'we-gradient-stop-pos-editor';

      if (isActive) {
        posEditor.append(selectedStopPosHost);
        // Avoid resetting while user is typing
        if (!isPositionInputFocused()) {
          selectedStopPosInput.value = String(formatPercentValue(stop.position));
        }
      }

      pos.append(posStatic, posEditor);

      // Color column
      const color = document.createElement('div');
      color.className = 'we-gradient-stop-color';

      // Static color display (shown when not selected)
      const colorStatic = document.createElement('button');
      colorStatic.type = 'button';
      colorStatic.className = 'we-gradient-stop-color-static';
      colorStatic.tabIndex = -1;
      colorStatic.setAttribute('aria-label', 'Select stop');

      const swatch = document.createElement('span');
      swatch.className = 'we-gradient-stop-swatch';
      swatch.style.backgroundColor = preview.color;

      const text = document.createElement('span');
      text.className = 'we-gradient-stop-color-text';
      text.textContent = stop.color.trim() || DEFAULT_STOP_1.color;

      colorStatic.append(swatch, text);

      // Color editor slot (shown when selected)
      const colorEditor = document.createElement('div');
      colorEditor.className = 'we-gradient-stop-color-editor';

      if (isActive) {
        colorEditor.append(selectedStopColorHost);
        // Avoid resetting while user is typing
        if (!selectedStopColorField.isFocused()) {
          selectedStopColorField.setValue(stop.color);
          selectedStopColorField.setPlaceholder(
            needsColorPlaceholder(stop.color) ? (model.placeholderColor ?? '') : '',
          );
        }
      }

      color.append(colorStatic, colorEditor);

      // Remove button (Phase 6)
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'we-icon-btn we-gradient-stop-remove';
      removeBtn.setAttribute('aria-label', 'Remove stop');
      // Disable if we can't remove (only 2 stops remaining or control is disabled)
      const canRemove = !typeSelect.disabled && models.length > 2;
      removeBtn.disabled = !canRemove;
      removeBtn.textContent = '–';

      removeBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        removeStopById(model.id);
      });

      // Focus helpers for position and color inputs
      const focusSelectedPosInput = () => {
        queueMicrotask(() => {
          selectedStopPosInput.focus();
          selectedStopPosInput.select();
        });
      };

      const focusSelectedColorField = () => {
        queueMicrotask(() => {
          const input =
            selectedStopColorHost.querySelector<HTMLInputElement>('input.we-color-text');
          input?.focus();
        });
      };

      // Click to select (with optional focus target)
      const selectThisRow = (opts?: { focusColor?: boolean; focusPosition?: boolean }) => {
        selectedStopId = model.id;
        updateGradientBar();
        if (opts?.focusColor) focusSelectedColorField();
        if (opts?.focusPosition) focusSelectedPosInput();
      };

      row.addEventListener('click', (event) => {
        if (model.id === selectedStopId) return;
        event.preventDefault();
        selectThisRow();
      });

      row.addEventListener('keydown', (event: KeyboardEvent) => {
        // Don't hijack keys while user is editing text inputs inside the row
        if (isTextInputLike(event.target)) return;

        // Arrow key navigation between rows (Phase 9)
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault();
          event.stopPropagation();

          const nextIndex =
            event.key === 'ArrowUp'
              ? Math.max(0, rowIndex - 1)
              : Math.min(rows.length - 1, rowIndex + 1);
          if (nextIndex === rowIndex) return;

          const nextModel = rows[nextIndex]?.model;
          if (!nextModel) return;

          selectedStopId = nextModel.id;
          updateGradientBar();

          // Focus the next row after DOM update
          queueMicrotask(() => {
            const nextRow = stopsList.querySelector<HTMLElement>(
              `.we-gradient-stop-row[data-stop-id="${nextModel.id}"]`,
            );
            nextRow?.focus();
          });
          return;
        }

        // Enter/Space to select (only if not already selected)
        if (model.id !== selectedStopId && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          selectThisRow();
        }
      });

      // Clicking the position area selects and focuses the position editor
      posStatic.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (model.id === selectedStopId) {
          focusSelectedPosInput();
          return;
        }
        selectThisRow({ focusPosition: true });
      });

      // Clicking the color static area selects and focuses the color editor
      colorStatic.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (model.id === selectedStopId) {
          focusSelectedColorField();
          return;
        }
        selectThisRow({ focusColor: true });
      });

      row.append(pos, color, removeBtn);
      stopsList.append(row);
    }
  }

  function updateRowVisibility(): void {
    gradientBarRow.hidden = currentType === 'none';
    angleRow.hidden = currentType !== 'linear';
    shapeRow.hidden = currentType !== 'radial';
    posXRow.hidden = currentType !== 'radial';
    posYRow.hidden = currentType !== 'radial';
    stopsHeaderRow.hidden = currentType === 'none';
    stopsList.hidden = currentType === 'none';
    stopsAddBtn.disabled = typeSelect.disabled || currentType === 'none';
  }

  function setAllDisabled(disabled: boolean): void {
    typeSelect.disabled = disabled;
    angleInput.disabled = disabled;
    shapeSelect.disabled = disabled;
    posXInput.disabled = disabled;
    posYInput.disabled = disabled;
    stopsAddBtn.disabled = disabled;
    selectedStopPosInput.disabled = disabled || currentType === 'none';
    selectedStopColorField.setDisabled(disabled || currentType === 'none');
  }

  function resetDefaults(options: { skipPreview?: boolean } = {}): void {
    angleInput.value = String(DEFAULT_LINEAR_ANGLE);
    shapeSelect.value = 'ellipse';
    posXInput.value = '';
    posYInput.value = '';

    // Reset stops array with new models (fresh IDs)
    currentStops = createDefaultStopModels();
    selectedStopId = currentStops[0]?.id ?? null;

    if (!options.skipPreview) {
      updateGradientBar();
    }
  }

  /**
   * Check if the position input is currently focused.
   * Used to prevent list re-rendering while editing.
   */
  function isPositionInputFocused(): boolean {
    return isFieldFocused(selectedStopPosInput);
  }

  function isEditing(): boolean {
    return (
      backgroundHandle !== null ||
      isFieldFocused(typeSelect) ||
      isFieldFocused(angleInput) ||
      isFieldFocused(shapeSelect) ||
      isFieldFocused(posXInput) ||
      isFieldFocused(posYInput) ||
      isPositionInputFocused() ||
      selectedStopColorField.isFocused()
    );
  }

  // -------------------------------------------------------------------------
  // Formatting / Live Preview
  // -------------------------------------------------------------------------

  /**
   * Format stops array as CSS color-stop list
   */
  function formatStopList(stops: GradientStop[]): string {
    return stops
      .map((s) => {
        const color = s.color.trim() || DEFAULT_STOP_1.color;
        const pos = clampPercent(s.position);
        return `${color} ${pos}%`;
      })
      .join(', ');
  }

  /**
   * Build CSS gradient string for writing back to element (background-image).
   * Uses current UI input values for angle (linear) or shape/position (radial).
   *
   * @param stops - The gradient stops to include
   * @returns CSS gradient string (e.g., "linear-gradient(45deg, #fff 0%, #000 100%)")
   */
  function buildElementGradientCss(stops: GradientStop[]): string {
    if (currentType === 'none' || stops.length === 0) {
      return 'none';
    }

    const stopsText = formatStopList(stops);

    if (currentType === 'linear') {
      const angle = clampAngle(parseNumber(angleInput.value) ?? DEFAULT_LINEAR_ANGLE);
      return `linear-gradient(${angle}deg, ${stopsText})`;
    }

    // Radial gradient
    const shape = (shapeSelect.value as RadialShape) || 'ellipse';
    const rawX = posXInput.value.trim();
    const rawY = posYInput.value.trim();
    const hasPosition = Boolean(rawX || rawY);

    if (!hasPosition) {
      return `radial-gradient(${shape}, ${stopsText})`;
    }

    const x = clampPercent(parseNumber(rawX) ?? DEFAULT_POSITION);
    const y = clampPercent(parseNumber(rawY) ?? DEFAULT_POSITION);
    return `radial-gradient(${shape} at ${x}% ${y}%, ${stopsText})`;
  }

  /**
   * Build CSS for the preview bar UI.
   * Always outputs a horizontal 90deg linear-gradient regardless of actual gradient type.
   * This provides a consistent left-to-right preview of stop positions and colors.
   *
   * @param stops - The gradient stops to preview
   * @returns CSS linear-gradient string with 90deg angle
   */
  function buildPreviewBarCss(stops: GradientStop[]): string {
    if (stops.length === 0) {
      return 'linear-gradient(90deg, transparent, transparent)';
    }
    const stopsText = formatStopList(stops);
    return `linear-gradient(90deg, ${stopsText})`;
  }

  /**
   * Collect current stops from UI state, merging UI values for edited stops
   * with preserved values for additional stops.
   * Returns GradientStop[] for CSS generation (strips id field).
   */
  function collectCurrentStops(): GradientStop[] {
    const baseStops = currentStops.length >= 2 ? currentStops : createDefaultStopModels();
    return baseStops.map((s) => ({
      color: s.color.trim() || DEFAULT_STOP_1.color,
      position: clampPercent(s.position),
    }));
  }

  /**
   * Build the current gradient value for writing to element
   */
  function buildGradientValue(): string {
    if (currentType === 'none') return 'none';
    const stops = collectCurrentStops();
    return buildElementGradientCss(stops);
  }

  function previewGradient(): void {
    if (disposer.isDisposed) return;

    // Avoid re-rendering stops list while dragging, keyboard stepping, or editing stop editors,
    // otherwise thumbs may lose pointer capture/focus and inputs can lose focus/caret.
    const isDragging = thumbDrag !== null;
    const isKeyboardStepping = thumbKeyboard !== null;
    const isEditingStopFields = selectedStopColorField.isFocused() || isPositionInputFocused();
    updateGradientBar({
      preserveThumbs: isDragging || isKeyboardStepping,
      refreshStopsList: isDragging || isKeyboardStepping ? false : !isEditingStopFields,
    });

    const target = currentTarget;
    if (!target || !target.isConnected) return;

    const handle = beginTransaction();
    if (!handle) return;

    handle.set(buildGradientValue());
  }

  // -------------------------------------------------------------------------
  // Sync (Render from Element State)
  // -------------------------------------------------------------------------

  function syncAllFields(force = false): void {
    const target = currentTarget;

    if (!target || !target.isConnected) {
      setAllDisabled(true);
      // Use 'linear' as default when 'none' is not allowed
      const defaultType = allowNone ? 'none' : 'linear';
      currentType = defaultType;
      typeSelect.value = defaultType;
      resetDefaults();
      updateRowVisibility();
      updateGradientBar();
      return;
    }

    setAllDisabled(false);

    if (isEditing() && !force) return;

    const inlineValue = readInlineValue(target, cssProperty);
    const needsComputed = !inlineValue || /\bvar\s*\(/i.test(inlineValue);
    const computedValue = needsComputed ? readComputedValue(target, cssProperty) : '';

    const inlineParsed = !isNoneValue(inlineValue) ? parseGradient(inlineValue) : null;
    const computedParsed = !isNoneValue(computedValue) ? parseGradient(computedValue) : null;

    let parsed: ParsedGradient | null = null;
    let source: 'inline' | 'computed' | 'none' = 'none';

    if (inlineValue.trim()) {
      if (isNoneValue(inlineValue)) {
        parsed = null;
        source = 'none';
      } else if (inlineParsed) {
        parsed = inlineParsed;
        source = 'inline';
      } else {
        // Has value but couldn't parse - treat as none for our UI
        parsed = null;
        source = 'none';
      }
    } else {
      if (isNoneValue(computedValue)) {
        parsed = null;
        source = 'none';
      } else if (computedParsed) {
        parsed = computedParsed;
        source = 'computed';
      } else {
        parsed = null;
        source = 'none';
      }
    }

    resetDefaults({ skipPreview: true });

    if (!parsed) {
      // Use 'linear' as default when 'none' is not allowed
      const defaultType = allowNone ? 'none' : 'linear';
      currentType = defaultType;
      typeSelect.value = defaultType;
      updateRowVisibility();
      updateGradientBar();
      return;
    }

    // Convert parsed stops to StopModel[] with stable IDs
    const rawStops: GradientStop[] =
      parsed.stops.length >= 2
        ? parsed.stops.slice()
        : [{ ...DEFAULT_STOP_1 }, { ...DEFAULT_STOP_2 }];

    // Apply placeholder mapping for var() values using nearest-neighbor matching
    const hasVarInInline = source === 'inline' && needsColorPlaceholder(inlineValue);
    if (hasVarInInline && computedParsed) {
      const placeholderColors = buildPlaceholderMapping(rawStops, computedParsed.stops);
      for (let i = 0; i < rawStops.length; i++) {
        rawStops[i]!.placeholderColor = placeholderColors[i] ?? '';
      }
    }

    // Reconcile with existing models to preserve stable IDs
    currentStops = reconcileStopModels(currentStops, rawStops);

    // Select first stop by default if nothing selected or selection is invalid
    if (!selectedStopId || !currentStops.some((s) => s.id === selectedStopId)) {
      selectedStopId = currentStops[0]?.id ?? null;
    }

    if (parsed.type === 'linear') {
      currentType = 'linear';
      typeSelect.value = 'linear';
      angleInput.value = String(parsed.angle);
    } else {
      currentType = 'radial';
      typeSelect.value = 'radial';
      shapeSelect.value = parsed.shape;
      if (parsed.position) {
        posXInput.value = String(parsed.position.x);
        posYInput.value = String(parsed.position.y);
      } else {
        posXInput.value = '';
        posYInput.value = '';
      }
    }

    updateRowVisibility();
    updateGradientBar();
  }

  // -------------------------------------------------------------------------
  // Event Wiring
  // -------------------------------------------------------------------------

  function wireTextInput(input: HTMLInputElement): void {
    disposer.listen(input, 'input', previewGradient);

    disposer.listen(input, 'blur', () => {
      commitTransaction();
      syncAllFields();
    });

    disposer.listen(input, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitTransaction();
        syncAllFields();
        input.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        rollbackTransaction();
        syncAllFields(true);
      }
    });
  }

  function wireSelect(select: HTMLSelectElement, onPreview?: () => void): void {
    const preview = () => {
      onPreview?.();
      previewGradient();
    };

    disposer.listen(select, 'input', preview);
    disposer.listen(select, 'change', preview);

    disposer.listen(select, 'blur', () => {
      commitTransaction();
      syncAllFields();
    });

    disposer.listen(select, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitTransaction();
        syncAllFields();
        select.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        rollbackTransaction();
        syncAllFields(true);
      }
    });
  }

  wireSelect(typeSelect, () => {
    currentType = typeSelect.value as GradientType;
    updateRowVisibility();
  });

  wireSelect(shapeSelect);

  wireTextInput(angleInput);
  wireTextInput(posXInput);
  wireTextInput(posYInput);

  // -------------------------------------------------------------------------
  // Stop Add/Delete Interactions (Phase 6)
  // -------------------------------------------------------------------------

  // Add stop via header button
  disposer.listen(stopsAddBtn, 'click', (event: MouseEvent) => {
    event.preventDefault();
    if (stopsAddBtn.disabled) return;
    addStopAtPosition(getSuggestedAddStopPosition(), { focusColor: true });
  });

  // Add stop via double-click on gradient bar
  disposer.listen(gradientBar, 'dblclick', (event: MouseEvent) => {
    // Don't add if dragging or if control is disabled
    if (thumbDrag) return;
    if (currentType === 'none' || typeSelect.disabled) return;

    // Only add on "empty bar" double-click (ignore thumbs)
    const path = event.composedPath();
    if (
      path.some((el) => el instanceof HTMLElement && el.classList.contains('we-gradient-thumb'))
    ) {
      return;
    }

    event.preventDefault();
    addStopAtPosition(calculatePositionFromPointer(event.clientX), { focusColor: true });
  });

  // Delete stop via Delete/Backspace key
  disposer.listen(root, 'keydown', (event: KeyboardEvent) => {
    if (event.key !== 'Delete' && event.key !== 'Backspace') return;
    if (thumbDrag) return;
    if (currentType === 'none' || typeSelect.disabled) return;

    const id = selectedStopId;
    if (!id) return;

    // Don't capture when user is editing text
    if (isTextInputLike(event.target)) return;

    // Only treat Delete/Backspace as stop deletion when the key event originates
    // from the stops UI (bar or list), to avoid surprising deletions elsewhere
    const path = event.composedPath();
    if (!path.includes(stopsList) && !path.includes(gradientBar)) return;

    event.preventDefault();
    event.stopPropagation();
    removeStopById(id);
  });

  // -------------------------------------------------------------------------
  // DesignControl Interface
  // -------------------------------------------------------------------------

  function setTarget(element: Element | null): void {
    if (disposer.isDisposed) return;
    if (element !== currentTarget) commitTransaction();
    currentTarget = element;
    syncAllFields(true);
  }

  function refresh(): void {
    if (disposer.isDisposed) return;
    syncAllFields();
  }

  function dispose(): void {
    commitTransaction();
    currentTarget = null;
    disposer.dispose();
  }

  // Initialize
  typeSelect.value = currentType;
  resetDefaults();
  updateRowVisibility();
  syncAllFields(true);

  return { setTarget, refresh, dispose };
}
