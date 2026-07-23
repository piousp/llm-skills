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

export interface ParsedAgentOutput {
  finalText?: string;
  lastProgress?: string;
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
