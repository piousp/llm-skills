import type { AgentConfig, InvocationOverride } from "./agents.ts";
import { applyInvocationOverride, OVERRIDE_KEYS } from "./agents.ts";
import { invocationOverrideOf } from "./validate.ts";
import { firstLine, truncate } from "./text-utils.ts";

const MAX_ITEMS_SHOWN = 5;

/** What a segment says when no layer supplies it. Lowercase, and deliberately
    the same word an explicitly empty list renders: the provenance suffix, not
    the word, is what tells "explicitly nothing" apart from "no value". */
const NO_VALUE = "none";
/** Provenance labels. Both settings files collapse into the one "settings.json"
    label on purpose: the reader only needs to know the value did not come from
    the agent's own frontmatter. */
const SETTINGS_LABEL = "settings.json";
const FRONTMATTER_LABEL = "frontmatter";

function formatList(items: string[] | undefined): string {
  if (items === undefined || items.length === 0) return NO_VALUE;

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
  const called: InvocationOverride = override ?? {};
  const effective = applyInvocationOverride(agent, called);

  // 1. A field the call itself overrode renders bare: the call is its own
  //    provenance (and applyInvocationOverride may have just replaced a
  //    settings value, which is why this check comes first).
  // 2. Otherwise a settings-supplied value says so.
  // 3. Any other present value came from the agent's frontmatter: discovery
  //    and applyOverrides are the only two writers of these fields.
  // 4. No value at all renders NO_VALUE with no suffix — a settings
  //    `model: "inherit"` is a present key with an undefined value and must
  //    not read "none (settings.json)".
  const suffix = (field: (typeof OVERRIDE_KEYS)[number], hasValue: boolean): string => {
    if (!hasValue || called[field] !== undefined) return "";
    return agent.settingsFields?.includes(field) ? ` (${SETTINGS_LABEL})` : ` (${FRONTMATTER_LABEL})`;
  };
  const scalar = (field: "model" | "thinking" | "maxTurns" | "timeoutMs"): string => {
    const value = effective[field];
    return value === undefined ? NO_VALUE : `${value}${suffix(field, true)}`;
  };
  const list = (field: "tools" | "skills"): string => {
    const value = effective[field];
    return `${formatList(value)}${suffix(field, value !== undefined)}`;
  };

  return `model: ${scalar("model")} · thinking: ${scalar("thinking")} · tools: ${list("tools")} · skills: ${list("skills")} · maxTurns: ${scalar("maxTurns")} · timeoutMs: ${scalar("timeoutMs")}`;
}
