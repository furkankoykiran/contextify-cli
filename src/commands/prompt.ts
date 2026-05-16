/**
 * `contextify prompt <draft|->`
 *
 * The Active Loop CLI — pipes a rough draft to /api/prompt/generate,
 * receives an XML prompt with project memories + GStack directives baked
 * in, and prints it to stdout so it can be redirected/piped.
 *
 * Unix-y by design:
 *   contextify prompt "build a date picker"   | pbcopy
 *   echo "draft from stdin" | contextify prompt -
 *   contextify prompt "draft" --json | jq '.retrievedMemories'
 *
 * stderr is reserved for diagnostics (--show-memories) and errors so
 * stdout stays a single clean artifact.
 */
import { resolveConfig } from '../config.js';
import { resolveApiKey } from '../credentials.js';

export interface PromptArgs {
  /** The draft text. Use null to read from stdin. */
  readonly draft: string | null;
  readonly topK?: number;
  readonly showMemories?: boolean;
  readonly json?: boolean;
}

export interface PromptOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly readStdin?: () => Promise<string>;
  readonly stdout?: NodeJS.WriteStream;
  readonly stderr?: NodeJS.WriteStream;
}

interface PromptApiResponse {
  readonly projectId: string;
  readonly xml: string;
  readonly retrievedMemories: ReadonlyArray<{
    readonly id: string;
    readonly content: string;
    readonly kind: string;
    readonly source: string;
    readonly distance: number;
  }>;
  readonly directives: ReadonlyArray<{
    readonly skill: string;
    readonly reason: string;
    readonly category: string;
  }>;
}

const MAX_DRAFT_CHARS = 20_000;

async function defaultReadStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buf += chunk;
    });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

export async function runPrompt(args: PromptArgs, opts: PromptOptions): Promise<number> {
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;

  // Resolve config (project + server) — same path as `wrap` / `ship`.
  let config;
  try {
    config = await resolveConfig(opts.cwd, opts.env);
  } catch (err) {
    stderr.write(`contextify: ${(err as Error).message}\n`);
    return 2;
  }

  // Resolve draft: positional arg, or stdin if "-".
  let draft: string;
  if (args.draft === null) {
    const readStdin = opts.readStdin ?? defaultReadStdin;
    draft = (await readStdin()).trim();
    if (draft.length === 0) {
      stderr.write('contextify: prompt: no draft provided (stdin was empty)\n');
      return 2;
    }
  } else {
    draft = args.draft.trim();
    if (draft.length === 0) {
      stderr.write('contextify: prompt: draft cannot be empty\n');
      return 2;
    }
  }
  if (draft.length > MAX_DRAFT_CHARS) {
    stderr.write(
      `contextify: prompt: draft exceeds ${MAX_DRAFT_CHARS} chars (got ${draft.length})\n`,
    );
    return 2;
  }

  // Validate flags.
  if (
    args.topK !== undefined &&
    (!Number.isInteger(args.topK) || args.topK < 1 || args.topK > 25)
  ) {
    stderr.write(`contextify: prompt: --top-k must be an integer in [1, 25]\n`);
    return 2;
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = new URL('/api/prompt/generate', config.serverUrl).toString();
  const body = {
    projectId: config.projectId,
    projectName: config.projectName,
    draft,
    topK: args.topK,
  };

  // Attach the same Bearer key the hook ships with so /api/prompt/generate
  // accepts the request. Without this the route 401s on fail-closed deploys.
  const creds = resolveApiKey(opts.env);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (creds) headers.authorization = `Bearer ${creds.apiKey}`;

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    stderr.write(`contextify: prompt: request failed: ${(err as Error).message}\n`);
    return 1;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    stderr.write(`contextify: prompt: server returned ${res.status} ${res.statusText}\n`);
    if (text.length > 0) stderr.write(`${text}\n`);
    return 1;
  }

  let json: PromptApiResponse;
  try {
    json = (await res.json()) as PromptApiResponse;
  } catch (err) {
    stderr.write(`contextify: prompt: invalid JSON response: ${(err as Error).message}\n`);
    return 1;
  }

  if (args.showMemories) {
    writeMemoriesSummary(stderr, json);
  }

  if (args.json) {
    stdout.write(`${JSON.stringify(json, null, 2)}\n`);
  } else {
    stdout.write(json.xml.endsWith('\n') ? json.xml : `${json.xml}\n`);
  }
  return 0;
}

function writeMemoriesSummary(stderr: NodeJS.WriteStream, json: PromptApiResponse): void {
  const memCount = json.retrievedMemories.length;
  const dirCount = json.directives.length;
  stderr.write(`\n# Retrieved ${memCount} memor${memCount === 1 ? 'y' : 'ies'}`);
  if (dirCount > 0) {
    stderr.write(`, ${dirCount} directive${dirCount === 1 ? '' : 's'}`);
  }
  stderr.write(`:\n`);
  for (const m of json.retrievedMemories) {
    const tag = `[${m.kind}/${m.source}, d=${m.distance.toFixed(3)}]`;
    const text = m.content.length > 200 ? `${m.content.slice(0, 197)}...` : m.content;
    stderr.write(`  - ${tag} ${text}\n`);
  }
  for (const d of json.directives) {
    stderr.write(`  > ${d.skill} — ${d.reason}\n`);
  }
  stderr.write(`\n`);
}
