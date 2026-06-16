import { createErrorResponse, classifyTabError, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { MAX_RESPONSE_BODY_BYTES } from '../../utils/timeouts';

/**
 * chrome_aria_snapshot — IMP-0127.
 *
 * Playwright-style compact ARIA tree snapshot for token-efficient page
 * reads. Where `chrome_read_page` returns a verbose JSON envelope plus
 * coordinate + attribute decorations on every node, `chrome_aria_snapshot`
 * returns indented role+name pairs with stable refs and nothing else:
 *
 *   - button "Submit" [ref=ref_12]
 *   - link "Privacy" [ref=ref_13]
 *
 * 4-6x smaller than chrome_read_page on rich pages (LinkedIn feed,
 * dashboards). LLMs scan it in ~half the tokens, then pivot to
 * `chrome_click_element({selectorType:'ref', selector:'ref_12'})`.
 *
 * Read-only — no `mutates`. Reuses the existing `accessibility-tree-helper.js`
 * the dispatcher already injects for `chrome_read_page`; this tool is a
 * thin formatter, no new inject-script.
 *
 * Params:
 *   - tabId?, windowId?: standard tab routing
 *   - refId?: snapshot a subtree rooted at this ref (mirrors read_page)
 *   - maxDepth?: clamp traversal depth (helper enforces a hard MAX_DEPTH)
 *   - interactiveOnly?: filter='interactive' (default true). false widens
 *     to 'all' for layout/structure snapshots.
 *   - includeRefs?: print `[ref=...]` markers (default true). false for
 *     pure structure dumps when refs aren't needed.
 */

interface AriaSnapshotParams {
  tabId?: number;
  windowId?: number;
  refId?: string;
  maxDepth?: number;
  interactiveOnly?: boolean;
  includeRefs?: boolean;
}

// 1 MiB cap shared with the network-capture / intercept-response paths.
const MAX_OUTPUT_BYTES = MAX_RESPONSE_BODY_BYTES;

class AriaSnapshotTool extends BaseBrowserToolExecutor {
  name = 'chrome_read_page__aria_internal';

  async execute(args: AriaSnapshotParams = {}): Promise<ToolResult> {
    try {
      const tab = await this.getOwnedTab({
        explicit: args.tabId,
        windowId: args.windowId,
        isRead: true,
      });

      await this.injectContentScript(
        tab.id!,
        ['inject-scripts/accessibility-tree-helper.js'],
        false,
        'ISOLATED',
        true,
      );

      const filter = args.interactiveOnly === false ? 'all' : 'interactive';
      const resp = await this.sendMessageToTab(tab.id!, {
        action: TOOL_MESSAGE_TYPES.GENERATE_ACCESSIBILITY_TREE,
        filter,
        depth: args.maxDepth,
        refId: args.refId || undefined,
      });

      if (!resp || resp.success !== true || typeof resp.pageContent !== 'string') {
        return createErrorResponse(
          resp?.error || 'Failed to generate ARIA snapshot',
          ToolErrorCode.UNKNOWN,
          { refId: args.refId },
        );
      }

      const stripped = formatPageContent(resp.pageContent, {
        includeRefs: args.includeRefs !== false,
      });

      // 1 MiB cap mirrors network-capture / intercept-response. On overflow,
      // truncate by line count (preserves tree structure rather than cutting
      // mid-element). Maintain a running byte total so the loop stays O(N)
      // instead of the O(N²) "re-measure ever-growing acc" pattern.
      let snapshot = stripped;
      let truncated = false;
      // Service workers have no Node `Buffer`. TextEncoder is the
      // standards-compliant UTF-8 byte-length measure.
      const enc = new TextEncoder();
      const originalSize = enc.encode(snapshot).length;
      if (originalSize > MAX_OUTPUT_BYTES) {
        const lines = snapshot.split('\n');
        let bytes = 0;
        let cutAt = 0;
        for (let i = 0; i < lines.length; i++) {
          // +1 for the '\n' joiner (except before the first line).
          const lineBytes = enc.encode(lines[i]).length + (i === 0 ? 0 : 1);
          if (bytes + lineBytes > MAX_OUTPUT_BYTES) break;
          bytes += lineBytes;
          cutAt = i + 1;
        }
        snapshot = lines.slice(0, cutAt).join('\n');
        truncated = true;
      }

      const refMap = Array.isArray(resp.refMap) ? resp.refMap : [];

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              snapshot,
              lineCount: snapshot ? snapshot.split('\n').filter((l) => l.length > 0).length : 0,
              refCount: refMap.length,
              filter,
              stats: resp.stats ?? null,
              viewport: resp.viewport ?? null,
              focus: resp.focus ?? null,
              ...(truncated
                ? {
                    truncation: {
                      truncated: true,
                      originalSize,
                      limit: MAX_OUTPUT_BYTES,
                      unit: 'bytes' as const,
                    },
                  }
                : {}),
            }),
          },
        ],
        isError: false,
      };
    } catch (err) {
      // classifyTabError preserves structured ToolError codes (e.g.
      // TAB_NOT_FOUND from getOwnedTab) and handles the "no tab with id"
      // → TAB_CLOSED mapping.
      return classifyTabError(err, { toolName: 'chrome_read_page' });
    }
  }
}

/**
 * The acc-tree-helper emits lines like:
 *   - button "Submit" [ref=ref_12] (x=120,y=30) id="submit-btn" href="/signup"
 *
 * Strip coordinate + per-element attribute decorations, keep indentation and
 * role/name/ref. Optionally drop the ref marker for pure structure dumps.
 *
 * Implemented as a regex chain on each line — cheap, runs once per snapshot,
 * preserves the indentation prefix that conveys tree depth.
 */
function formatPageContent(pageContent: string, opts: { includeRefs: boolean }): string {
  const out: string[] = [];
  for (const raw of pageContent.split('\n')) {
    if (raw.trim().length === 0) continue;
    let line = raw;
    // Strip coords: ` (x=123,y=456)`
    line = line.replace(/\s+\(x=-?\d+,y=-?\d+\)/, '');
    // Strip element-level attribute decorations (id, href, type, placeholder, disabled, pe=none).
    // Order: stripping ref last so we can optionally drop it after.
    line = line.replace(/\s+id="[^"]*"/g, '');
    line = line.replace(/\s+href="[^"]*"/g, '');
    line = line.replace(/\s+type="[^"]*"/g, '');
    line = line.replace(/\s+placeholder="[^"]*"/g, '');
    line = line.replace(/\s+disabled\b/g, '');
    line = line.replace(/\s+pe=none\b/g, '');
    if (!opts.includeRefs) {
      line = line.replace(/\s+\[ref=[^\]]+\]/g, '');
    }
    out.push(line.trimEnd());
  }
  return out.join('\n');
}

/** Test-only: exposed for unit tests of the formatter. */
export const _formatPageContentForTests = formatPageContent;

export const ariaSnapshotTool = new AriaSnapshotTool();
