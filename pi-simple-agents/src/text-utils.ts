// Small, dependency-free string helpers shared across rendering and
// messaging modules. Kept separate from render-call.ts (which pulls in
// agents.ts/validate.ts for its own needs) so a module that only needs these
// helpers — job-messages.ts, job-view.ts, format-tool-call.ts — doesn't
// transitively depend on the agent-config/validation chain.

export const MAX_PREVIEW_WIDTH = 80;

export function firstLine(text: string): string {
  return text.trim().split("\n", 1)[0] ?? "";
}

export function truncate(text: string): string {
  return text.length > MAX_PREVIEW_WIDTH
    ? `${text.slice(0, MAX_PREVIEW_WIDTH - 1)}\u2026`
    : text;
}
