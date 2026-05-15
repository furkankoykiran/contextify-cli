import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runPrompt } from './prompt.js';

function writeCliConfig(cwd: string): void {
  writeFileSync(
    join(cwd, '.contextify.json'),
    JSON.stringify({
      projectId: 'demo_pid',
      projectName: 'Demo',
      serverUrl: 'http://server.test',
    }),
  );
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

interface Streams {
  stdout: PassThrough & { collected: () => string };
  stderr: PassThrough & { collected: () => string };
}

function makeStreams(): Streams {
  const make = () => {
    const s = new PassThrough();
    const chunks: Buffer[] = [];
    s.on('data', (c: Buffer) => chunks.push(c));
    (s as PassThrough & { collected: () => string }).collected = () =>
      Buffer.concat(chunks).toString('utf8');
    return s as PassThrough & { collected: () => string };
  };
  return { stdout: make(), stderr: make() };
}

const SAMPLE_API_RESPONSE = {
  projectId: 'demo_pid',
  xml: '<prompt>\n  <user_draft>build a date picker</user_draft>\n</prompt>',
  retrievedMemories: [
    {
      id: '11111111-1111-1111-1111-111111111111',
      content: 'Always format dates as Day:Month:Year in this project.',
      kind: 'rule',
      source: 'claude-code',
      distance: 0.123,
    },
  ],
  directives: [{ skill: '/plan-design-review', reason: 'UI work detected', category: 'design' }],
};

describe('contextify prompt', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'contextify-prompt-'));
    writeCliConfig(cwd);
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('POSTs the draft and prints xml to stdout by default', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(SAMPLE_API_RESPONSE));
    const { stdout, stderr } = makeStreams();
    const exit = await runPrompt(
      { draft: 'build a date picker' },
      {
        cwd,
        env: {},
        fetchImpl: fetchSpy as unknown as typeof fetch,
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: stderr as unknown as NodeJS.WriteStream,
      },
    );
    expect(exit).toBe(0);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe('http://server.test/api/prompt/generate');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.projectId).toBe('demo_pid');
    expect(body.projectName).toBe('Demo');
    expect(body.draft).toBe('build a date picker');
    expect(body.topK).toBeUndefined();

    expect(stdout.collected()).toContain('<prompt>');
    expect(stdout.collected().endsWith('\n')).toBe(true);
    expect(stderr.collected()).toBe('');
  });

  it('reads the draft from stdin when draft is null', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(SAMPLE_API_RESPONSE));
    const { stdout, stderr } = makeStreams();
    const exit = await runPrompt(
      { draft: null },
      {
        cwd,
        env: {},
        fetchImpl: fetchSpy as unknown as typeof fetch,
        readStdin: async () => '  draft from stdin  ',
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: stderr as unknown as NodeJS.WriteStream,
      },
    );
    expect(exit).toBe(0);
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.draft).toBe('draft from stdin');
  });

  it('sends --top-k through to the API', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(SAMPLE_API_RESPONSE));
    const { stdout, stderr } = makeStreams();
    await runPrompt(
      { draft: 'x', topK: 7 },
      {
        cwd,
        env: {},
        fetchImpl: fetchSpy as unknown as typeof fetch,
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: stderr as unknown as NodeJS.WriteStream,
      },
    );
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.topK).toBe(7);
  });

  it('emits the full response as JSON to stdout under --json', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(SAMPLE_API_RESPONSE));
    const { stdout, stderr } = makeStreams();
    await runPrompt(
      { draft: 'x', json: true },
      {
        cwd,
        env: {},
        fetchImpl: fetchSpy as unknown as typeof fetch,
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: stderr as unknown as NodeJS.WriteStream,
      },
    );
    const parsed = JSON.parse(stdout.collected()) as typeof SAMPLE_API_RESPONSE;
    expect(parsed.projectId).toBe('demo_pid');
    expect(parsed.retrievedMemories).toHaveLength(1);
    expect(stderr.collected()).toBe('');
  });

  it('writes the memory summary to stderr under --show-memories (stdout stays clean)', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(SAMPLE_API_RESPONSE));
    const { stdout, stderr } = makeStreams();
    await runPrompt(
      { draft: 'x', showMemories: true },
      {
        cwd,
        env: {},
        fetchImpl: fetchSpy as unknown as typeof fetch,
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: stderr as unknown as NodeJS.WriteStream,
      },
    );
    expect(stderr.collected()).toContain('Retrieved 1 memory');
    expect(stderr.collected()).toContain('Day:Month:Year');
    expect(stderr.collected()).toContain('/plan-design-review');
    // stdout is still just the XML — pipes are safe.
    expect(stdout.collected().startsWith('<prompt>')).toBe(true);
    expect(stdout.collected()).not.toContain('Retrieved');
  });

  it('rejects empty draft (positional)', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(SAMPLE_API_RESPONSE));
    const { stdout, stderr } = makeStreams();
    const exit = await runPrompt(
      { draft: '   ' },
      {
        cwd,
        env: {},
        fetchImpl: fetchSpy as unknown as typeof fetch,
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: stderr as unknown as NodeJS.WriteStream,
      },
    );
    expect(exit).toBe(2);
    expect(stderr.collected()).toContain('draft cannot be empty');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects empty stdin', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(SAMPLE_API_RESPONSE));
    const { stdout, stderr } = makeStreams();
    const exit = await runPrompt(
      { draft: null },
      {
        cwd,
        env: {},
        fetchImpl: fetchSpy as unknown as typeof fetch,
        readStdin: async () => '   \n',
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: stderr as unknown as NodeJS.WriteStream,
      },
    );
    expect(exit).toBe(2);
    expect(stderr.collected()).toContain('stdin was empty');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects out-of-range --top-k values', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(SAMPLE_API_RESPONSE));
    const { stdout, stderr } = makeStreams();
    const exit = await runPrompt(
      { draft: 'x', topK: 0 },
      {
        cwd,
        env: {},
        fetchImpl: fetchSpy as unknown as typeof fetch,
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: stderr as unknown as NodeJS.WriteStream,
      },
    );
    expect(exit).toBe(2);
    expect(stderr.collected()).toContain('--top-k must be an integer in [1, 25]');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects oversized drafts before hitting the server', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(SAMPLE_API_RESPONSE));
    const { stdout, stderr } = makeStreams();
    const exit = await runPrompt(
      { draft: 'x'.repeat(20_001) },
      {
        cwd,
        env: {},
        fetchImpl: fetchSpy as unknown as typeof fetch,
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: stderr as unknown as NodeJS.WriteStream,
      },
    );
    expect(exit).toBe(2);
    expect(stderr.collected()).toContain('exceeds 20000 chars');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('surfaces server errors to stderr without polluting stdout', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'validation failed' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const { stdout, stderr } = makeStreams();
    const exit = await runPrompt(
      { draft: 'x' },
      {
        cwd,
        env: {},
        fetchImpl: fetchSpy as unknown as typeof fetch,
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: stderr as unknown as NodeJS.WriteStream,
      },
    );
    expect(exit).toBe(1);
    expect(stderr.collected()).toContain('server returned 400');
    expect(stdout.collected()).toBe('');
  });

  it('falls back to env config when there is no .contextify.json', async () => {
    rmSync(join(cwd, '.contextify.json'));
    const fetchSpy = vi.fn(async () => jsonResponse(SAMPLE_API_RESPONSE));
    const { stdout, stderr } = makeStreams();
    const exit = await runPrompt(
      { draft: 'x' },
      {
        cwd,
        env: {
          CONTEXTIFY_PROJECT_ID: 'env_pid',
          CONTEXTIFY_SERVER_URL: 'http://envserver.test',
        },
        fetchImpl: fetchSpy as unknown as typeof fetch,
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: stderr as unknown as NodeJS.WriteStream,
      },
    );
    expect(exit).toBe(0);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe('http://envserver.test/api/prompt/generate');
    expect(JSON.parse((init as RequestInit).body as string).projectId).toBe('env_pid');
  });

  it('errors when no config is available', async () => {
    rmSync(join(cwd, '.contextify.json'));
    const fetchSpy = vi.fn(async () => jsonResponse(SAMPLE_API_RESPONSE));
    const { stdout, stderr } = makeStreams();
    const exit = await runPrompt(
      { draft: 'x' },
      {
        cwd,
        env: {},
        fetchImpl: fetchSpy as unknown as typeof fetch,
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: stderr as unknown as NodeJS.WriteStream,
      },
    );
    expect(exit).toBe(2);
    expect(stderr.collected()).toContain('no contextify config found');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
