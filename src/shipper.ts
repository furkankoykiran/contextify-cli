/**
 * Webhook shipper with disk-spool fallback.
 *
 * The shipper takes a batch envelope and POSTs it gzip-compressed to the
 * server's /api/telemetry/ingest endpoint. If the server is unreachable
 * or returns a non-2xx, the batch is written to `<cwd>/.contextify/spool/`
 * so a later `contextify ship --once` can flush it.
 *
 * The CLI must never block the user's terminal — so all error handling
 * is silent (logs go to stderr only with --verbose, not implemented yet).
 */
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { resolveApiKey, type ResolvedCredentials } from './credentials.js';

export interface Batch {
  readonly projectId: string;
  readonly projectName?: string;
  readonly sessionId: string;
  readonly payload: string;
  /**
   * Origin discriminator. Omitted by the legacy wrap path; the API
   * defaults missing values to 'terminal' so old callers keep working.
   */
  readonly source?: 'terminal' | 'claude-code';
}

export interface ShipOptions {
  readonly serverUrl: string;
  readonly cwd: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /** When true, skip the network attempt entirely and spool. Useful for tests. */
  readonly forceSpool?: boolean;
  /**
   * Optional explicit credentials. Defaults to resolving via env then
   * `~/.contextify/credentials.json`. When null, the request goes
   * unauthenticated and the server rejects it with 401.
   * Tests can override this to assert the auth header is present.
   */
  readonly credentials?: ResolvedCredentials | null;
}

export interface ShipResult {
  readonly status: 'sent' | 'spooled' | 'error';
  readonly statusCode?: number;
  readonly spoolPath?: string;
  readonly error?: string;
}

export const SPOOL_DIR = '.contextify/spool';

export async function shipBatch(batch: Batch, opts: ShipOptions): Promise<ShipResult> {
  if (opts.forceSpool) {
    return spoolBatch(batch, opts.cwd, 'forceSpool');
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = new URL('/api/telemetry/ingest', opts.serverUrl).toString();
  const body = gzipSync(Buffer.from(JSON.stringify(batch), 'utf8'));

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10_000);
  try {
    // Resolve credentials lazily so call sites can inject test fixtures
    // via `opts.credentials`. `undefined` triggers the default lookup;
    // `null` means "send no Authorization header" (explicit unauth).
    const creds = opts.credentials === undefined ? resolveApiKey() : opts.credentials;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
    };
    if (creds) {
      headers.authorization = `Bearer ${creds.apiKey}`;
    }
    const res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      return spoolBatch(batch, opts.cwd, `HTTP ${res.status}`);
    }
    return { status: 'sent', statusCode: res.status };
  } catch (err) {
    return spoolBatch(batch, opts.cwd, (err as Error).message);
  } finally {
    clearTimeout(timeout);
  }
}

export async function spoolBatch(batch: Batch, cwd: string, reason: string): Promise<ShipResult> {
  try {
    const dir = join(cwd, SPOOL_DIR);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tmp = join(dir, `${stamp}.json.gz.tmp`);
    const final = join(dir, `${stamp}.json.gz`);
    const body = gzipSync(Buffer.from(JSON.stringify(batch), 'utf8'));
    await writeFile(tmp, body);
    await rename(tmp, final);
    return { status: 'spooled', spoolPath: final, error: reason };
  } catch (err) {
    return { status: 'error', error: (err as Error).message };
  }
}

export interface FlushOptions {
  readonly serverUrl: string;
  readonly cwd: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface FlushResult {
  readonly attempted: number;
  readonly sent: number;
  readonly remaining: number;
}

export async function flushSpool(opts: FlushOptions): Promise<FlushResult> {
  const dir = join(opts.cwd, SPOOL_DIR);
  if (!existsSync(dir)) return { attempted: 0, sent: 0, remaining: 0 };
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json.gz'));
  let sent = 0;
  for (const file of files) {
    const full = join(dir, file);
    const raw = await readFile(full);
    let batch: Batch;
    try {
      // The spool stores gzipped JSON. We could re-ship the raw gzip body
      // directly but that complicates the request — decompress and let
      // shipBatch re-compress so the wire shape stays consistent.
      const { gunzipSync } = await import('node:zlib');
      batch = JSON.parse(gunzipSync(raw).toString('utf8')) as Batch;
    } catch {
      // Corrupt spool entry — drop it so we don't loop forever.
      await unlink(full).catch(() => {});
      continue;
    }
    const result = await shipBatch(batch, {
      serverUrl: opts.serverUrl,
      cwd: opts.cwd,
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs,
    });
    if (result.status === 'sent') {
      await unlink(full).catch(() => {});
      sent += 1;
    }
  }
  const remaining = (await readdir(dir)).filter((f) => f.endsWith('.json.gz')).length;
  return { attempted: files.length, sent, remaining };
}
