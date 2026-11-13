import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CATEGORIES, SETTINGS_KEY, resolveConfig } from "../../src/config.ts";
import { openStore, type MemoryStore } from "../../src/db.ts";
import {
  MEMORY_TOOL_NAMES,
  createMemoryTools,
  executeDelete,
  executeRead,
  executeSearch,
  executeWrite,
  type MemoryToolDeps,
} from "../../src/tools.ts";

// I1: the four tools of §7 against a real store over a real file, one temporary directory per test. The declarations are
// asserted as declarations — names, snippets, annotations, exposure and the character budget of criterion 2 — and the
// executors are called directly, which is what makes this suite the place where the caps, the three search modes and the
// error paths of §7.1 are visible without a host. The store is never faked: a write that the database refuses, a
// vocabulary the settings reject and a page the formatter has to cut are facts about the whole chain, not about a stub.

/** The clock every fixture hands the tools, so a date in the output is a constant of the suite. */
const NOW = "2026-03-14T09:26:53.589Z";

/** A temporary directory that the test removes afterwards, never a fixed one shared between tests. */
function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(realpathSync(os.tmpdir()), "pi-memory-lite-tools-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A settings object with one block of this package, the shape `pi.getSettings()` returns. */
function settings(block: Record<string, unknown>): Record<string, unknown> {
  return { [SETTINGS_KEY]: block };
}

/** The store and the deps the executors take, both over a fresh temporary directory. */
interface Fixture {
  readonly deps: MemoryToolDeps;
  readonly store: MemoryStore;
}

/**
 * A store over a temporary directory and the deps that reach it, with the config `resolveConfig` produces for `raw` and
 * for the same directory: the memory opens under `<dir>/lite-memories`, the way a default install puts it under the agent
 * directory, and the test removes both afterwards.
 */
async function fixture(t: TestContext, raw: unknown = {}): Promise<Fixture> {
  const dir = tempDir(t);
  const { config } = resolveConfig({ raw, env: {}, agentDir: dir });
  const store = await openStore({ dir: config.dir });
  t.after(() => store.close());

  return { deps: { store: async () => store, config, now: () => new Date(NOW) }, store };
}

/** The text the model reads, which is where the caps and the declarations of §7 are visible. */
function textOf(result: AgentToolResult<unknown>): string {
  return result.content.map((part) => ("text" in part ? part.text : "")).join("");
}

/**
 * The details of a successful call. Every details type of this module is a member for the answer and a member that only
 * holds `error` for the failure, so an `error` key on a result that claims success is a contradiction the suite refuses.
 */
function detailsOf<T>(result: AgentToolResult<T>): Exclude<T, { error: string }> {
  assert.equal(result.isError ?? false, false, `la tool devolvió un error: ${textOf(result)}`);

  const details = result.details as Record<string, unknown>;
  assert.equal("error" in details, false, `la tool devolvió un error: ${String(details.error)}`);
  return result.details as Exclude<T, { error: string }>;
}

/** A write the suite expects to pass, with the vocabulary of one category and one key unless the test says otherwise. */
async function writeOk(
  deps: MemoryToolDeps,
  text: string,
  category = "general",
  keys: string[] = ["nota"],
): Promise<{ id: number; duplicate: boolean; category: string }> {
  return detailsOf(await executeWrite(deps, { text, category, keys }));
}

/** A write the suite expects to refuse, and the message it refused with. */
async function writeFail(
  deps: MemoryToolDeps,
  text: string,
  category = "general",
  keys: string[] = ["nota"],
): Promise<string> {
  const result = await executeWrite(deps, { text, category, keys });
  assert.equal(result.isError, true, `el write tenía que fallar: ${textOf(result)}`);

  const details = result.details;
  assert.ok("error" in details, "el details de un write fallido tiene que nombrar el mensaje");
  assert.equal(textOf(result), details.error, "el texto del error y su details tienen que decir lo mismo");
  return details.error;
}

/**
 * The categories a refusal names, parsed out of the sentence: the message is the model's whole view of the vocabulary, so
 * the assertion reads the list it actually wrote instead of matching a fragment that a shortened list would also match.
 */
function listedCategories(message: string): string[] {
  const match = /The valid categories are: (.+)\.$/.exec(message);
  assert.ok(match !== null, `el mensaje tiene que nombrar las categorías válidas; llegó: ${message}`);
  return match[1].split(", ");
}

// --- declaraciones --------------------------------------------------------------------------------------------------

// §7 and §8.6: the four tools in the order of the contract, each with the label, the description length, the snippet and
// the annotations of the table, all of them with the exposure the settings resolved.
test("tools: las cuatro se declaran en orden con su snippet, sus anotaciones y la exposición por defecto", async (t) => {
  const { deps } = await fixture(t);
  const tools = createMemoryTools(deps);

  assert.deepEqual(
    tools.map((tool) => tool.name),
    [...MEMORY_TOOL_NAMES],
  );
  assert.deepEqual(
    tools.map((tool) => tool.label),
    ["Memory write", "Memory search", "Memory read", "Memory delete"],
  );
  // The lengths are the ones of the table in the contract: a longer description is permanent context, not documentation.
  assert.deepEqual(
    tools.map((tool) => tool.description.length),
    [136, 184, 31, 89],
  );
  assert.deepEqual(
    tools.map((tool) => tool.promptSnippet),
    [
      "Save a durable fact, preference or decision to global memory",
      "Find what global memory knows: ranked search, or the category catalog",
      "Read full memory entries by id",
      "Delete memory entries by id",
    ],
  );
  assert.deepEqual(
    tools.map((tool) => tool.annotations),
    [
      { readOnlyHint: false, destructiveHint: false },
      { readOnlyHint: true },
      { readOnlyHint: true },
      { readOnlyHint: false, destructiveHint: true },
    ],
  );
  assert.deepEqual(
    tools.map((tool) => tool.exposure),
    ["direct", "direct", "direct", "direct"],
  );
});

// §8.6: the exposure of the settings reaches all four declarations, which is what keeps them out of the system prompt.
test("tools: la exposición codemode de la configuración se traslada a las cuatro", async (t) => {
  const { deps } = await fixture(t, settings({ exposure: "codemode" }));

  assert.deepEqual(
    createMemoryTools(deps).map((tool) => tool.exposure),
    ["codemode", "codemode", "codemode", "codemode"],
  );
});

// §10 criterion 2, measured at the level of a tool: descriptions, snippets and schemas of the four tools together.
test("presupuesto: descripciones, snippets y esquemas suman menos de 1500 caracteres", async (t) => {
  const { deps } = await fixture(t);
  const tools = createMemoryTools(deps);

  let total = 0;
  for (const tool of tools) {
    const schema = JSON.stringify(tool.parameters);
    // No per-property description anywhere: each one is context the model pays for on every request of every session.
    assert.equal(schema.includes('"description"'), false, `${tool.name} lleva descripciones en el esquema`);
    total += tool.description.length + (tool.promptSnippet?.length ?? 0) + schema.length;
  }

  t.diagnostic(`criterio 2: ${total} caracteres de los 1500 del presupuesto`);
  assert.ok(total < 1500, `las cuatro tools suman ${total} caracteres y el presupuesto es 1500`);
});

// --- memory_write ---------------------------------------------------------------------------------------------------

// §7.1: the success path says which id was stored and under which category, and the keys reach the store as slugs.
test("write: guarda la entrada y devuelve el id, la categoría y el texto guardado", async (t) => {
  const { deps, store } = await fixture(t);
  const result = await executeWrite(deps, {
    text: "La memoria usa node:sqlite.",
    category: "Decision",
    keys: ["node-sqlite", "FTS5"],
  });
  const details = detailsOf(result);

  assert.equal(details.duplicate, false);
  assert.equal(details.category, "decision");
  assert.equal(textOf(result), `Saved #${details.id} (decision).`);

  const stored = store.read([details.id]).found;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].text, "La memoria usa node:sqlite.");
  assert.equal(stored[0].category, "decision");
  assert.equal(stored[0].terms, "node-sqlite fts5");
  assert.equal(stored[0].ts, NOW);
});

// §7.1: duplicate detection normalizes case and internal spacing, so the same fact written twice is one entry and the
// answer names the id that already exists instead of a second one.
test("write: el mismo texto con otro caso y otro espaciado devuelve el id original como duplicado", async (t) => {
  const { deps, store } = await fixture(t);
  const first = await writeOk(deps, "Una preferencia firme.", "preference", ["preferencia"]);

  const result = await executeWrite(deps, {
    text: "  una   PREFERENCIA firme.  ",
    category: "preference",
    keys: ["preferencia"],
  });
  const details = detailsOf(result);

  assert.equal(details.duplicate, true);
  assert.equal(details.id, first.id);
  assert.equal(textOf(result), `Duplicate of #${first.id} (preference); nothing was written.`);
  assert.equal(store.totals({}).total, 1);
});

// G2 / I16: el duplicado se detecta sobre el texto y no sobre la categoría, así que el mismo texto escrito bajo otra
// categoría es el mismo duplicado: la respuesta nombra la categoría guardada, que es la de la fila que existe, y no la
// que pidió la llamada. La lectura de la entrada lo corrobora.
test("write: el duplicado en otra categoría nombra la categoría guardada", async (t) => {
  const { deps, store } = await fixture(t);
  const first = await writeOk(deps, "Una preferencia guardada en env.", "env", ["router"]);

  const result = await executeWrite(deps, {
    text: "  una   PREFERENCIA guardada en env.  ",
    category: "preference",
    keys: ["router"],
  });
  const details = detailsOf(result);

  assert.equal(details.duplicate, true);
  assert.equal(details.id, first.id);
  assert.equal(details.category, "env", "el details del duplicado nombra la categoría guardada");
  assert.equal(textOf(result), `Duplicate of #${first.id} (env); nothing was written.`);

  // La fila que existe sigue en `env`: el duplicado no la movió ni escribió una segunda entrada.
  assert.equal(store.read([first.id]).found[0].category, "env");
  assert.equal(store.totals({}).total, 1);
});

// §7.1: 1801 characters is an error and not a truncation, and the message names both numbers the model has to reconcile.
test("write: un texto de 1801 caracteres es error y no escribe nada", async (t) => {
  const { deps, store } = await fixture(t);
  const message = await writeFail(deps, "a".repeat(1801));

  assert.match(message, /1801/);
  assert.match(message, /1800/);
  assert.equal(store.totals({}).total, 0);
});

// §7.1: nine keys is an error, and the message names the ceiling the call broke.
test("write: nueve keys es error y no escribe nada", async (t) => {
  const { deps, store } = await fixture(t);
  const keys = Array.from({ length: 9 }, (_, index) => `clave-${index + 1}`);
  const message = await writeFail(deps, "Una entrada con demasiadas keys.", "general", keys);

  assert.match(message, /9/);
  assert.match(message, /8/);
  assert.equal(store.totals({}).total, 0);
});

// §7.1: keys that normalize to nothing leave no vocabulary, and an entry without a key is not what the contract stores.
test("write: keys que normalizan a nada es error", async (t) => {
  const { deps, store } = await fixture(t);
  const message = await writeFail(deps, "Una entrada sin vocabulario.", "general", ["!!!", "///"]);

  assert.match(message, /slug/);
  assert.equal(store.totals({}).total, 0);
});

// The refusal names the rejected value and the whole vocabulary, in the configured order: the model's next move is to
// pick one of them, so a message that listed part of the list would send it back with another refusal.
test("write: una categoría desconocida se rechaza y el mensaje lista las categorías válidas", async (t) => {
  const { deps, store } = await fixture(t);
  const message = await writeFail(deps, "Una entrada con categoría nueva.", "not-configured", ["nota"]);

  assert.match(message, /not-configured/);
  assert.deepEqual(listedCategories(message), [...DEFAULT_CATEGORIES]);
  assert.equal(store.totals({}).total, 0);

  // The empty slug is the other way to name no category, and it is refused with the same list.
  const empty = await writeFail(deps, "Una entrada con categoría vacía.", "!!!", ["nota"]);
  assert.deepEqual(listedCategories(empty), [...DEFAULT_CATEGORIES]);
});

// §7.6: with `allowUnknownCategory` the slug is created on the spot, and the answer names it as the category written.
test("write: la misma categoría se acepta con allowUnknownCategory", async (t) => {
  const { deps, store } = await fixture(t, settings({ allowUnknownCategory: true }));
  const details = await writeOk(deps, "Una entrada con categoría nueva.", "OMS", ["nota"]);

  assert.equal(details.duplicate, false);
  assert.equal(details.category, "oms");
  assert.deepEqual(
    store.catalog().categories.map((category) => category.category),
    ["oms"],
  );
});

// --- memory_search: catálogo ----------------------------------------------------------------------------------------

// §7.2: the call with no query is the catalog, and an empty database answers it with no category and no error.
test("search: el catálogo de una base vacía no es un error y declara cero categorías", async (t) => {
  const { deps } = await fixture(t);
  const result = await executeSearch(deps, {});
  const details = detailsOf(result);

  assert.equal(details.mode, "catalog");
  assert.equal(details.total, 0);
  assert.equal(details.shown, 0);
  assert.equal(details.omitted, 0);
  // An empty memory is a normal state, not an error, and the text says so instead of answering with nothing.
  assert.match(textOf(result), /memory_write/);
});

// §7.2: with entries, the catalog is one line per category with its count and its most used keys, and the ids of those
// keys are what the `details` offer for a follow-up read.
test("search: el catálogo con entradas muestra categoría, conteo y keys", async (t) => {
  const { deps } = await fixture(t);
  const first = await writeOk(deps, "El canon de Nicea.", "general", ["trinidad", "canon"]);
  const second = await writeOk(deps, "La trinidad en el credo.", "general", ["trinidad"]);
  const third = await writeOk(deps, "Usar node:sqlite.", "decision", ["node-sqlite"]);

  const result = await executeSearch(deps, {});
  const text = textOf(result);
  const details = detailsOf(result);

  assert.equal(details.mode, "catalog");
  assert.equal(details.total, 2);
  assert.equal(details.shown, 2);
  assert.equal(details.omitted, 0);
  assert.match(text, /#general \(2\): /);
  assert.match(text, /trinidad:\d+/);
  assert.match(text, /#decision \(1\): node-sqlite:\d+/);
  assert.deepEqual([...details.ids].sort((left, right) => left - right), [first.id, second.id, third.id].sort((left, right) => left - right));
});

// §10 criterion 5: more categories than fit one page stay under the cap and declare how many are left and with which
// offset they come.
test("search: un catálogo de más de veinte categorías declara cuántas faltan y con qué offset", async (t) => {
  const categories = Array.from({ length: 25 }, (_, index) => `cat${String(index + 1).padStart(2, "0")}`);
  const { deps } = await fixture(t, settings({ categories }));
  for (const category of categories) await writeOk(deps, `Nota de la categoría ${category}.`, category, [category]);

  const result = await executeSearch(deps, {});
  const text = textOf(result);
  const details = detailsOf(result);

  assert.ok(text.length <= 1500, `el catálogo mide ${text.length} caracteres y el cap es 1500`);
  assert.equal(details.mode, "catalog");
  assert.equal(details.total, 25);
  assert.equal(details.shown, 20);
  assert.equal(details.omitted, 5);
  assert.match(text, /5 more categories left/);
  assert.match(text, /offset=20/);
});

// §7.0 and criterion 5: a page whose twenty lines do not fit the cap shrinks until they do, and the tail names the
// offset that reveals the categories the shrink left out — the cap never trims a page in silence.
test("search: un catálogo que no entra en el cap se recorta y declara lo que quedó fuera", async (t) => {
  const categories = Array.from({ length: 25 }, (_, index) => `categoria-con-nombre-largo-${String(index + 1).padStart(2, "0")}`);
  const { deps } = await fixture(t, settings({ categories }));
  for (const category of categories) {
    const keys = [1, 2, 3, 4].map((key) => `clave-extremadamente-larga-${category.slice(-2)}-${key}`);
    await writeOk(deps, `Nota de la categoría ${category}.`, category, keys);
  }

  const result = await executeSearch(deps, {});
  const text = textOf(result);
  const details = detailsOf(result);

  assert.ok(text.length <= 1500, `el catálogo mide ${text.length} caracteres y el cap es 1500`);
  assert.equal(details.mode, "catalog");
  assert.equal(details.total, 25);
  // The shrink loop of §7.0 did its work: a page of twenty lines of this width cannot fit the cap.
  assert.ok(details.shown < 20, `la página mostró ${details.shown} categorías, cabían veinte`);
  assert.equal(details.omitted, 25 - details.shown);
  assert.match(text, new RegExp(`${details.omitted} more categories left`));
  assert.match(text, new RegExp(`use offset=${details.shown}`));
});

// --- memory_search: búsqueda ----------------------------------------------------------------------------------------

// §10 criterion 6: a page of two results stays under the cap and says how many results it left out and which knob
// reveals them.
test("search: tres coincidencias con limit 2 quedan bajo 800 caracteres y declaran las que faltan", async (t) => {
  const { deps } = await fixture(t);
  for (const index of [1, 2, 3]) {
    await writeOk(deps, `La criptografia numero ${index} ${"relleno ".repeat(40)}`, "general", ["criptografia"]);
  }

  const result = await executeSearch(deps, { query: "criptografia", limit: 2 });
  const text = textOf(result);
  const details = detailsOf(result);

  assert.equal(details.mode, "search");
  assert.equal(details.total, 3);
  assert.equal(details.shown, 2);
  assert.equal(details.omitted, 1);
  assert.equal(details.ids.length, 2);
  assert.ok(text.length <= 800, `la búsqueda mide ${text.length} caracteres y el cap es 800`);
  assert.match(text, /1 more results left out/);
  assert.match(text, /limit=10/);
});

// §7.2: `offset` pages the ranked order, so the second page starts where the first one stopped.
test("search: offset 1 corre la página de búsqueda", async (t) => {
  const { deps } = await fixture(t);
  for (const index of [1, 2, 3]) {
    await writeOk(deps, `El termino teologia numero ${index} ${"relleno ".repeat(40)}`, "general", ["teologia"]);
  }

  const first = detailsOf(await executeSearch(deps, { query: "teologia", limit: 2 }));
  const second = detailsOf(await executeSearch(deps, { query: "teologia", limit: 2, offset: 1 }));

  // El modo es lo que hace legibles `ids` y `offset`: los tres detalles de búsqueda no comparten esos campos.
  assert.equal(first.mode, "search");
  assert.equal(second.mode, "search");
  assert.equal(first.ids.length, 2);
  assert.equal(first.offset, 0);
  assert.equal(second.offset, 1);
  assert.equal(second.ids.length, 2);
  assert.equal(second.ids[0], first.ids[1]);
  assert.notEqual(second.ids[0], first.ids[0]);
});

// §7.2: a query with no match is an answer and not a failure, and the answer names the two moves that can still work.
test("search: una query sin coincidencias devuelve el consejo y no es error", async (t) => {
  const { deps } = await fixture(t);
  await writeOk(deps, "Sola scriptura y el canon.", "general", ["sola-scriptura"]);

  const result = await executeSearch(deps, { query: "hipopotamo" });
  const details = detailsOf(result);

  assert.equal(
    textOf(result),
    'No matches for "hipopotamo". Try fewer words, or memory_search with no query for the catalog.',
  );
  assert.equal(details.mode, "search");
  assert.equal(details.total, 0);
  assert.equal(details.shown, 0);
  assert.deepEqual(details.ids, []);
});

// --- memory_search: conteo ------------------------------------------------------------------------------------------

// §7.2: without a query the count mode answers the total and one line per category, which is the cheap look before any
// text is materialized.
test("search: count_only sin query cuenta el total y cada categoría", async (t) => {
  const { deps } = await fixture(t);
  await writeOk(deps, "Una entrada general.", "general", ["uno"]);
  await writeOk(deps, "Otra entrada general.", "general", ["dos"]);
  await writeOk(deps, "Una decisión.", "decision", ["tres"]);

  const result = await executeSearch(deps, { count_only: true });
  const text = textOf(result);
  const details = detailsOf(result);

  assert.equal(details.mode, "count");
  assert.equal(details.total, 3);
  assert.match(text, /total: 3/);
  assert.match(text, /general: 2/);
  assert.match(text, /decision: 1/);
});

// §7.2: with a query the count mode answers one number and no category, because a count narrowed to a query says
// nothing useful per category.
test("search: count_only con query cuenta solo las coincidencias", async (t) => {
  const { deps } = await fixture(t);
  await writeOk(deps, "Una entrada general.", "general", ["uno"]);
  await writeOk(deps, "Otra entrada general.", "general", ["dos"]);
  await writeOk(deps, "Una decisión.", "decision", ["tres"]);

  const result = await executeSearch(deps, { query: "entrada", count_only: true });
  const text = textOf(result);
  const details = detailsOf(result);

  assert.equal(details.mode, "count");
  assert.equal(details.total, 2);
  assert.match(text, /total: 2/);
  assert.doesNotMatch(text, /general: /);
});

// §7.2 and §7.6: the category narrows the count, and its slug is what the query layer compares against.
test("search: count_only con category acota el conteo", async (t) => {
  const { deps } = await fixture(t);
  await writeOk(deps, "Una entrada general.", "general", ["uno"]);
  await writeOk(deps, "Otra entrada general.", "general", ["dos"]);
  await writeOk(deps, "Una decisión.", "decision", ["tres"]);

  const result = await executeSearch(deps, { count_only: true, category: "Decision" });
  const text = textOf(result);
  const details = detailsOf(result);

  assert.equal(details.total, 1);
  assert.match(text, /total: 1/);
  assert.doesNotMatch(text, /general: /);
});

// §10 criterion 3 at tool level: the five hostile queries of the criterion reach `MATCH` neutralized as text, so none of
// them throws and none of them comes back as a syntax error.
test("search: las queries hostiles no lanzan y no devuelven un error de sintaxis", async (t) => {
  const { deps } = await fixture(t);
  await writeOk(deps, "Sola scriptura y el canon.", "general", ["sola-scriptura", "canon"]);

  for (const query of ["sola-scriptura", "a OR (b", '"unclosed', ")", "NEAR(a b"]) {
    const result = await executeSearch(deps, { query });
    assert.equal(result.isError ?? false, false, `la query ${String(query)} devolvió un error: ${textOf(result)}`);
  }

  // Criterion 4 rides along: the hyphenated query finds the entry through its vocabulary and its text.
  const found = detailsOf(await executeSearch(deps, { query: "sola-scriptura" }));
  assert.equal(found.total, 1);
});

// --- memory_read ----------------------------------------------------------------------------------------------------

// §10 criterion 7: twenty entries fit one page of the read cap, whole, in the order they were asked for.
test("read: veinte ids quedan bajo 2000 caracteres", async (t) => {
  const { deps } = await fixture(t);
  const ids: number[] = [];
  for (let index = 1; index <= 20; index += 1) {
    const written = await writeOk(deps, `Entrada ${index} ${"texto ".repeat(10)}`, "general", [`clave-${index}`]);
    ids.push(written.id);
  }

  const result = await executeRead(deps, { ids });
  const text = textOf(result);
  const details = detailsOf(result);

  assert.ok(text.length <= 2000, `la lectura mide ${text.length} caracteres y el cap es 2000`);
  assert.equal(details.shown, 20);
  assert.equal(details.omitted, 0);
  assert.deepEqual(details.found, ids);
  assert.deepEqual(details.missing, []);
});

// §7.3: an id that is not in the database is an absent entry, reported by the formatter, never an error.
test("read: los ids inexistentes se nombran y no son error", async (t) => {
  const { deps } = await fixture(t);
  const written = await writeOk(deps, "El canon de Nicea.", "general", ["canon"]);

  const result = await executeRead(deps, { ids: [written.id, 9999] });
  const text = textOf(result);
  const details = detailsOf(result);

  assert.match(text, /not found: 9999/);
  assert.match(text, /El canon de Nicea\./);
  assert.deepEqual(details.found, [written.id]);
  assert.deepEqual(details.missing, [9999]);
  assert.equal(details.shown, 1);
  assert.equal(details.omitted, 0);
});

// §7.1 and §7.3 together: the write ceiling sits below the read cap so a maximal entry always comes back whole.
test("read: una entrada de 1800 caracteres vuelve entera", async (t) => {
  const { deps } = await fixture(t);
  const long = "b".repeat(1800);
  const written = await writeOk(deps, long, "general", ["larga"]);

  const result = await executeRead(deps, { ids: [written.id] });
  const text = textOf(result);

  assert.equal(detailsOf(result).shown, 1);
  assert.ok(text.includes(long), "la entrada de 1800 caracteres tiene que volver entera y sin marcador");
  assert.ok(text.length <= 2000, `la lectura mide ${text.length} caracteres y el cap es 2000`);
});

// --- memory_delete --------------------------------------------------------------------------------------------------

// §7.4: one call over ids that exist and ids that do not reports both lists, and the entries that were deleted are gone.
test("delete: ids mixtos informan los borrados y los ausentes", async (t) => {
  const { deps } = await fixture(t);
  const first = await writeOk(deps, "La primera entrada.", "general", ["uno"]);
  const second = await writeOk(deps, "La segunda entrada.", "general", ["dos"]);

  const result = await executeDelete(deps, { ids: [first.id, second.id, 9999] });
  const details = detailsOf(result);

  assert.equal(textOf(result), `Deleted #${first.id}, #${second.id}.\nNot found: #9999.`);
  assert.deepEqual(details.deleted, [first.id, second.id]);
  assert.deepEqual(details.missing, [9999]);

  const after = detailsOf(await executeRead(deps, { ids: [first.id, second.id] }));
  assert.deepEqual(after.missing, [first.id, second.id]);
  assert.deepEqual(after.found, []);
});

// §7.4: a second delete of the same id is not a failure, it is an absent id, and the line says only that.
test("delete: el segundo borrado del mismo id lo informa como ausente", async (t) => {
  const { deps } = await fixture(t);
  const written = await writeOk(deps, "Una entrada que se borra dos veces.", "general", ["borrada"]);

  const first = detailsOf(await executeDelete(deps, { ids: [written.id] }));
  assert.deepEqual(first.deleted, [written.id]);

  const result = await executeDelete(deps, { ids: [written.id] });
  const details = detailsOf(result);

  assert.equal(textOf(result), `Not found: #${written.id}.`);
  assert.deepEqual(details.deleted, []);
  assert.deepEqual(details.missing, [written.id]);
});

// --- Node viejo -----------------------------------------------------------------------------------------------------

// §8.2 and criterion 13: with `unsupported` set, every executor answers the message and opens nothing. The getter throws
// if it is called, so a path that reached the database would fail the test with that sentence instead of the message.
test("unsupported: las cuatro devuelven el mensaje y no abren la base", async (t) => {
  const dir = tempDir(t);
  const { config } = resolveConfig({ raw: {}, env: {}, agentDir: dir });
  const message =
    "pi-memory-lite requires Node >= 22.14 for node:sqlite (found 20.11.0); the memory tools are registered but will return this error.";
  const deps: MemoryToolDeps = {
    store: (): Promise<MemoryStore> => {
      throw new Error("la base no se tenía que abrir");
    },
    config,
    now: () => new Date(NOW),
    unsupported: message,
  };

  const results = [
    await executeWrite(deps, { text: "Una entrada.", category: "general", keys: ["nota"] }),
    await executeSearch(deps, {}),
    await executeRead(deps, { ids: [1] }),
    await executeDelete(deps, { ids: [1] }),
  ];

  for (const result of results) {
    assert.equal(result.isError, true);
    assert.equal(textOf(result), message);
    assert.deepEqual(result.details, { error: message });
  }
});
