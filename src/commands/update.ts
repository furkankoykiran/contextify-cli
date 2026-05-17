/**
 * `contextify update` — actively pull the latest version from npm via the
 * package manager that owns the running binary.
 *
 * Flags:
 *   --check   Probe registry and print the upgrade command, but do not run it.
 *   --force   When the registry probe fails, install @latest anyway via the
 *             package manager. Without --force, we abort rather than risk a
 *             silent downgrade for users on a local/prerelease build.
 */
import { runUpdate } from '../updater.js';

export interface UpdateArgs {
  readonly check?: boolean;
  readonly force?: boolean;
}

export function parseUpdateArgs(argv: readonly string[]): UpdateArgs {
  let check = false;
  let force = false;
  for (const arg of argv) {
    if (arg === '--check') check = true;
    else if (arg === '--force') force = true;
  }
  return { check, force };
}

export async function runUpdateCommand(
  args: UpdateArgs,
  ctx: { env: NodeJS.ProcessEnv; currentVersion: string },
): Promise<number> {
  return runUpdate({
    env: ctx.env,
    currentVersion: ctx.currentVersion,
    check: args.check,
    force: args.force,
  });
}
