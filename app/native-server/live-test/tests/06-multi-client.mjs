/**
 * 06 — Per-client preferred-tab isolation.
 *
 * Two MCP clients (A, B) each open their own tab. Then each issues a
 * tool call WITHOUT an explicit tabId. Each call should target its own
 * client's preferred tab — not whichever happens to be UI-active.
 */
import { outcome, PASS, FAIL } from '../assertions.mjs';

export default [
  {
    name: '06-multi-client:implicit-tab-stays-with-each-client',
    async run({ A, B, fixtureBase }) {
      const navA = await A.callTool('chrome_navigate', { url: `${fixtureBase}/index.html` });
      const tabA = A.parseTextPayload(navA)?.tabId;
      const navB = await B.callTool('chrome_navigate', { url: `${fixtureBase}/long-page.html` });
      const tabB = B.parseTextPayload(navB)?.tabId;

      if (typeof tabA !== 'number' || typeof tabB !== 'number' || tabA === tabB) {
        return [
          outcome({
            name: this.name,
            status: FAIL,
            expected: 'two distinct tabIds, one per client',
            got: { tabA, tabB },
            note: 'precondition failed',
          }),
        ];
      }
      await new Promise((r) => setTimeout(r, 200));

      // Each client reads document.location WITHOUT passing tabId — should
      // hit its own preferred tab.
      const [readA, readB] = await Promise.all([
        A.callTool('chrome_javascript', { code: 'location.pathname' }),
        B.callTool('chrome_javascript', { code: 'location.pathname' }),
      ]);

      const aPath = A.parseTextPayload(readA)?.result;
      const bPath = B.parseTextPayload(readB)?.result;
      const aTabUsed = A.parseTextPayload(readA)?.tabId;
      const bTabUsed = B.parseTextPayload(readB)?.tabId;

      const ok =
        typeof aPath === 'string' &&
        typeof bPath === 'string' &&
        aPath.includes('index.html') &&
        bPath.includes('long-page.html') &&
        aTabUsed === tabA &&
        bTabUsed === tabB;

      return [
        outcome({
          name: this.name,
          status: ok ? PASS : FAIL,
          expected: {
            aPath: '*/index.html (tabA)',
            bPath: '*/long-page.html (tabB)',
            aTabUsed: tabA,
            bTabUsed: tabB,
          },
          got: { aPath, bPath, aTabUsed, bTabUsed, tabA, tabB },
          tool: 'chrome_javascript (no tabId)',
          client: 'A+B',
        }),
      ];
    },
  },
];
