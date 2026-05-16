import { mkdtempSync, rmSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSpool, shipBatch, SPOOL_DIR, type Batch } from './shipper.js';

const batch: Batch = {
  projectId: 'divimero',
  sessionId: 'sess-1',
  payload: 'hello',
};

describe('@contextify/cli shipper', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'contextify-ship-'));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  describe('shipBatch', () => {
    it('POSTs gzip-encoded JSON to /api/telemetry/ingest', async () => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify({ id: 'x' }), { status: 202 }));
      const result = await shipBatch(batch, {
        serverUrl: 'http://example/',
        cwd,
        fetchImpl,
      });
      expect(result.status).toBe('sent');
      expect(result.statusCode).toBe(202);

      const [url, init] = fetchImpl.mock.calls[0]!;
      expect(url).toBe('http://example/api/telemetry/ingest');
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers['content-encoding']).toBe('gzip');
      const body = (init as RequestInit).body as Uint8Array;
      const decoded = JSON.parse(gunzipSync(Buffer.from(body)).toString('utf8'));
      expect(decoded).toEqual(batch);
    });

    it('spools on network failure', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('net'));
      const result = await shipBatch(batch, {
        serverUrl: 'http://example/',
        cwd,
        fetchImpl,
      });
      expect(result.status).toBe('spooled');
      const spooled = await readdir(join(cwd, SPOOL_DIR));
      expect(spooled.filter((f) => f.endsWith('.json.gz'))).toHaveLength(1);
    });

    it('spools on non-2xx response', async () => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('nope', { status: 500 }));
      const result = await shipBatch(batch, {
        serverUrl: 'http://example/',
        cwd,
        fetchImpl,
      });
      expect(result.status).toBe('spooled');
      expect(result.error).toContain('500');
    });

    it('forceSpool skips the network entirely', async () => {
      const fetchImpl = vi.fn<typeof fetch>();
      const result = await shipBatch(batch, {
        serverUrl: 'http://example/',
        cwd,
        fetchImpl,
        forceSpool: true,
      });
      expect(result.status).toBe('spooled');
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('sends Authorization: Bearer when credentials are provided', async () => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify({ id: 'x' }), { status: 202 }));
      await shipBatch(batch, {
        serverUrl: 'http://example/',
        cwd,
        fetchImpl,
        credentials: {
          apiKey: 'ctx_live_aaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          source: 'env',
        },
      });
      const [, init] = fetchImpl.mock.calls[0]!;
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers.authorization).toBe(
        'Bearer ctx_live_aaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      );
    });

    it('sends no Authorization header when credentials are explicitly null', async () => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify({ id: 'x' }), { status: 202 }));
      await shipBatch(batch, {
        serverUrl: 'http://example/',
        cwd,
        fetchImpl,
        credentials: null,
      });
      const [, init] = fetchImpl.mock.calls[0]!;
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers.authorization).toBeUndefined();
    });
  });

  describe('flushSpool', () => {
    it('returns zeros when no spool dir exists', async () => {
      const result = await flushSpool({ serverUrl: 'http://example/', cwd });
      expect(result).toEqual({ attempted: 0, sent: 0, remaining: 0 });
    });

    it('ships every spool entry on success and clears the directory', async () => {
      // Seed the spool with two failures, then flush against a success mock.
      await shipBatch(batch, { serverUrl: 'http://example/', cwd, forceSpool: true });
      await shipBatch(
        { ...batch, payload: 'world' },
        {
          serverUrl: 'http://example/',
          cwd,
          forceSpool: true,
        },
      );

      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('{}', { status: 202 }));
      const result = await flushSpool({
        serverUrl: 'http://example/',
        cwd,
        fetchImpl,
      });
      expect(result.attempted).toBe(2);
      expect(result.sent).toBe(2);
      expect(result.remaining).toBe(0);
    });

    it('leaves entries on disk if shipping fails', async () => {
      await shipBatch(batch, { serverUrl: 'http://example/', cwd, forceSpool: true });
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('nope', { status: 500 }));
      const result = await flushSpool({
        serverUrl: 'http://example/',
        cwd,
        fetchImpl,
      });
      expect(result.sent).toBe(0);
      expect(result.remaining).toBeGreaterThanOrEqual(1);
    });
  });
});
