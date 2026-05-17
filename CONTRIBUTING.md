# Contributing to Contextify CLI

Thanks for your interest! This CLI is the open-source half of [Contextify](https://contextify.live) — the part that captures Claude Code sessions and ships transcripts to your memory pipeline. Backend code (web app, worker, prompt synthesis) lives in a private repo.

## Development

Requires Node 20+ and pnpm 9+.

```bash
git clone https://github.com/furkankoykiran/contextify-cli.git
cd contextify-cli
pnpm install
pnpm build
pnpm test
```

## Running locally against your account

```bash
export CONTEXTIFY_API_KEY="ctx_live_..."
export CONTEXTIFY_SERVER_URL="https://contextify.live"
node ./dist/index.js --version
```

Or point at your own server: `export CONTEXTIFY_SERVER_URL="http://localhost:3000"`.

## Workflow

1. **Open an issue first** for non-trivial changes so we can agree on scope before code is written.
2. Fork the repo, branch from `main`, submit a PR back into `main`.
3. CI must pass: `format:check`, `lint`, `typecheck`, `build`, `test`.
4. Follow conventional commit prefixes: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`.

## Code style

Prettier handles formatting. Run `pnpm format` before committing. ESLint enforces the rest — `pnpm lint`.

## Tests

We use [Vitest](https://vitest.dev). Unit tests live next to source files (`foo.test.ts`). The `wrap.integration.test.ts` spawns a real process and runs against the built `dist/`, so build first.

## What we're looking for

- Bug fixes (with a failing test that the fix turns green)
- New `contextify` subcommands that fit the "capture and ship" mandate
- Better error messages
- Cross-platform fixes (we test on Linux + macOS; Windows reports especially welcome)
- Docs improvements

## What's out of scope here

- Backend behavior (auth, ingest, synthesis, dashboard) lives in the closed-source repo. File an issue here and we'll route it.
- Anything that changes the wire protocol must coordinate with the backend; flag it in the issue.

## License

By contributing, you agree your changes ship under the [MIT License](LICENSE).
