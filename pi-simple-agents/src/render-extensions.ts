import type { AgentConfig } from "./agents.ts";
import type { AgentToolResult, MessageRenderer, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text, MouseRegion, Box, type Component } from "@earendil-works/pi-tui";
import type { JobTask } from "./background-jobs.ts";
import type { SubagentJobMessageDetails } from "./job-messages.ts";
import { buildSubagentCallText, type SubagentCallArgs } from "./render-call.ts";
import { buildSubagentResultText } from "./render-result.ts";

// The render-time seam over the agent registry: entry-point wiring supplies
// this (peeking the registry for the given cwd), so this module can render
// agent names without importing the registry or anything else from
// extensions/.
export type GetAgents = (cwd: string) => readonly AgentConfig[];

// One discriminated union for every shape the subagent tool's `details` field
// can take. A type alias (not an interface) is used deliberately: object type
// aliases carry an implicit index signature, so each member stays assignable
// to `Record<string, unknown>` wherever the host's tool types expect that
// shape.
//
// execute() launches a background job and returns the `{jobId,...}` ack
// immediately, without waiting for the run. The settled run's own
// `{runId,run}` shape only exists on the completion message (see
// SubagentJobMessageDetails in src/job-messages.ts), delivered later via
// pi.sendMessage(), not on this tool's own result.
export type SubagentToolDetails =
  | { jobId: string; runId: string; task: JobTask }
  | { error: string };

// Builds a name→config lookup for the render-time parameter line.
function toParamAgentsMap(agents: readonly AgentConfig[]): Map<string, AgentConfig> {
  return new Map(agents.map((agent) => [agent.name, agent]));
}

// `ToolRenderContext` isn't re-exported from the package's public entry point,
// so this structural subset (the only fields used here) stands in for it. It
// stays assignable to the real renderCall context param because every field
// it declares also exists on the host's ToolRenderContext.
export interface RenderCallContext {
  cwd: string;
  argsComplete: boolean;
  expanded?: boolean;
}

// Renders the tool_box title. Collapsed: agent name + truncated first line of
// the task. Expanded (Ctrl+O / click, which also expands the result): the full
// task under each agent.
export function createRenderSubagentCall(
  getAgents: GetAgents,
): (args: SubagentCallArgs, theme: Theme, context: RenderCallContext | undefined) => Text {
  return (args, theme, context) => {
    const paramAgents = context?.argsComplete
      ? toParamAgentsMap(getAgents(context.cwd))
      : new Map<string, AgentConfig>();
    return new Text(buildSubagentCallText(args, theme, paramAgents, context?.expanded === true), 0, 0);
  };
}

// Renders the tool call's own immediate result: the launch ack, or the
// pre-launch `{error}` result for validation/runtime-init failures. The
// settled run's own output arrives later as a separate `subagent-result`
// message, rendered by renderSubagentResultMessage below, not here.
export function renderSubagentResult(
  result: AgentToolResult<SubagentToolDetails | undefined>,
  options: ToolRenderResultOptions,
  theme: Theme,
  _context: { lastComponent?: Component },
): Text {
  const content = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

  if (result.details && "jobId" in result.details) {
    if (!options.expanded) {
      return new Text(theme.fg("dim", `\u23fa backgrounded job ${result.details.jobId} \u00b7 /subagents to manage`), 0, 0);
    }
    return new Text(content, 0, 0);
  }

  // `{error}` (or no details at all): generic passthrough — collapsed hides,
  // expanded shows the content.
  return new Text(
    buildSubagentResultText({ expanded: options.expanded, content, run: undefined }, theme),
    0,
    0,
  );
}

// Renders the completion message a background job injects via
// pi.sendMessage() when it settles. Distinct from renderSubagentResult
// above: that one renders the launch tool call, this one renders the
// separate transcript entry the result arrives in later.
//
// Styled to match a native tool result — same `Box` + toolSuccessBg/
// toolErrorBg background the host's own ToolExecutionComponent uses
// (tool-execution.ts: updateDisplay()), same `toolTitle` token for the
// header — and wrapped in its own MouseRegion so it is individually
// clickable to toggle expand, the same mechanism createResultRegion() uses
// there. CustomMessageComponent (the generic wrapper every
// registerMessageRenderer output gets) provides neither on its own: no box
// styling (it only boxes its *default*, non-custom rendering), and no click
// handling (only the global Ctrl+O toggle reaches a custom renderer). This
// closure-local `expanded` is what gives this block its own independent
// click state on top of that global toggle. The parent rebuilds this
// component from scratch on the next global toggle/resize/theme change, at
// which point it re-reads `options.expanded` — a click only persists until
// the next such rebuild.
export const renderSubagentResultMessage: MessageRenderer<SubagentJobMessageDetails> = (message, options, theme) => {
  const details = message.details;
  // Optional chain kept deliberately: dev sessions persisted from earlier
  // 1.0.0 builds may carry the old array-shaped `tasks` field instead of
  // `task`, and should still render (as "result", with no footer) rather
  // than throw.
  const who = details?.task?.agent ?? "result";
  const status = details?.status ? ` \u00b7 job ${details.jobId} \u00b7 ${details.status}` : "";
  const title = `${theme.fg("toolTitle", theme.bold(`subagent ${who}`))}${theme.fg("dim", status)}`;
  const content = typeof message.content === "string" ? message.content : "";
  const bgToken = details?.isError ? "toolErrorBg" : "toolSuccessBg";

  let expanded = options.expanded;
  const box = new Box(1, 1, (t) => theme.bg(bgToken, t));

  // `run` exists on the completed/cancelled and (since the 1.2.0 remap) the
  // failed members; the errored member has none. Narrow on key presence, not
  // on status: new failed messages carry a run (usage keeps working), while
  // pre-remap persisted messages may carry either shape — `"run" in details`
  // is tolerant to all of them without validation.
  const run = details && "run" in details ? details.run : undefined;

  function refreshBox(): void {
    box.clear();
    const body = buildSubagentResultText({ expanded, content, run }, theme);
    box.addChild(new Text(body ? `${title}\n${body}` : title, 0, 0));
  }

  return new MouseRegion(
    {
      render: (width: number) => {
        refreshBox();
        return box.render(width);
      },
      invalidate: () => box.invalidate(),
    },
    (event) => {
      if (event.type !== "click" || event.button !== "left") return undefined;
      expanded = !expanded;
      return { handled: true };
    },
  );
};
