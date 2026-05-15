import { describe, expect, it } from 'vitest';
import { parseLatestTurn } from './transcript.js';

function jsonl(...objs: unknown[]): string {
  return objs.map((o) => JSON.stringify(o)).join('\n');
}

describe('@contextify/cli transcript', () => {
  it('returns null on an empty transcript', () => {
    expect(parseLatestTurn('')).toBeNull();
  });

  it('extracts the last user→assistant text pair', () => {
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
    expect(turn!.transcriptUuid).toBe('a2');
    expect(turn!.cwd).toBe('/repo');
    expect(turn!.userAt).toBe('t3');
    expect(turn!.assistantAt).toBe('t4');
  });

  it('filters out tool_use and tool_result blocks', () => {
    const fixture = jsonl(
      { type: 'user', message: { role: 'user', content: 'analyze this' }, timestamp: 't1' },
      {
        type: 'assistant',
        uuid: 'a1',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
            { type: 'text', text: 'I will analyze' },
          ],
        },
        timestamp: 't2',
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', content: 'some output' }],
        },
        timestamp: 't3',
      },
      {
        type: 'assistant',
        uuid: 'a2',
        message: { role: 'assistant', content: [{ type: 'text', text: 'final answer' }] },
        timestamp: 't4',
      },
    );
    const turn = parseLatestTurn(fixture);
    expect(turn).not.toBeNull();
    // The intervening tool_result user message has no text, so the prompt
    // that gets paired with 'final answer' is still the original user prompt.
    expect(turn!.userText).toBe('analyze this');
    expect(turn!.assistantText).toBe('final answer');
    expect(turn!.transcriptUuid).toBe('a2');
  });

  it('skips assistant messages with only tool_use (no text)', () => {
    const fixture = jsonl(
      { type: 'user', message: { role: 'user', content: 'do the thing' }, timestamp: 't1' },
      {
        type: 'assistant',
        uuid: 'a1',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Bash', input: {} }],
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
  });
});
