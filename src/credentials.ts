/**
 * API key resolution for the CLI.
 *
 * Codex P3.5 prescription:
 *   1. CONTEXTIFY_API_KEY env var wins (hosted/prod via systemd/launchd)
 *   2. ~/.contextify/credentials.json on disk (per-user, persistent)
 *   3. nothing — request goes unauthenticated, server falls back to
 *      LEGACY_TENANT_ID (only allowed when the server has
 *      ALLOW_UNAUTHENTICATED_INGEST=1 or NODE_ENV != production)
 *
 * The credentials file is intentionally NOT inside the project repo —
 * bearer keys must never be committable.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const CRED_FILENAME = 'credentials.json';
const CRED_DIR_NAME = '.contextify';

export interface CredentialsFile {
  /**
   * The full `ctx_live_<prefix>_<secret>` string as issued by the
   * dashboard. We never split it — the server parses the prefix
   * itself from the bearer header.
   */
  readonly apiKey: string;
  /** Optional label for the key — informational only. */
  readonly name?: string;
  /** When this credentials file was written. */
  readonly savedAt?: string;
  /** Server URL this key was issued for. Lets users keep distinct keys per env. */
  readonly serverUrl?: string;
}

export interface ResolvedCredentials {
  readonly apiKey: string;
  readonly source: 'env' | 'file';
}

export function credentialsPath(home: string = homedir()): string {
  return join(home, CRED_DIR_NAME, CRED_FILENAME);
}

/**
 * Resolve the API key for outbound requests. Returns null if neither
 * env nor file has one — callers should ship without an Authorization
 * header in that case (server permits this in dev fallback mode).
 */
export function resolveApiKey(env: NodeJS.ProcessEnv = process.env): ResolvedCredentials | null {
  const fromEnv = env.CONTEXTIFY_API_KEY?.trim();
  if (fromEnv) {
    return { apiKey: fromEnv, source: 'env' };
  }
  const path = credentialsPath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as CredentialsFile;
    if (parsed?.apiKey && parsed.apiKey.startsWith('ctx_live_')) {
      return { apiKey: parsed.apiKey, source: 'file' };
    }
  } catch {
    // Don't crash on a malformed credentials file — fall through to
    // unauthenticated. The user can re-run `contextify login` to fix it.
  }
  return null;
}

/**
 * Write a credentials file with secure permissions. Used by
 * `contextify login --key <key>` (added later) and by integration
 * tests. The file is chmod 600 — only the user can read.
 */
export function saveCredentials(file: CredentialsFile, home: string = homedir()): string {
  const path = credentialsPath(home);
  mkdirSync(dirname(path), { recursive: true });
  const payload: CredentialsFile = {
    ...file,
    savedAt: new Date().toISOString(),
  };
  writeFileSync(path, JSON.stringify(payload, null, 2), { mode: 0o600 });
  // Re-chmod in case writeFile didn't honor `mode` (e.g. existing file).
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort
  }
  return path;
}
