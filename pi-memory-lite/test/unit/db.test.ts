import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import {
  CURRENT_SCHEMA_VERSION,
  openStore,
  runMigrations,
  type DatabaseFactory,
  type MemoryStore,
  type NodeSqliteModule,
  type SearchInput,
  type SqlDatabase,
  type WriteInput,
} from "../../src/db.ts";
import { KEYS_PER_CATEGORY } from "../../src/format.ts";

// I1: the schema, the migrations and the query layer against a real SQLite file, one temporary directory per test. This
// is the module that decides whether the memory survives a reopen, whether a duplicate is refused, whether a key that
// the text does not contain still finds its entry, and whether a database written without FTS5 becomes visible again
// when FTS5 is back: all of those are facts about a file, so a fixture in memory would prove nothing. There is one test
// per rule of §6, §7 and §8.8, so a rule that is dropped fails here under the name of the rule it dropped.

/** The real module for the degraded seam: the wrapper has to delegate everything except the FTS5 schema. */
const SQLITE = (await import("node:sqlite")) as unknown as NodeSqliteModule;

/** The stamp of most fixtures. The catalog test is the one that needs two different dates. */
const TS = "2026-01-01T00:00:00Z";

/** A temporary directory that the test removes afterwards, never a fixed one shared between tests. */
function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(realpathSync(os.tmpdir()), "pi-memory-lite-db-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A write input with the defaults the tests do not care about filled in. */
function entry(text: string, category = "general", keys: string[] = [], ts = TS): WriteInput {
  return { text, category, keys, ts };
}

/** A search input; `limit` of 10 is above every fixture, so the page is the whole answer unless a test says otherwise. */
function searchInput(tokens: string[], category: string | null = null, limit = 10, offset = 0): SearchInput {
  return { tokens, category, limit, offset };
}

/**
 * A Node build without FTS5, from the outside: the only thing that fails is the `CREATE VIRTUAL TABLE` of the probe, so
 * the store takes the degraded path of §8.5 and everything else runs against the real database file.
 */
function degradedFactory(): DatabaseFactory {
  return (dbPath: string): SqlDatabase => {
    const inner = new SQLITE.DatabaseSync(dbPath);
    return {
      exec: (sql: string): void => {
        if (/create\s+virtual\s+table/i.test(sql)) throw new Error("no such module: fts5");
        inner.exec(sql);
      },
      prepare: (sql: string) => inner.prepare(sql),
      close: (): void => inner.close(),
    };
  };
}

/** A `meta` value through the store's own connection, which is the seam the store exposes for exactly this. */
function readMetaValue(store: MemoryStore, key: string): string | null {
  const row = store.db.prepare("SELECT value FROM meta WHERE key = ?1").get(key);
  return row === undefined ? null : String(row.value);
}

/** The `n` of a `COUNT(*) AS n` statement, for the tests that count rows of a table they do not read otherwise. */
function count(store: MemoryStore, sql: string): number {
  const row = store.db.prepare(sql).get();
  return row === undefined ? 0 : Number(row.n);
}

/** Every name of one kind in the schema, sorted so a failure lists a stable set. */
function schemaNames(store: MemoryStore, type: string): string[] {
  return store.db
    .prepare("SELECT name FROM sqlite_master WHERE type = ?1 ORDER BY name")
    .all(type)
    .map((row) => String(row.name));
}

// --- schema ---------------------------------------------------------------------------------------------------------

// §6.1: the five objects the block creates are there after the first open, the index is a real FTS5 table and not a plain
// table with the same name, and the three triggers of the external content are attached to `entries`.
test("esquema: las tablas, los índices y los tres triggers del índice existen tras abrir", async (t) => {
  const dir = tempDir(t);
  const store = await openStore({ dir });
  t.after(() => store.close());

  const tables = schemaNames(store, "table");
  for (const table of ["meta", "entries", "keys", "entries_fts"]) {
    assert.ok(tables.includes(table), `falta la tabla ${table}`);
  }
  // Una tabla virtual de FTS5 crea las suyas: sin ellas `entries_fts` sería una tabla normal y `MATCH` no existiría.
  assert.ok(tables.includes("entries_fts_data"), "entries_fts no es una tabla virtual de FTS5");

  const triggers = schemaNames(store, "trigger");
  for (const trigger of ["entries_ai", "entries_ad", "entries_au"]) {
    assert.ok(triggers.includes(trigger), `falta el trigger ${trigger}`);
  }

  const indexes = schemaNames(store, "index");
  assert.ok(indexes.includes("entries_category"), "falta el índice entries_category");
  assert.ok(indexes.includes("keys_term"), "falta el índice keys_term");
});

// Abrir el mismo directorio otra vez no recrea nada ni pierde nada: es el caso normal, la segunda sesión de pi.
test("esquema: abrir el mismo directorio dos veces es idempotente", async (t) => {
  const dir = tempDir(t);
  const first = await openStore({ dir });
  const written = first.write(entry("La memoria sobrevive a la reapertura.", "general", ["reapertura"]));
  first.close();

  const second = await openStore({ dir });
  t.after(() => second.close());

  assert.equal(second.fts, true);
  assert.equal(second.read([written.id]).found.length, 1);
  assert.deepEqual(
    second.search(searchInput(["reapertura"])).map((hit) => hit.id),
    [written.id],
  );
});

// §6.2: la versión la escribe el esquema inicial, dentro de la misma transacción, y es la que conoce este build.
test("migraciones: schema_version es 1 tras la primera apertura", async (t) => {
  const dir = tempDir(t);
  const store = await openStore({ dir });
  t.after(() => store.close());

  assert.equal(CURRENT_SCHEMA_VERSION, 1);
  assert.equal(readMetaValue(store, "schema_version"), "1");
});

// §6.2: una base escrita por un build más nuevo no se toca ni se degrada en silencio; el error nombra la versión que
// encontró, porque el usuario tiene que leer qué actualizar.
test("migraciones: una versión mayor que la actual lanza un error que nombra la versión", async (t) => {
  const dir = tempDir(t);
  const store = await openStore({ dir });
  store.db
    .prepare("INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run("schema_version", "2");
  store.close();

  await assert.rejects(openStore({ dir }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /newer version of pi-memory-lite/);
    assert.match(error.message, /schema version 2/);
    return true;
  });
});

// Criterio 11: `CREATE TABLE IF NOT EXISTS` no muta una tabla existente, así que una migración que agrega una columna
// usa `ALTER TABLE` y tiene que aplicarse sobre una base que ya tiene datos.
test("migraciones: una migración con ALTER TABLE aplica sobre una base existente y devuelve 2", async (t) => {
  const dir = tempDir(t);
  const store = await openStore({ dir });
  t.after(() => store.close());
  const written = store.write(entry("Una entrada anterior a la migración.", "general", ["migracion"]));

  const applied = runMigrations(store.db, 2, [
    { version: 2, up: (db) => db.exec("ALTER TABLE entries ADD COLUMN note TEXT") },
  ]);

  assert.equal(applied, 2);
  assert.equal(readMetaValue(store, "schema_version"), "2");

  const columns = store.db
    .prepare("PRAGMA table_info(entries)")
    .all()
    .map((row) => String(row.name));
  assert.ok(columns.includes("note"), "la columna de la migración no quedó en la tabla");
  assert.equal(store.read([written.id]).found.length, 1);
});

// §8.7: el timeout se aplica al abrir, antes de cualquier `BEGIN`, y es el que evita `SQLITE_BUSY` entre dos sesiones.
test("apertura: busy_timeout es 5000", async (t) => {
  const dir = tempDir(t);
  const store = await openStore({ dir });
  t.after(() => store.close());

  const row = store.db.prepare("PRAGMA busy_timeout").get();
  assert.equal(Number(row?.timeout), 5000);
});

/**
 * El `SQLITE_BUSY` de §8.7 sin depender del tiempo: el único statement que falla es el primer `PRAGMA journal_mode = WAL`
 * de la conexión, con el `errcode` que SQLite reporta para ese error. El contador es lo que prueba que el reintento
 * ocurrió, porque el segundo intento llega al motor real y sí cambia el modo del archivo.
 */
function busyOnceFactory(counter: { wal: number }): DatabaseFactory {
  return (dbPath: string): SqlDatabase => {
    const inner = new SQLITE.DatabaseSync(dbPath);
    return {
      exec: (sql: string): void => {
        if (/journal_mode\s*=\s*wal/i.test(sql)) {
          counter.wal += 1;
          if (counter.wal === 1) throw Object.assign(new Error("database is locked"), { errcode: 5 });
        }
        inner.exec(sql);
      },
      prepare: (sql: string) => inner.prepare(sql),
      close: (): void => inner.close(),
    };
  };
}

// §8.7 y criterio 8: el reintento del PRAGMA de WAL, provocado a propósito y no por una carrera entre dos procesos. Un
// solo `SQLITE_BUSY` en el primer intento tiene que costar un reintento y no la apertura, y la conexión tiene que quedar
// usable y en WAL: sin el reintento este test falla con el error del motor, que es el camino que la suite de concurrencia
// solo reproduce cada tantas corridas.
test("apertura: un SQLITE_BUSY en el PRAGMA de WAL se reintenta y la apertura resuelve", async (t) => {
  const dir = tempDir(t);
  const counter = { wal: 0 };
  const store = await openStore({ dir }, busyOnceFactory(counter));
  t.after(() => store.close());

  assert.equal(counter.wal, 2, "el PRAGMA de WAL tiene que haberse ejecutado dos veces: el primer intento falló");

  // La conexión quedó usable y en WAL: el segundo intento llegó al motor y cambió el modo del archivo.
  const mode = store.db.prepare("PRAGMA journal_mode").get();
  assert.equal(String(mode?.journal_mode).toLowerCase(), "wal");

  const written = store.write(entry("La memoria se abre después de un busy.", "env", ["busy"]));
  assert.equal(store.read([written.id]).found[0].text, "La memoria se abre después de un busy.");
  assert.deepEqual(
    store.search(searchInput(["busy"])).map((hit) => hit.id),
    [written.id],
  );
});

// --- write, search, read, remove ------------------------------------------------------------------------------------

// El camino completo de §7.1 a §7.4: lo escrito se busca, se lee entero y se borra, y el borrado se lleva las `keys` por
// la cascada de la llave foránea.
test("escritura, búsqueda, lectura y borrado: ida y vuelta con cascada de keys", async (t) => {
  const dir = tempDir(t);
  const store = await openStore({ dir });
  t.after(() => store.close());

  const written = store.write(entry("El router usa el firmware flint2.", "env", ["router", "flint2"]));
  assert.equal(written.duplicate, false);
  assert.ok(written.id > 0);

  const hits = store.search(searchInput(["router"]));
  assert.deepEqual(
    hits.map((hit) => hit.id),
    [written.id],
  );
  assert.ok(hits[0].fragment.length > 0, "la búsqueda devolvió un fragmento vacío");

  const read = store.read([written.id]);
  assert.equal(read.found.length, 1);
  assert.equal(read.found[0].id, written.id);
  assert.equal(read.found[0].ts, TS);
  assert.equal(read.found[0].category, "env");
  assert.equal(read.found[0].text, "El router usa el firmware flint2.");
  assert.equal(read.found[0].terms, "router flint2");
  assert.deepEqual(read.missing, []);

  assert.equal(count(store, "SELECT COUNT(*) AS n FROM keys"), 2);

  const removed = store.remove([written.id]);
  assert.deepEqual(removed.deleted, [written.id]);
  assert.deepEqual(removed.missing, []);

  assert.equal(count(store, "SELECT COUNT(*) AS n FROM entries"), 0);
  assert.equal(count(store, "SELECT COUNT(*) AS n FROM keys"), 0);
  assert.deepEqual(store.read([written.id]), { found: [], missing: [written.id] });
});

// D17: el duplicado se detecta sobre el texto normalizado, y la segunda escritura no escribe nada ni inventa un id.
test("duplicados: el mismo texto con otro espaciado y otra caja devuelve el id original", async (t) => {
  const dir = tempDir(t);
  const store = await openStore({ dir });
  t.after(() => store.close());

  const first = store.write(entry("Hola   Mundo\n", "general", ["saludo"]));
  const again = store.write(entry("  hola mundo  ", "general", ["saludo"]));

  assert.equal(first.duplicate, false);
  assert.equal(again.duplicate, true);
  assert.equal(again.id, first.id);
  assert.equal(count(store, "SELECT COUNT(*) AS n FROM entries"), 1);
  assert.equal(count(store, "SELECT COUNT(*) AS n FROM keys"), 1);
});

// Criterio 4: la palabra no está en el texto, así que lo único que puede encontrar la entrada es el vocabulario que
// declara la escritura; el índice de FTS5 lo tiene porque la columna `terms` está indexada.
test("criterio 4: una key que el texto no contiene encuentra la entrada por FTS5", async (t) => {
  const dir = tempDir(t);
  const store = await openStore({ dir });
  t.after(() => store.close());

  const text = "El concilio de Nicea definió el homoousios.";
  const written = store.write(entry(text, "religion", ["trinidad"]));
  assert.ok(!text.toLowerCase().includes("trinidad"), "el texto del fixture contiene la palabra que se busca");

  const hits = store.search(searchInput(["trinidad"]));
  assert.deepEqual(
    hits.map((hit) => hit.id),
    [written.id],
  );
  assert.equal(store.countSearch({ tokens: ["trinidad"], category: null }), 1);
});

// §7.2 con y sin `category`: la misma consulta tiene que devolver los placeholders numerados ?1..?4 en el orden en que
// se vinculan, porque `?2 IS NULL` es la forma de decir "todas las categorías" sin una segunda consulta.
test("búsqueda: los placeholders numerados funcionan con y sin category", async (t) => {
  const dir = tempDir(t);
  const store = await openStore({ dir });
  t.after(() => store.close());

  const religion = store.write(entry("El concilio de Nicea definió el homoousios.", "religion", ["nicea"], TS));
  const env = store.write(entry("El concilio revisó el router.", "env", ["router"], "2026-01-02T00:00:00Z"));

  assert.deepEqual(
    store
      .search(searchInput(["concilio"]))
      .map((hit) => hit.id)
      .sort(),
    [religion.id, env.id].sort(),
  );
  assert.deepEqual(
    store.search(searchInput(["concilio"], "env")).map((hit) => hit.id),
    [env.id],
  );
  assert.deepEqual(
    store.search(searchInput(["concilio"], "religion")).map((hit) => hit.id),
    [religion.id],
  );
  assert.deepEqual(store.search(searchInput(["concilio"], "general")), []);

  assert.equal(store.countSearch({ tokens: ["concilio"], category: null }), 2);
  assert.equal(store.countSearch({ tokens: ["concilio"], category: "env" }), 1);

  // `limit` y `offset` son los otros dos placeholders numerados: dos páginas de uno no repiten fila.
  const firstPage = store.search(searchInput(["concilio"], null, 1, 0));
  const secondPage = store.search(searchInput(["concilio"], null, 1, 1));
  assert.equal(firstPage.length, 1);
  assert.equal(secondPage.length, 1);
  assert.notEqual(firstPage[0].id, secondPage[0].id);

  // La lectura conserva el orden pedido, no el de la tabla.
  assert.deepEqual(
    store.read([env.id, religion.id]).found.map((row) => row.id),
    [env.id, religion.id],
  );
});

// §7.2: el catálogo ordena las categorías por cantidad, los términos por uso, y cada término lleva el id de la entrada
// más reciente de esa categoría, que es la fecha y no el id más alto.
test("catálogo: dos categorías, keys ordenadas por uso y el id más reciente por término", async (t) => {
  const dir = tempDir(t);
  const store = await openStore({ dir });
  t.after(() => store.close());

  const newest = store.write(
    entry("El concilio de Nicea definió el homoousios.", "religion", ["trinidad", "nicea"], "2026-01-02T00:00:00Z"),
  );
  store.write(entry("El credo atanasiano y el filioque.", "religion", ["trinidad"], "2026-01-01T00:00:00Z"));
  const env = store.write(entry("El router usa el firmware flint2.", "env", ["router"], "2026-01-03T00:00:00Z"));

  const page = store.catalog();
  // El store no devuelve datos derivados: ni el total ni el offset, que son la cantidad de categorías y el de la llamada.
  assert.deepEqual(Object.keys(page), ["categories"]);
  assert.equal(page.categories.length, 2);
  assert.deepEqual(
    page.categories.map((category) => [category.category, category.n]),
    [
      ["religion", 2],
      ["env", 1],
    ],
  );

  // "trinidad" se declaró dos veces y "nicea" una, así que va primero; y el id de "trinidad" es el de la entrada del
  // 2 de enero aunque la del 1 de enero tenga el id más alto.
  assert.deepEqual(page.categories[0].keys, [
    { term: "trinidad", id: newest.id },
    { term: "nicea", id: newest.id },
  ]);
  assert.deepEqual(page.categories[1].keys, [{ term: "router", id: env.id }]);
});

// §7.2: el catálogo lista como mucho KEYS_PER_CATEGORY keys por categoría, y la sentencia del catálogo es la que las
// acota. El fixture de arriba declara dos keys en `religion`, así que ensanchar el cap del SQL no movería nada; este
// reparte cinco keys con usos distintos en una sola categoría y comprueba que vuelvan cuatro.
test("catálogo: una categoría con cinco keys devuelve solo las cuatro más usadas", async (t) => {
  const dir = tempDir(t);
  const store = await openStore({ dir });
  t.after(() => store.close());

  // Tres entradas reparten las cinco keys con usos distintos: alfa 3, beta 2, gamma 2, delta 1, epsilon 1. Así el
  // recorte lo decide el uso y no el alfabeto: epsilon cae aunque vaya antes que gamma.
  store.write(entry("La nota del primer reparto.", "general", ["alfa", "beta", "gamma"]));
  store.write(entry("La nota del segundo reparto.", "general", ["alfa", "beta", "delta"]));
  store.write(entry("La nota del tercer reparto.", "general", ["alfa", "gamma", "epsilon"]));

  const keys = store.catalog().categories[0].keys;
  assert.equal(keys.length, KEYS_PER_CATEGORY);
  assert.deepEqual(
    keys.map((key) => key.term),
    ["alfa", "beta", "gamma", "delta"],
  );
});

// --- degradación sin FTS5 -------------------------------------------------------------------------------------------

// Criterio 9: sin FTS5 las cuatro operaciones responden, la búsqueda sigue distinguiendo categorías y sigue encontrando
// por vocabulario, porque el `LIKE` mira `text` y `terms`.
test("degradación: sin FTS5 las cuatro operaciones siguen funcionando", async (t) => {
  const dir = tempDir(t);
  const store = await openStore({ dir }, degradedFactory());
  t.after(() => store.close());

  assert.equal(store.fts, false);
  assert.equal(readMetaValue(store, "fts_disabled"), "1");

  const religion = store.write(entry("El concilio de Nicea definió el homoousios.", "religion", ["trinidad"], TS));
  const env = store.write(entry("El router usa el firmware flint2.", "env", ["router"], "2026-01-02T00:00:00Z"));

  // Escritura: el duplicado también se detecta sin índice.
  assert.equal(
    store.write(entry("  el concilio de nicea definió el homoousios. ", "religion", ["trinidad"])).id,
    religion.id,
  );

  // Búsqueda: por vocabulario, con y sin categoría, y por texto.
  assert.deepEqual(
    store.search(searchInput(["trinidad"])).map((hit) => hit.id),
    [religion.id],
  );
  assert.deepEqual(store.search(searchInput(["trinidad"], "env")), []);
  assert.deepEqual(
    store.search(searchInput(["router"], "env")).map((hit) => hit.id),
    [env.id],
  );
  assert.equal(store.countSearch({ tokens: ["concilio"], category: null }), 1);

  // Catálogo, lectura y borrado.
  assert.equal(store.catalog().categories.length, 2);
  assert.equal(store.read([env.id]).found[0].text, "El router usa el firmware flint2.");
  assert.deepEqual(store.remove([env.id]).deleted, [env.id]);
  assert.equal(store.read([env.id]).missing[0], env.id);
});

// §8.5: el `%` y el `_` de un token son caracteres y no comodines; sin el `ESCAPE` el primero encontraría de más.
test("degradación: los comodines del token se escapan en el LIKE", async (t) => {
  const dir = tempDir(t);
  const store = await openStore({ dir }, degradedFactory());
  t.after(() => store.close());

  const percent = store.write(entry("El enlace va al 100% del ancho.", "env", ["ancho"]));
  store.write(entry("El enlace va al 100X del ancho.", "env", ["ancho"]));

  assert.deepEqual(
    store.search(searchInput(["100%"])).map((hit) => hit.id),
    [percent.id],
  );
  assert.equal(store.countSearch({ tokens: ["100%"], category: null }), 1);
});

// §8.5 y §8.8: un archivo que ya abrió un build con FTS5 conserva los tres triggers del external content, y en una
// conexión sin el módulo cada `INSERT` y cada `DELETE` sobre `entries` los dispara y falla con "no such module: fts5":
// perder el ranking no puede costar la escritura y el borrado. Abrir sin FTS5 los retira antes de escribir la marca, y la
// siguiente apertura con FTS5 los recrea y reconstruye el índice.
test("degradación: un archivo indexado por FTS5 se escribe y se borra sin FTS5", async (t) => {
  const dir = tempDir(t);
  const indexed = await openStore({ dir });
  const before = indexed.write(entry("El concilio de Nicea definió el homoousios.", "religion", ["trinidad"]));
  indexed.close();

  // Closed by hand below and not by an `after` hook: the same store would be closed twice.
  const degraded = await openStore({ dir }, degradedFactory());
  assert.equal(degraded.fts, false);
  assert.equal(readMetaValue(degraded, "fts_disabled"), "1");
  assert.deepEqual(schemaNames(degraded, "trigger"), [], "los triggers del índice siguen en la base sin FTS5");

  // La escritura y el borrado, que son las dos sentencias que los triggers rompían.
  const written = degraded.write(entry("El router usa el firmware flint2.", "env", ["router"]));
  assert.equal(written.duplicate, false);
  assert.equal(degraded.read([written.id]).found[0].text, "El router usa el firmware flint2.");
  assert.deepEqual(degraded.remove([before.id]).deleted, [before.id]);
  assert.equal(count(degraded, "SELECT COUNT(*) AS n FROM entries"), 1);

  // Y la vuelta: con FTS5 otra vez, los triggers están de nuevo y el rebuild de la marca hace visible lo escrito sin él.
  degraded.close();
  const restored = await openStore({ dir });
  t.after(() => restored.close());

  assert.equal(restored.fts, true);
  for (const trigger of ["entries_ai", "entries_ad", "entries_au"]) {
    assert.ok(schemaNames(restored, "trigger").includes(trigger), `no volvió el trigger ${trigger}`);
  }
  assert.deepEqual(
    restored.search(searchInput(["router"])).map((hit) => hit.id),
    [written.id],
  );
});

// Criterio 10 (§8.8): lo escrito sin FTS5 queda en `entries` y no en el índice; la marca `fts_disabled` es lo que hace
// que la siguiente apertura reconstruya el índice en vez de esconder la entrada para siempre.
test("criterio 10: escribir sin FTS5 y reabrir hace visible la entrada por el rebuild automático", async (t) => {
  const dir = tempDir(t);
  const degraded = await openStore({ dir }, degradedFactory());
  assert.equal(degraded.fts, false);

  const written = degraded.write(entry("El concilio de Nicea definió el homoousios.", "religion", ["trinidad"]));
  assert.equal(readMetaValue(degraded, "fts_disabled"), "1");
  degraded.close();

  const restored = await openStore({ dir });
  t.after(() => restored.close());

  assert.equal(restored.fts, true);
  assert.equal(readMetaValue(restored, "fts_disabled"), null);
  assert.deepEqual(
    restored.search(searchInput(["trinidad"])).map((hit) => hit.id),
    [written.id],
  );
});

// --- el MATCH que falla ------------------------------------------------------------------------------------------------

/**
 * Un build con FTS5 que acepta el esquema y falla al ejecutar: el único error es el `MATCH` de una sentencia preparada,
 * así que `openStore` deja `fts` en true y el camino degradado no entra en juego. Todo lo demás pasa tal cual.
 */
function failingMatchFactory(): DatabaseFactory {
  return (dbPath: string): SqlDatabase => {
    const inner = new SQLITE.DatabaseSync(dbPath);
    const fail = (): never => {
      throw new Error('fts5: syntax error near "trinidad"');
    };
    return {
      exec: (sql: string): void => inner.exec(sql),
      prepare: (sql: string) => (/MATCH/i.test(sql) ? { run: fail, get: fail, all: fail } : inner.prepare(sql)),
      close: (): void => inner.close(),
    };
  };
}

// §7.2: un `MATCH` que SQLite rechaza no es una búsqueda vacía. El error sale con la sentencia que el modelo lee y el
// error de SQLite como causa, que es lo que una sesión de depuración necesita y lo que la sentencia misma perdería.
test("búsqueda: un MATCH que falla sale como Error con la causa de SQLite", async (t) => {
  const dir = tempDir(t);
  const store = await openStore({ dir }, failingMatchFactory());
  t.after(() => store.close());

  assert.equal(store.fts, true);

  const inner = 'fts5: syntax error near "trinidad"';
  const calls: [string, () => unknown][] = [
    ["search", () => store.search({ tokens: ["trinidad"], category: null, limit: 5, offset: 0 })],
    ["countSearch", () => store.countSearch({ tokens: ["trinidad"], category: null })],
  ];

  for (const [label, run] of calls) {
    let caught: unknown = undefined;
    try {
      run();
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof Error, `${label} tiene que lanzar un Error`);
    assert.equal(caught.message, `The FTS5 query failed: ${inner}`, label);
    assert.ok(caught.cause instanceof Error, `${label} tiene que llevar el error de SQLite como causa`);
    assert.equal(caught.cause.message, inner, label);
  }
});

/**
 * Un build sin FTS5 que además falla en el camino degradado: la degradación de `degradedFactory` — el `CREATE VIRTUAL
 * TABLE` del probe falla, así que `openStore` deja `fts` en false — y, sobre esa misma conexión, toda sentencia cuyo SQL
 * contenga un `LIKE` falla al ejecutarse. Todo lo demás pasa tal cual, y el `LIKE` aparece solo en las dos sentencias de
 * §8.5, la búsqueda y el conteo degradados.
 */
function failingLikeFactory(): DatabaseFactory {
  return (dbPath: string): SqlDatabase => {
    const inner = new SQLITE.DatabaseSync(dbPath);
    const fail = (): never => {
      throw new Error("like failed on purpose");
    };
    return {
      exec: (sql: string): void => {
        if (/create\s+virtual\s+table/i.test(sql)) throw new Error("no such module: fts5");
        inner.exec(sql);
      },
      prepare: (sql: string) => (/LIKE/i.test(sql) ? { run: fail, get: fail, all: fail } : inner.prepare(sql)),
      close: (): void => inner.close(),
    };
  };
}

// §8.5: un fallo del `LIKE` sale como el error crudo de SQLite y no como `The FTS5 query failed: …`, porque ese mensaje
// afirmaría que el índice falló en una conexión donde el índice no existe. El test del `MATCH` que falla no puede cubrir
// esta regla: su factory deja `fts` en true, así que el `try/catch` de `searchFts` y `countFts` — el único que envuelve
// un error de búsqueda — nunca ve al camino degradado.
test("búsqueda: un fallo del camino degradado no se disfraza de fallo de FTS5", async (t) => {
  const dir = tempDir(t);
  const store = await openStore({ dir }, failingLikeFactory());
  t.after(() => store.close());

  assert.equal(store.fts, false);

  const calls: [string, () => unknown][] = [
    ["search", () => store.search({ tokens: ["trinidad"], category: null, limit: 5, offset: 0 })],
    ["countSearch", () => store.countSearch({ tokens: ["trinidad"], category: null })],
  ];

  for (const [label, run] of calls) {
    let caught: unknown = undefined;
    try {
      run();
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof Error, `${label} tiene que lanzar un Error`);
    // El mensaje es exactamente el de SQLite: sin prefijo, sin reescritura y sin causa de envoltorio.
    assert.equal(caught.message, "like failed on purpose", label);
    assert.equal(caught.cause, undefined, `${label} no puede llevar la causa de un envoltorio`);
  }
});
