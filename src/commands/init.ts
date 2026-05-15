import { existsSync } from 'node:fs';
import { configPath, writeConfig, DEFAULT_SERVER_URL } from '../config.js';
import { resolveIdentity } from '../identity.js';
import { installHooks } from './install-hooks.js';

export interface InitArgs {
  readonly projectId?: string;
  readonly projectName?: string;
  readonly serverUrl?: string;
  readonly force?: boolean;
  readonly installHooks?: boolean;
}

export async function runInit(args: InitArgs, cwd: string): Promise<number> {
  const path = configPath(cwd);
  if (existsSync(path) && !args.force) {
    process.stderr.write(`error: ${path} exists. Pass --force to overwrite.\n`);
    return 1;
  }

  // Resolve identity: explicit positional arg wins; otherwise derive.
  let projectId = args.projectId;
  let projectName = args.projectName;
  if (!projectId) {
    try {
      const id = await resolveIdentity({ cwd });
      projectId = id.projectId;
      projectName = projectName ?? id.projectName;
    } catch (err) {
      process.stderr.write(`error: ${(err as Error).message}\n`);
      return 2;
    }
  }

  await writeConfig(cwd, {
    projectId,
    projectName,
    serverUrl: args.serverUrl ?? DEFAULT_SERVER_URL,
  });
  process.stdout.write(`Wrote ${path}\n`);

  if (args.installHooks) {
    try {
      const result = await installHooks();
      const summary = {
        installed: result.appendedEvents,
        alreadyPresent: result.alreadyPresentEvents,
        hooksDir: result.hooksDir,
        backup: result.backupPath,
      };
      process.stdout.write(`Installed hooks: ${JSON.stringify(summary)}\n`);
    } catch (err) {
      process.stderr.write(`error: install-hooks failed: ${(err as Error).message}\n`);
      return 1;
    }
  }
  return 0;
}
