/**
 * chrome_paste tests.
 *
 * Focus + (optional clipboard seed via offscreen) + synthetic ClipboardEvent
 * + execCommand fallback. Tests stub chrome.scripting.executeScript and the
 * offscreen sendMessage path; they don't try to exercise the in-page shim.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/offscreen-manager', () => ({
  offscreenManager: {
    ensureOffscreenDocument: vi.fn().mockResolvedValue(undefined),
  },
}));

import { pasteTool } from '@/entrypoints/background/tools/browser/paste';
import { offscreenManager } from '@/utils/offscreen-manager';
import { runWithContext } from '@/entrypoints/background/utils/request-context';
import {
  _resetClientStateForTests,
  claimTabForClient,
} from '@/entrypoints/background/utils/client-state';

const TEST_CLIENT = 'paste-test-client';

function exec(args: any): Promise<any> {
  return runWithContext({ clientId: TEST_CLIENT }, () => pasteTool.execute(args));
}

let executeScriptMock: ReturnType<typeof vi.fn>;
let tabsGetMock: ReturnType<typeof vi.fn>;
let sendMessageMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  _resetClientStateForTests();
  executeScriptMock = vi.fn().mockResolvedValue([
    {
      result: {
        ok: true,
        focused: true,
        resolution: 'selector',
        tagName: 'input',
        pasted: true,
        mode: 'event',
        textInserted: 5,
      },
    },
  ]);
  tabsGetMock = vi.fn(async (id: number) => ({ id, url: 'https://example.com', windowId: 1 }));
  sendMessageMock = vi.fn().mockResolvedValue({ success: true });

  (globalThis.chrome as any).scripting = { executeScript: executeScriptMock };
  (globalThis.chrome as any).tabs = {
    ...(globalThis.chrome as any).tabs,
    get: tabsGetMock,
  };
  (globalThis.chrome as any).runtime = {
    ...(globalThis.chrome as any).runtime,
    sendMessage: sendMessageMock,
  };
  (offscreenManager.ensureOffscreenDocument as any).mockClear();
  (offscreenManager.ensureOffscreenDocument as any).mockResolvedValue(undefined);
});

afterEach(() => {
  _resetClientStateForTests();
});

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

describe('chrome_paste', () => {
  it('rejects when neither selector nor ref is supplied', async () => {
    const res = await exec({});
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('selector|ref');
  });

  it('rejects when both selector and ref are supplied', async () => {
    const res = await exec({ selector: 'input', ref: 'r1' });
    expect(res.isError).toBe(true);
  });

  it('without text, does NOT call the offscreen clipboard.write', async () => {
    await exec({ tabId: 7, selector: 'input' });
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(offscreenManager.ensureOffscreenDocument).not.toHaveBeenCalled();
  });

  it('with text, seeds the clipboard via the offscreen doc before paste', async () => {
    await exec({ tabId: 7, selector: 'input', text: 'hello' });
    expect(offscreenManager.ensureOffscreenDocument).toHaveBeenCalled();
    expect(sendMessageMock).toHaveBeenCalledWith({
      target: 'offscreen',
      type: 'clipboard.write',
      text: 'hello',
    });
  });

  it('forwards selector + text via the shim args', async () => {
    await exec({ tabId: 7, selector: '#email', text: 'hi' });
    expect(executeScriptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 7 },
        world: 'ISOLATED',
        args: ['#email', null, 'hi'],
      }),
    );
  });

  it('forwards ref via the shim args', async () => {
    await exec({ tabId: 7, ref: 'r-99', text: 'x' });
    expect(executeScriptMock).toHaveBeenCalledWith(
      expect.objectContaining({ args: [null, 'r-99', 'x'] }),
    );
  });

  it('falls back to the client-owned tab when no tabId is provided', async () => {
    claimTabForClient(TEST_CLIENT, 7, 1);
    await exec({ selector: 'input' });
    expect(executeScriptMock).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 7 } }),
    );
  });

  it('forwards frameId when supplied', async () => {
    await exec({ tabId: 7, selector: 'input', frameId: 11 });
    expect(executeScriptMock).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 7, frameIds: [11] } }),
    );
  });

  it('reports mode and pasted from the shim result', async () => {
    executeScriptMock.mockResolvedValueOnce([
      {
        result: {
          ok: true,
          focused: true,
          resolution: 'selector',
          tagName: 'input',
          pasted: true,
          mode: 'event',
          textInserted: 1,
        },
      },
    ]);
    const body = parseBody(await exec({ tabId: 7, selector: 'input', text: 'x' }));
    expect(body.mode).toBe('event');
    expect(body.pasted).toBe(true);
    expect(body.textInserted).toBe(1);
  });

  it('forwards textInserted and mode:"none" from the shim (silent-success fixed per IMP-0134)', async () => {
    // Shim now reports a real "no text was inserted" outcome instead of
    // pasted:true,mode:event silent-success. The bridge response carries
    // this faithfully so callers can react.
    executeScriptMock.mockResolvedValueOnce([
      {
        result: {
          ok: true,
          focused: true,
          resolution: 'selector',
          tagName: 'input',
          pasted: false,
          mode: 'none',
          textInserted: 0,
        },
      },
    ]);
    const body = parseBody(
      await exec({ tabId: 7, selector: 'input[readonly]', text: 'hello' }),
    );
    expect(body.pasted).toBe(false);
    expect(body.mode).toBe('none');
    expect(body.textInserted).toBe(0);
  });

  it('surfaces a shim ok:false (selector matched no element)', async () => {
    executeScriptMock.mockResolvedValueOnce([
      { result: { ok: false, message: 'selector "#nope" matched no element' } },
    ]);
    const res = await exec({ tabId: 7, selector: '#nope', text: 'x' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('matched no element');
  });

  it('degrades clipboard-seed failure to a warning and still runs the shim', async () => {
    // Seed fails (NotAllowedError is what offscreen returns when document
    // focus can't be synthesized in background mode). The tool must NOT
    // hard-fail — the shim accepts text directly via DataTransfer +
    // execCommand without needing the OS clipboard. Surface the seed
    // failure as `clipboardSeedWarning` on success so callers can tell.
    sendMessageMock.mockResolvedValueOnce({ success: false, error: 'NotAllowedError' });
    executeScriptMock.mockResolvedValueOnce([
      {
        result: {
          ok: true,
          resolution: { type: 'selector', selector: 'input', frame: 'main' },
          focused: true,
          pasted: true,
          tagName: 'INPUT',
          mode: 'event',
          textInserted: 1,
        },
      },
    ]);
    const body = parseBody(await exec({ tabId: 7, selector: 'input', text: 'x' }));
    expect(body.ok).toBe(true);
    expect(body.pasted).toBe(true);
    expect(body.clipboardSeedWarning).toContain('NotAllowedError');
    expect(executeScriptMock).toHaveBeenCalled();
  });

  it('classifies "no tab with id" as TAB_CLOSED', async () => {
    executeScriptMock.mockRejectedValueOnce(new Error('No tab with id: 99'));
    const res = await exec({ tabId: 99, selector: 'input' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('TAB_CLOSED');
  });

  it('returns TAB_NOT_FOUND when there is no owned tab', async () => {
    const res = await exec({ selector: 'input' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('TAB_NOT_FOUND');
  });

  it('returns an error when the shim returns no result', async () => {
    executeScriptMock.mockResolvedValueOnce([]);
    const res = await exec({ tabId: 7, selector: 'input' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('no result');
  });
});

/**
 * In-shim tests — IMP-0134 silent-success regression coverage.
 *
 * Direct invocation of the page-side shim against a jsdom DOM. The shim
 * normally runs inside `chrome.scripting.executeScript`; we expose it via
 * `_pasteShimForTest` so we can verify the textBefore/textAfter derivation
 * against real elements (the only way to catch the readonly-input +
 * paste-listener silent-success class).
 *
 * jsdom is missing ClipboardEvent, DataTransfer, and execCommand — we
 * polyfill them per-test to model the specific browser behavior under
 * test (event listener inserts vs. doesn't, execCommand inserts vs.
 * returns true-but-noop on readonly).
 */
import { _pasteShimForTest } from '@/entrypoints/background/tools/browser/paste';

interface PolyfillConfig {
  /**
   * Optional handler called when the synthetic ClipboardEvent is dispatched.
   * Receives (target, text). Return value ignored — handler mutates target
   * to simulate a real page's paste listener.
   */
  onPaste?: (target: HTMLElement, text: string) => void;
  /**
   * Whether execCommand('insertText', ...) should actually mutate the
   * focused element. Default: true (append text to input.value or
   * contenteditable's textContent). Set false to simulate readonly /
   * contenteditable=false where execCommand returns true but writes nothing.
   */
  execCommandInserts?: boolean;
  /** Force execCommand to return false (and not insert). */
  execCommandReturnsFalse?: boolean;
}

function installShimPolyfills(cfg: PolyfillConfig = {}): () => void {
  const originals: Record<string, unknown> = {};

  // DataTransfer polyfill — minimum surface used by the shim: setData /
  // getData. Internally backed by a plain object.
  const fakeDT = class {
    private store = new Map<string, string>();
    setData(type: string, data: string) {
      this.store.set(type, data);
    }
    getData(type: string) {
      return this.store.get(type) ?? '';
    }
  };
  originals.DataTransfer = (globalThis as any).DataTransfer;
  (globalThis as any).DataTransfer = fakeDT;

  // ClipboardEvent polyfill — extends Event so dispatchEvent works. Carries
  // clipboardData reference.
  const fakeCE = class extends Event {
    clipboardData: any;
    constructor(type: string, init: any = {}) {
      super(type, init);
      this.clipboardData = init.clipboardData ?? null;
    }
  };
  originals.ClipboardEvent = (globalThis as any).ClipboardEvent;
  (globalThis as any).ClipboardEvent = fakeCE;

  // execCommand polyfill — when execCommandInserts is true (default), append
  // the text to input.value or contenteditable's textContent (whichever the
  // focused element supports). When execCommandReturnsFalse is set, return
  // false without writing.
  originals.execCommand = (document as any).execCommand;
  (document as any).execCommand = (cmd: string, _ui: boolean, value: string): boolean => {
    if (cmd !== 'insertText') return false;
    if (cfg.execCommandReturnsFalse) return false;
    const active = document.activeElement as HTMLElement | null;
    if (!active) return true;
    if (cfg.execCommandInserts === false) return true; // claim success without writing
    // Default-insert path. If contenteditable mock layered on it: append to textContent.
    if ((active as any).__isContentEditable) {
      const cur = active.textContent ?? '';
      active.textContent = cur + value;
      return true;
    }
    // input/textarea-style:
    if ('value' in active) {
      const cur = String((active as any).value ?? '');
      (active as any).value = cur + value;
      return true;
    }
    return true;
  };

  // Page-listener hook for ClipboardEvent dispatch — install on document so
  // any focused target inherits via bubble. Listener runs `cfg.onPaste`
  // against the actual target.
  let listener: ((ev: Event) => void) | null = null;
  if (cfg.onPaste) {
    const onPaste = cfg.onPaste;
    listener = (ev: Event) => {
      const target = ev.target as HTMLElement | null;
      if (!target) return;
      const text = (ev as any).clipboardData?.getData('text/plain') ?? '';
      onPaste(target, text);
    };
    document.addEventListener('paste', listener);
  }

  return () => {
    (globalThis as any).DataTransfer = originals.DataTransfer;
    (globalThis as any).ClipboardEvent = originals.ClipboardEvent;
    (document as any).execCommand = originals.execCommand;
    if (listener) document.removeEventListener('paste', listener);
    // Clear DOM between tests.
    document.body.innerHTML = '';
  };
}

/**
 * Stamp contenteditable-shaped behavior onto a plain div for jsdom.
 * Real Chrome uses isContentEditable to switch the readText() branch; we
 * mimic by patching both isContentEditable (getter) and innerText (getter
 * mirrored to textContent).
 */
function makeContentEditable(div: HTMLElement, editable = true): void {
  Object.defineProperty(div, 'isContentEditable', { value: editable, configurable: true });
  Object.defineProperty(div, 'innerText', {
    get: () => div.textContent ?? '',
    set: (v) => {
      div.textContent = v;
    },
    configurable: true,
  });
  (div as any).__isContentEditable = editable; // hint for execCommand polyfill
  if (editable) div.setAttribute('contenteditable', 'true');
  else div.setAttribute('contenteditable', 'false');
}

describe('chrome_paste shim (IMP-0134 — text-actually-inserted derivation)', () => {
  let cleanup: () => void = () => {};
  afterEach(() => cleanup());

  function mountInput(id: string, attrs: Record<string, string> = {}): HTMLInputElement {
    const inp = document.createElement('input');
    inp.id = id;
    for (const [k, v] of Object.entries(attrs)) inp.setAttribute(k, v);
    document.body.appendChild(inp);
    return inp;
  }

  it('happy path: input + execCommand insert → pasted:true, mode:execCommand, textInserted=5', () => {
    cleanup = installShimPolyfills(); // execCommand inserts by default; no listener
    const inp = mountInput('happy');

    const res = _pasteShimForTest('#happy', null, 'hello');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.pasted).toBe(true);
    expect(res.mode).toBe('execCommand');
    expect(res.textInserted).toBe(5);
    expect(inp.value).toBe('hello');
  });

  it('happy path: paste listener inserts text → pasted:true, mode:event, no execCommand double-insert', () => {
    cleanup = installShimPolyfills({
      onPaste: (target, text) => {
        // Simulate a rich editor that consumes the paste event and writes
        // text via its own logic (LinkedIn React composer style).
        if ('value' in target) {
          (target as HTMLInputElement).value = String((target as any).value ?? '') + text;
        }
      },
    });
    const inp = mountInput('rich');

    const res = _pasteShimForTest('#rich', null, 'hi');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.pasted).toBe(true);
    expect(res.mode).toBe('event');
    expect(res.textInserted).toBe(2);
    // Critical: execCommand path was skipped — text inserted exactly once.
    expect(inp.value).toBe('hi');
  });

  it('IMP-0134 readonly input: paste listener fires but no text inserted → pasted:false, mode:none', () => {
    // The canonical IMP-0134 repro: page has a paste listener that runs
    // (for telemetry/logging) but doesn't write text. The element is
    // readonly, so execCommand returns true but cannot insert. Previously
    // the tool reported pasted:true,mode:event — now correctly false.
    cleanup = installShimPolyfills({
      onPaste: (_target, _text) => {
        // Listener consumes the event but inserts nothing.
        // (No body — just being present is the bug surface.)
      },
      execCommandInserts: false, // readonly: execCommand claims success, no write
    });
    const inp = mountInput('ro', { readonly: 'readonly' });

    const res = _pasteShimForTest('#ro', null, 'hello');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.pasted).toBe(false);
    expect(res.mode).toBe('none');
    expect(res.textInserted).toBe(0);
    expect(inp.value).toBe('');
  });

  it('IMP-0134 contenteditable=false: paste rejects in both paths → pasted:false, mode:none', () => {
    cleanup = installShimPolyfills({
      onPaste: () => {
        /* listener runs, can't write to non-editable target */
      },
      execCommandInserts: false,
    });
    const div = document.createElement('div');
    div.id = 'rich-ro';
    document.body.appendChild(div);
    makeContentEditable(div, false);

    const res = _pasteShimForTest('#rich-ro', null, 'hello');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.pasted).toBe(false);
    expect(res.mode).toBe('none');
    expect(res.textInserted).toBe(0);
    expect(div.textContent).toBe('');
  });

  it('contenteditable=true: execCommand insert path → pasted:true, mode:execCommand', () => {
    cleanup = installShimPolyfills(); // execCommand inserts via textContent for CE
    const div = document.createElement('div');
    div.id = 'ce';
    document.body.appendChild(div);
    makeContentEditable(div, true);

    const res = _pasteShimForTest('#ce', null, 'hello');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.pasted).toBe(true);
    expect(res.mode).toBe('execCommand');
    expect(res.textInserted).toBe(5);
    expect(div.textContent).toBe('hello');
  });

  it('IMP-0134 partial insert: listener inserted only "hello" of "hello world" → textInserted=5, mode:event', () => {
    // A page's listener inserts a sanitized prefix (e.g. truncated to a
    // max-length). The shim reports the ACTUAL inserted count so callers
    // can detect partial inserts.
    cleanup = installShimPolyfills({
      onPaste: (target, _text) => {
        if ('value' in target) {
          (target as HTMLInputElement).value = 'hello'; // ignores requested text
        }
      },
    });
    mountInput('partial');

    const res = _pasteShimForTest('#partial', null, 'hello world');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.pasted).toBe(true);
    expect(res.mode).toBe('event');
    expect(res.textInserted).toBe(5);
    expect(res.textInserted).toBeLessThan('hello world'.length);
  });

  it('clipboard-only path (text=null): pasted derives from focused — preserved behavior', () => {
    cleanup = installShimPolyfills();
    mountInput('clip');

    const res = _pasteShimForTest('#clip', null, null);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.focused).toBe(true);
    expect(res.pasted).toBe(true); // derives from focus
    expect(res.mode).toBe('none'); // no insertion path ran
    expect(res.textInserted).toBe(0);
  });

  it('IMP-0134 execCommand returns false: no text written → pasted:false, mode:none', () => {
    // Some browsers return false from execCommand when the focus context
    // doesn't accept the command. Without the diff-check, the prior
    // implementation already handled this — but now we ALSO catch the
    // case where execCommand returns true but writes nothing (above
    // tests). This belt-and-braces test confirms the diff path stays
    // consistent.
    cleanup = installShimPolyfills({ execCommandReturnsFalse: true });
    const inp = mountInput('nope');

    const res = _pasteShimForTest('#nope', null, 'hello');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.pasted).toBe(false);
    expect(res.mode).toBe('none');
    expect(res.textInserted).toBe(0);
    expect(inp.value).toBe('');
  });

  it('mode:event takes precedence over execCommand (no double-insert)', () => {
    // Cover the explicit guard: even if execCommand WOULD insert, the
    // shim skips that path when the event-listener already wrote text.
    cleanup = installShimPolyfills({
      onPaste: (target, text) => {
        if ('value' in target) {
          (target as HTMLInputElement).value = String((target as any).value ?? '') + text;
        }
      },
      // execCommandInserts left at default (true) — would double-write if reached.
    });
    const inp = mountInput('noddi');

    const res = _pasteShimForTest('#noddi', null, 'X');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.mode).toBe('event');
    expect(res.textInserted).toBe(1);
    expect(inp.value).toBe('X'); // not 'XX'
  });
});
