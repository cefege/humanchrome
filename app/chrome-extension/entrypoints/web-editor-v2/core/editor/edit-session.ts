/**
 * Web Editor V2 — Text editing session (Phase 2.7).
 *
 * Owns per-edit lifecycle for inline text edits: enabling contentEditable,
 * snapshotting before-state, committing/cancelling, and emitting a text
 * transaction when content changes.
 *
 * The orchestrator wires startEdit into EventController callbacks and
 * delegates pre-cleanup commits in stop().
 */

import { WEB_EDITOR_V2_LOG_PREFIX } from '../../constants';
import type { EventModifiers } from '../event-controller';
import type { EditSessionController, EditorInternalState } from './types';

interface InternalEditSession {
  element: HTMLElement;
  beforeText: string;
  beforeContentEditable: string | null;
  beforeSpellcheck: boolean;
  keydownHandler: (ev: KeyboardEvent) => void;
  blurHandler: () => void;
}

export interface EditSessionDeps {
  state: EditorInternalState;
  /** Called when starting to edit an element that isn't currently selected. */
  selectElement(element: Element, modifiers: EventModifiers): void;
}

export function createEditSession({ state, selectElement }: EditSessionDeps): EditSessionController {
  let editSession: InternalEditSession | null = null;

  /** Check if element is a valid text edit target */
  function isTextEditTarget(element: Element): element is HTMLElement {
    if (!(element instanceof HTMLElement)) return false;
    // Not for form controls
    if (element instanceof HTMLInputElement) return false;
    if (element instanceof HTMLTextAreaElement) return false;
    // Only for text-only targets (no element children)
    if (element.childElementCount > 0) return false;
    return true;
  }

  /** Restore element to pre-edit state */
  function restoreEditTarget(session: InternalEditSession): void {
    const { element, beforeContentEditable, beforeSpellcheck } = session;

    if (beforeContentEditable === null) {
      element.removeAttribute('contenteditable');
    } else {
      element.setAttribute('contenteditable', beforeContentEditable);
    }

    element.spellcheck = beforeSpellcheck;

    // Remove event listeners
    element.removeEventListener('keydown', session.keydownHandler, true);
    element.removeEventListener('blur', session.blurHandler, true);
  }

  function commitEdit(): void {
    const session = editSession;
    if (!session) return;

    editSession = null;

    const element = session.element;
    const afterText = element.textContent ?? '';

    // Normalize to text-only to avoid structure drift from contentEditable
    element.textContent = afterText;

    restoreEditTarget(session);

    // Record transaction if text changed
    if (session.beforeText !== afterText) {
      state.transactionManager?.recordText(element, session.beforeText, afterText);
    }

    console.log(`${WEB_EDITOR_V2_LOG_PREFIX} Text edit committed`);
  }

  function cancelEdit(): void {
    const session = editSession;
    if (!session) return;

    editSession = null;

    // Restore original text
    session.element.textContent = session.beforeText;

    restoreEditTarget(session);
    console.log(`${WEB_EDITOR_V2_LOG_PREFIX} Text edit cancelled`);
  }

  function startEdit(element: Element, modifiers: EventModifiers): boolean {
    if (!isTextEditTarget(element)) return false;
    if (!element.isConnected) return false;

    // Ensure element is selected
    if (state.selectedElement !== element) {
      selectElement(element, modifiers);
    }

    // If already editing this element, keep editing
    if (editSession?.element === element) return true;

    // Commit previous edit if any
    if (editSession) {
      commitEdit();
    }

    const beforeText = element.textContent ?? '';
    const beforeContentEditable = element.getAttribute('contenteditable');
    const beforeSpellcheck = element.spellcheck;

    // ESC cancels editing
    const keydownHandler = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      cancelEdit();
      state.eventController?.setMode('selecting');
    };

    // Blur commits editing
    const blurHandler = () => {
      commitEdit();
      state.eventController?.setMode('selecting');
    };

    element.addEventListener('keydown', keydownHandler, true);
    element.addEventListener('blur', blurHandler, true);

    element.setAttribute('contenteditable', 'true');
    element.spellcheck = false;

    try {
      element.focus({ preventScroll: true });
    } catch {
      try {
        element.focus();
      } catch {
        // Best-effort only
      }
    }

    editSession = {
      element,
      beforeText,
      beforeContentEditable,
      beforeSpellcheck,
      keydownHandler,
      blurHandler,
    };

    console.log(`${WEB_EDITOR_V2_LOG_PREFIX} Text edit started`);
    return true;
  }

  return {
    startEdit,
    commitEdit,
    cancelEdit,
    hasSession: () => editSession !== null,
    currentElement: () => editSession?.element ?? null,
  };
}
