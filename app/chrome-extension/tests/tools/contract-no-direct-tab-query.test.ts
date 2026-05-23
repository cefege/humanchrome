/**
 * Contract: no tool under `tools/browser/` may call
 * `chrome.tabs.query({ active: true, ... })` or
 * `chrome.tabs.query({ currentWindow: true, ... })` directly.
 *
 * The dispatcher's per-client ownership model (IMP-0086) and the new
 * `getOwnedTab` helper (IMP-0157) require every "what's the active
 * tab" decision to flow through `resolveOwnedTabIdForClient`. A direct
 * `chrome.tabs.query({active:true})` lands on the globally-active
 * tab, which can belong to another MCP client — exactly the regression
 * the multi-tab-by-design rollout exists to close.
 *
 * The allowlist below covers files that legitimately need to look at
 * the whole browser surface (claim, close-by-pattern, get-all,
 * tab-groups query-by-groupId). Adding a file requires a one-line PR
 * with a comment explaining why.
 *
 * Phase 2 lands this ratchet after the bulk migration in IMP-0159 +
 * IMP-0160. The matching mutating sites in `record-replay/`,
 * `web-editor/`, and `quick-panel/` are out of scope for this contract
 * — they're not MCP tools and don't carry a clientId.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const TOOLS_BROWSER_DIR = join(
  __dirname,
  '../../entrypoints/background/tools/browser',
);

/**
 * Allowlist — each file is allowed direct active/currentWindow queries
 * because of the comment beside it. New entries must be explicitly
 * justified in the PR that adds them.
 */
const ALLOWLIST: Map<string, string> = new Map([
  // Whole-browser surface enumerators.
  ['window.ts', 'get_windows_and_tabs walks every window/tab on the user side'],
  ['close-tabs-matching.ts', 'matches across all windows by URL/regex; ownership-agnostic'],
  ['close-my-tabs.ts', 'closes the caller-owned set, never queries by active'],
  ['claim-tab.ts', 'explicit-tabId claim; no implicit-active path'],
  // Per-client UI bridge stays out of `tools/browser/` so it isn't
  // scanned here — see `entrypoints/popup/` and `sidepanel/` for the
  // UI-side allowlist test (IMP-0167).
]);

const FORBIDDEN = [
  // Match `chrome.tabs.query({ ... active: true ... })` — covers single-
  // and multi-line query options bags.
  /chrome\.tabs\.query\s*\(\s*\{[^}]*active\s*:\s*true/,
  // Match `chrome.tabs.query({ ... currentWindow: true ... })` without
  // also being a tab-id-targeted query.
  /chrome\.tabs\.query\s*\(\s*\{[^}]*currentWindow\s*:\s*true/,
];

function* walkTsFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      yield* walkTsFiles(full);
    } else if (stat.isFile() && entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      yield full;
    }
  }
}

describe('contract: no direct chrome.tabs.query({active|currentWindow}) in tools/browser/', () => {
  const offences: Array<{ file: string; line: number; snippet: string }> = [];

  for (const fullPath of walkTsFiles(TOOLS_BROWSER_DIR)) {
    const relative = fullPath.slice(TOOLS_BROWSER_DIR.length + 1);
    if (ALLOWLIST.has(relative)) continue;
    const text = readFileSync(fullPath, 'utf8');
    if (!FORBIDDEN.some((re) => re.test(text))) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const slice = lines.slice(i, i + 4).join('\n');
      if (FORBIDDEN.some((re) => re.test(slice))) {
        offences.push({ file: relative, line: i + 1, snippet: lines[i]!.trim() });
        break; // one offence per file is enough to fail
      }
    }
  }

  it('passes the ratchet (no forbidden chrome.tabs.query calls outside allowlist)', () => {
    if (offences.length > 0) {
      const formatted = offences
        .map((o) => `  - ${o.file}:${o.line} → ${o.snippet}`)
        .join('\n');
      throw new Error(
        `Direct chrome.tabs.query({active|currentWindow}) found in tools/browser/.\n` +
          `Use \`this.getOwnedTab(...)\` from BaseBrowserToolExecutor (IMP-0157).\n` +
          `If the call is legitimately whole-browser, add the file to the ALLOWLIST\n` +
          `in this test with a one-line justification.\n\nViolations:\n${formatted}`,
      );
    }
    expect(offences).toEqual([]);
  });

  it('allowlist contains the expected entries (no stale shims)', () => {
    // If a file in the allowlist no longer exists, drop it. This protects
    // against renames that leave dead allowlist entries that could later
    // shadow a real violation if the file comes back.
    const missing: string[] = [];
    for (const relative of ALLOWLIST.keys()) {
      try {
        statSync(join(TOOLS_BROWSER_DIR, relative));
      } catch {
        missing.push(relative);
      }
    }
    expect(missing).toEqual([]);
  });
});
