/**
 * Auto-update mechanism for the contextify CLI.
 *
 * Pattern: classic `update-notifier` (npm, yarn, vercel) — never modify the
 * running executable, never block the user's command. Instead:
 *
 *   1. Once per UPDATE_CHECK_INTERVAL_MS, fork a detached background process
 *      that hits `https://registry.npmjs.org/<pkg>/latest` and writes the
 *      result to `~/.contextify/update-check.json`.
 *   2. On every foreground command, read the cache and print a one-line
 *      banner on stderr if a newer version is available. Cache reads cost
 *      a single fs.stat + readFile, so this is effectively free.
 *   3. `contextify update` shells out to the package manager that owns the
 *      running binary (npm / pnpm / yarn) and installs the latest.
 *
 * Zero new runtime deps — uses node:https + a hand-rolled SemVer compare.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_NAME = '@furkankoykiran/contextify-cli';
export const REGISTRY_URL = `https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME).replace('%40', '@')}/latest`;
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
/** When the registry probe fails, retry after this long instead of every invocation. */
export const PROBE_BACKOFF_MS = 60 * 60 * 1000; // 1h
const HTTP_TIMEOUT_MS = 5_000;
/** Hard cap on the registry response body — the JSON we want is well under 8KB. */
const MAX_RESPONSE_BYTES = 256 * 1024;

export interface UpdateCache {
  /** Latest version observed on the registry (or '' if no successful probe yet). */
  readonly latest: string;
  /** Epoch ms of the last *successful* probe. */
  readonly checkedAt: number;
  /**
   * Epoch ms of the last *failed* probe. Used to apply PROBE_BACKOFF_MS so we
   * don't respawn the detached probe on every invocation while the registry
   * is unreachable, AND we still re-check before the 24h `checkedAt` window
   * elapses once the network recovers. Undefined when the most recent probe
   * succeeded.
   */
  readonly failedAt?: number;
  /** Version of the CLI that wrote this cache — invalidates on upgrade. */
  readonly currentAtCheck: string;
}

export interface UpdaterOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly currentVersion: string;
  readonly now?: () => number;
  /** Injected for tests — defaults to fetchLatestVersion against the npm registry. */
  readonly fetchLatest?: () => Promise<string | null>;
}

export function stateDirFor(env: NodeJS.ProcessEnv): string {
  return env.CONTEXTIFY_STATE_DIR ?? join(homedir(), '.contextify');
}

export function cachePathFor(env: NodeJS.ProcessEnv): string {
  return join(stateDirFor(env), 'update-check.json');
}

/** Opt-out checks: CI, tests, explicit env flag, or non-TTY stderr. */
export function isUpdateCheckDisabled(env: NodeJS.ProcessEnv): boolean {
  if (env.CONTEXTIFY_NO_UPDATE_CHECK && env.CONTEXTIFY_NO_UPDATE_CHECK !== '0') return true;
  if (env.NO_UPDATE_NOTIFIER && env.NO_UPDATE_NOTIFIER !== '0') return true;
  if (env.CI && env.CI !== 'false' && env.CI !== '0') return true;
  if (env.NODE_ENV === 'test') return true;
  return false;
}

// ---------------------------------------------------------------------------
// SemVer compare — minimal, sufficient for X.Y.Z and X.Y.Z-prerelease.
// Returns -1 if a < b, 0 if equal, 1 if a > b. Invalid inputs sort low.
// ---------------------------------------------------------------------------

export interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
}

// Numeric identifiers MUST NOT have leading zeroes per SemVer 2.0.0 §2 / §9.
const NUMERIC_ID = '(?:0|[1-9]\\d*)';
const PRERELEASE_ID = '(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9A-Za-z-]*)';
const PRERELEASE = `(?:${PRERELEASE_ID}(?:\\.${PRERELEASE_ID})*)`;
const SEMVER_RE = new RegExp(
  `^v?(${NUMERIC_ID})\\.(${NUMERIC_ID})\\.(${NUMERIC_ID})(?:-(${PRERELEASE}))?(?:\\+[0-9A-Za-z.-]+)?$`,
);

export function parseVersion(v: string): ParsedVersion | null {
  const m = SEMVER_RE.exec(v.trim());
  if (!m) return null;
  const [, maj, min, pat, pre] = m;
  return {
    major: Number(maj),
    minor: Number(min),
    patch: Number(pat),
    prerelease: pre ? pre.split('.') : [],
  };
}

export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;

  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;

  // Prerelease tiebreak: 1.0.0-rc.1 < 1.0.0; 1.0.0-alpha < 1.0.0-beta.
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;
  if (pa.prerelease.length === 0) return 1;
  if (pb.prerelease.length === 0) return -1;

  const len = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < len; i++) {
    const ai = pa.prerelease[i];
    const bi = pb.prerelease[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    const an = /^\d+$/.test(ai) ? Number(ai) : null;
    const bn = /^\d+$/.test(bi) ? Number(bi) : null;
    if (an !== null && bn !== null) {
      if (an !== bn) return an < bn ? -1 : 1;
    } else if (an !== null) {
      return -1; // numeric < alphanumeric per semver spec
    } else if (bn !== null) {
      return 1;
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1;
    }
  }
  return 0;
}

/** True if `latest` is strictly newer than `current`. Robust to junk inputs. */
export function isUpdateAvailable(current: string, latest: string): boolean {
  if (!latest) return false;
  return compareVersions(latest, current) > 0;
}

// ---------------------------------------------------------------------------
// Cache I/O
// ---------------------------------------------------------------------------

export async function readCache(env: NodeJS.ProcessEnv): Promise<UpdateCache | null> {
  const path = cachePathFor(env);
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<UpdateCache>;
    if (
      typeof parsed.latest !== 'string' ||
      typeof parsed.checkedAt !== 'number' ||
      typeof parsed.currentAtCheck !== 'string'
    ) {
      return null;
    }
    return {
      latest: parsed.latest,
      checkedAt: parsed.checkedAt,
      ...(typeof parsed.failedAt === 'number' ? { failedAt: parsed.failedAt } : {}),
      currentAtCheck: parsed.currentAtCheck,
    };
  } catch {
    return null;
  }
}

export async function writeCache(env: NodeJS.ProcessEnv, cache: UpdateCache): Promise<void> {
  const dir = stateDirFor(env);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  const path = cachePathFor(env);
  await writeFile(path, JSON.stringify(cache, null, 2), 'utf8');
  try {
    await chmod(path, 0o600);
  } catch {
    // chmod is best-effort (e.g. Windows) — the file content is non-secret.
  }
}

// ---------------------------------------------------------------------------
// Registry fetch (used by the background probe AND `contextify update`).
// ---------------------------------------------------------------------------

export async function fetchLatestVersion(timeoutMs = HTTP_TIMEOUT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    const req = request(
      REGISTRY_URL,
      {
        method: 'GET',
        headers: {
          accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8',
          'user-agent': `contextify-cli updater`,
        },
        timeout: timeoutMs,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        let aborted = false;
        res.on('data', (c: Buffer) => {
          if (aborted) return;
          received += c.length;
          if (received > MAX_RESPONSE_BYTES) {
            aborted = true;
            res.destroy();
            resolve(null);
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          if (aborted) return;
          try {
            const body = Buffer.concat(chunks).toString('utf8');
            const json = JSON.parse(body) as { version?: unknown };
            resolve(typeof json.version === 'string' ? json.version : null);
          } catch {
            resolve(null);
          }
        });
        res.on('error', () => resolve(null));
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Background probe spawner — runs `node <thisFile> --probe` detached.
// The probe writes the cache and exits; the parent process never waits on it.
// ---------------------------------------------------------------------------

export function shouldSpawnProbe(
  cache: UpdateCache | null,
  currentVersion: string,
  now: number,
): boolean {
  if (!cache) return true;
  if (cache.currentAtCheck !== currentVersion) return true; // user upgraded; recheck
  // If the most recent probe failed, honor the short backoff regardless of
  // whether we still have a stale-but-good `latest` cached. Otherwise a
  // transient outage at the scheduled 24h check would suppress retries for
  // another full day instead of retrying in PROBE_BACKOFF_MS.
  if (cache.failedAt !== undefined) {
    return now - cache.failedAt >= PROBE_BACKOFF_MS;
  }
  return now - cache.checkedAt >= UPDATE_CHECK_INTERVAL_MS;
}

export function spawnProbeIfNeeded(opts: UpdaterOptions, cache: UpdateCache | null): void {
  const now = (opts.now ?? Date.now)();
  if (!shouldSpawnProbe(cache, opts.currentVersion, now)) return;
  try {
    const entry = fileURLToPath(import.meta.url);
    const child = spawn(process.execPath, [entry, '--probe'], {
      detached: true,
      stdio: 'ignore',
      env: { ...opts.env, CONTEXTIFY_UPDATER_PROBE: '1' },
    });
    // spawn reports OS-level failures (EMFILE, EAGAIN, Windows ENOENT) via an
    // 'error' event on the returned ChildProcess — NOT via the synchronous
    // throw caught below. Without a listener, Node would crash the foreground
    // CLI command on an unhandled error event.
    child.on('error', () => {
      // Best-effort: swallow. The next invocation will retry per
      // shouldSpawnProbe / PROBE_BACKOFF_MS gating.
    });
    child.unref();
  } catch {
    // Synchronous spawn failure (rare — most platforms surface via 'error').
  }
}

/** Runs inside the detached child: fetch + write cache, then exit. */
export async function runProbe(opts: UpdaterOptions): Promise<void> {
  const fetcher = opts.fetchLatest ?? (() => fetchLatestVersion());
  const latest = await fetcher();
  const now = (opts.now ?? Date.now)();
  if (latest === null) {
    // Negative-cache the failure so we don't respawn a probe on every
    // invocation while the registry is unreachable. Preserve any
    // previously-known `latest` (so the banner doesn't disappear during a
    // transient outage) AND the previous `checkedAt` (so the 24h interval
    // isn't silently reset by a failure). The new `failedAt` field carries
    // the short-backoff signal independently.
    const existing = await readCache(opts.env);
    await writeCache(opts.env, {
      latest: existing?.latest ?? '',
      checkedAt: existing?.checkedAt ?? 0,
      failedAt: now,
      currentAtCheck: opts.currentVersion,
    });
    return;
  }
  await writeCache(opts.env, {
    latest,
    checkedAt: now,
    currentAtCheck: opts.currentVersion,
  });
}

// ---------------------------------------------------------------------------
// Notifier — read cache and print banner if a newer version exists.
// ---------------------------------------------------------------------------

export function formatBanner(current: string, latest: string): string {
  const line1 = `┌──────────────────────────────────────────────────────────┐`;
  const line2 = `│ Update available: ${current.padEnd(8)} → ${latest.padEnd(8)}                  │`;
  const line3 = `│ Run:  contextify update                                  │`;
  const line4 = `└──────────────────────────────────────────────────────────┘`;
  return `${line1}\n${line2}\n${line3}\n${line4}\n`;
}

export interface NotifierResult {
  readonly shown: boolean;
  readonly latest?: string;
}

export async function runNotifier(
  opts: UpdaterOptions,
  stderr: NodeJS.WriteStream = process.stderr,
): Promise<NotifierResult> {
  if (isUpdateCheckDisabled(opts.env)) return { shown: false };

  const cache = await readCache(opts.env);
  spawnProbeIfNeeded(opts, cache);

  if (!cache) return { shown: false };
  if (!isUpdateAvailable(opts.currentVersion, cache.latest)) return { shown: false };

  // Only show banner to interactive stderr — keeps machine-parseable output
  // clean. Node sets isTTY to `true` ONLY for real ttys; redirected / piped
  // streams leave it `undefined` (NOT `false`), so we must treat anything
  // other than explicit `true` as non-interactive.
  if (stderr.isTTY !== true) {
    return { shown: false, latest: cache.latest };
  }

  stderr.write(formatBanner(opts.currentVersion, cache.latest));
  return { shown: true, latest: cache.latest };
}

// ---------------------------------------------------------------------------
// `contextify update` — actively install latest via the host package manager.
// ---------------------------------------------------------------------------

export type PackageManager = 'npm' | 'pnpm' | 'yarn';

/**
 * Heuristic: look at the realpath of the running binary. pnpm and yarn each
 * install globals into distinctive directories; everything else falls back
 * to npm.
 */
export function detectPackageManager(argv1: string | undefined): PackageManager {
  if (!argv1) return 'npm';
  // Lowercase the normalized path: Windows is case-insensitive on filesystem
  // and Yarn classic installs under %LOCALAPPDATA%\Yarn\... — without this
  // a Yarn-owned install would fall through to npm.
  const norm = resolvePath(argv1).replace(/\\/g, '/').toLowerCase();
  if (norm.includes('/pnpm/') || norm.includes('/.pnpm/')) return 'pnpm';
  if (norm.includes('/yarn/') || norm.includes('/.yarn/')) return 'yarn';
  return 'npm';
}

export function updateCommandFor(pm: PackageManager, version = 'latest'): readonly string[] {
  // Pin to an explicit version when we verified one against the npm registry.
  // If the user's package manager points at a lagging private mirror,
  // `@latest` could still resolve to an older version and silently downgrade
  // them; pinning the exact version we probed avoids that. Fallback path
  // (--force without a probed version) passes `latest`.
  const spec = `${PACKAGE_NAME}@${version}`;
  switch (pm) {
    case 'pnpm':
      return ['pnpm', 'add', '-g', spec];
    case 'yarn':
      return ['yarn', 'global', 'add', spec];
    case 'npm':
    default:
      return ['npm', 'install', '-g', spec];
  }
}

export interface RunUpdateOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly currentVersion: string;
  readonly argv1?: string;
  readonly check?: boolean;
  /**
   * Opt in to running the package-manager install even when we couldn't
   * verify the registry version is newer. Without this, a probe failure
   * with no cached `latest` aborts rather than risk a silent downgrade for
   * users on a local/prerelease build that's ahead of `@latest`.
   */
  readonly force?: boolean;
  readonly stdout?: NodeJS.WriteStream;
  readonly stderr?: NodeJS.WriteStream;
  /** Injected for tests — defaults to fetchLatestVersion + child_process.spawn. */
  readonly fetchLatest?: () => Promise<string | null>;
  readonly runCommand?: (cmd: readonly string[]) => Promise<number>;
}

export async function runUpdate(opts: RunUpdateOptions): Promise<number> {
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const fetcher = opts.fetchLatest ?? (() => fetchLatestVersion());

  const latest = await fetcher();
  const pm = detectPackageManager(opts.argv1 ?? process.argv[1]);

  // If our direct probe to registry.npmjs.org failed (corporate proxy, custom
  // mirror, IPv6-only, registry outage, rate limit), the user's package
  // manager may still be able to fetch a newer version. But we can't blindly
  // install @latest: if the user is on a local/prerelease build that's ahead
  // of the registry's `latest` dist-tag (or a corporate mirror is lagging),
  // doing so silently DOWNGRADES them. So: print the command, explain, and
  // require --force to actually run it.
  if (latest === null) {
    // Fallback path: we don't know the target version, so `@latest` is the
    // best we can do. The user opted in via --force.
    const fallbackCmd = updateCommandFor(pm, 'latest');
    stderr.write(
      `contextify: could not reach npm registry directly. ` +
        `Cannot confirm whether ${PACKAGE_NAME}@latest is newer than ${opts.currentVersion}.\n`,
    );
    stdout.write(`Run manually:  ${fallbackCmd.join(' ')}\n`);
    if (opts.check) return 0;
    if (!opts.force) {
      stdout.write(`Or re-run with --force to install @latest anyway.\n`);
      return 1;
    }
    stdout.write(
      `--force given; deferring to ${pm} (note: this may downgrade if ${PACKAGE_NAME}@latest < ${opts.currentVersion}).\n`,
    );
    stdout.write(`$ ${fallbackCmd.join(' ')}\n`);
    return runInstall(opts, fallbackCmd, undefined, stdout, stderr);
  }

  if (!isUpdateAvailable(opts.currentVersion, latest)) {
    stdout.write(`contextify ${opts.currentVersion} is already the latest version.\n`);
    return 0;
  }

  // Pin to the exact verified version. Using `@latest` here would let a
  // lagging private mirror return an older release than the one we just
  // confirmed on npmjs.org, silently downgrading the user.
  const cmd = updateCommandFor(pm, latest);

  if (opts.check) {
    stdout.write(`Update available: ${opts.currentVersion} → ${latest}\n`);
    stdout.write(`Run:  ${cmd.join(' ')}\n`);
    return 0;
  }

  stdout.write(`Updating contextify ${opts.currentVersion} → ${latest} via ${pm}…\n`);
  stdout.write(`$ ${cmd.join(' ')}\n`);
  return runInstall(opts, cmd, latest, stdout, stderr);
}

async function runInstall(
  opts: RunUpdateOptions,
  cmd: readonly string[],
  latest: string | undefined,
  stdout: NodeJS.WriteStream,
  stderr: NodeJS.WriteStream,
): Promise<number> {
  const runner =
    opts.runCommand ??
    ((c) =>
      new Promise<number>((resolveExit) => {
        const child = spawn(c[0]!, c.slice(1), {
          stdio: 'inherit',
          env: opts.env,
        });
        child.on('exit', (code) => resolveExit(code ?? 1));
        child.on('error', (err) => {
          stderr.write(`contextify: failed to launch ${c[0]}: ${err.message}\n`);
          resolveExit(127);
        });
      }));

  const code = await runner(cmd);
  if (code === 0) {
    if (latest !== undefined) {
      // Invalidate the cache so the banner stops showing immediately.
      try {
        await writeCache(opts.env, {
          latest,
          checkedAt: Date.now(),
          currentAtCheck: latest,
        });
      } catch {
        // Non-fatal: stale banner will self-heal on next probe.
      }
      stdout.write(`contextify updated to ${latest}.\n`);
    } else {
      // We deferred to the package manager without knowing the target version;
      // drop the cache so the next probe re-establishes ground truth.
      try {
        await writeCache(opts.env, {
          latest: '',
          checkedAt: 0,
          currentAtCheck: opts.currentVersion,
        });
      } catch {
        // Non-fatal.
      }
      stdout.write(`contextify update complete.\n`);
    }
  } else {
    stderr.write(`contextify: update failed (exit ${code}).\n`);
  }
  return code;
}

// ---------------------------------------------------------------------------
// CLI entry for the detached probe subprocess.
// ---------------------------------------------------------------------------

async function maybeRunProbeMain(): Promise<void> {
  if (process.env.CONTEXTIFY_UPDATER_PROBE !== '1') return;
  if (!process.argv.includes('--probe')) return;
  // Read the version baked into the dist at build time.
  const req = createRequire(import.meta.url);
  const pkg = req('../package.json') as { version?: unknown };
  const currentVersion = typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  await runProbe({ env: process.env, currentVersion });
}

void maybeRunProbeMain();
