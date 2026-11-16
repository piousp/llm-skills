// What the model reads back: the four output shapes, each one a pure function of the rows the database returned.
// No import, no clock, no database, so every cap here is provable against a fixture. The caps are hard and the text
// declares what it left out, because a cap that clips silently is worse than no cap: the model cannot tell a complete
// answer from a truncated one. The row shapes the database layer has to satisfy are declared here, structurally, so
// `src/db.ts` can return its own rows without this module importing it.

/** Cap of a catalog page, in characters. */
export const CATALOG_CAP = 1500;
/** Cap of a search page, in characters. */
export const SEARCH_CAP = 800;
/** Cap of a read, in characters. */
export const READ_CAP = 2000;
/** Most rows a search page returns, whatever `limit` asks for. */
export const MAX_RESULTS = 10;
/** Categories in one catalog page. */
export const CATALOG_PAGE = 20;
/** Keys listed per category in the catalog. */
export const KEYS_PER_CATEGORY = 4;
/** Smallest fragment budget worth showing; below it the page drops rows instead of clipping words to nothing. */
export const MIN_SNIPPET = 12;

/** A search hit: the row, its whole text and the fragment `snippet()` produced, which a search line shows when the text does not fit. */
export interface SearchRow {
  readonly id: number;
  readonly ts: string;
  readonly category: string;
  readonly text: string;
  readonly fragment: string;
}

/** A full entry, which is what a read shows. */
export interface ReadRow {
  readonly id: number;
  readonly ts: string;
  readonly category: string;
  readonly text: string;
}

/** One term of a category in the catalog, with the id of the most recent entry that declares it. */
export interface CatalogKey {
  readonly term: string;
  readonly id: number;
}

/** One category line of the catalog: how many entries it holds and its most frequent keys. */
export interface CatalogCategory {
  readonly category: string;
  readonly n: number;
  readonly keys: readonly CatalogKey[];
}

/** What the database hands the catalog formatter: the categories to paginate and the offset the tail counts from. */
export interface CatalogPage {
  readonly categories: readonly CatalogCategory[];
  readonly totalCategories: number;
  readonly offset: number;
}

/** The text a tool returns plus the two counts the tool repeats in `details`, so both agree with the text by construction. */
export interface Formatted {
  readonly text: string;
  readonly shown: number;
  readonly omitted: number;
}

/** Head of every tail that declares results the page did not show; the three forms differ only in the advice after it. */
const RESULTS_LEFT_OUT = "more results left out";
/** Head of every tail that declares categories the page did not show. */
const MORE_CATEGORIES = "more categories left";
/**
 * Head of the only line a page whose `offset` walked past the last result answers. Such a page has no row to render, and a
 * tool that answers with the empty string tells the model nothing: it cannot tell an empty answer from a broken call.
 */
const PAST_THE_END = "the offset is past the end";
/** Advice of that line: the offset that does hold the results. */
const FIRST_PAGE = "use offset=0";
/** The whole line a catalog of a database with nothing written yet answers, and the tool that fills it. */
const EMPTY_CATALOG = "Nothing has been written to the memory yet; memory_write adds the first entry.";
/** Line of a read that names the requested ids the database did not find; the ids follow it. */
const NOT_FOUND = "... not found: ";
/** Line of a read that names the requested ids whose content the budget left out; the ids follow it. */
const IDS_NOT_SHOWN = "... ids not shown: ";
/** What a list of ids carries after the ids it cut, so the reader knows the list is not the whole of them. */
const ELLIPSIS = "\u2026";

/** The first 10 characters of the ISO stamp, which is the whole date and none of the time. */
export function shortDate(ts: string): string {
  return ts.slice(0, 10);
}

/** `#<id> <shortDate> <category> `: the fixed part of every row, trailing space included, so a fragment starts one apart. */
export function rowPrefix(row: { id: number; ts: string; category: string }): string {
  return `#${row.id} ${shortDate(row.ts)} ${row.category} `;
}

/**
 * Splits `room` characters among rows that want `lengths` each, raising the smallest share first: a row that fits gets
 * its whole length, and the rest divide what is left evenly. The shares never add up to more than `room`.
 */
export function allocate(lengths: readonly number[], room: number): number[] {
  const shares = lengths.map(() => 0);
  const order = lengths.map((_, index) => index).sort((a, b) => lengths[a] - lengths[b]);

  order.reduce((left, index, rank) => {
    const rows = order.length - rank;
    const share = Math.min(lengths[index], Math.floor(left / rows));
    shares[index] = share;
    return left - share;
  }, Math.max(0, room));

  return shares;
}

/** `text` whole when it fits `max`, else cut at the last word that fits and ended with an ellipsis. */
export function clipAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 0) return "";

  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space >= max / 2 ? cut.slice(0, space) : cut).trimEnd()}${ELLIPSIS}`;
}

/** `#1, #2, …`, cut after `max` ids with a trailing ellipsis when there are more. */
export function formatIdList(ids: readonly number[], max?: number): string {
  const shown = ids.slice(0, max === undefined ? ids.length : Math.max(0, max));
  const list = shown.map((id) => `#${id}`).join(", ");
  return ids.length > shown.length ? `${list}, ${ELLIPSIS}` : list;
}

/**
 * Renders at `n`, then drops a row at a time until the text fits `cap` or only one row is left. A page of one row is the
 * floor: below it there is no answer left to shrink toward.
 */
function shrinkToCap(start: number, cap: number, render: (n: number) => Formatted): Formatted {
  let n = start;
  let page = render(n);

  while (page.text.length > cap && n > 1) {
    n -= 1;
    page = render(n);
  }

  return page;
}

type SearchPageInput = { hits: readonly SearchRow[]; total: number; offset: number; limit: number; note?: string };

/**
 * A search page. The two loops are the guarantee and not an optimisation: the first shrinks the page until every
 * row has room to say something, the second until the rendered text — rows, newlines and tail — fits the cap.
 */
export function formatSearch(input: SearchPageInput): Formatted {
  const offset = Math.max(0, input.offset);
  const fetched = input.hits.length;
  const room = SEARCH_CAP - (input.note === undefined ? 0 : input.note.length + 1);
  let n = Math.max(0, Math.min(input.limit, MAX_RESULTS, fetched));

  while (n > 1 && tooNarrow(input, offset, n, room)) n -= 1;

  return shrinkToCap(n, SEARCH_CAP, (rows) => renderSearchPage(input, offset, rows, room));
}

/**
 * A catalog page. The rows here carry no fragment, so the formula has nothing to divide: the page shrinks a category
 * at a time until the lines, their newlines and the tail fit `CATALOG_CAP`.
 */
export function formatCatalog(input: CatalogPage): Formatted {
  const offset = Math.max(0, input.offset);
  const n = Math.max(0, Math.min(CATALOG_PAGE, input.categories.length - offset));

  return shrinkToCap(n, CATALOG_CAP, (rows) => renderCatalogPage(input, offset, rows));
}

/**
 * A read: full entries in the order asked for, an entry that does not fit its remaining budget truncated with its
 * marker, and closing lines that keep apart the two reasons an id brought no content — the ids the database did not
 * find and the ids the cap left out. Nothing is dropped without a line that says so.
 */
export function formatRead(input: { rows: readonly ReadRow[]; missing: readonly number[] }): Formatted {
  // The closing lines list ids chosen by the render, and their length decides how much room the entries get. The room
  // is therefore reserved for the widest version of both lines — every row id plus every missing id — before a single
  // entry is placed: a reservation that is too wide wastes a few characters of the last entry, one that is too narrow
  // is a cap that fails for lines nobody counted.
  const reserve = reserveForClosingLine(input.rows, input.missing);
  const entries = renderReadEntries(input.rows, READ_CAP - reserve);
  const closing = closingLines(input.missing, entries.dropped);
  const body = entries.bodies.join("\n\n");
  const text = closingLineText(body, closing);

  // `omitted` counts the ids whose content was left out and never the ids that do not exist: those are absent, not
  // hidden, and the closing line for them says so.
  return { text, shown: entries.bodies.length, omitted: entries.dropped.length };
}

/** Collapses every run of whitespace to one space: a row is one line whatever the entry held. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The tail of the page of `n` rows, and the characters left for the row bodies once prefixes, newlines and tail are paid. */
function searchLayout(input: SearchPageInput, offset: number, n: number, room: number): { tail: string; bodyRoom: number; omitted: number } {
  const omitted = Math.max(0, input.total - (offset + n));
  const tail = searchTail(omitted, offset, n, input.hits.length, input.limit);
  let used = Math.max(0, n - 1) + (tail === "" ? 0 : tail.length + 1);
  for (let index = 0; index < n; index += 1) used += rowPrefix(input.hits[index]).length;
  return { tail, bodyRoom: room - used, omitted };
}

/** The body budget of each of the first `n` rows: its whole text when it fits, an even share of the room otherwise. */
function bodyBudgets(
  input: SearchPageInput,
  offset: number,
  n: number,
  room: number,
): { wanted: number[]; budgets: number[]; tail: string; omitted: number } {
  const wanted = input.hits.slice(0, n).map((hit) => oneLine(hit.text).length);
  const { tail, bodyRoom, omitted } = searchLayout(input, offset, n, room);
  return { wanted, budgets: allocate(wanted, bodyRoom), tail, omitted };
}

/** True when some row of an `n`-row page would get less than `MIN_SNIPPET` characters, or less than it needs when shorter. */
function tooNarrow(input: SearchPageInput, offset: number, n: number, room: number): boolean {
  const { wanted, budgets } = bodyBudgets(input, offset, n, room);
  return budgets.some((budget, index) => budget < Math.min(MIN_SNIPPET, wanted[index]));
}

/** One candidate page: `n` rows, each whole or its fragment clipped at a word, plus the tail that declares what the page did not show. */
function renderSearchPage(input: SearchPageInput, offset: number, n: number, room: number): Formatted {
  const { wanted, budgets, tail, omitted } = bodyBudgets(input, offset, n, room);
  const lines: string[] = input.note === undefined ? [] : [input.note];
  for (let index = 0; index < n; index += 1) {
    const row = input.hits[index];
    const body = wanted[index] <= budgets[index] ? oneLine(row.text) : clipAtWord(oneLine(row.fragment), budgets[index]);
    lines.push(rowPrefix(row) + body);
  }

  const shown = n;
  // No row over a memory that does hold results is the page of an offset past the end, and it gets its own one line: the
  // loop above rendered nothing, and the counting tail below would clamp to zero and render nothing either.
  if (shown === 0 && input.total > 0) {
    return { text: pastTheEndLine(input.total, "result", "results"), shown, omitted: input.total };
  }

  if (tail !== "") lines.push(tail);

  return { text: lines.join("\n"), shown, omitted };
}

/**
 * The one line a search page ends with, or the empty string when nothing is left out. The advice names what reveals the
 * results that are missing: `offset` when the next window holds them, `limit` when the window itself is too narrow, and
 * both when the cap already dropped rows of a window that is also below the maximum.
 */
function searchTail(omitted: number, offset: number, shown: number, fetched: number, limit: number): string {
  if (omitted <= 0) return "";

  const next = offset + shown;
  const capCut = shown < fetched;
  const beyondWindow = omitted > fetched - shown;
  const offsetAdvice = `offset=${next}`;
  const limitAdvice = `limit=${MAX_RESULTS}`;

  if (capCut && beyondWindow && limit < MAX_RESULTS) {
    return `... ${omitted} ${RESULTS_LEFT_OUT}; use ${offsetAdvice} or ${limitAdvice}`;
  }
  if (capCut) return `... ${omitted} ${RESULTS_LEFT_OUT}; use ${offsetAdvice}`;
  if (limit < MAX_RESULTS) return `... ${omitted} ${RESULTS_LEFT_OUT}; use ${limitAdvice}`;
  return `... ${omitted} ${RESULTS_LEFT_OUT}; use ${offsetAdvice}`;
}

/** One candidate catalog page: `n` categories from `offset` plus the tail that declares the rest. */
function renderCatalogPage(input: CatalogPage, offset: number, n: number): Formatted {
  const lines = input.categories.slice(offset, offset + n).map(catalogLine);

  const shown = lines.length;
  // The two empty pages of the catalog get a line each, because the empty string is not an answer: a fresh database has
  // nothing written yet, and an offset past the last category has a total and a page that does show it.
  if (shown === 0) {
    if (input.totalCategories === 0) return { text: EMPTY_CATALOG, shown, omitted: 0 };

    return { text: pastTheEndLine(input.totalCategories, "category", "categories"), shown, omitted: input.totalCategories };
  }

  const omitted = Math.max(0, input.totalCategories - (offset + shown));
  if (omitted > 0) lines.push(`... ${omitted} ${MORE_CATEGORIES}; use offset=${offset + shown}`);

  return { text: lines.join("\n"), shown, omitted };
}

/**
 * The one line a page whose `offset` walked past the last result answers: where the offset landed, how many there are, and
 * the offset that shows them. `singular` and `plural` keep the count agreeing with what it counts.
 */
function pastTheEndLine(total: number, singular: string, plural: string): string {
  return `${PAST_THE_END}: the memory holds ${total} ${total === 1 ? singular : plural}; ${FIRST_PAGE}`;
}

/** `<category> (<n>): <term>:<id>, ...` with at most `KEYS_PER_CATEGORY` keys, in the order received. */
function catalogLine(category: CatalogCategory): string {
  const head = `${category.category} (${category.n}):`;
  const keys = category.keys.slice(0, KEYS_PER_CATEGORY).map((key) => `${key.term}:${key.id}`);
  return keys.length === 0 ? head : `${head} ${keys.join(", ")}`;
}

/**
 * The prefix of a row without its trailing space: the header a read prints on a line of its own, above the text of the
 * entry. The space exists for the inline fragment of a search line, and a header that kept it would end the line with a
 * character that says nothing.
 */
function readHeader(row: { id: number; ts: string; category: string }): string {
  return rowPrefix(row).trimEnd();
}

/** The entries of a read that fit `budget`, each whole or truncated, plus the ids of the rows that did not fit. */
function renderReadEntries(
  rows: readonly ReadRow[],
  budget: number,
): { bodies: readonly string[]; dropped: readonly number[] } {
  const bodies: string[] = [];
  let used = 0;

  // The page is the longest prefix of whole entries: the first one that does not fit ends it, and the read drops nothing
  // it could have placed before that point.
  for (const row of rows) {
    const whole = `${readHeader(row)}\n${row.text}`;
    const separator = bodies.length === 0 ? 0 : 2; // the blank line between two entries
    if (used + separator + whole.length > budget) break;
    bodies.push(whole);
    used += separator + whole.length;
  }

  // The entry that ended the prefix still gets its clipped form when one character of text fits it, and only that one:
  // everything past it is named in the closing lines.
  if (rows.length > bodies.length) {
    const row = rows[bodies.length];
    const separator = bodies.length === 0 ? 0 : 2;
    const clipped = truncatedEntry(readHeader(row), row.text, budget - used - separator);
    if (clipped !== null) bodies.push(clipped);
  }

  return { bodies, dropped: rows.slice(bodies.length).map((row) => row.id) };
}

/**
 * An entry clipped to `room` characters, marker included, or null when not even one character of text fits. The marker's
 * own length grows with the number of digits of the count it names, so the reservation uses the marker of the whole text:
 * it is never shorter than the one the clip actually gets, which keeps the entry inside its room.
 */
function truncatedEntry(header: string, text: string, room: number): string | null {
  const fixed = header.length + 2; // header, newline, newline before the marker
  const roomForText = room - fixed - omittedMarker(text.length).length;
  if (roomForText < 1) return null;

  const kept = text.slice(0, roomForText);
  return `${header}\n${kept}\n${omittedMarker(text.length - kept.length)}`;
}

/** The marker of an entry that a read had to clip. */
function omittedMarker(omitted: number): string {
  return `[... ${omitted} characters omitted; read fewer ids at once]`;
}

/**
 * Characters the closing lines can cost: the widest pair of lists the render could name, the newline between them
 * included because it is part of the text those lines occupy, plus the newline that separates them from the entries.
 */
function reserveForClosingLine(rows: readonly ReadRow[], missing: readonly number[]): number {
  const widest = closingLines(missing, rows.map((row) => row.id));
  return widest === "" ? 0 : widest.length + 1;
}

/**
 * `... not found: 9, 11` for the ids the database did not find, then `... ids not shown: 3, 4` for the ids that were
 * found but did not fit the budget: two different facts for the model, so one line each, in that order, and a line only
 * when its list has an id. The empty string means every requested id brought content.
 */
function closingLines(notFound: readonly number[], notShown: readonly number[]): string {
  const lines: string[] = [];
  if (notFound.length > 0) lines.push(`${NOT_FOUND}${notFound.join(", ")}`);
  if (notShown.length > 0) lines.push(`${IDS_NOT_SHOWN}${notShown.join(", ")}`);
  return lines.join("\n");
}

/** The entries, then the closing lines on their own lines; the lines alone when no entry fit. */
function closingLineText(body: string, closing: string): string {
  if (closing === "") return body;
  return body === "" ? closing : `${body}\n${closing}`;
}
