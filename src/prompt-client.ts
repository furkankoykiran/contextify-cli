/**
 * Shared HTTP client for /api/prompt/generate.
 *
 * `prompt` (deprecated) and `compile` both call this — there is one synth
 * engine and one client. New commands that want compiled XML go through
 * here; do not fork the fetch.
 */
import type { ResolvedConfig } from './config.js';
import { resolveApiKey } from './credentials.js';

export interface PromptApiResponse {
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

export interface CompileRequest {
  readonly draft: string;
  readonly topK?: number;
}

export interface CompileClientOptions {
  readonly config: ResolvedConfig;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
}

export type CompileResult =
  | { ok: true; data: PromptApiResponse }
  | { ok: false; status: number; statusText: string; body: string }
  | { ok: false; status: null; statusText: string; body: string };

export async function compilePrompt(
  req: CompileRequest,
  opts: CompileClientOptions,
): Promise<CompileResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = new URL('/api/prompt/generate', opts.config.serverUrl).toString();
  const body = {
    projectId: opts.config.projectId,
    projectName: opts.config.projectName,
    draft: req.draft,
    topK: req.topK,
  };

  const creds = resolveApiKey(opts.env);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (creds) headers.authorization = `Bearer ${creds.apiKey}`;

  let res: Response;
  try {
    // The CLI intentionally sends its locally-stored Contextify project config
    // (from .contextify.json) and API credential (from ~/.contextify/credentials.json)
    // to the configured Contextify server. That is the entire purpose of this
    // binary; there is no untrusted intermediary. The URL is constructed from
    // the operator-controlled `serverUrl` in resolveConfig.
    // lgtm[js/file-access-to-http]
    res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (err) {
    return { ok: false, status: null, statusText: (err as Error).message, body: '' };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, status: res.status, statusText: res.statusText, body: text };
  }
  try {
    const data = (await res.json()) as PromptApiResponse;
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      status: res.status,
      statusText: `invalid JSON: ${(err as Error).message}`,
      body: '',
    };
  }
}
