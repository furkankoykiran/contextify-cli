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
    await runInstall({}, { stateRoot, claudeSettingsPath: settingsPath });
    const stdout = makeStream();
    const stderr = makeStream();
    const exit = await runInstall(
      {},
      {
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
        await runInstall({}, { stateRoot, claudeSettingsPath: settingsPath });
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
    await runInstall({}, { stateRoot, claudeSettingsPath: settingsPath });
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
    };
    expect(out.dryRun).toBe(true);
    expect(out.wouldWriteHooks).toEqual(['SessionStart', 'Stop', 'SessionEnd']);
    expect(out.settingsPath).toBe(settingsPath);
    // Settings file was NOT touched.
    expect(() => readFileSync(settingsPath, 'utf8')).toThrow();
  });
});
