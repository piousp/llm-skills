# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - unreleased

First version: global memory for pi exposed as four tools, with no npm dependencies and no memory content
ever entering the system prompt.

### Added

- `memory_write`: one entry of up to 1800 characters, a category validated against a configurable vocabulary,
  and one to eight keys normalized to slugs. A text that is already stored under the same normalization writes
  nothing and answers with the id that exists.
- `memory_search`: ranked search with BM25 over the text and the keys, with `category`, `limit` and `offset`;
  a category catalog with each category's count and most used keys when the call has no query; and a
  `count_only` mode for the totals, with and without a query.
- `memory_read`: full entries by id, in the order asked for, with the absent ids named and the entries the
  budget left out listed.
- `memory_delete`: hard deletes by id, with the deleted and the absent ids reported separately.
- Hard character caps on every answer that can grow, declared in the text: 800 for a search page, 1500 for the
  catalog, 1500 for a count and 2000 for a read, each one naming how many results or characters it left out and
  the `offset`, `limit` or smaller range that reaches them.
- `src/db.ts`: the SQLite store over `node:sqlite`, in WAL mode with `busy_timeout`, `synchronous = NORMAL`
  and foreign keys on. External-content FTS5 table with its three triggers, a core schema and an FTS schema kept
  apart, `meta.schema_version` with a migration runner, and hard deletes cascading through the keys.
- Degraded mode without FTS5: detection on a throwaway in-memory connection, search over `text` and `terms`
  with one escaped `LIKE` per token, the FTS triggers dropped so writes and deletes keep working, a persisted
  `fts_disabled` mark, and the index rebuilt and integrity-checked the next time a binary with FTS5 opens the
  database.
- Retry of the WAL pragma on `SQLITE_BUSY`, which is what keeps two processes opening a fresh database at the
  same time from failing intermittently.
- `src/config.ts`: the `pi-memory-lite` settings block with `dir`, `categories`, `allowUnknownCategory` and
  `exposure`, resolved without throwing from `pi.getSettings()` inside `session_start`, with the directory
  precedence `PI_MEMORY_LITE_DIR` over `settings.dir` over `<agentDir>/lite-memories`.
- The three exposure modes: `direct` declares the four tools to the model, `codemode` calls them from codemode
  scripts, and `deferred` leaves them to `tool_search`; the last two cost nothing per request.
- `src/prompt.ts` and a third handler: when a turn does not declare the four tools, the extension adds one
  `<memory_lite>` section naming them and the mechanism that reaches them — `tool_search` when the exposure is
  `codemode` or `deferred` and the session registry holds the four, a codemode script, or the fact that neither can
  reach them, with the ways out, the tools allowlist among them. The registry check is what tells a declaration hidden
  for the turn apart from a tool the session does not have: a `-t` allowlist that leaves one of the four out lands in
  the unreachable case instead of being pointed at a search that cannot return it. The section is deleted again once
  the tools are declared, costs one patch and nothing per turn, and never carries memory content. The unreachable case
  also warns once per instance, in the same words.
- A readable error instead of a failed load on a Node older than 22.14, where every call names the version
  found and the one required.
- `src/render.ts`: call and result renderers for the TUI, one collapsed line per call and per result, the text
  the model read when expanded, and the query a search line needs taken from the call arguments.
- A name-collision check at `session_start` that warns when another extension registers one of the four
  `memory_*` names.
- `src/query.ts`: FTS5 query sanitization into quoted AND terms, controlled-vocabulary slugs, the normalization
  used for duplicate detection and the denormalized `terms` column.
- Documentation: `README.md` for the user who installs the package, `DEVELOPER.md` for whoever maintains it, and
  this changelog.
- Test suites over `node --test`, one per module plus the extension entrypoint and a concurrency suite: 193
  tests, among them the context budget measured on what `registerTool` receives, the truncated-caps arithmetic,
  the degraded search, the index resynchronization, the migration path and two real processes writing to the
  same database at once.

### Changed

- The default data directory is `<agentDir>/lite-memories`, and the previous default path, `<agentDir>/memories`, is
  no longer read. No migration touches it: a memory written by an earlier build has to be moved by hand, or copied over
  with `memory_write`. `PI_MEMORY_LITE_DIR` and `settings.dir` still win over the default, so a configured install keeps
  reading the directory it names.
- The default category vocabulary went from five slugs to ten: `general`, `decision`, `preference`, `env`, `project`,
  `gotcha`, `convention`, `workflow`, `reference` and `person`, in that order. The vocabulary is closed by default
  (`allowUnknownCategory: false`), so this widens what can be written without configuring anything.
