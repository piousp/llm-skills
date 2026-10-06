import type { AgentConfig, InvocationOverride } from "./agents.ts";
import { applyInvocationOverride } from "./agents.ts";
import { invocationOverrideOf } from "./validate.ts";
import { firstLine, truncate } from "./text-utils.ts";

export { firstLine, truncate } from "./text-utils.ts";

const MAX_ITEMS_SHOWN = 5;

function formatList(items: string[] | undefined): string {
  if (items === undefined) return "inherited";
  if (items.length === 0) return "none";

  const shown = items.slice(0, MAX_ITEMS_SHOWN).join(", ");
  const remaining = items.length - MAX_ITEMS_SHOWN;
  return remaining > 0 ? `${shown} +${remaining} more` : shown;
}

export type SubagentCallArgs = { agent?: string; task?: string } & InvocationOverride;

export interface CallTheme {
  fg(color: "toolTitle" | "accent" | "dim", text: string): string;
  bold(text: string): string;
}

export function buildSubagentCallText(
  args: SubagentCallArgs,
  theme: CallTheme,
  paramAgents: ReadonlyMap<string, AgentConfig>,
  expanded = false,
): string {
  return expanded
    ? buildExpandedSingleCallText(args, theme, paramAgents)
    : buildSingleCallText(args, theme, paramAgents);
}

// Drops leading blank lines and trailing whitespace only, so the first line
// keeps its indentation relative to the rest.
const LEADING_BLANK_LINES = /^(?:[ \t]*\r?\n)+/;

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text.replace(LEADING_BLANK_LINES, "").trimEnd().split("\n").map((line) => `${pad}${line}`).join("\n");
}

function callPrefix(theme: CallTheme): string {
  return theme.fg("toolTitle", theme.bold("subagent "));
}

function paramsSuffix(
  agentName: string | undefined,
  entry: SubagentCallArgs,
  paramAgents: ReadonlyMap<string, AgentConfig>,
): string | undefined {
  const config = agentName ? paramAgents.get(agentName) : undefined;
  return config ? formatAgentParams(config, invocationOverrideOf(entry)) : undefined;
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
