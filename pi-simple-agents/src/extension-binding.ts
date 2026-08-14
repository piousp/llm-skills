/**
 * Structural subset of the host's ToolInfo: the fields this module
 * consumes. The SDK's `ToolInfo[]` is assignable to `readonly ToolSource[]`.
 */
export interface ToolSource {
  name: string;
  sourceInfo: {
    origin: "package" | "top-level";
    source: string;
  };
}

/** The tool this package itself registers. Excluded from needsExtensionBinding: an agent that can nest subagents does not, by that fact alone, need any MCP server connected — the nested subagent makes its own binding decision independently. */
export const SUBAGENT_TOOL_NAME = "subagent";

/** True if at least one tool in the set (other than this package's own subagent tool) came from an installed extension package. */
export function needsExtensionBinding(tools: readonly ToolSource[]): boolean {
  return tools.some((tool) => tool.name !== SUBAGENT_TOOL_NAME && tool.sourceInfo.origin === "package");
}

/**
 * Local mirror of the SDK's ExtensionMode. Not re-exported from the
 * package root (verified absent from dist/index.d.ts), and the package's
 * `exports` map only publishes ".", "./rpc-entry" and "./client", so a
 * deep import isn't possible either — inlining is the only option.
 */
export type ExtensionMode = "tui" | "rpc" | "json" | "print";
