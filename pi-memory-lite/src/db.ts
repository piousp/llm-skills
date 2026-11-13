// Opening, schema, migrations and the query layer of the memory: the only module that touches `node:sqlite`. The types
// over that module are structural, so the rest of the package never imports it; the import is dynamic and it happens
// inside the first `openStore`, so a Node without the module fails in a tool call and not while the extension loads; and
// the FTS5 schema is a block of its own, separate from the core schema, so a binary without the module still opens the
// database and loses the ranking, never the memory. Every statement binds numbered placeholders, because node:sqlite
// binds by ordinal and an anonymous `?` mixed with `?N` collides in silence (§8.7).
//
// Three states of the world this file has to survive, all of them tested: a database that FTS5 can index, a database
// written while FTS5 was unavailable (the `fts_disabled` mark plus the `rebuild` on the next open, §8.8), and a database
// written by a newer build, which is an error the caller reports and this module never swallows.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { DB_FILE } from "./config.ts";
import { KEYS_PER_CATEGORY } from "./format.ts";
import { distinctSlugs, normalizeTextForDuplicate, quoteToken, toTerms } from "./query.ts";

/** A value a statement accepts, as the rest of the package is allowed to see it. */
export type SqlValue = string | number | null | Uint8Array;

/** A prepared statement, structurally: `run` for writes, `get` for one row, `all` for a page. */
export interface SqlStatement {
  run(...params: SqlValue[]): { changes: number; lastInsertRowid: number };
  get(...params: SqlValue[]): Record<string, unknown> | undefined;
  all(...params: SqlValue[]): Record<string, unknown>[];
}

/** What the query layer needs from a connection: a script and prepared statements, nothing else. */
export interface SqlExecutor {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
}

/** A connection that can also be closed, which is what the store does on shutdown. */
export interface SqlDatabase extends SqlExecutor {
  close(): void;
}

/** The one member of `node:sqlite` this package uses, so the module never appears in a type outside this file. */
export interface NodeSqliteModule {
  DatabaseSync: new (path: string) => SqlDatabase;
}

/** How `openStore` builds its connections. The default is the dynamic import of `node:sqlite`; tests inject. */
export type DatabaseFactory = (path: string) => SqlDatabase;

/** A whole entry, as `read` hands it back. */
export interface MemoryRow {
  readonly id: number;
  readonly ts: string;
  readonly category: string;
  readonly text: string;
  readonly terms: string;
}

/** A search hit: the row plus the fragment the search produced, which is what a search line shows. */
export interface SearchHit {
  readonly id: number;
  readonly ts: string;
  readonly category: string;
  readonly fragment: string;
}

/** One term of a category in the catalog, with the id of the newest entry of that category that declares it. */
export interface CatalogKey {
  readonly term: string;
  readonly id: number;
}

/** One category line of the catalog: how many entries it holds and its most used keys. */
export interface CatalogEntry {
  readonly category: string;
  readonly n: number;
  readonly keys: readonly CatalogKey[];
}

/** Every category with its keys, in the order the catalog query gave them; the formatter does the paging. */
export interface CatalogPage {
  readonly categories: readonly CatalogEntry[];
}

/** What the count mode returns: the total, and one row per category when no tokens narrowed it. */
export interface Totals {
  readonly total: number;
  readonly byCategory: readonly { readonly category: string; readonly n: number }[];
}

/** What a write needs. `ts` is supplied by the caller so the query layer has no clock. */
export interface WriteInput {
  readonly text: string;
  readonly category: string;
  readonly keys: readonly string[];
  readonly ts: string;
}

/** The id of the row that holds the text, the category that row was stored with, and whether the row was already there. */
export interface WriteResult {
  readonly id: number;
  readonly duplicate: boolean;
  readonly category: string;
}

/** What a search needs. The tokens arrive normalized, so this layer never parses a query. */
export interface SearchInput {
  readonly tokens: readonly string[];
  readonly category: string | null;
  readonly limit: number;
  readonly offset: number;
}

/** The whole surface the tools get: four operations, a count, a catalog, and the connection for the tests. */
export interface MemoryStore {
  readonly path: string;
  readonly fts: boolean;
  readonly db: SqlExecutor;
  write(input: WriteInput): WriteResult;
  search(input: SearchInput): SearchHit[];
  countSearch(input: Omit<SearchInput, "limit" | "offset">): number;
  catalog(): CatalogPage;
  totals(input: { readonly tokens?: readonly string[]; readonly category?: string | null }): Totals;
  read(ids: readonly number[]): { readonly found: readonly MemoryRow[]; readonly missing: readonly number[] };
  remove(ids: readonly number[]): { readonly deleted: readonly number[]; readonly missing: readonly number[] };
  close(): void;
}

/** Schema version this build writes and knows how to read (§6.2). */
export const CURRENT_SCHEMA_VERSION = 1;

/** Version a database with no `meta` row is created at, before any migration runs. */
const INITIAL_SCHEMA_VERSION = 1;

/** `meta` key that holds the schema version. */
const SCHEMA_VERSION_KEY = "schema_version";

/** `meta` key that marks a database written while FTS5 was unavailable (§8.8). */
const FTS_DISABLED_KEY = "fts_disabled";

/** The mark itself: any value works and `1` is the one the contract names. */
const FTS_DISABLED_VALUE = "1";

/** Characters of `text` a degraded fragment shows, before the formatter clips it to its own budget. */
const DEGRADED_FRAGMENT = 80;

/** Characters of context a degraded fragment keeps before the match, so the match is not at the very edge. */
const DEGRADED_LEAD = 20;

/** Attempts of the WAL switch, and the pause between two of them (§8.7). */
const WAL_ATTEMPTS = 10;
const WAL_RETRY_DELAY_MS = 25;

/** The SQLite error code of `SQLITE_BUSY`, which `node:sqlite` reports as `errcode`. */
const SQLITE_BUSY = 5;

/**
 * The PRAGMAs of §6.1 that every connection can run unconditionally, `busy_timeout` first because it has to be in place
 * before any transaction and before the first `BEGIN`. They live apart from the schema so they can run before it; the
 * trailing blank line is the separator of the §6.1 block. `journal_mode` is not here: it is the one PRAGMA that a
 * second opening can refuse, so it runs on its own through the retry of `switchToWal`.
 */
const PRAGMAS_SQL = `PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

`;

/**
 * The `journal_mode` line of §6.1, alone because it is the statement `openStore` has to retry: it is the first write a
 * fresh file sees, and two processes opening that same fresh file at once make it fail with `SQLITE_BUSY`.
 */
const WAL_PRAGMA_SQL = "PRAGMA journal_mode = WAL;";

/**
 * The schema that needs no FTS5: `meta`, `entries`, `entries_category`, `keys` and `keys_term`. This is the block that
 * always runs, which is what keeps the memory usable in a Node built without the module.
 */
const CORE_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entries (
  id       INTEGER PRIMARY KEY,
  ts       TEXT NOT NULL,
  category TEXT NOT NULL,
  text     TEXT NOT NULL,
  terms    TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS entries_category ON entries(category);

CREATE TABLE IF NOT EXISTS keys (
  entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  term     TEXT NOT NULL,
  PRIMARY KEY (entry_id, term)
);

CREATE INDEX IF NOT EXISTS keys_term ON keys(term);

`;

/**
 * `entries_fts` and the three triggers of §6.1. External content (`content='entries'`), never contentless: with
 * `content=''` the `SELECT text` inside `snippet()` returns NULL and the fragments come back empty without an error, and
 * without the triggers the index stays empty and `MATCH` answers zero rows without an error either. This block is the
 * only one a binary without FTS5 may skip, and `openStore` skips it on the evidence of the `:memory:` probe.
 */
const FTS_SCHEMA_SQL = `CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
  text,
  terms,
  content='entries',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, text, terms) VALUES (new.id, new.text, new.terms);
END;

CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, text, terms)
    VALUES ('delete', old.id, old.text, old.terms);
END;

CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, text, terms)
    VALUES ('delete', old.id, old.text, old.terms);
  INSERT INTO entries_fts(rowid, text, terms) VALUES (new.id, new.text, new.terms);
END;
`;

/**
 * The three triggers of `FTS_SCHEMA_SQL`, dropped by name. They are the only objects of the schema that reach `entries_fts`
 * from a write, so a connection without the module that keeps them cannot insert or delete a single row: the `INSERT` of
 * `entries_ai` fails with "no such module: fts5" and takes the write with it. `IF EXISTS` is the normal case of a database
 * that never saw an FTS5 build.
 */
const DROP_FTS_TRIGGERS_SQL = `DROP TRIGGER IF EXISTS entries_ai;
DROP TRIGGER IF EXISTS entries_ad;
DROP TRIGGER IF EXISTS entries_au`;

/** One step from a schema version to the next. `up` runs inside the transaction `runMigrations` opened. */
export interface Migration {
  readonly version: number;
  readonly up: (db: SqlExecutor) => void;
}

/**
 * The pending steps of this build. Version 1 is the baseline of §6.1 and not a migration, so the list is empty until a
 * change needs one; the next change adds `{ version: 2, up }` and nothing else has to move. `ALTER TABLE` is the rule,
 * `CREATE TABLE IF NOT EXISTS` never mutates an existing table (§6.2).
 */
export const MIGRATIONS: readonly Migration[] = [];

/** The `meta` statements, numbered like every other statement of this module. */
const SELECT_META_SQL = "SELECT value FROM meta WHERE key = ?1";
const UPSERT_META_SQL =
  "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value";
const DELETE_META_SQL = "DELETE FROM meta WHERE key = ?1";

/**
 * Duplicate detection is a scan of the normalized texts; §6.1 has no unique index and D17 keeps it that way. `category`
 * travels with the row because a duplicate answer names the category the entry was stored with.
 */
const SELECT_ALL_TEXTS_SQL = "SELECT id, text, category FROM entries";
const INSERT_ENTRY_SQL = "INSERT INTO entries (ts, category, text, terms) VALUES (?1, ?2, ?3, ?4)";
const INSERT_KEY_SQL = "INSERT INTO keys (entry_id, term) VALUES (?1, ?2)";

/**
 * The search of §7.2, verbatim: `snippet()` for both indexed columns, `bm25` weighted 1.0 for the text and 1.5 for the
 * vocabulary, ascending because the most negative score is the best. `plain_text` is the last fallback of the fragment,
 * which is why the text travels with the row.
 */
const SEARCH_FTS_SQL = `SELECT e.id AS id, e.ts AS ts, e.category AS category,
       snippet(entries_fts, 0, '[', ']', '...', 12) AS frag_text,
       snippet(entries_fts, 1, '[', ']', '...', 12) AS frag_terms,
       e.text AS plain_text,
       bm25(entries_fts, 1.0, 1.5) AS score
FROM entries_fts
JOIN entries e ON e.id = entries_fts.rowid
WHERE entries_fts MATCH ?1
  AND (?2 IS NULL OR e.category = ?2)
ORDER BY score
LIMIT ?3 OFFSET ?4`;

/** The count mode of an FTS5 build: the same predicate as the search, without the materialized text. */
const COUNT_FTS_SQL = `SELECT COUNT(*) AS n
FROM entries_fts
JOIN entries e ON e.id = entries_fts.rowid
WHERE entries_fts MATCH ?1
  AND (?2 IS NULL OR e.category = ?2)`;

/** The first catalog statement: every category, most populated first (§7.2). */
const CATALOG_CATEGORIES_SQL = `SELECT category AS category, COUNT(*) AS n
FROM entries
GROUP BY category
ORDER BY n DESC, category ASC`;

/**
 * The second catalog statement: up to `KEYS_PER_CATEGORY` keys per category, most used first, each carrying the id of the newest entry
 * of that category that declares it. `uses` counts the entries of a (category, term) pair and `ranked` numbers both the
 * pairs and the rows inside a pair, so one pass answers both facts. `DENSE_RANK` and not `ROW_NUMBER` for the pairs:
 * a pair with five uses would otherwise eat five ranks and hide the second most used key behind it.
 */
const CATALOG_KEYS_SQL = `WITH uses AS (
  SELECT e.category AS category, k.term AS term, e.id AS id, e.ts AS ts,
         COUNT(*) OVER (PARTITION BY e.category, k.term) AS n
  FROM keys k
  JOIN entries e ON e.id = k.entry_id
), ranked AS (
  SELECT category, term, id,
         ROW_NUMBER() OVER (PARTITION BY category, term ORDER BY ts DESC, id DESC) AS newest,
         DENSE_RANK() OVER (PARTITION BY category ORDER BY n DESC, term ASC) AS term_rank
  FROM uses
)
SELECT category AS category, term AS term, id AS id
FROM ranked
WHERE newest = 1 AND term_rank <= ${KEYS_PER_CATEGORY}
ORDER BY category ASC, term_rank ASC`;

/** The total of the count mode, narrowed by the category when one is given. */
const TOTAL_SQL = "SELECT COUNT(*) AS n FROM entries WHERE (?1 IS NULL OR category = ?1)";

/** One row per category of the count mode, most populated first, narrowed by the category when one is given. */
const TOTAL_BY_CATEGORY_SQL = `SELECT category AS category, COUNT(*) AS n
FROM entries
WHERE (?1 IS NULL OR category = ?1)
GROUP BY category
ORDER BY n DESC, category ASC`;

/** One whole entry, which is what a read asks for once per requested id. */
const READ_SQL = "SELECT id, ts, category, text, terms FROM entries WHERE id = ?1";

/** A hard delete: the foreign key removes the keys and the triggers clean the index (§7.4). */
const DELETE_ENTRY_SQL = "DELETE FROM entries WHERE id = ?1";

/**
 * Runs the migration steps that `meta.schema_version` is still missing, or creates the schema and writes version 1 when
 * the row is absent (§6.2). Both parameters are injectable so a test can prove that a step adding a column applies to an
 * existing database, and that a database from a newer build is refused instead of truncated.
 *
 * Returns the version the database holds afterwards. A stored version above `target` is an error the caller reports:
 * this module never downgrades, and it never guesses what a column of an unknown build means.
 */
export function runMigrations(
  db: SqlExecutor,
  target: number = CURRENT_SCHEMA_VERSION,
  migrations: readonly Migration[] = MIGRATIONS,
): number {
  const stored = readSchemaVersion(db);
  const from = stored === null ? createSchema(db) : stored;

  if (from > target) throw new Error(newerVersionMessage(from, target));

  const pending = migrations.filter((migration) => migration.version > from && migration.version <= target);
  if (pending.length === 0) return from;

  const ordered = [...pending].sort((left, right) => left.version - right.version);
  transaction(db, () => {
    for (const migration of ordered) {
      migration.up(db);
      writeSchemaVersion(db, migration.version);
    }
  });

  return ordered[ordered.length - 1].version;
}

/**
 * FTS5 detection (§8.1): the FTS schema and its triggers are created on a throwaway `:memory:` connection, never on the
 * user's file, where the probe table would remain as a real table and would write to the WAL. `PRAGMA compile_options` is
 * not the criterion, because there are builds where the macro is defined and the module is missing.
 */
function probeFts5(createDatabase: DatabaseFactory): boolean {
  let db: SqlDatabase | undefined;
  try {
    db = createDatabase(":memory:");
    // The core schema first: the triggers of the FTS block are attached to `entries`, which has to exist.
    db.exec(CORE_SCHEMA_SQL);
    db.exec(FTS_SCHEMA_SQL);
    return true;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

/** Rebuilds the index from `entries`, which is what external content makes possible and necessary (§8.8). */
function rebuildFts(db: SqlExecutor): void {
  db.exec("INSERT INTO entries_fts(entries_fts) VALUES('rebuild')");
}

/** The FTS5 consistency check, run after a rebuild: an index that disagrees with its content is corruption, not a typo. */
function checkFtsIntegrity(db: SqlExecutor): void {
  db.exec("INSERT INTO entries_fts(entries_fts) VALUES('integrity-check')");
}

/**
 * Opens the memory under `dir`, in the order §8 fixes: directory, dynamic import, PRAGMAs, core schema, migrations,
 * probe, FTS schema, index resynchronization, mark. The second parameter is a test seam: production always takes the
 * dynamic import, and a test that needs an FTS5-less build injects a factory whose `CREATE VIRTUAL TABLE` fails.
 */
export async function openStore(
  options: { readonly dir: string },
  createDatabase?: DatabaseFactory,
): Promise<MemoryStore> {
  mkdirSync(options.dir, { recursive: true });
  const path = join(options.dir, DB_FILE);

  const factory = await databaseFactory(createDatabase);
  const db = factory(path);

  let fts: boolean;
  try {
    // `busy_timeout` first and WAL through the retry, in that order: see `switchToWal`.
    db.exec(PRAGMAS_SQL);
    await switchToWal(db);
    db.exec(CORE_SCHEMA_SQL);
    // The version lives with the schema and is written first: everything after this point may create FTS objects, and
    // objects of a schema this build does not know are not ours to touch.
    runMigrations(db);

    fts = probeFts5(factory);
    if (fts) {
      try {
        db.exec(FTS_SCHEMA_SQL);
      } catch {
        fts = false;
      }
    }

    if (fts && readMeta(db, FTS_DISABLED_KEY) !== null) {
      // Written without FTS5 and reopened with it: the entries of that window are in `entries` and not in the index.
      rebuildFts(db);
      checkFtsIntegrity(db);
      deleteMeta(db, FTS_DISABLED_KEY);
    }
    if (!fts) {
      // A file that an FTS5 build already opened still carries the three triggers of the external content, and on this
      // connection every `INSERT` and every `DELETE` on `entries` would fire them and fail with "no such module: fts5":
      // losing the ranking must not cost the writes and the deletes. They go before the mark, and the next FTS5 open puts
      // them back from `FTS_SCHEMA_SQL` (`IF NOT EXISTS`) and rebuilds the index from `entries` because of the mark. The
      // stale index shell stays behind, and nothing on this connection can read it.
      db.exec(DROP_FTS_TRIGGERS_SQL);
      writeMeta(db, FTS_DISABLED_KEY, FTS_DISABLED_VALUE);
    }
  } catch (error) {
    // The caller never saw the connection, so it cannot close it, and a leaked handle would keep the WAL alive.
    db.close();
    throw error;
  }

  return createStore(db, path, fts);
}

/**
 * Switches the connection to WAL, retrying while SQLite answers `SQLITE_BUSY`, and rethrowing the original error once
 * the attempts run out, so a failure that is not this one and a failure that outlasts the retry both reach the caller
 * intact.
 *
 * The retry is not redundant with `busy_timeout = 5000`, and it cannot be replaced by setting `busy_timeout` earlier
 * (measured): this error comes from the lock-upgrade deadlock detection of SQLite, a path on which the busy handler is
 * never consulted, so no timeout covers it. Two processes opening a fresh database at nearly the same time reproduce it
 * every few runs — `PRAGMA journal_mode = WAL` is the first statement that needs a lock on a file nobody has written
 * yet —, and that is exactly the scenario of acceptance criterion 8 (§8.7, §10). Without this retry the opening fails
 * intermittently; with it, the second process waits a few milliseconds for the first one to finish the switch.
 */
async function switchToWal(db: SqlExecutor): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      db.exec(WAL_PRAGMA_SQL);
      return;
    } catch (error) {
      if (attempt >= WAL_ATTEMPTS || !isBusy(error)) throw error;
    }
    await sleep(WAL_RETRY_DELAY_MS);
  }
}

/** Whether a thrown value is `SQLITE_BUSY`: by its code, and by its message when the error carries no code. */
function isBusy(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null ? (error as { readonly errcode?: unknown }).errcode : undefined;
  if (code !== undefined) return code === SQLITE_BUSY;
  return messageOf(error).includes("database is locked");
}

/**
 * The one way this module makes a connection: the injected factory when a test gave one, and otherwise the dynamic import
 * of `node:sqlite`, whose `DatabaseSync` is a factory of the same shape.
 */
async function databaseFactory(createDatabase?: DatabaseFactory): Promise<DatabaseFactory> {
  if (createDatabase !== undefined) return createDatabase;

  const module = (await import("node:sqlite")) as unknown as NodeSqliteModule;
  return (dbPath: string): SqlDatabase => new module.DatabaseSync(dbPath);
}

/** The two read queries of the store, as one object: the pair is the whole of what the FTS5 flag decides. */
type QueryLayer = Pick<MemoryStore, "search" | "countSearch">;

/** The store over an open connection: every operation of `MemoryStore`, and the statement cache they share. */
function createStore(db: SqlDatabase, path: string, fts: boolean): MemoryStore {
  const statements = new Map<string, SqlStatement>();

  /** One prepared statement per SQL text, reused for the life of the store; the degraded search prepares per call. */
  function prepare(sql: string): SqlStatement {
    const cached = statements.get(sql);
    if (cached !== undefined) return cached;

    const statement = db.prepare(sql);
    statements.set(sql, statement);
    return statement;
  }

  /**
   * The row whose normalized text is `normalized`, or null. Duplicate detection is the scan §6.1 mandates: no unique
   * index (D17), so the comparison is the normalization of `query.ts` applied to every stored text. The category travels
   * with the id because the answer to a duplicate describes the row that exists and not the call that repeated it.
   */
  function findDuplicate(normalized: string): { readonly id: number; readonly category: string } | null {
    for (const row of prepare(SELECT_ALL_TEXTS_SQL).all()) {
      if (normalizeTextForDuplicate(readText(row, "text")) !== normalized) continue;
      return { id: readInt(row, "id"), category: readText(row, "category") };
    }
    return null;
  }

  function write(input: WriteInput): WriteResult {
    // The bracket stays inline here and not in `transaction`: the duplicate path answers from inside the transaction, and
    // the transaction has to be rolled back before the answer, a mid-transaction rollback the helper has no way to ask
    // for without a sentinel of its own.
    db.exec("BEGIN IMMEDIATE");
    try {
      const duplicate = findDuplicate(normalizeTextForDuplicate(input.text));
      if (duplicate !== null) {
        // Nothing was written and nothing may stay half written: the transaction of the duplicate is rolled back.
        rollBack(db);
        return { id: duplicate.id, duplicate: true, category: duplicate.category };
      }

      const inserted = prepare(INSERT_ENTRY_SQL).run(input.ts, input.category, input.text, toTerms(input.keys));
      const insertKey = prepare(INSERT_KEY_SQL);
      // The slug of a key is the term of the `keys` table, and the rule that produces it is the one of the vocabulary: the
      // primary key of (entry_id, term) would reject a repeat, and an emptied slug is not a term at all.
      for (const term of distinctSlugs(input.keys)) insertKey.run(inserted.lastInsertRowid, term);

      db.exec("COMMIT");
      return { id: inserted.lastInsertRowid, duplicate: false, category: input.category };
    } catch (error) {
      rollBack(db);
      throw error;
    }
  }

  /**
   * The two read queries, chosen once from the flag `openStore` already fixed: the FTS5 pair or the degraded pair for the
   * whole life of the store. The guards below are the only thing the two paths share, and they stay outside the choice.
   */
  const queries: QueryLayer = fts
    ? { search: searchFts, countSearch: countFts }
    : { search: searchLike, countSearch: countLike };

  function search(input: SearchInput): SearchHit[] {
    if (input.tokens.length === 0) return [];
    return queries.search(input);
  }

  /** The FTS5 path: a failure of `MATCH` leaves as an Error that carries the SQLite message, never as a silent zero. */
  function searchFts(input: SearchInput): SearchHit[] {
    try {
      const rows = prepare(SEARCH_FTS_SQL).all(matchExpression(input.tokens), input.category, input.limit, input.offset);
      return rows.map((row) => ({
        id: readInt(row, "id"),
        ts: readText(row, "ts"),
        category: readText(row, "category"),
        fragment: ftsFragment(row),
      }));
    } catch (error) {
      throw ftsFailure(error);
    }
  }

  /**
   * The degraded search of §8.5: the frame of `degradedStatement` around the columns the fragment is cut from, with the
   * paging of the page. The statement is prepared per call because its parameter count follows the token count.
   */
  function searchLike(input: SearchInput): SearchHit[] {
    const { sql, params, tokens } = degradedStatement(input, DEGRADED_SEARCH_COLUMNS, {
      limit: input.limit,
      offset: input.offset,
    });

    const rows = db.prepare(sql).all(...params);
    return rows.map((row) => ({
      id: readInt(row, "id"),
      ts: readText(row, "ts"),
      category: readText(row, "category"),
      fragment: degradedFragment(readText(row, "text"), readText(row, "terms"), tokens),
    }));
  }

  function countSearch(input: Omit<SearchInput, "limit" | "offset">): number {
    if (input.tokens.length === 0) return 0;
    return queries.countSearch(input);
  }

  /**
   * The FTS5 count, which fails the same way the search does and carries the same sentence: the `MATCH` is the same one.
   * The rewrite lives here and not in the caller, so a failure of the degraded path is never reported as an FTS5 failure.
   */
  function countFts(input: Omit<SearchInput, "limit" | "offset">): number {
    try {
      const row = prepare(COUNT_FTS_SQL).get(matchExpression(input.tokens), input.category);
      return row === undefined ? 0 : readInt(row, "n");
    } catch (error) {
      throw ftsFailure(error);
    }
  }

  /** The degraded count: the same frame as the search, with the count as its projection and no paging of its own. */
  function countLike(input: Omit<SearchInput, "limit" | "offset">): number {
    const { sql, params } = degradedStatement(input, DEGRADED_COUNT_COLUMNS);

    const row = db.prepare(sql).get(...params);
    return row === undefined ? 0 : readInt(row, "n");
  }

  function catalog(): CatalogPage {
    const totals = prepare(CATALOG_CATEGORIES_SQL).all();
    const keys = new Map<string, CatalogKey[]>();
    for (const row of prepare(CATALOG_KEYS_SQL).all()) {
      const category = readText(row, "category");
      const list = keys.get(category) ?? [];
      list.push({ term: readText(row, "term"), id: readInt(row, "id") });
      keys.set(category, list);
    }

    // Every category, in the order the first statement gave: the formatter pages, so no category is dropped here.
    const categories = totals.map((row) => {
      const category = readText(row, "category");
      return { category, n: readInt(row, "n"), keys: keys.get(category) ?? [] };
    });

    return { categories };
  }

  function totals(input: { readonly tokens?: readonly string[]; readonly category?: string | null }): Totals {
    const tokens = input.tokens ?? [];
    const category = input.category ?? null;

    // With tokens the answer is only the number of matches (§7.2): a count narrowed to one query says nothing useful
    // per category, and the count mode has no second page to paginate.
    if (tokens.length > 0) return { total: countSearch({ tokens, category }), byCategory: [] };

    const row = prepare(TOTAL_SQL).get(category);
    const byCategory = prepare(TOTAL_BY_CATEGORY_SQL)
      .all(category)
      .map((categoryRow) => ({ category: readText(categoryRow, "category"), n: readInt(categoryRow, "n") }));

    return { total: row === undefined ? 0 : readInt(row, "n"), byCategory };
  }

  /** The requested ids in the requested order: the found ones keep their place among the missing ones. */
  function read(ids: readonly number[]): { readonly found: readonly MemoryRow[]; readonly missing: readonly number[] } {
    const found: MemoryRow[] = [];
    const missing: number[] = [];
    const statement = prepare(READ_SQL);

    for (const id of ids) {
      const row = statement.get(id);
      if (row === undefined) {
        missing.push(id);
        continue;
      }
      found.push({
        id: readInt(row, "id"),
        ts: readText(row, "ts"),
        category: readText(row, "category"),
        text: readText(row, "text"),
        terms: readText(row, "terms"),
      });
    }

    return { found, missing };
  }

  /** Hard deletes, one statement per id, all or nothing: a failure halfway does not leave half a deletion behind. */
  function remove(ids: readonly number[]): { readonly deleted: readonly number[]; readonly missing: readonly number[] } {
    const deleted: number[] = [];
    const missing: number[] = [];
    const seen = new Set<number>();

    transaction(db, () => {
      const statement = prepare(DELETE_ENTRY_SQL);
      for (const id of ids) {
        // A repeated id is one request: reporting the second delete as missing would name an id that was there.
        if (seen.has(id)) continue;
        seen.add(id);

        if (statement.run(id).changes === 1) deleted.push(id);
        else missing.push(id);
      }
    });

    return { deleted, missing };
  }

  function close(): void {
    statements.clear();
    db.close();
  }

  return { path, fts, db, write, search, countSearch, catalog, totals, read, remove, close };
}

/** `BEGIN IMMEDIATE` around `work`, `COMMIT` on return, `ROLLBACK` on throw, and the error rethrown untouched. */
function transaction<T>(db: SqlExecutor, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    rollBack(db);
    throw error;
  }
}

/** A rollback that cannot mask the error that caused it: the BEGIN may not have opened a transaction at all. */
function rollBack(db: SqlExecutor): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // Nothing to undo, or the connection can no longer undo it; the caller's error is the one worth reporting.
  }
}

/** Creates the core schema and writes version 1 together, or does neither. */
function createSchema(db: SqlExecutor): number {
  transaction(db, () => {
    db.exec(CORE_SCHEMA_SQL);
    writeSchemaVersion(db, INITIAL_SCHEMA_VERSION);
  });
  return INITIAL_SCHEMA_VERSION;
}

/** The stored version, or null when the `meta` table or the row is absent: both mean a database of this build's own. */
function readSchemaVersion(db: SqlExecutor): number | null {
  let stored: string | null;
  try {
    stored = readMeta(db, SCHEMA_VERSION_KEY);
  } catch {
    return null;
  }
  if (stored === null) return null;

  const version = Number.parseInt(stored, 10);
  return Number.isNaN(version) ? null : version;
}

function writeSchemaVersion(db: SqlExecutor, version: number): void {
  writeMeta(db, SCHEMA_VERSION_KEY, String(version));
}

function readMeta(db: SqlExecutor, key: string): string | null {
  const row = db.prepare(SELECT_META_SQL).get(key);
  return row === undefined ? null : readText(row, "value");
}

function writeMeta(db: SqlExecutor, key: string, value: string): void {
  db.prepare(UPSERT_META_SQL).run(key, value);
}

function deleteMeta(db: SqlExecutor, key: string): void {
  db.prepare(DELETE_META_SQL).run(key);
}

/** One sentence for a database from a newer build; the caller prefixes and reports it, this module only refuses. */
function newerVersionMessage(stored: number, supported: number): string {
  return (
    `The memory database was written by a newer version of pi-memory-lite (schema version ${stored}, ` +
    `this build supports ${supported}); update pi-memory-lite to open it.`
  );
}

/** The quoted AND of the tokens, the shape FTS5 reads without an operator and without a syntax error (§8.4). */
function matchExpression(tokens: readonly string[]): string {
  return tokens.map(quoteToken).join(" ");
}

/**
 * The one error a failed `MATCH` leaves as, for the search and for the count alike: the sentence the model reads, and the
 * SQLite error as the cause, which is what a debugging session needs and what the sentence itself would lose.
 */
function ftsFailure(error: unknown): Error {
  return new Error(`The FTS5 query failed: ${messageOf(error)}`, { cause: error });
}

/** One `LIKE` pair per token plus the values to bind: the predicate scrolls outwards from what the caller gave. */
function likePredicate(tokens: readonly string[]): { where: string; params: SqlValue[] } {
  const clauses: string[] = [];
  const params: SqlValue[] = [];

  for (const token of tokens) {
    const index = params.length + 1;
    // `ESCAPE '\'` is a single backslash in the SQL text, which is two in this source: two backslashes in the SQL that
    // reaches the engine make it answer "ESCAPE expression must be a single character" (§8.5).
    clauses.push(`(lower(e.text) LIKE ?${index} ESCAPE '\\' OR lower(e.terms) LIKE ?${index} ESCAPE '\\')`);
    params.push(`%${escapeLike(token)}%`);
  }

  return { where: clauses.join(" AND "), params };
}

/** `%`, `_` and the backslash itself, escaped for a `LIKE` that declares the backslash as its escape character. */
function escapeLike(token: string): string {
  return token.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** The columns of the degraded search: the row itself, plus the text and the vocabulary the fragment is cut from. */
const DEGRADED_SEARCH_COLUMNS = "e.id AS id, e.ts AS ts, e.category AS category, e.text AS text, e.terms AS terms";

/** The projection of the degraded count: the number of matches and nothing else. */
const DEGRADED_COUNT_COLUMNS = "COUNT(*) AS n";

/**
 * The degraded statement of §8.5 that the search and the count share, differing only in projection and paging: one `LIKE`
 * pair per lowercased token, joined by AND, over the text and the denormalized vocabulary — both, so a key that is not in
 * the text still finds its entry (criterion 4) —, with `%` and `_` escaped because the model writes them without meaning
 * to, then the category filter and, when a page is asked for, the order and the two paging placeholders. The parameter
 * count follows the token count, so these statements are prepared per call and never cached.
 */
function degradedStatement(
  input: { readonly tokens: readonly string[]; readonly category: string | null },
  projection: string,
  paging?: { readonly limit: number; readonly offset: number },
): { sql: string; params: SqlValue[]; tokens: readonly string[] } {
  const tokens = input.tokens.map((token) => token.toLowerCase());
  const { where, params } = likePredicate(tokens);
  const categoryIndex = tokens.length + 1;

  const lines = [
    `SELECT ${projection}`,
    "FROM entries e",
    `WHERE ${where}`,
    `  AND (?${categoryIndex} IS NULL OR e.category = ?${categoryIndex})`,
  ];

  const bound: SqlValue[] = [...params, input.category];
  if (paging !== undefined) {
    lines.push("ORDER BY e.id DESC", `LIMIT ?${categoryIndex + 1} OFFSET ?${categoryIndex + 2}`);
    bound.push(paging.limit, paging.offset);
  }

  return { sql: lines.join("\n"), params: bound, tokens };
}

/** The fragment of an FTS hit: the text around the match, then the vocabulary, then the text itself (§7.2). */
function ftsFragment(row: Record<string, unknown>): string {
  const snippet = readText(row, "frag_text");
  if (snippet !== "") return snippet;

  const terms = readText(row, "frag_terms");
  if (terms !== "") return terms;

  return readText(row, "plain_text");
}

/**
 * The fragment of a degraded hit: the window around the earliest match in the text, or the vocabulary when the row
 * matched through a key that its text does not contain. Whatever comes out is clipped to the page budget afterwards.
 */
function degradedFragment(text: string, terms: string, tokens: readonly string[]): string {
  const at = firstMatch(text.toLowerCase(), tokens);
  if (at !== -1) {
    const start = Math.max(0, at - DEGRADED_LEAD);
    const head = start === 0 ? "" : "...";
    return `${head}${text.slice(start, start + DEGRADED_FRAGMENT)}`;
  }

  if (firstMatch(terms.toLowerCase(), tokens) !== -1) return terms;
  return text.slice(0, DEGRADED_FRAGMENT);
}

/** The earliest position of any token in the haystack, or -1; the tokens arrive lowercased like the haystack. */
function firstMatch(haystack: string, tokens: readonly string[]): number {
  let at = -1;
  for (const token of tokens) {
    const index = haystack.indexOf(token);
    if (index !== -1 && (at === -1 || index < at)) at = index;
  }
  return at;
}

/** A column as a string: NULL and every non-string become the empty string, which is what a fragment falls back on. */
function readText(row: Record<string, unknown>, column: string): string {
  const value = row[column];
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : String(value);
}

/** A column as an integer, whatever node:sqlite decided to hand back. */
function readInt(row: Record<string, unknown>, column: string): number {
  return Number(row[column]);
}

/** The message of an unknown thrown value: the text an error result or a rewritten error carries. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
