/**
 * Bounded in-memory batcher.
 *
 * Appends data; flushes when either (a) the buffer crosses `maxBytes`
 * or (b) `maxIdleMs` has elapsed since the last append. Concurrency
 * model:
 *   - Only one flush runs at a time.
 *   - Calls to flush() while one is in-flight chain after it — they
 *     await the same shared promise rather than dropping. This lets
 *     `close()` reliably drain everything that arrived during the
 *     last in-flight flush.
 */

export interface BatcherOptions {
  readonly maxBytes: number;
  readonly maxIdleMs: number;
  readonly flush: (payload: string) => Promise<void>;
  readonly setInterval?: typeof setInterval;
  readonly clearInterval?: typeof clearInterval;
}

export class Batcher {
  readonly #maxBytes: number;
  readonly #maxIdleMs: number;
  readonly #flushCb: (payload: string) => Promise<void>;
  readonly #setInterval: typeof setInterval;
  readonly #clearInterval: typeof clearInterval;

  #buffer: string[] = [];
  #bytes = 0;
  #timer: ReturnType<typeof setInterval> | null = null;
  #pending: Promise<void> | null = null;
  #closed = false;

  constructor(opts: BatcherOptions) {
    this.#maxBytes = opts.maxBytes;
    this.#maxIdleMs = opts.maxIdleMs;
    this.#flushCb = opts.flush;
    this.#setInterval = opts.setInterval ?? setInterval;
    this.#clearInterval = opts.clearInterval ?? clearInterval;
  }

  start(): void {
    if (this.#timer || this.#closed) return;
    this.#timer = this.#setInterval(() => {
      this.flush().catch(() => {
        /* swallow — the shipper already handles errors */
      });
    }, this.#maxIdleMs);
    if (typeof (this.#timer as NodeJS.Timeout)?.unref === 'function') {
      (this.#timer as NodeJS.Timeout).unref();
    }
  }

  append(chunk: string): void {
    if (this.#closed) return;
    if (chunk.length === 0) return;
    this.#buffer.push(chunk);
    this.#bytes += Buffer.byteLength(chunk, 'utf8');
    if (this.#bytes >= this.#maxBytes) {
      this.flush().catch(() => {});
    }
  }

  get bufferedBytes(): number {
    return this.#bytes;
  }

  /**
   * Drain the buffer.
   *
   * If a flush is already in-flight, callers wait for it AND for whatever
   * the buffer holds when that flush ends. This makes close() correct
   * even when an append() races against an in-flight flush.
   */
  flush(): Promise<void> {
    if (this.#pending) {
      const pending = this.#pending;
      // Chain: after the in-flight flush completes, drain anything left.
      const next = pending.then(() => this.#drainOnce()).catch(() => undefined);
      return next;
    }
    return this.#drainOnce();
  }

  #drainOnce(): Promise<void> {
    if (this.#buffer.length === 0) return Promise.resolve();
    const payload = this.#buffer.join('');
    this.#buffer = [];
    this.#bytes = 0;
    const promise = this.#flushCb(payload).finally(() => {
      this.#pending = null;
    });
    this.#pending = promise;
    return promise;
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) {
      this.#clearInterval(this.#timer);
      this.#timer = null;
    }
    await this.flush();
  }
}
