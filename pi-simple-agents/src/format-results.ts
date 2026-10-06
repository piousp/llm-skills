import type { AgentRunResult } from "./run.ts";

export interface FormattedResults {
  text: string;
  isError: boolean;
}

const NO_FINAL_TEXT = "(agent produced no final answer)";

export function formatRunResult(result: AgentRunResult): FormattedResults {
  if (result.status === "error") {
    return { text: `Agent "${result.agent}" failed: ${result.error}`, isError: true };
  }
  return { text: result.finalText ?? NO_FINAL_TEXT, isError: false };
}
