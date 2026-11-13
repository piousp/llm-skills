# pi-memory-lite — development notes

Working notes for this package. They ship inside the published package, but they are not user
documentation: that is `README.md`.

## Layout

| Path | Contents |
|---|---|
| `extensions/index.ts` | The entrypoint pi loads: it subscribes to `session_start` and `session_shutdown`; inside the first it reads the settings, checks the Node version, registers the four tools with their renderers and warns about name collisions; inside the second it closes the connection. No SQL, no budget arithmetic, no formatting. |
| `src/config.ts` | `resolveConfig()` and `checkNodeVersion()`: from the raw settings, the environment and `agentDir` to the effective configuration. Pure functions; neither throws on what a user typed into a JSON file. |
| `src/tools.ts` | The four declarations the host sees (description, `promptSnippet`, schema, `exposure`, annotations) and the four executors: they validate the arguments, normalize the keys and the category, and delegate to the store. |
| `src/db.ts` | Opening, pragmas, the core schema and the FTS schema kept apart, migrations, the FTS5 probe on `:memory:`, the index `rebuild`, and the whole query layer. `openStore` retries the WAL pragma on `SQLITE_BUSY`, and `createStore` picks the FTS5 or the degraded search-and-count pair once, at open (`QueryLayer`), for the life of the store. The only module that imports `node:sqlite`, and it does it dynamically. |
| `src/query.ts` | The pure surface of the index: `toTokens()` and `quoteToken()` for FTS5, `toSlug()` for the controlled vocabulary, `distinctSlugs()` for the keys of an entry, `normalizeTextForDuplicate()` for duplicate detection and `toTerms()` for the denormalized column. |
| `src/format.ts` | The text that goes back to the model: caps for the catalog (1500), search (800), read (2000) and count (1500), the per-fragment budget, and the explicit declaration of what was left out. Pure functions over rows. |
| `src/render.ts` | The TUI face of the four tools: one line per call and per result while the row is collapsed, and the text the model read when it is expanded. The lines come from `TOOL_LINES`, a private table with one entry per tool name, so a name added to `MEMORY_TOOL_NAMES` without its two lines fails to compile instead of rendering an empty row. |
| `test/unit/` | One suite per module of `src/` except `src/render.ts`, whose lines are covered by `extensions-index.test.ts` (lifecycle, exposure, budget and rendering), plus `concurrency.test.ts` (two real processes). 170 tests through `npm test`. |

## Setup

Node 24.19.0 on this machine; `engines` declares `>=22.14`, which is the floor `node:sqlite` needs. Dependencies
are installed and the three control commands are:

```bash
npm install
npm run typecheck
npm test
```

There is no build step: pi loads the extension through jiti, so the `.ts` imports resolve directly, which is why
the tsconfig uses `allowImportingTsExtensions`. The tests run on Node's native type stripping, the default since
22.18; on 22.14 to 22.17 the `test` script needs `--experimental-strip-types` added. That is a limit of the test
harness and not of the package: pi does not take that path.

Two rules that took time to learn, and that are not worth undoing:

1. **The settings and the tool registration live inside `session_start`.** `pi.getSettings()` and
   `pi.getAllTools()` throw while the extension is loading (`Extension runtime not initialized. Action methods
   cannot be called during extension loading.`). Subscribing to events is allowed during the load, so the
   factory only subscribes: it reads the settings, checks the version, registers the four tools and compares
   names inside the handler. Moving any of those four things into the module body breaks the start of every
   session.
2. **The WAL pragma is retried on `SQLITE_BUSY`.** Two simultaneous openings of a fresh database make
   `PRAGMA journal_mode = WAL` fail with `SQLITE_BUSY` (errcode 5) through SQLite's lock-upgrade deadlock
   detection, a path on which the busy handler is never consulted: `busy_timeout` does not cover it and raising
   it changes nothing. `switchToWal()` in `src/db.ts` retries ten times, 25 ms apart, and only for that error;
   anything else is rethrown untouched. Without that retry the opening fails intermittently and the concurrency
   criterion stops holding.

## Settings contract

The key is `pi-memory-lite` and it carries four fields:

| Field | Contents |
|---|---|
| `dir` | Directory that holds the memory database. Must be a non-empty absolute path. |
| `categories` | The controlled vocabulary of categories the tool accepts. Normalized to slugs, empties and repeats dropped, and a vocabulary that ends up empty degrades to the default list. |
| `allowUnknownCategory` | Whether a category outside the vocabulary is accepted or refused. Only `true` accepts it. |
| `exposure` | How the tools are exposed: `direct`, `codemode` or `deferred`. Nothing is ever injected into the system prompt, so the field chooses the mode, not the content. |

The defaults are `categories = ["general", "decision", "preference", "env", "project"]`,
`allowUnknownCategory = false` and `exposure = "direct"`.

Directory precedence is `PI_MEMORY_LITE_DIR` > `settings.dir` > `<agentDir>/memories`: the environment variable
exists so a test session can be isolated without touching the settings file. `agentDir` comes from the host's
`getAgentDir()`, which honours `PI_CODING_AGENT_DIR`.

Configuration enters through `pi.getSettings()`, which returns the effective copy: the global
`<agentDir>/settings.json` merged with the project's only when the project is trusted, plus the session
overrides. `settings.json` is never read by hand anywhere: that would reimplement the merge and ignore project
trust. The host's `Settings` type has no index signature, so the block is read with a cast to
`Record<string, unknown>` and parsed in `resolveConfig()`, which never throws: every invalid level falls through
to the next one and leaves a warning, and that warning goes both to the log and to the session UI. The extension
never refuses to load over a badly written setting.

Every setting is read and applied inside `session_start`; a change applies on the next session or after
`/reload`, which runs the factory again and fires `session_start` again.

## Degradation matrix

| Condition | Behaviour |
|---|---|
| The database has no FTS5 | Search degrades to one `LIKE` per token over `text` and over `terms`, with `%` and `_` escaped; the order becomes `id` descending instead of BM25. Catalog, count, `read`, `write` and `delete` work the same, and so does finding an entry by a key its text does not contain. |
| It was written without FTS5 and reopens with FTS5 | `meta.fts_disabled` is set: on open, `rebuild` runs over `entries_fts`, `integrity-check` verifies it and the mark is deleted. Without that, the entries of that window would be invisible to search and would raise no error. |
| It opens without FTS5 on a database written with FTS5 | The three external-content triggers are dropped before the mark is written: if they stayed, every `INSERT` and every `DELETE` on `entries` would fail with "no such module: fts5". The stale index stays in the file as a shell that connection never reads, and the next open with FTS5 rebuilds it. |
| Node older than 22.14, or 23.0 to 23.3 | The four tools are registered anyway, but every call returns a readable error naming the version found and the floor it missed instead of failing on the module import. The database is never opened. |
| `node:sqlite` is missing from the binary | Same as the case above: the import is dynamic and happens inside the first open, not during the load. |
| The database was written by a newer version of the package | The open fails with an error naming the stored and the supported version and asking for an update. Nothing is degraded and nothing is truncated. |
| Invalid settings | The default of that field is used and a warning is reported in the session. |

## Context budget

The permanent cost of the package with `exposure: "direct"` is **1352 of the 1500 characters allowed**. The count
is `description + promptSnippet + JSON.stringify(parameters)` over the four tools, as they arrive at
`pi.registerTool` inside the `session_start` handler:

| Tool | Description | Snippet | Schema | Total |
|---|---|---|---|---|
| `memory_write` | 136 | 60 | 259 | 455 |
| `memory_search` | 184 | 69 | 211 | 464 |
| `memory_read` | 31 | 30 | 128 | 189 |
| `memory_delete` | 89 | 27 | 128 | 244 |

It is asserted in `test/unit/extensions-index.test.ts`, in the criterion 2 test, and it is measured on the
arguments `registerTool` received and never on a copy built for the measurement. Two rules keep the number
where it is: no schema carries a per-property description, and `promptGuidelines` is not declared at all, since
it would add bullets to `<rules>` and break the criterion that the prompt differs only in the `<tools>` entries
and in the tool declarations.

## Test rules

- One file per module, named after the module: `src/query.ts` is tested in `test/unit/query.test.ts`. The
  exceptions are `src/render.ts`, whose lines are tested in `extensions-index.test.ts` beside the entrypoint's
  lifecycle, and `concurrency.test.ts` (criterion 8).
- Temporary directories are created with
  `fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-memory-lite-<area>-"))` and cleaned up in
  `t.after`, never in the body of the test: a test that fails in the middle has to leave the directory just as
  clean.
- Rows returned by `node:sqlite` have a null prototype, so they are not compared with `assert.deepEqual` against
  an object literal. Fields are compared one by one, or the row is spread before it is compared.
- The concurrency suite spawns two real processes, and it must never be made green by staggering them. The two
  children of `spawn(process.execPath, ["--input-type=module", "-e", ...])` open the same database and write a
  hundred entries each at the same time; that is what criterion 8 asserts and what exercises the WAL retry. A
  `sleep` between the two spawns, or serializing them in any other way, leaves the test green without testing
  anything: when it fails, fix the code and not the calendar.

## Known limitations

- Duplicate detection is an O(n) scan over the table on every write. A later version adds the `text_norm` column
  with a unique index, which is what turns it into a lookup.
- The degraded search path uses SQLite's `lower()`, which folds ASCII only: two memories that differ only in an
  accent are not found there, though they are found when FTS5 is available. It does not rank either: it returns
  by `id` descending.
- There is no `memory_update`. Correcting an entry is `memory_delete` followed by `memory_write`, and the `id`
  changes, so ids quoted earlier in a transcript go stale. The `UPDATE` triggers already exist, so adding the
  tool later needs no migration.
- The memory is global only: there is no per-project scoping and no `source` field, so an environment note about
  one machine is visible from every project on that machine.
- `MIGRATIONS` is empty and the schema is at version 1. The first real change adds `{ version: 2, up }`; a
  migration that touches an existing table uses `ALTER TABLE`, and one that touches the FTS table recreates it
  and runs `rebuild`.
- The test harness needs Node 22.18 or newer to run without flags; on 22.14 to 22.17 the `test` script requires
  `--experimental-strip-types`. The package does not: pi loads it with jiti.

## Release

The package is published from `.github/workflows/publish-memory-lite.yml`, which lives at the root of the
monorepo and runs with `working-directory: pi-memory-lite`. It is triggered by hand only
(`workflow_dispatch`), over OIDC with `npm stage publish`. There is no `NPM_TOKEN`: the npm CLI exchanges the
runner's OIDC identity for a short-lived publish token. The trust relationship is configured on npmjs.com and
names the exact filename of that workflow, so renaming it breaks publishing until the connection is deleted and
created again. The publish stays in stage and goes to production when a person approves it on npmjs.com.

The job order is the usual one: `npm ci`, `npm run typecheck`, `npm test` and `npm stage publish`. The version
published is the one in `package.json` at that commit, so a release is a version bump committed to `main`, a
push and then the dispatch; a version already on the registry fails the last step and leaves nothing staged.
