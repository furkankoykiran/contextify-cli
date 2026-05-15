/**
 * Wrap integration test: spawn a real child via `contextify wrap` and verify
 * that its stdout is captured and shipped (here: spooled, since we point
 * at an unreachable server). This exercises the full chain:
 *
 *   child stdout -> Batcher -> shipBatch (network fail) -> .contextify/spool
 *
 * No DATABASE_URL required.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runWrap } from './commands/wrap.js';
import { SPOOL_DIR } from './shipper.js';

describe('@contextify/cli wrap (integration)', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), 'contextify-wrap-'));
    await writeFile(
      join(cwd, '.contextify.json'),
      JSON.stringify(
        {
          projectId: 'divimero',
          projectName: 'Divimero',
          // unreachable port — guaranteed to fail and spool
          serverUrl: 'http://127.0.0.1:1',
        },
        null,
        2,
      ),
      'utf8',
    );
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('captures child stdout and spools it when the server is unreachable', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const exit = await runWrap({
        argv: ['node', '-e', "process.stdout.write('hello-from-child\\n')"],
        cwd,
      });
      expect(exit).toBe(0);
    } finally {
      writeSpy.mockRestore();
    }

    const dir = join(cwd, SPOOL_DIR);
    const entries = (await readdir(dir)).filter((f) => f.endsWith('.json.gz'));
    expect(entries.length).toBeGreaterThanOrEqual(1);

    const raw = await readFile(join(dir, entries[0]!));
    const decoded = JSON.parse(gunzipSync(raw).toString('utf8')) as {
      projectId: string;
      sessionId: string;
      payload: string;
    };
    expect(decoded.projectId).toBe('divimero');
    expect(decoded.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(decoded.payload).toContain('hello-from-child');
  }, 15_000);

  it('propagates the child exit code', async () => {
    const exit = await runWrap({
      argv: ['node', '-e', 'process.exit(7)'],
      cwd,
    });
    expect(exit).toBe(7);
  }, 15_000);

  it("returns 2 when there's no command after --", async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exit = await runWrap({ argv: [], cwd });
    expect(exit).toBe(2);
    stderr.mockRestore();
  });
});
