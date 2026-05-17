/**
 * `contextify install` — zero-config global install.
 *
 * Materializes the three hook scripts under ~/.contextify/hooks/ and
 * merges hook entries into ~/.claude/settings.json. Idempotent. Does
 * NOT write .contextify.json into the cwd — that's `init`'s job.
 *
 * Also persists API credentials when --key (or CONTEXTIFY_API_KEY) is
 * available, so IDE-spawned hook subprocesses (which do not inherit the
 * operator's shell env) can authenticate against the SaaS via the
 * on-disk ~/.contextify/credentials.json. Without this step, hooks ship
 * unauthenticated and the server rejects them with 401.
 *
 * Designed for users who want one-time global wiring: run once anywhere,
 * and every Claude Code session in any directory gets captured. The hook
 * scripts resolve project_id dynamically from each session's cwd at
 * fire-time via identity.ts, so no per-project setup is required.
 *
 * Flags:
 *   --key <ctx_live_...>   Persist this API key (chmod 600).
 *   --server <url>         Persist server URL alongside the key.
 *   --name <label>         Optional label stored next to the key.
 *   --dry-run              Print what would change without modifying anything.
 *
 * Env auto-detect (when flags absent):
 *   CONTEXTIFY_API_KEY     Used as --key.
 *   CONTEXTIFY_SERVER_URL  Used as --server.
 */
import { saveCredentials } from '../credentials.js';
import { KEY_RE } from './login.js';
import { HOOK_EVENTS, installHooks, type InstallHooksResult } from './install-hooks.js';

export interface InstallArgs {
  readonly dryRun?: boolean;
  readonly apiKey?: string;
  readonly serverUrl?: string;
  readonly name?: string;
}

export interface InstallOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly stdout?: NodeJS.WriteStream;
  readonly stderr?: NodeJS.WriteStream;
  /** For tests: bypass the real ~/.claude / ~/.contextify dirs. */
  readonly stateRoot?: string;
  readonly claudeSettingsPath?: string;
  /** For tests / dry-run preview. */
  readonly runner?: (opts: {
    stateRoot?: string;
    claudeSettingsPath?: string;
  }) => Promise<InstallHooksResult>;
  /** For tests: override credentials persistence. */
  readonly saveCredentialsImpl?: typeof saveCredentials;
}

interface ResolvedCreds {
  readonly apiKey: string;
  readonly serverUrl?: string;
  readonly name?: string;
  readonly source: 'flag' | 'env';
}

function resolveInstallCreds(args: InstallArgs, env: NodeJS.ProcessEnv): ResolvedCreds | null {
  const flagKey = args.apiKey?.trim();
  if (flagKey) {
    return {
      apiKey: flagKey,
      serverUrl: args.serverUrl?.trim() || env.CONTEXTIFY_SERVER_URL?.trim() || undefined,
      name: args.name?.trim() || undefined,
      source: 'flag',
    };
  }
  const envKey = env.CONTEXTIFY_API_KEY?.trim();
  if (envKey) {
    return {
      apiKey: envKey,
      serverUrl: args.serverUrl?.trim() || env.CONTEXTIFY_SERVER_URL?.trim() || undefined,
      name: args.name?.trim() || undefined,
      source: 'env',
    };
  }
  return null;
}

export async function runInstall(args: InstallArgs, opts: InstallOptions = {}): Promise<number> {
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const runner = opts.runner ?? installHooks;
  const env = opts.env ?? process.env;
  const persist = opts.saveCredentialsImpl ?? saveCredentials;

  const creds = resolveInstallCreds(args, env);
  if (creds && !KEY_RE.test(creds.apiKey)) {
    stderr.write(
      `contextify install: API key from ${creds.source === 'flag' ? '--key' : 'CONTEXTIFY_API_KEY'} does not look like a contextify api key.\n` +
        `Expected format: ctx_live_<8>_<32>\n`,
    );
    return 2;
  }

  if (args.dryRun) {
    const { defaultStateRoot, defaultClaudeSettingsPath } = await import('./install-hooks.js');
    const stateRoot = opts.stateRoot ?? defaultStateRoot(env);
    const settingsPath = opts.claudeSettingsPath ?? defaultClaudeSettingsPath(env);
    stdout.write(
      `${JSON.stringify(
        {
          dryRun: true,
          wouldWriteHooks: HOOK_EVENTS,
          hooksDir: `${stateRoot}/hooks`,
          settingsPath,
          backupDir: `${stateRoot}/backups`,
          wouldPersistCredentials: creds
            ? { source: creds.source, serverUrl: creds.serverUrl ?? null }
            : null,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  let result: InstallHooksResult;
  try {
    result = await runner({
      stateRoot: opts.stateRoot,
      claudeSettingsPath: opts.claudeSettingsPath,
    });
  } catch (err) {
    stderr.write(`contextify install: ${(err as Error).message}\n`);
    return 1;
  }

  let credentialsPath: string | null = null;
  if (creds) {
    try {
      credentialsPath = persist({
        apiKey: creds.apiKey,
        name: creds.name,
        serverUrl: creds.serverUrl,
      });
    } catch (err) {
      stderr.write(
        `contextify install: failed to persist credentials: ${(err as Error).message}\n`,
      );
      return 1;
    }
  }

  const allPresent =
    result.appendedEvents.length === 0 && result.alreadyPresentEvents.length === HOOK_EVENTS.length;

  stdout.write(`${allPresent ? 'Hooks already installed' : 'Installed Contextify hooks'} (`);
  stdout.write(`appended=${JSON.stringify(result.appendedEvents)}, `);
  stdout.write(`alreadyPresent=${JSON.stringify(result.alreadyPresentEvents)})\n`);
  stdout.write(`  hooks dir:     ${result.hooksDir}\n`);
  stdout.write(`  settings:      ${result.settingsPath}\n`);
  if (result.backupPath) {
    stdout.write(`  backup:        ${result.backupPath}\n`);
  }
  if (credentialsPath) {
    stdout.write(`  credentials:   ${credentialsPath} (chmod 600, source=${creds!.source})\n`);
  } else {
    stdout.write(
      `  credentials:   NOT PERSISTED — hooks will ship unauthenticated and the server\n` +
        `                 will reject them with 401. Re-run with --key or set\n` +
        `                 CONTEXTIFY_API_KEY before invoking install.\n`,
    );
  }
  stdout.write(`\n`);
  stdout.write(`Hooks fire automatically on every Claude Code session. project_id\n`);
  stdout.write(`is derived from each session's cwd at fire-time via the identity stack\n`);
  stdout.write(`(env override → .contextify.json → git remote → folder realpath).\n`);
  return 0;
}
