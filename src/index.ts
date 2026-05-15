#!/usr/bin/env node
/**
 * contextify — telemetry CLI.
 *
 * Commands:
 *   contextify init <projectId> [--name <name>] [--server <url>] [--force]
 *   contextify wrap -- <cmd> [args...]
 *   contextify ship --once
 *   contextify --version
 *   contextify --help
 */
import { runInit } from './commands/init.js';
import { runShip } from './commands/ship.js';
import { runWrap } from './commands/wrap.js';

export const VERSION = '0.1.0';

const HELP_TEXT = `contextify — telemetry CLI (v${VERSION})

Usage:
  contextify init <projectId> [--name <name>] [--server <url>] [--force]
      Write .contextify.json in the current directory.

  contextify wrap -- <cmd> [args...]
      Spawn the command, mirror its output to your terminal, and ship the
      capture to the Contextify server in batches.

  contextify ship --once
      Flush any locally-spooled batches (left over from offline runs).

  contextify --version
  contextify --help

Environment:
  CONTEXTIFY_SERVER_URL   override server URL
  CONTEXTIFY_PROJECT_ID   override project id
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

  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  const command = argv.shift();
  switch (command) {
    case 'init':
      return runInit(parseInitArgs(argv), cwd);
    case 'wrap':
      return runWrap({ argv: extractWrapArgv(argv), cwd, env });
    case 'ship':
      return runShip({ cwd, env });
    default:
      process.stderr.write(`contextify: unknown command '${command}'\n${HELP_TEXT}`);
      return 2;
  }
}

function parseInitArgs(argv: readonly string[]): {
  projectId: string;
  projectName?: string;
  serverUrl?: string;
  force?: boolean;
} {
  let projectId = '';
  let projectName: string | undefined;
  let serverUrl: string | undefined;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--name') {
      projectName = argv[++i];
    } else if (arg === '--server') {
      serverUrl = argv[++i];
    } else if (arg === '--force') {
      force = true;
    } else if (!arg.startsWith('-') && !projectId) {
      projectId = arg;
    }
  }
  return { projectId, projectName, serverUrl, force };
}

/** Extract everything after `--` (or default to the whole argv if no `--`). */
function extractWrapArgv(argv: readonly string[]): string[] {
  const idx = argv.indexOf('--');
  if (idx === -1) return [...argv];
  return argv.slice(idx + 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main({ argv: process.argv.slice(2) })
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`${(err as Error).stack ?? err}\n`);
      process.exit(1);
    });
}
