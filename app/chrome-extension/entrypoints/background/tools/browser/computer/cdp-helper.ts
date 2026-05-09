/**
 * CDP helper for the chrome_computer tool.
 *
 * Pre-IMP-0054 this lived inline at the top of computer.ts. Extracted
 * so the per-action handler split planned for IMP-0054 has a stable
 * import target (every action handler needs a few of these primitives).
 *
 * `timeoutMs` flows down to `cdpSessionManager.sendCommand` via a per-tab
 * map. `chrome_computer.execute()` calls `withTimeout(tabId, params.timeoutMs,
 * async () => { ... })` to scope the override; nested invocations restore
 * the previous value on exit. Keyed by tabId so concurrent invocations on
 * different tabs don't clobber each other (within the same tab the JS lock
 * already serialises chrome_computer calls).
 */

import { cdpSessionManager } from '@/utils/cdp-session-manager';

export class CDPHelper {
  private static timeoutByTab = new Map<number, number>();

  static async withTimeout<T>(
    tabId: number,
    timeoutMs: number | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    const previous = this.timeoutByTab.get(tabId);
    if (timeoutMs !== undefined) {
      this.timeoutByTab.set(tabId, timeoutMs);
    } else {
      this.timeoutByTab.delete(tabId);
    }
    try {
      return await fn();
    } finally {
      if (previous !== undefined) {
        this.timeoutByTab.set(tabId, previous);
      } else {
        this.timeoutByTab.delete(tabId);
      }
    }
  }

  static async attach(tabId: number): Promise<void> {
    await cdpSessionManager.attach(tabId, 'computer');
  }

  static async detach(tabId: number): Promise<void> {
    await cdpSessionManager.detach(tabId, 'computer');
  }

  static async send(tabId: number, method: string, params?: object): Promise<any> {
    return await cdpSessionManager.sendCommand(tabId, method, params, this.timeoutByTab.get(tabId));
  }

  static async dispatchMouseEvent(tabId: number, opts: any) {
    const params: any = {
      type: opts.type,
      x: Math.round(opts.x),
      y: Math.round(opts.y),
      modifiers: opts.modifiers || 0,
    };
    if (
      opts.type === 'mousePressed' ||
      opts.type === 'mouseReleased' ||
      opts.type === 'mouseMoved'
    ) {
      params.button = opts.button || 'none';
      if (opts.type === 'mousePressed' || opts.type === 'mouseReleased') {
        params.clickCount = opts.clickCount || 1;
      }
      // Per CDP: buttons is ignored for mouseWheel
      params.buttons = opts.buttons !== undefined ? opts.buttons : 0;
    }
    if (opts.type === 'mouseWheel') {
      params.deltaX = opts.deltaX || 0;
      params.deltaY = opts.deltaY || 0;
    }
    await this.send(tabId, 'Input.dispatchMouseEvent', params);
  }

  static async insertText(tabId: number, text: string) {
    await this.send(tabId, 'Input.insertText', { text });
  }

  static modifierMask(mods: string[]): number {
    const map: Record<string, number> = {
      alt: 1,
      ctrl: 2,
      control: 2,
      meta: 4,
      cmd: 4,
      command: 4,
      win: 4,
      windows: 4,
      shift: 8,
    };
    let mask = 0;
    for (const m of mods) mask |= map[m] || 0;
    return mask;
  }

  // Enhanced key mapping for common non-character keys
  private static KEY_ALIASES: Record<string, { key: string; code?: string; text?: string }> = {
    enter: { key: 'Enter', code: 'Enter' },
    return: { key: 'Enter', code: 'Enter' },
    backspace: { key: 'Backspace', code: 'Backspace' },
    delete: { key: 'Delete', code: 'Delete' },
    tab: { key: 'Tab', code: 'Tab' },
    escape: { key: 'Escape', code: 'Escape' },
    esc: { key: 'Escape', code: 'Escape' },
    space: { key: ' ', code: 'Space', text: ' ' },
    pageup: { key: 'PageUp', code: 'PageUp' },
    pagedown: { key: 'PageDown', code: 'PageDown' },
    home: { key: 'Home', code: 'Home' },
    end: { key: 'End', code: 'End' },
    arrowup: { key: 'ArrowUp', code: 'ArrowUp' },
    arrowdown: { key: 'ArrowDown', code: 'ArrowDown' },
    arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft' },
    arrowright: { key: 'ArrowRight', code: 'ArrowRight' },
  };

  private static resolveKeyDef(token: string): { key: string; code?: string; text?: string } {
    const t = (token || '').toLowerCase();
    if (this.KEY_ALIASES[t]) return this.KEY_ALIASES[t];
    if (/^f([1-9]|1[0-2])$/.test(t)) {
      return { key: t.toUpperCase(), code: t.toUpperCase() };
    }
    if (t.length === 1) {
      const upper = t.toUpperCase();
      return { key: upper, code: `Key${upper}`, text: t };
    }
    return { key: token };
  }

  static async dispatchSimpleKey(tabId: number, token: string) {
    const def = this.resolveKeyDef(token);
    if (def.text && def.text.length === 1) {
      await this.insertText(tabId, def.text);
      return;
    }
    await this.send(tabId, 'Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: def.key,
      code: def.code,
    });
    await this.send(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: def.key,
      code: def.code,
    });
  }

  static async dispatchKeyChord(tabId: number, chord: string) {
    const parts = chord.split('+');
    const modifiers: string[] = [];
    let keyToken = '';
    for (const pRaw of parts) {
      const p = pRaw.trim().toLowerCase();
      if (
        ['ctrl', 'control', 'alt', 'shift', 'cmd', 'meta', 'command', 'win', 'windows'].includes(p)
      )
        modifiers.push(p);
      else keyToken = pRaw.trim();
    }
    const mask = this.modifierMask(modifiers);
    const def = this.resolveKeyDef(keyToken);
    await this.send(tabId, 'Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: def.key,
      code: def.code,
      text: def.text,
      modifiers: mask,
    });
    await this.send(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: def.key,
      code: def.code,
      modifiers: mask,
    });
  }
}
