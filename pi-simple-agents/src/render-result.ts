import { formatRunUsage, type RunUsage } from "./usage.ts";

export const DIVIDER = "\u2500\u2500\u2500"; // ───

export interface ResultTheme {
  fg(color: "accent" | "dim" | "muted" | "toolOutput", text: string): string;
}

// Only the fields this module reads from a run result; avoids importing
// AgentRunResult's full union just for `agent` + `usage`.
export interface RunUsageSource {
  agent: string;
  usage?: RunUsage;
}

export interface SubagentResultView {
  expanded: boolean;
  content: string;
  run?: RunUsageSource;
}

function buildUsageFooterLine(run: RunUsageSource | undefined, theme: ResultTheme): string | undefined {
  if (!run || !run.usage) return undefined;
  const footer = formatRunUsage(run.usage);
  if (footer === "") return undefined;
  return `${theme.fg("accent", run.agent)} ${theme.fg("dim", footer)}`;
}

export function buildSubagentResultText(view: SubagentResultView, theme: ResultTheme): string {
  const { expanded, content, run } = view;

  // The usage footer is visible collapsed or expanded — it's a one-line
  // summary, not the (potentially large) output the collapse/expand toggle
  // guards. Only the divider + full content stay gated behind `expanded`.
  const footerLine = buildUsageFooterLine(run, theme);
  const footerLines = footerLine ? [footerLine] : [];

  if (!expanded || !content) return footerLines.join("\n");

  return [`${theme.fg("muted", DIVIDER)}\n${theme.fg("toolOutput", content)}`, ...footerLines].join("\n");
}
