/**
 * Transcript parser.
 *
 * Reads a Claude Code session JSONL (one JSON object per line) and extracts
 * the most recent completed user → assistant turn, including:
 *   - the user's text prompt
 *   - the assistant's final text response
 *   - the sequence of *actions* the assistant executed between them
 *     (Bash commands, file Writes/Edits/MultiEdits, WebFetches)
 *
 * Read-only tool calls (Read, Grep, Glob, LS, etc.) are dropped — they're
 * introspection, not durable insight, and they explode payload size for no
 * extraction value. tool_result blocks are likewise dropped (the *action*
 * is what's durable; the output is noise the LLM doesn't need).
 *
 * Pure with respect to I/O: takes the raw JSONL text, returns a turn or null.
 */

/** Kinds of actions worth shipping to the worker. */
export type ActionKind = 'bash' | 'write' | 'edit' | 'multiedit' | 'webfetch';

export interface DialogAction {
  readonly kind: ActionKind;
  /** Single-line summary of the action (command string, file path, URL, etc.). */
  readonly detail: string;
}

export interface DialogTurn {
  readonly userText: string;
  readonly assistantText: string;
  readonly actions: ReadonlyArray<DialogAction>;
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

interface ToolUseBlock {
  type: 'tool_use';
  name?: string;
  input?: unknown;
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

const MAX_DETAIL_CHARS = 400;

/**
 * Map a tool_use block to a DialogAction, or null if it's a read-only
 * inspection tool we want to drop on the floor.
 */
function classifyToolUse(block: ToolUseBlock): DialogAction | null {
  const name = typeof block.name === 'string' ? block.name : '';
  const input = (block.input ?? {}) as Record<string, unknown>;
  switch (name) {
    case 'Bash': {
      const cmd = typeof input.command === 'string' ? input.command : '';
      if (cmd.trim().length === 0) return null;
      return { kind: 'bash', detail: truncateDetail(cmd) };
    }
    case 'Write': {
      const fp = typeof input.file_path === 'string' ? input.file_path : '';
      if (!fp) return null;
      return { kind: 'write', detail: truncateDetail(fp) };
    }
    case 'Edit': {
      const fp = typeof input.file_path === 'string' ? input.file_path : '';
      if (!fp) return null;
      return { kind: 'edit', detail: truncateDetail(fp) };
    }
    case 'MultiEdit': {
      const fp = typeof input.file_path === 'string' ? input.file_path : '';
      if (!fp) return null;
      return { kind: 'multiedit', detail: truncateDetail(fp) };
    }
    case 'WebFetch': {
      const url = typeof input.url === 'string' ? input.url : '';
      if (!url) return null;
      return { kind: 'webfetch', detail: truncateDetail(url) };
    }
    // Read-only inspections (Read, Grep, Glob, LS, NotebookRead, etc.) are
    // skipped intentionally — high frequency, low signal.
    default:
      return null;
  }
}

function truncateDetail(text: string): string {
  if (text.length <= MAX_DETAIL_CHARS) return text;
  return `${text.slice(0, MAX_DETAIL_CHARS - 3)}...`;
}

/** Collect tool_use actions from a single message body. */
function extractActions(message: TranscriptLine['message']): DialogAction[] {
  if (!message) return [];
  const c = message.content;
  if (!Array.isArray(c)) return [];
  const out: DialogAction[] = [];
  for (const block of c) {
    if (!block || typeof block !== 'object') continue;
    const b = block as ToolUseBlock & { type?: string };
    if (b.type !== 'tool_use') continue;
    const action = classifyToolUse(b);
    if (action) out.push(action);
  }
  return out;
}

export interface ParseOptions {
  /** Cap the assistant text at this many chars (head+tail). */
  readonly maxAssistantChars?: number;
  /** Cap the actions array length. Default 50. */
  readonly maxActions?: number;
}

const DEFAULT_ASSISTANT_CAP = 50_000;
const DEFAULT_ACTIONS_CAP = 50;

/**
 * Find the latest completed user → assistant text turn in the transcript.
 *
 * Strategy:
 *   1. Walk lines in order, indexing every text-bearing user message.
 *   2. Track the latest assistant message that contains text.
 *   3. Pair the latest-assistant with the closest preceding user-text.
 *   4. Collect every action (Bash / Write / Edit / MultiEdit / WebFetch)
 *      from every line *between* those two anchors (inclusive of the
 *      assistant message's own tool_use blocks).
 */
export function parseLatestTurn(jsonl: string, options: ParseOptions = {}): DialogTurn | null {
  const cap = options.maxAssistantChars ?? DEFAULT_ASSISTANT_CAP;
  const actionsCap = options.maxActions ?? DEFAULT_ACTIONS_CAP;
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

  // First pass: find the turn anchors.
  const parsedLines: Array<TranscriptLine | null> = new Array(lines.length).fill(null);
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
    parsedLines[index] = parsed;
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
  let pairedUserIndex = -1;
  for (let i = userTextAt.length - 1; i >= 0; i -= 1) {
    if (userTextAt[i]!.index < finalAssistant.index) {
      pairedUser = userTextAt[i]!.user;
      pairedUserIndex = userTextAt[i]!.index;
      break;
    }
  }
  if (!pairedUser) return null;

  // Second pass: collect actions in the [pairedUserIndex+1, finalAssistant.index] window.
  // We include the assistant line itself because tool_use can live alongside text
  // in the same assistant message.
  const actions: DialogAction[] = [];
  for (let i = pairedUserIndex + 1; i <= finalAssistant.index; i += 1) {
    const parsed = parsedLines[i];
    if (!parsed) continue;
    if (parsed.message?.role !== 'assistant') continue;
    for (const action of extractActions(parsed.message)) {
      if (actions.length >= actionsCap) break;
      actions.push(action);
    }
    if (actions.length >= actionsCap) break;
  }

  return {
    userText: pairedUser.text,
    assistantText: truncate(finalAssistant.text, cap),
    actions,
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
