#!/usr/bin/env node
/**
 * contextify — telemetry CLI.
 *
 * Commands:
 *   contextify init [projectId] [--name <name>] [--server <url>] [--install-hooks] [--force]
 *   contextify wrap -- <cmd> [args...]
 *   contextify ship --once
 *   contextify hooks <session-start|stop|session-end>
 *   contextify --version
 *   contextify --help
 */
import { runCompile, type CompileMode } from './commands/compile.js';
import { runHook, type HookEvent } from './commands/hooks.js';
import { runInit } from './commands/init.js';
import { runInstall } from './commands/install.js';
import { runLogin } from './commands/login.js';
import { runPrompt } from './commands/prompt.js';
import { runShip } from './commands/ship.js';
import { parseUpdateArgs, runUpdateCommand } from './commands/update.js';
import { runWrap } from './commands/wrap.js';
import { runNotifier } from './updater.js';

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version?: unknown };

export const VERSION = typeof pkg.version === 'string' ? pkg.version : '0.0.0';

const HELP_TEXT = `contextify — telemetry CLI (v${VERSION})

Usage:
  contextify install [--key <ctx_live_...>] [--server <url>] [--name <label>] [--dry-run]
      Install Contextify hooks into ~/.claude/settings.json so every
      Claude Code session is captured. Run once per machine — no
      per-project setup required. project_id is derived from each
      session's cwd at fire-time.

      If --key (or CONTEXTIFY_API_KEY in env) is present, the key is
      persisted to ~/.contextify/credentials.json (chmod 600) so the
      IDE-spawned hook subprocess can authenticate. Without it, hooks
      ship unauthenticated and the server may reject the request.

  contextify init [projectId] [--name <name>] [--server <url>] [--install-hooks] [--force]
      Write .contextify.json in the current directory to PIN a project
      to an explicit id (useful when you want stable identity across
      machines via a committed file). When projectId is omitted,
      identity is derived from .contextify.json in an ancestor, git
      remote, or folder realpath (in that order).

  contextify wrap -- <cmd> [args...]
      Spawn the command, mirror its output to your terminal, and ship the
      capture to the Contextify server in batches.

  contextify login --key <ctx_live_...> [--server <url>] [--name <label>]
      Save an API key issued by /dashboard/keys to
      ~/.contextify/credentials.json (chmod 600). All subsequent
      requests send Authorization: Bearer <key>. The CONTEXTIFY_API_KEY
      env var, if set, still wins over this file.

  contextify ship --once
      Flush any locally-spooled batches (left over from offline runs).

  contextify compile <intent|-> [--raw|--paste|--claude] [--top-k N]
      Compile a Claude-Code-ready XML prompt from an intent draft. Default
      is --raw (XML to stdout, pipe-friendly). --paste copies to the system
      clipboard. --claude copies to clipboard and prints a stderr tip for
      Claude Code paste. Pass '-' to read the intent from stdin.

  contextify prompt <draft|-> [--top-k N] [--show-memories] [--json]
      DEPRECATED — use 'contextify compile' instead. Will be removed in a
      future minor. Same server engine as 'compile'; only the flags differ.

  contextify hooks <session-start|stop|session-end|user-prompt-submit|post-tool-use>
      Internal: invoked by Claude Code hook scripts. Reads the hook
      payload from stdin and ships the matching event (dialog turn,
      user prompt, or tool execution) to the server.

  contextify update [--check] [--force]
      Pull the latest published CLI from npm via the package manager
      that owns the running binary (npm/pnpm/yarn). Pass --check to
      print the upgrade command without executing it. Pass --force to
      install @latest even when the registry probe failed (may downgrade
      if you're running a prerelease build).

  contextify --version
  contextify --help

Environment:
  CONTEXTIFY_SERVER_URL       override server URL
  CONTEXTIFY_PROJECT_ID       override project id
  CONTEXTIFY_STATE_DIR        override ~/.contextify state directory
  CLAUDE_SETTINGS_PATH        override ~/.claude/settings.json path
  CONTEXTIFY_NO_UPDATE_CHECK  set to 1 to silence the update notifier
`;

export interface CliEntry {
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export async function main(entry: CliEntry): Promise<number> {
  const argv = [...entry.argv];
  const cwd = entry.cwd ?? process.cwd();
  const env = entry.env ?? process.env;

  // Strip --no-update-check only when it appears BEFORE the subcommand and
  // BEFORE any `--` separator. Otherwise a command like
  // `contextify wrap -- mycmd --no-update-check` would silently drop the flag
  // meant for the wrapped child process.
  const noUpdateFlag = stripGlobalFlag(argv, '--no-update-check');

  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  const command = argv.shift();
  const code = await dispatch(command, argv, { cwd, env });

  // Notifier runs after dispatch so it never delays the user's command.
  // Skip for machine-driven commands (hooks fire from Claude Code, ship is
  // batched flush — both can land in logs) and for the update command itself.
  const skipNotifier =
    noUpdateFlag || command === 'hooks' || command === 'ship' || command === 'update';
  if (!skipNotifier) {
    try {
      await runNotifier({ env, currentVersion: VERSION });
    } catch {
      // Notifier failures must never affect the user's exit code.
    }
  }

  return code;
}

async function dispatch(
  command: string | undefined,
  argv: string[],
  ctx: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<number> {
  switch (command) {
    case 'init':
      return runInit(parseInitArgs(argv), ctx.cwd);
    case 'install':
      return runInstall(parseInstallArgs(argv), { env: ctx.env });
    case 'login':
      return runLogin(parseLoginArgs(argv));
    case 'wrap':
      return runWrap({ argv: extractWrapArgv(argv), cwd: ctx.cwd, env: ctx.env });
    case 'ship':
      return runShip({ cwd: ctx.cwd, env: ctx.env });
    case 'compile':
      return runCompile(parseCompileArgs(argv), { cwd: ctx.cwd, env: ctx.env });
    case 'prompt':
      process.stderr.write(
        "contextify: 'prompt' is deprecated; use 'contextify compile' instead.\n",
      );
      return runPrompt(parsePromptArgs(argv), { cwd: ctx.cwd, env: ctx.env });
    case 'update':
      return runUpdateCommand(parseUpdateArgs(argv), {
        env: ctx.env,
        currentVersion: VERSION,
      });
    case 'hooks': {
      const event = argv.shift();
      if (!isHookEvent(event)) {
        process.stderr.write(
          `contextify: usage: contextify hooks <session-start|stop|session-end|user-prompt-submit|post-tool-use>\n`,
        );
        return 2;
      }
      return runHook(event, { env: ctx.env });
    }
    default:
      process.stderr.write(`contextify: unknown command '${command}'\n${HELP_TEXT}`);
      return 2;
  }
}

/**
 * Strip a global flag that appears BEFORE the subcommand position and BEFORE
 * any `--` separator. Anything after the subcommand belongs to the subcommand
 * (or, for `wrap --`, to the wrapped child process).
 */
export function stripGlobalFlag(argv: string[], flag: string): boolean {
  let found = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') break;
    if (arg === flag) {
      argv.splice(i, 1);
      found = true;
      i--;
      continue;
    }
    // Once we hit the first non-flag token, that's the subcommand — stop.
    if (!arg.startsWith('-')) break;
  }
  return found;
}

function isHookEvent(s: string | undefined): s is HookEvent {
  return (
    s === 'session-start' ||
    s === 'stop' ||
    s === 'session-end' ||
    s === 'user-prompt-submit' ||
    s === 'post-tool-use'
  );
}

function parseInitArgs(argv: readonly string[]): {
  projectId?: string;
  projectName?: string;
  serverUrl?: string;
  force?: boolean;
  installHooks?: boolean;
} {
  let projectId: string | undefined;
  let projectName: string | undefined;
  let serverUrl: string | undefined;
  let force = false;
  let installHooks = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--name') {
      projectName = argv[++i];
    } else if (arg === '--server') {
      serverUrl = argv[++i];
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--install-hooks') {
      installHooks = true;
    } else if (!arg.startsWith('-') && !projectId) {
      projectId = arg;
    }
  }
  return { projectId, projectName, serverUrl, force, installHooks };
}

function parseInstallArgs(argv: readonly string[]): {
  dryRun?: boolean;
  apiKey?: string;
  serverUrl?: string;
  name?: string;
} {
  let dryRun = false;
  let apiKey: string | undefined;
  let serverUrl: string | undefined;
  let name: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--key') apiKey = argv[++i];
    else if (arg === '--server') serverUrl = argv[++i];
    else if (arg === '--name') name = argv[++i];
  }
  return { dryRun, apiKey, serverUrl, name };
}

function parseLoginArgs(argv: readonly string[]): {
  apiKey?: string;
  serverUrl?: string;
  name?: string;
} {
  let apiKey: string | undefined;
  let serverUrl: string | undefined;
  let name: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--key') {
      apiKey = argv[++i];
    } else if (arg === '--server') {
      serverUrl = argv[++i];
    } else if (arg === '--name') {
      name = argv[++i];
    }
  }
  return { apiKey, serverUrl, name };
}

function parseCompileArgs(argv: readonly string[]): {
  intent: string | null;
  modes: readonly CompileMode[];
  topK?: number;
} {
  let intent: string | null = null;
  let topK: number | undefined;
  const modes: CompileMode[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--top-k') {
      const next = argv[++i];
      const parsed = next !== undefined ? Number.parseInt(next, 10) : NaN;
      topK = Number.isFinite(parsed) ? parsed : Number.NaN;
    } else if (arg === '--raw') {
      modes.push('raw');
    } else if (arg === '--paste') {
      modes.push('paste');
    } else if (arg === '--claude') {
      modes.push('claude');
    } else if (arg === '-' && intent === null) {
      // '-' is equivalent to omitting the positional; runCompile reads stdin.
    } else if (!arg.startsWith('-') && intent === null) {
      intent = arg;
    }
  }
  return { intent, modes, topK };
}

function parsePromptArgs(argv: readonly string[]): {
  draft: string | null;
  topK?: number;
  showMemories?: boolean;
  json?: boolean;
} {
  let draft: string | null = null;
  let topK: number | undefined;
  let showMemories = false;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--top-k') {
      const next = argv[++i];
      const parsed = next !== undefined ? Number.parseInt(next, 10) : NaN;
      topK = Number.isFinite(parsed) ? parsed : Number.NaN;
    } else if (arg === '--show-memories') {
      showMemories = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '-' && draft === null) {
      // Sentinel: read from stdin.
      draft = null;
      // mark explicitly that the user asked for stdin
      // by leaving draft null but blocking the "no draft" branch in runPrompt.
      // We use a string ' __STDIN__' would be hacky; instead, capture
      // the intent via a flag-style approach:
      // — but simplest: leave as null and let runPrompt's stdin path handle it.
      // The positional default below leaves draft === null too, which already
      // triggers stdin reading. So '-' is equivalent to omitting the arg.
    } else if (!arg.startsWith('-') && draft === null) {
      draft = arg;
    }
  }
  return { draft, topK, showMemories, json };
}

/** Extract everything after `--` (or default to the whole argv if no `--`). */
function extractWrapArgv(argv: readonly string[]): string[] {
  const idx = argv.indexOf('--');
  if (idx === -1) return [...argv];
  return argv.slice(idx + 1);
}

/**
 * Auto-run guard. Compares the realpath of process.argv[1] against the
 * realpath of this module — so `npm link` and `npm i -g` (which install
 * a symlink as `bin/contextify`) still trigger main(). The naïve
 * `file://${argv[1]}` equality breaks on symlinks because it compares
 * the symlink path against the module's resolved url.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function isDirectInvocation(): boolean {
  if (!process.argv[1]) return false;
  try {
    const thisFile = realpathSync(fileURLToPath(import.meta.url));
    const entry = realpathSync(process.argv[1]);
    return thisFile === entry;
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  main({ argv: process.argv.slice(2) })
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`${(err as Error).stack ?? err}\n`);
      process.exit(1);
    });
}
