import { formatRunResult } from "./format-results.ts";
import { firstLine, truncate } from "./text-utils.ts";
import { toAggregatedUsage, type AggregatedUsage } from "./usage.ts";
import type { AgentRunResult } from "./run.ts";
import type { JobSnapshot, JobTask, SettledJob } from "./background-jobs.ts";

// Pure assembly of a settled job's result shape — runId/run/usage,
// unit-testable without a real model session. The package's published entry
// point (extensions/index.ts) re-exports this for existing external call
// sites; buildJobCompletionMessage below does not use it (it needs only a
// subset of this shape, see the comment there).
export function buildSubagentToolResult(result: AgentRunResult, runId: string) {
  const formatted = formatRunResult(result);
  return {
    content: [{ type: "text" as const, text: formatted.text }],
    details: { runId, run: result },
    usage: toAggregatedUsage(result.usage),
    isError: formatted.isError,
  };
}

function describeTaskLine(t: { agent: string; task: string }): string {
  return `- ${t.agent}: ${truncate(firstLine(t.task))}`;
}

// Immediate tool result: a launch acknowledgment, not the subagent's own
// output. The model is told explicitly not to poll — the real result
// arrives later as a `subagent-result` message (see buildJobCompletionMessage).
export function buildSubagentAckResult(job: JobSnapshot) {
  const lines = [
    `Started background subagent job ${job.id}:`,
    describeTaskLine(job.task),
    `The result will be delivered automatically to this conversation as a message when the job finishes. Do not call subagent again to poll or wait for it. The user can cancel it with /subagents cancel ${job.id}.`,
  ];
  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: { jobId: job.id, runId: job.runId, task: job.task },
    isError: false,
  };
}

export const SUBAGENT_RESULT_MESSAGE_TYPE = "subagent-result";

export interface SubagentJobMessageDetails {
  jobId: string;
  runId: string;
  status: SettledJob["state"]["status"];
  task: JobTask;
  run?: AgentRunResult;
  usage?: AggregatedUsage;
  isError: boolean;
}

export interface SubagentJobMessage {
  customType: typeof SUBAGENT_RESULT_MESSAGE_TYPE;
  content: string;
  display: true;
  details: SubagentJobMessageDetails;
}

export type SubagentJobDeliveryOptions = { triggerTurn: true; deliverAs: "followUp" } | { triggerTurn: false };

function buildCompletionHeader(job: SettledJob): string {
  switch (job.state.status) {
    case "completed":
      return `Background subagent job ${job.id} finished \u2014 completed`;
    case "cancelled": {
      const by = job.state.reason === "user" ? "cancelled by the user" : "cancelled (session ending)";
      return `Background subagent job ${job.id} finished \u2014 ${by}`;
    }
    case "failed":
      return `Background subagent job ${job.id} finished \u2014 failed: ${job.state.error}`;
  }
}

// Delivery options depend only on job.state.status — cancellation is user
// intent, so it's informational only (`triggerTurn: false`); completed and
// failed both wake the model as a follow-up.
const DELIVERY_OPTIONS_BY_STATUS: Record<SettledJob["state"]["status"], SubagentJobDeliveryOptions> = {
  completed: { triggerTurn: true, deliverAs: "followUp" },
  cancelled: { triggerTurn: false },
  failed: { triggerTurn: true, deliverAs: "followUp" },
};

// Builds the message injected back into the conversation when a background
// job settles (via pi.sendMessage), plus the delivery options above. Does
// not go through buildSubagentToolResult: that function's full tool-result
// shape (content/details/usage/isError) would be built only to be taken
// apart again for the subset of fields this message actually needs.
export function buildJobCompletionMessage(job: SettledJob): { message: SubagentJobMessage; options: SubagentJobDeliveryOptions } {
  const header = buildCompletionHeader(job);
  // Copied, not the shared table entry itself — options goes to
  // pi.sendMessage, which belongs to the host; each call gets its own object.
  const options: SubagentJobDeliveryOptions = { ...DELIVERY_OPTIONS_BY_STATUS[job.state.status] };

  let content = header;
  let details: SubagentJobMessageDetails;

  if (job.state.status === "failed") {
    details = {
      jobId: job.id, runId: job.runId, status: "failed", task: job.task,
      run: undefined, usage: undefined, isError: true,
    };
  } else {
    const result = job.state.result;
    const formatted = formatRunResult(result);
    content = `${header}\n\n${formatted.text}`;
    details = {
      jobId: job.id,
      runId: job.runId,
      status: job.state.status,
      task: job.task,
      run: result,
      usage: toAggregatedUsage(result.usage),
      isError: formatted.isError,
    };
  }

  return { message: { customType: SUBAGENT_RESULT_MESSAGE_TYPE, content, display: true, details }, options };
}
