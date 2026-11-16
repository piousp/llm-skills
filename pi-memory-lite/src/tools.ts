// The four tools as the host sees them, and the four executors where the logic lives. The declarations are the
// only permanent cost of the package, so every model-facing string is a constant of this module and
// none of the schemas carries a per-property description; the executors are exported so the suite can call them with no
// host, and `createMemoryTools` is a table that only wires each one to its `execute`.
//
// Nothing here opens a database on its own: the store arrives through `deps.store()`, a lazy getter, so a Node without
// `node:sqlite` answers every call with the message in `deps.unsupported` and never touches a file. And no
// executor throws: every call runs through the one shell `toolShell`, and a store failure leaves it as an error result
// that carries the store's own message, because a thrown error reaching the model is a failure the model can neither read
// nor act on.

import { defineTool, type AgentToolResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { ResolvedConfig } from "./config.ts";
import type { MemoryStore, SearchInput } from "./db.ts";
import { MAX_KEYS, messageOf } from "./db.ts";
import { MAX_RESULTS, formatCatalog, formatIdList, formatRead, formatSearch, type CatalogCategory } from "./format.ts";
import { appendUnique, distinctSlugs, toSlug, toTokens } from "./query.ts";
import { secretKindOf } from "./secrets.ts";

/** Longest text one entry may hold: under the 2000-character read cap, so a maximal entry is always legible whole. */
const MAX_TEXT = 1800;

/** Results per search page when the call does not say. */
const DEFAULT_LIMIT = 5;

/** First result of a search page when the call does not say. */
const DEFAULT_OFFSET = 0;

/** The order the host registers the four tools in, which is also the order of the `createMemoryTools` tuple. */
export const MEMORY_TOOL_NAMES = ["memory_write", "memory_search", "memory_read", "memory_delete"] as const;

/** What a write takes. No per-property description: it would be permanent context and the sibling fields are enough. */
export const WriteParams = Type.Object({
  text: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
  category: Type.String({ minLength: 1 }),
  keys: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: MAX_KEYS }),
});

/** The write schema of one session: with `allowUnknownCategory` off the category is an enum of the vocabulary. */
export function writeParamsFor(config: ResolvedConfig): typeof WriteParams {
  if (config.allowUnknownCategory) return WriteParams;
  return Type.Object({
    ...WriteParams.properties,
    category: Type.Unsafe<string>({ type: "string", enum: [...config.categories] }),
  }) as unknown as typeof WriteParams;
}

/** What a search takes: every field optional, because the empty call is the catalog mode. */
export const SearchParams = Type.Object({
  query: Type.Optional(Type.String()),
  category: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_RESULTS })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
});

/** What a read takes: integer ids, an array and not a comma-separated string. */
export const ReadParams = Type.Object({ ids: Type.Array(Type.Integer(), { minItems: 1, maxItems: 20 }) });

/** What a delete takes: the same array, with a wider ceiling because curation deletes in batches. */
export const DeleteParams = Type.Object({ ids: Type.Array(Type.Integer(), { minItems: 1, maxItems: 50 }) });

/**
 * The description of `memory_write`: what goes in the memory, that a write needs no permission, and the two
 * exclusions the model would otherwise learn by trial — what a future session does not need, and secrets. The clause
 * about initiative is the only channel present on every turn: the skill that says the same is read on demand, and a
 * session that only advertises it asks the user before writing, which is what four smoke runs showed.
 */
const WRITE_DESCRIPTION =
  "Save one durable fact, preference, decision or environment note to global memory. Write on your own initiative, without asking permission; what a future session needs only; never secrets.";

/** The `<tools>` line of `memory_write`: it appears in the default system prompt, so it is budget, not documentation. */
const WRITE_SNIPPET = "Save a durable fact, preference or decision to global memory";

/** The description of `memory_search`: the two modes and the paging, in one sentence. */
const SEARCH_DESCRIPTION =
  "Search global memory. With query: ranked matches with snippets and ids. Without query: the category catalog and top keys. offset pages both.";

/** The `<tools>` line of `memory_search`, naming both modes: the call with no query is the one models forget. */
const SEARCH_SNIPPET = "Find what global memory knows: ranked search, or the category catalog";

/** The description of `memory_read`: the only way to the full text of an entry, whose id a search line showed. */
const READ_DESCRIPTION = "Read full memory entries by id.";

/** The `<tools>` line of `memory_read`. */
const READ_SNIPPET = "Read full memory entries by id";

/**
 * The description of `memory_delete` names the correction route, because with no `memory_update` the model
 * that wants to fix an entry has to be told that deleting and writing again is the way.
 */
const DELETE_DESCRIPTION = "Delete memory entries by id. To correct an entry, delete it and write the corrected text.";

/** The `<tools>` line of `memory_delete`. */
const DELETE_SNIPPET = "Delete memory entries by id";

/** The message of a call whose keys all normalize to nothing: the rule broken, stated as what a key has to be. */
const KEYLESS_MESSAGE = "Every key normalizes to an empty slug; a key needs at least one letter or a digit.";

/** What `memory_write` answers when it stored the entry: the id a later `read` or `delete` takes, and the category. */
function savedMessage(id: number, category: string, similar: readonly number[]): string {
  const hint = similar.length === 0 ? "" : ` Similar: ${similar.map((n) => `#${n}`).join(", ")}.`;
  return `Saved #${id} (${category}).${hint}`;
}

/** What `memory_write` answers when the text was already there: the id that exists and the keys it gained or could not hold. */
function duplicateMessage(
  id: number,
  category: string,
  addedKeys: readonly string[],
  droppedKeys: readonly string[],
): string {
  const added = addedKeys.length === 0 ? "; nothing was written" : `; added keys: ${addedKeys.join(", ")}`;
  const dropped = droppedKeys.length === 0 ? "" : `; not added (limit ${MAX_KEYS}): ${droppedKeys.join(", ")}`;
  return `Duplicate of #${id} (${category})${added}${dropped}.`;
}

/** What `memory_search` answers when the query matched nothing, in the two moves that can still find it. */
function noMatchesMessage(query: string): string {
  return `No matches for "${query}". Try other words, or memory_search with no query for the catalog.`;
}

/** The tools' view of the world: the store they open lazily, the resolved settings, the clock and the early exit. */
export interface MemoryToolDeps {
  /** Opens the memory on the first call and caches it; never called while `unsupported` is set. */
  readonly store: () => Promise<MemoryStore>;
  /** The settings resolved at `session_start`: the vocabulary, the unknown-category rule and the exposure. */
  readonly config: ResolvedConfig;
  /** The clock of a write. Injected so the executors stay functions of their arguments. */
  readonly now: () => Date;
  /** The message for a Node older than `node:sqlite` needs; every call answers it and no database is opened. */
  readonly unsupported?: string;
}

/** The details of a write: the id plus what happened to it, or the message of the failure. */
export type WriteDetails =
  | { id: number; duplicate: false; category: string; similar: number[] }
  | { id: number; duplicate: true; category: string; addedKeys: string[]; droppedKeys: string[] }
  | { error: string };

/**
 * The details of a ranked search page: which mode answered, the total the page counts against, the page itself and how
 * many results it left out, the offset it started at, and the ids of the rows it named.
 */
export type RankedSearchDetails = {
  mode: "search";
  match: SearchInput["match"];
  total: number;
  shown: number;
  omitted: number;
  offset: number;
  ids: number[];
};

/** The details of a catalog page: the categories, the page of them and the ids of the keys it named. */
export type CatalogDetails = {
  mode: "catalog";
  total: number;
  shown: number;
  omitted: number;
  offset: number;
  ids: number[];
};

/** The details of a search: whichever of the two modes answered, or the message of the failure. */
export type SearchDetails = RankedSearchDetails | CatalogDetails | { error: string };

/** The details of a read: the ids found and absent, and how many of the found ones the cap left out. */
export type ReadDetails = { found: number[]; missing: number[]; shown: number; omitted: number } | { error: string };

/** The details of a delete: the ids the store removed and the ids that were not there. */
export type DeleteDetails = { deleted: number[]; missing: number[] } | { error: string };

/**
 * The four declarations the host registers, in the order of `MEMORY_TOOL_NAMES`. `exposure` comes from the resolved
 * settings on all four: `direct` declares them to the model, `codemode` and `deferred` keep them out of the
 * prompt and leave them to be found. Each `execute` is the one line that delegates to its executor.
 */
export function createMemoryTools(deps: MemoryToolDeps): readonly [
  ToolDefinition<typeof WriteParams, WriteDetails>,
  ToolDefinition<typeof SearchParams, SearchDetails>,
  ToolDefinition<typeof ReadParams, ReadDetails>,
  ToolDefinition<typeof DeleteParams, DeleteDetails>,
] {
  const exposure = deps.config.exposure;

  return [
    defineTool({
      name: MEMORY_TOOL_NAMES[0],
      label: "Memory write",
      description: WRITE_DESCRIPTION,
      promptSnippet: WRITE_SNIPPET,
      parameters: writeParamsFor(deps.config),
      exposure,
      annotations: { readOnlyHint: false, destructiveHint: false },
      execute: (_toolCallId, params) => executeWrite(deps, params),
    }),
    defineTool({
      name: MEMORY_TOOL_NAMES[1],
      label: "Memory search",
      description: SEARCH_DESCRIPTION,
      promptSnippet: SEARCH_SNIPPET,
      parameters: SearchParams,
      exposure,
      annotations: { readOnlyHint: true },
      execute: (_toolCallId, params) => executeSearch(deps, params),
    }),
    defineTool({
      name: MEMORY_TOOL_NAMES[2],
      label: "Memory read",
      description: READ_DESCRIPTION,
      promptSnippet: READ_SNIPPET,
      parameters: ReadParams,
      exposure,
      annotations: { readOnlyHint: true },
      execute: (_toolCallId, params) => executeRead(deps, params),
    }),
    defineTool({
      name: MEMORY_TOOL_NAMES[3],
      label: "Memory delete",
      description: DELETE_DESCRIPTION,
      promptSnippet: DELETE_SNIPPET,
      parameters: DeleteParams,
      exposure,
      annotations: { readOnlyHint: false, destructiveHint: true },
      execute: (_toolCallId, params) => executeDelete(deps, params),
    }),
  ];
}

function secretMessage(kind: string): string {
  return `The text looks like it contains a ${kind}; nothing was written. Save where to find it, not the value.`;
}

/**
 * `memory_write`. The checks run in the order of the contract and before the store is touched: a text over the
 * ceiling, too many keys, keys that normalize to nothing, and a category that normalizes to nothing or is not in the
 * vocabulary. Only then is the entry written, and only then does the clock tick; the shell of `toolShell` is around all
 * of it.
 */
export function executeWrite(
  deps: MemoryToolDeps,
  params: Static<typeof WriteParams>,
): Promise<AgentToolResult<WriteDetails>> {
  return toolShell<WriteDetails>(deps, async () => {
    if (params.text.length > MAX_TEXT) return errorResult(textTooLongMessage(params.text.length));
    if (params.keys.length > MAX_KEYS) return errorResult(tooManyKeysMessage(params.keys.length));

    const secretKind = [params.text, ...params.keys].map(secretKindOf).find((kind) => kind !== null);
    if (secretKind) return errorResult(secretMessage(secretKind));

    const keys = distinctSlugs(params.keys);
    if (keys.length === 0) return errorResult(KEYLESS_MESSAGE);

    const category = toSlug(params.category);
    const rejection = categoryMessage(params.category, category, deps.config);
    if (rejection !== null) return errorResult(rejection);

    const store = await deps.store();
    const written = store.write({ text: params.text, category, keys, ts: deps.now().toISOString() });

    // The parenthetical names the row this answer is about: the stored category, which a duplicate call under another one
    // would otherwise report as the category it asked for.
    return written.duplicate
      ? okResult(duplicateMessage(written.id, written.category, written.addedKeys, written.droppedKeys), {
          id: written.id,
          duplicate: true,
          category: written.category,
          addedKeys: [...written.addedKeys],
          droppedKeys: [...written.droppedKeys],
        })
      : okResult(savedMessage(written.id, written.category, written.similar), {
          id: written.id,
          duplicate: false,
          category: written.category,
          similar: [...written.similar],
        });
  });
}

/** The two modes one `memory_search` call runs. */
export type SearchMode = "catalog" | "search";

/**
 * The mode one call runs, and the one place its order is written: a query that produced no tokens is the
 * catalog, and anything else is the ranked search. The renderer of a call line reads this same rule,
 * because a line that named a mode the executor does not run would be a claim the model cannot check.
 */
export function searchModeOf(tokens: readonly string[]): SearchMode {
  return tokens.length === 0 ? "catalog" : "search";
}

/**
 * `memory_search`, as the dispatcher of its two modes: the catalog when the query produced
 * no tokens, then the ranked search. The order is what makes a query of symbols the catalog instead of an error. The
 * call is read once, here, and handed to the mode that answers it; the shell of `toolShell` is around all of it.
 */
export function executeSearch(
  deps: MemoryToolDeps,
  params: Static<typeof SearchParams>,
): Promise<AgentToolResult<SearchDetails>> {
  return toolShell<SearchDetails>(deps, async () => {
    const call = searchCall(params);
    const store = await deps.store();
    const mode = searchModeOf(call.tokens);

    if (mode === "catalog") return executeCatalog(store, call.offset);
    return executeRankedSearch(store, call);
  });
}

/** What one `memory_search` call resolved to: the input the store takes, plus the query its answer may quote. */
interface SearchCall extends Omit<SearchInput, "match"> {
  readonly query: string;
}

const ANY_WORD_NOTE = "No entry has every word; showing entries with any of them.";

/** Every word first; when no entry has them all and the query has several, any word. Returns the total of the mode chosen. */
function resolveMatch(store: MemoryStore, call: SearchCall): { match: SearchInput["match"]; total: number } {
  const all = store.countSearch({ ...call, match: "all" });
  if (call.tokens.length < 2 || all > 0) return { match: "all", total: all };
  return { match: "any", total: store.countSearch({ ...call, match: "any" }) };
}

/**
 * The catalog mode: the count of every category and its most used keys, paged by the offset of the call. The
 * store returns every category and the formatter pages them, so the offset is the caller's and not the store's, and the
 * total the details name is the number of categories the store answered with.
 */
function executeCatalog(store: MemoryStore, offset: number): AgentToolResult<CatalogDetails> {
  const { categories } = store.catalog();
  const totalCategories = categories.length;
  const page = formatCatalog({ categories, totalCategories, offset });

  return okResult(page.text, {
    mode: "catalog",
    total: totalCategories,
    shown: page.shown,
    omitted: page.omitted,
    offset,
    ids: catalogIds(categories, offset, page.shown),
  });
}

/** The ranked search: the page of hits, the total it counts against, and the advice for a query of no matches. */
function executeRankedSearch(store: MemoryStore, call: SearchCall): AgentToolResult<RankedSearchDetails> {
  const { match, total } = resolveMatch(store, call);
  const hits = store.search({ ...call, match });
  const note = match === "any" && total > 0 ? ANY_WORD_NOTE : undefined;
  const page = formatSearch({ hits, total, offset: call.offset, limit: call.limit, note });
  // A page that came back empty over a total of zero is the case the advice exists for; an empty page over a total that
  // the offset walked past keeps the formatter's line, which is the one that names the total and offset=0.
  const text = hits.length === 0 && total === 0 ? noMatchesMessage(call.query) : page.text;

  return okResult(text, {
    mode: "search",
    match,
    total,
    shown: page.shown,
    omitted: page.omitted,
    offset: call.offset,
    ids: hits.slice(0, page.shown).map((hit) => hit.id),
  });
}

/** The call of `memory_search` as the modes read it: the query and its tokens, the category slug and the two knobs. */
function searchCall(params: Static<typeof SearchParams>): SearchCall {
  const query = params.query ?? "";

  return {
    query,
    tokens: toTokens(query),
    category: filterOf(params.category),
    limit: params.limit ?? DEFAULT_LIMIT,
    offset: params.offset ?? DEFAULT_OFFSET,
  };
}

/**
 * `memory_read`: the full entries in the requested order, an id that is not in the database named by the
 * formatter and never an error, and an entry over the remaining budget clipped by the formatter with its marker.
 */
export function executeRead(
  deps: MemoryToolDeps,
  params: Static<typeof ReadParams>,
): Promise<AgentToolResult<ReadDetails>> {
  return toolShell(deps, async () => {
    const store = await deps.store();
    const read = store.read(params.ids);
    const page = formatRead({ rows: read.found, missing: read.missing });

    return okResult(page.text, {
      found: read.found.map((row) => row.id),
      missing: [...read.missing],
      shown: page.shown,
      omitted: page.omitted,
    });
  });
}

/**
 * `memory_delete`. There is no confirmation step: curation is explicit, and a second call for an id that is gone
 * reports it as absent rather than as a failure. The schema guarantees at least one id, so every id lands in one of the
 * two lines and the text is never empty.
 */
export function executeDelete(
  deps: MemoryToolDeps,
  params: Static<typeof DeleteParams>,
): Promise<AgentToolResult<DeleteDetails>> {
  return toolShell(deps, async () => {
    const store = await deps.store();
    const removed = store.remove(params.ids);

    const lines: string[] = [];
    // A call that deleted nothing says so on its own line only: `Deleted .` would report a fact that did not happen.
    if (removed.deleted.length > 0) lines.push(`Deleted ${formatIdList(removed.deleted)}.`);
    if (removed.missing.length > 0) lines.push(`Not found: ${formatIdList(removed.missing)}.`);

    return okResult(lines.join("\n"), { deleted: [...removed.deleted], missing: [...removed.missing] });
  });
}

/**
 * The one shell of a tool call, the rule every executor shares instead of repeating: a Node without `node:sqlite`
 * answers the message and opens nothing, and a failure of the store leaves as an error result carrying its own
 * message instead of as a thrown error the model can neither read nor act on. What the executors compute is the answer;
 * the two rules live here, once.
 */
async function toolShell<T>(
  deps: MemoryToolDeps,
  work: () => Promise<AgentToolResult<T>>,
): Promise<AgentToolResult<T | { error: string }>> {
  if (deps.unsupported !== undefined) return errorResult(deps.unsupported);

  try {
    return await work();
  } catch (error) {
    return errorResult(messageOf(error));
  }
}

/** A successful result: the text the model reads and the details the host keeps. */
function okResult<T>(text: string, details: T): AgentToolResult<T> {
  return { content: [{ type: "text", text }], details };
}

/** A failed result: the message is both what the model reads and what `details` carries, so the two never disagree. */
function errorResult(message: string): AgentToolResult<{ error: string }> {
  return { content: [{ type: "text", text: message }], details: { error: message }, isError: true };
}

/** The message of a text over the ceiling: the length found and the ceiling, and the move that keeps the fact. */
function textTooLongMessage(length: number): string {
  return `The text is ${length} characters and the maximum is ${MAX_TEXT}. Split it into two entries.`;
}

/** The message of a call with too many keys: how many arrived and how many fit. */
function tooManyKeysMessage(length: number): string {
  return `Too many keys: ${length} arrived and the maximum is ${MAX_KEYS}.`;
}

/**
 * Why a category cannot be written, or null when it can: an empty slug from any input, or a slug outside the vocabulary
 * while `allowUnknownCategory` is false. The message names the rejected value and lists the valid ones in the
 * configured order, because the model's next move is to pick one of them.
 */
function categoryMessage(raw: string, slug: string, config: ResolvedConfig): string | null {
  const valid = config.categories.join(", ");

  // The input is what is named here: the empty slug is a fact about the normalization, and the model wrote the input.
  if (slug === "") {
    return `The category "${raw}" normalizes to an empty slug. The valid categories are: ${valid}.`;
  }
  if (config.allowUnknownCategory || config.categories.includes(slug)) return null;

  return `The category "${slug}" is not configured. The valid categories are: ${valid}.`;
}

/**
 * The filter of a search, as the query layer takes it: `null` when the call names no category, and also when the name
 * normalizes to nothing, because a slug that can match no row would answer "no matches" over a full memory.
 */
function filterOf(raw: string | undefined): string | null {
  if (raw === undefined) return null;

  const slug = toSlug(raw);
  return slug === "" ? null : slug;
}

/** The ids the catalog page names: the newest entry of each key it shows, in the order it shows them, once each. */
function catalogIds(categories: readonly CatalogCategory[], offset: number, shown: number): number[] {
  const ids: number[] = [];
  for (const category of categories.slice(offset, offset + shown)) {
    for (const key of category.keys) {
      appendUnique(ids, key.id);
    }
  }
  return ids;
}
