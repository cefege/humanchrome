# Tool description style — IMP-0180 skeleton

Every tool description in `TOOL_SCHEMAS` follows a fixed skeleton so the
1-tool MCP dispatcher (IMP-0177) ships a tight, predictable catalog to the
LLM. The contract test `tool-descriptions-style.test.ts` enforces these
invariants — if it passes, the description is accepted.

## Hard rules (enforced)

- **≤160 estimated tokens** (`chars/4` heuristic) — a pathological-bloat
  guard, not a tight budget. The original 80-token cap assumed the full
  catalog shipped in the dispatcher description every turn; under the lazy
  dispatcher (IMP-0185, default) only tool names ship in the cache-hot
  path and full descriptions load on demand via `chrome_help`, where the
  `Example:` + `Cross-ref:` content powers Playwright-vocabulary discovery.
- **Contains the literal substring `Example:`** — one short call →
  outcome example. This is the model's best signal for getting args
  right on the first call.
- **No markdown headers** (`#`, `##`, etc.) and no multi-paragraph prose.
- **No trailing newlines.**
- **No timestamps, env vars, hostnames, semver build metadata, or other
  byte-unstable text** — see [`IMP-0181`'s banned-patterns invariant](../tool-index.snapshot.test.ts).

## Skeleton

```
<imperative verb-phrase, one sentence>. <one constraint or footgun if any>. Example: <minimal-args> → <outcome>
```

### Examples

```
Click an element by selector, ref, or viewport coordinates. Strict-mode multi-match errors with `details.matchCount` unless you pass `index` or `multi:true`. Example: {selector:"#submit"} → {clicked:true, frameId:0}
```

```
Capture network traffic on a tab. action=start begins; action=stop returns the buffer; action=flush drains without stopping. needResponseBody=true switches to the CDP backend. Example: {action:"start", needResponseBody:false} → {captureId, started:true}
```

```
Wait until a DOM element reaches the desired state. Example: {selector:"#login", state:"present", timeoutMs:5000} → {found:true, ref:"r1"}
```

## Why the constraint matters

The dispatcher's `description` field is the only signal the LLM has for
picking and shaping a call (per [IMP-0177](../tool-index.ts) — no
per-tool JSONSchema is sent to the client). A tight description means:

- Under the lazy dispatcher (IMP-0185) only tool names ship in the
  cache-hot path; full descriptions load on demand via `chrome_help`, so
  the token budget is a bloat guard rather than a per-turn cache cost.
- The model sees the **same structure** for every tool — verb, constraint,
  example — and learns the pattern.
- The `Example:` line teaches arg shape better than 200 tokens of prose.

## How to update

Edit the tool's entry in `packages/shared/src/tools.ts`. Run
`pnpm --filter humanchrome-shared test` to verify the contract test
passes. Regenerate the IMP-0181 snapshot with
`pnpm --filter humanchrome-shared regen:tool-index-snapshot`.

The audit script `packages/shared/scripts/audit-tool-descriptions.mjs`
lists which tools are over-budget and where to focus.
