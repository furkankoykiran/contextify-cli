import { describe, expect, it } from 'vitest';
import { parseLatestTurn } from './transcript.js';

function jsonl(...objs: unknown[]): string {
  return objs.map((o) => JSON.stringify(o)).join('\n');
}

describe('@contextify/cli transcript', () => {
  it('returns null on an empty transcript', () => {
    expect(parseLatestTurn('')).toBeNull();
  });

  it('extracts the last user→assistant text pair with empty actions when no tools were used', () => {
    const fixture = jsonl(
      { type: 'user', message: { role: 'user', content: 'first prompt' }, timestamp: 't1' },
      {
        type: 'assistant',
        uuid: 'a1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'first reply' }] },
        timestamp: 't2',
        cwd: '/repo',
      },
      { type: 'user', message: { role: 'user', content: 'second prompt' }, timestamp: 't3' },
      {
        type: 'assistant',
        uuid: 'a2',
        message: { role: 'assistant', content: [{ type: 'text', text: 'second reply' }] },
        timestamp: 't4',
        cwd: '/repo',
      },
    );
    const turn = parseLatestTurn(fixture);
    expect(turn).not.toBeNull();
    expect(turn!.userText).toBe('second prompt');
    expect(turn!.assistantText).toBe('second reply');
    expect(turn!.actions).toEqual([]);
    expect(turn!.transcriptUuid).toBe('a2');
    expect(turn!.cwd).toBe('/repo');
  });

  it('captures Bash commands and file Edits between the paired user and final assistant', () => {
    const fixture = jsonl(
      // Earlier turn — irrelevant.
      { type: 'user', message: { role: 'user', content: 'warmup' }, timestamp: 't0' },
      {
        type: 'assistant',
        uuid: 'a-old',
        message: { role: 'assistant', content: [{ type: 'text', text: 'warmup reply' }] },
        timestamp: 't0a',
      },
      // The turn we want.
      { type: 'user', message: { role: 'user', content: 'apply the migration' }, timestamp: 't1' },
      {
        type: 'assistant',
        uuid: 'a-mid-1',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pnpm db:migrate' } }],
        },
        timestamp: 't2',
      },
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', content: 'migrated ok' }] },
        timestamp: 't3',
      },
      {
        type: 'assistant',
        uuid: 'a-mid-2',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/src/schema.ts' } }],
        },
        timestamp: 't4',
      },
      {
        type: 'assistant',
        uuid: 'a-final',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Write', input: { file_path: '/src/new-file.ts' } },
            { type: 'text', text: 'Schema updated and migration applied.' },
          ],
        },
        timestamp: 't5',
        cwd: '/repo',
      },
    );
    const turn = parseLatestTurn(fixture);
    expect(turn).not.toBeNull();
    expect(turn!.userText).toBe('apply the migration');
    expect(turn!.assistantText).toBe('Schema updated and migration applied.');
    expect(turn!.transcriptUuid).toBe('a-final');
    expect(turn!.actions).toEqual([
      { kind: 'bash', detail: 'pnpm db:migrate' },
      { kind: 'edit', detail: '/src/schema.ts' },
      { kind: 'write', detail: '/src/new-file.ts' },
    ]);
  });

  it('drops read-only tools (Read, Grep, Glob, LS) but keeps mutating ones', () => {
    const fixture = jsonl(
      { type: 'user', message: { role: 'user', content: 'investigate' }, timestamp: 't1' },
      {
        type: 'assistant',
        uuid: 'a-final',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: '/x' } },
            { type: 'tool_use', name: 'Grep', input: { pattern: 'foo' } },
            { type: 'tool_use', name: 'Glob', input: { pattern: '*.ts' } },
            { type: 'tool_use', name: 'LS', input: { path: '/' } },
            { type: 'tool_use', name: 'Bash', input: { command: 'git status' } },
            { type: 'tool_use', name: 'WebFetch', input: { url: 'https://example.com' } },
            { type: 'text', text: 'done' },
          ],
        },
        timestamp: 't2',
      },
    );
    const turn = parseLatestTurn(fixture);
    expect(turn).not.toBeNull();
    expect(turn!.actions).toEqual([
      { kind: 'bash', detail: 'git status' },
      { kind: 'webfetch', detail: 'https://example.com' },
    ]);
  });

  it('caps actions to the configured maximum', () => {
    const tools = [] as unknown[];
    for (let i = 0; i < 60; i += 1) {
      tools.push({ type: 'tool_use', name: 'Bash', input: { command: `echo ${i}` } });
    }
    tools.push({ type: 'text', text: 'done' });
    const fixture = jsonl(
      { type: 'user', message: { role: 'user', content: 'go' }, timestamp: 't1' },
      {
        type: 'assistant',
        uuid: 'a',
        message: { role: 'assistant', content: tools },
        timestamp: 't2',
      },
    );
    const turn = parseLatestTurn(fixture, { maxActions: 10 });
    expect(turn!.actions).toHaveLength(10);
    expect(turn!.actions[0]).toEqual({ kind: 'bash', detail: 'echo 0' });
    expect(turn!.actions[9]).toEqual({ kind: 'bash', detail: 'echo 9' });
  });

  it('truncates over-long action detail strings', () => {
    const longCmd = 'echo ' + 'x'.repeat(500);
    const fixture = jsonl(
      { type: 'user', message: { role: 'user', content: 'go' }, timestamp: 't1' },
      {
        type: 'assistant',
        uuid: 'a',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Bash', input: { command: longCmd } },
            { type: 'text', text: 'ok' },
          ],
        },
        timestamp: 't2',
      },
    );
    const turn = parseLatestTurn(fixture);
    expect(turn!.actions[0]!.detail.length).toBeLessThanOrEqual(400);
    expect(turn!.actions[0]!.detail.endsWith('...')).toBe(true);
  });

  it('skips assistant messages with only tool_use (no text)', () => {
    const fixture = jsonl(
      { type: 'user', message: { role: 'user', content: 'do the thing' }, timestamp: 't1' },
      {
        type: 'assistant',
        uuid: 'a1',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }],
        },
        timestamp: 't2',
      },
    );
    expect(parseLatestTurn(fixture)).toBeNull();
  });

  it('truncates absurdly long assistant text with head+tail markers', () => {
    const huge = 'x'.repeat(60_000);
    const fixture = jsonl(
      { type: 'user', message: { role: 'user', content: 'go' }, timestamp: 't1' },
      {
        type: 'assistant',
        uuid: 'a1',
        message: { role: 'assistant', content: [{ type: 'text', text: huge }] },
        timestamp: 't2',
      },
    );
    const turn = parseLatestTurn(fixture, { maxAssistantChars: 1000 });
    expect(turn).not.toBeNull();
    expect(turn!.assistantText.length).toBeLessThan(1100);
    expect(turn!.assistantText).toContain('[truncated');
  });

  it('only collects actions inside the [user, assistant] window — not from earlier turns', () => {
    const fixture = jsonl(
      // Old turn with its own actions.
      { type: 'user', message: { role: 'user', content: 'old' }, timestamp: 't0' },
      {
        type: 'assistant',
        uuid: 'old-a',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Bash', input: { command: 'OLD ACTION' } },
            { type: 'text', text: 'old reply' },
          ],
        },
        timestamp: 't0a',
      },
      // Current turn.
      { type: 'user', message: { role: 'user', content: 'current' }, timestamp: 't1' },
      {
        type: 'assistant',
        uuid: 'cur-a',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Bash', input: { command: 'CURRENT ACTION' } },
            { type: 'text', text: 'current reply' },
          ],
        },
        timestamp: 't2',
      },
    );
    const turn = parseLatestTurn(fixture);
    expect(turn!.userText).toBe('current');
    expect(turn!.actions).toEqual([{ kind: 'bash', detail: 'CURRENT ACTION' }]);
  });

  it('tolerates malformed JSON lines silently', () => {
    const fixture =
      '{this is not json}\n' +
      jsonl(
        { type: 'user', message: { role: 'user', content: 'p' }, timestamp: 't1' },
        {
          type: 'assistant',
          uuid: 'a',
          message: { role: 'assistant', content: [{ type: 'text', text: 'r' }] },
          timestamp: 't2',
        },
      );
    const turn = parseLatestTurn(fixture);
    expect(turn).not.toBeNull();
    expect(turn!.userText).toBe('p');
    expect(turn!.actions).toEqual([]);
  });
});
