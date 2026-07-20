// Task-level scenarios for humanchrome. Each scenario represents a
// realistic outcome an LLM driving the MCP would need to achieve.
//
// Two runners consume this catalog:
//   - scripts/run-task-scenarios.mjs  (tier-2 — runs `steps` deterministically)
//   - scripts/run-agent-scenarios.mjs (tier-3 — hands `agentTask` to a Claude
//                                      subagent and scores against `predicate`)
//
// Schema per scenario:
//   id            string  — kebab-case unique id
//   failureClass  one of  'search' | 'interaction' | 'navigation' | 'tool-choice'
//   live          bool    — true → only runs with --live (real network)
//   target        { kind: 'fixture' | 'live', url, fixturePath? }
//   description   string  — human-readable goal
//   agentTask     string  — natural-language brief for tier-3
//   steps         async ({ call, log }) => any  — runs scripted tools; returns
//                                                 the "answer" we score on
//   predicate     (answer) => { ok, reason }    — checks the answer

const FIXTURE_BASE = 'http://127.0.0.1:4173';

// chrome_javascript returns the evaluated value either as a primitive
// or as a JSON-stringified blob inside `parsed.result`. Unwrap both.
function jsResult(res) {
  let v = res?.parsed?.result ?? res?.parsed;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      // Only treat as structured if it's not just a quoted string round-trip.
      if (typeof parsed !== 'string') return parsed;
      return parsed;
    } catch {
      return v;
    }
  }
  return v;
}

export const scenarios = [
  // ── SEARCH ────────────────────────────────────────────────────────────
  {
    id: 'search-fixture-launch-code',
    failureClass: 'search',
    live: false,
    target: { kind: 'fixture', url: `${FIXTURE_BASE}/task-scenarios.html#s-search` },
    description: 'Extract the launch code from a deeply nested DOM section.',
    agentTask:
      'Open the page and tell me the exact launch code mentioned in the Search section. Return only the digits.',
    async steps({ call }) {
      const read = await call('chrome_read_page', { textContent: true });
      const text = read?.parsed?.text || read?.parsed?.content || JSON.stringify(read?.parsed ?? '');
      const m = text.match(/launch code is (\d+)/i);
      return { code: m?.[1] ?? null, raw: text.slice(0, 200) };
    },
    predicate: (a) => ({
      ok: a.code === '4815162342',
      reason: a.code ? `got ${a.code}` : `no match in text: ${a.raw}`,
    }),
  },
  {
    id: 'search-fixture-pricing-tiers',
    failureClass: 'search',
    live: false,
    target: { kind: 'fixture', url: `${FIXTURE_BASE}/task-scenarios.html#s-search` },
    description: 'Pull structured pricing tiers via aria snapshot or DOM query.',
    agentTask: 'List every plan tier and price from the Search section as JSON.',
    async steps({ call }) {
      const res = await call('chrome_javascript', {
        code: `[...document.querySelectorAll('[data-tier]')].map(el => ({ tier: el.dataset.tier, price: el.textContent.trim() }))`,
      });
      return { tiers: jsResult(res) };
    },
    predicate: (a) => {
      const arr = a.tiers;
      const ok =
        Array.isArray(arr) &&
        arr.length === 3 &&
        arr.some((t) => t.tier === 'basic' && /\$9/.test(t.price)) &&
        arr.some((t) => t.tier === 'pro' && /\$29/.test(t.price));
      return { ok, reason: ok ? 'all three tiers' : `got ${JSON.stringify(arr).slice(0, 160)}` };
    },
  },
  {
    id: 'search-live-example-com',
    failureClass: 'search',
    live: true,
    target: { kind: 'live', url: 'https://example.com' },
    description: 'Pull the H1 from example.com — smallest possible live smoke.',
    agentTask: 'What is the H1 of https://example.com? Return the exact text.',
    async steps({ call }) {
      const res = await call('chrome_javascript', { code: `document.querySelector('h1')?.textContent` });
      return { h1: String(jsResult(res) ?? '').trim() };
    },
    predicate: (a) => ({
      ok: a.h1 === 'Example Domain',
      reason: `got ${JSON.stringify(a.h1)}`,
    }),
  },

  // ── INTERACTION ───────────────────────────────────────────────────────
  {
    id: 'interaction-fixture-form-submit',
    failureClass: 'interaction',
    live: false,
    target: { kind: 'fixture', url: `${FIXTURE_BASE}/task-scenarios.html#s-interaction` },
    description: 'Fill the signup form, pick a plan, submit, verify result.',
    agentTask:
      'Sign up on the form in the Interaction section using email "user@test.dev" and the Pro plan, then read back the submission confirmation text.',
    async steps({ call }) {
      await call('chrome_fill_or_select', { selector: '#signup-email', value: 'user@test.dev' });
      await call('chrome_fill_or_select', { selector: '#signup-plan', value: 'pro' });
      await call('chrome_click_element', { selector: '#signup-submit' });
      const out = await call('chrome_javascript', {
        code: `document.getElementById('signup-result').textContent`,
      });
      return { result: String(jsResult(out) ?? '') };
    },
    predicate: (a) => ({
      ok: a.result === 'submitted:user@test.dev:pro',
      reason: `got ${JSON.stringify(a.result)}`,
    }),
  },
  {
    id: 'interaction-fixture-counter-clicks',
    failureClass: 'interaction',
    live: false,
    target: { kind: 'fixture', url: `${FIXTURE_BASE}/task-scenarios.html#s-interaction` },
    description: 'Three clicks should land three counter increments — proves click delivers real events.',
    agentTask:
      'Click the "Increment" button three times and then tell me the final counter value shown next to it.',
    async steps({ call }) {
      // Reset counter state — fragment-only navigates don't reload the page.
      await call('chrome_javascript', {
        code: `(() => { const b = document.getElementById('counter-btn'); b.dataset.count = '0'; document.getElementById('counter-out').textContent = 'clicks=0'; return 'reset'; })()`,
      });
      await call('chrome_click_element', { selector: '#counter-btn' });
      await call('chrome_click_element', { selector: '#counter-btn' });
      await call('chrome_click_element', { selector: '#counter-btn' });
      const out = await call('chrome_javascript', {
        code: `document.getElementById('counter-out').textContent`,
      });
      return { value: String(jsResult(out) ?? '') };
    },
    predicate: (a) => ({
      ok: a.value === 'clicks=3',
      reason: `got ${JSON.stringify(a.value)}`,
    }),
  },

  // ── NAVIGATION ────────────────────────────────────────────────────────
  {
    id: 'navigation-fixture-hash-route',
    failureClass: 'navigation',
    live: false,
    target: { kind: 'fixture', url: `${FIXTURE_BASE}/task-scenarios.html#s-navigation` },
    description: 'Anchor click toggles a hash-routed view that becomes visible.',
    agentTask:
      'Click the "this anchor" link in the Navigation section and then read the token shown at the hop target.',
    async steps({ call }) {
      await call('chrome_click_element', { selector: '#hop-link' });
      await new Promise((r) => setTimeout(r, 300));
      const out = await call('chrome_javascript', {
        code: `document.getElementById('hop-target').hidden ? 'HIDDEN' : document.getElementById('hop-token').textContent`,
      });
      return { token: String(jsResult(out) ?? '').trim() };
    },
    predicate: (a) => ({
      ok: a.token === 'HOP-OK-7321',
      reason: `got ${JSON.stringify(a.token)}`,
    }),
  },
  {
    id: 'navigation-fixture-await-slow',
    failureClass: 'navigation',
    live: false,
    target: { kind: 'fixture', url: `${FIXTURE_BASE}/task-scenarios.html#s-navigation` },
    description: 'await_element should resolve when slow content unhides after 600ms.',
    agentTask:
      'Wait for the slow content in the Navigation section to render and then tell me what it says.',
    async steps({ call }) {
      const wait = await call('chrome_wait_for', {
        kind: 'element',
        selector: '#slow-box',
        state: 'present',
        timeoutMs: 3000,
      });
      const out = await call('chrome_javascript', {
        code: `document.getElementById('slow-box').textContent.trim()`,
      });
      return {
        waited: !wait?.isError,
        text: String(jsResult(out) ?? '').trim(),
      };
    },
    predicate: (a) => ({
      ok: a.waited && a.text === 'Slow content rendered.',
      reason: `waited=${a.waited} text=${JSON.stringify(a.text)}`,
    }),
  },

  // ── TOOL-CHOICE ───────────────────────────────────────────────────────
  {
    id: 'tool-choice-visible-contact',
    failureClass: 'tool-choice',
    live: false,
    target: { kind: 'fixture', url: `${FIXTURE_BASE}/task-scenarios.html#s-tool-choice` },
    description:
      'Page contains a VISIBLE and a HIDDEN email — a good agent should return the visible one only.',
    agentTask:
      'What support email is shown on the page? Return only the email address that is visible to a user.',
    async steps({ call }) {
      // Scripted tier: we directly query the visible one to verify the contract.
      const out = await call('chrome_javascript', {
        code: `(() => { const el = document.getElementById('visible-contact'); const cs = getComputedStyle(el); return cs.display === 'none' || cs.visibility === 'hidden' ? null : el.textContent.trim(); })()`,
      });
      return { email: String(jsResult(out) ?? '').trim() };
    },
    predicate: (a) => ({
      ok: a.email === 'support@example.com',
      reason: `got ${JSON.stringify(a.email)}`,
    }),
  },
  {
    id: 'tool-choice-screenshot-region',
    failureClass: 'tool-choice',
    live: false,
    target: { kind: 'fixture', url: `${FIXTURE_BASE}/task-scenarios.html#s-tool-choice` },
    description:
      'Screenshot of the pricing table — exercises chrome_screenshot with a selector instead of a fullpage capture.',
    agentTask:
      'Take a screenshot of the pricing table in the Tool choice section. Return the size of the resulting image in bytes.',
    async steps({ call }) {
      const shot = await call('chrome_screenshot', { selector: '#pricing' });
      const p = shot?.parsed ?? {};
      return {
        isError: !!shot?.isError,
        success: p?.success === true,
        captured: !!(p?.fileSaved || p?.base64 || p?.dataUrl),
        filename: p?.filename ?? null,
      };
    },
    predicate: (a) => ({
      ok: !a.isError && a.success && a.captured,
      reason: `success=${a.success} captured=${a.captured} file=${a.filename}`,
    }),
  },
];

// ── SHADOW DOM ────────────────────────────────────────────────────────
scenarios.push({
  id: 'shadow-dom-token',
  failureClass: 'shadow-dom',
  live: false,
  target: { kind: 'fixture', url: `${FIXTURE_BASE}/task-scenarios.html#s-shadow` },
  description: 'Extract content from inside an open shadow root.',
  agentTask:
    'In the Shadow DOM section there is a "shadow secret" string. Return only the token portion (e.g. SHA-XXXX-OK).',
  async steps({ call }) {
    const res = await call('chrome_javascript', {
      code: `(() => { const root = document.getElementById('shadow-host').shadowRoot; const m = (root?.querySelector('[data-marker="shadow-target"]')?.textContent || '').match(/SHA-\\d+-OK/); return m && m[0]; })()`,
    });
    return { token: String(jsResult(res) ?? '').trim() };
  },
  predicate: (a) => ({ ok: a.token === 'SHA-9981-OK', reason: `got ${JSON.stringify(a.token)}` }),
});

// ── IFRAME ────────────────────────────────────────────────────────────
scenarios.push({
  id: 'iframe-token',
  failureClass: 'iframe',
  live: false,
  target: { kind: 'fixture', url: `${FIXTURE_BASE}/task-scenarios.html#s-iframe` },
  description: 'Read text from inside a same-origin iframe.',
  agentTask: 'Return the IFR token visible inside the iframe.',
  async steps({ call }) {
    const res = await call('chrome_javascript', {
      code: `(() => { const fr = document.getElementById('inner-frame'); const doc = fr?.contentDocument; const m = (doc?.querySelector('[data-marker="iframe-target"]')?.textContent || '').match(/IFR-\\d+-OK/); return m && m[0]; })()`,
    });
    return { token: String(jsResult(res) ?? '').trim() };
  },
  predicate: (a) => ({ ok: a.token === 'IFR-77-OK', reason: `got ${JSON.stringify(a.token)}` }),
});

// ── DIALOG ────────────────────────────────────────────────────────────
scenarios.push({
  id: 'dialog-accept',
  failureClass: 'dialog',
  live: false,
  target: { kind: 'fixture', url: `${FIXTURE_BASE}/task-scenarios.html#s-dialog` },
  description: 'Accept a native confirm() dialog without freezing the tab.',
  agentTask:
    'In the Dialog section, click the "Trigger confirm" button and accept the dialog. Then return the text shown in the output element.',
  async steps({ call }) {
    // Pre-register an accept policy so the click doesn't block.
    const reg = await call('chrome_handle_dialog', {
      action: 'register_default',
      defaultBehavior: 'accept',
    });
    await call('chrome_click_element', { selector: '#dialog-btn' });
    await new Promise((r) => setTimeout(r, 400));
    const out = await call('chrome_javascript', {
      code: `document.getElementById('dialog-out').textContent`,
    });
    return {
      regOk: !reg?.isError,
      result: String(jsResult(out) ?? '').trim(),
    };
  },
  predicate: (a) => ({
    ok: a.regOk && a.result === 'confirmed',
    reason: `regOk=${a.regOk} result=${JSON.stringify(a.result)}`,
  }),
});

// ── KEYBOARD ──────────────────────────────────────────────────────────
scenarios.push({
  id: 'keyboard-type-and-enter',
  failureClass: 'keyboard',
  live: false,
  target: { kind: 'fixture', url: `${FIXTURE_BASE}/task-scenarios.html#s-keyboard` },
  description: 'Type a phrase into a text input and press Enter.',
  agentTask:
    'Focus the input in the Keyboard section, type "hello world" exactly, press Enter, then return the value shown in the output.',
  async steps({ call }) {
    await call('chrome_fill_or_select', { selector: '#kb-input', value: 'hello world' });
    await call('chrome_keyboard', { keys: 'Enter', selector: '#kb-input' });
    await new Promise((r) => setTimeout(r, 200));
    const out = await call('chrome_javascript', {
      code: `document.getElementById('kb-out').textContent`,
    });
    return { result: String(jsResult(out) ?? '').trim() };
  },
  predicate: (a) => ({
    ok: a.result === 'commit:hello world',
    reason: `got ${JSON.stringify(a.result)}`,
  }),
});

// ── TABLE EXTRACTION ──────────────────────────────────────────────────
scenarios.push({
  id: 'search-table-shipped-orders',
  failureClass: 'search',
  live: false,
  target: { kind: 'fixture', url: `${FIXTURE_BASE}/task-scenarios.html#s-table` },
  description: 'Filter table rows to those with status=shipped.',
  agentTask:
    'From the orders table in the Table extraction section, return the order IDs whose status is "shipped" as a JSON array of strings.',
  async steps({ call }) {
    const res = await call('chrome_javascript', {
      code: `[...document.querySelectorAll('#orders tbody tr')].filter(tr => tr.cells[3].textContent.trim() === 'shipped').map(tr => tr.cells[0].textContent.trim())`,
    });
    return { ids: jsResult(res) };
  },
  predicate: (a) => {
    const ok =
      Array.isArray(a.ids) &&
      a.ids.length === 2 &&
      a.ids.includes('1001') &&
      a.ids.includes('1003');
    return { ok, reason: ok ? 'shipped=[1001,1003]' : `got ${JSON.stringify(a.ids)}` };
  },
});

// ── MULTI-STEP ────────────────────────────────────────────────────────
scenarios.push({
  id: 'multistep-flow-complete',
  failureClass: 'multi-step',
  live: false,
  target: { kind: 'fixture', url: `${FIXTURE_BASE}/task-scenarios.html#s-multistep` },
  description: 'Click Start → read generated code → enter it → submit.',
  agentTask:
    'Complete the multi-step flow in the Multi-step flow section: click Start, copy the code that appears, enter it into the input, then click Submit code. Return the final output text.',
  async steps({ call }) {
    await call('chrome_click_element', { selector: '#ms-start' });
    await new Promise((r) => setTimeout(r, 200));
    const code = await call('chrome_javascript', {
      code: `document.getElementById('ms-code').textContent`,
    });
    const codeStr = String(jsResult(code) ?? '').trim();
    await call('chrome_fill_or_select', { selector: '#ms-code-input', value: codeStr });
    await call('chrome_click_element', { selector: '#ms-submit' });
    await new Promise((r) => setTimeout(r, 200));
    const out = await call('chrome_javascript', {
      code: `document.getElementById('ms-out').textContent`,
    });
    return { result: String(jsResult(out) ?? '').trim(), code: codeStr };
  },
  predicate: (a) => ({
    ok: a.result === 'flow-complete' && /^MS-[A-Z0-9]{6}$/.test(a.code),
    reason: `result=${a.result} code=${a.code}`,
  }),
});

// ── STORAGE ───────────────────────────────────────────────────────────
scenarios.push({
  id: 'storage-cookie-and-localstorage',
  failureClass: 'storage',
  live: false,
  target: { kind: 'fixture', url: `${FIXTURE_BASE}/task-scenarios.html#s-storage` },
  description: 'Read the hc_test cookie and localStorage entry.',
  agentTask:
    'Return a JSON object with two keys: "cookie" = the value of the cookie named hc_test, and "ls" = the value of the localStorage entry hc_test.',
  async steps({ call }) {
    const res = await call('chrome_javascript', {
      code: `({ cookie: (document.cookie.match(/hc_test=([^;]+)/) || [])[1], ls: localStorage.getItem('hc_test') })`,
    });
    return jsResult(res);
  },
  predicate: (a) => ({
    ok: a?.cookie === 'cookie-OK-9133' && a?.ls === 'ls-OK-4422',
    reason: `cookie=${a?.cookie} ls=${a?.ls}`,
  }),
});

// ── ERROR RECOVERY ────────────────────────────────────────────────────
scenarios.push({
  id: 'error-recovery-bad-selector',
  failureClass: 'error-recovery',
  live: false,
  target: { kind: 'fixture', url: `${FIXTURE_BASE}/task-scenarios.html#s-interaction` },
  description: 'First click hits a non-existent selector; retry with a real one.',
  agentTask:
    'Try to click the button "#never-exists-zzz" in the Interaction section. If that fails, click the "Increment" button once instead, then return the counter value.',
  async steps({ call }) {
    const bad = await call('chrome_click_element', { selector: '#never-exists-zzz' });
    const recovered = bad?.isError === true;
    await call('chrome_javascript', {
      code: `(() => { const b = document.getElementById('counter-btn'); b.dataset.count = '0'; document.getElementById('counter-out').textContent = 'clicks=0'; return 'reset'; })()`,
    });
    await call('chrome_click_element', { selector: '#counter-btn' });
    const out = await call('chrome_javascript', {
      code: `document.getElementById('counter-out').textContent`,
    });
    return { recovered, value: String(jsResult(out) ?? '').trim() };
  },
  predicate: (a) => ({
    ok: a.recovered && a.value === 'clicks=1',
    reason: `recovered=${a.recovered} value=${a.value}`,
  }),
});

// ── NAVIGATION: reload flag ───────────────────────────────────────────
scenarios.push({
  id: 'navigation-reload-flag',
  failureClass: 'navigation',
  live: false,
  target: { kind: 'fixture', url: `${FIXTURE_BASE}/task-scenarios.html#s-interaction` },
  description:
    'After incrementing the counter, navigate to the SAME url with reload:true. Counter should reset to 0 because the page reloaded.',
  agentTask:
    'In the Interaction section, click "Increment" twice. Then navigate to the same URL again with reload:true. Then return the current counter value.',
  async steps({ call }) {
    await call('chrome_click_element', { selector: '#counter-btn' });
    await call('chrome_click_element', { selector: '#counter-btn' });
    // Navigate again with reload:true — this is the new flag's whole reason.
    await call('chrome_navigate', {
      url: `${FIXTURE_BASE}/task-scenarios.html#s-interaction`,
      reload: true,
    });
    await new Promise((r) => setTimeout(r, 400));
    const out = await call('chrome_javascript', {
      code: `document.getElementById('counter-out').textContent`,
    });
    return { value: String(jsResult(out) ?? '').trim() };
  },
  predicate: (a) => ({
    ok: a.value === 'clicks=0',
    reason: `expected clicks=0 (reload), got ${JSON.stringify(a.value)}`,
  }),
});

// ── LIVE: GitHub repo lookup ──────────────────────────────────────────
scenarios.push({
  id: 'search-live-github-readme-title',
  failureClass: 'search',
  live: true,
  target: { kind: 'live', url: 'https://github.com/cefege/humanchrome' },
  description: 'Pull the repo description from the GitHub UI.',
  agentTask:
    'Open https://github.com/cefege/humanchrome and return the about/description text shown at the top of the repo page.',
  async steps({ call }) {
    const res = await call('chrome_javascript', {
      code: `(document.querySelector('[data-pjax]+p, .f4.my-3, p.f4') || {}).textContent?.trim()`,
    });
    const text = String(jsResult(res) ?? '').trim();
    return { text };
  },
  predicate: (a) => ({
    ok: a.text.length > 5 && /chrome|mcp|browser/i.test(a.text),
    reason: `got ${JSON.stringify(a.text).slice(0, 200)}`,
  }),
});

export function getScenarios({ includeLive = false } = {}) {
  return scenarios.filter((s) => includeLive || !s.live);
}
