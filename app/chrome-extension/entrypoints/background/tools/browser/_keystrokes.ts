/**
 * Shared CDP keystroke + click helpers. Callers must already be inside
 * `cdpSessionManager.withSession` — these send raw CDP commands and
 * assume an attached session.
 */
import { cdpSessionManager } from '@/utils/cdp-session-manager';

// CDP `Input.dispatchKeyEvent`/`dispatchMouseEvent` modifier bitmask.
// Match Chromium's CDP spec values (Alt=1, Ctrl=2, Meta=4, Shift=8).
export const ALT_MODIFIER = 1;
export const CTRL_MODIFIER = 2;
export const META_MODIFIER = 4;
export const SHIFT_MODIFIER = 8;

export interface KeyboardModifiers {
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

/** Pack `{altKey, ctrlKey, metaKey, shiftKey}` into the CDP modifier bitmask. */
export function buildCdpModifiers(mods?: KeyboardModifiers): number {
  if (!mods) return 0;
  return (
    (mods.altKey ? ALT_MODIFIER : 0) |
    (mods.ctrlKey ? CTRL_MODIFIER : 0) |
    (mods.metaKey ? META_MODIFIER : 0) |
    (mods.shiftKey ? SHIFT_MODIFIER : 0)
  );
}

export interface KeyMeta {
  code: string;
  vk: number;
  shift?: boolean;
  unmodified?: string;
}

// US QWERTY → unshifted base char for ASCII symbols. Map values are
// `[code, vk, unshifted-base]`.
const SHIFTED_SYMBOLS: Record<string, [string, number, string]> = {
  '!': ['Digit1', 49, '1'],
  '@': ['Digit2', 50, '2'],
  '#': ['Digit3', 51, '3'],
  $: ['Digit4', 52, '4'],
  '%': ['Digit5', 53, '5'],
  '^': ['Digit6', 54, '6'],
  '&': ['Digit7', 55, '7'],
  '*': ['Digit8', 56, '8'],
  '(': ['Digit9', 57, '9'],
  ')': ['Digit0', 48, '0'],
  _: ['Minus', 189, '-'],
  '+': ['Equal', 187, '='],
  '{': ['BracketLeft', 219, '['],
  '}': ['BracketRight', 221, ']'],
  '|': ['Backslash', 220, '\\'],
  ':': ['Semicolon', 186, ';'],
  '"': ['Quote', 222, "'"],
  '<': ['Comma', 188, ','],
  '>': ['Period', 190, '.'],
  '?': ['Slash', 191, '/'],
  '~': ['Backquote', 192, '`'],
};

const UNSHIFTED_SYMBOLS: Record<string, [string, number]> = (() => {
  const out: Record<string, [string, number]> = { ' ': ['Space', 32] };
  for (const [code, vk, base] of Object.values(SHIFTED_SYMBOLS)) {
    out[base] = [code, vk];
  }
  return out;
})();

/**
 * Map a printable ASCII char to its CDP `code` + `windowsVirtualKeyCode`.
 * Returns `null` for non-ASCII (let the caller fall through to insertText).
 */
export function charToKey(ch: string): KeyMeta | null {
  if (ch.length !== 1) return null;
  const code = ch.charCodeAt(0);
  if (code > 127) return null;
  if (ch >= 'a' && ch <= 'z') {
    return { code: 'Key' + ch.toUpperCase(), vk: ch.toUpperCase().charCodeAt(0) };
  }
  if (ch >= 'A' && ch <= 'Z') {
    return { code: 'Key' + ch, vk: ch.charCodeAt(0), shift: true, unmodified: ch.toLowerCase() };
  }
  if (ch >= '0' && ch <= '9') {
    return { code: 'Digit' + ch, vk: ch.charCodeAt(0) };
  }
  const shifted = SHIFTED_SYMBOLS[ch];
  if (shifted) {
    return { code: shifted[0], vk: shifted[1], shift: true, unmodified: shifted[2] };
  }
  const unshifted = UNSHIFTED_SYMBOLS[ch];
  if (unshifted) {
    return { code: unshifted[0], vk: unshifted[1] };
  }
  return null;
}

/**
 * Dispatch one character through CDP: keyDown + insertText + keyUp.
 *
 * Input.insertText goes through the IME pipeline, which Chromium delivers
 * to the focused input regardless of tab visibility — dispatchKeyEvent's
 * text payload is suppressed in hidden renderers (CFT-CI, alt-tabbed).
 */
export async function sendChar(tabId: number, ch: string): Promise<void> {
  const meta = charToKey(ch);
  if (!meta) {
    await cdpSessionManager.sendCommand(tabId, 'Input.insertText', { text: ch });
    return;
  }
  const modifiers = meta.shift ? SHIFT_MODIFIER : 0;
  const keyArgs = {
    key: ch,
    code: meta.code,
    windowsVirtualKeyCode: meta.vk,
    nativeVirtualKeyCode: meta.vk,
    modifiers,
  };
  await cdpSessionManager.sendCommand(tabId, 'Input.dispatchKeyEvent', {
    ...keyArgs,
    type: 'keyDown',
    unmodifiedText: meta.unmodified ?? ch,
  });
  await cdpSessionManager.sendCommand(tabId, 'Input.insertText', { text: ch });
  await cdpSessionManager.sendCommand(tabId, 'Input.dispatchKeyEvent', { ...keyArgs, type: 'keyUp' });
}

/**
 * Send a named non-printable key (Enter, Delete, ArrowDown, etc).
 * CDP needs `key`, `code`, `windowsVirtualKeyCode` to recognize it as a
 * control key rather than printable text.
 */
export async function sendKey(
  tabId: number,
  key: string,
  code: string,
  vk: number,
  text?: string,
): Promise<void> {
  const down: Record<string, unknown> = {
    type: 'keyDown',
    key,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
  };
  if (text) down.text = text;
  await cdpSessionManager.sendCommand(tabId, 'Input.dispatchKeyEvent', down);
  await cdpSessionManager.sendCommand(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
  });
}

/**
 * Cross-platform Select-All via Ctrl+A. Chromium honors the modifier mask
 * regardless of host OS, so Ctrl works on Mac too — picking Ctrl avoids
 * Linux/Windows divergence on builds that only honor Ctrl for text inputs.
 */
export async function sendSelectAll(tabId: number): Promise<void> {
  const aDown = {
    type: 'rawKeyDown' as const,
    modifiers: CTRL_MODIFIER,
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
  };
  const aUp = {
    type: 'keyUp' as const,
    modifiers: CTRL_MODIFIER,
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
  };
  await cdpSessionManager.sendCommand(tabId, 'Input.dispatchKeyEvent', aDown);
  await cdpSessionManager.sendCommand(tabId, 'Input.dispatchKeyEvent', aUp);
}

/** Named-key constants for callers that don't want to remember vk codes. */
export const NAMED_KEYS = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
} as const;

export type NamedKey = keyof typeof NAMED_KEYS;

/** Convenience wrapper for sendKey using NAMED_KEYS entries. */
export async function sendNamedKey(tabId: number, name: NamedKey): Promise<void> {
  const k = NAMED_KEYS[name];
  await sendKey(tabId, k.key, k.code, k.vk, (k as { text?: string }).text);
}

export type MouseButton = 'left' | 'middle' | 'right';

export interface CdpClickOptions {
  /** Default 'left'. */
  button?: MouseButton;
  /** Default false. When true, fires a second press/release with clickCount=2. */
  double?: boolean;
  /** Keyboard modifiers active during the click. */
  modifiers?: KeyboardModifiers;
}

/**
 * Dispatch a trusted CDP mouse click at (x, y). Always issues the full
 * `mouseMoved → mousePressed → mouseReleased` sequence — stable Chrome 145
 * sometimes drops a bare press/release pair on click handlers that gate on
 * a preceding pointermove (Bug-002 fix). For `double:true`, fires a second
 * press+release with `clickCount: 2`.
 */
export async function cdpClick(
  tabId: number,
  x: number,
  y: number,
  options: CdpClickOptions = {},
): Promise<void> {
  const button: MouseButton = options.button ?? 'left';
  const buttons = button === 'right' ? 2 : button === 'middle' ? 4 : 1;
  const modifiers = buildCdpModifiers(options.modifiers);
  const isDouble = options.double === true;

  await cdpSessionManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y,
    button: 'none',
    buttons: 0,
    modifiers,
  });
  await cdpSessionManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button,
    buttons,
    clickCount: isDouble ? 2 : 1,
    modifiers,
  });
  await cdpSessionManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button,
    buttons: 0,
    clickCount: isDouble ? 2 : 1,
    modifiers,
  });
  if (isDouble) {
    await cdpSessionManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button,
      buttons,
      clickCount: 2,
      modifiers,
    });
    await cdpSessionManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button,
      buttons: 0,
      clickCount: 2,
      modifiers,
    });
  }
}
