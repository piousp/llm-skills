import os from "node:os";
import path from "node:path";
import { Type, type Static } from "typebox";
import type { AgentToolUpdateCallback, ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { discoverAgents, applyOverrides, loadOverrides, type AgentConfig } from "../src/agents.ts";
import { runAgent } from "../src/run.ts";
import { formatRunResults } from "../src/format-results.ts";
import { validateSubagentParams, resolveAgents } from "../src/validate.ts";

const AGENTS_DIR = path.join(os.homedir(), ".pi/agent/agents");
const PROGRESS_THROTTLE_MS = 100;

function loadAvailableAgents(cwd: string): AgentConfig[] {
  const agents = discoverAgents(AGENTS_DIR);
  const userSettingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
  const projectSettingsPath = path.join(cwd, ".pi", "settings.json");
  const overrides = loadOverrides(userSettingsPath, projectSettingsPath);
  return applyOverrides(agents, overrides);
}

function errorResult(error: string) {
  return {
    content: [{ type: "text" as const, text: error }],
    details: { error },
    isError: true,
  };
}

type TaskEntry = { agent: string; task: string };

const SubagentParams = Type.Object({
  agent: Type.Optional(Type.String()),
  task: Type.Optional(Type.String()),
  tasks: Type.Optional(
    Type.Array(
      Type.Object({
        agent: Type.String(),
        task: Type.String(),
      }),
    ),
  ),
});
type SubagentArgs = Static<typeof SubagentParams>;

function firstLine(text: string): string {
  return text.trim().split("\n", 1)[0] ?? "";
}

function truncate(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max - 1)}\u2026` : text;
}

// Collapsed one-line summary for a single task entry, e.g. "agent: first line of the task".
function describeTask(t: TaskEntry): string {
  return `${t.agent}: ${truncate(firstLine(t.task))}`;
}

// Renders the tool_box title: agent name + truncated first line of the task.
// The host only supports expand/collapse on the result body (renderResult),
// not on the call title, so there is no separate "expanded" title variant.
function renderSubagentCall(args: SubagentArgs, theme: Theme) {
  const prefix = theme.fg("toolTitle", theme.bold("subagent "));

  if (args.tasks?.length) {
    const suffix = args.tasks.length > 1 ? ", ..." : "";
    return new Text(`${prefix}(${args.tasks.length}): ${describeTask(args.tasks[0])}${suffix}`, 0, 0);
  }

  const agent = args.agent ?? "?";
  const task = args.task ? `: ${truncate(firstLine(args.task))}` : "";
  return new Text(`${prefix}${theme.fg("accent", agent)}${task}`, 0, 0);
}

// Normalizes validateSubagentParams' two accepted shapes ({agent, task} or
// {tasks: [...]}) into the single task-entry array every downstream step
// (agent resolution, spawning, progress indexing) operates on.
function normalizeTasks(params: { agent?: string; task?: string; tasks?: TaskEntry[] }): TaskEntry[] {
  return params.tasks === undefined ? [{ agent: params.agent!, task: params.task! }] : params.tasks;
}

// Runs every task in parallel, reporting incremental progress per index via
// onUpdate (throttled to 100ms) as each agent streams text, and returns the
// settled results in the same order as `tasks`.
function runTasks(
  tasks: TaskEntry[],
  resolvedAgents: AgentConfig[],
  cwd: string,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
) {
  const progressByIndex: string[] = tasks.map(() => "");
  const throttledUpdate = createThrottledUpdate(onUpdate, progressByIndex);

  return Promise.all(
    tasks.map((t, index) => {
      const agent = resolvedAgents[index];
      return runAgent(agent, t.task, {
        cwd,
        signal,
        onProgress: (text) => {
          progressByIndex[index] = `${t.agent}: ${text}`;
          throttledUpdate(progressByIndex);
        },
      });
    }),
  );
}

function createThrottledUpdate(
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
  progressByIndex: string[],
): (pb: string[]) => void {
  if (!onUpdate) return () => {};
  let lastUpdateAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const emit = () => {
    lastUpdateAt = Date.now();
    timer = undefined;
    onUpdate!({
      content: [{ type: "text", text: progressByIndex.filter(Boolean).join("\n") }],
      details: { progress: [...progressByIndex] },
    });
  };
  return (_pb: string[]) => {
    const now = Date.now();
    const delay = PROGRESS_THROTTLE_MS - (now - lastUpdateAt);
    if (delay <= 0) {
      if (timer) { clearTimeout(timer); timer = undefined; }
      emit();
    } else if (!timer) {
      timer = setTimeout(emit, delay);
    }
  };
}

function renderSubagentResult(
  result: { content: Array<{ type: string; text?: string }>; details?: Record<string, unknown> },
  _options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  context: { lastComponent?: Text },
): Text {
  const text = context.lastComponent ?? new Text("", 0, 0);
  const content = result.content.map((c) => c.text ?? "").join("\n");
  text.setText(content ? theme.fg("toolOutput", content) : "");
  return text;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Run one or more subagents and wait for their results",
    parameters: SubagentParams,
    renderCall: renderSubagentCall,
    renderResult: renderSubagentResult,
    execute: async (_toolCallId, rawParams, signal, onUpdate, ctx) => {
      const parsedParams = validateSubagentParams(rawParams);
      if (!parsedParams.ok) {
        return errorResult(parsedParams.error);
      }

      const tasks = normalizeTasks(parsedParams.value);

      const availableAgents = loadAvailableAgents(ctx.cwd);
      const resolved = resolveAgents(tasks.map((t) => t.agent), availableAgents);
      if (!resolved.ok) {
        return errorResult(resolved.error);
      }

      const results = await runTasks(tasks, resolved.value, ctx.cwd, signal, onUpdate);

      const formatted = formatRunResults(results);
      return {
        content: [{ type: "text", text: formatted.text }],
        details: { runs: results },
        isError: formatted.isError,
      };
    },
  });
}