/**
 * `contextify hooks <event>` — internal entry point for the Claude Code hooks.
 *
 * The three hook events delegate to this command. It reads the Claude Code
 * hook payload from stdin, resolves identity at the cwd, and:
 *   - session-start: upserts the project and writes session state.
 *   - stop: parses the transcript for the latest turn and ships it.
 *   - session-end: flushes the spool and clears session state.
 *
 * The CLI bin (`contextify`) routes to this when called as
 * `contextify hooks <event>`. Bash hook scripts do nothing except pipe
 * the hook stdin into this and discard the exit code.
 */
import { readFile, mkdir, writeFile, unlink, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_SERVER_URL } from '../config.js';
import { resolveIdentity, type ResolvedIdentity } from '../identity.js';
import { flushSpool, shipBatch, type Batch } from '../shipper.js';
import { parseLatestTurn } from '../transcript.js';

export type HookEvent = 'session-start' | 'stop' | 'session-end';

export interface HookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  source?: string;
  reason?: string;
  // Permissive — Claude Code adds fields over time; we ignore unknown.
  [k: string]: unknown;
}

export interface SessionState {
  projectId: string;
  projectName: string;
  serverUrl: string;
  cwd: string;
  startedAt: string;
  lastShippedUuid?: string;
}

export interface HookDeps {
  readonly env?: NodeJS.ProcessEnv;
  /** For tests: where to read stdin from. Default: process.stdin. */
  readonly readStdin?: () => Promise<string>;
  /** For tests: override the contextify state directory. */
  readonly stateRoot?: string;
  /** For tests: HTTP client override. */
  readonly fetchImpl?: typeof fetch;
}

/** Default stdin reader — fully consumes process.stdin. */
async function defaultReadStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buf += chunk;
    });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

export function stateRootFor(env: NodeJS.ProcessEnv, override?: string): string {
  if (override) return override;
  return env.CONTEXTIFY_STATE_DIR ?? join(homedir(), '.contextify');
}

function sessionFile(stateRoot: string, sessionId: string): string {
  return join(stateRoot, 'sessions', `${sessionId}.json`);
}

async function ensureDir(path: string): Promise<void> {
  if (!existsSync(path)) await mkdir(path, { recursive: true });
}

async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await rename(tmp, path);
}

async function readSession(stateRoot: string, sessionId: string): Promise<SessionState | null> {
  const path = sessionFile(stateRoot, sessionId);
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as SessionState;
  } catch {
    return null;
  }
}

async function appendLog(stateRoot: string, line: string): Promise<void> {
  try {
    await ensureDir(stateRoot);
    const path = join(stateRoot, 'hooks.log');
    const { appendFile } = await import('node:fs/promises');
    await appendFile(path, `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch {
    // never block on logging
  }
}

function serverUrlFromEnv(env: NodeJS.ProcessEnv): string {
  return env.CONTEXTIFY_SERVER_URL || DEFAULT_SERVER_URL;
}

async function upsertProject(
  serverUrl: string,
  identity: ResolvedIdentity,
  fetchImpl: typeof fetch,
): Promise<void> {
  const url = new URL('/api/projects', serverUrl).toString();
  await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: identity.projectId, name: identity.projectName }),
  });
}

async function runSessionStart(
  payload: HookPayload,
  deps: Required<HookDepsResolved>,
): Promise<number> {
  const cwd = payload.cwd ?? deps.env.PWD ?? process.cwd();
  const sessionId = payload.session_id;
  if (!sessionId) {
    await appendLog(deps.stateRoot, 'session-start: missing session_id');
    return 0;
  }
  let identity: ResolvedIdentity;
  try {
    identity = await resolveIdentity({ cwd, env: deps.env });
  } catch (err) {
    await appendLog(deps.stateRoot, `session-start: identity error: ${(err as Error).message}`);
    return 0;
  }
  const serverUrl = serverUrlFromEnv(deps.env);
  const state: SessionState = {
    projectId: identity.projectId,
    projectName: identity.projectName,
    serverUrl,
    cwd,
    startedAt: new Date().toISOString(),
  };
  await atomicWriteJson(sessionFile(deps.stateRoot, sessionId), state);
  // Best-effort upsert. Don't block on failure.
  try {
    await upsertProject(serverUrl, identity, deps.fetchImpl);
  } catch (err) {
    await appendLog(deps.stateRoot, `session-start: upsert failed: ${(err as Error).message}`);
  }
  return 0;
}

async function runStop(payload: HookPayload, deps: Required<HookDepsResolved>): Promise<number> {
  const sessionId = payload.session_id;
  const transcriptPath = payload.transcript_path;
  if (!sessionId || !transcriptPath) {
    await appendLog(deps.stateRoot, 'stop: missing session_id or transcript_path');
    return 0;
  }
  const state = await readSession(deps.stateRoot, sessionId);
  if (!state) {
    await appendLog(deps.stateRoot, `stop: no session state for ${sessionId} — skipping`);
    return 0;
  }
  let transcript: string;
  try {
    transcript = await readFile(transcriptPath, 'utf8');
  } catch (err) {
    await appendLog(deps.stateRoot, `stop: cannot read transcript: ${(err as Error).message}`);
    return 0;
  }
  const turn = parseLatestTurn(transcript);
  if (!turn) {
    await appendLog(deps.stateRoot, 'stop: no completed text turn — skipping');
    return 0;
  }
  if (state.lastShippedUuid && state.lastShippedUuid === turn.transcriptUuid) {
    // Already shipped this exact turn — Stop must have re-fired.
    return 0;
  }

  const dialogEnvelope = {
    source: 'claude-code' as const,
    turn,
  };
  const batch: Batch = {
    projectId: state.projectId,
    projectName: state.projectName,
    sessionId,
    payload: JSON.stringify(dialogEnvelope),
    source: 'claude-code',
  };
  const ship = await shipBatch(batch, {
    serverUrl: state.serverUrl,
    cwd: state.cwd,
    fetchImpl: deps.fetchImpl,
  });
  if (ship.status === 'error') {
    await appendLog(deps.stateRoot, `stop: shipBatch error: ${ship.error ?? 'unknown'}`);
  }
  await atomicWriteJson(sessionFile(deps.stateRoot, sessionId), {
    ...state,
    lastShippedUuid: turn.transcriptUuid,
  } satisfies SessionState);
  return 0;
}

async function runSessionEnd(
  payload: HookPayload,
  deps: Required<HookDepsResolved>,
): Promise<number> {
  const sessionId = payload.session_id;
  if (!sessionId) {
    await appendLog(deps.stateRoot, 'session-end: missing session_id');
    return 0;
  }
  const state = await readSession(deps.stateRoot, sessionId);
  if (state) {
    try {
      await flushSpool({
        serverUrl: state.serverUrl,
        cwd: state.cwd,
        fetchImpl: deps.fetchImpl,
      });
    } catch (err) {
      await appendLog(deps.stateRoot, `session-end: flush error: ${(err as Error).message}`);
    }
  }
  // Best-effort cleanup; missing file is fine.
  try {
    await unlink(sessionFile(deps.stateRoot, sessionId));
  } catch {
    // ignored
  }
  return 0;
}

interface HookDepsResolved {
  env: NodeJS.ProcessEnv;
  readStdin: () => Promise<string>;
  stateRoot: string;
  fetchImpl: typeof fetch;
}

function resolveDeps(deps: HookDeps = {}): HookDepsResolved {
  const env = deps.env ?? process.env;
  return {
    env,
    readStdin: deps.readStdin ?? defaultReadStdin,
    stateRoot: stateRootFor(env, deps.stateRoot),
    fetchImpl: deps.fetchImpl ?? fetch,
  };
}

export async function runHook(event: HookEvent, deps: HookDeps = {}): Promise<number> {
  const resolved = resolveDeps(deps);
  let payload: HookPayload = {};
  try {
    const raw = (await resolved.readStdin()).trim();
    if (raw.length > 0) payload = JSON.parse(raw) as HookPayload;
  } catch (err) {
    await appendLog(resolved.stateRoot, `${event}: stdin parse error: ${(err as Error).message}`);
    return 0;
  }

  try {
    switch (event) {
      case 'session-start':
        return await runSessionStart(payload, resolved);
      case 'stop':
        return await runStop(payload, resolved);
      case 'session-end':
        return await runSessionEnd(payload, resolved);
      default:
        // Unreachable via the CLI dispatcher, but guard anyway.
        await appendLog(resolved.stateRoot, `unknown hook event: ${event as string}`);
        return 0;
    }
  } catch (err) {
    // Absolute backstop — hooks never propagate failure.
    await appendLog(resolved.stateRoot, `${event}: unhandled: ${(err as Error).message}`);
    return 0;
  }
}

/** Build a fresh session id (used only by tests that synthesize payloads). */
export function newSessionId(): string {
  return randomUUID();
}
