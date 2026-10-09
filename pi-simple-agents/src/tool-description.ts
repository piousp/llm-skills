import type { AgentConfig } from "./agents.ts";

export const SUBAGENT_BASE_DESCRIPTION =
  "Launch a subagent in the background. Returns immediately with a job id; the job's result is delivered later as a message in this conversation. Do not call this tool again to poll for or wait on a result \u2014 it arrives automatically. To run several subagents concurrently, call this tool once per task (each call starts its own independent background job). Use /subagents to list running/recent jobs and /subagents cancel <id> to cancel one.";

export function buildSubagentToolDescription(
  agents: ReadonlyArray<Pick<AgentConfig, "name" | "description">>,
): string {
  if (agents.length === 0) {
    return SUBAGENT_BASE_DESCRIPTION;
  }

  const lines = [...agents]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((agent) => `- ${agent.name}: ${agent.description.trim()}`);

  return `${SUBAGENT_BASE_DESCRIPTION}\n\nAvailable agents:\n${lines.join("\n")}`;
}
