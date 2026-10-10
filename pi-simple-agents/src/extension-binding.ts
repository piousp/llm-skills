import type { SourceInfo } from "@earendil-works/pi-coding-agent";
import { CLAUDE_INERT_TOOLS } from "./claude-compat.ts";

/**
 * Structural subset of the host's ToolInfo: the fields this module
 * consumes. The SDK's `ToolInfo[]` is assignable to `readonly ToolSource[]`.
 */
export interface ToolSource {
  name: string;
  sourceInfo: Pick<SourceInfo, "path" | "origin" | "source">;
}

/** The tool this package itself registers. Excluded from needsExtensionBinding: an agent that can nest subagents does not, by that fact alone, need any MCP server connected — the nested subagent makes its own binding decision independently. */
export const SUBAGENT_TOOL_NAME = "subagent";

/**
 * Source paths of pi's built-in extensions whose tools depend on session_start
 * (MCP connects its servers there; tool_search/codemode reach MCP tools). Base
 * tools share origin "top-level" + source "builtin" with these, so the path
 * (`builtin:<extension>` vs `builtin:<tool>`) is the only distinguishing field.
 */
const SESSION_START_BUILTIN_PATHS: ReadonlySet<string> = new Set([
  "builtin:mcp",
  "builtin:tool-search",
  "builtin:codemode",
]);

function isBindingTool(tool: ToolSource): boolean {
  return tool.sourceInfo.origin === "package" || SESSION_START_BUILTIN_PATHS.has(tool.sourceInfo.path);
}

/**
 * True if the subagent needs session_start emitted: some registered tool
 * (other than this package's own subagent tool) came from an installed
 * extension package or a session_start-dependent built-in extension, or some
 * requested tool isn't registered yet — only an extension can still supply it
 * at session_start (e.g. `mcp__<server>__<tool>`, registered once the server connects).
 * Inert Claude Code tool names stay in agent.tools but no extension ever
 * supplies them, so they are ignored.
 */
export function needsExtensionBinding(
  tools: readonly ToolSource[],
  requestedToolNames: readonly string[] = [],
): boolean {
  const candidates = tools.filter((tool) => tool.name !== SUBAGENT_TOOL_NAME);
  if (candidates.some(isBindingTool)) return true;
  // Same predicate as the fail-loud check after bind in runAgentViaSdk: the
  // bind decision and the missing-tools verdict must agree on what counts as
  // missing (shared predicate, src/run.ts).
  return missingRequestedTools(tools, requestedToolNames).length > 0;
}

/** Requested tool names that are not registered — the names a session will
    never be able to execute. Wildcard entries (`*` patterns) cannot be
    matched to a registered name at this point, so they are exempt.
    Inert Claude Code tool names have no pi equivalent by design, so they
    never count as missing. */
export function missingRequestedTools(
  tools: readonly ToolSource[],
  requestedToolNames: readonly string[] = [],
): string[] {
  const registered = new Set(tools.map((tool) => tool.name));
  return requestedToolNames.filter(
    (name) =>
      name !== SUBAGENT_TOOL_NAME
      && !CLAUDE_INERT_TOOLS.has(name)
      && !name.includes("*")
      && !registered.has(name),
  );
}

/**
 * Local mirror of the SDK's ExtensionMode. Not re-exported from the
 * package root (verified absent from dist/index.d.ts), and none of the
 * package's `exports` entry points expose it, so a deep import isn't
 * possible either — inlining is the only option.
 */
export type ExtensionMode = "tui" | "rpc" | "json" | "print";
