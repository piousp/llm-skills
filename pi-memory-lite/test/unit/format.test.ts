import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CATALOG_CAP,
  CATALOG_PAGE,
  COUNT_CAP,
  KEYS_PER_CATEGORY,
  MAX_RESULTS,
  MAX_SNIPPET,
  MIN_SNIPPET,
  READ_CAP,
  SEARCH_CAP,
  formatCatalog,
  formatCount,
  formatIdList,
  formatRead,
  formatSearch,
  rowPrefix,
  shortDate,
  snippetBudget,
  truncateText,
} from "../../src/format.ts";
import type { CatalogCategory, ReadRow, SearchRow } from "../../src/format.ts";

// I1: the four output shapes of §7, on their own. Every function of src/format.ts is a function of its arguments, so this
// suite is a list of rows and their expected text: a database would prove nothing the module does not do, because the
// module never sees one. The caps are asserted as caps (`text.length <= CAP`) and not as lengths, so an implementation
// that fills the budget differently still passes, and one that overflows fails under the name of the cap it broke.

const TS = "2026-03-14T09:26:53.589Z";

/** `count` search hits of one fixed date, each fragment `fragmentLength` characters long and distinct from the next. */
function searchRows(count: number, fragmentLength: number): SearchRow[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    ts: TS,
    category: "general",
    fragment: `${String(index + 1).padStart(3, "0")}${"x".repeat(Math.max(0, fragmentLength - 3))}`,
  }));
}

/** One full entry, with the date and the category fixed unless the test says otherwise. */
function readRow(id: number, text: string, category = "general"): ReadRow {
  return { id, ts: TS, category, text };
}

/** `count` categories with `keysPerCategory` short keys each, in the order a catalog query returns them. */
function catalogCategories(count: number, keysPerCategory: number): CatalogCategory[] {
  return Array.from({ length: count }, (_, index) => ({
    category: `cat${index + 1}`,
    n: index + 1,
    keys: Array.from({ length: keysPerCategory }, (_, key) => ({ term: `term${key + 1}`, id: index * 10 + key + 1 })),
  }));
}

// --- snippetBudget ---------------------------------------------------------------------------------------------------

// The three numbers of §7.0, verbatim: the formula, the cap of 60, and the case where the fixed part alone eats the cap.
test("snippetBudget: cinco filas de 28 caracteres dan el máximo de 60 por fragmento", () => {
  assert.equal(snippetBudget(800, 5, 28), 60);
});

// The case that makes the second loop necessary: 52 per fragment is what the formula promises for ten rows.
test("snippetBudget: diez filas de 28 caracteres dejan 52 por fragmento", () => {
  assert.equal(snippetBudget(800, 10, 28), 52);
});

// Twenty rows of 100 characters do not fit 800 at all, and the floor of the formula is zero, never a negative budget.
test("snippetBudget: veinte filas de 100 caracteres no dejan presupuesto", () => {
  assert.equal(snippetBudget(800, 20, 100), 0);
});

// A cap smaller than the fixed part is the same case one step further: zero, because a negative fragment has no meaning.
test("snippetBudget: un cap menor que la parte fija da 0 y nunca un número negativo", () => {
  assert.equal(snippetBudget(100, 5, 30), 0);
  assert.equal(snippetBudget(10, 1, 500), 0);
});

// --- truncateText ----------------------------------------------------------------------------------------------------

// The cut and the number of characters dropped travel together, because the caller has to declare the second one.
test("truncateText: devuelve el texto cortado y los caracteres descartados", () => {
  assert.deepEqual(truncateText("abcdefghij", 4), { text: "abcd", omitted: 6 });
});

// A text that fits comes back whole, with nothing declared as dropped.
test("truncateText: un texto que entra completo vuelve entero sin omisiones", () => {
  assert.deepEqual(truncateText("corto", 60), { text: "corto", omitted: 0 });
});

// --- shortDate y rowPrefix -------------------------------------------------------------------------------------------

// The stamp is ISO, so the date is its first ten characters and the time is the rest.
test("shortDate: la fecha corta son los primeros diez caracteres del sello ISO", () => {
  assert.equal(shortDate(TS), "2026-03-14");
});

// The prefix is what a search line and a read header share: id, date, category, and the space the fragment follows.
test("rowPrefix: el prefijo de fila es id, fecha corta, categoría y un espacio final", () => {
  assert.equal(rowPrefix({ id: 34, ts: TS, category: "religion" }), "#34 2026-03-14 religion ");
});

// --- formatIdList ----------------------------------------------------------------------------------------------------

// No ids is no text at all: the caller that has nothing to list has nothing to put after the tool name.
test("formatIdList: la lista vacía es la cadena vacía", () => {
  assert.equal(formatIdList([]), "");
  assert.equal(formatIdList([], 5), "");
});

// Three ids fit under any maximum the row uses, and the separator is a comma and one space.
test("formatIdList: tres ids se unen con coma y espacio", () => {
  assert.equal(formatIdList([1, 2, 3]), "#1, #2, #3");
  assert.equal(formatIdList([1, 2, 3], 5), "#1, #2, #3");
});

// Five ids under a maximum of five are exactly the row's capacity: the last id is there and nothing was cut.
test("formatIdList: cinco ids caben enteros bajo un máximo de cinco", () => {
  assert.equal(formatIdList([1, 2, 3, 4, 5], 5), "#1, #2, #3, #4, #5");
});

// Seven ids are past it: the first five stay and the ellipsis declares the two the row did not show. Without a maximum
// the list is the whole of what it was given, which is the shape the contract's closing lines print.
test("formatIdList: siete ids bajo un máximo de cinco se cortan con la elipsis", () => {
  assert.equal(formatIdList([1, 2, 3, 4, 5, 6, 7], 5), "#1, #2, #3, #4, #5, …");
  assert.equal(formatIdList([1, 2, 3, 4, 5, 6, 7]), "#1, #2, #3, #4, #5, #6, #7");
});

// --- formatSearch ----------------------------------------------------------------------------------------------------

// The second loop of §7.0, asserted where it bites: ten fragments of 300 characters, a cap of 800 and a formula that
// promises 57 per fragment with the page full. The page has to come back with fewer than MAX_RESULTS rows and a tail
// that says how many results are left out and which offset reaches them.
test("formatSearch: diez fragmentos largos caben en SEARCH_CAP y la cola declara el offset", () => {
  const page = formatSearch({ hits: searchRows(10, 300), total: 40, offset: 0, limit: 10 });

  assert.ok(page.text.length <= SEARCH_CAP);
  assert.ok(page.shown < MAX_RESULTS);

  const lines = page.text.split("\n");
  assert.equal(lines.length, page.shown + 1);
  assert.equal(lines[page.shown], `... ${page.omitted} more results left out; use offset=${page.shown}`);
  assert.equal(page.omitted, 40 - page.shown);
});

// The fragment of a row is cut to the budget and the row keeps its prefix, which is what lets the model read the id back.
test("formatSearch: el fragmento se corta al presupuesto y la fila conserva su prefijo", () => {
  const page = formatSearch({ hits: searchRows(3, 300), total: 3, offset: 0, limit: 3 });
  const [first] = page.text.split("\n");

  assert.ok(first.startsWith("#1 2026-03-14 general "));
  assert.ok(first.length <= rowPrefix({ id: 1, ts: TS, category: "general" }).length + MAX_SNIPPET);
});

// Nothing left out is nothing declared: no tail line at all, and one line per row.
test("formatSearch: una página con todos los resultados no lleva cola", () => {
  const page = formatSearch({ hits: searchRows(3, 40), total: 3, offset: 0, limit: 5 });

  assert.equal(page.shown, 3);
  assert.equal(page.omitted, 0);
  assert.equal(page.text.split("\n").length, 3);
  assert.ok(!page.text.includes("left out"));
});

// When the limit is what hides results, the advice is the maximum limit and not the offset: raising the window is the
// cheaper request for the model.
test("formatSearch: un límite menor que diez se declara como use limit=10", () => {
  const page = formatSearch({ hits: searchRows(5, 40), total: 40, offset: 20, limit: 5 });

  assert.equal(page.shown, 5);
  assert.equal(page.omitted, 15);
  assert.ok(page.text.endsWith("... 15 more results left out; use limit=10"));
});

// Both at once: the cap dropped rows the database did return and the window is narrower than the maximum, so the tail
// names the offset that reaches the rest of this window and the limit that widens the next one.
test("formatSearch: recortada por el cap y por el límite, la cola declara las dos salidas", () => {
  const hits = searchRows(5, 300).map((row) => ({ ...row, category: "c".repeat(200) }));
  const page = formatSearch({ hits, total: 40, offset: 0, limit: 5 });

  assert.ok(page.text.length <= SEARCH_CAP);
  assert.ok(page.shown < 5);
  assert.ok(page.text.endsWith(`... ${page.omitted} more results left out; use offset=${page.shown} or limit=10`));
});

// §7.0, primer ajuste (§11): un prefijo fijo de 68 y 69 caracteres deja 11 por fragmento en una página de diez filas, por
// debajo de MIN_SNIPPET, así que la página baja a nueve filas y el presupuesto sube a 20. El segundo ajuste no interviene:
// los fragmentos de diez caracteres caben enteros en ese presupuesto y la página no toca el cap, que es lo que deja ver
// que fue el primer ajuste el que decidió la cantidad de filas.
test("formatSearch: diez filas de prefijo largo bajan a nueve por MIN_SNIPPET", () => {
  const category = "c".repeat(53);
  const hits = searchRows(10, 10).map((row) => ({ ...row, category }));
  const page = formatSearch({ hits, total: 10, offset: 0, limit: 10 });

  // El prefijo de cada fila, tal como lo mide el presupuesto: el más largo de la página que se va a renderizar.
  const prefixOf = (count: number): number => Math.max(...hits.slice(0, count).map((row) => rowPrefix(row).length));
  assert.equal(prefixOf(10), 69);
  assert.equal(prefixOf(9), 68);
  assert.ok(snippetBudget(SEARCH_CAP, 10, prefixOf(10)) < MIN_SNIPPET, "diez filas ya no dejan presupuesto suficiente");

  assert.equal(page.shown, 9);
  assert.equal(page.omitted, 1);
  // El presupuesto de la página que sí se renderiza está por encima del mínimo, que es lo que el primer ajuste busca.
  assert.ok(snippetBudget(SEARCH_CAP, page.shown, prefixOf(page.shown)) >= MIN_SNIPPET);

  // Los nueve fragmentos entran enteros: ninguno queda cortado por debajo de su presupuesto.
  const lines = page.text.split("\n");
  assert.equal(lines.length, page.shown + 1);
  const fragments = lines.slice(0, page.shown).map((line, index) => line.slice(rowPrefix(hits[index]).length));
  for (const [index, fragment] of fragments.entries()) {
    assert.equal(fragment, hits[index].fragment);
  }
});

// El presupuesto de fragmento se recalcula para cada n que el segundo ajuste prueba, y no se queda con el valor que dejó
// el lazo de MIN_SNIPPET: esta página dibuja diez filas, no entra en el cap y baja a nueve, y al bajar una fila cada
// fragmento que queda tiene que ensancharse por encima del presupuesto de diez. Congelar el presupuesto en 57 deja la
// suite entera verde salvo aquí.
test("formatSearch: bajar una fila recalcula el presupuesto y ensancha los fragmentos por encima del de n=10", () => {
  const hits = searchRows(10, 300);
  const page = formatSearch({ hits, total: 40, offset: 0, limit: 10 });

  // El primer candidato es el de la llamada: diez filas, con el prefijo más largo de esas diez, que es el de `#10`.
  const fixedLen = Math.max(...hits.map((row) => rowPrefix(row).length));
  const frozen = snippetBudget(SEARCH_CAP, hits.length, fixedLen);
  assert.equal(fixedLen, 23);
  assert.equal(frozen, 57);

  assert.ok(page.text.length <= SEARCH_CAP, `la búsqueda mide ${page.text.length} caracteres y el cap es 800`);
  assert.ok(page.shown < MAX_RESULTS, `la página mostró ${page.shown} filas, cabían diez`);

  const fragments = page.text
    .split("\n")
    .slice(0, page.shown)
    .map((line, index) => line.slice(rowPrefix(hits[index]).length));
  assert.equal(fragments.length, page.shown);
  for (const fragment of fragments) {
    assert.ok(
      fragment.length > frozen,
      `el fragmento de ${fragment.length} caracteres no se ensanchó por encima de los ${frozen} de la página de diez`,
    );
  }
});

// Una página que el offset dejó más allá del último resultado existe y tiene que decir algo: con tres coincidencias y
// offset 4 no hay fila que renderizar, y la respuesta vacía no distingue "no hay nada" de "la tool no contestó".
test("formatSearch: un offset más allá del último resultado rinde una línea con el total y offset=0", () => {
  const page = formatSearch({ hits: [], total: 3, offset: 4, limit: 5 });

  const lines = page.text.split("\n");
  assert.equal(lines.length, 1);
  assert.notEqual(page.text.trim(), "");
  assert.match(page.text, /past the end/);
  assert.match(page.text, / 3 results/);
  assert.match(page.text, /offset=0/);
  assert.equal(page.shown, 0);
  assert.equal(page.omitted, 3);
});

// --- formatCatalog ---------------------------------------------------------------------------------------------------

// Twenty-five categories paginate by category: twenty lines, the cap respected, and a tail whose offset is the next page.
test("formatCatalog: veinticinco categorías dan veinte líneas y una cola con offset=20", () => {
  const page = formatCatalog({ categories: catalogCategories(25, 4), totalCategories: 25, offset: 0 });

  assert.ok(page.text.length <= CATALOG_CAP);

  const lines = page.text.split("\n");
  assert.equal(page.shown, CATALOG_PAGE);
  assert.equal(lines.filter((line) => line.startsWith("#")).length, CATALOG_PAGE);
  assert.equal(lines[lines.length - 1], "... 5 more categories left; use offset=20");
  assert.equal(page.omitted, 5);
});

// El segundo ajuste de §7.0 puede tener que correr más de una vez. Con categorías de 80 caracteres, la página de veinte
// filas y la de diecinueve se pasan de CATALOG_CAP y la de dieciocho entra: la página baja dos filas y no una, que es lo
// que distingue un ajuste que itera de uno que resta una sola vez.
test("formatCatalog: un cap que exige dos reducciones baja la página dos filas", () => {
  const categories: CatalogCategory[] = Array.from({ length: 25 }, () => ({
    category: "c".repeat(70),
    n: 1,
    keys: [{ term: "t", id: 1 }],
  }));

  const page = formatCatalog({ categories, totalCategories: 25, offset: 0 });

  const [firstLine] = page.text.split("\n");
  assert.equal(firstLine.length, 80);
  // Las dos páginas que el ajuste tuvo que descartar, medidas como el formateador las mide: filas, saltos y cola.
  assert.ok(20 * 80 + 20 + "... 5 more categories left; use offset=20".length > CATALOG_CAP, "veinte filas no caben");
  assert.ok(19 * 80 + 19 + "... 6 more categories left; use offset=19".length > CATALOG_CAP, "diecinueve tampoco");

  assert.equal(page.shown, CATALOG_PAGE - 2);
  assert.equal(page.omitted, 25 - page.shown);
  assert.ok(page.text.length <= CATALOG_CAP);
  assert.ok(page.text.endsWith(`... ${page.omitted} more categories left; use offset=${page.shown}`));
});

// A category lists at most KEYS_PER_CATEGORY keys: the fifth term of the vocabulary never reaches the page.
test("formatCatalog: una categoría con cinco claves muestra solo cuatro", () => {
  const categories: CatalogCategory[] = [
    { category: "religion", n: 12, keys: Array.from({ length: 5 }, (_, index) => ({ term: `t${index + 1}`, id: index + 1 })) },
  ];
  const page = formatCatalog({ categories, totalCategories: 1, offset: 0 });

  assert.equal(page.text, "#religion (12): t1:1, t2:2, t3:3, t4:4");
  assert.equal(page.text.split(", ").length, KEYS_PER_CATEGORY);
});

// A category the model has never used is still a category: the count is printed and the colon has nothing after it.
test("formatCatalog: una categoría sin claves termina en dos puntos", () => {
  const page = formatCatalog({ categories: [{ category: "env", n: 2, keys: [] }], totalCategories: 1, offset: 0 });

  assert.equal(page.text, "#env (2):");
});

// The last page leaves nothing out, so it carries no tail and its offset does not invite another request.
test("formatCatalog: la última página no lleva cola", () => {
  const page = formatCatalog({ categories: catalogCategories(25, 2), totalCategories: 25, offset: 20 });

  assert.equal(page.shown, 5);
  assert.equal(page.omitted, 0);
  assert.ok(!page.text.includes("more categories left"));
});

// El mismo caso del catálogo: veinticinco categorías con offset 30 no dejan fila, y una respuesta vacía no se distingue de
// una tool que no contestó. La línea nombra el total y el offset que sí muestra el catálogo.
test("formatCatalog: un offset más allá de la última categoría rinde una línea con el total y offset=0", () => {
  const page = formatCatalog({ categories: catalogCategories(25, 4), totalCategories: 25, offset: 30 });

  const lines = page.text.split("\n");
  assert.equal(lines.length, 1);
  assert.notEqual(page.text.trim(), "");
  assert.match(page.text, /past the end/);
  assert.match(page.text, / 25 categories/);
  assert.match(page.text, /offset=0/);
  assert.equal(page.shown, 0);
  assert.equal(page.omitted, 25);
});

// Una base recién creada no tiene ninguna categoría, y ese catálogo tampoco es la cadena vacía: dice qué hay y cuál es la
// tool que escribe la primera entrada.
test("formatCatalog: un catálogo sin categorías dice que la memoria está vacía y nombra memory_write", () => {
  const page = formatCatalog({ categories: [], totalCategories: 0, offset: 0 });

  const lines = page.text.split("\n");
  assert.equal(lines.length, 1);
  assert.notEqual(page.text.trim(), "");
  assert.match(page.text, /Nothing has been written/);
  assert.match(page.text, /memory_write/);
  assert.equal(page.shown, 0);
  assert.equal(page.omitted, 0);
});

// --- formatCount -----------------------------------------------------------------------------------------------------

// The total first, then one line per category with its count, in the order received.
test("formatCount: la primera línea es el total y después una línea por categoría", () => {
  const page = formatCount({
    total: 17,
    byCategory: [
      { category: "general", n: 12 },
      { category: "env", n: 5 },
    ],
  });

  assert.equal(page.text, "total: 17\ngeneral: 12\nenv: 5");
  assert.equal(page.shown, 2);
  assert.equal(page.omitted, 0);
});

// A vocabulary of two hundred categories does not fit 1500 characters, and the categories that fall outside are
// declared instead of disappearing.
test("formatCount: una lista larga queda bajo COUNT_CAP y declara las categorías fuera", () => {
  const byCategory = Array.from({ length: 200 }, (_, index) => ({ category: `categoria-${index + 1}`, n: index }));
  const page = formatCount({ total: 19900, byCategory });

  assert.ok(page.text.length <= COUNT_CAP);
  assert.ok(page.shown < 200);
  assert.equal(page.omitted, 200 - page.shown);
  assert.ok(page.text.startsWith("total: 19900\n"));
  assert.ok(page.text.endsWith(`... ${page.omitted} more categories left`));
});

// --- formatRead ------------------------------------------------------------------------------------------------------

// Criterion 7's cheap half: the largest text a write accepts is legible whole, with its header, inside the read cap.
test("formatRead: una entrada de 1800 caracteres vuelve entera dentro de READ_CAP", () => {
  const text = "x".repeat(1800);
  const page = formatRead({ rows: [readRow(7, text)], missing: [] });

  assert.ok(page.text.length <= READ_CAP);
  assert.ok(page.text.includes(text));
  assert.ok(!page.text.includes("characters omitted"));
  assert.equal(page.shown, 1);
  assert.equal(page.omitted, 0);
});

// Twenty ids of two hundred characters do not fit: the entries that survive are the first ones, and the two reasons an
// id brought no content keep to their own lines — the ids the cap dropped, then the ids that are not in the database.
test("formatRead: una petición de veinte ids separa los ids sin lugar de los ids inexistentes", () => {
  const rows = Array.from({ length: 20 }, (_, index) => readRow(index + 1, "y".repeat(200)));
  const page = formatRead({ rows, missing: [99, 100] });

  assert.ok(page.text.length <= READ_CAP);

  const lines = page.text.split("\n");
  const droppedIds = rows.slice(page.shown).map((row) => row.id).join(", ");
  assert.equal(lines[lines.length - 1], `... ids not shown: ${droppedIds}`);
  assert.equal(lines[lines.length - 2], "... not found: 99, 100");
  assert.ok(page.shown < 20);
  assert.equal(page.omitted, rows.length - page.shown);
});

// An id the database did not find is absent and not hidden: it is never counted as omitted, and it does not make the
// line that declares the cap look like it hid something.
test("formatRead: una petición de ids inexistentes rinde solo la línea not found", () => {
  const page = formatRead({ rows: [], missing: [9, 11] });

  assert.equal(page.text, "... not found: 9, 11");
  assert.ok(!page.text.includes("ids not shown"));
  assert.equal(page.shown, 0);
  assert.equal(page.omitted, 0);
});

// The same distinction with an entry that did come back: the header line, the text, then the one line that names what
// the database did not find.
test("formatRead: un id encontrado y dos inexistentes rinden la entrada y la línea not found", () => {
  const page = formatRead({ rows: [readRow(1, "hola")], missing: [9, 11] });

  assert.equal(page.text, "#1 2026-03-14 general\nhola\n... not found: 9, 11");
  assert.ok(!page.text.includes("ids not shown"));
  assert.equal(page.shown, 1);
  assert.equal(page.omitted, 0);
});

// A page the cap cut declares only what it cut, with the ids the render dropped, in the order it dropped them.
test("formatRead: una petición recortada por el cap rinde solo la línea ids not shown", () => {
  const rows = Array.from({ length: 5 }, (_, index) => readRow(index + 1, "w".repeat(900)));
  const page = formatRead({ rows, missing: [] });

  assert.ok(page.text.length <= READ_CAP);
  assert.ok(page.shown < 5);

  const lines = page.text.split("\n");
  const droppedIds = rows.slice(page.shown).map((row) => row.id).join(", ");
  assert.equal(lines[lines.length - 1], `... ids not shown: ${droppedIds}`);
  assert.ok(!page.text.includes("not found"));
  assert.equal(page.omitted, rows.length - page.shown);
});

// The header of a read is a line of its own, so it carries no trailing space: the exact line is asserted, because a
// substring match would tolerate the space that only an inline fragment has a use for.
test("formatRead: el encabezado de una entrada no lleva espacio final", () => {
  const page = formatRead({ rows: [readRow(3, "texto corto", "decision")], missing: [] });
  const lines = page.text.split("\n");

  assert.equal(lines[0], "#3 2026-03-14 decision");
  assert.equal(lines[0].length, rowPrefix({ id: 3, ts: TS, category: "decision" }).length - 1);
  assert.equal(page.text, "#3 2026-03-14 decision\ntexto corto");
});

// An entry that does not fit its remaining budget is rendered truncated, with the §7.0 marker on its own line and the
// number of characters it dropped.
test("formatRead: una entrada que no cabe se trunca con el marcador exacto", () => {
  const page = formatRead({ rows: [readRow(1, "y".repeat(1800)), readRow(2, "z".repeat(1800))], missing: [] });

  assert.ok(page.text.length <= READ_CAP);
  assert.match(page.text, /\[\.\.\. \d+ characters omitted, use memory_read\(ids\) with a smaller range\]/);
  assert.equal(page.shown, 2);
  assert.equal(page.omitted, 0);
});

// The entry that ends the page can also be too small a box for even one character; then its id joins the closing line
// with the ids of everything after it, so no requested id disappears from the answer.
test("formatRead: las entradas sin lugar se listan por id en la última línea", () => {
  const rows = Array.from({ length: 5 }, (_, index) => readRow(index + 1, "w".repeat(900)));
  const page = formatRead({ rows, missing: [] });

  assert.ok(page.text.length <= READ_CAP);

  const lines = page.text.split("\n");
  assert.ok(page.shown < 5);
  assert.ok(lines[lines.length - 1].startsWith("... ids not shown: "));
  assert.equal(page.omitted, 5 - page.shown);
});

// --- los caps, sobre entradas extremas -------------------------------------------------------------------------------

// The property every formatter shares: whatever comes in, the text stays inside the cap of its shape. The cases are the
// degenerate ones — nothing at all, a hundred rows, a category name longer than any catalog line should hold.
test("formatSearch: el texto nunca supera SEARCH_CAP en los casos extremos", () => {
  const cases = [
    { hits: [], total: 0, offset: 0, limit: 10 },
    { hits: searchRows(100, 300), total: 100, offset: 0, limit: 10 },
    { hits: searchRows(10, 300).map((row) => ({ ...row, category: "c".repeat(200) })), total: 10, offset: 0, limit: 10 },
    { hits: searchRows(3, 3), total: 500, offset: 490, limit: 10 },
  ];

  for (const input of cases) assert.ok(formatSearch(input).text.length <= SEARCH_CAP);
});

test("formatCatalog: el texto nunca supera CATALOG_CAP en los casos extremos", () => {
  const longCategory: CatalogCategory[] = [{ category: "c".repeat(200), n: 1, keys: [{ term: "t", id: 1 }] }];
  const widePage = catalogCategories(100, 4).map((category) => ({ ...category, category: "c".repeat(200) }));
  const cases = [
    { categories: [], totalCategories: 0, offset: 0 },
    { categories: catalogCategories(100, 4), totalCategories: 100, offset: 0 },
    { categories: widePage, totalCategories: 100, offset: 0 },
    { categories: longCategory, totalCategories: 1, offset: 0 },
  ];

  for (const input of cases) assert.ok(formatCatalog(input).text.length <= CATALOG_CAP);
});

test("formatCount: el texto nunca supera COUNT_CAP en los casos extremos", () => {
  const cases = [
    { total: 0, byCategory: [] },
    { total: 19900, byCategory: Array.from({ length: 100 }, (_, index) => ({ category: `categoria-${index}`, n: index })) },
    { total: 1, byCategory: [{ category: "c".repeat(200), n: 1 }] },
  ];

  for (const input of cases) assert.ok(formatCount(input).text.length <= COUNT_CAP);
});

test("formatRead: el texto nunca supera READ_CAP en los casos extremos", () => {
  const cases = [
    { rows: [], missing: [] },
    { rows: Array.from({ length: 100 }, (_, index) => readRow(index + 1, "w".repeat(100))), missing: [] },
    { rows: [readRow(1, "w".repeat(100), "c".repeat(200))], missing: [] },
    { rows: [readRow(1, "w".repeat(1800))], missing: [9, 11] },
  ];

  for (const input of cases) assert.ok(formatRead(input).text.length <= READ_CAP);
});
