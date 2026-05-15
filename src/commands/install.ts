/**
 * `contextify install` — zero-config global install.
 *
 * Materializes the three hook scripts under ~/.contextify/hooks/ and
 * merges hook entries into ~/.claude/settings.json. Idempotent. Does
 * NOT write .contextify.json into the cwd — that's `init`'s job.
 *
 * Designed for users who want one-time global wiring: run once anywhere,
 * and every Claude Code session in any directory gets captured. The hook
 * scripts resolve project_id dynamically from each session's cwd at
 * fire-time via identity.ts, so no per-project setup is required.
 *
 * Flags:
 *   (none required)
 *   --dry-run         Print what would change without modifying anything.
 */
import { installHooks, type InstallHooksResult } from './install-hooks.js';

export interface InstallArgs {
  readonly dryRun?: boolean;
}

export interface InstallOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly stdout?: NodeJS.WriteStream;
  readonly stderr?: NodeJS.WriteStream;
  /** For tests: bypass the real ~/.claude / ~/.contextify dirs. */
  readonly stateRoot?: string;
  readonly claudeSettingsPath?: string;
  /** For tests / dry-run preview. */
  readonly runner?: (opts: {
    stateRoot?: string;
    claudeSettingsPath?: string;
  }) => Promise<InstallHooksResult>;
}

export async function runInstall(args: InstallArgs, opts: InstallOptions = {}): Promise<number> {
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const runner = opts.runner ?? installHooks;

  if (args.dryRun) {
    // Preview: surface the same target paths the real install would touch.
    const { defaultStateRoot, defaultClaudeSettingsPath } = await import('./install-hooks.js');
    const env = opts.env ?? process.env;
    const stateRoot = opts.stateRoot ?? defaultStateRoot(env);
    const settingsPath = opts.claudeSettingsPath ?? defaultClaudeSettingsPath(env);
    stdout.write(
      `${JSON.stringify(
        {
          dryRun: true,
          wouldWriteHooks: ['SessionStart', 'Stop', 'SessionEnd'],
          hooksDir: `${stateRoot}/hooks`,
          settingsPath,
          backupDir: `${stateRoot}/backups`,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  let result: InstallHooksResult;
  try {
    result = await runner({
      stateRoot: opts.stateRoot,
      claudeSettingsPath: opts.claudeSettingsPath,
    });
  } catch (err) {
    stderr.write(`contextify install: ${(err as Error).message}\n`);
    return 1;
  }

  const allPresent = result.appendedEvents.length === 0 && result.alreadyPresentEvents.length === 3;

  stdout.write(`${allPresent ? 'Hooks already installed' : 'Installed Contextify hooks'} (`);
  stdout.write(`appended=${JSON.stringify(result.appendedEvents)}, `);
  stdout.write(`alreadyPresent=${JSON.stringify(result.alreadyPresentEvents)})\n`);
  stdout.write(`  hooks dir:     ${result.hooksDir}\n`);
  stdout.write(`  settings:      ${result.settingsPath}\n`);
  if (result.backupPath) {
    stdout.write(`  backup:        ${result.backupPath}\n`);
  }
  stdout.write(`\n`);
  stdout.write(`Hooks fire automatically on every Claude Code session. project_id\n`);
  stdout.write(`is derived from each session's cwd at fire-time via the identity stack\n`);
  stdout.write(`(env override → .contextify.json → git remote → folder realpath).\n`);
  return 0;
}
