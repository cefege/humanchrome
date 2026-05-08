# Capture-pipeline golden fixtures

Static HTML fixtures for snapshot-style tests that verify the capture
pipeline (web-fetcher's HTML extraction, the cleaning passes, etc.) doesn't
silently regress when upstream dependencies (Readability, jsdom, the
extension's content scripts) change.

## How to add a fixture

1. Drop a small HTML file in this directory. Name it after the scenario
   it covers (`sticky-header.html`, `lazy-images.html`, `spa-stub.html`).
2. Add a test in `../../web-fetcher.golden.test.ts` (or a sibling) that
   loads the fixture, runs the cleaning pipeline against it, and snapshots
   the output via vitest's `toMatchSnapshot()`. First run creates the
   `__snapshots__/<test-name>.snap` file; subsequent runs compare.
3. Commit the fixture, the test file change, and the generated snapshot.

## What this catches

The unit tests in `tests/tools/browser/web-fetcher.test.ts` mock the
content-script response shape and assert specific calls — they don't
exercise the actual HTML processing pipeline. Golden snapshots catch
silent output regressions that pass type-checks and unit tests because
the _shape_ didn't change but the _content_ did:

- Readability bumps changing the extracted text
- jsdom version bumps changing how the DOM is serialised
- Cleaning-pass tweaks that drop or add whitespace, attributes, etc.
- Content scripts that shift class-stripping heuristics

## Why fixtures live here

Co-located with the tests so the failure context is right next to the
expected output. The vitest snapshot file generated next to the test
captures the canonical serialisation; diffs in CI surface the change for
review rather than silently shifting behaviour.
