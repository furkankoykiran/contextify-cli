/**
 * Project identity resolver.
 *
 * Determines a deterministic, cross-environment `projectId` from the
 * caller's working directory. Resolution stack — first hit wins:
 *
 *   1. CONTEXTIFY_PROJECT_ID env var          (operator override)
 *   2. .contextify.json#projectId             (committed config)
 *   3. git remote signature                   (origin → slug + hash12)
 *   4. folder-realpath fallback               (machine-local)
 *
 * See docs/DESIGN-claude-code-hooks.md §2 for the full rationale.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, parse as parsePath, resolve } from 'node:path';
import { promisify } from 'node:util';
import { CONFIG_FILENAME, readConfig } from './config.js';

const execFileAsync = promisify(execFile);

const SLUG_RE = /^[a-zA-Z0-9_-]+$/;
const HASH_LEN = 12;

export type IdentitySource = 'env' | 'config' | 'git-remote' | 'folder';

export interface ResolvedIdentity {
  readonly projectId: string;
  readonly projectName: string;
  readonly source: IdentitySource;
  /** The directory that owns the identity — for git/config sources, the repo or config root. */
  readonly anchor: string;
}

export interface ResolveOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Override for tests: `git remote get-url <name>`. */
  readonly gitRemoteUrl?: (anchor: string, remoteName: string) => Promise<string | null>;
  /** Override for tests: `git rev-parse --show-toplevel`. */
  readonly gitToplevel?: (anchor: string) => Promise<string | null>;
  /** Remote name to consult. Defaults to 'origin'. */
  readonly remoteName?: string;
}

/**
 * Walks up from `start` looking for `.contextify.json`. Returns the
 * directory that contains it, or null.
 */
export function findConfigAncestor(start: string): string | null {
  let dir = resolve(start);
  const root = parsePath(dir).root;
  // Bounded by `dir === root` plus the parent-equality stop — never infinite.
  for (;;) {
    if (existsSync(join(dir, CONFIG_FILENAME))) return dir;
    if (dir === root) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Normalize a remote URL into a comparison-stable string.
 *
 * Examples (all → 'github.com/furkankoykiran/contextify'):
 *   - 'https://github.com/furkankoykiran/contextify.git'
 *   - 'git@github.com:FurkanKoykiran/contextify/'
 *   - 'ssh://git@github.com/furkankoykiran/contextify.git'
 *   - 'http://gitlab.example.com:8080/group/sub/repo.git'  → 'gitlab.example.com/group/sub/repo'
 */
export function normalizeGitRemote(raw: string): string | null {
  let s = raw.trim().toLowerCase();
  if (!s) return null;

  // ssh form: git@host:path
  const sshMatch = /^git@([^:]+):(.+)$/.exec(s);
  if (sshMatch) {
    s = `${sshMatch[1]}/${sshMatch[2]}`;
  } else {
    // strip scheme
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
    // strip user@ (e.g. ssh://git@host/path)
    s = s.replace(/^[^/@]+@/, '');
    // strip :port if present right after host
    s = s.replace(/^([^/]+):\d+/, '$1');
  }
  // strip trailing slash(es) first, then trailing .git
  s = s.replace(/\/+$/, '');
  s = s.replace(/\.git$/, '');
  // a trailing slash can be left if the .git was the only trailing token
  s = s.replace(/\/+$/, '');
  // collapse double slashes
  s = s.replace(/\/{2,}/g, '/');
  if (!s.includes('/')) return null;
  return s;
}

/**
 * Convert any string into a safe lowercase slug that matches SLUG_RE.
 * Used for `projectId` prefixes and falls back to 'project' if the
 * derived string is empty.
 */
export function slugify(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.length === 0 ? 'project' : cleaned.slice(0, 64);
}

export function hash12(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, HASH_LEN);
}

/** Default `git remote get-url <name>` runner. Returns null if git is absent or the remote is missing. */
async function defaultGitRemoteUrl(anchor: string, remoteName: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', remoteName], {
      cwd: anchor,
      timeout: 5_000,
    });
    const out = stdout.trim();
    return out.length === 0 ? null : out;
  } catch {
    return null;
  }
}

/** Default `git rev-parse --show-toplevel` runner. Returns null if not in a git repo. */
async function defaultGitToplevel(anchor: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd: anchor,
      timeout: 5_000,
    });
    const out = stdout.trim();
    return out.length === 0 ? null : out;
  } catch {
    return null;
  }
}

function envIdentity(env: NodeJS.ProcessEnv, cwd: string): ResolvedIdentity | null {
  const pid = env.CONTEXTIFY_PROJECT_ID;
  if (!pid) return null;
  if (!SLUG_RE.test(pid)) {
    throw new Error('CONTEXTIFY_PROJECT_ID must match [a-zA-Z0-9_-]+');
  }
  return {
    projectId: pid,
    projectName: env.CONTEXTIFY_PROJECT_NAME || pid,
    source: 'env',
    anchor: cwd,
  };
}

async function configIdentity(cwd: string): Promise<ResolvedIdentity | null> {
  const anchor = findConfigAncestor(cwd);
  if (!anchor) return null;
  const cfg = await readConfig(anchor);
  if (!cfg) return null;
  return {
    projectId: cfg.projectId,
    projectName: cfg.projectName ?? cfg.projectId,
    source: 'config',
    anchor,
  };
}

async function gitIdentity(
  cwd: string,
  remoteName: string,
  remoteUrl: (anchor: string, remoteName: string) => Promise<string | null>,
  toplevel: (anchor: string) => Promise<string | null>,
): Promise<ResolvedIdentity | null> {
  const top = await toplevel(cwd);
  if (!top) return null;
  const url = await remoteUrl(top, remoteName);
  if (!url) return null;
  const normalized = normalizeGitRemote(url);
  if (!normalized) return null;
  const slug = slugify(normalized.split('/').pop() ?? 'project');
  const projectId = `${slug}-${hash12(normalized)}`;
  return {
    projectId,
    projectName: slug,
    source: 'git-remote',
    anchor: top,
  };
}

function folderIdentity(cwd: string): ResolvedIdentity {
  // Real path so symlink hops collapse to one identity.
  let realCwd: string;
  try {
    realCwd = realpathSync(cwd);
  } catch {
    realCwd = resolve(cwd);
  }
  const slug = slugify(basename(realCwd));
  const projectId = `${slug}-${hash12(realCwd)}`;
  return {
    projectId,
    projectName: slug,
    source: 'folder',
    anchor: realCwd,
  };
}

export async function resolveIdentity(opts: ResolveOptions): Promise<ResolvedIdentity> {
  const env = opts.env ?? process.env;
  const remoteName = opts.remoteName ?? 'origin';

  const fromEnv = envIdentity(env, opts.cwd);
  if (fromEnv) return fromEnv;

  const fromConfig = await configIdentity(opts.cwd);
  if (fromConfig) return fromConfig;

  const fromGit = await gitIdentity(
    opts.cwd,
    remoteName,
    opts.gitRemoteUrl ?? defaultGitRemoteUrl,
    opts.gitToplevel ?? defaultGitToplevel,
  );
  if (fromGit) return fromGit;

  return folderIdentity(opts.cwd);
}
