/**
 * Agent prompt builders for the web-editor "apply visual edit to source"
 * workflow. Two shapes:
 *   - `buildAgentPrompt(payload)` — single-element edit; emits one prompt
 *     focused on locating a single DOM element (preferring debugSource
 *     when available) and applying the requested change.
 *   - `buildAgentPromptBatch(elements, pageUrl)` — multi-element edit;
 *     emits one prompt that lists all changes and tells the agent to
 *     persist them in one pass.
 *
 * Both produce plain-text instructions consumed by AgentChat. The
 * payload shapes are validated upstream by `normalizers.ts`; these
 * builders trust their inputs to be normalised.
 */

import type { ElementChangeSummary } from '@/common/web-editor-types';
import type { WebEditorApplyPayload } from './normalizers';

/**
 * Build a batch prompt for multiple element changes.
 * Designed for AgentChat integration to apply multiple visual edits at once.
 */
export function buildAgentPromptBatch(
  elements: readonly ElementChangeSummary[],
  pageUrl: string,
): string {
  const lines: string[] = [];

  // Header
  lines.push('You are a senior frontend engineer working in a local codebase.');
  lines.push(
    'Goal: persist a batch of visual edits from the browser into the source code with minimal changes.',
  );
  lines.push('');

  // Page context
  lines.push(`Page URL: ${pageUrl}`);
  lines.push('');

  lines.push('## Batch Changes');
  lines.push(`Total elements: ${elements.length}`);
  lines.push('');
  lines.push(
    'For each element, prefer "source" (file/line/component) when available; otherwise use selectors/fingerprint to locate it.',
  );
  lines.push('');

  // Element details
  elements.forEach((element, index) => {
    const title = element.fullLabel || element.label || element.elementKey;
    lines.push(`### ${index + 1}. ${title}`);
    lines.push(`- elementKey: ${element.elementKey}`);
    lines.push(`- change type: ${element.type}`);

    // Debug source (high-confidence location)
    const ds = element.debugSource ?? element.locator?.debugSource;
    if (ds?.file) {
      const loc = ds.line ? `${ds.file}:${ds.line}${ds.column ? `:${ds.column}` : ''}` : ds.file;
      lines.push(`- source: ${loc}${ds.componentName ? ` (${ds.componentName})` : ''}`);
    }

    // Locator hints for fallback
    if (element.locator?.selectors?.length) {
      lines.push('- selectors:');
      for (const sel of element.locator.selectors.slice(0, 5)) {
        lines.push(`  - ${sel}`);
      }
    }
    if (element.locator?.fingerprint) {
      lines.push(`- fingerprint: ${element.locator.fingerprint}`);
    }
    if (Array.isArray(element.locator?.path) && element.locator.path.length > 0) {
      lines.push(`- path: ${JSON.stringify(element.locator.path)}`);
    }
    if (element.locator?.shadowHostChain?.length) {
      lines.push(`- shadowHostChain: ${JSON.stringify(element.locator.shadowHostChain)}`);
    }
    lines.push('');

    // Net effect details
    const net = element.netEffect;
    lines.push('#### Net Effect (apply these final values)');

    if (net.textChange) {
      lines.push('##### Text');
      lines.push(`- before: ${JSON.stringify(net.textChange.before)}`);
      lines.push(`- after: ${JSON.stringify(net.textChange.after)}`);
      lines.push('');
    }

    if (net.classChanges) {
      lines.push('##### Classes');
      lines.push(`- before: ${net.classChanges.before.join(' ')}`);
      lines.push(`- after: ${net.classChanges.after.join(' ')}`);
      lines.push('');
    }

    if (net.styleChanges) {
      lines.push('##### Styles (before → after)');
      const before = net.styleChanges.before ?? {};
      const after = net.styleChanges.after ?? {};
      const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
      for (const key of Array.from(allKeys).sort()) {
        const beforeVal = before[key] ?? '(unset)';
        const afterRaw = Object.prototype.hasOwnProperty.call(after, key) ? after[key] : '(unset)';
        const afterVal = afterRaw === '' ? '(removed)' : afterRaw;
        if (beforeVal !== afterVal) {
          lines.push(`- ${key}: "${beforeVal}" → "${afterVal}"`);
        }
      }
      lines.push('');
    }

    // Fallback message if no specific changes
    if (!net.textChange && !net.classChanges && !net.styleChanges) {
      lines.push(
        '- No net effect details available; use locator hints to inspect the element in code.',
      );
      lines.push('');
    }
  });

  // Instructions
  lines.push('## How to Apply');
  lines.push('1. Use "source" when available to go directly to the component file.');
  lines.push('2. Otherwise, use selectors/fingerprint/path to locate the element in the codebase.');
  lines.push('3. Apply the net effect with minimal changes and correct styling conventions.');
  lines.push('4. Avoid generated/bundled outputs; update source files only.');
  lines.push('');

  // Output format
  lines.push('## Constraints');
  lines.push('- Make the smallest safe edit possible for each element');
  lines.push(
    '- If Tailwind/CSS Modules/styled-components are used, update the correct styling source',
  );
  lines.push('- Do not change unrelated behavior or formatting');
  lines.push('');

  lines.push(
    '## Output\nApply all the changes in the repo, then reply with a short summary of what file(s) you modified and the exact changes made.',
  );

  return lines.join('\n');
}

export function buildAgentPrompt(payload: WebEditorApplyPayload): string {
  const lines: string[] = [];

  // Header
  lines.push('You are a senior frontend engineer working in a local codebase.');
  lines.push(
    'Goal: persist a visual edit from the browser into the source code with minimal changes.',
  );
  lines.push('');

  // Page context
  lines.push(`Page URL: ${payload.pageUrl}`);
  lines.push('');

  // == Source Location (high-confidence if debugSource available) ==
  const ds = payload.debugSource;
  if (ds?.file) {
    lines.push('## Source Location (from React/Vue debug info)');
    const loc = ds.line ? `${ds.file}:${ds.line}${ds.column ? `:${ds.column}` : ''}` : ds.file;
    lines.push(`- file: ${loc}`);
    if (ds.componentName) lines.push(`- component: ${ds.componentName}`);
    lines.push('');
    lines.push('This is high-confidence source location extracted from framework debug info.');
    lines.push('Start your search here. Only fall back to fingerprint if this file is invalid.');
    lines.push('');
  } else if (payload.targetFile) {
    lines.push(`## Target File (best-effort): ${payload.targetFile}`);
    lines.push(
      'If this path is invalid or points to node_modules, fall back to fingerprint search.',
    );
    lines.push('');
  }

  // == Element Fingerprint ==
  lines.push('## Element Fingerprint');
  lines.push(`- tag: ${payload.fingerprint.tag}`);
  if (payload.fingerprint.id) lines.push(`- id: ${payload.fingerprint.id}`);
  if (payload.fingerprint.classes?.length) {
    lines.push(`- classes: ${payload.fingerprint.classes.join(' ')}`);
  }
  if (payload.fingerprint.text) lines.push(`- text: ${payload.fingerprint.text}`);
  lines.push('');

  // == CSS Selectors (for precise matching) ==
  if (payload.selectorCandidates?.length) {
    lines.push('## CSS Selectors (ordered by specificity)');
    for (const sel of payload.selectorCandidates.slice(0, 5)) {
      lines.push(`- ${sel}`);
    }
    lines.push('');
    lines.push('Use these selectors to grep the codebase if file location is unavailable.');
    lines.push('');
  }

  // == Tech Stack ==
  if (payload.techStackHint?.length) {
    lines.push(`## Tech Stack: ${payload.techStackHint.join(', ')}`);
    lines.push('');
  }

  // == Requested Change ==
  lines.push('## Requested Change');
  lines.push(`- type: ${payload.instruction.type}`);
  lines.push(`- description: ${payload.instruction.description}`);

  if (payload.instruction.type === 'update_text' && payload.instruction.text !== undefined) {
    lines.push(`- new text: ${JSON.stringify(payload.instruction.text)}`);
  }

  // For style updates, show detailed before/after diff if available
  if (payload.instruction.type === 'update_style') {
    const op = payload.operation;
    if (op && (Object.keys(op.before).length > 0 || Object.keys(op.after).length > 0)) {
      lines.push('');
      lines.push('### Style Changes (before → after)');
      const allKeys = new Set([...Object.keys(op.before), ...Object.keys(op.after)]);
      for (const key of allKeys) {
        const before = op.before[key] ?? '(unset)';
        const after = op.after[key] ?? '(removed)';
        if (before !== after) {
          lines.push(`  ${key}: "${before}" → "${after}"`);
        }
      }
      if (op.removed.length > 0) {
        lines.push(`  [Removed]: ${op.removed.join(', ')}`);
      }
    } else if (payload.instruction.style) {
      lines.push(`- style map: ${JSON.stringify(payload.instruction.style, null, 2)}`);
    }
  }
  lines.push('');

  // == Instructions ==
  lines.push('## How to Apply');
  if (ds?.file) {
    lines.push(`1. Open ${ds.file}${ds.line ? ` around line ${ds.line}` : ''}`);
    if (ds.componentName) {
      lines.push(`2. Locate the "${ds.componentName}" component definition`);
    }
    lines.push(
      `3. Find the element matching tag="${payload.fingerprint.tag}"${payload.fingerprint.classes?.length ? ` with classes including "${payload.fingerprint.classes[0]}"` : ''}`,
    );
    lines.push('4. Apply the requested style/text change');
  } else if (payload.targetFile) {
    lines.push(`1. Open ${payload.targetFile}`);
    lines.push('2. Search for the element by matching fingerprint (tag, classes, text)');
    lines.push('3. If not found, use repo-wide search with selectors or class names');
    lines.push('4. Apply the requested change');
  } else {
    lines.push('1. Use repo-wide search (rg) with class names or text from fingerprint');
    if (payload.selectorCandidates?.length) {
      lines.push(`2. Try searching for: "${payload.selectorCandidates[0]}"`);
    }
    lines.push('3. Locate the component/template containing this element');
    lines.push('4. Apply the requested change');
  }
  lines.push('');

  // == Constraints ==
  lines.push('## Constraints');
  lines.push('- Make the smallest safe edit possible');
  if (payload.techStackHint?.includes('Tailwind')) {
    lines.push('- Tailwind detected: prefer updating className over inline styles');
  }
  if (payload.techStackHint?.includes('React') || payload.techStackHint?.includes('Vue')) {
    lines.push('- Update the component source, not generated/bundled code');
  }
  lines.push('- If CSS Modules or styled-components are used, update the correct styling source');
  lines.push('- Do not change unrelated behavior or formatting');
  lines.push('');

  // == Output ==
  lines.push(
    '## Output\nApply the change in the repo, then reply with a short summary of what file(s) you modified and the exact change made.',
  );

  return lines.join('\n');
}
