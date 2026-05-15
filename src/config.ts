/**
 * Project-local CLI configuration.
 *
 * `.contextify.json` lives in the user's cwd (the project root) and stores the
 * `projectId`, optional display name, and server URL. Environment variables
 * (`CONTEXTIFY_SERVER_URL`, `CONTEXTIFY_PROJECT_ID`) override the file so CI can
 * inject credentials without rewriting the file on disk.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const CONFIG_FILENAME = '.contextify.json';
export const DEFAULT_SERVER_URL = 'http://localhost:3000';

export interface CliConfig {
  readonly projectId: string;
  readonly projectName?: string;
  readonly serverUrl: string;
}

export interface ResolvedConfig extends CliConfig {
  readonly configPath: string | null;
  readonly source: 'file' | 'env' | 'mixed' | 'none';
}

const SLUG_RE = /^[a-zA-Z0-9_-]+$/;

export function configPath(cwd: string): string {
  return join(resolve(cwd), CONFIG_FILENAME);
}

export async function readConfig(cwd: string): Promise<CliConfig | null> {
  const path = configPath(cwd);
  if (!existsSync(path)) return null;
  const text = await readFile(path, 'utf8');
  try {
    const parsed = JSON.parse(text) as Partial<CliConfig>;
    if (!parsed.projectId || !SLUG_RE.test(parsed.projectId)) {
      throw new Error(`${path}: projectId is missing or invalid`);
    }
    return {
      projectId: parsed.projectId,
      projectName: parsed.projectName,
      serverUrl: parsed.serverUrl ?? DEFAULT_SERVER_URL,
    };
  } catch (err) {
    throw new Error(`${path}: ${(err as Error).message}`);
  }
}

export async function writeConfig(cwd: string, config: CliConfig): Promise<string> {
  if (!SLUG_RE.test(config.projectId)) {
    throw new Error('projectId must match [a-zA-Z0-9_-]+');
  }
  const path = configPath(cwd);
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return path;
}

export async function resolveConfig(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedConfig> {
  const fromFile = await readConfig(cwd);
  const envProjectId = env.CONTEXTIFY_PROJECT_ID;
  const envServerUrl = env.CONTEXTIFY_SERVER_URL;

  if (envProjectId && envServerUrl) {
    if (!SLUG_RE.test(envProjectId)) {
      throw new Error('CONTEXTIFY_PROJECT_ID must match [a-zA-Z0-9_-]+');
    }
    return {
      projectId: envProjectId,
      projectName: fromFile?.projectName,
      serverUrl: envServerUrl,
      configPath: fromFile ? configPath(cwd) : null,
      source: fromFile ? 'mixed' : 'env',
    };
  }

  if (fromFile) {
    return {
      ...fromFile,
      projectId: envProjectId ?? fromFile.projectId,
      serverUrl: envServerUrl ?? fromFile.serverUrl,
      configPath: configPath(cwd),
      source: envProjectId || envServerUrl ? 'mixed' : 'file',
    };
  }

  if (envProjectId) {
    if (!SLUG_RE.test(envProjectId)) {
      throw new Error('CONTEXTIFY_PROJECT_ID must match [a-zA-Z0-9_-]+');
    }
    return {
      projectId: envProjectId,
      serverUrl: envServerUrl ?? DEFAULT_SERVER_URL,
      configPath: null,
      source: 'env',
    };
  }

  throw new Error(
    'no contextify config found — run `contextify init <projectId>` or set CONTEXTIFY_PROJECT_ID',
  );
}
