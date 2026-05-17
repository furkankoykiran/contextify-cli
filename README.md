# Contextify CLI

> **Open-source CLI for Claude Code: capture sessions, ship transcripts to your memory pipeline, and synthesize Claude-ready prompts.**

[![npm version](https://img.shields.io/npm/v/@furkankoykiran/contextify-cli.svg)](https://www.npmjs.com/package/@furkankoykiran/contextify-cli)
[![npm downloads](https://img.shields.io/npm/dm/@furkankoykiran/contextify-cli.svg)](https://www.npmjs.com/package/@furkankoykiran/contextify-cli)
[![CI](https://github.com/furkankoykiran/contextify-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/furkankoykiran/contextify-cli/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node ≥ 20](https://img.shields.io/badge/node-%E2%89%A520.19-brightgreen.svg)](.nvmrc)

`contextify` is the capture half of [Contextify](https://contextify.live) — a closed-loop prompt factory and project memory for Claude Code. It hooks into [Anthropic Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions on your machine, ships transcripts to your memory pipeline, and turns drafts into Claude-ready prompts grounded in everything your project has already learned.

The CLI is **MIT-licensed and contribution-friendly**. The backend (web app, worker, prompt synthesizer) is closed-source.

## Why use this

- **Claude Code transcript capture** — every `SessionStart`, `Stop`, and `SessionEnd` event is shadowed and streamed without disrupting your flow.
- **Project memory grounding** — turn a one-line draft into a multi-section, memory-augmented Claude Code prompt with `contextify prompt`.
- **Zero per-project config** — `project_id` is derived from each session's `cwd` at fire-time. Install once, capture everywhere.
- **Bring your own server** — point `CONTEXTIFY_SERVER_URL` at `https://contextify.live` or self-host the backend.

## Install

```bash
pnpm add -g @furkankoykiran/contextify-cli
# or
npm i -g @furkankoykiran/contextify-cli
```

## Quick start

1. Create an API key at [https://contextify.live/dashboard/keys](https://contextify.live/dashboard/keys).
2. Export the key and the server URL:
   ```bash
   export CONTEXTIFY_API_KEY="ctx_live_..."
   export CONTEXTIFY_SERVER_URL="https://contextify.live"
   ```
3. Install the Claude Code hooks (once per machine):
   ```bash
   contextify install
   ```

That's it — every Claude Code session is now captured. Inspect captures and synthesized memories at [https://contextify.live/dashboard](https://contextify.live/dashboard).

## Commands

| Command                                                                  | What it does                                                                                 |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `contextify install [--key <ctx_live_...>] [--server <url>] [--dry-run]` | Wires SessionStart / Stop / SessionEnd into `~/.claude/settings.json`. Run once per machine. |
| `contextify init [projectId] [--name <name>] [--server <url>]`           | Pin a project id by writing `.contextify.json` in the current directory.                     |
| `contextify wrap -- <cmd> [args...]`                                     | Run any command, mirror its output, and ship the capture in batches.                         |
| `contextify login --key <ctx_live_...>`                                  | Persist a key to `~/.contextify/credentials.json` (chmod 600).                               |
| `contextify ship --once`                                                 | Flush locally-spooled batches left over from offline runs.                                   |
| `contextify prompt <draft\|-> [--top-k N] [--show-memories] [--json]`    | Build an XML prompt augmented with project memories. Pass `-` to read from stdin.            |
| `contextify hooks <session-start\|stop\|session-end>`                    | Internal — invoked by Claude Code hook scripts.                                              |
| `contextify --version`                                                   | Print the CLI version.                                                                       |

## Environment

| Variable                | Purpose                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| `CONTEXTIFY_API_KEY`    | Bearer key used to authenticate every request. Wins over `~/.contextify/credentials.json`. |
| `CONTEXTIFY_SERVER_URL` | Target server. Defaults to `https://contextify.live`.                                      |
| `CONTEXTIFY_PROJECT_ID` | Override the auto-derived project id.                                                      |
| `CONTEXTIFY_STATE_DIR`  | Override the `~/.contextify` state directory.                                              |
| `CLAUDE_SETTINGS_PATH`  | Override the `~/.claude/settings.json` path (useful for tests).                            |

## How project identity is resolved

Project id resolution stack, first match wins:

1. `CONTEXTIFY_PROJECT_ID` (env)
2. `.contextify.json` in the current dir or an ancestor (`projectId` field)
3. Git remote URL of the enclosing repo
4. `realpath` of the current directory

## Development

```bash
git clone https://github.com/furkankoykiran/contextify-cli.git
cd contextify-cli
pnpm install
pnpm build
pnpm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow.

## Related

- [Contextify](https://contextify.live) — the hosted prompt factory + project memory.
- [Anthropic Claude Code](https://docs.anthropic.com/en/docs/claude-code) — the official CLI this tool hooks into.

## License

[MIT](LICENSE) © Furkan Köykıran
