/**
 * Golden-fixture snapshot tests for the capture pipeline.
 *
 * Loads the static HTML fixtures from tests/fixtures/pages/, parses them
 * in jsdom (the vitest environment), and snapshots the key extractable
 * structures. Runs as a regular vitest test — no real browser needed.
 *
 * The point isn't to test the actual content scripts (those run in the
 * page context, not jsdom). It's to lock the canonical *shape* of each
 * fixture so when a scout/cron rebuilds against a new Chrome version, a
 * new Readability release, or a refactored content script, the diff
 * surfaces visibly via snapshot mismatches rather than silently shifting.
 *
 * To extend: add a fixture under tests/fixtures/pages/, add a test here
 * that parses + snapshots the relevant slice, commit the generated
 * __snapshots__/ entry. See pages/README.md for guidelines.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(here, 'pages');

function loadFixture(name: string): Document {
  const html = fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf-8');
  // jsdom is the vitest environment for this suite; new DOMParser uses it.
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('article-with-noise.html — golden snapshot of structure', () => {
  it('parses the expected top-level structure', () => {
    const doc = loadFixture('article-with-noise.html');

    // Document title is the static one; the inline <script> would mutate
    // it at runtime in a real browser, but jsdom doesn't execute the
    // script, so we see the literal value. That's intentional: the
    // snapshot pins what static parsing produces, separate from any
    // runtime DOM mutation.
    expect(doc.title).toBe('Sample Article');

    // Capture the section landmarks the fixture promises so any future
    // restructuring of the fixture is caught.
    const landmarks = {
      hasNav: !!doc.querySelector('nav.top-nav'),
      hasHeader: !!doc.querySelector('header.site-header'),
      hasArticle: !!doc.querySelector('article'),
      hasSidebar: !!doc.querySelector('aside.sidebar'),
      hasFooter: !!doc.querySelector('footer'),
    };
    expect(landmarks).toMatchInlineSnapshot(`
      {
        "hasArticle": true,
        "hasFooter": true,
        "hasHeader": true,
        "hasNav": true,
        "hasSidebar": true,
      }
    `);
  });

  it('article body contains the expected paragraphs and headings', () => {
    const doc = loadFixture('article-with-noise.html');
    const article = doc.querySelector('article');
    if (!article) throw new Error('article element missing from fixture');

    const headings = Array.from(article.querySelectorAll('h2')).map((h) => h.textContent?.trim());
    const paragraphCount = article.querySelectorAll('p').length;
    const listItemCount = article.querySelectorAll('li').length;

    expect({ headings, paragraphCount, listItemCount }).toMatchInlineSnapshot(`
      {
        "headings": [
          "Introduction",
          "A subsection",
        ],
        "listItemCount": 2,
        "paragraphCount": 3,
      }
    `);
  });

  it('footer text exists in the document but is outside the article (Readability should drop it)', () => {
    const doc = loadFixture('article-with-noise.html');
    const footerText = doc.querySelector('footer')?.textContent?.trim() ?? '';
    expect(footerText).toContain('Footer text');

    // The footer must NOT be a descendant of <article>; this is the
    // invariant Readability relies on to keep noise out of the extracted
    // body text. If a future fixture refactor moves the footer inside
    // article, the assertion fires and the cleaning expectations need
    // to change with it.
    const article = doc.querySelector('article');
    expect(article?.contains(doc.querySelector('footer'))).toBe(false);
  });
});
