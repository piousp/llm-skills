import type { AgentConfig } from "./agents.ts";

export const SUBAGENT_BASE_DESCRIPTION =
  "Launch a subagent in the background. Returns immediately with a job id; the job's result is delivered later as a message in this conversation. Do not call this tool again to poll for or wait on a result \u2014 it arrives automatically. To run several subagents concurrently, call this tool once per task (each call starts its own independent background job). A running job can be cancelled, steered, or queued a follow-up with the `subagent_job` tool, or with the user's `/subagents` command; a job that has already settled can no longer be messaged. A run that settled as failed or errored, or was interrupted mid-run, can be re-dispatched with `subagent_job` action `retry` or, when it left a persisted child session, continued from that point with action `continue` \u2014 both relaunch with the original call's recorded parameters when the launch acknowledgment persisted them, and with the agent's own defaults otherwise. Interventions (cancel, steer, followUp, retry, continue) are allowed once per job on your own initiative; a second intervention on the same job requires asking the user first \u2014 the `subagent_job` tool refuses it and says so. `status` and `list` are read-only and always allowed.";

export const SUBAGENT_JOB_DESCRIPTION =
  "Manage a background subagent job launched by the subagent tool. Actions: status (detail one job; without an id it auto-targets the single active job), list (all running/recent jobs, newest first), cancel (stop a running job), steer (inject a message into a running job's live session to redirect it; needs message), followUp (queue a message for the end of the run; it extends the run; needs message), retry (re-dispatch a settled run as a NEW job), continue (relaunch an interrupted run from its persisted child session, keeping its partial work; the agent re-verifies half-done work first). status and list are read-only and always allowed. The other five are interventions: allowed once per job on your own initiative; a second intervention on the same job is refused, and needs the user to ask for it. Target by job id (from the subagent acknowledgment, e.g. S1002); retry/continue also accept a run id, and without an id they resolve their target from settled runs on disk (cancelled runs are user intent and need an explicit id).";

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
