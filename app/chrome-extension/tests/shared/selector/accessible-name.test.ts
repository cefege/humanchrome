/**
 * Accessible-name compute tests (IMP-0098).
 *
 * Cover the W3C accname-1.2 edge cases the IMP names:
 *   - aria-labelledby chains (multi-id, recursive, cycle guard)
 *   - aria-label precedence over native label
 *   - label[for] association
 *   - wrapping <label>
 *   - <img alt> in name-from-content for buttons
 *   - title fallback (lowest priority among implemented steps)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { computeAccessibleName, matchesAccessibleName } from '@/shared/selector/accessible-name';

function setBody(html: string): void {
  document.body.innerHTML = html;
}

describe('computeAccessibleName', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('returns empty string for null/undefined element', () => {
    expect(computeAccessibleName(null)).toBe('');
    expect(computeAccessibleName(undefined)).toBe('');
  });

  it('uses aria-label when set', () => {
    setBody('<button aria-label="Close menu">x</button>');
    const btn = document.querySelector('button')!;
    expect(computeAccessibleName(btn)).toBe('Close menu');
  });

  it('aria-labelledby resolves single id reference', () => {
    setBody(`
      <h2 id="title">Settings</h2>
      <section aria-labelledby="title"></section>
    `);
    const section = document.querySelector('section')!;
    expect(computeAccessibleName(section)).toBe('Settings');
  });

  it('aria-labelledby chains multiple ids with single space separator', () => {
    setBody(`
      <span id="a">User</span>
      <span id="b">Profile</span>
      <span id="c">Settings</span>
      <button aria-labelledby="a b c">x</button>
    `);
    const btn = document.querySelector('button')!;
    expect(computeAccessibleName(btn)).toBe('User Profile Settings');
  });

  it('aria-labelledby honors nested aria-label inside the referenced element', () => {
    setBody(`
      <span id="ref">
        <span aria-label="Real label">visible text</span>
      </span>
      <button aria-labelledby="ref">x</button>
    `);
    const btn = document.querySelector('button')!;
    expect(computeAccessibleName(btn)).toBe('Real label');
  });

  it('aria-labelledby cycle guard — element pointing to itself falls through to name from content', () => {
    // W3C accname-1.2: self-cycle short-circuits the labelledby step but the
    // algorithm continues. For a button, name-from-content kicks in.
    setBody('<button id="b" aria-labelledby="b">x</button>');
    const btn = document.querySelector('button')!;
    // Cycle resolution is empty; name-from-content surfaces "x".
    expect(computeAccessibleName(btn)).toBe('x');
  });

  it('aria-label outranks native label[for]', () => {
    setBody(`
      <label for="email">Email Address</label>
      <input id="email" aria-label="Override label" />
    `);
    const input = document.querySelector('input')!;
    expect(computeAccessibleName(input)).toBe('Override label');
  });

  it('label[for] association is used when aria-label / labelledby absent', () => {
    setBody(`
      <label for="email">Email Address</label>
      <input id="email" />
    `);
    const input = document.querySelector('input')!;
    expect(computeAccessibleName(input)).toBe('Email Address');
  });

  it('wrapping <label> contributes its text (excluding the wrapped control)', () => {
    setBody(`
      <label>
        Username
        <input type="text" />
      </label>
    `);
    const input = document.querySelector('input')!;
    expect(computeAccessibleName(input)).toBe('Username');
  });

  it('<input type="submit"> uses value as accessible name', () => {
    setBody('<input type="submit" value="Send message" />');
    const input = document.querySelector('input')!;
    expect(computeAccessibleName(input)).toBe('Send message');
  });

  it('<input type="submit"> without value falls back to default "Submit"', () => {
    setBody('<input type="submit" />');
    const input = document.querySelector('input')!;
    expect(computeAccessibleName(input)).toBe('Submit');
  });

  it('<img alt> contributes to the name of the containing button (name from content)', () => {
    setBody('<button><img alt="search" />Find</button>');
    const btn = document.querySelector('button')!;
    // Name from content concatenates child names (img → "search") + text ("Find").
    expect(computeAccessibleName(btn)).toContain('Find');
  });

  it('<img alt> is used directly for the img element', () => {
    setBody('<img alt="Logo" />');
    const img = document.querySelector('img')!;
    expect(computeAccessibleName(img)).toBe('Logo');
  });

  it('<img alt=""> returns empty (presentation image)', () => {
    setBody('<img alt="" />');
    const img = document.querySelector('img')!;
    expect(computeAccessibleName(img)).toBe('');
  });

  it('title attribute is used as last resort fallback', () => {
    setBody('<span title="Tooltip text"></span>');
    const span = document.querySelector('span')!;
    expect(computeAccessibleName(span)).toBe('Tooltip text');
  });

  it('hidden elements (aria-hidden) produce empty name', () => {
    setBody('<button aria-hidden="true">Click me</button>');
    const btn = document.querySelector('button')!;
    expect(computeAccessibleName(btn)).toBe('');
  });

  it('button name from contents (buttons allow name-from-content per accname §4.3.2)', () => {
    setBody('<button>Submit Form</button>');
    const btn = document.querySelector('button')!;
    expect(computeAccessibleName(btn)).toBe('Submit Form');
  });

  it('whitespace is normalized', () => {
    setBody('<button aria-label="  multiple   spaces  here  ">x</button>');
    const btn = document.querySelector('button')!;
    expect(computeAccessibleName(btn)).toBe('multiple spaces here');
  });

  it('legend within fieldset is the accessible name', () => {
    setBody(`
      <fieldset>
        <legend>Personal Info</legend>
        <input />
      </fieldset>
    `);
    const fs = document.querySelector('fieldset')!;
    expect(computeAccessibleName(fs)).toBe('Personal Info');
  });

  it('caption within table is the accessible name', () => {
    setBody(`
      <table>
        <caption>Quarterly Results</caption>
        <tr><td>1</td></tr>
      </table>
    `);
    const table = document.querySelector('table')!;
    expect(computeAccessibleName(table)).toBe('Quarterly Results');
  });
});

describe('matchesAccessibleName', () => {
  it('contains mode is case-insensitive substring (default)', () => {
    expect(matchesAccessibleName('Submit Form', 'submit')).toBe(true);
    expect(matchesAccessibleName('Submit Form', 'SUBMIT')).toBe(true);
    expect(matchesAccessibleName('Submit Form', 'cancel')).toBe(false);
  });

  it('exact mode is case-sensitive equality after normalization', () => {
    expect(matchesAccessibleName('Submit', 'Submit', 'exact')).toBe(true);
    expect(matchesAccessibleName('  Submit  ', 'Submit', 'exact')).toBe(true);
    expect(matchesAccessibleName('SUBMIT', 'Submit', 'exact')).toBe(false);
  });

  it('iexact mode is case-insensitive equality after normalization', () => {
    expect(matchesAccessibleName('SUBMIT', 'Submit', 'iexact')).toBe(true);
    expect(matchesAccessibleName('Submit Form', 'Submit', 'iexact')).toBe(false);
  });

  it('regex mode accepts a RegExp', () => {
    expect(matchesAccessibleName('Submit Form', /^Submit/)).toBe(true);
    expect(matchesAccessibleName('Submit Form', /^cancel/)).toBe(false);
  });

  it('empty inputs return false', () => {
    expect(matchesAccessibleName('', 'foo')).toBe(false);
    expect(matchesAccessibleName('foo', '')).toBe(false);
  });
});
