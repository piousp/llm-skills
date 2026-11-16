import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openStore, runMigrations, type NodeSqliteModule, type SqlExecutor } from "../../src/db.ts";

// dos procesos reales abren a la vez el mismo archivo v1: la migración a v2 tiene que serializarse (una corre, la otra
// ve v2) sin SQLITE_BUSY y sin duplicar ni perder filas. Se repite en directorios nuevos para que el solape ocurra.

const SQLITE = (await import("node:sqlite")) as unknown as NodeSqliteModule;

const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MODULE_URL = pathToFileURL(join(PACKAGE_ROOT, "src", "db.ts")).href;
const TS = "2026-01-01T00:00:00Z";
const ROUNDS = 5;
const OPENERS = 2;

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(realpathSync(os.tmpdir()), "pi-memory-lite-migration-concurrency-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Same baseline schema as the v1 fixture of db.test.ts (kept minimal: no FTS objects, openStore creates them).
const V1_SCHEMA_SQL = `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE entries (
  id       INTEGER PRIMARY KEY,
  ts       TEXT NOT NULL,
  category TEXT NOT NULL,
  text     TEXT NOT NULL,
  terms    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX entries_category ON entries(category);
CREATE TABLE keys (
  entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  term     TEXT NOT NULL,
  PRIMARY KEY (entry_id, term)
);
CREATE INDEX keys_term ON keys(term);
PRAGMA journal_mode = WAL;
`;

/** A v1 file with ids 1, 2 and 5 (a gap at 3 and 4) and three keys. */
function buildV1File(dir: string): void {
  const db = new SQLITE.DatabaseSync(join(dir, "memory.db"));
  db.exec(V1_SCHEMA_SQL);
  db.exec("INSERT INTO meta (key, value) VALUES ('schema_version', '1')");
  const insert = db.prepare("INSERT INTO entries (id, ts, category, text, terms) VALUES (?1, ?2, ?3, ?4, ?5)");
  insert.run(1, TS, "env", "El router usa el firmware flint2.", "router flint2");
  insert.run(2, TS, "env", "La nas duerme a las once.", "nas");
  insert.run(5, TS, "general", "Despliegue en producción cada viernes.", "despliegue");
  db.exec("INSERT INTO keys (entry_id, term) VALUES (1, 'router'), (1, 'flint2'), (2, 'nas'), (5, 'despliegue')");
  db.close();
}

interface ChildRun {
  readonly code: number | null;
  readonly signal: string | null;
  readonly stderr: string;
}

/** Un hijo que solo abre y cierra el store: la migración ocurre dentro de `openStore`. */
function runOpener(dir: string): Promise<ChildRun> {
  const script = `
const { openStore } = await import(${JSON.stringify(MODULE_URL)});
const store = await openStore({ dir: ${JSON.stringify(dir)} });
store.close();
`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: PACKAGE_ROOT,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal, stderr }));
  });
}

test("migración concurrente: dos procesos abren a la vez la misma base v1 y queda en v2 intacta", async (t) => {
  for (let round = 1; round <= ROUNDS; round += 1) {
    const dir = tempDir(t);
    buildV1File(dir);

    const runs = await Promise.all(Array.from({ length: OPENERS }, () => runOpener(dir)));
    for (const run of runs) {
      assert.equal(
        run.code,
        0,
        `ronda ${round}: un proceso terminó con código ${String(run.code)} y señal ${String(run.signal)}; stderr:\n${run.stderr}`,
      );
    }

    const store = await openStore({ dir });
    try {
      const one = (sql: string): Record<string, unknown> | undefined => store.db.prepare(sql).get();
      assert.equal(one("SELECT value FROM meta WHERE key = 'schema_version'")?.value, "2", `ronda ${round}`);
      assert.equal(one("SELECT value FROM meta WHERE key = 'fts_disabled'"), undefined, `ronda ${round}`);

      const rows = store.read([1, 2, 5]).found;
      assert.deepEqual(
        rows.map((row) => [row.id, row.text, row.terms]),
        [
          [1, "El router usa el firmware flint2.", "router flint2"],
          [2, "La nas duerme a las once.", "nas"],
          [5, "Despliegue en producción cada viernes.", "despliegue"],
        ],
        `ronda ${round}`,
      );
      assert.equal(Number(one("SELECT COUNT(*) AS n FROM entries")?.n), 3, `ronda ${round}: entradas duplicadas`);
      assert.deepEqual(
        store.db
          .prepare("SELECT entry_id, term FROM keys ORDER BY entry_id, term")
          .all()
          .map((row) => [Number(row.entry_id), String(row.term)]),
        [
          [1, "flint2"],
          [1, "router"],
          [2, "nas"],
          [5, "despliegue"],
        ],
        `ronda ${round}`,
      );
      assert.equal(store.db.prepare("PRAGMA foreign_key_check").all().length, 0, `ronda ${round}`);
      assert.equal(one("PRAGMA integrity_check")?.integrity_check, "ok", `ronda ${round}`);
      assert.deepEqual(
        store.search({ tokens: ["router"], match: "all", category: null, limit: 10, offset: 0 }).map((hit) => hit.id),
        [1],
        `ronda ${round}`,
      );
    } finally {
      store.close();
    }
  }
});

test("migraciones: una carrera ganada por otra conexión no vuelve a correr el paso", (t) => {
  const dir = tempDir(t);
  const file = join(dir, "race.db");
  const main = new SQLITE.DatabaseSync(file);
  const other = new SQLITE.DatabaseSync(file);
  t.after(() => {
    main.close();
    other.close();
  });
  main.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  main.exec("INSERT INTO meta (key, value) VALUES ('schema_version', '1')");

  // La otra conexión gana la carrera justo antes de que `main` tome el lock: hay que migrar ANTES de reenviar el BEGIN.
  let raced = false;
  const racing: SqlExecutor = {
    exec(sql) {
      if (sql === "BEGIN IMMEDIATE" && !raced) {
        raced = true;
        other.exec("UPDATE meta SET value = '2' WHERE key = 'schema_version'");
      }
      main.exec(sql);
    },
    prepare: (sql) => main.prepare(sql),
  };

  let ran = 0;
  const result = runMigrations(racing, 2, [
    {
      version: 2,
      up: () => {
        ran += 1;
      },
    },
  ]);

  assert.equal(raced, true, "la carrera no ocurrió: el test no prueba nada");
  assert.equal(result, 2);
  assert.equal(ran, 0, "el paso corrió aunque otra conexión ya había migrado");
  assert.equal(main.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value, "2");
});
