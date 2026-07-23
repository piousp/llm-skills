import type { AgentRunResult } from "./run.ts";

export interface FormattedResults {
  text: string;
  isError: boolean;
}

const NO_FINAL_TEXT = "(agent produced no final answer)";

function resultText(result: AgentRunResult): string {
  return result.status === "success" ? result.finalText ?? NO_FINAL_TEXT : result.error;
}

export function formatRunResults(results: AgentRunResult[]): FormattedResults {
  if (results.length === 1) {
    const [result] = results;
    const text =
      result.status === "error" ? `Agent "${result.agent}" failed: ${result.error}` : resultText(result);
    return { text, isError: result.status === "error" };
  }

  const sections = results.map((result, index) => {
    const label = result.status === "error" ? "FAILED" : "success";
    return `## ${index + 1}. ${result.agent} — ${label}\n${resultText(result)}`;
  });

  const isError = results.every((result) => result.status === "error");
  return { text: sections.join("\n\n"), isError };
}
