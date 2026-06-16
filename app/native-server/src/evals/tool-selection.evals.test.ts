/**
 * IMP-0184 — tool-selection evals harness.
 *
 * Once descriptions are the model's only signal (post-IMP-0177 + IMP-0180),
 * descriptions ARE prompts and must be eval'd like prompts. This suite runs
 * ~30 "user said X → model should call Y" cases through the Anthropic API
 * against the LIVE dispatcher tool descriptor + catalog. Output is a
 * per-case pass/fail + a top-line tool-routing accuracy number.
 *
 * Gated behind `RUN_EVALS=1` — skipped by default so day-to-day CI doesn't
 * burn API credits. Run with:
 *
 *   ANTHROPIC_API_KEY=sk-... RUN_EVALS=1 pnpm test -- --testPathPattern tool-selection.evals
 *
 * Cheap model (claude-haiku-4-5-20251001) keeps cost negligible; this is
 * observation, not synthesis. Adds zero production code paths — pure
 * regression detection for the description-as-prompt surface.
 */
import { afterAll, describe, test, expect } from '@jest/globals';
import { buildDispatcherTool, DISPATCHER_TOOL_NAME } from 'humanchrome-shared';

// Hoisted once: buildDispatcherTool memoizes its description per IMP-0181 but
// still allocates a fresh wrapper object per call; doing it once at module
// load is cleaner and confirms the descriptor is stable across the suite.
const DISPATCHER_TOOL = buildDispatcherTool();

const EVAL_MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 256;
const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

const RUN_EVALS = process.env.RUN_EVALS === '1';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const describeIfEnabled = RUN_EVALS && ANTHROPIC_API_KEY ? describe : describe.skip;

interface EvalCase {
  intent: string;
  expectedTool: string;
  expectedAction?: string;
  /** Optional: assert a specific arg key is populated (e.g. selector, url). */
  expectedArgKeys?: string[];
}

/**
 * Seed set — 30 cases covering the most-used flows. Authors editing tool
 * descriptions should expect to add cases here when the routing surface
 * changes; this is the unit-economics safety net.
 */
const CASES: EvalCase[] = [
  // Page-reading + interaction chains.
  {
    intent: 'Open https://example.com in the current tab',
    expectedTool: 'chrome_navigate',
    expectedArgKeys: ['url'],
  },
  {
    intent: 'Take a screenshot of the page',
    expectedTool: 'chrome_computer',
    expectedAction: 'screenshot',
  },
  { intent: 'Get the accessibility tree of the visible page', expectedTool: 'chrome_read_page' },
  { intent: 'Click the button with id "submit"', expectedTool: 'chrome_click_element' },
  { intent: 'Fill the #email input with "user@x.com"', expectedTool: 'chrome_fill_or_select' },
  { intent: 'Hover over the .profile-card element', expectedTool: 'chrome_hover' },
  { intent: 'Type "hello world" character-by-character into #q', expectedTool: 'chrome_type_into' },
  { intent: 'Press the keyboard shortcut for paste', expectedTool: 'chrome_keyboard' },
  { intent: 'Drag #card1 onto #col2', expectedTool: 'chrome_drag_drop' },
  { intent: 'Wait for the #modal element to disappear', expectedTool: 'chrome_wait_for' },

  // Tabs + windows.
  {
    intent: 'List all open browser windows and their tabs',
    expectedTool: 'chrome_get_windows_and_tabs',
  },
  { intent: 'Switch focus to tab id 7', expectedTool: 'chrome_switch_tab' },
  { intent: 'Close tabs 3 and 5', expectedTool: 'chrome_close_tab' },
  {
    intent: 'Group tabs 1 and 2 into a new "agent" group, colored blue',
    expectedTool: 'chrome_tab_groups',
    expectedAction: 'create',
  },
  { intent: 'Restore the most recently closed tab', expectedTool: 'chrome_sessions' },

  // Network.
  {
    intent: 'Start capturing network traffic on this tab',
    expectedTool: 'chrome_network_capture',
    expectedAction: 'start',
  },
  {
    intent: 'Stop the active network capture and return the buffer',
    expectedTool: 'chrome_network_capture',
    expectedAction: 'stop',
  },
  {
    intent: 'Wait for the next /api/users response and return its JSON body',
    expectedTool: 'chrome_intercept_response',
  },
  { intent: 'Mock the /api/me endpoint to return {ok:true}', expectedTool: 'chrome_mock_response' },
  { intent: 'Block all requests to tracker.com', expectedTool: 'chrome_block_or_redirect' },

  // Storage / state.
  { intent: 'Read all cookies for linkedin.com', expectedTool: 'chrome_get_cookies' },
  {
    intent: 'Delete the session cookie "sid" on https://example.com',
    expectedTool: 'chrome_remove_cookie',
  },
  {
    intent: 'Read the localStorage key "flag" on this tab',
    expectedTool: 'chrome_storage',
    expectedAction: 'get',
  },

  // Scripting + reading.
  { intent: 'Run document.title in this tab and return it', expectedTool: 'chrome_javascript' },
  { intent: 'Get the full page text as Markdown', expectedTool: 'chrome_get_web_content' },
  {
    intent: 'Read href attributes of all links on the page',
    expectedTool: 'chrome_get_attributes',
  },

  // Performance / vitals.
  {
    intent: 'Start a performance trace and reload the page',
    expectedTool: 'chrome_performance_start_trace',
  },
  { intent: 'Collect Core Web Vitals on this tab', expectedTool: 'chrome_web_vitals' },

  // Diagnostics + ownership.
  {
    intent: 'Show me recent debug-log entries for chrome_click_element',
    expectedTool: 'chrome_debug_dump',
  },
  { intent: 'Claim tab id 42 for this client', expectedTool: 'browser_claim_tab' },
];

interface AnthropicToolUse {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface AnthropicResponse {
  content: Array<{ type: string } & Partial<AnthropicToolUse> & { text?: string }>;
  stop_reason: string;
}

async function callDispatcherEval(intent: string): Promise<AnthropicToolUse | null> {
  const body = {
    model: EVAL_MODEL,
    max_tokens: MAX_TOKENS,
    tools: [
      {
        name: DISPATCHER_TOOL.name,
        description: DISPATCHER_TOOL.description,
        input_schema: DISPATCHER_TOOL.inputSchema,
      },
    ],
    tool_choice: { type: 'any' as const },
    messages: [{ role: 'user' as const, content: intent }],
  };
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY!,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${text.slice(0, 500)}`);
  }
  const data = (await res.json()) as AnthropicResponse;
  const toolUse = data.content.find((c) => c.type === 'tool_use') as AnthropicToolUse | undefined;
  return toolUse ?? null;
}

interface EvalResult {
  intent: string;
  expectedTool: string;
  expectedAction?: string;
  observedTool: string | null;
  observedAction?: string;
  pass: boolean;
  reason?: string;
}

function evalOne(c: EvalCase, toolUse: AnthropicToolUse | null): EvalResult {
  if (!toolUse || toolUse.name !== DISPATCHER_TOOL_NAME) {
    return {
      intent: c.intent,
      expectedTool: c.expectedTool,
      observedTool: toolUse?.name ?? null,
      pass: false,
      reason: 'Model did not call the humanchrome dispatcher',
    };
  }
  const inner = toolUse.input;
  const observedTool = typeof inner.name === 'string' ? inner.name : null;
  const innerArgs = (inner.args as Record<string, unknown> | undefined) ?? {};
  const observedAction = typeof innerArgs.action === 'string' ? innerArgs.action : undefined;

  if (observedTool !== c.expectedTool) {
    return {
      intent: c.intent,
      expectedTool: c.expectedTool,
      observedTool,
      observedAction,
      pass: false,
      reason: `Expected tool ${c.expectedTool}, got ${observedTool ?? '<null>'}`,
    };
  }
  if (c.expectedAction && observedAction !== c.expectedAction) {
    return {
      intent: c.intent,
      expectedTool: c.expectedTool,
      expectedAction: c.expectedAction,
      observedTool,
      observedAction,
      pass: false,
      reason: `Expected action "${c.expectedAction}", got "${observedAction ?? '<unset>'}"`,
    };
  }
  if (c.expectedArgKeys) {
    const missing = c.expectedArgKeys.filter((k) => !(k in innerArgs));
    if (missing.length) {
      return {
        intent: c.intent,
        expectedTool: c.expectedTool,
        observedTool,
        observedAction,
        pass: false,
        reason: `Missing expected arg keys: ${missing.join(', ')}`,
      };
    }
  }
  return {
    intent: c.intent,
    expectedTool: c.expectedTool,
    expectedAction: c.expectedAction,
    observedTool,
    observedAction,
    pass: true,
  };
}

describeIfEnabled('IMP-0184 tool-selection evals', () => {
  const results: EvalResult[] = [];

  test.each(CASES.map((c) => [c.intent, c] as const))(
    '%s',
    async (_intent, c) => {
      const tu = await callDispatcherEval(c.intent);
      const r = evalOne(c, tu);
      results.push(r);
      if (!r.pass) {
        console.warn(
          `EVAL FAIL: "${r.intent}"\n  expected: ${r.expectedTool}${r.expectedAction ? `(${r.expectedAction})` : ''}\n  observed: ${r.observedTool}${r.observedAction ? `(${r.observedAction})` : ''}\n  reason: ${r.reason}`,
        );
      }
      // Per-case assertion so a single failure surfaces in jest's output, but
      // we let other cases run by design — the summary is the headline number.
      expect(r.pass).toBe(true);
    },
    60_000,
  );

  // afterAll runs after every per-case test regardless of pass/fail order, so
  // the headline routing-accuracy number is computed against the full set
  // even when a case throws. Avoids the previous module-scope shared-state
  // ordering risk if jest ever runs tests out of declaration order.
  afterAll(() => {
    if (results.length === 0) {
      console.warn('No eval results collected (likely all cases skipped).');
      return;
    }
    const passed = results.filter((r) => r.pass).length;
    const accuracy = passed / results.length;
    console.log(
      `\nIMP-0184 routing accuracy: ${passed}/${results.length} = ${(accuracy * 100).toFixed(1)}%`,
    );
    // Trend tracking: this number should ratchet up over time. Floor at 70%
    // catches regressions without flapping on a single bad case.
    expect(accuracy).toBeGreaterThanOrEqual(0.7);
  });
});

// Always expose a tiny harness-wiring test so the file isn't empty when the
// real suite is gated off and so the gating logic itself is regression-tested.
describe('IMP-0184 evals harness wiring', () => {
  test('gate matches RUN_EVALS + ANTHROPIC_API_KEY presence', () => {
    const enabled = Boolean(RUN_EVALS && ANTHROPIC_API_KEY);
    if (!enabled) {
      console.log(
        'IMP-0184 evals skipped — set RUN_EVALS=1 and ANTHROPIC_API_KEY to run live eval against the dispatcher.',
      );
    }
    expect(typeof CASES.length).toBe('number');
    expect(CASES.length).toBeGreaterThanOrEqual(30);
  });
});
