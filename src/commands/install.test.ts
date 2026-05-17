import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInstall } from './install.js';

function makeStream() {
  const s = new PassThrough();
  const chunks: Buffer[] = [];
  s.on('data', (c: Buffer) => chunks.push(c));
  (s as PassThrough & { collected: () => string }).collected = () =>
    Buffer.concat(chunks).toString('utf8');
  return s as PassThrough & { collected: () => string };
}

describe('contextify install', () => {
  let stateRoot: string;
  let settingsPath: string;
  beforeEach(() => {
    stateRoot = mkdtempSync(join(tmpdir(), 'contextify-install-'));
    settingsPath = join(stateRoot, 'fake-claude-settings.json');
  });
  afterEach(() => {
    rmSync(stateRoot, { recursive: true, force: true });
  });

  it('first run materializes scripts + writes all three event entries', async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const exit = await runInstall(
      {},
      {
        env: {},
        stateRoot,
        claudeSettingsPath: settingsPath,
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: stderr as unknown as NodeJS.WriteStream,
      },
    );
    expect(exit).toBe(0);
    expect(stdout.collected()).toContain('Installed Contextify hooks');
    expect(stdout.collected()).toContain('SessionStart');
    expect(stdout.collected()).toContain('Stop');
    expect(stdout.collected()).toContain('SessionEnd');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain('session-start.sh');
    expect(settings.hooks.Stop[0].hooks[0].command).toContain('stop.sh');
    expect(settings.hooks.SessionEnd[0].hooks[0].command).toContain('session-end.sh');
  });

  it('second run is a no-op — reports "already installed"', async () => {
    await runInstall({}, { env: {}, stateRoot, claudeSettingsPath: settingsPath });
    const stdout = makeStream();
    const stderr = makeStream();
    const exit = await runInstall(
      {},
      {
        env: {},
        stateRoot,
        claudeSettingsPath: settingsPath,
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: stderr as unknown as NodeJS.WriteStream,
      },
    );
    expect(exit).toBe(0);
    expect(stdout.collected()).toContain('Hooks already installed');
    expect(stdout.collected()).toContain('appended=[]');
  });

  it('does NOT write .contextify.json into the cwd (decoupled from init)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'contextify-install-cwd-'));
    try {
      const originalCwd = process.cwd();
      try {
        process.chdir(cwd);
        await runInstall({}, { env: {}, stateRoot, claudeSettingsPath: settingsPath });
      } finally {
        process.chdir(originalCwd);
      }
      // No project config should exist in the cwd.
      expect(() => readFileSync(join(cwd, '.contextify.json'), 'utf8')).toThrow();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('preserves pre-existing unrelated hooks under PreToolUse/PostToolUse', async () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        permissions: { allow: ['Bash(ls:*)'] },
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/x/pre.sh' }] }],
        },
      }),
    );
    await runInstall({}, { env: {}, stateRoot, claudeSettingsPath: settingsPath });
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(settings.permissions.allow).toEqual(['Bash(ls:*)']);
    expect(settings.hooks.PreToolUse).toEqual([
      { matcher: 'Bash', hooks: [{ type: 'command', command: '/x/pre.sh' }] },
    ]);
    // The Contextify hooks landed alongside, not on top of, PreToolUse.
    expect(settings.hooks.SessionStart).toBeDefined();
  });

  it('--dry-run prints what would change without touching anything', async () => {
    const stdout = makeStream();
    const exit = await runInstall(
      { dryRun: true },
      {
        env: {},
        stateRoot,
        claudeSettingsPath: settingsPath,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    );
    expect(exit).toBe(0);
    const out = JSON.parse(stdout.collected()) as {
      dryRun: boolean;
      wouldWriteHooks: string[];
      hooksDir: string;
      settingsPath: string;
      wouldPersistCredentials: { source: string; serverUrl: string | null } | null;
    };
    expect(out.dryRun).toBe(true);
    expect(out.wouldWriteHooks).toEqual([
      'SessionStart',
      'Stop',
      'SessionEnd',
      'UserPromptSubmit',
      'PostToolUse',
    ]);
    expect(out.settingsPath).toBe(settingsPath);
    expect(out.wouldPersistCredentials).toBeNull();
    expect(() => readFileSync(settingsPath, 'utf8')).toThrow();
  });

  it('persists credentials when --key is provided', async () => {
    const stdout = makeStream();
    const calls: Array<{ apiKey: string; serverUrl?: string; name?: string }> = [];
    const exit = await runInstall(
      {
        apiKey: 'ctx_live_abcdefgh_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        serverUrl: 'https://contextify.test',
        name: 'laptop',
      },
      {
        env: {},
        stateRoot,
        claudeSettingsPath: settingsPath,
        stdout: stdout as unknown as NodeJS.WriteStream,
        saveCredentialsImpl: (file) => {
          calls.push(file);
          return `${stateRoot}/credentials.json`;
        },
      },
    );
    expect(exit).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.apiKey).toBe('ctx_live_abcdefgh_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(calls[0]!.serverUrl).toBe('https://contextify.test');
    expect(calls[0]!.name).toBe('laptop');
    expect(stdout.collected()).toContain('source=flag');
  });

  it('auto-detects CONTEXTIFY_API_KEY from env when --key is absent', async () => {
    const stdout = makeStream();
    const calls: Array<{ apiKey: string; serverUrl?: string }> = [];
    const exit = await runInstall(
      {},
      {
        env: {
          CONTEXTIFY_API_KEY: 'ctx_live_zzzzzzzz_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
          CONTEXTIFY_SERVER_URL: 'https://contextify.test',
        },
        stateRoot,
        claudeSettingsPath: settingsPath,
        stdout: stdout as unknown as NodeJS.WriteStream,
        saveCredentialsImpl: (file) => {
          calls.push(file);
          return `${stateRoot}/credentials.json`;
        },
      },
    );
    expect(exit).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.apiKey).toBe('ctx_live_zzzzzzzz_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz');
    expect(calls[0]!.serverUrl).toBe('https://contextify.test');
    expect(stdout.collected()).toContain('source=env');
  });

  it('rejects malformed --key without writing anything', async () => {
    const stderr = makeStream();
    let saveCalled = false;
    const exit = await runInstall(
      { apiKey: 'not-a-key' },
      {
        env: {},
        stateRoot,
        claudeSettingsPath: settingsPath,
        stderr: stderr as unknown as NodeJS.WriteStream,
        saveCredentialsImpl: () => {
          saveCalled = true;
          return '';
        },
      },
    );
    expect(exit).toBe(2);
    expect(saveCalled).toBe(false);
    expect(stderr.collected()).toContain('does not look like a contextify api key');
  });

  it('warns when no credentials are available — hooks will ship unauthenticated', async () => {
    const stdout = makeStream();
    const exit = await runInstall(
      {},
      {
        env: {},
        stateRoot,
        claudeSettingsPath: settingsPath,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    );
    expect(exit).toBe(0);
    expect(stdout.collected()).toContain('credentials:   NOT PERSISTED');
  });
});
