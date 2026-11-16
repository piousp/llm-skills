import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CATALOG_CAP,
  CATALOG_PAGE,
  KEYS_PER_CATEGORY,
  MAX_RESULTS,
  MIN_SNIPPET,
  READ_CAP,
  SEARCH_CAP,
  allocate,
  clipAtWord,
  formatCatalog,
  formatIdList,
  formatRead,
  formatSearch,
  rowPrefix,
  shortDate,
} from "../../src/format.ts";
import type { CatalogCategory, ReadRow, SearchRow } from "../../src/format.ts";

// I1: the four output shapes, on their own. Every function of src/format.ts is a function of its arguments, so this
// suite is a list of rows and their expected text: a database would prove nothing the module does not do, because the
// module never sees one. The caps are asserted as caps (`text.length <= CAP`) and not as lengths, so an implementation
// that fills the budget differently still passes, and one that overflows fails under the name of the cap it broke.

const TS = "2026-03-14T09:26:53.589Z";

/** `count` search hits of one fixed date, each text `length` characters long and distinct from the next; the fragment is the text. */
function searchRows(count: number, length: number): SearchRow[] {
  return Array.from({ length: count }, (_, index) => {
    const text = `${String(index + 1).padStart(3, "0")}${"x".repeat(Math.max(0, length - 3))}`;
    return { id: index + 1, ts: TS, category: "general", text, fragment: text };
  });
}

/** The body of each rendered row: the line without its prefix. */
function bodiesOf(page: { text: string; shown: number }, hits: readonly SearchRow[]): string[] {
  return page.text
    .split("\n")
    .slice(0, page.shown)
    .map((line, index) => line.slice(rowPrefix(hits[index]).length));
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

// --- allocate y clipAtWord -------------------------------------------------------------------------------------------

test("allocate: si todo cabe cada fila recibe su longitud", () => {
  assert.deepEqual(allocate([10, 20, 30], 100), [10, 20, 30]);
});

test("allocate: las filas cortas quedan enteras y las largas se reparten lo que sobra", () => {
  assert.deepEqual(allocate([10, 100, 100], 110), [10, 50, 50]);
  assert.deepEqual(allocate([100, 10, 100], 110), [50, 10, 50]);
});

test("allocate: nunca reparte más que el room y un room negativo da ceros", () => {
  assert.ok(allocate([100, 100, 100], 100).reduce((a, b) => a + b, 0) <= 100);
  assert.deepEqual(allocate([5, 5], -3), [0, 0]);
  assert.deepEqual(allocate([], 10), []);
});

test("clipAtWord: un texto que cabe vuelve entero", () => {
  assert.equal(clipAtWord("hola mundo", 10), "hola mundo");
});

test("clipAtWord: corta en la última palabra que cabe y termina con elipsis", () => {
  assert.equal(clipAtWord("uno dos tres cuatro", 12), "uno dos…");
});

test("clipAtWord: sin espacio útil corta en seco y la elipsis cabe en max", () => {
  const clipped = clipAtWord("abcdefghijklmnop", 6);
  assert.equal(clipped, "abcde…");
  assert.equal(clipAtWord("abc", 0), "");
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

// Ten texts of 300 characters share the cap evenly: the page keeps every row, each clipped, and the tail declares the
// results left out and the offset that reaches them.
test("formatSearch: diez textos largos se reparten SEARCH_CAP y la cola declara el offset", () => {
  const hits = searchRows(10, 300);
  const page = formatSearch({ hits, total: 40, offset: 0, limit: 10 });

  assert.ok(page.text.length <= SEARCH_CAP);
  assert.equal(page.shown, MAX_RESULTS);
  for (const body of bodiesOf(page, hits)) {
    assert.ok(body.length >= MIN_SNIPPET && body.endsWith("…"));
  }

  const lines = page.text.split("\n");
  assert.equal(lines.length, page.shown + 1);
  assert.equal(lines[page.shown], `... ${page.omitted} more results left out; use offset=${page.shown}`);
  assert.equal(page.omitted, 40 - page.shown);
});

test("formatSearch: la nota va en la primera línea y cuenta dentro de SEARCH_CAP", () => {
  const note = "No entry has every word; showing entries with any of them.";
  const page = formatSearch({ hits: searchRows(10, 300), total: 40, offset: 0, limit: 10, note });

  assert.equal(page.text.split("\n")[0], note);
  assert.ok(page.text.length <= SEARCH_CAP);
  assert.equal(page.text.split("\n").length, page.shown + 2);
});

// The fragment of a row is cut to the budget and the row keeps its prefix, which is what lets the model read the id back.
test("formatSearch: el fragmento se corta al presupuesto y la fila conserva su prefijo", () => {
  const page = formatSearch({ hits: searchRows(3, 900), total: 3, offset: 0, limit: 3 });
  const [first] = page.text.split("\n");

  assert.ok(first.startsWith("#1 2026-03-14 general "));
  assert.ok(first.endsWith("…"));
  assert.ok(page.text.length <= SEARCH_CAP);
});

// An entry that fits its share comes back whole, on one line, with its whitespace collapsed.
test("formatSearch: un texto corto vuelve entero en una línea", () => {
  const hits = [{ ...searchRows(1, 10)[0], text: "uno\n  dos\ttres", fragment: "...dos..." }];
  const page = formatSearch({ hits, total: 1, offset: 0, limit: 5 });

  assert.equal(page.text, `${rowPrefix(hits[0])}uno dos tres`);
});

// The shares come from the whole cap, so short entries stay whole next to long ones that are clipped.
test("formatSearch: las entradas cortas quedan enteras junto a una larga recortada", () => {
  const hits = [...searchRows(2, 40), { ...searchRows(1, 1500)[0], id: 3 }];
  const page = formatSearch({ hits, total: 3, offset: 0, limit: 5 });
  const bodies = bodiesOf(page, hits);

  assert.equal(bodies[0], hits[0].text);
  assert.equal(bodies[1], hits[1].text);
  assert.ok(bodies[2].endsWith("…") && bodies[2].length > 600);
  assert.ok(page.text.length <= SEARCH_CAP);
});

// Whatever the sizes, the page fits the cap, keeps its rows consistent with `shown` and returns whole whatever fits.
test("formatSearch: fixtures aleatorias nunca superan SEARCH_CAP", () => {
  let seed = 12345;
  const random = (max: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % max;
  };

  for (let round = 0; round < 300; round += 1) {
    const count = 1 + random(12);
    const hits = Array.from({ length: count }, (): SearchRow => {
      const text = "palabra ".repeat(random(250)).trim() || "x";
      return { id: 1 + random(99999), ts: TS, category: "c".repeat(1 + random(60)), text, fragment: text.slice(0, 1 + random(240)) };
    });
    const note = random(2) === 0 ? undefined : "n".repeat(random(80));
    const page = formatSearch({ hits, total: count + random(30), offset: random(20), limit: 1 + random(12), note });

    assert.ok(page.text.length <= SEARCH_CAP, `ronda ${round}: ${page.text.length} caracteres`);
    assert.ok(page.shown >= 1 && page.shown <= MAX_RESULTS);
  }
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

// Un prefijo fijo de 68 y 69 caracteres deja 10 por fila en una página de diez filas, por debajo de MIN_SNIPPET, así que la
// página baja a nueve filas, donde cada cuerpo supera el mínimo.
test("formatSearch: diez filas de prefijo largo bajan a nueve por MIN_SNIPPET", () => {
  const category = "c".repeat(53);
  const hits = searchRows(10, 300).map((row) => ({ ...row, category }));
  const page = formatSearch({ hits, total: 10, offset: 0, limit: 10 });

  assert.equal(page.shown, 9);
  assert.equal(page.omitted, 1);
  assert.ok(page.text.length <= SEARCH_CAP);
  for (const body of bodiesOf(page, hits)) {
    assert.ok(body.length >= MIN_SNIPPET);
  }
});

// Bajar una fila reparte el room entre menos filas: cada cuerpo de la página recortada es más ancho que el de la página
// completa de las mismas filas.
test("formatSearch: bajar una fila ensancha los cuerpos", () => {
  const category = "c".repeat(53);
  const hits = searchRows(10, 300).map((row) => ({ ...row, category }));
  const nine = formatSearch({ hits: hits.slice(0, 9), total: 9, offset: 0, limit: 9 });
  const eight = formatSearch({ hits: hits.slice(0, 8), total: 8, offset: 0, limit: 8 });

  assert.ok(bodiesOf(eight, hits)[0].length > bodiesOf(nine, hits)[0].length);
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
  assert.equal(lines.filter((line) => !line.startsWith("...")).length, CATALOG_PAGE);
  assert.equal(lines[lines.length - 1], "... 5 more categories left; use offset=20");
  assert.equal(page.omitted, 5);
});

// El segundo ajuste puede tener que correr más de una vez. Con categorías de 80 caracteres, la página de veinte
// filas y la de diecinueve se pasan de CATALOG_CAP y la de dieciocho entra: la página baja dos filas y no una, que es lo
// que distingue un ajuste que itera de uno que resta una sola vez.
test("formatCatalog: un cap que exige dos reducciones baja la página dos filas", () => {
  const categories: CatalogCategory[] = Array.from({ length: 25 }, () => ({
    category: "c".repeat(71),
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

  assert.equal(page.text, "religion (12): t1:1, t2:2, t3:3, t4:4");
  assert.equal(page.text.split(", ").length, KEYS_PER_CATEGORY);
});

// A category the model has never used is still a category: the count is printed and the colon has nothing after it.
test("formatCatalog: una categoría sin claves termina en dos puntos", () => {
  const page = formatCatalog({ categories: [{ category: "env", n: 2, keys: [] }], totalCategories: 1, offset: 0 });

  assert.equal(page.text, "env (2):");
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

// An entry that does not fit its remaining budget is rendered truncated, with the marker on its own line and the
// number of characters it dropped.
test("formatRead: una entrada que no cabe se trunca con el marcador exacto", () => {
  const page = formatRead({ rows: [readRow(1, "y".repeat(1800)), readRow(2, "z".repeat(1800))], missing: [] });

  assert.ok(page.text.length <= READ_CAP);
  assert.match(page.text, /\[\.\.\. \d+ characters omitted; read fewer ids at once\]/);
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

test("formatRead: el texto nunca supera READ_CAP en los casos extremos", () => {
  const cases = [
    { rows: [], missing: [] },
    { rows: Array.from({ length: 100 }, (_, index) => readRow(index + 1, "w".repeat(100))), missing: [] },
    { rows: [readRow(1, "w".repeat(100), "c".repeat(200))], missing: [] },
    { rows: [readRow(1, "w".repeat(1800))], missing: [9, 11] },
  ];

  for (const input of cases) assert.ok(formatRead(input).text.length <= READ_CAP);
});
