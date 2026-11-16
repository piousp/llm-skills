import { test } from "node:test";
import assert from "node:assert/strict";
import { distinctSlugs, fromTerms, mergeKeys, normalizeTextForDuplicate, quoteToken, toMatchTerm, toSlug, toTerms, toTokens } from "../../src/query.ts";

// I1: the pure surface of the index, on its own. Every function of src/query.ts is a function of its argument, so this
// suite is a list of inputs and their expected output and it reads no file: a fixture on disk would prove something the
// module does not do. There is one test per behaviour, so a change that drops a rule fails here under the name of the
// rule it dropped.

// --- toTokens -------------------------------------------------------------------------------------------------------

// The diacritics of an accented word leave the token, which is what lets "cancion" and "canción" meet in the index.
test("toTokens: los acentos se quitan del token", () => {
  assert.deepEqual(toTokens("canción"), ["cancion"]);
});

// An emoji is not a letter and not a number, so it separates two tokens and contributes none.
test("toTokens: el emoji se descarta", () => {
  assert.deepEqual(toTokens("hola 🎉 mundo"), ["hola", "mundo"]);
});

// The cap is the whole point: a query of a hundred tokens is a query FTS5 answers badly, so the first sixteen survive
// and the position of the cut is what the test fixes.
test("toTokens: una entrada de veinte palabras se corta en las primeras dieciséis", () => {
  const twenty = Array.from({ length: 20 }, (_, index) => `palabra${index + 1}`).join(" ");

  assert.deepEqual(
    toTokens(twenty),
    Array.from({ length: 16 }, (_, index) => `palabra${index + 1}`),
  );
});

// The two degenerate inputs: nothing and punctuation only. Both answer an empty list instead of throwing, because a
// memory is nobody's validated form.
test("toTokens: la cadena vacía no produce tokens", () => {
  assert.deepEqual(toTokens(""), []);
});

test("toTokens: la puntuación sola no produce tokens", () => {
  assert.deepEqual(toTokens(")("), []);
});

// --- quoteToken -----------------------------------------------------------------------------------------------------

// A double quote inside a term is written twice, which is how FTS5 reads a quote that belongs to the term and not to the
// quoting around it: the quoter and the production `MATCH` expression of src/db.ts now agree on this one rule.
test("quoteToken: una comilla embebida se duplica dentro del término entre comillas", () => {
  assert.equal(quoteToken('a"b'), '"a""b"');
});

// The plain case, which is every token `toTokens` produces today: the word between two quotes and nothing else.
test("quoteToken: un token simple vuelve entre comillas", () => {
  assert.equal(quoteToken("word"), '"word"');
});

// The AND of the contract is the space the caller joins with: three quoted terms keep one space between them and none
// inside any of them, so the expression cannot grow a second separator.
test("quoteToken: tres tokens unidos por un espacio quedan con un solo espacio entre términos", () => {
  const joined = ["a", "b", "c"].map(quoteToken).join(" ");

  assert.equal(joined, '"a" "b" "c"');
  assert.equal(joined.split(" ").length, 3);
});

// --- toSlug ---------------------------------------------------------------------------------------------------------

test("toSlug: las palabras separadas por un espacio se unen con un guion", () => {
  assert.equal(toSlug("Sola Scriptura"), "sola-scriptura");
});

// A run of punctuation and spaces is one separator, never two hyphens in a row.
test("toSlug: la puntuación repetida colapsa en un solo guion", () => {
  assert.equal(toSlug("sola---scriptura!!!"), "sola-scriptura");
});

test("toSlug: la puntuación de los extremos se recorta", () => {
  assert.equal(toSlug("  --sola-  "), "sola");
});

// The cut falls on the 32nd character and can fall inside a separator, so the trim after it is what keeps the slug from
// ending in a hyphen: the input is 40 characters and the 32nd is one.
test("toSlug: un slug largo se corta en 32 caracteres sin terminar en guion", () => {
  const long = `${"a".repeat(31)}-bbbbbbbb`;
  const slug = toSlug(long);

  assert.equal(long.length, 40);
  assert.equal(slug, "a".repeat(31));
  assert.ok(slug.length <= 32);
  assert.ok(!slug.endsWith("-"));
});

// Nothing alphanumeric survives the collapses, so the answer is the empty slug the caller drops.
test("toSlug: el espacio en blanco solo produce la cadena vacía", () => {
  assert.equal(toSlug("  "), "");
});

// The controlled vocabulary is ASCII: the slug of an accented word is the same slug as the unaccented one.
test("toSlug: los acentos se quitan igual que en los tokens", () => {
  assert.equal(toSlug("Canción"), "cancion");
});

// --- normalizeTextForDuplicate --------------------------------------------------------------------------------------

// NFKC and not NFKD: the ligature is a compatibility character and folding it is what makes two memories that print
// differently compare equal.
test("normalizeTextForDuplicate: la ligadura se despliega por compatibilidad", () => {
  assert.equal(normalizeTextForDuplicate("ﬁ"), "fi");
});

test("normalizeTextForDuplicate: el espacio interno colapsa en uno solo", () => {
  assert.equal(normalizeTextForDuplicate("  dos   palabras \n\t sueltas  "), "dos palabras sueltas");
});

test("normalizeTextForDuplicate: la caja se pliega y los extremos se recortan", () => {
  assert.equal(normalizeTextForDuplicate("  Hola Mundo  "), "hola mundo");
});

// --- toTerms --------------------------------------------------------------------------------------------------------

// Two keys that slug to the same term are one term, and the order is the order of the first appearance.
test("toTerms: los duplicados se quitan en el orden de la primera aparición", () => {
  assert.equal(toTerms(["Sola Scriptura", "sola  scriptura", "Gracia"]), "sola-scriptura gracia");
});

// A key that slugs to nothing is not a term: the empty slug would join two spaces and look like a term of its own.
test("toTerms: los slugs vacíos se descartan", () => {
  assert.equal(toTerms(["!!", "Fe", "  "]), "fe");
});

test("toTerms: los términos se unen con un solo espacio", () => {
  assert.equal(toTerms(["Gracia", "Fe"]), "gracia fe");
});

// The empty list is the empty column and not an exception.
test("toTerms: la lista vacía produce la cadena vacía", () => {
  assert.equal(toTerms([]), "");
});

// --- distinctSlugs ---------------------------------------------------------------------------------------------------

// The rule `toTerms` joins, on its own: two keys that slug to the same term are one slug, and the order is the order of
// the first appearance.
test("distinctSlugs: los duplicados se quitan en el orden de la primera aparición", () => {
  assert.deepEqual(distinctSlugs(["Sola Scriptura", "sola  scriptura", "Gracia"]), ["sola-scriptura", "gracia"]);
});

// A key that slugs to nothing is not a slug: it would be an empty term between two spaces, and the caller that writes
// the keys table would insert an empty term.
test("distinctSlugs: una clave que normaliza a la cadena vacía se descarta", () => {
  assert.deepEqual(distinctSlugs(["!!", "Fe", "  "]), ["fe"]);
});

// The empty list is the empty list and not an exception.
test("distinctSlugs: la lista vacía produce una lista vacía", () => {
  assert.deepEqual(distinctSlugs([]), []);
});

test("toMatchTerm: prefijo desde tres caracteres, el token corto queda exacto", () => {
  assert.equal(toMatchTerm("deploy"), '"deploy"*');
  assert.equal(toMatchTerm("abc"), '"abc"*');
  assert.equal(toMatchTerm("ab"), '"ab"');
});

// --- fromTerms ------------------------------------------------------------------------------------------------------

test("fromTerms: la cadena vacía no tiene términos", () => {
  assert.deepEqual(fromTerms(""), []);
});

test("fromTerms: separa por espacios", () => {
  assert.deepEqual(fromTerms("a b"), ["a", "b"]);
});

// --- mergeKeys ------------------------------------------------------------------------------------------------------

test("mergeKeys: con espacio para todas, las nuevas se añaden tras las existentes", () => {
  assert.deepEqual(mergeKeys(["a"], ["B", "c"], 8), { addedKeys: ["b", "c"], droppedKeys: [], terms: "a b c" });
});

test("mergeKeys: con espacio parcial corta en max y informa las sobrantes", () => {
  assert.deepEqual(mergeKeys(["a"], ["b", "c", "d"], 2), { addedKeys: ["b"], droppedKeys: ["c", "d"], terms: "a b" });
});

test("mergeKeys: con la entrada llena no añade nada", () => {
  assert.deepEqual(mergeKeys(["a", "b"], ["c"], 2), { addedKeys: [], droppedKeys: ["c"], terms: "a b" });
});

test("mergeKeys: con más existentes que max el espacio es 0 y todas se descartan", () => {
  assert.deepEqual(mergeKeys(["a", "b", "c"], ["d", "e"], 2), { addedKeys: [], droppedKeys: ["d", "e"], terms: "a b c" });
});

test("mergeKeys: sin existentes (inserción) también aplica el tope", () => {
  assert.deepEqual(mergeKeys([], ["a", "b", "c"], 2), { addedKeys: ["a", "b"], droppedKeys: ["c"], terms: "a b" });
});

test("mergeKeys: descarta slugs vacíos y repeticiones, y las que ya existen, en orden de primera aparición", () => {
  assert.deepEqual(mergeKeys(["x"], ["!!", "Fe", "fe", "X", "Gracia"], 8), {
    addedKeys: ["fe", "gracia"],
    droppedKeys: [],
    terms: "x fe gracia",
  });
});
