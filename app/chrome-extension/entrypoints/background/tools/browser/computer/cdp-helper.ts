/**
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

  private static MODIFIER_MASK: Record<string, number> = {
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

  static modifierMask(mods: string[]): number {
    let mask = 0;
    for (const m of mods) mask |= this.MODIFIER_MASK[m] || 0;
    return mask;
  }

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
    await this.dispatchKeyDownUp(tabId, def);
  }

  static async dispatchKeyChord(tabId: number, chord: string) {
    const modifiers: string[] = [];
    let keyToken = '';
    for (const pRaw of chord.split('+')) {
      const p = pRaw.trim().toLowerCase();
      if (this.MODIFIER_MASK[p] !== undefined) modifiers.push(p);
      else keyToken = pRaw.trim();
    }
    await this.dispatchKeyDownUp(tabId, this.resolveKeyDef(keyToken), this.modifierMask(modifiers));
  }

  private static async dispatchKeyDownUp(
    tabId: number,
    def: { key: string; code?: string; text?: string },
    modifiers?: number,
  ) {
    const base: any = { key: def.key, code: def.code };
    if (modifiers !== undefined) base.modifiers = modifiers;
    if (def.text !== undefined && modifiers !== undefined) base.text = def.text;
    await this.send(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'rawKeyDown' });
    const up = { ...base };
    delete up.text;
    await this.send(tabId, 'Input.dispatchKeyEvent', { ...up, type: 'keyUp' });
  }
}
