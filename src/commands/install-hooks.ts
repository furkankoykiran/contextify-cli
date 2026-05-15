/**
 * `contextify init --install-hooks` implementation.
 *
 * 1. Materialize the three hook scripts into <state>/hooks/ with executable bit.
 * 2. Snapshot ~/.claude/settings.json to <state>/backups/settings.<UTC>.json.
 * 3. Merge a SessionStart / Stop / SessionEnd entry into settings.json,
 *    skipping any event that already references our hook command.
 *
 * Idempotent: rerunning is a no-op (modulo the harmless backup).
 *
 * See docs/DESIGN-claude-code-hooks.md §5.
 */
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const HOOK_EVENTS = ['SessionStart', 'Stop', 'SessionEnd'] as const;
export type ClaudeHookEvent = (typeof HOOK_EVENTS)[number];

const SCRIPT_FILES: Record<ClaudeHookEvent, string> = {
  SessionStart: 'session-start.sh',
  Stop: 'stop.sh',
  SessionEnd: 'session-end.sh',
};

const SCRIPT_BODIES: Record<ClaudeHookEvent, string> = {
  SessionStart: `#!/usr/bin/env bash
# Contextify hook — SessionStart.
# Pipes the Claude Code hook stdin into 'contextify hooks session-start'.
# Silent on success, never blocks.
exec contextify hooks session-start
`,
  Stop: `#!/usr/bin/env bash
# Contextify hook — Stop.
# Pipes the Claude Code hook stdin into 'contextify hooks stop'.
# Silent on success, never blocks.
exec contextify hooks stop
`,
  SessionEnd: `#!/usr/bin/env bash
# Contextify hook — SessionEnd.
# Pipes the Claude Code hook stdin into 'contextify hooks session-end'.
# Silent on success, never blocks.
exec contextify hooks session-end
`,
};

export interface InstallHooksOptions {
  readonly stateRoot?: string;
  readonly claudeSettingsPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** For tests — override the script bodies. */
  readonly scriptBodies?: Partial<Record<ClaudeHookEvent, string>>;
}

export interface InstallHooksResult {
  readonly stateRoot: string;
  readonly hooksDir: string;
  readonly settingsPath: string;
  readonly backupPath: string | null;
  /** Events whose hook entry we appended. */
  readonly appendedEvents: readonly ClaudeHookEvent[];
  /** Events that already had our hook entry — left untouched. */
  readonly alreadyPresentEvents: readonly ClaudeHookEvent[];
}

interface HookCommandEntry {
  type: 'command';
  command: string;
}

interface HookMatcherGroup {
  matcher?: string;
  hooks: HookCommandEntry[];
}

type SettingsHooks = Partial<Record<string, HookMatcherGroup[] | undefined>>;

interface ClaudeSettings {
  hooks?: SettingsHooks;
  [k: string]: unknown;
}

export function defaultStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.CONTEXTIFY_STATE_DIR ?? join(homedir(), '.contextify');
}

export function defaultClaudeSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_SETTINGS_PATH ?? join(homedir(), '.claude', 'settings.json');
}

function hookCommandFor(stateRoot: string, event: ClaudeHookEvent): string {
  return join(stateRoot, 'hooks', SCRIPT_FILES[event]);
}

async function ensureDir(path: string): Promise<void> {
  if (!existsSync(path)) await mkdir(path, { recursive: true });
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, path);
}

async function readSettings(path: string): Promise<ClaudeSettings> {
  if (!existsSync(path)) return {};
  const raw = await readFile(path, 'utf8');
  if (raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as ClaudeSettings;
    }
    throw new Error('settings.json root must be an object');
  } catch (err) {
    throw new Error(`failed to parse ${path}: ${(err as Error).message}`);
  }
}

function eventHasCommand(groups: HookMatcherGroup[] | undefined, command: string): boolean {
  if (!groups) return false;
  for (const g of groups) {
    if (!g || !Array.isArray(g.hooks)) continue;
    for (const h of g.hooks) {
      if (h && h.type === 'command' && h.command === command) return true;
    }
  }
  return false;
}

/**
 * Append `command` under `hooks.<event>` without disturbing other groups.
 * Returns true if a new entry was appended, false if already present.
 */
export function appendHookCommand(
  settings: ClaudeSettings,
  event: ClaudeHookEvent,
  command: string,
): boolean {
  const hooks: SettingsHooks = settings.hooks ?? {};
  const existing = hooks[event];
  if (eventHasCommand(existing, command)) return false;
  const groups: HookMatcherGroup[] = Array.isArray(existing) ? [...existing] : [];
  groups.push({ hooks: [{ type: 'command', command }] });
  hooks[event] = groups;
  settings.hooks = hooks;
  return true;
}

async function materializeScripts(
  stateRoot: string,
  bodies: Record<ClaudeHookEvent, string>,
): Promise<string> {
  const hooksDir = join(stateRoot, 'hooks');
  await ensureDir(hooksDir);
  for (const event of HOOK_EVENTS) {
    const target = join(hooksDir, SCRIPT_FILES[event]);
    await atomicWrite(target, bodies[event]);
    await chmod(target, 0o755);
  }
  return hooksDir;
}

async function snapshotSettings(stateRoot: string, settingsPath: string): Promise<string | null> {
  if (!existsSync(settingsPath)) return null;
  const backupDir = join(stateRoot, 'backups');
  await ensureDir(backupDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = join(backupDir, `settings.${stamp}.json`);
  await copyFile(settingsPath, backupPath);
  return backupPath;
}

export async function installHooks(opts: InstallHooksOptions = {}): Promise<InstallHooksResult> {
  const env = opts.env ?? process.env;
  const stateRoot = opts.stateRoot ?? defaultStateRoot(env);
  const settingsPath = opts.claudeSettingsPath ?? defaultClaudeSettingsPath(env);

  const bodies: Record<ClaudeHookEvent, string> = {
    SessionStart: opts.scriptBodies?.SessionStart ?? SCRIPT_BODIES.SessionStart,
    Stop: opts.scriptBodies?.Stop ?? SCRIPT_BODIES.Stop,
    SessionEnd: opts.scriptBodies?.SessionEnd ?? SCRIPT_BODIES.SessionEnd,
  };

  const hooksDir = await materializeScripts(stateRoot, bodies);
  const backupPath = await snapshotSettings(stateRoot, settingsPath);
  const settings = await readSettings(settingsPath);

  const appended: ClaudeHookEvent[] = [];
  const present: ClaudeHookEvent[] = [];

  for (const event of HOOK_EVENTS) {
    const command = hookCommandFor(stateRoot, event);
    if (appendHookCommand(settings, event, command)) {
      appended.push(event);
    } else {
      present.push(event);
    }
  }

  // Even when nothing changed, write settings back so the file always
  // exists when we get to this point (rare edge case: empty default).
  await atomicWrite(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

  return {
    stateRoot,
    hooksDir,
    settingsPath,
    backupPath,
    appendedEvents: appended,
    alreadyPresentEvents: present,
  };
}
