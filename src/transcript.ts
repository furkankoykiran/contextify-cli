/**
 * Transcript parser.
 *
 * Reads a Claude Code session JSONL (one JSON object per line) and extracts
 * the most recent completed `user → assistant` text turn — tool_use and
 * tool_result blocks are filtered out by design (see DESIGN-claude-code-hooks.md §3.2).
 *
 * Pure with respect to I/O: takes the raw text, returns a turn or null.
 */

export interface DialogTurn {
  readonly userText: string;
  readonly assistantText: string;
  readonly userAt: string | null;
  readonly assistantAt: string | null;
  readonly cwd: string | null;
  readonly transcriptUuid: string;
}

interface TranscriptLine {
  type?: string;
  uuid?: string;
  timestamp?: string;
  cwd?: string;
  message?: {
    role?: 'user' | 'assistant';
    content?: unknown;
  };
}

/** Concatenate all `type:text` blocks; ignore tool_use/tool_result/etc. */
function extractText(message: TranscriptLine['message']): string {
  if (!message) return '';
  const c = message.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  const parts: string[] = [];
  for (const block of c) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: string; text?: unknown };
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0) {
      parts.push(b.text);
    }
  }
  return parts.join('\n\n');
}

export interface ParseOptions {
  /** Cap the assistant text at this many chars (head+tail). */
  readonly maxAssistantChars?: number;
}

const DEFAULT_ASSISTANT_CAP = 50_000;

/**
 * Find the latest completed user → assistant text turn in the transcript.
 *
 * Strategy: walk lines in order, remember the most recent text-bearing
 * user message; when we then see an assistant message that has any text
 * blocks, that's a complete turn. Keep the last such pair we encounter
 * — that's "the latest turn".
 */
export function parseLatestTurn(jsonl: string, options: ParseOptions = {}): DialogTurn | null {
  const cap = options.maxAssistantChars ?? DEFAULT_ASSISTANT_CAP;
  const lines = jsonl.split(/\r?\n/);

  interface UserText {
    text: string;
    ts: string | null;
  }
  interface AssistantText {
    uuid: string;
    text: string;
    ts: string | null;
    cwd: string | null;
    index: number;
  }

  const userTextAt: Array<{ index: number; user: UserText }> = [];
  let latestAssistant: AssistantText | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!;
    if (!raw) continue;
    let parsed: TranscriptLine;
    try {
      parsed = JSON.parse(raw) as TranscriptLine;
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const role = parsed.message?.role;

    if (parsed.type === 'user' && role === 'user') {
      const text = extractText(parsed.message);
      if (text.trim().length > 0) {
        userTextAt.push({ index, user: { text, ts: parsed.timestamp ?? null } });
      }
      continue;
    }

    if (parsed.type === 'assistant' && role === 'assistant') {
      const text = extractText(parsed.message);
      if (text.trim().length === 0) continue;
      const uuid = typeof parsed.uuid === 'string' ? parsed.uuid : '';
      if (!uuid) continue;
      latestAssistant = {
        uuid,
        text,
        ts: parsed.timestamp ?? null,
        cwd: typeof parsed.cwd === 'string' ? parsed.cwd : null,
        index,
      };
    }
  }

  if (!latestAssistant) return null;
  const finalAssistant = latestAssistant;
  // Find the closest preceding user-text by file order.
  let pairedUser: UserText | null = null;
  for (let i = userTextAt.length - 1; i >= 0; i -= 1) {
    if (userTextAt[i]!.index < finalAssistant.index) {
      pairedUser = userTextAt[i]!.user;
      break;
    }
  }
  if (!pairedUser) return null;
  return {
    userText: pairedUser.text,
    assistantText: truncate(finalAssistant.text, cap),
    userAt: pairedUser.ts,
    assistantAt: finalAssistant.ts,
    cwd: finalAssistant.cwd,
    transcriptUuid: finalAssistant.uuid,
  };
}

function truncate(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const half = Math.floor((cap - 64) / 2);
  return `${text.slice(0, half)}\n... [truncated ${text.length - cap} chars] ...\n${text.slice(-half)}`;
}
