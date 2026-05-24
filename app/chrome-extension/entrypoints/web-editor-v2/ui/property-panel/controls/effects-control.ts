/**
 * Effects Control
 *
 * Current scope:
 * - Inline `box-shadow` list editor (Drop Shadow / Inner Shadow)
 * - `filter: blur(...)` (Layer Blur)
 * - `backdrop-filter: blur(...)` (Backdrop Blur)
 *
 * Features:
 * - Add/remove multiple effects per element
 * - Toggle visibility (hide/show) per effect
 * - Adjust popover for detailed editing (type, offset, blur, spread, color)
 *
 * Notes:
 * - Rendering reads inline styles only (no computed fallback)
 * - Hidden effects are kept in memory for the current editor session
 *
 * File layout (post IMP-0148 split):
 * - `./effects-control/shadow-parser.ts` — CSS box-shadow + blur parsers
 * - `./effects-control/svg-icons.ts`     — Plus / Trash / Adjust / Eye icon factories
 * - this file                            — main `createEffectsControl` factory
 */

import { Disposer } from '../../../utils/disposables';
import type { StyleTransactionHandle, TransactionManager } from '../../../core/transaction-manager';
import type { DesignTokensService } from '../../../core/design-tokens';
import { createInputContainer, type InputContainer } from '../components/input-container';
import { createColorField, type ColorField } from './color-field';
import {
  combineLengthValue,
  formatLengthForDisplay,
  readInlineValue,
  splitTopLevel,
} from './css-helpers';
import { wireNumberStepping } from './number-stepping';
import type { DesignControl } from '../types';
import {
  formatBoxShadow,
  parseBlurRadius,
  parseBoxShadow,
  upsertBlurFunction,
} from './effects-control/shadow-parser';
import {
  createAdjustIcon,
  createEyeIcon,
  createIconButton,
  createPlusIcon,
  createTrashIcon,
} from './effects-control/svg-icons';

// =============================================================================
// Constants
// =============================================================================

const BOX_SHADOW_PROPERTY = 'box-shadow';

const EFFECT_TYPE_OPTIONS = [
  { value: 'drop-shadow', label: 'Drop Shadow', category: 'shadow' },
  { value: 'inner-shadow', label: 'Inner Shadow', category: 'shadow' },
  { value: 'layer-blur', label: 'Layer Blur', category: 'blur' },
  { value: 'backdrop-blur', label: 'Backdrop Blur', category: 'blur' },
] as const;

type EffectTypeValue = (typeof EFFECT_TYPE_OPTIONS)[number]['value'];

// =============================================================================
// Public Types
// =============================================================================

export interface EffectsControlOptions {
  container: HTMLElement;
  transactionManager: TransactionManager;
  /** Optional: Design tokens service for TokenPill/TokenPicker integration (Phase 5.3) */
  tokensService?: DesignTokensService;
  /** Optional: Container element for header actions (e.g., add button) */
  headerActionsContainer?: HTMLElement;
}

// =============================================================================
// ID Generation
// =============================================================================

let shadowItemIdCounter = 0;

function createShadowItemId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // Fallback to counter
  }
  shadowItemIdCounter += 1;
  return `shadow_${shadowItemIdCounter}_${Date.now()}`;
}

// =============================================================================
// Effect Item Types
// =============================================================================

interface EffectItemBase {
  id: string;
  enabled: boolean;
}

interface ShadowEffectItem extends EffectItemBase {
  type: 'drop-shadow' | 'inner-shadow';
  kind: 'parsed';
  inset: boolean;
  offsetX: string;
  offsetY: string;
  blurRadius: string;
  spreadRadius: string;
  color: string;
}

interface BlurEffectItem extends EffectItemBase {
  type: 'layer-blur' | 'backdrop-blur';
  kind: 'parsed';
  radius: string;
}

/** Raw effect we could not parse; preserved verbatim so we don't lose user CSS. */
interface RawEffectItem extends EffectItemBase {
  type: 'raw';
  kind: 'raw';
  property: 'box-shadow' | 'filter' | 'backdrop-filter';
  rawText: string;
}

type EffectItem = ShadowEffectItem | BlurEffectItem | RawEffectItem;

function isShadowEffect(item: EffectItem): item is ShadowEffectItem {
  return item.type === 'drop-shadow' || item.type === 'inner-shadow';
}

function isBlurEffect(item: EffectItem): item is BlurEffectItem {
  return item.type === 'layer-blur' || item.type === 'backdrop-blur';
}

// =============================================================================
// Effect Item Helpers
// =============================================================================

function createDefaultShadowEffect(): ShadowEffectItem {
  return {
    id: createShadowItemId(),
    enabled: true,
    type: 'drop-shadow',
    kind: 'parsed',
    inset: false,
    offsetX: '0px',
    offsetY: '4px',
    blurRadius: '12px',
    spreadRadius: '0px',
    color: 'rgba(0, 0, 0, 0.15)',
  };
}

function createDefaultBlurEffect(type: 'layer-blur' | 'backdrop-blur'): BlurEffectItem {
  return {
    id: createShadowItemId(),
    enabled: true,
    type,
    kind: 'parsed',
    radius: '8px',
  };
}

function getEffectItemLabel(item: EffectItem): string {
  const option = EFFECT_TYPE_OPTIONS.find((o) => o.value === item.type);
  if (option) return option.label;
  if (item.kind === 'raw') return 'Custom Effect';
  return 'Unknown Effect';
}

function effectItemKey(item: EffectItem): string {
  if (item.kind === 'raw') return `raw:${item.property}:${item.rawText.trim()}`;
  if (isShadowEffect(item)) {
    const css = formatBoxShadow({
      inset: item.inset,
      offsetX: item.offsetX,
      offsetY: item.offsetY,
      blurRadius: item.blurRadius,
      spreadRadius: item.spreadRadius,
      color: item.color,
    });
    return `shadow:${item.type}:${css.toLowerCase()}`;
  }
  // isBlurEffect(item) must be true at this point
  return `blur:${item.type}:${item.radius}`;
}

// =============================================================================
// Parsing & Formatting
// =============================================================================

function parseBoxShadowToEffects(raw: string): EffectItem[] {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase() === 'none') return [];

  const segments = splitTopLevel(trimmed, ',')
    .map((s) => s.trim())
    .filter(Boolean);

  const out: EffectItem[] = [];

  for (const seg of segments) {
    const parsed = parseBoxShadow(seg);
    if (parsed) {
      out.push({
        id: createShadowItemId(),
        enabled: true,
        type: parsed.inset ? 'inner-shadow' : 'drop-shadow',
        kind: 'parsed',
        inset: parsed.inset,
        offsetX: parsed.offsetX,
        offsetY: parsed.offsetY,
        blurRadius: parsed.blurRadius,
        spreadRadius: parsed.spreadRadius,
        color: parsed.color,
      });
    } else {
      out.push({
        id: createShadowItemId(),
        enabled: true,
        type: 'raw',
        kind: 'raw',
        property: 'box-shadow',
        rawText: seg,
      });
    }
  }

  return out;
}

function parseFilterBlurToEffect(
  raw: string,
  type: 'layer-blur' | 'backdrop-blur',
): BlurEffectItem | null {
  const radius = parseBlurRadius(raw);
  if (!radius) return null;

  return {
    id: createShadowItemId(),
    enabled: true,
    type,
    kind: 'parsed',
    radius,
  };
}

function formatEffectsToBoxShadow(items: EffectItem[]): string {
  const parts = items
    .filter(
      (item) =>
        item.enabled &&
        (isShadowEffect(item) || (item.kind === 'raw' && item.property === 'box-shadow')),
    )
    .map((item) => {
      if (item.kind === 'raw') return item.rawText.trim();
      if (isShadowEffect(item)) {
        return formatBoxShadow({
          inset: item.inset,
          offsetX: item.offsetX,
          offsetY: item.offsetY,
          blurRadius: item.blurRadius,
          spreadRadius: item.spreadRadius,
          color: item.color,
        });
      }
      return '';
    })
    .map((s) => s.trim())
    .filter(Boolean);

  return parts.join(', ');
}

function getBlurEffectByType(
  items: EffectItem[],
  type: 'layer-blur' | 'backdrop-blur',
): BlurEffectItem | null {
  const item = items.find((i) => i.type === type && i.enabled);
  return item && isBlurEffect(item) ? item : null;
}

function reconcileEffectItems(
  prevItems: EffectItem[],
  nextEnabledItems: EffectItem[],
): EffectItem[] {
  const usedIds = new Set<string>();
  const pool = new Map<string, EffectItem[]>();

  for (const item of prevItems) {
    const key = effectItemKey(item);
    const queue = pool.get(key) ?? [];
    queue.push(item);
    pool.set(key, queue);
  }

  const reconciledEnabled = nextEnabledItems.map((item) => {
    const key = effectItemKey(item);
    const queue = pool.get(key);
    const match = queue?.shift();
    if (match) {
      usedIds.add(match.id);
      return { ...item, id: match.id, enabled: true };
    }
    return item;
  });

  // Keep session-only hidden effects (enabled=false) that are not present in CSS
  const remainingHidden = prevItems.filter((item) => !item.enabled && !usedIds.has(item.id));

  return [...reconciledEnabled, ...remainingHidden];
}

// =============================================================================
// Item View Types
// =============================================================================

interface EffectItemViewBase {
  id: string;
  root: HTMLDivElement;
  row: HTMLDivElement;
  adjustBtn: HTMLButtonElement;
  nameBtn: HTMLButtonElement;
  eyeBtn: HTMLButtonElement;
  deleteBtn: HTMLButtonElement;
  popover: HTMLDivElement;
  disposer: Disposer;
  setOpen(open: boolean): void;
  focusFirst(): void;
  sync(item: EffectItem): void;
  dispose(): void;
}

interface ShadowEffectItemView extends EffectItemViewBase {
  viewType: 'shadow';
  typeSelect: HTMLSelectElement;
  offsetX: InputContainer;
  offsetY: InputContainer;
  blur: InputContainer;
  spread: InputContainer;
  colorField: ColorField;
}

interface BlurEffectItemView extends EffectItemViewBase {
  viewType: 'blur';
  typeSelect: HTMLSelectElement;
  radiusInput: InputContainer;
}

interface RawEffectItemView extends EffectItemViewBase {
  viewType: 'raw';
  rawInput: HTMLInputElement;
}

type EffectItemView = ShadowEffectItemView | BlurEffectItemView | RawEffectItemView;

function getViewTypeForItem(item: EffectItem): EffectItemView['viewType'] {
  if (item.kind === 'raw') return 'raw';
  if (isShadowEffect(item)) return 'shadow';
  if (isBlurEffect(item)) return 'blur';
  return 'raw';
}

// =============================================================================
// Main Factory
// =============================================================================

export function createEffectsControl(options: EffectsControlOptions): DesignControl {
  const { container, transactionManager, tokensService, headerActionsContainer } = options;
  const disposer = new Disposer();

  // Per-target effect cache (current editor session only). WeakMap is used so
  // disabled effects (enabled=false, not written to CSS) are remembered without
  // leaking when the element is removed.
  const perTargetItems = new WeakMap<Element, EffectItem[]>();

  let currentTarget: Element | null = null;
  let currentItems: EffectItem[] = [];
  let itemsById = new Map<string, EffectItem>();
  let openItemId: string | null = null;
  let activeHandle: StyleTransactionHandle | null = null;
  let activeProperty: string | null = null;

  // Root container
  const root = document.createElement('div');
  root.className = 'we-field-group we-effects';
  container.append(root);
  disposer.add(() => root.remove());

  // Add button - placed in header if available, otherwise in toolbar
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'we-effects-icon-btn';
  addBtn.setAttribute('aria-label', 'Add effect');
  addBtn.append(createPlusIcon());

  if (headerActionsContainer) {
    headerActionsContainer.insertBefore(addBtn, headerActionsContainer.firstChild);
    disposer.add(() => addBtn.remove());
  } else {
    const toolbar = document.createElement('div');
    toolbar.className = 'we-effects-toolbar';
    toolbar.append(addBtn);
    root.append(toolbar);
  }

  // Effect list container
  const list = document.createElement('div');
  list.className = 'we-effects-list';

  root.append(list);

  // View registry
  const views = new Map<string, EffectItemView>();

  // -------------------------------------------------------------------------
  // State Management
  // -------------------------------------------------------------------------

  function setCurrentItems(next: EffectItem[]): void {
    currentItems = next;
    itemsById = new Map(next.map((i) => [i.id, i]));
    const target = currentTarget;
    if (target) perTargetItems.set(target, next);
  }

  function getItem(id: string): EffectItem | null {
    return itemsById.get(id) ?? null;
  }

  // -------------------------------------------------------------------------
  // Transaction Management
  // -------------------------------------------------------------------------

  function beginTransaction(property: string): StyleTransactionHandle | null {
    if (disposer.isDisposed) return null;
    const target = currentTarget;
    if (!target || !target.isConnected) return null;
    if (activeHandle && activeProperty === property) return activeHandle;
    // Commit previous if different property
    if (activeHandle) activeHandle.commit({ merge: true });
    activeHandle = transactionManager.beginStyle(target, property);
    activeProperty = property;
    return activeHandle;
  }

  function commitTransaction(): void {
    const handle = activeHandle;
    activeHandle = null;
    activeProperty = null;
    if (handle) handle.commit({ merge: true });
  }

  function rollbackTransaction(): void {
    const handle = activeHandle;
    activeHandle = null;
    activeProperty = null;
    if (handle) handle.rollback();
  }

  function isEditing(): boolean {
    // Only block refresh while a popover is open or a transaction is in flight;
    // a broader focus check would prevent external style changes from syncing.
    return activeHandle !== null || openItemId !== null;
  }

  // -------------------------------------------------------------------------
  // Preview & Apply
  // -------------------------------------------------------------------------

  function previewCurrentItems(): void {
    const target = currentTarget;
    if (!target || !target.isConnected) return;

    // Preview box-shadow
    const shadowHandle = beginTransaction(BOX_SHADOW_PROPERTY);
    if (shadowHandle) {
      shadowHandle.set(formatEffectsToBoxShadow(currentItems));
    }

    // Preview filter blur
    const layerBlur = getBlurEffectByType(currentItems, 'layer-blur');
    if (layerBlur) {
      const filterHandle = beginTransaction('filter');
      if (filterHandle) {
        const existing = readInlineValue(target, 'filter');
        filterHandle.set(upsertBlurFunction(existing, layerBlur.radius));
      }
    }

    // Preview backdrop-filter blur
    const backdropBlur = getBlurEffectByType(currentItems, 'backdrop-blur');
    if (backdropBlur) {
      const backdropHandle = beginTransaction('backdrop-filter');
      if (backdropHandle) {
        const existing = readInlineValue(target, 'backdrop-filter');
        backdropHandle.set(upsertBlurFunction(existing, backdropBlur.radius));
      }
    }
  }

  function applyCurrentItemsDiscrete(): void {
    const target = currentTarget;
    if (!target || !target.isConnected) return;
    commitTransaction();

    // Apply box-shadow
    transactionManager.applyStyle(
      target,
      BOX_SHADOW_PROPERTY,
      formatEffectsToBoxShadow(currentItems),
      {
        merge: false,
      },
    );

    // Apply filter blur
    const layerBlur = getBlurEffectByType(currentItems, 'layer-blur');
    const existingFilter = readInlineValue(target, 'filter');
    transactionManager.applyStyle(
      target,
      'filter',
      upsertBlurFunction(existingFilter, layerBlur?.radius ?? ''),
      {
        merge: false,
      },
    );

    // Apply backdrop-filter blur
    const backdropBlur = getBlurEffectByType(currentItems, 'backdrop-blur');
    const existingBackdrop = readInlineValue(target, 'backdrop-filter');
    transactionManager.applyStyle(
      target,
      'backdrop-filter',
      upsertBlurFunction(existingBackdrop, backdropBlur?.radius ?? ''),
      {
        merge: false,
      },
    );
  }

  // -------------------------------------------------------------------------
  // Popover Management
  // -------------------------------------------------------------------------

  function closePopover(opts?: { commit?: boolean; rollback?: boolean }): void {
    const commit = opts?.commit ?? false;
    const rollback = opts?.rollback ?? false;

    if (rollback) rollbackTransaction();
    else if (commit) commitTransaction();

    const wasOpen = openItemId !== null;
    openItemId = null;
    for (const view of views.values()) view.setOpen(false);

    // Re-sync after close so currentItems reflect any browser normalization of
    // the inline style (e.g. value rounding) that happened during the edit.
    if (wasOpen && !rollback) {
      syncFromTarget(true);
    }
  }

  function setPopoverOpen(id: string | null): void {
    if (id === openItemId) {
      closePopover({ commit: true });
      return;
    }

    closePopover({ commit: true });

    if (!id) return;
    const view = views.get(id);
    if (!view) return;

    openItemId = id;
    for (const [vid, v] of views) v.setOpen(vid === id);
    view.focusFirst();
  }

  // -------------------------------------------------------------------------
  // Input Helpers
  // -------------------------------------------------------------------------

  function setLengthInput(containerRef: InputContainer, raw: string): void {
    const formatted = formatLengthForDisplay(raw);
    containerRef.input.value = formatted.value;
    containerRef.setSuffix(formatted.suffix);
  }

  // -------------------------------------------------------------------------
  // Effect Type Conversion
  // -------------------------------------------------------------------------

  /**
   * Convert an effect item to a new type, preserving compatible fields.
   */
  function createEffectItemWithType(
    prev: EffectItem,
    nextType: EffectTypeValue,
  ): EffectItem | null {
    if (prev.kind === 'raw') return null;

    // Convert to blur type
    if (nextType === 'layer-blur' || nextType === 'backdrop-blur') {
      const base = createDefaultBlurEffect(nextType);
      // Map blur radius from previous effect
      const mappedRadius = isBlurEffect(prev)
        ? prev.radius
        : isShadowEffect(prev)
          ? prev.blurRadius
          : base.radius;
      return {
        ...base,
        id: prev.id,
        enabled: prev.enabled,
        radius: mappedRadius || base.radius,
      };
    }

    // Convert to shadow type
    const base = createDefaultShadowEffect();
    const shadowPrev = isShadowEffect(prev) ? prev : null;
    const blurPrev = isBlurEffect(prev) ? prev : null;
    const mappedBlurRadius = shadowPrev?.blurRadius ?? blurPrev?.radius ?? base.blurRadius;

    return {
      ...base,
      id: prev.id,
      enabled: prev.enabled,
      type: nextType,
      inset: nextType === 'inner-shadow',
      offsetX: shadowPrev?.offsetX ?? base.offsetX,
      offsetY: shadowPrev?.offsetY ?? base.offsetY,
      blurRadius: mappedBlurRadius || base.blurRadius,
      spreadRadius: shadowPrev?.spreadRadius ?? base.spreadRadius,
      color: shadowPrev?.color ?? base.color,
    };
  }

  /**
   * Update an effect item's type, potentially converting between shadow/blur.
   */
  function updateEffectItemType(id: string, nextType: EffectTypeValue): void {
    const prev = getItem(id);
    if (!prev || prev.kind === 'raw') return;
    if (prev.type === nextType) return;

    const nextItem = createEffectItemWithType(prev, nextType);
    if (!nextItem) return;

    let nextItems = currentItems.map((it) => (it.id === id ? nextItem : it));

    // Only one blur effect per type (filter/backdrop-filter) is supported
    if (nextItem.type === 'layer-blur' || nextItem.type === 'backdrop-blur') {
      nextItems = nextItems.filter((it) => it.id === id || it.type !== nextItem.type);
    }

    setCurrentItems(nextItems);
    renderList();
    applyCurrentItemsDiscrete();

    // The view might have been recreated (shadow <-> blur), restore focus
    if (openItemId === id) {
      views.get(id)?.focusFirst();
    }
  }

  // -------------------------------------------------------------------------
  // Item View Factory
  // -------------------------------------------------------------------------

  function createItemView(item: EffectItem): EffectItemView {
    const itemDisposer = new Disposer();

    const wrap = document.createElement('div');
    wrap.className = 'we-effects-item-wrap';

    const row = document.createElement('div');
    row.className = 'we-effects-item';
    row.dataset.enabled = item.enabled ? 'true' : 'false';
    row.dataset.open = 'false';

    const adjustBtn = createIconButton('Adjust effect');
    adjustBtn.append(createAdjustIcon());

    const nameBtn = document.createElement('button');
    nameBtn.type = 'button';
    nameBtn.className = 'we-effects-name';

    const eyeBtn = createIconButton('Toggle visibility');

    const deleteBtn = createIconButton('Remove effect');
    deleteBtn.append(createTrashIcon());

    row.append(adjustBtn, nameBtn, eyeBtn, deleteBtn);

    const popover = document.createElement('div');
    popover.className = 'we-effects-popover';
    popover.hidden = true;

    wrap.append(row, popover);

    // Common event handlers
    itemDisposer.listen(adjustBtn, 'click', (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setPopoverOpen(item.id);
    });

    itemDisposer.listen(nameBtn, 'click', (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setPopoverOpen(item.id);
    });

    itemDisposer.listen(eyeBtn, 'click', (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const it = getItem(item.id);
      if (!it) return;
      it.enabled = !it.enabled;
      row.dataset.enabled = it.enabled ? 'true' : 'false';
      eyeBtn.replaceChildren(createEyeIcon(it.enabled));
      applyCurrentItemsDiscrete();
    });

    itemDisposer.listen(deleteBtn, 'click', (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (openItemId === item.id) closePopover({ commit: true });
      setCurrentItems(currentItems.filter((i) => i.id !== item.id));
      views.get(item.id)?.dispose();
      views.delete(item.id);
      renderList();
      applyCurrentItemsDiscrete();
    });

    // Raw shadow item view
    if (item.kind === 'raw') {
      const content = document.createElement('div');
      content.className = 'we-effects-popover-content';

      const field = document.createElement('div');
      field.className = 'we-field';

      const label = document.createElement('span');
      label.className = 'we-field-label';
      label.textContent = 'Value';

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'we-input';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.setAttribute('aria-label', 'Shadow value');

      field.append(label, input);
      content.append(field);
      popover.append(content);

      itemDisposer.listen(input, 'input', () => {
        const it = getItem(item.id);
        if (!it || it.kind !== 'raw') return;
        it.rawText = input.value;
        previewCurrentItems();
      });

      itemDisposer.listen(input, 'blur', () => {
        commitTransaction();
      });

      itemDisposer.listen(input, 'keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commitTransaction();
          input.blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          closePopover({ rollback: true });
          syncFromTarget(true);
        }
      });

      const view: RawEffectItemView = {
        id: item.id,
        viewType: 'raw',
        root: wrap,
        row,
        adjustBtn,
        nameBtn,
        eyeBtn,
        deleteBtn,
        popover,
        rawInput: input,
        disposer: itemDisposer,
        setOpen(open: boolean): void {
          row.dataset.open = open ? 'true' : 'false';
          popover.hidden = !open;
        },
        focusFirst(): void {
          input.focus();
          input.select();
        },
        sync(next: EffectItem): void {
          row.dataset.enabled = next.enabled ? 'true' : 'false';
          nameBtn.textContent = getEffectItemLabel(next);
          eyeBtn.replaceChildren(createEyeIcon(next.enabled));
          if (next.kind === 'raw') input.value = next.rawText;
        },
        dispose(): void {
          itemDisposer.dispose();
          wrap.remove();
        },
      };

      return view;
    }

    // Blur effect view (Layer Blur / Backdrop Blur)
    if (isBlurEffect(item)) {
      const content = document.createElement('div');
      content.className = 'we-effects-popover-content';

      // Type select (only blur types)
      const typeField = document.createElement('div');
      typeField.className = 'we-field';

      const typeLabel = document.createElement('span');
      typeLabel.className = 'we-field-label';
      typeLabel.textContent = 'Type';

      const typeSelect = document.createElement('select');
      typeSelect.className = 'we-select';
      typeSelect.setAttribute('aria-label', 'Effect type');

      for (const v of EFFECT_TYPE_OPTIONS) {
        const opt = document.createElement('option');
        opt.value = v.value;
        opt.textContent = v.label;
        typeSelect.append(opt);
      }

      typeField.append(typeLabel, typeSelect);

      // Radius input
      const radiusField = document.createElement('div');
      radiusField.className = 'we-field';

      const radiusLabel = document.createElement('span');
      radiusLabel.className = 'we-field-label';
      radiusLabel.textContent = 'Blur';

      const radiusInput = createInputContainer({
        ariaLabel: 'Blur radius',
        inputMode: 'decimal',
        suffix: 'px',
      });

      radiusField.append(radiusLabel, radiusInput.root);
      content.append(typeField, radiusField);
      popover.append(content);

      wireNumberStepping(itemDisposer, radiusInput.input, {
        mode: 'css-length',
        min: 0,
        step: 1,
        shiftStep: 10,
        altStep: 0.1,
      });

      itemDisposer.listen(radiusInput.input, 'input', () => {
        const it = getItem(item.id);
        if (!it || !isBlurEffect(it)) return;
        it.radius = combineLengthValue(radiusInput.input.value, radiusInput.getSuffixText());
        previewCurrentItems();
      });

      itemDisposer.listen(radiusInput.input, 'blur', () => {
        commitTransaction();
        syncFromTarget(true);
      });

      itemDisposer.listen(radiusInput.input, 'keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commitTransaction();
          syncFromTarget(true);
          radiusInput.input.blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          closePopover({ rollback: true });
          syncFromTarget(true);
        }
      });

      const onTypeChange = () => {
        updateEffectItemType(item.id, typeSelect.value as EffectTypeValue);
      };

      itemDisposer.listen(typeSelect, 'input', onTypeChange);
      itemDisposer.listen(typeSelect, 'change', onTypeChange);

      const view: BlurEffectItemView = {
        id: item.id,
        viewType: 'blur',
        root: wrap,
        row,
        adjustBtn,
        nameBtn,
        eyeBtn,
        deleteBtn,
        popover,
        disposer: itemDisposer,
        typeSelect,
        radiusInput,
        setOpen(open: boolean): void {
          row.dataset.open = open ? 'true' : 'false';
          popover.hidden = !open;
        },
        focusFirst(): void {
          radiusInput.input.focus();
          radiusInput.input.select();
        },
        sync(next: EffectItem): void {
          row.dataset.enabled = next.enabled ? 'true' : 'false';
          nameBtn.textContent = getEffectItemLabel(next);
          eyeBtn.replaceChildren(createEyeIcon(next.enabled));
          if (!isBlurEffect(next)) return;
          typeSelect.value = next.type;
          setLengthInput(radiusInput, next.radius);
        },
        dispose(): void {
          itemDisposer.dispose();
          wrap.remove();
        },
      };

      return view;
    }

    // Shadow effect view (Drop Shadow / Inner Shadow)
    const content = document.createElement('div');
    content.className = 'we-effects-popover-content';

    // Type select (only shadow types)
    const typeField = document.createElement('div');
    typeField.className = 'we-field';

    const typeLabel = document.createElement('span');
    typeLabel.className = 'we-field-label';
    typeLabel.textContent = 'Type';

    const typeSelect = document.createElement('select');
    typeSelect.className = 'we-select';
    typeSelect.setAttribute('aria-label', 'Effect type');

    for (const v of EFFECT_TYPE_OPTIONS) {
      const opt = document.createElement('option');
      opt.value = v.value;
      opt.textContent = v.label;
      typeSelect.append(opt);
    }

    typeField.append(typeLabel, typeSelect);

    // X/Y row
    const xyRow = document.createElement('div');
    xyRow.className = 'we-field-row';

    const x = createInputContainer({
      ariaLabel: 'Shadow offset X',
      inputMode: 'decimal',
      prefix: 'X',
      suffix: 'px',
    });
    const y = createInputContainer({
      ariaLabel: 'Shadow offset Y',
      inputMode: 'decimal',
      prefix: 'Y',
      suffix: 'px',
    });
    xyRow.append(x.root, y.root);

    // Blur/Spread row
    const blurRow = document.createElement('div');
    blurRow.className = 'we-field-row';

    const blur = createInputContainer({
      ariaLabel: 'Shadow blur radius',
      inputMode: 'decimal',
      prefix: 'B',
      suffix: 'px',
    });
    const spread = createInputContainer({
      ariaLabel: 'Shadow spread radius',
      inputMode: 'decimal',
      prefix: 'S',
      suffix: 'px',
    });
    blurRow.append(blur.root, spread.root);

    // Color field
    const colorFieldRow = document.createElement('div');
    colorFieldRow.className = 'we-field';

    const colorLabel = document.createElement('span');
    colorLabel.className = 'we-field-label';
    colorLabel.textContent = 'Color';

    const colorMount = document.createElement('div');
    colorMount.style.minWidth = '0';

    colorFieldRow.append(colorLabel, colorMount);

    content.append(typeField, xyRow, blurRow, colorFieldRow);
    popover.append(content);

    // Wire number stepping
    wireNumberStepping(itemDisposer, x.input, { mode: 'css-length' });
    wireNumberStepping(itemDisposer, y.input, { mode: 'css-length' });
    wireNumberStepping(itemDisposer, blur.input, {
      mode: 'css-length',
      min: 0,
      step: 1,
      shiftStep: 10,
      altStep: 0.1,
    });
    wireNumberStepping(itemDisposer, spread.input, {
      mode: 'css-length',
      step: 1,
      shiftStep: 10,
      altStep: 0.1,
    });

    // Create color field
    const colorField = createColorField({
      container: colorMount,
      ariaLabel: 'Shadow color',
      tokensService,
      getTokenTarget: () => currentTarget,
      onInput: (value) => {
        const it = getItem(item.id);
        if (!it || !isShadowEffect(it)) return;
        it.color = value;
        previewCurrentItems();
      },
      onCommit: () => {
        commitTransaction();
      },
      onCancel: () => {
        rollbackTransaction();
        syncFromTarget(true);
      },
    });
    itemDisposer.add(() => colorField.dispose());

    // Wire length field handlers
    const wireShadowLengthField = (
      containerRef: InputContainer,
      key: keyof Pick<ShadowEffectItem, 'offsetX' | 'offsetY' | 'blurRadius' | 'spreadRadius'>,
    ) => {
      itemDisposer.listen(containerRef.input, 'input', () => {
        const it = getItem(item.id);
        if (!it || !isShadowEffect(it)) return;
        const next = combineLengthValue(containerRef.input.value, containerRef.getSuffixText());
        it[key] = next;
        previewCurrentItems();
      });

      itemDisposer.listen(containerRef.input, 'blur', () => {
        commitTransaction();
        syncFromTarget(true);
      });

      itemDisposer.listen(containerRef.input, 'keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commitTransaction();
          syncFromTarget(true);
          containerRef.input.blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          rollbackTransaction();
          syncFromTarget(true);
        }
      });
    };

    wireShadowLengthField(x, 'offsetX');
    wireShadowLengthField(y, 'offsetY');
    wireShadowLengthField(blur, 'blurRadius');
    wireShadowLengthField(spread, 'spreadRadius');

    // Type change handler
    const onTypeChange = () => {
      updateEffectItemType(item.id, typeSelect.value as EffectTypeValue);
    };

    itemDisposer.listen(typeSelect, 'input', onTypeChange);
    itemDisposer.listen(typeSelect, 'change', onTypeChange);

    const view: ShadowEffectItemView = {
      id: item.id,
      viewType: 'shadow',
      root: wrap,
      row,
      adjustBtn,
      nameBtn,
      eyeBtn,
      deleteBtn,
      popover,
      disposer: itemDisposer,
      typeSelect,
      offsetX: x,
      offsetY: y,
      blur,
      spread,
      colorField,
      setOpen(open: boolean): void {
        row.dataset.open = open ? 'true' : 'false';
        popover.hidden = !open;
      },
      focusFirst(): void {
        typeSelect.focus();
      },
      sync(next: EffectItem): void {
        row.dataset.enabled = next.enabled ? 'true' : 'false';
        nameBtn.textContent = getEffectItemLabel(next);
        eyeBtn.replaceChildren(createEyeIcon(next.enabled));
        if (!isShadowEffect(next)) return;
        typeSelect.value = next.type;
        setLengthInput(x, next.offsetX);
        setLengthInput(y, next.offsetY);
        setLengthInput(blur, next.blurRadius);
        setLengthInput(spread, next.spreadRadius);
        colorField.setValue(next.color);
      },
      dispose(): void {
        itemDisposer.dispose();
        wrap.remove();
      },
    };

    return view;
  }

  // -------------------------------------------------------------------------
  // List Rendering
  // -------------------------------------------------------------------------

  function renderList(): void {
    const ids = new Set(currentItems.map((i) => i.id));

    // Remove stale views
    for (const [id, view] of Array.from(views.entries())) {
      if (!ids.has(id)) {
        if (openItemId === id) openItemId = null;
        view.dispose();
        views.delete(id);
      }
    }

    // Create/update views
    for (const item of currentItems) {
      const existing = views.get(item.id);
      const expectedViewType = getViewTypeForItem(item);
      if (!existing || existing.viewType !== expectedViewType) {
        existing?.dispose();
        views.set(item.id, createItemView(item));
      }

      const view = views.get(item.id)!;
      view.sync(item);
      view.setOpen(openItemId === item.id);
      list.append(view.root);
    }
  }

  // -------------------------------------------------------------------------
  // Sync from Target
  // -------------------------------------------------------------------------

  function syncFromTarget(force = false): void {
    const target = currentTarget;

    if (!target || !target.isConnected) {
      addBtn.disabled = true;
      setCurrentItems([]);
      closePopover({ commit: true });
      renderList();
      return;
    }

    addBtn.disabled = false;
    if (!force && isEditing()) return;

    // Parse box-shadow effects
    const boxShadowInline = readInlineValue(target, BOX_SHADOW_PROPERTY);
    const shadowEffects = parseBoxShadowToEffects(boxShadowInline);

    // Parse filter blur
    const filterInline = readInlineValue(target, 'filter');
    const layerBlur = parseFilterBlurToEffect(filterInline, 'layer-blur');

    // Parse backdrop-filter blur
    const backdropInline = readInlineValue(target, 'backdrop-filter');
    const backdropBlur = parseFilterBlurToEffect(backdropInline, 'backdrop-blur');

    // Combine all enabled effects
    const nextEnabled: EffectItem[] = [
      ...shadowEffects,
      ...(layerBlur ? [layerBlur] : []),
      ...(backdropBlur ? [backdropBlur] : []),
    ];

    const prev = perTargetItems.get(target) ?? [];
    setCurrentItems(reconcileEffectItems(prev, nextEnabled));
    renderList();
  }

  // -------------------------------------------------------------------------
  // Event Handlers
  // -------------------------------------------------------------------------

  disposer.listen(addBtn, 'click', (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const target = currentTarget;
    if (!target || !target.isConnected) return;

    closePopover({ commit: true });
    const newEffect = createDefaultShadowEffect();
    const next = [...currentItems, newEffect];
    setCurrentItems(next);
    renderList();
    applyCurrentItemsDiscrete();
    setPopoverOpen(newEffect.id);
  });

  // Close popover when clicking outside the open item.
  // Capture-phase document listener so clicks outside the Effects control still close it.
  const handleClickOutside = (e: MouseEvent) => {
    const openId = openItemId;
    if (!openId) return;
    const view = views.get(openId);
    if (!view) return;

    // Use composedPath to handle Shadow DOM event retargeting
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    const clickedInside =
      path.length > 0
        ? path.includes(view.root)
        : (() => {
            const node = e.target as Node | null;
            return !!(node && view.root.contains(node));
          })();

    if (clickedInside) return;
    closePopover({ commit: true });
  };

  const doc = root.ownerDocument;
  doc.addEventListener('click', handleClickOutside, true);
  disposer.add(() => doc.removeEventListener('click', handleClickOutside, true));

  // Escape closes the popover and rolls back the current preview transaction.
  const handleEscape = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    if (!openItemId) return;
    e.preventDefault();
    e.stopPropagation();
    closePopover({ rollback: true });
    syncFromTarget(true);
  };

  root.addEventListener('keydown', handleEscape, true);
  disposer.add(() => root.removeEventListener('keydown', handleEscape, true));

  // -------------------------------------------------------------------------
  // DesignControl Interface
  // -------------------------------------------------------------------------

  function setTarget(element: Element | null): void {
    if (disposer.isDisposed) return;

    if (element !== currentTarget) {
      commitTransaction();
      closePopover({ commit: true });
    }

    currentTarget = element;

    if (element && element.isConnected) {
      setCurrentItems(perTargetItems.get(element) ?? []);
    } else {
      setCurrentItems([]);
    }

    syncFromTarget(true);
  }

  function refresh(): void {
    if (disposer.isDisposed) return;
    syncFromTarget(false);
  }

  function dispose(): void {
    commitTransaction();
    currentTarget = null;
    for (const view of views.values()) view.dispose();
    views.clear();
    disposer.dispose();
  }

  // Initialize
  syncFromTarget(true);

  return { setTarget, refresh, dispose };
}
