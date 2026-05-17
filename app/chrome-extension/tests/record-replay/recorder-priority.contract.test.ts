/**
 * IMP-0099 — Recorder ⇄ Replayer priority ladder contract.
 *
 * This is the back-compat regression guard: it pins the runtime invariant
 * that `compareSelectorCandidates` re-sorts candidates by stability+weight
 * regardless of the order they were recorded in. Old flows (pre-IMP-0099)
 * stored candidates in a hand-rolled order with structural css-path as the
 * primary. New flows (post-IMP-0099) store them in the Playwright ladder
 * (testid > aria > label > placeholder > alt > title > text > css > ...).
 *
 * Both must produce the SAME resolved candidate when fed to
 * `compareSelectorCandidates`, because the runtime's `SelectorLocator.locate`
 * re-sorts and iterates without trusting the recorded order.
 */

import { describe, expect, it } from 'vitest';
import {
  compareSelectorCandidates,
  generateExtendedSelectorTarget,
  withStability,
} from '@/shared/selector';
import type { SelectorCandidate } from '@/shared/selector';

describe('IMP-0099 contract: legacy flows still resolve via runtime re-sort', () => {
  it('an old recording with css-path-first ordering is still topped by testid after re-sort', () => {
    // Simulate an "old" recording produced by the pre-IMP-0099 recorder, where
    // SelectorEngine._choosePrimary preferred nth-of-type CSS as primary.
    const oldRecording: SelectorCandidate[] = [
      {
        type: 'css',
        value: 'body > div:nth-of-type(2) > section > button:nth-of-type(3)',
        source: 'recorded',
        strategy: 'css-path',
      },
      {
        type: 'attr',
        value: '[data-testid="confirm-btn"]',
        source: 'recorded',
        strategy: 'testid',
      },
      {
        type: 'aria',
        value: 'button[name="Confirm"]',
        role: 'button',
        name: 'Confirm',
        source: 'recorded',
        strategy: 'aria',
      },
    ];

    const sorted = oldRecording.map(withStability).sort(compareSelectorCandidates);
    // The runtime re-sort surfaces testid first even though it was recorded
    // as candidates[1].
    expect(sorted[0].value).toBe('[data-testid="confirm-btn"]');
  });

  it('an old recording with aria-style strings still resolves via type-priority fallback', () => {
    // A pre-IMP-0099 recording where the only candidate was a "free-form"
    // aria expression (the old SelectorEngine emitted `${role}[name=${aria}]`
    // without weight or stability metadata).
    const oldRecording: SelectorCandidate[] = [
      {
        type: 'aria',
        value: 'textbox[name=Email address]',
        // intentionally no weight, no stability — pre-IMP-0099 shape
      },
      {
        type: 'css',
        value: 'body > main:nth-of-type(1) > form > input:nth-of-type(1)',
      },
    ];

    const sorted = oldRecording.map(withStability).sort(compareSelectorCandidates);
    // aria has higher stability than nth-of-type css-path; sort surfaces it.
    expect(sorted[0].type).toBe('aria');
  });

  it('new recordings emit candidates in priority order; runtime sort is a no-op', () => {
    // Generate a fresh recording for a typical button with testid + text +
    // structural fallback. Verify the order coming out of the generator is
    // already what the runtime sort would produce.
    document.body.innerHTML = `
      <main>
        <section>
          <button data-testid="cta" class="btn primary">Click me</button>
        </section>
      </main>
    `;
    const btn = document.querySelector('button')!;
    const target = generateExtendedSelectorTarget(btn);

    const recordedOrder = target.candidates.map((c) => c.value);
    const reSorted = target.candidates
      .slice()
      .sort(compareSelectorCandidates)
      .map((c) => c.value);

    expect(recordedOrder).toEqual(reSorted);
    // And the leader is testid (highest weight).
    expect(target.candidates[0].strategy).toBe('testid');
  });

  it('mixing old + new candidate shapes still surfaces the most stable one', () => {
    // Imagine a recording was captured under the old recorder and then
    // partially upgraded (e.g. a manual edit added a testid candidate). The
    // runtime should still pick the best.
    const mixed: SelectorCandidate[] = [
      {
        type: 'css',
        value: 'body > div > div:nth-of-type(4) > a:nth-of-type(2)',
        source: 'recorded',
      },
      {
        type: 'css',
        value: '.product-card-cta',
        source: 'recorded',
      },
      // freshly added testid from a manual edit
      {
        type: 'attr',
        value: '[data-testid="product-cta"]',
        weight: 50,
        source: 'user',
        strategy: 'testid',
      },
    ];

    const sorted = mixed.map(withStability).sort(compareSelectorCandidates);
    expect(sorted[0].value).toBe('[data-testid="product-cta"]');
  });
});

describe('IMP-0099 contract: primary selector remains a CSS-resolvable string', () => {
  it('every generated target.selector is parseable as a CSS query', () => {
    // The locator's fast-path treats target.selector as a CSS string. Even
    // when candidates[0] is a text/aria locator, target.selector falls back
    // to the best CSS/attr candidate so the fast-path call doesn't error.
    document.body.innerHTML = `
      <div>
        <button>Subscribe</button>
        <input placeholder="Email" />
        <a href="/">Home</a>
      </div>
    `;
    const els = Array.from(document.querySelectorAll('button, input, a'));
    for (const el of els) {
      const target = generateExtendedSelectorTarget(el);
      expect(target.selector).toBeDefined();
      // querySelectorAll must accept the primary selector without throwing.
      expect(() => document.querySelectorAll(target.selector!)).not.toThrow();
    }
  });
});
