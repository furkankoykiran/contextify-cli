import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHook, type SessionState } from './hooks.js';

function jsonl(...objs: unknown[]): string {
  return objs.map((o) => JSON.stringify(o)).join('\n');
}

function makeFetchSpy() {
  return vi.fn(
    async () =>
      new Response(JSON.stringify({ id: 'row-1' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }),
  );
}

describe('contextify hooks <event>', () => {
  let stateRoot: string;
  let cwd: string;
  beforeEach(() => {
    stateRoot = mkdtempSync(join(tmpdir(), 'contextify-hooks-state-'));
    cwd = mkdtempSync(join(tmpdir(), 'contextify-hooks-cwd-'));
  });
  afterEach(() => {
    rmSync(stateRoot, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it('session-start writes a session state file and POSTs /api/projects', async () => {
    const fetchSpy = makeFetchSpy();
    const sessionId = 'sess-1';
    const exit = await runHook('session-start', {
      env: { CONTEXTIFY_SERVER_URL: 'http://server.test' },
      stateRoot,
      readStdin: async () =>
        JSON.stringify({ session_id: sessionId, cwd, hook_event_name: 'SessionStart' }),
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(exit).toBe(0);
    const stateFile = join(stateRoot, 'sessions', `${sessionId}.json`);
    expect(existsSync(stateFile)).toBe(true);
    const state = JSON.parse(readFileSync(stateFile, 'utf8')) as SessionState;
    expect(state.projectId.length).toBeGreaterThan(0);
    expect(state.cwd).toBe(cwd);
    // Verify upsert call shape.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe('http://server.test/api/projects');
    const body = JSON.parse((init as RequestInit).body as string) as { id: string; name: string };
    expect(body.id).toBe(state.projectId);
  });

  it('stop ships the latest user→assistant turn with source=claude-code', async () => {
    // Seed session state as if session-start ran already.
    const sessionId = 'sess-2';
    const sessions = join(stateRoot, 'sessions');
    mkdirSync(sessions, { recursive: true });
    const state: SessionState = {
      projectId: 'demo_pid',
      projectName: 'demo',
      serverUrl: 'http://server.test',
      cwd,
      startedAt: new Date().toISOString(),
    };
    writeFileSync(join(sessions, `${sessionId}.json`), JSON.stringify(state));

    // Create a synthetic transcript with mixed text + tool_use blocks so we
    // can also assert that actions are extracted and shipped.
    const transcriptPath = join(stateRoot, 'transcript.jsonl');
    writeFileSync(
      transcriptPath,
      jsonl(
        {
          type: 'user',
          message: { role: 'user', content: 'always use postgres-js' },
          timestamp: 't1',
        },
        {
          type: 'assistant',
          uuid: 'A1',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', name: 'Bash', input: { command: 'pnpm add postgres' } },
              { type: 'tool_use', name: 'Edit', input: { file_path: '/repo/db.ts' } },
              { type: 'text', text: 'Acknowledged — postgres-js it is.' },
            ],
          },
          timestamp: 't2',
          cwd,
        },
      ),
    );

    const fetchSpy = makeFetchSpy();
    const exit = await runHook('stop', {
      stateRoot,
      readStdin: async () =>
        JSON.stringify({ session_id: sessionId, transcript_path: transcriptPath }),
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(exit).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe('http://server.test/api/telemetry/ingest');
    // Body was gzipped — decompress to inspect.
    const { gunzipSync } = await import('node:zlib');
    const raw = gunzipSync(Buffer.from(((init as RequestInit).body as Buffer) ?? Buffer.alloc(0)));
    const parsed = JSON.parse(raw.toString('utf8'));
    expect(parsed.projectId).toBe('demo_pid');
    expect(parsed.sessionId).toBe(sessionId);
    expect(parsed.source).toBe('claude-code');
    const turnEnvelope = JSON.parse(parsed.payload);
    expect(turnEnvelope.source).toBe('claude-code');
    expect(turnEnvelope.turn.userText).toBe('always use postgres-js');
    expect(turnEnvelope.turn.assistantText).toBe('Acknowledged — postgres-js it is.');
    expect(turnEnvelope.turn.transcriptUuid).toBe('A1');
    // Actions executed during the turn are bundled in.
    expect(turnEnvelope.turn.actions).toEqual([
      { kind: 'bash', detail: 'pnpm add postgres' },
      { kind: 'edit', detail: '/repo/db.ts' },
    ]);

    // lastShippedUuid should be recorded for dedup.
    const stateAfter = JSON.parse(
      readFileSync(join(sessions, `${sessionId}.json`), 'utf8'),
    ) as SessionState;
    expect(stateAfter.lastShippedUuid).toBe('A1');
  });

  it('stop is a no-op when the latest turn has already been shipped', async () => {
    const sessionId = 'sess-3';
    const sessions = join(stateRoot, 'sessions');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      join(sessions, `${sessionId}.json`),
      JSON.stringify({
        projectId: 'demo_pid',
        projectName: 'demo',
        serverUrl: 'http://server.test',
        cwd,
        startedAt: new Date().toISOString(),
        lastShippedUuid: 'A1',
      } satisfies SessionState),
    );
    const transcriptPath = join(stateRoot, 'transcript.jsonl');
    writeFileSync(
      transcriptPath,
      jsonl(
        { type: 'user', message: { role: 'user', content: 'p' }, timestamp: 't1' },
        {
          type: 'assistant',
          uuid: 'A1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'r' }] },
          timestamp: 't2',
        },
      ),
    );

    const fetchSpy = makeFetchSpy();
    await runHook('stop', {
      stateRoot,
      readStdin: async () =>
        JSON.stringify({ session_id: sessionId, transcript_path: transcriptPath }),
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('session-end removes the session state file', async () => {
    const sessionId = 'sess-4';
    const sessions = join(stateRoot, 'sessions');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      join(sessions, `${sessionId}.json`),
      JSON.stringify({
        projectId: 'demo_pid',
        projectName: 'demo',
        serverUrl: 'http://server.test',
        cwd,
        startedAt: new Date().toISOString(),
      } satisfies SessionState),
    );
    const exit = await runHook('session-end', {
      stateRoot,
      readStdin: async () => JSON.stringify({ session_id: sessionId, reason: 'user_exit' }),
      fetchImpl: makeFetchSpy() as unknown as typeof fetch,
    });
    expect(exit).toBe(0);
    expect(existsSync(join(sessions, `${sessionId}.json`))).toBe(false);
  });

  it('session-start sends Authorization header on /api/projects when CONTEXTIFY_API_KEY is set', async () => {
    const fetchSpy = makeFetchSpy();
    const sessionId = 'sess-auth';
    const apiKey = 'ctx_live_abcdefgh_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const exit = await runHook('session-start', {
      env: { CONTEXTIFY_SERVER_URL: 'http://server.test', CONTEXTIFY_API_KEY: apiKey },
      stateRoot,
      readStdin: async () =>
        JSON.stringify({ session_id: sessionId, cwd, hook_event_name: 'SessionStart' }),
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(exit).toBe(0);
    const [, init] = fetchSpy.mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${apiKey}`);
  });

  it('never throws on malformed stdin — exits 0 silently', async () => {
    const exit = await runHook('stop', {
      stateRoot,
      readStdin: async () => 'this is not json',
      fetchImpl: makeFetchSpy() as unknown as typeof fetch,
    });
    expect(exit).toBe(0);
  });
});
