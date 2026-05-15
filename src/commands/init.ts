import { existsSync } from 'node:fs';
import { configPath, writeConfig, DEFAULT_SERVER_URL } from '../config.js';

export interface InitArgs {
  readonly projectId: string;
  readonly projectName?: string;
  readonly serverUrl?: string;
  readonly force?: boolean;
}

export async function runInit(args: InitArgs, cwd: string): Promise<number> {
  if (!args.projectId) {
    process.stderr.write('error: project id required\n');
    return 2;
  }
  const path = configPath(cwd);
  if (existsSync(path) && !args.force) {
    process.stderr.write(`error: ${path} exists. Pass --force to overwrite.\n`);
    return 1;
  }
  await writeConfig(cwd, {
    projectId: args.projectId,
    projectName: args.projectName,
    serverUrl: args.serverUrl ?? DEFAULT_SERVER_URL,
  });
  process.stdout.write(`Wrote ${path}\n`);
  return 0;
}
