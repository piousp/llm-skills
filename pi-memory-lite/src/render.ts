// The TUI face of the four tools: one line per call and per result while the row is collapsed, and the text the model
// read as is when the reader expands it. Everything but `createMemoryRenderers` is a pure function of the name and the
// payload, because a renderer runs against whatever pi holds at that instant: arguments still streaming, a partial
// result with no details yet, a details object this build did not write. Nothing here holds state, opens a box or
// catches a click — a `Text` with the line is the whole of the row, so the row costs nothing to redraw and nothing here
// can drift from the payload the executors of `src/tools.ts` return.
//
// The query is the one fact a collapsed search line shows that `details` does not carry: it lives in the call arguments,
// which the host hands the result renderer as `context.args`. That is why the result builder takes the arguments as an
// optional member of its options, and why a result rendered without them falls back to a line without the query instead
// of inventing one.

import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { formatIdList } from "./format.ts";
import { toTokens } from "./query.ts";
import { MEMORY_TOOL_NAMES, searchModeOf } from "./tools.ts";

/** The four tool names, as the registration order has them. */
export type MemoryToolName = (typeof MEMORY_TOOL_NAMES)[number];

/** Ids a line lists before it truncates with `…`: a read of twenty ids would otherwise wrap the row. */
const MAX_IDS = 5;

/** The word the error line starts with. */
const ERROR_LABEL = "Error";

/** The suffix of a line whose payload has not arrived yet: the call is running and has told the row nothing. */
const PENDING_SUFFIX = "…";

/** What a renderer reads of a result: `details` is whatever the executor returned, `content` is what the model read. */
export interface MemoryToolResultLike {
  readonly details?: unknown;
  readonly content?: readonly { readonly type: string; readonly text?: string }[];
}

/**
 * The slice of the host's `ToolRenderContext` the result line reads. The package does not export the whole of it, and
 * this renderer needs one member: the arguments of the call, which is where a search line finds its query.
 */
export interface MemoryRenderContext {
  readonly args?: unknown;
}

/** One rendered result: the text of the row and whether it is an error, which is the only line a theme touches. */
export interface MemoryResultRender {
  readonly text: string;
  readonly error: boolean;
}

/** The two renderers of one tool, in the shape `ToolDefinition` takes. */
export interface MemoryToolRenderers {
  renderCall(args: unknown, theme: Theme, context: MemoryRenderContext): Component;
  renderResult(
    result: AgentToolResult<unknown>,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: MemoryRenderContext,
  ): Component;
}

/**
 * The two lines of one tool: the call line, which runs before there is a result, and the result line, which runs over the
 * `details` the executor returned and the arguments of the call.
 */
interface ToolLines {
  call(name: MemoryToolName, args: unknown): string;
  result(name: MemoryToolName, details: Record<string, unknown>, args: unknown): string;
}

/**
 * One entry per tool name, so a name added to `MEMORY_TOOL_NAMES` without its lines is a compile error here instead of a
 * row that renders nothing. The name is passed to every line rather than read from the key: a line is a pure function of
 * what it is given, and one of them is shared by two tools.
 */
const TOOL_LINES: Readonly<Record<MemoryToolName, ToolLines>> = {
  memory_write: { call: writeCallLine, result: writeLine },
  memory_search: { call: searchCallLine, result: searchLine },
  memory_read: { call: idListCallLine, result: readLine },
  memory_delete: { call: idListCallLine, result: deleteLine },
};

/**
 * The collapsed line of a call: the one fact each tool needs to be readable while it runs. `memory_write` names the
 * category it is about to write into, `memory_search` the mode it is about to run — the query, the catalog or the count —
 * and the two tools that take ids list them. Nothing throws on the arguments: a call whose arguments have not arrived, or
 * arrived as something other than the object the schema describes, renders as the bare name. The claim is scoped to the
 * arguments because the name is not one: a name outside `MemoryToolName` has no entry in `TOOL_LINES` and throws a
 * `TypeError`, where the two switches this replaced answered `undefined`.
 */
export function buildCallLine(name: MemoryToolName, args: unknown): string {
  return TOOL_LINES[name].call(name, args);
}

/** `memory_write <category>`: the category the call is about to write into, or the bare name when it does not say. */
function writeCallLine(name: MemoryToolName, args: unknown): string {
  const category = stringField(args, "category");
  return category === undefined ? name : `${name} ${category}`;
}

/** `memory_search count`, `memory_search catalog` or `memory_search "<query>"`, whichever the executor is about to run. */
function searchCallLine(name: MemoryToolName, args: unknown): string {
  // The three modes are decided by the executor's own rule, read from `src/tools.ts`: `count_only` wins, then a query
  // that produces no tokens is the catalog. A call with no query at all has no tokens either, so it lands there too.
  const query = stringField(args, "query") ?? "";
  const mode = searchModeOf(toTokens(query), booleanField(args, "count_only") === true);

  if (mode === "count") return `${name} count`;
  if (mode === "catalog") return `${name} catalog`;
  return queryHead(name, args) ?? name;
}

/** `memory_read #3, #7`: the ids of the call, capped, and the bare name when the call carries no usable list. */
function idListCallLine(name: MemoryToolName, args: unknown): string {
  const ids = intListField(args, "ids");
  return ids === undefined || ids.length === 0 ? name : `${name} ${formatIdList(ids, MAX_IDS)}`;
}

/**
 * What one result row shows: the content text as is when the row is expanded, and the collapsed line otherwise. The
 * returned `error` is the fact the renderer styles with; the text itself stays plain, so a caller that only wants the
 * line never has to know a theme exists.
 */
export function buildResultRender(
  name: MemoryToolName,
  result: MemoryToolResultLike | undefined,
  options: { readonly expanded: boolean; readonly args?: unknown },
): MemoryResultRender {
  const details = detailsOf(result);
  const error = errorOf(details);

  if (options.expanded) {
    const content = contentText(result);
    if (content !== "") return { text: content, error: error !== undefined };
  }

  return { text: collapsedLine(name, details, error, options.args), error: error !== undefined };
}

/**
 * The renderers of one tool. Both close over the name and nothing else, and both answer a fresh `Text`: the host keeps
 * the last component itself, and a renderer that cached one would render the previous result forever.
 */
export function createMemoryRenderers(name: MemoryToolName): MemoryToolRenderers {
  return {
    renderCall: (args) => new Text(buildCallLine(name, args), 0, 0),
    renderResult: (result, options, theme, context) => {
      const rendered = buildResultRender(name, result, { expanded: options.expanded, args: context.args });
      // Expanded, an error result shows the message the model read, uncoloured like every other expansion.
      const styled = rendered.error && !options.expanded ? theme.fg("error", rendered.text) : rendered.text;
      return new Text(styled, 0, 0);
    },
  };
}

/**
 * The line of a result that is not expanded: the error first, the pending state second, the tool's own shape last. The
 * first two rules are shared by all four tools and stay here, in one place; only the third is the tool's.
 */
function collapsedLine(
  name: MemoryToolName,
  details: Record<string, unknown> | undefined,
  error: string | undefined,
  args: unknown,
): string {
  if (error !== undefined) return errorLine(error);
  if (details === undefined) return pendingLine(name);

  return TOOL_LINES[name].result(name, details, args);
}

/** `memory_write <category> #<id>`, plus `(duplicate)` when nothing was written because the text was already there. */
function writeLine(name: MemoryToolName, details: Record<string, unknown>, _args: unknown): string {
  const id = intField(details, "id");
  if (id === undefined) return pendingLine(name);

  const category = stringField(details, "category");
  const head = category === undefined ? `${name} #${id}` : `${name} ${category} #${id}`;
  return booleanField(details, "duplicate") === true ? `${head} (duplicate)` : head;
}

/** The three modes of a search: the query and its page, the catalog and its categories, the count and its total. */
function searchLine(name: MemoryToolName, details: Record<string, unknown>, args: unknown): string {
  const mode = stringField(details, "mode");
  const total = intField(details, "total") ?? 0;

  if (mode === "catalog") return `${name} catalog ${total} categories`;
  if (mode === "count") return `${name} count ${total}`;
  if (mode !== "search") return pendingLine(name);

  const shown = intField(details, "shown") ?? 0;
  // Without the call arguments there is no query to quote, and a line that guessed one would be inventing the request.
  const head = queryHead(name, args) ?? name;
  return `${head} ${shown} of ${total}`;
}

/** `memory_read #3, #7 → 1 found, 1 missing`: the ids asked for, then how many of each kind the store answered with. */
function readLine(name: MemoryToolName, details: Record<string, unknown>, _args: unknown): string {
  const found = intListField(details, "found");
  const missing = intListField(details, "missing");
  if (found === undefined && missing === undefined) return pendingLine(name);

  const ids = [...(found ?? []), ...(missing ?? [])];
  const head = ids.length === 0 ? name : `${name} ${formatIdList(ids, MAX_IDS)}`;
  return `${head} → ${found?.length ?? 0} found, ${missing?.length ?? 0} missing`;
}

/** `memory_delete 2 deleted, 1 missing`: the two counts of §7.4 and never the ids, which the model can read in the text. */
function deleteLine(name: MemoryToolName, details: Record<string, unknown>, _args: unknown): string {
  const deleted = intListField(details, "deleted");
  const missing = intListField(details, "missing");
  if (deleted === undefined && missing === undefined) return pendingLine(name);

  return `${name} ${deleted?.length ?? 0} deleted, ${missing?.length ?? 0} missing`;
}

/** `Error: <first line>`: a multi-line message keeps its first line on the row and its whole body in `details`. */
function errorLine(message: string): string {
  const first = message.split("\n")[0].trim();
  return first === "" ? ERROR_LABEL : `${ERROR_LABEL}: ${first}`;
}

/** `<name> …`: the row of a call whose result has not carried details yet. */
function pendingLine(name: MemoryToolName): string {
  return `${name} ${PENDING_SUFFIX}`;
}

/**
 * `<name> "<query>"`, or undefined when the call carries no query the executor would search: no query at all, or one
 * that `toTokens` reduces to nothing, which is the catalog the executor answers instead.
 */
function queryHead(name: MemoryToolName, args: unknown): string | undefined {
  const query = stringField(args, "query");
  if (query === undefined || toTokens(query).length === 0) return undefined;
  return `${name} "${query}"`;
}

/** The text parts of a result, one per line, which is what an expanded row shows and what the model read. */
function contentText(result: MemoryToolResultLike | undefined): string {
  const content = result?.content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => (typeof part === "object" && part !== null && typeof part.text === "string" ? part.text : ""))
    .filter((text) => text !== "")
    .join("\n");
}

/** The `details` of a result as a record, or undefined when there is none or it is not an object. */
function detailsOf(result: MemoryToolResultLike | undefined): Record<string, unknown> | undefined {
  const details = result?.details;
  if (typeof details !== "object" || details === null) return undefined;
  return details as Record<string, unknown>;
}

/**
 * The message of a details that carries `{ error }`, or undefined. A details of another shape answers undefined and falls
 * through to the tool's own line, which renders the pending form: an unexpected payload must not make the row throw.
 */
function errorOf(details: Record<string, unknown> | undefined): string | undefined {
  if (details === undefined) return undefined;

  const value = details.error;
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : String(value);
}

/** One field of an arbitrary value, or undefined for a value that is not an object. */
function fieldOf(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

function stringField(value: unknown, key: string): string | undefined {
  const raw = fieldOf(value, key);
  return typeof raw === "string" ? raw : undefined;
}

function intField(value: unknown, key: string): number | undefined {
  const raw = fieldOf(value, key);
  return typeof raw === "number" && Number.isInteger(raw) ? raw : undefined;
}

/** The integer members of an array field, in order; a value that is not an array answers undefined. */
function intListField(value: unknown, key: string): number[] | undefined {
  const raw = fieldOf(value, key);
  if (!Array.isArray(raw)) return undefined;
  return raw.filter((item): item is number => typeof item === "number" && Number.isInteger(item));
}

function booleanField(value: unknown, key: string): boolean | undefined {
  const raw = fieldOf(value, key);
  return typeof raw === "boolean" ? raw : undefined;
}
