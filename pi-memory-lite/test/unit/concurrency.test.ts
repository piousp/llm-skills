import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openStore, type MemoryStore } from "../../src/db.ts";
import { normalizeTextForDuplicate } from "../../src/query.ts";

// Criterio 8 y §8.7: dos procesos del sistema operativo escribiendo en la misma base al mismo tiempo. Que dos
// conexiones se serialicen sin `SQLITE_BUSY` y sin corromper el archivo es un hecho de dos procesos reales, así que este
// archivo no simula nada: lanza dos hijos de Node con `openStore`, los deja escribir en paralelo y revisa el archivo
// desde el padre. Cada regla vive en su propio subtest para que un fallo nombre la regla que se rompió.

/** La raíz del paquete, derivada de este archivo y no del cwd, para que los hijos corran desde cualquier directorio. */
const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** El módulo que importan los hijos, por URL absoluta: el `-e` de un hijo no tiene `import.meta.url` de este archivo. */
const MODULE_URL = pathToFileURL(join(PACKAGE_ROOT, "src", "db.ts")).href;

/** Las entradas de cada escritor llevan este token, así que una búsqueda por él tiene que encontrar las 200. */
const SHARED_TOKEN = "memoria";

/** Las entradas por escritor de cada proceso: cien, que es lo que pide el plan de pruebas de §11. */
const ENTRIES_PER_WRITER = 100;

/** El nombre de cada escritor es también el token propio de sus textos y el prefijo de sus claves. */
const WRITERS = ["escritor1", "escritor2"] as const;

/** Los diez textos que los dos escritores intentan escribir, cada uno con su mayúsculas y sus espacios (§8.7). */
const SHARED_TEXTS = [
  "el router reinicia solo",
  "la nas duerme a las once",
  "el backup corre los domingos",
  "el disco externo esta lleno",
  "la vpn cae cada tanto",
  "el portatil usa wayland",
  "el movil sincroniza fotos",
  "la impresora no tiene toner",
  "el switch hace ruido",
  "el ups dura diez minutos",
] as const;

/** Un directorio temporal que el test borra después, nunca uno fijo compartido entre tests. */
function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(realpathSync(os.tmpdir()), "pi-memory-lite-concurrency-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Los diez textos compartidos, con la forma que cada escritor elige: mayúsculas y espacios triples de un lado, minúsculas
 * y espacios de más del otro. `normalizeTextForDuplicate` es lo único que los hace iguales, y por eso la deduplicación
 * tiene algo que decidir.
 */
function sharedTextsFor(writer: string): string[] {
  return writer === WRITERS[0]
    ? SHARED_TEXTS.map((text) => `  ${text.toUpperCase().replace(/ /g, "   ")}  `)
    : SHARED_TEXTS.map((text) => `   ${text} `);
}

/**
 * El programa de un escritor: abre su propio store sobre `dir`, escribe sus cien entradas y los textos compartidos que se
 * le pasen, y cierra. No imprime nada cuando le va bien: un error se va solo a stderr con el código distinto de cero de
 * una excepción no atrapada, que es exactamente lo que el padre mira.
 */
function writerScript(dir: string, writer: string, sharedTexts: readonly string[]): string {
  return `
const { openStore } = await import(${JSON.stringify(MODULE_URL)});
const store = await openStore({ dir: ${JSON.stringify(dir)} });
const ts = "2026-01-01T00:00:00Z";
for (let i = 1; i <= ${ENTRIES_PER_WRITER}; i += 1) {
  store.write({
    ts,
    category: "general",
    text: ${JSON.stringify(`${writer} entrada numero `)} + i + ${JSON.stringify(` ${SHARED_TOKEN}`)},
    keys: [${JSON.stringify(`clave-${writer}-`)} + i],
  });
}
for (const text of ${JSON.stringify(sharedTexts)}) {
  store.write({ ts, category: "general", text, keys: ["compartida"] });
}
store.close();
`;
}

/** Lo que dejó un hijo: el código de salida, la señal si lo mataron, y las dos salidas completas. */
interface ChildRun {
  readonly writer: string;
  readonly code: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Lanza un escritor y espera su `close`, que es el único evento en el que las salidas ya están completas. */
function runWriter(dir: string, writer: string, sharedTexts: readonly string[] = []): Promise<ChildRun> {
  const child = spawn(process.execPath, ["--input-type=module", "-e", writerScript(dir, writer, sharedTexts)], {
    cwd: PACKAGE_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  return new Promise((resolve) => {
    child.on("close", (code, signal) => resolve({ writer, code, signal, stdout, stderr }));
  });
}

/** Las dos salidas al mismo tiempo: los dos procesos arrancan juntos y el padre espera a que terminen los dos. */
function runBoth(dir: string, textsFor: (writer: string) => readonly string[] = () => []): Promise<ChildRun[]> {
  return Promise.all(WRITERS.map((writer) => runWriter(dir, writer, textsFor(writer))));
}

/**
 * Las líneas de stderr que son un fallo. El test no exige stderr vacío —un warning legítimo de Node no puede romperlo—,
 * solo que no haya `SQLITE_BUSY` ni una línea de excepción, que son las dos formas en que el criterio 8 se rompe.
 */
function errorLines(stderr: string): string[] {
  return stderr
    .split("\n")
    .filter((line) => line.includes("SQLITE_BUSY") || line.includes("Error:"))
    .map((line) => line.trim());
}

/** El `n` de un `COUNT(*) AS n`, por la conexión que el store expone para los tests. */
function count(store: MemoryStore, sql: string): number {
  const row = store.db.prepare(sql).get();
  return row === undefined ? 0 : Number(row.n);
}

/** Cuántas entradas encuentra un token, en una página más grande que cualquier fixture de este archivo. */
function hitCount(store: MemoryStore, token: string): number {
  return store.search({ tokens: [token], category: null, limit: 500, offset: 0 }).length;
}

/** Los textos escritos, normalizados como los compara la deduplicación. */
function normalizedTexts(store: MemoryStore): string[] {
  return store.db
    .prepare("SELECT text FROM entries")
    .all()
    .map((row) => normalizeTextForDuplicate(String(row.text)));
}

test("concurrencia: dos procesos escriben 100 entradas cada uno en la misma base", async (t) => {
  const dir = tempDir(t);
  const runs = await runBoth(dir);
  const store = await openStore({ dir });
  t.after(() => store.close());

  await t.test("criterio 8: los dos procesos hijos terminan con código 0", () => {
    for (const run of runs) {
      assert.equal(
        run.code,
        0,
        `el escritor ${run.writer} terminó con código ${String(run.code)} y señal ${String(run.signal)}; stderr:\n${run.stderr}`,
      );
    }
  });

  await t.test('criterio 8: la salida de error no tiene "SQLITE_BUSY" ni líneas "Error:"', () => {
    for (const run of runs) {
      assert.equal(run.stdout, "", `el escritor ${run.writer} imprimió en stdout:\n${run.stdout}`);
      assert.deepEqual(
        errorLines(run.stderr),
        [],
        `la salida de error del escritor ${run.writer} tiene líneas con "SQLITE_BUSY" o "Error:" (se buscaron esas dos):\n${run.stderr}`,
      );
    }
  });

  await t.test("criterio 8: la base reabierta tiene 200 entradas y 200 claves distintas", () => {
    assert.equal(count(store, "SELECT COUNT(*) AS n FROM entries"), WRITERS.length * ENTRIES_PER_WRITER);
    assert.equal(count(store, "SELECT COUNT(DISTINCT term) AS n FROM keys"), WRITERS.length * ENTRIES_PER_WRITER);
  });

  await t.test("criterio 8: PRAGMA integrity_check devuelve ok", () => {
    const row = store.db.prepare("PRAGMA integrity_check").get();
    assert.equal(String(row?.integrity_check), "ok");
  });

  await t.test("criterio 8: el token compartido encuentra 200 entradas y el propio de cada escritor 100", () => {
    assert.equal(hitCount(store, SHARED_TOKEN), WRITERS.length * ENTRIES_PER_WRITER);
    for (const writer of WRITERS) {
      assert.equal(hitCount(store, writer), ENTRIES_PER_WRITER, `el token ${writer} no encontró sus 100 entradas`);
    }
  });
});

// §8.7 con criterio 8: los dos procesos escriben además los mismos diez textos. La cuenta final es 100 + 100 textos
// únicos de cada escritor más 10 textos compartidos escritos por los dos, es decir 210 filas, porque el segundo intento
// de un texto compartido entra en su `BEGIN IMMEDIATE` después del `COMMIT` del primero, encuentra la fila en el escaneo
// de duplicados y devuelve su id sin insertar nada. Si la transacción no serializara las dos escrituras, cada copia
// pasaría el escaneo antes de que la otra se confirmara y la base acabaría con 220: el número que se afirma es 210.
test("concurrencia y §8.7: los diez textos compartidos quedan una sola vez y la base termina en 210", async (t) => {
  const dir = tempDir(t);
  const runs = await runBoth(dir, sharedTextsFor);
  const store = await openStore({ dir });
  t.after(() => store.close());

  await t.test("§8.7: los dos procesos hijos terminan con código 0", () => {
    for (const run of runs) {
      assert.equal(
        run.code,
        0,
        `el escritor ${run.writer} terminó con código ${String(run.code)} y señal ${String(run.signal)}; stderr:\n${run.stderr}`,
      );
    }
  });

  await t.test('§8.7: la salida de error no tiene "SQLITE_BUSY" ni líneas "Error:"', () => {
    for (const run of runs) {
      assert.equal(run.stdout, "", `el escritor ${run.writer} imprimió en stdout:\n${run.stdout}`);
      assert.deepEqual(
        errorLines(run.stderr),
        [],
        `la salida de error del escritor ${run.writer} tiene líneas con "SQLITE_BUSY" o "Error:" (se buscaron esas dos):\n${run.stderr}`,
      );
    }
  });

  await t.test("§8.7: la base tiene 210 entradas (100 + 100 + 10) y no 220", () => {
    assert.equal(
      count(store, "SELECT COUNT(*) AS n FROM entries"),
      ENTRIES_PER_WRITER * WRITERS.length + SHARED_TEXTS.length,
      "las 100 + 100 entradas propias más los 10 textos compartidos son 210 filas; 220 querría decir que la copia de uno de los dos escritores pasó el escaneo de duplicados",
    );

    const written = normalizedTexts(store);
    for (const text of SHARED_TEXTS) {
      const same = written.filter((candidate) => candidate === normalizeTextForDuplicate(text)).length;
      assert.equal(same, 1, `el texto compartido "${text}" tiene que aparecer una sola vez y aparece ${same} veces`);
    }
  });
});
