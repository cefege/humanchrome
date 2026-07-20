# Tab-ownership recovery — fix plan

**Status:** plan only, no code written
**Author:** investigation 2026-06-15
**Symptom owner:** Mihai
**Tracking bugs:** BUG-001 (related), IMP-0086 (origin), IMP-0089 (`force:true` patch — currently the only escape hatch)

---

## 0. Problem statement (verbatim)

Across consecutive Claude Code sessions, calls like `chrome_navigate({tabId, url})` fail with:

```
TAB_NOT_OWNED — Tab 324646949 is owned by client a1613338-d169-4223-bdc4-a8c4ad3c8ded
```

…even though the Claude Code session that owned client `a1613338-…` has long since exited. New sessions get fresh client UUIDs and must either spawn new tabs (10+ accumulate per work day) or call `browser_claim_tab({tabId, force: true})` on every tab. The mechanism exists — it's the auto-recovery path that's broken.

---

## 1. Root cause analysis

The bug is **three independent defects compounding**. Any one alone would still produce the symptom; the combination guarantees it.

### 1.1 — Claude Code never sends a stable `sessionName`, so clientId resets every launch

Claude Code's MCP config for humanchrome (per `~/.claude.json`):

```json
{ "type": "http", "url": "http://127.0.0.1:12306/mcp" }
```

No headers. No env. The HTTP MCP client connects directly to fastify at port 12306. The server reads sessionName at `app/native-server/src/server/index.ts:282-295`:

```ts
private readSessionName(request: FastifyRequest): string | null {
  const header = request.headers['x-humanchrome-session'];
  const raw = Array.isArray(header) ? header[0] : typeof header === 'string' ? header : undefined;
  if (raw) {
    const norm = normalizeSessionName(raw);
    if (norm) return norm;
  }
  const q = (request.query as { session?: unknown } | undefined)?.session;
  if (typeof q === 'string') {
    const norm = normalizeSessionName(q);
    if (norm) return norm;
  }
  return null;
}
```

Both inputs (`X-Humanchrome-Session` header, `?session=` query) are humanchrome-specific extensions. Claude Code sends neither. Fallback at `server/index.ts:417`:

```ts
const sessionName = this.readSessionName(request);
const newSessionId = sessionName ?? randomUUID();
```

→ every Claude Code launch becomes a fresh UUID clientId. The "reconnect under same name reclaims owned tabs" path documented at `client-state.ts:30-32` and `docs/MULTI-TAB.md:30` is dead-letter for Claude Code.

The stdio shim at `app/native-server/src/mcp/mcp-server-stdio.ts:75-86` does derive sessionName from `path.basename(process.cwd())`, but Claude Code does NOT use the stdio shim — it talks HTTP directly.

The doc at `docs/AGENTS.md:115` claims a third option exists ("a `_meta.humanchrome.session` value on MCP `initialize`") — grep shows zero implementation. The doc is wishful.

### 1.2 — `releaseClient` never fires for an HTTP transport that the client kills without a clean DELETE

Disconnect notification is wired at `app/native-server/src/server/index.ts:430-435`:

```ts
transport.onclose = () => {
  if (transport?.sessionId && this.transportsMap.get(transport.sessionId)) {
    this.transportsMap.delete(transport.sessionId);
  }
  this.notifyClientDisconnected(newSessionId);
};
```

…which sends `client_disconnected` to the extension, where `app/chrome-extension/entrypoints/background/native-host.ts:470-480` releases ownership:

```ts
} else if (isClientDisconnectedMessage(message)) {
  const ownedTabIds = Array.from(getClientState(message.clientId)?.ownedTabs ?? []);
  const released = releaseClient(message.clientId);
  ...
```

The wire works in tests. The catch: `transport.onclose` is invoked by the MCP SDK's `StreamableHTTPServerTransport` ONLY when the SDK observes the transport has closed. For Streamable HTTP, the SDK has no socket-level liveness check between the discrete POST calls. The transport sits "alive" in `transportsMap` until either:

- the client sends an explicit `DELETE /mcp` with the matching `mcp-session-id` header (Claude Code on exit does NOT do this), OR
- the same sessionName initializes again (kicks the prior transport via `closeExistingTransport` at `server/index.ts:304-316`).

Claude Code on session-end terminates its own process and the OS reaps it. No DELETE goes out. The transport never closes. `releaseClient` never runs. Owned tabs stay pinned to the dead UUID clientId forever.

This is the dominant cause of the symptom Mihai sees — combined with §1.1, every Claude Code session ALSO comes back as a different UUID, so the "same-name takeover" branch can't save us either.

### 1.3 — The stale-client GC is wired wrong: it only runs from inside a successful claim

`app/chrome-extension/entrypoints/background/utils/client-state.ts:92-104`:

```ts
const STALE_AFTER_MS = 30 * 60 * 1000; // 30 min

function gc(now: number): void {
  for (const [id, s] of STATE) {
    if (now - s.lastSeenAt > STALE_AFTER_MS) STATE.delete(id);
  }
}
```

`gc()` has exactly one caller, at line 299, inside `claimTabForClient`:

```ts
export function claimTabForClient(
  clientId: string | undefined,
  tabId: number,
  windowId?: number,
): string | null {
  if (!clientId || ...) return null;
  const now = Date.now();
  gc(now);           // <-- only here
  ...
}
```

But `claimTabForClient` is gated by `resolveOwnedTabIdForClient` at lines 432-440:

```ts
if (typeof explicitTabId === 'number') {
  if (opts.isRead) return { tabId: explicitTabId };
  const owner = findTabOwner(explicitTabId);
  if (owner && owner !== clientId) {
    return { conflict: { tabId: explicitTabId, owner } }; // <-- returns here, gc() never runs
  }
  if (clientId) claimTabForClient(clientId, explicitTabId);
  return { tabId: explicitTabId };
}
```

`findTabOwner` (lines 336-341) walks `STATE` and returns the stale-but-still-present clientId. The function bails with `conflict` BEFORE `claimTabForClient` (the only gc entry point) has any chance to run. **gc is unreachable from the exact code path that needs it.** No `setInterval`, no `chrome.alarms` registration, no boot-time sweep. The persisted snapshot in `chrome.storage.session` also gets reloaded with the stale clients on every SW restart via `loadPersistedClientState` (lines 172-229), with no `lastSeenAt > STALE_AFTER_MS` filter on restore.

The doc at `IMP-0089` (`docs/improvement-backlog.md:750`) explicitly anticipated this scenario ("when the owning client is dead and `CLIENT_DISCONNECTED` never fires (native-host crash, transport hang, manual hand-off between operator-driven sessions), there's no escape hatch short of restarting the extension or waiting out the 30-min `STALE_AFTER_MS` GC") — and the patch was just to add `force:true` as a manual override. The 30-min GC was assumed to work as a backstop. It doesn't.

### 1.4 — Combined effect

For a typical Mihai workflow day:

1. Claude Code session 1 starts → fastify mints UUID `aaa-…` → opens tabs T1, T2, T3 → ownership lane `aaa-…` owns {T1, T2, T3}.
2. Mihai exits Claude Code → process killed → no DELETE → fastify's `transportsMap` still holds the transport → `onclose` never fires → `releaseClient('aaa-…')` never runs → STATE still has `aaa-…` owning {T1, T2, T3} → persisted snapshot still has it too.
3. Mihai starts Claude Code session 2 → fastify mints UUID `bbb-…` (NEW because no sessionName) → `bbb-…` tries `chrome_navigate({tabId: T1})` → `findTabOwner(T1)` returns `aaa-…` → `TAB_NOT_OWNED`.
4. The 30-min GC that should have evicted `aaa-…` never runs because step 3 is the path that would have run it, and step 3 bails before the gc call.
5. Mihai's only options: `force:true` claim, or spawn a fresh tab. Repeat 10x per day.

---

## 2. Three fix options

### Option A — Reactive: prune stale clients from inside the conflict path

**What:** before `resolveOwnedTabIdForClient` reports a conflict, check the owner's `lastSeenAt`. If it exceeds `STALE_AFTER_MS`, evict the owner via `releaseClient` and retry the resolution.

**Code surface:**

- `app/chrome-extension/entrypoints/background/utils/client-state.ts:427-461` — `resolveOwnedTabIdForClient`. Insert a `pruneStaleOwner(owner)` helper between lines 434-436 and re-check `findTabOwner` afterwards.
- New helper `pruneStaleOwner(ownerId): boolean` in same file that checks `lastSeenAt` and calls `releaseClient(ownerId)` if past threshold.
- Same pattern applied at `claim-tab.ts:60-69` so a non-`force` claim also benefits.

**Pros:**

- Smallest change. ~30 lines.
- Self-healing — no daemons, no timers, no SW-wake-up considerations.
- The stale-check happens exactly when its outcome matters (conflict-resolution time), so there's no perf overhead in the happy path.
- Defensible in isolation: even if §1.1 and §1.2 stay broken, the symptom Mihai sees disappears after `STALE_AFTER_MS`.

**Cons:**

- Still leaves a 30-min window where stale ownership blocks new sessions. Mihai's typical session-to-session gap is well under 30 min, so the bug persists for most of his workflow.
- Doesn't fix the persisted-snapshot leak — stale entries reload on every SW restart and pin until first `findTabOwner` collision happens 30 min later.
- Doesn't fix the underlying disconnect-detection gap; the stale-owner accumulation continues at one-per-session-exit forever.

**Effort:** S (~1 hour with tests)

**Behavior change:** any `chrome.tabs.onRemoved`-survival ambiguity stays; legitimate cross-client coordination (two CLIs sharing a tab on purpose) gets a 30-min eviction window instead of indefinite. Acceptable trade per existing `STALE_AFTER_MS` semantics.

---

### Option B — Proactive: drive sessionName from Claude Code via stable identity, plus a periodic SW alarm sweep

**What (two parts):**

**B1 — stable sessionName from Claude Code's HTTP config.**
Update Mihai's `~/.claude.json` to include the header:

```json
{
  "type": "http",
  "url": "http://127.0.0.1:12306/mcp",
  "headers": { "X-Humanchrome-Session": "mihai-claude-code" }
}
```

(Claude Code's MCP HTTP support takes a `headers` map per its current schema.) This makes every Claude Code session reconnect under the same clientId; the same-name takeover at `server/index.ts:419` (`closeExistingTransport`) fires when a new session starts, which closes the previous transport, which fires `onclose`, which dispatches `client_disconnected`, which calls `releaseClient` AT THE START OF THE NEXT SESSION. The new session then re-claims the same tabs from the persisted snapshot at `client-state.ts:172-229`.

Document this in `docs/mcp-cli-config.md` and `docs/MULTI-TAB.md`.

**B2 — chrome.alarms-driven periodic gc.**
Service workers can use `chrome.alarms` to fire across SW sleep cycles. Register at `client-state.ts` module-init time (alongside the existing `chrome.tabs.onRemoved` registration at line 666):

```ts
chrome.alarms?.create('humanchrome:client-state-gc', { periodInMinutes: 5 });
chrome.alarms?.onAlarm.addListener((a) => {
  if (a.name === 'humanchrome:client-state-gc') {
    sweepStaleClients(Date.now());
  }
});
```

…where `sweepStaleClients` iterates STATE, releases tabs of any client with `lastSeenAt > STALE_AFTER_MS` via the existing `releaseClient` path (so subscribers in `owned-registry.ts` get notified), then `STATE.delete(id)`. Also call it once at SW boot from `native-host.ts` right after `loadPersistedClientState()`.

Optionally lower `STALE_AFTER_MS` from 30 min to 5 min — but only after B1 lands, because B1 makes a legitimate same-name reconnect always observable within seconds. Without B1, a 5-min threshold would aggressively kill the user's only escape hatch (waiting it out).

**Code surface:**

- `~/.claude.json` (Mihai's config, NOT inside the humanchrome repo — but doc this in `docs/mcp-cli-config.md`).
- `app/chrome-extension/entrypoints/background/utils/client-state.ts` — new exported `sweepStaleClients(now)`, alarm registration, boot-time sweep export hook.
- `app/chrome-extension/entrypoints/background/native-host.ts:13` — import + call `sweepStaleClients` after `loadPersistedClientState`.
- `app/chrome-extension/wxt.config.ts` or `manifest.json` — ensure `alarms` permission. (Likely already present — verify before adding.)
- New `app/chrome-extension/tests/utils/client-state-sweep.test.ts`.
- `docs/MULTI-TAB.md` — add §"Stable identity for Claude Code" with the JSON snippet.

**Pros:**

- Fixes BOTH §1.1 (sessionName) and §1.3 (gc never runs) at the source.
- B1 alone fixes the symptom for Mihai immediately (a same-name re-init triggers `closeExistingTransport` → `onclose` → `releaseClient`).
- B2 is a true safety net for everything sessionName can't fix (native-host crash, fastify restart, malformed header, third-party MCP clients without sessionName support).
- Lower `STALE_AFTER_MS` after B1 lands → minutes, not half-hour. Mihai's day-to-day pain vanishes.

**Cons:**

- B1 requires Mihai to edit `~/.claude.json` once. Small but non-zero coordination cost.
- B2 needs `alarms` permission in the manifest (verify it's not already there; if added, triggers a re-install prompt for end users — small UX cost).
- Doesn't fix §1.2 (HTTP transport has no socket-level liveness) directly. B1 makes §1.2 moot for THIS scenario, but a session that crashes WITHOUT a successor starting will still have its ownership lane persist until the GC sweeps.

**Effort:** M (~2-3 hours: config doc + alarm wiring + tests). B1 alone is 10 minutes.

**Behavior change:** Claude Code sessions become stable, repeatable identity. Two parallel Claude Code sessions on the same machine (rare) would collide on the same sessionName — second-wins per existing semantics; first session loses ownership but tabs stay open. Acceptable; documented behavior.

---

### Option C — Transport-level: server-side TTL on `transportsMap`, plus liveness pings

**What:** treat each `transportsMap` entry as a TTL-bounded resource. Track `lastSeenAt` on each entry (updated on every POST). A `setInterval` in `server/index.ts` checks every minute; entries silent for >2 minutes are explicitly closed (triggering `onclose` → `notifyClientDisconnected` → extension `releaseClient`).

Optionally add a server-side keep-alive expectation: clients that don't send ANY MCP request within `KEEPALIVE_MS` get force-closed.

**Code surface:**

- `app/native-server/src/server/index.ts` — new `Map<string, { transport, lastSeenAt }>` wrapper (or augment `transportsMap` entries), bump `lastSeenAt` in `/mcp` POST handler at line 404, setInterval to sweep at module-init. Be careful with fastify lifecycle — register on `ready()` and tear down in `Server.stop()`.
- `app/native-server/src/server/index.test.ts` — add coverage for transport TTL.
- Possibly `docs/AGENTS.md` to document the keep-alive.

**Pros:**

- Fixes §1.2 at the right architectural layer — the server should know when its transports are dead.
- Pairs well with §1.1: even without sessionName, a fresh UUID won't pile up; its predecessor disconnects within minutes.
- Independent of Chrome extension behavior — server logic can be tested with supertest without spinning up the extension.

**Cons:**

- Subtle to get right. The MCP Streamable HTTP transport already has its own `sessionIdGenerator` / `onsessioninitialized` lifecycle; layering a parallel TTL means understanding when a transport is "legitimately idle waiting for the next tool call" vs "dead client." A heartbeat-based sweep is conservative but introduces a knob (KEEPALIVE_MS) that has to be tuned for both Claude Code (might idle for minutes between calls) and curl one-shots (might never call again).
- False-positive: a long-idle but live session gets kicked. Easy to misconfigure. Without §1.1 to help reconnects re-claim, this could close one bug and open another.
- More code, more surface area, more tests.

**Effort:** M-L (~3-5 hours including careful test coverage of edge cases).

**Behavior change:** server becomes opinionated about session liveness. Idle sessions get reaped. Legitimate long-idle clients have to either reconnect (sessionName makes that cheap) or send periodic pings.

---

## 3. Recommended path

**Primary: Option B.** Both parts. B1 (sessionName in Claude Code config) closes the most common bug instance — Mihai's day-to-day pain — within minutes of the next session start. B2 (chrome.alarms sweep) backstops every other failure mode (native-host crash, fastify restart without DELETE, third-party clients, malformed configs).

**Defense-in-depth: Option A.** Cheap to add on top of B. Catches the case where SW alarm registration is delayed or the alarm fires while STATE is in mid-restore. Makes the conflict-resolution path self-healing on the very first call after a stale client's `lastSeenAt` exceeds threshold, regardless of whether the periodic sweep has run yet.

**Skip Option C for now.** It's the most architecturally correct fix for §1.2, but B+A makes the symptom go away with less code and lower regression risk. Revisit C if either:

- We see a recurring case where B1's `closeExistingTransport` does NOT fire on session-name collision (e.g., a fastify bug), or
- We start supporting third-party clients that can't be persuaded to send `X-Humanchrome-Session`.

### Why B+A and not B alone

The single failure mode B doesn't handle: a Claude Code session crashes mid-call (not a clean exit), the next session doesn't start for an hour, Mihai opens Chrome and tries to manually use a tab the dead session owned. Option A makes the next tool call self-heal as soon as the eviction threshold is crossed; without A, only the periodic alarm sweep (B2) saves us, and SW alarms can be delayed under Chrome's MV3 quiet-hours throttling.

A also covers a real-world race: SW restarts, `loadPersistedClientState` repopulates STATE from the snapshot (with the stale `lastSeenAt` baked into the persisted entry), and the alarm hasn't fired yet. The first tool call should not have to wait for the alarm — it should self-heal at conflict time.

---

## 4. Step-by-step implementation outline

Execute in this order. Each step is independently testable.

### Step 1 — B1: document + apply sessionName for Claude Code

1. Update `~/.claude.json` (Mihai's machine, outside the repo) — humanchrome block becomes:
   ```json
   "humanchrome": {
     "type": "http",
     "url": "http://127.0.0.1:12306/mcp",
     "headers": { "X-Humanchrome-Session": "claude-code" }
   }
   ```
2. Edit `docs/MULTI-TAB.md:26-32` ("Stable session identity" section) — add a "Claude Code" subsection with the exact JSON snippet. Note that the same sessionName ALSO benefits Codex and any other HTTP MCP client; recommend a per-CLI distinct name (`claude-code`, `codex`, `curl`) to keep ownership lanes separate.
3. Edit `docs/mcp-cli-config.md` — link to MULTI-TAB.md §"Stable session identity."
4. Restart Claude Code once → verify in fastify log that `mcp-session-id` is `claude-code` instead of a UUID.
5. **Acceptance:** new Claude Code sessions all report `clientId: claude-code` in `chrome_get_windows_and_tabs`'s `owner` field.

### Step 2 — A: reactive stale-owner prune in resolveOwnedTabIdForClient

1. `app/chrome-extension/entrypoints/background/utils/client-state.ts`:
   - Extract the `lastSeenAt > STALE_AFTER_MS` check from `gc()` into a `isStaleClient(state, now)` helper.
   - Add `pruneStaleOwner(ownerId: string, now: number): boolean` that returns true if it released the owner (calls `releaseClient(ownerId)` and `STATE.delete(ownerId)`).
   - In `resolveOwnedTabIdForClient` at the conflict branch (line 435): before returning `conflict`, look up the owner's state. If `isStaleClient`, call `pruneStaleOwner`, then re-run `findTabOwner(explicitTabId)`. If now unowned, auto-claim and return `{ tabId: explicitTabId }` as the success path already does.
   - Mirror the same pattern in `claim-tab.ts:60-69` — before returning the `TAB_NOT_OWNED` for a non-`force` claim, attempt `pruneStaleOwner`.
2. Add tests in `app/chrome-extension/tests/utils/client-state.test.ts`:
   - "Stale owner is auto-evicted on conflicting explicit-tabId resolution."
   - "Fresh owner is NOT evicted on conflicting explicit-tabId resolution."
   - "claim-tab without force succeeds against stale owner."
3. **Acceptance:** vitest pass; manually confirm in an SW console: a `client-state.test.ts` scenario where a client with `lastSeenAt = Date.now() - 31min` is the owner of T1; calling `resolveOwnedTabIdForClient(newClient, T1)` returns `{tabId: T1}`, not `conflict`.

### Step 3 — B2: chrome.alarms periodic sweep + boot-time sweep

1. `app/chrome-extension/wxt.config.ts` (or manifest equivalent): verify `alarms` is in `permissions`. If not, add it; note this triggers a permission warning on the next install.
2. `app/chrome-extension/entrypoints/background/utils/client-state.ts`:
   - Add exported `sweepStaleClients(now: number): { evicted: string[] }` that walks STATE, calls `releaseClient(id)` (so subscribers fire) and `STATE.delete(id)` for each `isStaleClient(state, now)` entry, then schedules a persist. Returns the list for logging.
   - Wrap the module-init `try { chrome.tabs?.onRemoved... }` block at line 665 with a sibling block registering `chrome.alarms.create('humanchrome:client-state-gc', { periodInMinutes: 5 })` and an `onAlarm.addListener` that filters by name and calls `sweepStaleClients(Date.now())`. Log the eviction list via `debugLog.info`.
3. `app/chrome-extension/entrypoints/background/native-host.ts:13`:
   - Import `sweepStaleClients` alongside `loadPersistedClientState`.
   - Wherever `loadPersistedClientState()` is currently awaited at SW boot, await it then call `sweepStaleClients(Date.now())`. This catches the case where the persisted snapshot reloaded already-stale clients.
4. Tests in `app/chrome-extension/tests/utils/client-state-sweep.test.ts`:
   - "sweepStaleClients evicts clients past STALE_AFTER_MS."
   - "sweepStaleClients leaves fresh clients untouched."
   - "sweepStaleClients triggers subscribeOnClientReleased subscribers (owned-registry teardown)."
5. **Acceptance:** install the extension on a Chrome profile, open SW devtools, manually run `chrome.alarms.getAll()` and confirm `humanchrome:client-state-gc` is present. Force a stale STATE entry via test helper, advance time, observe sweep fires.

### Step 4 — lower STALE_AFTER_MS

1. After Step 1-3 verify clean: change `STALE_AFTER_MS` from `30 * 60 * 1000` to `5 * 60 * 1000` at `client-state.ts:92`.
2. Update the doc comment above the constant to reflect the new rationale (with sessionName-based reconnects observable in seconds, the threshold can be much tighter).
3. **Acceptance:** all existing tests still pass; manual test: kill Claude Code, wait 6 min, open a NEW Claude Code session with a DIFFERENT sessionName (`HUMANCHROME_SESSION=test-other`), claim the now-stale tab succeeds without `force`.

### Step 5 — close the doc-vs-code gap

1. Edit `docs/AGENTS.md:115` — remove the `_meta.humanchrome.session` claim (no implementation exists). Keep header + env + cwd-fallback.
2. Edit `client-state.ts:30-32` docstring — clarify that reconnects reclaim ownership ONLY if the client sends the same sessionName (header or env), and that without sessionName each reconnect is a new lane.

### Step 6 — regenerate docs and changelog

1. `pnpm` regenerate `docs/TOOLS.md` if any tool schema changed (none should).
2. Add changelog entry: "Stale ownership cleanup — Claude Code-driven tabs no longer pin to dead UUID clients."

---

## 5. Test plan

### Local manual repro (before any fix lands — confirm the bug)

1. Start a clean Chrome with the extension loaded; service worker live.
2. Start Claude Code session 1 — connects to humanchrome via HTTP, no sessionName.
3. In session 1, run `chrome_navigate({newTab: true, url: 'https://example.com'})` — note the returned `tabId` (call it T1).
4. Run `chrome_get_windows_and_tabs` and confirm T1's `owner` is some UUID (call it `uuid-1`).
5. Exit Claude Code (Ctrl+C or window close).
6. Start Claude Code session 2 (fresh).
7. Run `chrome_navigate({tabId: T1, url: 'https://other.com'})`.
8. **Expected today:** `TAB_NOT_OWNED — Tab T1 is owned by client uuid-1`.

### Verify Step 1 (sessionName)

After updating `~/.claude.json` per Step 1:

1. Repeat the repro above. After step 4, confirm T1's `owner` is the literal string `claude-code` (not a UUID).
2. After exiting and starting session 2, confirm `chrome_get_windows_and_tabs` shows T1's owner is STILL `claude-code` (same lane reclaimed via persisted snapshot at `client-state.ts:172-229`).
3. Run `chrome_navigate({tabId: T1, url: 'https://other.com'})` from session 2 — succeeds with no `TAB_NOT_OWNED`.

### Verify Step 2 (reactive prune)

1. In SW devtools, force-set a client's `lastSeenAt` to `Date.now() - 31*60*1000`:
   ```js
   // SW console — devtools attached to humanchrome SW
   const { _resetClientStateForTests, ... } = await import('/path/to/client-state.ts');  // dev only
   // or test helper accessor
   ```
   Easier path: write a vitest integration test that seeds STATE directly.
2. From a different clientId, call `resolveOwnedTabIdForClient(newClient, T1)`.
3. **Expected after fix:** returns `{ tabId: T1 }` (auto-claimed), no `conflict`. The stale client is gone from STATE.
4. Confirm `subscribeOnClientReleased` subscribers (e.g., `owned-registry`) saw the release event.

### Verify Step 3 (alarms sweep)

1. Install the extension; open SW devtools; `chrome.alarms.getAll()` should list `humanchrome:client-state-gc` with period 5 min.
2. Seed a stale STATE entry (test helper).
3. Manually trigger the alarm: `chrome.alarms.onAlarm.dispatch({ name: 'humanchrome:client-state-gc' })` — or fast-forward via test harness.
4. **Expected:** STATE no longer contains the seeded stale entry; persisted snapshot in `chrome.storage.session` no longer contains it; release subscribers fired.

### Verify Step 4 (lowered threshold)

1. Kill Claude Code.
2. Wait 6 minutes (or fast-forward via test harness).
3. From a separate MCP client (e.g., `curl` with a different `X-Humanchrome-Session`), call `chrome_navigate({tabId: T1})`.
4. **Expected:** succeeds (the now-5-min stale claude-code lane has been swept).

### Regression suite

- `pnpm test` (root) — all existing tests pass.
- Specifically watch `app/native-server/src/server/session-name.test.ts` — must still pass; B1 is purely additive to caller-config, doesn't change server semantics.
- Specifically watch `app/chrome-extension/tests/utils/client-state.test.ts` — must still pass; new tests are added.

---

## 6. Rollback plan

Each step is independently revertible; rollback granularity is per-step.

### If Step 1 (sessionName in Claude Code config) misbehaves

**Symptom to watch:** parallel Claude Code sessions on the same machine now collide (second-wins, first loses tabs).
**Detection:** `debugLog.info('client released', ...)` lines in SW console appear at session-start instead of session-end, and Mihai notices tabs going "unowned" when he didn't expect it.
**Rollback:** remove the `headers` block from `~/.claude.json`. Reverts to UUID-per-session. Symptom returns, but no new bug introduced.

### If Step 2 (reactive prune) misbehaves

**Symptom to watch:** legitimate cross-client coordination breaks — a long-running second client that paused for >30 min (>5 min after Step 4) gets its tabs stolen by another client's call.
**Detection:** unexpected `client released` log lines correlated with tools other than `client_disconnected` messages.
**Rollback:** revert the `pruneStaleOwner` call in `resolveOwnedTabIdForClient` and `claim-tab.ts`. Keep the helper exported (no harm) but stop invoking it. Reverts to the previous behavior — stale clients persist, but only Option A's path is affected; B2 still does periodic sweep.

### If Step 3 (alarms sweep) misbehaves

**Symptom to watch:** alarm fires while a legitimate session is mid-call but hasn't bumped `lastSeenAt`; client loses ownership unexpectedly.
**Detection:** SW log shows `client-state-gc evicted [clientId]` for a clientId that was actively used within the last few minutes.
**Mitigation A (no rollback):** widen `STALE_AFTER_MS` back to 30 min. Sweep still runs but only catches truly stale entries.
**Rollback:** remove the `chrome.alarms.create` and listener registration. Reverts to no periodic sweep. Step 2 still works as the safety net.

### If Step 4 (lowered threshold) misbehaves

**Symptom to watch:** any tool call that pauses for human input >5 min loses ownership of its tabs by the time the human responds.
**Detection:** STATUS reports unexpectedly often that tabs are unowned.
**Rollback:** bump `STALE_AFTER_MS` back to 30 min in `client-state.ts:92`. One-line revert.

### Atomic emergency rollback (everything)

`git revert` the merge commit. Restart Chrome and reload the extension. Mihai's `~/.claude.json` change is independent; remove the `headers` block to undo Step 1. Symptom returns to today's behavior; nothing else breaks.

### Long-term canary

Add a debug-log counter for `pruneStaleOwner triggered` and `sweepStaleClients evicted N` events. Spike in these counters (>10/day during normal use) signals either:

- `STALE_AFTER_MS` is too aggressive, or
- A real disconnect-notification path is silently breaking and we're masking it.

In either case, the canary surfaces the issue before users notice.

---

## 7. Open questions for follow-up (not blockers)

1. **Should `releaseClient` ALSO close tabs that were the LAST one in a window for the dead client?** Currently it only releases ownership; the tab stays open. For Mihai's 10-tabs-per-day complaint, this matters. Probably a separate IMP — orthogonal to this plan.
2. **Should `chrome_get_windows_and_tabs` surface a `stale: true` flag on tabs whose owner hasn't been seen in N min?** Useful diagnostic; cheap to add. Out of scope here.
3. **Codex / other CLIs:** same fix shape applies. Once Step 1 is documented, encourage every CLI integration to set its own sessionName. Possibly add a default `X-Humanchrome-Session: unknown-http-client` in the fastify layer with a log warning so silent-UUID sessions are visible.
