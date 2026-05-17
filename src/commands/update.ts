/**
 * `contextify update` — actively pull the latest version from npm via the
 * package manager that owns the running binary.
 *
 * Flags:
 *   --check   Probe registry and print the upgrade command, but do not run it.
 */
import { runUpdate } from '../updater.js';

export interface UpdateArgs {
  readonly check?: boolean;
}

export function parseUpdateArgs(argv: readonly string[]): UpdateArgs {
  let check = false;
  for (const arg of argv) {
    if (arg === '--check') check = true;
  }
  return { check };
}

export async function runUpdateCommand(
  args: UpdateArgs,
  ctx: { env: NodeJS.ProcessEnv; currentVersion: string },
): Promise<number> {
  return runUpdate({
    env: ctx.env,
    currentVersion: ctx.currentVersion,
    check: args.check,
  });
}
