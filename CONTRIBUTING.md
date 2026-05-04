# Contributing to HumanChrome

Thanks for considering a contribution. This file covers how to set up the repo, what kind of changes are welcome, and the conventions used for commits and pull requests.

## Setup

Prerequisites: Node 20+, pnpm, Chrome (or Chromium), Git. Optional: Rust + wasm-pack if you're touching the SIMD math package.

```bash
git clone https://github.com/cefege/humanchrome.git
cd humanchrome
pnpm install
pnpm build:shared
pnpm build:native
pnpm build:extension
```

Load the extension in Chrome:

1. Go to `chrome://extensions/` and enable Developer mode.
2. Click "Load unpacked" and choose `app/chrome-extension/.output/chrome-mv3/`.
3. Click the extension icon, then **Connect**.

For day-to-day development, run `pnpm dev` from the repo root. It rebuilds the shared package first, then runs all packages in watch mode.

## What's welcome

- Bug reports and bug fixes.
- New tools (see "Adding a tool" below).
- Workflow regression fixes (especially LinkedIn, WhatsApp Web, Tinder, or other adversarial-traffic sites).
- Test coverage gaps. The live-test harness under `app/native-server/live-test/` always wants more cases.
- Documentation improvements.
- Performance work in the WASM SIMD math package.

## What is out of scope right now

- Firefox support. Manifest V3 + native messaging in Firefox needs a separate code path. Open an issue if you want it; don't send a PR before discussion.
- Translations. The extension is English-only on purpose right now.
- Visual redesigns of the popup or sidepanel without a clear UX rationale.

## Adding a tool

1. Define the schema in `packages/shared/src/tools.ts` with a name, description, and JSON Schema for the inputs.
2. Implement the executor under `app/chrome-extension/entrypoints/background/tools/browser/<your-tool>.ts`. Extend `BaseBrowserToolExecutor`.
3. Register it in `app/chrome-extension/entrypoints/background/tools/index.ts`.
4. Add a smoke-test entry in `app/chrome-extension/smoke-test.mjs` and (where relevant) a live-test in `app/native-server/live-test/tests/`.
5. Update `docs/TOOLS.md`.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/). Common prefixes:

- `feat:` — new user-visible capability.
- `fix:` — bug fix.
- `docs:` — documentation only.
- `refactor:` — internal restructuring with no behavior change.
- `test:` — test-only changes.
- `chore:` — tooling, dependencies, build config.

Keep the subject line under 72 characters. Body wraps at 72.

## Pull requests

1. Branch from `main`.
2. Run `pnpm lint && pnpm typecheck && pnpm build` before opening.
3. Run the smoke tests:
   ```bash
   cd app/native-server && node smoke-test.mjs
   cd app/chrome-extension && node smoke-test.mjs
   ```
4. Describe what changed, why, and what you tested. Screenshots help for UI changes.
5. One topic per PR. If you find yourself writing "also" in the description, split it up.

## Code style

- TypeScript strict mode. No implicit `any`.
- ESLint and Prettier are wired into pre-commit via `lint-staged`. They'll auto-fix what they can.
- Default to no comments. Add one when the _why_ is non-obvious.
- Avoid backwards-compatibility shims for code paths nobody depends on yet.

## Reporting bugs

Use the bug report template at <https://github.com/cefege/humanchrome/issues/new/choose>. Include:

- Bridge version (`humanchrome-bridge -V`).
- Chrome version.
- OS.
- The MCP client you're using (Claude Desktop, Cursor, etc.) or the HTTP curl you sent.
- Output of `humanchrome-bridge doctor`.
- A copy-pasteable repro.

## License

By contributing, you agree that your contributions are licensed under the MIT License.
