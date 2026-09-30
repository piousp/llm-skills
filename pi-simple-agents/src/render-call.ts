import type { AgentConfig, InvocationOverride } from "./agents.ts";
import { applyInvocationOverride } from "./agents.ts";
import { invocationOverrideOf } from "./validate.ts";

const MAX_ITEMS_SHOWN = 5;
export const MAX_PREVIEW_WIDTH = 80;

function formatList(items: string[] | undefined): string {
  if (items === undefined) return "inherited";
  if (items.length === 0) return "none";

  const shown = items.slice(0, MAX_ITEMS_SHOWN).join(", ");
  const remaining = items.length - MAX_ITEMS_SHOWN;
  return remaining > 0 ? `${shown} +${remaining} more` : shown;
}

export type RenderTaskEntry = { agent?: string; task?: string } & InvocationOverride;

export type SubagentCallArgs = {
  agent?: string;
  task?: string;
  tasks?: RenderTaskEntry[];
} & InvocationOverride;

export interface CallTheme {
  fg(color: "toolTitle" | "accent" | "dim", text: string): string;
  bold(text: string): string;
}

export function firstLine(text: string): string {
  return text.trim().split("\n", 1)[0] ?? "";
}

export function truncate(text: string): string {
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
  expanded = false,
): string {
  if (args.tasks && args.tasks.length > 0) {
    return expanded
      ? buildExpandedParallelCallText(args.tasks, theme, paramAgents)
      : buildParallelCallText(args.tasks, theme, paramAgents);
  }
  return expanded
    ? buildExpandedSingleCallText(args, theme, paramAgents)
    : buildSingleCallText(args, theme, paramAgents);
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text.trim().split("\n").map((line) => `${pad}${line}`).join("\n");
}

function callPrefix(theme: CallTheme): string {
  return theme.fg("toolTitle", theme.bold("subagent "));
}

function paramsSuffix(
  agentName: string | undefined,
  entry: RenderTaskEntry,
  paramAgents: ReadonlyMap<string, AgentConfig>,
): string | undefined {
  const config = agentName ? paramAgents.get(agentName) : undefined;
  return config ? formatAgentParams(config, invocationOverrideOf(entry)) : undefined;
}

function buildParallelCallText(
  tasks: RenderTaskEntry[],
  theme: CallTheme,
  paramAgents: ReadonlyMap<string, AgentConfig>,
): string {
  const suffix = tasks.length > 1 ? ", ..." : "";
  const title = `${callPrefix(theme)}(${tasks.length}): ${describeTask(tasks[0])}${suffix}`;

  const paramLines: string[] = [];
  for (const t of tasks) {
    const params = paramsSuffix(t.agent, t, paramAgents);
    if (t.agent && params) {
      paramLines.push(`\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", `: ${params}`)}`);
    }
  }

  return [title, ...paramLines].join("");
}

function buildExpandedParallelCallText(
  tasks: RenderTaskEntry[],
  theme: CallTheme,
  paramAgents: ReadonlyMap<string, AgentConfig>,
): string {
  const lines = [`${callPrefix(theme)}(${tasks.length})`];
  for (const t of tasks) {
    const params = paramsSuffix(t.agent, t, paramAgents);
    const head = `  ${theme.fg("accent", t.agent ?? "?")}`;
    lines.push(params ? `${head}${theme.fg("dim", `: ${params}`)}` : head);
    if (t.task?.trim()) lines.push(indent(t.task, 4));
  }
  return lines.join("\n");
}

function buildSingleCallText(
  args: SubagentCallArgs,
  theme: CallTheme,
  paramAgents: ReadonlyMap<string, AgentConfig>,
): string {
  const agent = args.agent ?? "?";
  const task = args.task ? `: ${truncate(firstLine(args.task))}` : "";
  const title = `${callPrefix(theme)}${theme.fg("accent", agent)}${task}`;

  const params = paramsSuffix(agent, args, paramAgents);
  const paramLine = params ? `\n  ${theme.fg("dim", params)}` : "";

  return `${title}${paramLine}`;
}

function buildExpandedSingleCallText(
  args: SubagentCallArgs,
  theme: CallTheme,
  paramAgents: ReadonlyMap<string, AgentConfig>,
): string {
  const agent = args.agent ?? "?";
  const lines = [`${callPrefix(theme)}${theme.fg("accent", agent)}`];
  const params = paramsSuffix(agent, args, paramAgents);
  if (params) lines.push(`  ${theme.fg("dim", params)}`);
  if (args.task?.trim()) lines.push(indent(args.task, 2));
  return lines.join("\n");
}

export function formatAgentParams(agent: AgentConfig, override?: InvocationOverride): string {
  const effective = applyInvocationOverride(agent, override ?? {});
  const model = effective.model ?? "inherited";
  const thinking = effective.thinking ?? "inherited";
  const tools = formatList(effective.tools);
  const skills = formatList(effective.skills);
  const maxTurns = effective.maxTurns ?? "inherited";
  const timeoutMs = effective.timeoutMs ?? "inherited";

  return `model: ${model} · thinking: ${thinking} · tools: ${tools} · skills: ${skills} · maxTurns: ${maxTurns} · timeoutMs: ${timeoutMs}`;
}
