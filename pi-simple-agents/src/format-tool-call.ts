import { truncate, firstLine } from "./text-utils.ts";

function str(a: Record<string, unknown>, key: string, fallback = ""): string {
  return typeof a[key] === "string" ? (a[key] as string) : fallback;
}

function num(a: Record<string, unknown>, key: string): number | undefined {
  return typeof a[key] === "number" ? (a[key] as number) : undefined;
}

function readSummary(a: Record<string, unknown>): string {
  const path = str(a, "path");
  const offset = num(a, "offset");
  const limit = num(a, "limit");

  let range = "";
  if (offset !== undefined && limit !== undefined) range = `:${offset}-${offset + limit - 1}`;
  else if (offset !== undefined) range = `:${offset}+`;
  else if (limit !== undefined) range = `:1-${limit}`;

  return `read ${path}${range}`.trim();
}

function writeSummary(a: Record<string, unknown>): string {
  return `write ${str(a, "path")}`.trim();
}

function editSummary(a: Record<string, unknown>): string {
  const path = str(a, "path");
  const count = Array.isArray(a.edits) ? ` (${a.edits.length} edits)` : "";
  return `edit ${path}${count}`.trim();
}

function bashSummary(a: Record<string, unknown>): string {
  return `$ ${firstLine(str(a, "command"))}`.trim();
}

function grepSummary(a: Record<string, unknown>): string {
  const pattern = str(a, "pattern");
  const path = str(a, "path") || undefined;
  const glob = str(a, "glob") || undefined;
  let text = `grep /${pattern}/`;
  if (path) text += ` in ${path}`;
  if (glob) text += ` (${glob})`;
  return text;
}

function findSummary(a: Record<string, unknown>): string {
  const pattern = str(a, "pattern");
  const path = str(a, "path") || undefined;
  return path ? `find ${pattern} in ${path}` : `find ${pattern}`;
}

function lsSummary(a: Record<string, unknown>): string {
  return `ls ${str(a, "path", ".")}`;
}

function toolSearchSummary(a: Record<string, unknown>): string {
  return `tool_search ${str(a, "query")}`.trim();
}

const CODEMODE_OPTIONS_LINE = /^\s*\/\/\s*@options:.*\n/;

function codemodeSummary(a: Record<string, unknown>): string {
  return `codemode ${firstLine(str(a, "code").replace(CODEMODE_OPTIONS_LINE, ""))}`.trim();
}

// Built-in MCP tools are named `mcp__<server>__<tool>`; render them as
// `server/tool key=value ...`. This matches pi's own `server/tool` title for
// plain names; sanitized or hash-shortened names show as registered.
const MCP_TOOL_NAME = /^mcp__(.+?)__(.+)$/;

function mcpSummary(toolName: string, a: Record<string, unknown>): string | undefined {
  const match = MCP_TOOL_NAME.exec(toolName);
  if (!match) return undefined;
  const title = `${match[1]}/${match[2]}`;
  const pairs = Object.entries(a).map(([key, value]) => `${key}=${safeJson(value)}`).join(" ");
  return pairs ? `${title} ${pairs}` : title;
}

const FORMATTERS: Record<string, (a: Record<string, unknown>) => string> = {
  read: readSummary,
  write: writeSummary,
  edit: editSummary,
  bash: bashSummary,
  grep: grepSummary,
  find: findSummary,
  ls: lsSummary,
  tool_search: toolSearchSummary,
  codemode: codemodeSummary,
};

function safeJson(args: unknown): string {
  try {
    return JSON.stringify(args) ?? "";
  } catch {
    return "";
  }
}

function fallbackSummary(toolName: string, args: unknown): string {
  const json = safeJson(args);
  return json ? `${toolName} ${json}` : toolName;
}

export function formatToolCall(toolName: string, args: unknown): string {
  const record = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
  const formatter = FORMATTERS[toolName];
  const summary = formatter
    ? formatter(record)
    : mcpSummary(toolName, record) ?? fallbackSummary(toolName, args);
  return truncate(summary);
}
