// Parses the raw --mode json stream produced by `pi -p --mode json` (the
// stdout accumulated into a buffer built by runAgent in src/run.ts). Each line
// is one JSON event. The two shapes this module cares about:
//
//   { type: "message_end", message: { role, content: [{ type: "text", text }] } }
//   { type: "tool_execution_end", toolName, result: { content: [{ type: "text", text }] } }
//
// finalText is the assistant's answer (last assistant message_end).
// lastProgress is the most recent bit of text seen from either an assistant
// message_end or a tool_execution_end, used for progress display while a
// run is still going or as a fallback summary.

interface ContentPart {
  type?: string;
  text?: string;
}

function joinTextParts(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const texts = (content as ContentPart[])
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string);
  return texts.length > 0 ? texts.join("\n") : undefined;
}

// Maximum length for progress display text sent to the TUI.
// Longer text (e.g. file content from tool_execution_end) is truncated
// to avoid freezing the TUI with large re-renders.
const MAX_PROGRESS_CHARS = 500;

export interface ParsedAgentOutput {
  finalText?: string;
  lastProgress?: string;
}

export interface IncrementalParser {
  /** Offset de bytes ya procesados hasta el último \n completo. */
  lastOffset: number;
  /** Último valor de lastProgress reportado. */
  lastProgress: string | undefined;
  /** Último valor de finalText visto. */
  finalText: string | undefined;
}

export function createIncrementalParser(): IncrementalParser {
  return { lastOffset: 0, lastProgress: undefined, finalText: undefined };
}

/**
 * Procesa solo las líneas **nuevas y completas** desde el último offset.
 * Solo avanza hasta el último \n, reteniendo texto parcial para el próximo chunk.
 * Retorna { finalText, lastProgress } si hubo cambios, o undefined si no.
 */
export function parseAgentOutputIncremental(
  stdout: string,
  parser: IncrementalParser,
): { finalText?: string; lastProgress?: string } | undefined {
  const lastNewlineIdx = stdout.lastIndexOf("\n");
  if (lastNewlineIdx < parser.lastOffset) return undefined;

  const newText = stdout.slice(parser.lastOffset, lastNewlineIdx + 1);
  if (!newText) return undefined;

  let changed = false;

  for (const line of newText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let record: Record<string, unknown>;
    try {
      record = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (record.type === "message_end") {
      const message = record.message as { role?: string; content?: unknown } | undefined;
      if (message?.role === "assistant") {
        const text = joinTextParts(message.content);
        if (text !== undefined) {
          parser.finalText = text;
          parser.lastProgress = text.length > MAX_PROGRESS_CHARS
            ? text.slice(0, MAX_PROGRESS_CHARS) + "… (truncado)"
            : text;
          changed = true;
        }
      }
      continue;
    }

    if (record.type === "tool_execution_end") {
      const result = record.result as { content?: unknown } | undefined;
      const text = joinTextParts(result?.content);
      if (text !== undefined) {
        parser.lastProgress = text.length > MAX_PROGRESS_CHARS
          ? text.slice(0, MAX_PROGRESS_CHARS) + "… (truncado)"
          : text;
        changed = true;
      }
    }
  }

  parser.lastOffset = lastNewlineIdx + 1;
  return changed ? { finalText: parser.finalText, lastProgress: parser.lastProgress } : undefined;
}

export function parseAgentOutput(stdout: string): ParsedAgentOutput {
  let finalText: string | undefined;
  let lastProgress: string | undefined;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let record: Record<string, unknown>;
    try {
      record = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue; // not a JSON line (or a chunk-split partial) — ignore
    }

    if (record.type === "message_end") {
      const message = record.message as { role?: string; content?: unknown } | undefined;
      if (message?.role === "assistant") {
        const text = joinTextParts(message.content);
        if (text !== undefined) {
          finalText = text;
          lastProgress = text;
        }
      }
      continue;
    }

    if (record.type === "tool_execution_end") {
      const result = record.result as { content?: unknown } | undefined;
      const text = joinTextParts(result?.content);
      if (text !== undefined) {
        lastProgress = text;
      }
    }
  }

  return { finalText, lastProgress };
}
