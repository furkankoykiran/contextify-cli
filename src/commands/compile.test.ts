import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCompile } from './compile.js';

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

const SAMPLE = {
  projectId: 'demo_pid',
  xml: '<prompt>\n  <user_draft>build a date picker</user_draft>\n</prompt>',
  retrievedMemories: [],
  directives: [],
};

describe('contextify compile', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'contextify-compile-'));
    writeCliConfig(cwd);
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('default --raw prints xml to stdout', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(SAMPLE));
    const { stdout, stderr } = makeStreams();
    const clipboardWrite = vi.fn(async () => ({ ok: true as const }));
    const exit = await runCompile(
      { intent: 'build a date picker', modes: [] },
      {
        cwd,
        env: {},
        fetchImpl: fetchSpy as unknown as typeof fetch,
        clipboardWrite,
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: stderr as unknown as NodeJS.WriteStream,
      },
    );
    expect(exit).toBe(0);
    expect(clipboardWrite).not.toHaveBeenCalled();
    expect(stdout.collected()).toContain('<prompt>');
    expect(stdout.collected().endsWith('\n')).toBe(true);
    expect(stderr.collected()).toBe('');
  });

  it('--paste copies to clipboard and writes confirmation to stderr', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(SAMPLE));
    const { stdout, stderr } = makeStreams();
    const clipboardWrite = vi.fn(async () => ({ ok: true as const }));
    const exit = await runCompile(
      { intent: 'build a date picker', modes: ['paste'] },
      {
        cwd,
        env: {},
        fetchImpl: fetchSpy as unknown as typeof fetch,
        clipboardWrite,
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: stderr as unknown as NodeJS.WriteStream,
      },
    );
    expect(exit).toBe(0);
    expect(clipboardWrite).toHaveBeenCalledWith(SAMPLE.xml);
    expect(stdout.collected()).toBe('');
    expect(stderr.collected()).toContain('Copied compiled prompt to clipboard');
  });

  it('--claude copies to clipboard with Claude-Code stderr tip', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(SAMPLE));
    const { stdout, stderr } = makeStreams();
    const clipboardWrite = vi.fn(async () => ({ ok: true as const }));
    const exit = await runCompile(
      { intent: 'build a date picker', modes: ['claude'] },
      {
        cwd,
        env: {},
        fetchImpl: fetchSpy as unknown as typeof fetch,
        clipboardWrite,
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: stderr as unknown as NodeJS.WriteStream,
      },
    );
    expect(exit).toBe(0);
    expect(clipboardWrite).toHaveBeenCalledWith(SAMPLE.xml);
    expect(stderr.collected()).toContain('Paste it as the next Claude Code message');
  });

  it('clipboard failure falls back to stdout with exit 1', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(SAMPLE));
    const { stdout, stderr } = makeStreams();
    const clipboardWrite = vi.fn(async () => ({ ok: false as const, reason: 'no tool' }));
    const exit = await runCompile(
      { intent: 'build a date picker', modes: ['paste'] },
      {
        cwd,
        env: {},
        fetchImpl: fetchSpy as unknown as typeof fetch,
        clipboardWrite,
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: stderr as unknown as NodeJS.WriteStream,
      },
    );
    expect(exit).toBe(1);
    expect(stderr.collected()).toContain('clipboard unavailable');
    expect(stdout.collected()).toContain('<prompt>');
  });

  it('rejects more than one output mode with exit 2', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(SAMPLE));
    const { stdout, stderr } = makeStreams();
    const exit = await runCompile(
      { intent: 'x', modes: ['paste', 'claude'] },
      {
        cwd,
        env: {},
        fetchImpl: fetchSpy as unknown as typeof fetch,
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: stderr as unknown as NodeJS.WriteStream,
      },
    );
    expect(exit).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stderr.collected()).toContain('choose at most one');
  });

  it('reads intent from stdin when intent is null', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(SAMPLE));
    const { stdout, stderr } = makeStreams();
    const exit = await runCompile(
      { intent: null, modes: [] },
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

  it('attaches Bearer key from env', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(SAMPLE));
    const { stdout, stderr } = makeStreams();
    const exit = await runCompile(
      { intent: 'x', modes: [] },
      {
        cwd,
        env: { CONTEXTIFY_API_KEY: 'ctx_live_test_key' },
        fetchImpl: fetchSpy as unknown as typeof fetch,
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: stderr as unknown as NodeJS.WriteStream,
      },
    );
    expect(exit).toBe(0);
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer ctx_live_test_key');
  });
});
