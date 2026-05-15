import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Batcher } from './batcher.js';

describe('@gbrain/cli Batcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes when the byte threshold is crossed', async () => {
    const flushes: string[] = [];
    const batcher = new Batcher({
      maxBytes: 10,
      maxIdleMs: 1_000_000,
      flush: async (p) => {
        flushes.push(p);
      },
    });
    batcher.start();
    batcher.append('hello'); // 5 bytes, under threshold
    expect(flushes).toEqual([]);
    batcher.append('world!!'); // crosses 10 bytes
    await Promise.resolve();
    await Promise.resolve();
    expect(flushes).toEqual(['helloworld!!']);
    await batcher.close();
  });

  it('flushes on the idle timer', async () => {
    const flushes: string[] = [];
    const batcher = new Batcher({
      maxBytes: 10_000,
      maxIdleMs: 100,
      flush: async (p) => {
        flushes.push(p);
      },
    });
    batcher.start();
    batcher.append('idle');
    await vi.advanceTimersByTimeAsync(120);
    expect(flushes).toEqual(['idle']);
    await batcher.close();
  });

  it('close flushes pending data', async () => {
    const flushes: string[] = [];
    const batcher = new Batcher({
      maxBytes: 10_000,
      maxIdleMs: 1_000_000,
      flush: async (p) => {
        flushes.push(p);
      },
    });
    batcher.start();
    batcher.append('on close');
    await batcher.close();
    expect(flushes).toEqual(['on close']);
  });

  it('does not invoke flush while another flush is in flight', async () => {
    let resolveFirst: (() => void) | null = null;
    const flushes: string[] = [];
    const batcher = new Batcher({
      maxBytes: 5,
      maxIdleMs: 1_000_000,
      flush: (p) =>
        new Promise<void>((resolve) => {
          flushes.push(p);
          if (!resolveFirst) {
            resolveFirst = resolve;
            return;
          }
          resolve();
        }),
    });
    batcher.start();
    batcher.append('aaaaa'); // triggers flush #1, which awaits resolveFirst
    await Promise.resolve();
    batcher.append('bbbbb'); // triggers concurrent flush attempt — should be ignored
    await Promise.resolve();
    expect(flushes).toEqual(['aaaaa']);
    resolveFirst?.();
    await batcher.close(); // drains the rest
    expect(flushes).toEqual(['aaaaa', 'bbbbb']);
  });

  it('append after close is a no-op', async () => {
    const flushes: string[] = [];
    const batcher = new Batcher({
      maxBytes: 1,
      maxIdleMs: 1_000_000,
      flush: async (p) => {
        flushes.push(p);
      },
    });
    batcher.start();
    await batcher.close();
    batcher.append('ignored');
    expect(flushes).toEqual([]);
  });
});
