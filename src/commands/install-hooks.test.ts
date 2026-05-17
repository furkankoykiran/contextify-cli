import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendHookCommand, installHooks } from './install-hooks.js';

describe('install-hooks — appendHookCommand (pure)', () => {
  it('appends a hook entry to an empty event', () => {
    const settings: Record<string, unknown> = {};
    const changed = appendHookCommand(
      settings as { hooks?: Record<string, unknown> },
      'Stop',
      '/p/stop.sh',
    );
    expect(changed).toBe(true);
    expect(settings).toMatchObject({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: '/p/stop.sh' }] }],
      },
    });
  });

  it('is idempotent when the same command already exists', () => {
    const settings = {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: '/p/stop.sh' }] }],
      },
    };
    const changed = appendHookCommand(settings, 'Stop', '/p/stop.sh');
    expect(changed).toBe(false);
    expect(settings.hooks.Stop).toHaveLength(1);
  });

  it('preserves unrelated event entries (PreToolUse, PostToolUse, …)', () => {
    const settings = {
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/x/pre.sh' }] }],
        PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: '/x/post.sh' }] }],
      },
    };
    appendHookCommand(settings as never, 'SessionStart', '/p/start.sh');
    expect(settings.hooks.PreToolUse).toEqual([
      { matcher: 'Bash', hooks: [{ type: 'command', command: '/x/pre.sh' }] },
    ]);
    expect(settings.hooks.PostToolUse).toEqual([
      { matcher: 'Edit', hooks: [{ type: 'command', command: '/x/post.sh' }] },
    ]);
    expect((settings.hooks as Record<string, unknown>).SessionStart).toBeDefined();
  });
});

describe('install-hooks — installHooks (filesystem)', () => {
  let state: string;
  let settingsPath: string;
  beforeEach(() => {
    state = mkdtempSync(join(tmpdir(), 'contextify-ih-'));
    settingsPath = join(state, 'fake-claude-settings.json');
  });
  afterEach(() => {
    rmSync(state, { recursive: true, force: true });
  });

  it('writes the three hook scripts with executable bit', async () => {
    const result = await installHooks({ stateRoot: state, claudeSettingsPath: settingsPath });
    for (const script of ['session-start.sh', 'stop.sh', 'session-end.sh']) {
      const path = join(result.hooksDir, script);
      const stat = statSync(path);
      // Executable for owner.
      expect(stat.mode & 0o100).not.toBe(0);
      expect(readFileSync(path, 'utf8')).toContain('contextify hooks');
    }
  });

  it('appends one entry per configured event when settings.json is missing', async () => {
    const result = await installHooks({ stateRoot: state, claudeSettingsPath: settingsPath });
    expect(result.appendedEvents).toEqual([
      'SessionStart',
      'Stop',
      'SessionEnd',
      'UserPromptSubmit',
      'PostToolUse',
    ]);
    expect(result.alreadyPresentEvents).toEqual([]);
    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(written.hooks.SessionStart[0].hooks[0].command).toContain('session-start.sh');
    expect(written.hooks.Stop[0].hooks[0].command).toContain('stop.sh');
    expect(written.hooks.SessionEnd[0].hooks[0].command).toContain('session-end.sh');
    expect(written.hooks.UserPromptSubmit[0].hooks[0].command).toContain('user-prompt-submit.sh');
    // PostToolUse carries a matcher so Claude Code only fires it for the
    // tools we actually ship in hooks.ts.
    expect(written.hooks.PostToolUse[0].matcher).toBe('Bash|Edit|MultiEdit|Write|WebFetch|Task');
    expect(written.hooks.PostToolUse[0].hooks[0].command).toContain('post-tool-use.sh');
  });

  it('preserves existing hooks (PreToolUse/PostToolUse) untouched', async () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        permissions: { allow: ['Bash(ls:*)'] },
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/x/pre.sh' }] }],
        },
      }),
    );
    await installHooks({ stateRoot: state, claudeSettingsPath: settingsPath });
    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(written.permissions.allow).toEqual(['Bash(ls:*)']);
    expect(written.hooks.PreToolUse).toEqual([
      { matcher: 'Bash', hooks: [{ type: 'command', command: '/x/pre.sh' }] },
    ]);
  });

  it('is a no-op on the second run (idempotency)', async () => {
    const first = await installHooks({ stateRoot: state, claudeSettingsPath: settingsPath });
    expect(first.appendedEvents).toEqual([
      'SessionStart',
      'Stop',
      'SessionEnd',
      'UserPromptSubmit',
      'PostToolUse',
    ]);
    const second = await installHooks({ stateRoot: state, claudeSettingsPath: settingsPath });
    expect(second.appendedEvents).toHaveLength(0);
    expect(second.alreadyPresentEvents).toEqual([
      'SessionStart',
      'Stop',
      'SessionEnd',
      'UserPromptSubmit',
      'PostToolUse',
    ]);
  });

  it('snapshots an existing settings.json to backups/ before modifying', async () => {
    const original = JSON.stringify({ permissions: { allow: [] } });
    writeFileSync(settingsPath, original);
    const result = await installHooks({ stateRoot: state, claudeSettingsPath: settingsPath });
    expect(result.backupPath).not.toBeNull();
    // copyFile preserves bytes — backup is the original verbatim.
    expect(readFileSync(result.backupPath!, 'utf8')).toBe(original);
  });
});
