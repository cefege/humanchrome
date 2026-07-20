# Task-level scenarios

The matrix runner (`scripts/run-e2e-matrix.mjs`) is a contract suite — it
proves each tool, called with specific args, returns the expected envelope.
That's necessary but not sufficient: a real LLM driving humanchrome has to
pick a tool, chain calls, recover from misses, and ground its answer in the
DOM. Contract green can still mean "LLM-driven flows are broken."

This directory holds **task-level scenarios** — outcomes a user would judge
the MCP on. Each scenario is portable across two runners:

| Runner                          | Drives                                             | Catches                                              |
| ------------------------------- | -------------------------------------------------- | ---------------------------------------------------- |
| `pnpm e2e:tasks` (tier 2)       | The runner calls tools directly through the bridge | Tool-level regressions on realistic chains           |
| `pnpm e2e:tasks:agent` (tier 3) | A real Claude subagent via `claude -p`             | LLM picks the wrong tool / wrong args / wrong answer |

Add `--live` to either to include scenarios that hit real URLs. Without
`--live` only local fixtures (port 4173) run.

## Adding a scenario

Append an object to `scenarios` in `index.mjs`:

```js
{
  id: 'kebab-id',
  failureClass: 'search' | 'interaction' | 'navigation' | 'tool-choice',
  live: false,
  target: { kind: 'fixture', url: `${FIXTURE_BASE}/task-scenarios.html#anchor` },
  description: 'human-readable goal',
  agentTask: 'natural-language brief the agent reads',
  async steps({ call }) {
    // call() auto-injects tabId from the prior chrome_navigate.
    const r = await call('chrome_javascript', { code: '…' });
    return { /* whatever predicate needs */ };
  },
  predicate: (answer) => ({ ok: Boolean, reason: 'string for diagnostics' }),
},
```

Then add an `<section>` to `../fixtures/task-scenarios.html` if you need new
DOM. Tier 3 (`adaptAnswer` in `scripts/run-agent-scenarios.mjs`) needs a
case that translates the agent's free-form answer into the shape the
predicate expects — keep it lenient.

## Why two runners

Tier 2 is deterministic and fast (~2s for the full suite). Run it on every
chrome-extension change.

Tier 3 burns tokens and varies run-to-run. Use it when you suspect the model
is the failure mode — vague tool descriptions, ambiguous schemas, or a tool
that "works" but is unfindable from the catalog blurb.
