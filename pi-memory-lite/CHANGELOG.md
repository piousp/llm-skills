# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-11-16

Search that finds more, writes that guard themselves, and ids that are not handed out twice. The database moves to schema
version 2.

### Added

- Schema version 2: `entries` and `keys` use `AUTOINCREMENT`, so the id of a deleted entry is never handed out again
  and an id quoted earlier never points at a different text. On a database migrated from v1, numbering continues after
  the highest id still present, because v1 keeps no record of deleted ids: an entry deleted before the upgrade whose id
  was above every remaining one can get that id again, once, as it could under v1. The migration copies the tables and
  sets `fts_disabled`, so the index is rebuilt on the next open with FTS5.
- Prefix matching in ranked search: a token of three or more characters ends in `*` (`deploy` finds `deployments`).
- Fallback from all words to any word when no entry matches all of them, with a note saying so.
- `memory_write` may end its reply with `Similar: #a, #b`: up to three entries that share keys with the new one,
  computed after the commit.
- An exact duplicate merges its new keys into the existing entry; the reply names the keys added and the keys cut by
  the limit of 8.
- Secret detection in `memory_write` (`src/secrets.ts`): an AWS key, a GitHub token, a private key, a Slack token or
  `password=value` rejects the write, and the reply never echoes the match. The password value must be 6+ characters
  and include a digit or a symbol, so "password: stored in Vault" is still saved; a letters-only password is not caught
  (a known tradeoff).
- The data directory is created with mode 0700; an existing directory is left untouched.
- The `category` of `memory_write` is an enum of the configured categories unless `allowUnknownCategory` is true.
  Direct calls to the executor still normalize to a slug.
- The degraded search folds accents through a deterministic SQL function, so `cafe` finds `Café` without FTS5.

### Changed

- A search row returns the whole text when it fits, and otherwise a clip cut at a word boundary with an ellipsis. The
  FTS snippet is 32 tokens and the degraded fragment 240 characters.
- Catalog lines no longer start with `#`, which now only marks ids.
- The `memory_read` marker says `read fewer ids at once`.
- The Node floor of the 23 line goes from 23.4 to 23.5; 23.0 to 23.4 are refused.
- The text of the `unreachable` prompt section is a constant.
- There is no fixed ceiling on the always-loaded text any more. The suite measures and reports the four tools plus the
  skill (1410 + 120 = 1530 characters, measured at 0.3.0) instead of asserting 1500.
- A 0.2.x build refuses a schema version 2 database with its newer-version error: update every install that shares the
  data directory.

### Removed

- `count_only` from `memory_search`: the catalog already shows the counts.
- The 1500-character always-loaded budget and its assertion.

### Fixed

- The degraded search no longer misses entries that differ only by an accent: it used ASCII-only `lower()`.
- Ids of deleted entries could be reused by the next write.

## [0.2.0] - 2026-11-13

The usage skill that the non-`direct` exposures needed ships with the package.

### Added

- `skills/memory-lite/SKILL.md`: the triggers of the memory, which the four tool descriptions do not carry. When to
  write without being asked (a working preference the repository does not hold, a design decision with its reason, an
  environment gotcha, an unwritten convention, the location of an external resource, a stable fact of the setup that
  changed how something was done), when to search first (a project or a technology the memory may have touched, before
  a write, when the user says something was already discussed, before proposing a configuration change, and the
  catalog when no query word is obvious), what never goes in (secrets, what the repository or `AGENTS.md` already
  states, task state, long dumps, unverified assumptions), the mechanics of a write (one fact per entry, category from
  the vocabulary in force, one to three slug keys, a soft ceiling of ten unrequested writes per session, one announced
  line per write, correction as delete plus write) and one line on reaching the tools under `codemode` and `deferred`.
  It repeats no tool description: the skill says when, the tools say what.
- The skill is declared in the `pi` manifest as `"skills": ["./skills"]` and carried in the tarball by the `files`
  list, so an install of the package gets it with no configuration to write.
- `README.md`: a section on the skill, on its permanent cost and on `/skill:memory-lite`, linked from the saving
  guidance.

### Changed

- `memory_write` says that a write needs no permission: "Write on your own initiative, without asking permission".
  The skill that says the same is read on demand, and four smoke runs showed what happens without the clause in the
  description: the model searched the memory, read the skill, and then asked the user before writing. The four
  descriptions now spend 1403 of the 1500 characters the budget allows.
- `ROADMAP.md` records the skill as shipped instead of open. The permanent cost of its description is accepted, not
  argued away, and the measurement of writes per session, of noise and of the catalog becomes the work that adjusts
  the content afterwards.

## [0.1.0] - 2026-11-13

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
