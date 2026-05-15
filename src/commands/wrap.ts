/**
 * `gbrain wrap -- <cmd> [args...]`
 *
 * Spawns the child command, mirrors its stdout/stderr to the user's
 * terminal in real time, and ships batched copies to the gBrain server.
 *
 * Trade-off: we use `child_process.spawn` with piped stdio so we avoid
 * a native dep (`node-pty`). Line-based commands (git, pnpm, scripts)
 * work fine. Full-screen TUI apps lose true TTY semantics — that's a
 * documented limitation, swappable for `node-pty` later if needed.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Batcher } from '../batcher.js';
import { resolveConfig } from '../config.js';
import { shipBatch, type Batch } from '../shipper.js';

export interface WrapOptions {
  readonly argv: readonly string[]; // includes the command and its args
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly maxBytes?: number;
  readonly maxIdleMs?: number;
  readonly forceSpool?: boolean;
}

const DEFAULT_MAX_BYTES = 64 * 1024;
const DEFAULT_MAX_IDLE_MS = 5_000;

export async function runWrap(opts: WrapOptions): Promise<number> {
  if (opts.argv.length === 0) {
    process.stderr.write('error: gbrain wrap -- <cmd> [args...]\n');
    return 2;
  }

  let config;
  try {
    config = await resolveConfig(opts.cwd, opts.env);
  } catch (err) {
    process.stderr.write(`gbrain: ${(err as Error).message}\n`);
    return 2;
  }

  const sessionId = randomUUID();
  const ship = async (payload: string): Promise<void> => {
    const batch: Batch = {
      projectId: config.projectId,
      projectName: config.projectName,
      sessionId,
      payload,
    };
    await shipBatch(batch, {
      serverUrl: config.serverUrl,
      cwd: opts.cwd,
      forceSpool: opts.forceSpool,
    });
  };

  const batcher = new Batcher({
    maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES,
    maxIdleMs: opts.maxIdleMs ?? DEFAULT_MAX_IDLE_MS,
    flush: ship,
  });
  batcher.start();

  const [cmd, ...rest] = opts.argv;
  const child = spawn(cmd!, rest, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk: Buffer) => {
    process.stdout.write(chunk);
    batcher.append(chunk.toString('utf8'));
  });
  child.stderr.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk);
    batcher.append(chunk.toString('utf8'));
  });

  const exitCode = await new Promise<number>((resolve) => {
    child.on('close', (code, signal) => {
      if (typeof code === 'number') resolve(code);
      else if (signal) resolve(128);
      else resolve(0);
    });
    child.on('error', (err) => {
      process.stderr.write(`gbrain: ${err.message}\n`);
      resolve(127);
    });
  });

  await batcher.close();
  return exitCode;
}
