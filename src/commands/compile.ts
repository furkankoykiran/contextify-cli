/**
 * `contextify compile <intent>`
 *
 * Compile a Claude-Code-ready XML prompt from an intent draft. Same server
 * synth engine as the (deprecated) `contextify prompt` command — the only
 * difference is output: --raw to stdout (default), --paste to the system
 * clipboard, --claude to the clipboard with a stderr tip framed for Claude
 * Code paste.
 *
 *   contextify compile "build a date picker"             # stdout
 *   contextify compile "build a date picker" --paste     # clipboard
 *   contextify compile "build a date picker" --claude    # clipboard + tip
 *   echo "draft from stdin" | contextify compile -
 *
 * The output modes are mutually exclusive. Passing two flags errors with
 * exit 2 so the user notices the ambiguity instead of silently picking one.
 */
import { spawnSync } from 'node:child_process';
import { resolveConfig } from '../config.js';
import { compilePrompt } from '../prompt-client.js';

export type CompileMode = 'raw' | 'paste' | 'claude';

export interface CompileArgs {
  readonly intent: string | null;
  /**
   * Output modes the user passed. Empty array defaults to 'raw'. More than
   * one entry is rejected with exit 2 — the modes are mutually exclusive
   * and silently picking one would hide a typo.
   */
  readonly modes: readonly CompileMode[];
  readonly topK?: number;
}

export interface CompileOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly readStdin?: () => Promise<string>;
  readonly stdout?: NodeJS.WriteStream;
  readonly stderr?: NodeJS.WriteStream;
  readonly clipboardWrite?: (text: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
}

const MAX_INTENT_CHARS = 20_000;

async function defaultReadStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (buf += chunk));
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

export async function runCompile(args: CompileArgs, opts: CompileOptions): Promise<number> {
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;

  if (args.modes.length > 1) {
    stderr.write(
      `contextify: compile: choose at most one of --raw, --paste, --claude (got ${args.modes.join(', ')})\n`,
    );
    return 2;
  }
  const mode: CompileMode = args.modes[0] ?? 'raw';

  let config;
  try {
    config = await resolveConfig(opts.cwd, opts.env);
  } catch (err) {
    stderr.write(`contextify: ${(err as Error).message}\n`);
    return 2;
  }

  let intent: string;
  if (args.intent === null) {
    const readStdin = opts.readStdin ?? defaultReadStdin;
    intent = (await readStdin()).trim();
    if (intent.length === 0) {
      stderr.write('contextify: compile: no intent provided (stdin was empty)\n');
      return 2;
    }
  } else {
    intent = args.intent.trim();
    if (intent.length === 0) {
      stderr.write('contextify: compile: intent cannot be empty\n');
      return 2;
    }
  }
  if (intent.length > MAX_INTENT_CHARS) {
    stderr.write(
      `contextify: compile: intent exceeds ${MAX_INTENT_CHARS} chars (got ${intent.length})\n`,
    );
    return 2;
  }
  if (
    args.topK !== undefined &&
    (!Number.isInteger(args.topK) || args.topK < 1 || args.topK > 25)
  ) {
    stderr.write('contextify: compile: --top-k must be an integer in [1, 25]\n');
    return 2;
  }

  const result = await compilePrompt(
    { draft: intent, topK: args.topK },
    { config, env: opts.env, fetchImpl: opts.fetchImpl },
  );

  if (!result.ok) {
    if (result.status === null) {
      stderr.write(`contextify: compile: request failed: ${result.statusText}\n`);
    } else {
      stderr.write(`contextify: compile: server returned ${result.status} ${result.statusText}\n`);
      if (result.body.length > 0) stderr.write(`${result.body}\n`);
    }
    return 1;
  }

  const xml = result.data.xml;

  if (mode === 'raw') {
    stdout.write(xml.endsWith('\n') ? xml : `${xml}\n`);
    return 0;
  }

  const clipboardWrite = opts.clipboardWrite ?? writeToSystemClipboard;
  const clip = await clipboardWrite(xml);
  if (!clip.ok) {
    stderr.write(
      `contextify: compile: clipboard unavailable (${clip.reason}); writing XML to stdout instead.\n`,
    );
    stdout.write(xml.endsWith('\n') ? xml : `${xml}\n`);
    return 1;
  }

  if (mode === 'claude') {
    stderr.write(
      'Copied Claude Code prompt to clipboard. Paste it as the next Claude Code message.\n',
    );
  } else {
    stderr.write('Copied compiled prompt to clipboard.\n');
  }
  return 0;
}

/**
 * Cross-platform clipboard write via the platform's native tool. No npm
 * dep on clipboardy/clipboard-cli — they pull binaries and we want this
 * CLI to stay small. Order: pbcopy (macOS) → wl-copy (Wayland) → xclip
 * (X11) → xsel (X11 fallback) → clip.exe (Windows / WSL interop).
 */
async function writeToSystemClipboard(
  text: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const candidates: ReadonlyArray<{ cmd: string; args: readonly string[] }> = [
    { cmd: 'pbcopy', args: [] },
    { cmd: 'wl-copy', args: [] },
    { cmd: 'xclip', args: ['-selection', 'clipboard'] },
    { cmd: 'xsel', args: ['--clipboard', '--input'] },
    { cmd: 'clip.exe', args: [] },
    { cmd: 'clip', args: [] },
  ];
  const tried: string[] = [];
  for (const { cmd, args } of candidates) {
    const probe = spawnSync('which', [cmd], { stdio: 'ignore' });
    if (probe.status !== 0) continue;
    tried.push(cmd);
    const res = spawnSync(cmd, args, { input: text, encoding: 'utf8' });
    if (res.error) continue;
    if (typeof res.status === 'number' && res.status !== 0) continue;
    return { ok: true };
  }
  if (tried.length === 0) {
    return {
      ok: false,
      reason: 'no clipboard tool found (install pbcopy, wl-copy, xclip, xsel, or clip.exe)',
    };
  }
  return { ok: false, reason: `clipboard tools failed (tried: ${tried.join(', ')})` };
}
