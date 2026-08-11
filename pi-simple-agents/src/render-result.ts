import { buildProgressLines, buildProgressStream, type TaskProgress } from "./progress.ts";
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
  isPartial: boolean;
  expanded: boolean;
  progress: readonly TaskProgress[] | undefined;
  content: string;
  runs?: readonly RunUsageSource[];
}

function buildUsageFooterLines(runs: readonly RunUsageSource[] | undefined, theme: ResultTheme): string[] {
  if (!runs) return [];
  return runs
    .map((run) => ({ agent: run.agent, footer: run.usage ? formatRunUsage(run.usage) : "" }))
    .filter((r) => r.footer !== "")
    .map((r) => `${theme.fg("accent", r.agent)} ${theme.fg("dim", r.footer)}`);
}

export function buildSubagentResultText(view: SubagentResultView, theme: ResultTheme): string {
  const { isPartial, expanded, progress, content, runs } = view;

  if (isPartial) {
    if (!progress) return "";
    const body = expanded ? buildProgressStream(progress, theme) : buildProgressLines(progress, theme);
    return `${theme.fg("muted", DIVIDER)}\n${body}`;
  }

  // Usage footers are visible collapsed or expanded — they're a one-line
  // summary, not the (potentially large) output the collapse/expand toggle
  // guards. Only the divider + full content stay gated behind `expanded`.
  const footerLines = buildUsageFooterLines(runs, theme);

  if (!expanded || !content) return footerLines.join("\n");

  return [`${theme.fg("muted", DIVIDER)}\n${theme.fg("toolOutput", content)}`, ...footerLines].join("\n");
}
