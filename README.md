# @furkankoykiran/contextify-cli

**Telemetry CLI for Contextify — shadows your Claude Code sessions and ships them to your project's memory.**

Pairs with [Contextify](https://contextify.live), a closed-loop prompt factory: every session you run feeds back into your next prompt. This CLI is the capture half.

## Install

```bash
pnpm add -g @furkankoykiran/contextify-cli
# or
npm i -g @furkankoykiran/contextify-cli
```

## Quick start

1. Create an API key at https://contextify.live/dashboard/keys
2. Export the key and the server URL:
   ```bash
   export CONTEXTIFY_API_KEY="ctx_live_..."
   export CONTEXTIFY_SERVER_URL="https://contextify.live"
   ```
3. Install the Claude Code hooks (once per machine):
   ```bash
   contextify install
   ```

That's it — every Claude Code session is now captured. `project_id` is derived from each session's `cwd` at fire-time, so no per-project config is needed. Inspect captures and synthesized memories at https://contextify.live/dashboard.

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

## How identity is resolved

Project id resolution stack, first match wins:

1. `CONTEXTIFY_PROJECT_ID` (env)
2. `.contextify.json` in the current dir or an ancestor (`projectId` field)
3. Git remote URL of the enclosing repo
4. `realpath` of the current directory

## License

MIT
