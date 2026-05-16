/**
 * Normalize a free-form sessionName into a stable, comparable clientId.
 *
 * Why: humanchrome's per-client ownership is keyed by clientId. Without a
 * canonical form, "Acme-API" and "acme-api" would create two separate
 * ownership lanes; whitespace, slashes, and leading dots could either
 * collide with reserved names or break logging.
 *
 * The output is suitable for direct use as a Map key, for chrome.storage
 * persistence, and for log output. Returns `null` when the input can't be
 * salvaged into a valid name — callers should fall back to a UUID.
 *
 * Rules (in order):
 *   1. Unicode NFC normalize.
 *   2. Trim, lowercase.
 *   3. Replace whitespace and path separators (`/`, `\`, `:`) with `-`.
 *   4. Strip characters outside `[a-z0-9_.-]`.
 *   5. Collapse repeated `-`, `_`, `.` runs.
 *   6. Trim leading/trailing `-`, `_`, `.`.
 *   7. Cap length at 64.
 *   8. Reject empty, reserved names (`default`, `null`, `undefined`), or
 *      anything starting with `__` (reserved for synthetic UI ids).
 */
export function normalizeSessionName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.normalize('NFC').trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/[\s/\\:]+/g, '-');
  s = s.replace(/[^a-z0-9_.-]/g, '');
  // Reject anything that LOOKS like a reserved UI id (`__ui:*`) BEFORE we
  // collapse / strip leading underscores — otherwise `__ui:popup` would
  // squeeze down to `ui-popup` and slip past the prefix check.
  if (s.startsWith('__')) return null;
  s = s
    .replace(/-{2,}/g, '-')
    .replace(/_{2,}/g, '_')
    .replace(/\.{2,}/g, '.');
  s = s.replace(/^[-_.]+/, '').replace(/[-_.]+$/, '');
  if (s.length > 64) s = s.slice(0, 64).replace(/[-_.]+$/, '');
  if (!s) return null;
  if (s === 'default' || s === 'null' || s === 'undefined') return null;
  return s;
}
