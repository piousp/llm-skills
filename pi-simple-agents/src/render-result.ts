import { buildProgressLines, buildProgressStream, type TaskProgress } from "./progress.ts";

export const DIVIDER = "\u2500\u2500\u2500"; // ───

export interface ResultTheme {
  fg(color: "accent" | "dim" | "muted" | "toolOutput", text: string): string;
}

export interface SubagentResultView {
  isPartial: boolean;
  expanded: boolean;
  progress: readonly TaskProgress[] | undefined;
  content: string;
}

export function buildSubagentResultText(view: SubagentResultView, theme: ResultTheme): string {
  const { isPartial, expanded, progress, content } = view;

  if (isPartial) {
    if (!progress) return "";
    const body = expanded ? buildProgressStream(progress, theme) : buildProgressLines(progress, theme);
    return `${theme.fg("muted", DIVIDER)}\n${body}`;
  }

  if (!expanded || !content) return "";
  return `${theme.fg("muted", DIVIDER)}\n${theme.fg("toolOutput", content)}`;
}
