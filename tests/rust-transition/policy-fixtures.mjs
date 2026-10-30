// Shared JSONL corpus for the TypeScript and Rust policy-oracle processes.
// Each case is deliberately an input, never a Rust-derived expected result.

const customTools = [
  {
    name: 'chrome_click_element',
    description: 'Click a visible page element. Supports CSS selectors.',
    inputSchema: { type: 'object', properties: { selector: { type: 'string' } } },
  },
  {
    name: 'browser_claim_tab',
    description: 'Claim a browser tab for a client.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' } } },
  },
  {
    name: 'flow.checkout',
    description: 'Run checkout flow safely. Handles payment confirmation.',
    inputSchema: { type: 'object' },
  },
];

const textResult = (text, extra = {}) => ({ content: [{ type: 'text', text }], ...extra });

export const policyFixtures = [
  // Session normalization is native policy, but its TypeScript oracle is the compiled bridge module.
  ['session plain whitespace and separators', { op: 'normalizeSessionName', value: '  Acme API/foo\\bar:zap  ' }],
  ['session NFC and stripped characters', { op: 'normalizeSessionName', value: 'CAFE\u0301@Team!' }],
  ['session reserved synthetic prefix', { op: 'normalizeSessionName', value: '__ui:popup' }],
  ['session reserved name after normalization', { op: 'normalizeSessionName', value: ' NULL ' }],
  ['session whitespace-only', { op: 'normalizeSessionName', value: ' \t\n ' }],
  ['session cap removes trailing separator', { op: 'normalizeSessionName', value: `${'a'.repeat(63)}--tail` }],
  ['session non-string', { op: 'normalizeSessionName', value: 42 }],

  // Catalog resolution, ranking, aliases/replacements, custom schemas, and the pinned descriptor.
  ['catalog resolves chrome short name', { op: 'resolveToolName', name: 'click_element' }],
  ['catalog resolves browser short name', { op: 'resolveToolName', name: 'claim_tab' }],
  ['catalog resolves dynamic extra', { op: 'resolveToolName', name: 'checkout', extras: ['flow.checkout'] }],
  ['catalog rejects unknown name', { op: 'resolveToolName', name: 'not_a_humanchrome_tool' }],
  ['catalog suggests typo including dynamic extra', { op: 'suggestToolName', name: 'flo.chekout', extras: ['flow.checkout'] }],
  ['catalog known names ordered', { op: 'knownToolNames' }],
  ['catalog search rank click', { op: 'searchTools', query: 'click element' }],
  ['catalog search ignores noise', { op: 'searchTools', query: 'to is' }],
  ['catalog help query limit', { op: 'buildToolHelp', args: { query: 'click', limit: 1 } }],
  ['catalog help unknown exact name', { op: 'buildToolHelp', args: { name: 'chrome_no_such_tool' } }],
  ['catalog help full index', { op: 'buildToolHelp', args: {} }],
  ['catalog dispatcher descriptor', { op: 'buildDispatcherTool' }],
  ['catalog sunset replacement', { op: 'findReplacementForSunsetTool', name: 'chrome_get_cookies' }],
  ['catalog no sunset replacement', { op: 'findReplacementForSunsetTool', name: 'chrome_click_element' }],
  ['catalog custom tools resolve and rank', { op: 'resolveToolName', name: 'claim_tab', tools: customTools }],
  ['catalog custom tools help descriptor', { op: 'buildDispatcherTool', tools: customTools }],
  ['catalog custom tools search', { op: 'searchTools', query: 'payment confirmation', tools: customTools }],

  // INVALID_ARGS keeps UTF-16 slicing and JSON-in-text stable.
  ['invalid args did-you-mean case insensitive', { op: 'didYouMean', value: 'Strat', candidates: ['start', 'stop'], maxDistance: 2 }],
  ['invalid args did-you-mean transposition not accepted', { op: 'didYouMean', value: 'statr', candidates: ['start', 'stop'], maxDistance: 1 }],
  ['invalid args received exactly 200 UTF16 units', { op: 'truncateReceived', value: 'x'.repeat(200) }],
  ['invalid args valid pair becomes lone surrogate at UTF16 boundary', { op: 'truncateReceived', value: `${'x'.repeat(199)}😀` }],
  ['invalid args large array becomes JSON text', { op: 'truncateReceived', value: Array.from({ length: 150 }, (_, index) => ({ index, label: 'entry' })) }],
  ['invalid args object details and suggestion', {
    op: 'buildInvalidArgsDetails', arg: 'action', received: 'Strat', candidates: ['start', 'stop'],
    extra: { matchCount: 2, sample: { nested: true } },
  }],
  ['invalid args explicit expected and hint', {
    op: 'buildInvalidArgsDetails', arg: 'mode', received: null,
    expected: { type: 'string', enum: ['preview', 'raw'] }, hint: 'Pass preview or raw.',
  }],
  ['invalid args extras override fields with integer-key ordering', {
    op: 'buildInvalidArgsDetails', arg: 'original', received: 'bad', expected: ['one', 'two'],
    extra: { '10': 'ten', '2': 'two', arg: 'overridden', received: null, extra: true },
  }],
  ['tool error JSON text preserves details ordering', {
    op: 'serializeToolError', code: 'INVALID_ARGS', message: 'bad action', details: { arg: 'action', expected: { enum: ['start', 'stop'] } },
  }],

  // Dispatcher output budget differs from the browser truncation envelope below.
  ['output budget UTF8 partial replacement decode', { op: 'enforceOutputBudget', options: { budgetBytes: 1024 }, result: textResult(`${'a'.repeat(1023)}😀${'b'.repeat(900)}`) }],
  ['output budget raw bypass', { op: 'enforceOutputBudget', options: { raw: true, budgetBytes: 1024 }, result: textResult('x'.repeat(4000)) }],
  ['output budget error bypass', { op: 'enforceOutputBudget', options: { budgetBytes: 1024 }, result: textResult('x'.repeat(4000), { isError: true }) }],
  ['output budget preserves image and truncates text blocks', {
    op: 'enforceOutputBudget', options: { budgetBytes: 1024 },
    result: { content: [{ type: 'image', data: 'a'.repeat(5000), mimeType: 'image/png' }, { type: 'text', text: 'x'.repeat(2000) }, { type: 'text', text: 'y'.repeat(2000) }] },
  }],
  ['browser truncate string UTF8 character boundary', { op: 'truncateString', value: 'é😀z', limit: 5 }],
  ['browser truncate string raw mode', { op: 'truncateString', value: 'é😀z', limit: 1, mode: 'raw' }],
  ['browser truncate JSON envelope', { op: 'truncateJson', value: { label: '😀😀', nested: [1, 2] }, limit: 12 }],
  ['browser truncate array item envelope', { op: 'truncateArray', value: [0, 1, 2, 3], limit: 2 }],
  ['browser mode accepts only true', { op: 'modeFromRaw', value: 'true' }],
  ['browser mode true is raw', { op: 'modeFromRaw', value: true }],

  // Graph conversion retains source errors, duplicate IDs, cycle fallback, and coercion quirks.
  ['graph maps delay negative clamp', { op: 'mapNodeToStep', node: { id: 'delay', type: 'delay', config: { ms: -2 } } }],
  ['graph maps delay NaN-like string', { op: 'mapNodeToStep', node: { id: 'delay-nan', type: 'delay', config: { ms: 'NaN' } } }],
  ['graph maps target fallback', { op: 'mapNodeToStep', node: { id: 'click', type: 'click', config: { target: null } } }],
  ['graph step config omits identifiers', { op: 'mapStepToNodeConfig', step: { id: 's1', type: 'click', target: null, value: '' } }],
  ['graph steps assign ids and script type', { op: 'stepsToNodes', steps: [{ id: '', type: '' }, null, { id: 'same', type: 'fill', value: 'x' }] }],
  ['graph DAG duplicate ids retain unique edge ids', { op: 'stepsToDAG', steps: [{ id: 'same', type: 'click' }, { id: 'same', type: 'fill' }] }],
  ['graph topo stable branching order', {
    op: 'topoOrder', nodes: [{ id: 'a', type: 'click' }, { id: 'b', type: 'fill' }, { id: 'c', type: 'wait' }],
    edges: [{ id: 'ab', from: 'a', to: 'b' }, { id: 'ac', from: 'a', to: 'c' }],
  }],
  ['graph topo cycle falls back original order', {
    op: 'topoOrder', nodes: [{ id: 'a', type: 'click' }, { id: 'b', type: 'fill' }],
    edges: [{ id: 'ab', from: 'a', to: 'b' }, { id: 'ba', from: 'b', to: 'a' }],
  }],
  ['graph topo dangling source error', { op: 'topoOrder', nodes: [{ id: 'a', type: 'click' }], edges: [{ id: 'bad', from: 'missing', to: 'a' }] }],
  ['graph nodes to steps duplicate IDs', { op: 'nodesToSteps', nodes: [{ id: 'x', type: 'fill', config: { value: 'one' } }, { id: 'x', type: 'key', config: { keys: 'Enter' } }], edges: [] }],

  // IPC validates named authoritative schemas, with strict reparse only for load-bearing types.
  ['IPC ClientId maximum UTF16 length', { op: 'ipcValidate', schema: 'ClientIdSchema', value: 'a'.repeat(128) }],
  ['IPC ClientId exceeds UTF16 length', { op: 'ipcValidate', schema: 'ClientIdSchema', value: 'a'.repeat(129) }],
  ['IPC ClientId rejects whitespace', { op: 'ipcValidate', schema: 'ClientIdSchema', value: 'alice bob' }],
  ['IPC ClientId rejects empty string', { op: 'ipcValidate', schema: 'ClientIdSchema', value: '' }],
  ['IPC ClientId emoji fits UTF16 cap but fails grammar', { op: 'ipcValidate', schema: 'ClientIdSchema', value: '😀'.repeat(64) }],
  ['IPC ClientId emoji exceeds UTF16 cap and fails grammar', { op: 'ipcValidate', schema: 'ClientIdSchema', value: '😀'.repeat(65) }],
  ['IPC JSON value nested valid', { op: 'ipcValidate', schema: 'JsonValueSchema', value: { nested: [true, null, 'x'] } }],
  ['IPC stop named schema', { op: 'ipcValidate', schema: 'StopServerMessageSchema', value: { type: 'stop', future: true } }],
  ['IPC ping named schema', { op: 'ipcValidate', schema: 'PingFromExtensionMessageSchema', value: { type: 'ping_from_extension', future: true } }],
  ['IPC file operation named schema', { op: 'ipcValidate', schema: 'FileOperationMessageSchema', value: { type: 'file_operation', payload: { action: 'prepareFile', future: true } } }],
  ['IPC file payload rejects unknown action', { op: 'ipcValidate', schema: 'FileOperationPayloadSchema', value: { action: 'launchMissiles' } }],
  ['IPC file payload missing required action', { op: 'ipcValidate', schema: 'FileOperationPayloadSchema', value: {} }],
  ['IPC response named schema', { op: 'ipcValidate', schema: 'ResponseMessageSchema', value: { responseToRequestId: 'r1', payload: { ok: true }, future: true } }],
  ['IPC unknown typed rejects empty type', { op: 'ipcValidate', schema: 'UnknownTypedMessageSchema', value: { type: '' } }],
  ['IPC tool call body rejects extra key', { op: 'ipcValidate', schema: 'ToolCallBodySchema', value: { args: {}, clientId: 'leaked' } }],
  ['IPC tool call args rejects non-record', { op: 'ipcValidate', schema: 'ToolCallArgsSchema', value: ['not', 'a', 'record'] }],
  ['IPC start accepts future keys', { op: 'ipcValidate', schema: 'StartServerMessageSchema', value: { type: 'start', payload: { port: 12306, futurePayload: true }, futureTop: 'kept' } }],
  ['IPC start missing literal type', { op: 'ipcValidate', schema: 'StartServerMessageSchema', value: { payload: { port: 12306 } } }],
  ['IPC start rejects unsafe integer port', { op: 'ipcValidate', schema: 'StartServerMessageSchema', value: { type: 'start', payload: { port: 9007199254740992 } } }],
  ['IPC start rejects decimal port', { op: 'ipcValidate', schema: 'StartServerMessageSchema', value: { type: 'start', payload: { port: 123.5 } } }],
  ['IPC call tool valid future keys', { op: 'ipcValidate', schema: 'CallToolMessageSchema', value: { type: 'call_tool', requestId: 'r1', clientId: 'alice', payload: { name: 'chrome_click_element', args: { selector: '#x' }, future: 1 }, futureTop: true } }],
  ['IPC call tool invalid payload name', { op: 'ipcValidate', schema: 'CallToolMessageSchema', value: { type: 'call_tool', requestId: 'r1', clientId: 'alice', payload: { name: '' } } }],
  ['IPC call tool reports optional-base errors in schema order', {
    op: 'ipcValidate', schema: 'CallToolMessageSchema',
    value: { type: 'call_tool', requestId: '', responseToRequestId: 7, clientId: 'invalid client', payload: {} },
  }],
  ['IPC disconnected accepts legacy payload client', { op: 'ipcValidate', schema: 'ClientDisconnectedMessageSchema', value: { type: 'client_disconnected', clientId: 'alice', payload: { clientId: 'legacy' }, future: true } }],
  ['IPC disconnected rejects malformed client', { op: 'ipcValidate', schema: 'ClientDisconnectedMessageSchema', value: { type: 'client_disconnected', clientId: '' } }],
  ['IPC native union accepts future typed envelope', { op: 'ipcValidate', schema: 'NativeMessageSchema', value: { type: 'future_directive', future: { nested: true } } }],
  ['IPC native union rejects primitive', { op: 'ipcValidate', schema: 'NativeMessageSchema', value: 42 }],
  ['IPC native union missing every discriminator', { op: 'ipcValidate', schema: 'NativeMessageSchema', value: {} }],
  ['IPC native union empty type', { op: 'ipcValidate', schema: 'NativeMessageSchema', value: { type: '' } }],
  ['IPC parse native union retains nested branch errors', { op: 'parseNativeMessage', value: { type: 'future_directive', requestId: 7 } }],
  ['IPC parse preserves future keys', { op: 'parseNativeMessage', value: { type: 'future_directive', future: { nested: true } } }],
  ['IPC parse strictly rejects malformed call tool', { op: 'parseNativeMessage', value: { type: 'call_tool', requestId: 'r1', clientId: 'alice', payload: {} } }],
  ['IPC parse strictly rejects malformed disconnected', { op: 'parseNativeMessage', value: { type: 'client_disconnected', clientId: '' } }],
  ['IPC parse response envelope', { op: 'parseNativeMessage', value: { responseToRequestId: 'r1', payload: { ok: true }, future: 'kept' } }],

  // Cache operations run against fresh test-only configuration and an injected clock per case.
  ['idem cache replay preserves error result', {
    op: 'idemCache', ttlMs: 30_000, maxEntries: 3, actions: [
      { kind: 'record', now: 100, clientId: 'a', tool: 'chrome_click_element', key: 'one', result: textResult('{"error":"no"}', { isError: true }) },
      { kind: 'lookup', now: 101, clientId: 'a', tool: 'chrome_click_element', key: 'one' },
    ],
  }],
  ['idem cache expires at TTL boundary', {
    op: 'idemCache', ttlMs: 10, maxEntries: 3, actions: [
      { kind: 'record', now: 100, clientId: 'a', tool: 't', key: 'one', result: textResult('one') },
      { kind: 'lookup', now: 109, clientId: 'a', tool: 't', key: 'one' },
      { kind: 'lookup', now: 110, clientId: 'a', tool: 't', key: 'one' },
    ],
  }],
  ['idem cache LRU hit refreshes order', {
    op: 'idemCache', ttlMs: 1000, maxEntries: 2, actions: [
      { kind: 'record', now: 1, clientId: 'a', tool: 't', key: 'one', result: textResult('one') },
      { kind: 'record', now: 2, clientId: 'a', tool: 't', key: 'two', result: textResult('two') },
      { kind: 'lookup', now: 3, clientId: 'a', tool: 't', key: 'one' },
      { kind: 'record', now: 4, clientId: 'a', tool: 't', key: 'three', result: textResult('three') },
      { kind: 'lookup', now: 5, clientId: 'a', tool: 't', key: 'two' },
      { kind: 'lookup', now: 5, clientId: 'a', tool: 't', key: 'one' },
    ],
  }],
  ['idem cache key delimiter collision behavior', {
    op: 'idemCache', ttlMs: 1000, maxEntries: 3, actions: [
      { kind: 'record', now: 1, clientId: 'a:b', tool: 'c', key: 'd', result: textResult('first') },
      { kind: 'lookup', now: 2, clientId: 'a', tool: 'b:c', key: 'd' },
    ],
  }],
  ['idem cache ignores absent key components', {
    op: 'idemCache', ttlMs: 1000, maxEntries: 3, actions: [
      { kind: 'record', now: 1, clientId: 'a', tool: 't', result: textResult('ignored') },
      { kind: 'lookup', now: 2, clientId: 'a', tool: 't' },
      { kind: 'record', now: 3, clientId: 'a', tool: '', key: 'key', result: textResult('ignored') },
    ],
  }],
  ['idem replay retains UTF-16 object-spread metadata', {
    op: 'idemCache', ttlMs: 1000, maxEntries: 3, actions: [
      { kind: 'record', now: 1, clientId: 'a', tool: 't', key: 'key', result: textResult('kept', { _meta: '😀' }) },
      { kind: 'lookup', now: 2, clientId: 'a', tool: 't', key: 'key' },
    ],
  }],
  ['idem replay retains array result indices', {
    op: 'idemCache', ttlMs: 1000, maxEntries: 3, actions: [
      { kind: 'record', now: 1, clientId: 'a', tool: 't', key: 'key', result: ['first', 'second'] },
      { kind: 'lookup', now: 2, clientId: 'a', tool: 't', key: 'key' },
    ],
  }],
].map(([name, input]) => Object.freeze({ name, input: Object.freeze(input) }));
