/**
 * Cross-cutting timeout / size constants for the extension's tool layer.
 *
 * Why centralize: before this file, the same default value (`15000` for
 * await-element / wait-for, `10000` for tab-lock, `60000` for the
 * download-wait + perf-trace ceiling, `1 * 1024 * 1024` for the
 * response-body cap) appeared as a bare literal or a file-local
 * `DEFAULT_TIMEOUT_MS` in 6+ places. Three problems:
 *
 *   1. An LLM reading a tool can't tell if a number is a meaningful
 *      contract or an arbitrary pick.
 *   2. Two files using the "same default" can drift apart if one is
 *      tuned without the other.
 *   3. Caller-facing docs (docs/AGENTS.md mentions "1 MiB body cap")
 *      can get out of sync with the source.
 *
 * Each constant has a one-line WHY. The values themselves are
 * pre-existing — this file is a pure rename, not a behavior change.
 */

/** Default timeout for `chrome_await_element` waits (no element/state goal hit). */
export const DEFAULT_AWAIT_ELEMENT_TIMEOUT_MS = 15_000;

/** Default timeout for the unified `chrome_wait_for` tool. */
export const DEFAULT_WAIT_FOR_TIMEOUT_MS = 15_000;

/** Default timeout for per-tab mutating-call locks (see acquireTabLock). */
export const DEFAULT_TAB_LOCK_TIMEOUT_MS = 10_000;

/** Default ceiling for the download-wait timeout (chrome_handle_download). */
export const DEFAULT_HANDLE_DOWNLOAD_TIMEOUT_MS = 60_000;

/** Hard upper bound for any tool-supplied `timeoutMs` argument we clamp. */
export const MAX_TOOL_TIMEOUT_MS = 300_000;

/** Default ceiling for performance-trace duration. */
export const DEFAULT_PERF_TRACE_MAX_DURATION_MS = 60_000;

/** Hard cap on captured-response-body size, surfaced as the truncation contract in docs/AGENTS.md. */
export const MAX_RESPONSE_BODY_BYTES = 1 * 1024 * 1024;
