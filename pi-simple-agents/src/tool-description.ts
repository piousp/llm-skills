import type { AgentConfig } from "./agents.ts";

export const SUBAGENT_BASE_DESCRIPTION = "Run one or more subagents and wait for their results";

export function buildSubagentToolDescription(
  agents: ReadonlyArray<Pick<AgentConfig, "name" | "description">>,
): string {
  if (agents.length === 0) {
    return SUBAGENT_BASE_DESCRIPTION;
  }

  const lines = [...agents]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((agent) => `- ${agent.name}: ${(typeof agent.description === "string" ? agent.description : "").trim()}`);

  return `${SUBAGENT_BASE_DESCRIPTION}\n\nAvailable agents:\n${lines.join("\n")}`;
}
