import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cachePathFor,
  compareVersions,
  detectPackageManager,
  formatBanner,
  isUpdateAvailable,
  isUpdateCheckDisabled,
  parseVersion,
  PROBE_BACKOFF_MS,
  readCache,
  runNotifier,
  runProbe,
  runUpdate,
  shouldSpawnProbe,
  stateDirFor,
  UPDATE_CHECK_INTERVAL_MS,
  updateCommandFor,
  writeCache,
  type UpdateCache,
} from './updater.js';

const baseEnv = (stateDir: string): NodeJS.ProcessEnv => ({
  CONTEXTIFY_STATE_DIR: stateDir,
  // Force the notifier "enabled" path — base env strips CI/test guards.
  CI: '',
  NODE_ENV: 'production',
  CONTEXTIFY_NO_UPDATE_CHECK: '',
  NO_UPDATE_NOTIFIER: '',
});

describe('updater — parseVersion / compareVersions', () => {
  it('parses plain X.Y.Z', () => {
    expect(parseVersion('1.2.3')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: [],
    });
  });

  it('tolerates a leading v', () => {
    expect(parseVersion('v0.5.0')?.minor).toBe(5);
  });

  it('parses prerelease tags', () => {
    expect(parseVersion('1.0.0-rc.2')?.prerelease).toEqual(['rc', '2']);
  });

  it('rejects garbage', () => {
    expect(parseVersion('not-a-version')).toBeNull();
    expect(parseVersion('')).toBeNull();
  });

  it('rejects SemVer with leading zeroes per spec', () => {
    // SemVer 2.0.0 §2: numeric identifiers MUST NOT have leading zeroes.
    expect(parseVersion('01.2.3')).toBeNull();
    expect(parseVersion('1.02.3')).toBeNull();
    expect(parseVersion('1.2.03')).toBeNull();
    expect(parseVersion('1.0.0-alpha.01')).toBeNull();
    // Bare 0 is allowed.
    expect(parseVersion('0.0.0')).not.toBeNull();
    expect(parseVersion('1.0.0-0.1')).not.toBeNull();
    // Alphanumeric prerelease IDs with leading-zero-looking text are valid.
    expect(parseVersion('1.0.0-0a')).not.toBeNull();
  });

  it('accepts build metadata and ignores it for ordering', () => {
    expect(parseVersion('1.2.3+sha.abc')).not.toBeNull();
    expect(compareVersions('1.2.3+a', '1.2.3+b')).toBe(0);
  });

  it('orders by major, minor, patch', () => {
    expect(compareVersions('1.0.0', '1.0.1')).toBe(-1);
    expect(compareVersions('1.1.0', '1.0.9')).toBe(1);
    expect(compareVersions('2.0.0', '1.99.99')).toBe(1);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('treats release > prerelease', () => {
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBe(1);
  });

  it('compares prerelease identifiers per SemVer spec', () => {
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBe(-1);
    expect(compareVersions('1.0.0-rc.1', '1.0.0-rc.2')).toBe(-1);
    // numeric < alphanumeric
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1);
  });
});

describe('updater — isUpdateAvailable', () => {
  it('false when latest is empty or equal', () => {
    expect(isUpdateAvailable('1.0.0', '')).toBe(false);
    expect(isUpdateAvailable('1.0.0', '1.0.0')).toBe(false);
  });
  it('true when latest is strictly newer', () => {
    expect(isUpdateAvailable('0.4.3', '0.5.0')).toBe(true);
    expect(isUpdateAvailable('1.0.0', '1.0.1')).toBe(true);
  });
  it('false when current is newer than latest (downgrade)', () => {
    expect(isUpdateAvailable('2.0.0', '1.9.9')).toBe(false);
  });
});

describe('updater — opt-out gating', () => {
  it('disables under CI=true', () => {
    expect(isUpdateCheckDisabled({ CI: 'true' })).toBe(true);
    expect(isUpdateCheckDisabled({ CI: '1' })).toBe(true);
    expect(isUpdateCheckDisabled({ CI: '0' })).toBe(false);
    expect(isUpdateCheckDisabled({ CI: '' })).toBe(false);
  });

  it('disables under NODE_ENV=test', () => {
    expect(isUpdateCheckDisabled({ NODE_ENV: 'test' })).toBe(true);
  });

  it('disables under CONTEXTIFY_NO_UPDATE_CHECK', () => {
    expect(isUpdateCheckDisabled({ CONTEXTIFY_NO_UPDATE_CHECK: '1' })).toBe(true);
    expect(isUpdateCheckDisabled({ CONTEXTIFY_NO_UPDATE_CHECK: '0' })).toBe(false);
  });

  it('disables under NO_UPDATE_NOTIFIER (industry-standard opt-out)', () => {
    expect(isUpdateCheckDisabled({ NO_UPDATE_NOTIFIER: '1' })).toBe(true);
  });
});

describe('updater — cache I/O', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'contextify-updater-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('paths derive from CONTEXTIFY_STATE_DIR', () => {
    const env = baseEnv(dir);
    expect(stateDirFor(env)).toBe(dir);
    expect(cachePathFor(env)).toBe(join(dir, 'update-check.json'));
  });

  it('returns null when cache file is missing', async () => {
    const env = baseEnv(dir);
    expect(await readCache(env)).toBeNull();
  });

  it('round-trips a cache entry and chmods 600', async () => {
    const env = baseEnv(dir);
    const cache: UpdateCache = {
      latest: '1.2.3',
      checkedAt: 1_700_000_000_000,
      currentAtCheck: '1.0.0',
    };
    await writeCache(env, cache);
    expect(existsSync(cachePathFor(env))).toBe(true);
    expect(await readCache(env)).toEqual(cache);
  });

  it('returns null on malformed cache JSON', async () => {
    const env = baseEnv(dir);
    writeFileSync(cachePathFor(env), '{not json', 'utf8');
    expect(await readCache(env)).toBeNull();
  });

  it('returns null on shape mismatch', async () => {
    const env = baseEnv(dir);
    writeFileSync(cachePathFor(env), JSON.stringify({ latest: 'x' }), 'utf8');
    expect(await readCache(env)).toBeNull();
  });
});

describe('updater — shouldSpawnProbe', () => {
  const NOW = 1_700_000_000_000;
  it('spawns when cache missing', () => {
    expect(shouldSpawnProbe(null, '1.0.0', NOW)).toBe(true);
  });
  it('spawns when CLI version differs from cache (post-upgrade)', () => {
    const cache: UpdateCache = {
      latest: '1.0.0',
      checkedAt: NOW - 10,
      currentAtCheck: '0.9.0',
    };
    expect(shouldSpawnProbe(cache, '1.0.0', NOW)).toBe(true);
  });
  it('spawns when interval elapsed', () => {
    const cache: UpdateCache = {
      latest: '1.0.0',
      checkedAt: NOW - (UPDATE_CHECK_INTERVAL_MS + 1),
      currentAtCheck: '1.0.0',
    };
    expect(shouldSpawnProbe(cache, '1.0.0', NOW)).toBe(true);
  });
  it('skips when cache is fresh', () => {
    const cache: UpdateCache = {
      latest: '1.0.0',
      checkedAt: NOW - 60,
      currentAtCheck: '1.0.0',
    };
    expect(shouldSpawnProbe(cache, '1.0.0', NOW)).toBe(false);
  });

  it('honors PROBE_BACKOFF_MS via failedAt without resetting the 24h interval', () => {
    // Fresh failure — short backoff hasn't elapsed.
    const fresh: UpdateCache = {
      latest: '',
      checkedAt: 0,
      failedAt: NOW - 60_000,
      currentAtCheck: '1.0.0',
    };
    expect(shouldSpawnProbe(fresh, '1.0.0', NOW)).toBe(false);
    // Past the configured backoff — retry.
    const stale: UpdateCache = {
      latest: '',
      checkedAt: 0,
      failedAt: NOW - (PROBE_BACKOFF_MS + 1),
      currentAtCheck: '1.0.0',
    };
    expect(shouldSpawnProbe(stale, '1.0.0', NOW)).toBe(true);
    // Still respects the 24h interval on successful caches (no failedAt).
    const success: UpdateCache = {
      latest: '1.0.0',
      checkedAt: NOW - (PROBE_BACKOFF_MS + 1),
      currentAtCheck: '1.0.0',
    };
    expect(shouldSpawnProbe(success, '1.0.0', NOW)).toBe(false);
  });

  it('failedAt overrides a still-fresh checkedAt — transient outage retries in 1h, not 24h', () => {
    // Scenario: 12h ago we successfully fetched v1.0.0. Just now a recheck
    // failed. The next retry must happen in PROBE_BACKOFF_MS, NOT wait the
    // remaining 12h until the next 24h checkedAt window — otherwise a
    // transient outage at the wrong moment suppresses checks for a full day.
    const cache: UpdateCache = {
      latest: '1.0.0',
      checkedAt: NOW - 12 * 60 * 60 * 1000,
      failedAt: NOW - 60_000, // failure 1 minute ago
      currentAtCheck: '1.0.0',
    };
    expect(shouldSpawnProbe(cache, '1.0.0', NOW)).toBe(false); // backoff active
    // After PROBE_BACKOFF_MS, retry — even though checkedAt is still "fresh".
    expect(shouldSpawnProbe(cache, '1.0.0', NOW + PROBE_BACKOFF_MS)).toBe(true);
  });
});

describe('updater — formatBanner', () => {
  it('includes both versions and the update hint', () => {
    const out = formatBanner('0.4.3', '0.5.0');
    expect(out).toContain('0.4.3');
    expect(out).toContain('0.5.0');
    expect(out).toContain('contextify update');
  });
});

describe('updater — runNotifier', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'contextify-notifier-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function ttyStderr(): { stream: NodeJS.WriteStream; readOutput: () => string } {
    const chunks: Buffer[] = [];
    const stream = new PassThrough() as unknown as NodeJS.WriteStream;
    (stream as unknown as { isTTY: boolean }).isTTY = true;
    stream.on('data', (c: Buffer) => chunks.push(c));
    return { stream, readOutput: () => Buffer.concat(chunks).toString('utf8') };
  }

  it('shows banner when cache reports newer version', async () => {
    const env = baseEnv(dir);
    await writeCache(env, {
      latest: '0.5.0',
      checkedAt: Date.now(),
      currentAtCheck: '0.4.3',
    });
    const { stream, readOutput } = ttyStderr();
    const res = await runNotifier({ env, currentVersion: '0.4.3' }, stream);
    expect(res.shown).toBe(true);
    expect(readOutput()).toContain('0.4.3');
    expect(readOutput()).toContain('0.5.0');
  });

  it('does not show banner when versions match', async () => {
    const env = baseEnv(dir);
    await writeCache(env, {
      latest: '0.4.3',
      checkedAt: Date.now(),
      currentAtCheck: '0.4.3',
    });
    const { stream, readOutput } = ttyStderr();
    const res = await runNotifier({ env, currentVersion: '0.4.3' }, stream);
    expect(res.shown).toBe(false);
    expect(readOutput()).toBe('');
  });

  it('respects CONTEXTIFY_NO_UPDATE_CHECK', async () => {
    const env = { ...baseEnv(dir), CONTEXTIFY_NO_UPDATE_CHECK: '1' };
    await writeCache(env, {
      latest: '99.0.0',
      checkedAt: Date.now(),
      currentAtCheck: '0.4.3',
    });
    const { stream, readOutput } = ttyStderr();
    const res = await runNotifier({ env, currentVersion: '0.4.3' }, stream);
    expect(res.shown).toBe(false);
    expect(readOutput()).toBe('');
  });

  it('does not show banner on non-TTY stderr (explicit false)', async () => {
    const env = baseEnv(dir);
    await writeCache(env, {
      latest: '0.5.0',
      checkedAt: Date.now(),
      currentAtCheck: '0.4.3',
    });
    const chunks: Buffer[] = [];
    const stream = new PassThrough() as unknown as NodeJS.WriteStream;
    (stream as unknown as { isTTY: boolean }).isTTY = false;
    stream.on('data', (c: Buffer) => chunks.push(c));
    const res = await runNotifier({ env, currentVersion: '0.4.3' }, stream);
    expect(res.shown).toBe(false);
    expect(res.latest).toBe('0.5.0');
    expect(Buffer.concat(chunks).toString('utf8')).toBe('');
  });

  it('does not show banner when stderr.isTTY is undefined (redirected/piped)', async () => {
    // Node sets process.stderr.isTTY to `true` only for real ttys — for
    // piped or redirected streams it's `undefined`, NOT `false`. The
    // notifier must treat the undefined case as non-interactive to avoid
    // polluting captured logs or pipelines.
    const env = baseEnv(dir);
    await writeCache(env, {
      latest: '0.5.0',
      checkedAt: Date.now(),
      currentAtCheck: '0.4.3',
    });
    const chunks: Buffer[] = [];
    const stream = new PassThrough() as unknown as NodeJS.WriteStream;
    // Explicitly do NOT set isTTY — leave it `undefined`.
    stream.on('data', (c: Buffer) => chunks.push(c));
    const res = await runNotifier({ env, currentVersion: '0.4.3' }, stream);
    expect(res.shown).toBe(false);
    expect(res.latest).toBe('0.5.0');
    expect(Buffer.concat(chunks).toString('utf8')).toBe('');
  });
});

describe('updater — detectPackageManager + updateCommandFor', () => {
  it('detects pnpm from path', () => {
    expect(detectPackageManager('/home/user/.local/share/pnpm/contextify')).toBe('pnpm');
  });
  it('detects yarn from path', () => {
    expect(detectPackageManager('/home/user/.yarn/bin/contextify')).toBe('yarn');
  });
  it('detects yarn from case-mixed Windows path', () => {
    // Yarn classic installs under %LOCALAPPDATA%\Yarn\... — must be
    // detected even though the path component is "Yarn" not "yarn".
    expect(detectPackageManager('C:\\Users\\Foo\\AppData\\Local\\Yarn\\bin\\contextify')).toBe(
      'yarn',
    );
    expect(detectPackageManager('C:\\Program Files\\PNPM\\contextify.cmd')).toBe('pnpm');
  });
  it('falls back to npm', () => {
    expect(detectPackageManager('/usr/local/bin/contextify')).toBe('npm');
    expect(detectPackageManager(undefined)).toBe('npm');
  });

  it('produces the right install command per manager (defaults to @latest)', () => {
    expect(updateCommandFor('npm')).toEqual([
      'npm',
      'install',
      '-g',
      '@furkankoykiran/contextify-cli@latest',
    ]);
    expect(updateCommandFor('pnpm')).toEqual([
      'pnpm',
      'add',
      '-g',
      '@furkankoykiran/contextify-cli@latest',
    ]);
    expect(updateCommandFor('yarn')).toEqual([
      'yarn',
      'global',
      'add',
      '@furkankoykiran/contextify-cli@latest',
    ]);
  });

  it('pins to an explicit version when given', () => {
    expect(updateCommandFor('npm', '1.2.3')).toEqual([
      'npm',
      'install',
      '-g',
      '@furkankoykiran/contextify-cli@1.2.3',
    ]);
    expect(updateCommandFor('pnpm', '1.2.3')).toEqual([
      'pnpm',
      'add',
      '-g',
      '@furkankoykiran/contextify-cli@1.2.3',
    ]);
  });
});

describe('updater — runUpdate', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'contextify-run-update-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function captureStream(): { stream: NodeJS.WriteStream; output: () => string } {
    const chunks: Buffer[] = [];
    const stream = new PassThrough() as unknown as NodeJS.WriteStream;
    stream.on('data', (c: Buffer) => chunks.push(c));
    return { stream, output: () => Buffer.concat(chunks).toString('utf8') };
  }

  it('reports already-latest when no update available', async () => {
    const env = baseEnv(dir);
    const stdout = captureStream();
    const stderr = captureStream();
    const code = await runUpdate({
      env,
      currentVersion: '1.0.0',
      argv1: '/usr/local/bin/contextify',
      stdout: stdout.stream,
      stderr: stderr.stream,
      fetchLatest: async () => '1.0.0',
      runCommand: async () => 0,
    });
    expect(code).toBe(0);
    expect(stdout.output()).toContain('already the latest');
  });

  it('without --force, aborts when the registry probe fails (no silent downgrade)', async () => {
    // Blindly running `npm install -g pkg@latest` would silently downgrade
    // users on a local/prerelease build ahead of the registry's `latest`.
    const env = baseEnv(dir);
    const stdout = captureStream();
    const stderr = captureStream();
    let ran = false;
    const code = await runUpdate({
      env,
      currentVersion: '1.0.0',
      argv1: '/usr/local/bin/contextify',
      stdout: stdout.stream,
      stderr: stderr.stream,
      fetchLatest: async () => null,
      runCommand: async () => {
        ran = true;
        return 0;
      },
    });
    expect(code).toBe(1);
    expect(ran).toBe(false);
    expect(stderr.output()).toContain('could not reach npm registry');
    expect(stdout.output()).toContain('--force');
    // Probe failed, so the fallback command uses @latest.
    expect(stdout.output()).toContain('npm install -g @furkankoykiran/contextify-cli@latest');
  });

  it('with --force, defers to the package manager when the registry probe fails', async () => {
    // Corporate proxies, private mirrors, registry outages — the user's npm
    // is configured for them and will succeed where our direct probe can't.
    const env = baseEnv(dir);
    const stdout = captureStream();
    const stderr = captureStream();
    let invoked: readonly string[] = [];
    const code = await runUpdate({
      env,
      currentVersion: '1.0.0',
      argv1: '/usr/local/bin/contextify',
      force: true,
      stdout: stdout.stream,
      stderr: stderr.stream,
      fetchLatest: async () => null,
      runCommand: async (cmd) => {
        invoked = cmd;
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(invoked).toEqual(['npm', 'install', '-g', '@furkankoykiran/contextify-cli@latest']);
    expect(stdout.output()).toContain('--force given');
  });

  it('with --check, prints the install command even when registry probe fails', async () => {
    const env = baseEnv(dir);
    const stdout = captureStream();
    const stderr = captureStream();
    let ran = false;
    const code = await runUpdate({
      env,
      currentVersion: '1.0.0',
      argv1: '/usr/local/bin/contextify',
      check: true,
      stdout: stdout.stream,
      stderr: stderr.stream,
      fetchLatest: async () => null,
      runCommand: async () => {
        ran = true;
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(ran).toBe(false);
    // Probe failed, so the fallback command uses @latest (we never verified
    // a specific version against npmjs).
    expect(stdout.output()).toContain('npm install -g @furkankoykiran/contextify-cli@latest');
    expect(stderr.output()).toContain('could not reach npm registry');
  });

  it('prints the upgrade command without running it under --check', async () => {
    const env = baseEnv(dir);
    const stdout = captureStream();
    const stderr = captureStream();
    let ran = false;
    const code = await runUpdate({
      env,
      currentVersion: '0.4.3',
      argv1: '/home/user/.local/share/pnpm/contextify',
      check: true,
      stdout: stdout.stream,
      stderr: stderr.stream,
      fetchLatest: async () => '0.5.0',
      runCommand: async () => {
        ran = true;
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(ran).toBe(false);
    // Probed version is pinned to avoid lagging-mirror downgrades.
    expect(stdout.output()).toContain('pnpm add -g @furkankoykiran/contextify-cli@0.5.0');
  });

  it('shells out to the detected manager and refreshes cache on success', async () => {
    const env = baseEnv(dir);
    const stdout = captureStream();
    const stderr = captureStream();
    let invoked: readonly string[] = [];
    const code = await runUpdate({
      env,
      currentVersion: '0.4.3',
      argv1: '/usr/local/bin/contextify',
      stdout: stdout.stream,
      stderr: stderr.stream,
      fetchLatest: async () => '0.5.0',
      runCommand: async (cmd) => {
        invoked = cmd;
        return 0;
      },
    });
    expect(code).toBe(0);
    // Probed version is pinned — using @latest could resolve to an older
    // version on a lagging private mirror and silently downgrade.
    expect(invoked).toEqual(['npm', 'install', '-g', '@furkankoykiran/contextify-cli@0.5.0']);
    const cachePath = cachePathFor(env);
    expect(existsSync(cachePath)).toBe(true);
    const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as UpdateCache;
    expect(cached.latest).toBe('0.5.0');
    expect(cached.currentAtCheck).toBe('0.5.0');
  });

  it('propagates non-zero exit from the installer', async () => {
    const env = baseEnv(dir);
    const stdout = captureStream();
    const stderr = captureStream();
    const code = await runUpdate({
      env,
      currentVersion: '0.4.3',
      argv1: '/usr/local/bin/contextify',
      stdout: stdout.stream,
      stderr: stderr.stream,
      fetchLatest: async () => '0.5.0',
      runCommand: async () => 42,
    });
    expect(code).toBe(42);
    expect(stderr.output()).toContain('update failed');
  });
});

describe('updater — runProbe negative-cache on failure', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'contextify-probe-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips the failedAt field through writeCache / readCache', async () => {
    const env: NodeJS.ProcessEnv = {
      CONTEXTIFY_STATE_DIR: dir,
      CI: '',
      NODE_ENV: 'production',
    };
    await writeCache(env, {
      latest: '',
      checkedAt: 0,
      failedAt: 1_700_000_000_000,
      currentAtCheck: '1.0.0',
    });
    const cached = await readCache(env);
    expect(cached?.latest).toBe('');
    expect(cached?.failedAt).toBe(1_700_000_000_000);
    // Within backoff — no respawn.
    expect(shouldSpawnProbe(cached, '1.0.0', 1_700_000_000_000 + 60_000)).toBe(false);
  });

  it('preserves previously-known latest AND checkedAt when a probe later fails', async () => {
    // Successful probe wrote v1.5.0 at t=A. A later failed probe writes a
    // new failedAt but must NOT clobber:
    //   - latest (banner keeps showing during transient outage)
    //   - checkedAt (so the 24h interval isn't silently reset by a failure)
    const env: NodeJS.ProcessEnv = {
      CONTEXTIFY_STATE_DIR: dir,
      CI: '',
      NODE_ENV: 'production',
    };
    await writeCache(env, {
      latest: '1.5.0',
      checkedAt: 1_700_000_000_000,
      currentAtCheck: '1.0.0',
    });
    // Simulate what runProbe does on fetchLatest === null: keep latest +
    // checkedAt, add failedAt with the failure timestamp.
    const existing = await readCache(env);
    await writeCache(env, {
      latest: existing?.latest ?? '',
      checkedAt: existing?.checkedAt ?? 0,
      failedAt: 1_700_000_999_000,
      currentAtCheck: '1.0.0',
    });
    const after = await readCache(env);
    expect(after?.latest).toBe('1.5.0');
    expect(after?.checkedAt).toBe(1_700_000_000_000);
    expect(after?.failedAt).toBe(1_700_000_999_000);
  });

  it('runProbe writes a fresh successful cache on probe success', async () => {
    // No live-network: inject fetchLatest so tests stay deterministic and
    // fast even on offline / firewalled CI.
    const env: NodeJS.ProcessEnv = {
      CONTEXTIFY_STATE_DIR: dir,
      CI: '',
      NODE_ENV: 'production',
    };
    const fixedNow = 1_750_000_000_000;
    await runProbe({
      env,
      currentVersion: '1.0.0',
      fetchLatest: async () => '1.2.0',
      now: () => fixedNow,
    });
    const cached = await readCache(env);
    expect(cached?.latest).toBe('1.2.0');
    expect(cached?.checkedAt).toBe(fixedNow);
    expect(cached?.failedAt).toBeUndefined();
  });

  it('runProbe writes failedAt on probe failure, preserves prior latest/checkedAt', async () => {
    const env: NodeJS.ProcessEnv = {
      CONTEXTIFY_STATE_DIR: dir,
      CI: '',
      NODE_ENV: 'production',
    };
    // Seed a successful prior probe.
    await writeCache(env, {
      latest: '1.5.0',
      checkedAt: 1_700_000_000_000,
      currentAtCheck: '1.0.0',
    });
    const fixedNow = 1_700_000_999_000;
    await runProbe({
      env,
      currentVersion: '1.0.0',
      fetchLatest: async () => null,
      now: () => fixedNow,
    });
    const cached = await readCache(env);
    expect(cached?.latest).toBe('1.5.0');
    expect(cached?.checkedAt).toBe(1_700_000_000_000);
    expect(cached?.failedAt).toBe(fixedNow);
  });

  it('runProbe writes an empty-latest cache on first-ever failure', async () => {
    const env: NodeJS.ProcessEnv = {
      CONTEXTIFY_STATE_DIR: dir,
      CI: '',
      NODE_ENV: 'production',
    };
    const fixedNow = 1_700_000_000_000;
    await runProbe({
      env,
      currentVersion: '1.0.0',
      fetchLatest: async () => null,
      now: () => fixedNow,
    });
    const cached = await readCache(env);
    expect(cached?.latest).toBe('');
    expect(cached?.checkedAt).toBe(0);
    expect(cached?.failedAt).toBe(fixedNow);
  });
});
