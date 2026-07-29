import type { AgentConfig } from "./agents.ts";

const MAX_TOOLS_SHOWN = 5;
const MAX_PREVIEW_WIDTH = 80;

function formatTools(tools: string[] | undefined): string {
  if (tools === undefined) return "inherited";
  if (tools.length === 0) return "none";

  const shown = tools.slice(0, MAX_TOOLS_SHOWN).join(", ");
  const remaining = tools.length - MAX_TOOLS_SHOWN;
  return remaining > 0 ? `${shown} +${remaining} more` : shown;
}

export interface RenderTaskEntry {
  agent?: string;
  task?: string;
}

export interface SubagentCallArgs {
  agent?: string;
  task?: string;
  tasks?: RenderTaskEntry[];
}

export interface CallTheme {
  fg(color: "toolTitle" | "accent" | "dim", text: string): string;
  bold(text: string): string;
}

function firstLine(text: string): string {
  return text.trim().split("\n", 1)[0] ?? "";
}

function truncate(text: string): string {
  return text.length > MAX_PREVIEW_WIDTH
    ? `${text.slice(0, MAX_PREVIEW_WIDTH - 1)}\u2026`
    : text;
}

function describeTask(t: RenderTaskEntry): string {
  const agent = t.agent ?? "?";
  const task = t.task ?? "";
  return `${agent}: ${truncate(firstLine(task))}`;
}

export function buildSubagentCallText(
  args: SubagentCallArgs,
  theme: CallTheme,
  paramAgents: ReadonlyMap<string, AgentConfig>,
): string {
  if (args.tasks && args.tasks.length > 0) {
    return buildParallelCallText(args.tasks, theme, paramAgents);
  }
  return buildSingleCallText(args, theme, paramAgents);
}

function buildParallelCallText(
  tasks: RenderTaskEntry[],
  theme: CallTheme,
  paramAgents: ReadonlyMap<string, AgentConfig>,
): string {
  const prefix = theme.fg("toolTitle", theme.bold("subagent "));
  const suffix = tasks.length > 1 ? ", ..." : "";
  const title = `${prefix}(${tasks.length}): ${describeTask(tasks[0])}${suffix}`;

  const paramLines: string[] = [];
  for (const t of tasks) {
    const agentName = t.agent;
    if (!agentName) continue;
    const config = paramAgents.get(agentName);
    if (config) {
      paramLines.push(`\n  ${theme.fg("accent", agentName)}${theme.fg("dim", `: ${formatAgentParams(config)}`)}`);
    }
  }

  return [title, ...paramLines].join("");
}

function buildSingleCallText(
  args: SubagentCallArgs,
  theme: CallTheme,
  paramAgents: ReadonlyMap<string, AgentConfig>,
): string {
  const prefix = theme.fg("toolTitle", theme.bold("subagent "));
  const agent = args.agent ?? "?";
  const task = args.task ? `: ${truncate(firstLine(args.task))}` : "";
  const title = `${prefix}${theme.fg("accent", agent)}${task}`;

  const agentConfig = paramAgents.get(agent);
  const paramLine = agentConfig ? `\n  ${theme.fg("dim", formatAgentParams(agentConfig))}` : "";

  return `${title}${paramLine}`;
}

export function formatAgentParams(agent: AgentConfig): string {
  const model = agent.model ?? "inherited";
  const thinking = agent.thinking ?? "inherited";
  const tools = formatTools(agent.tools);

  return `model: ${model} · thinking: ${thinking} · tools: ${tools}`;
}
