# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-11-16

### Added

- Database schema v2: ids are no longer reused after a delete. A database migrated from v1 can reuse an id above the
  highest remaining one, once.
- Prefix search: `deploy` finds `deployments`.
- Any-word search when no entry matches all the words, with a note saying so.
- `memory_write` replies with up to three similar entries (`Similar: #a, #b`).
- A duplicate write merges its new keys into the existing entry and names the keys cut by the limit of 8.
- `memory_write` rejects secrets: AWS keys, GitHub and Slack tokens, private keys and `password=value`.
- The data directory is created with mode 0700.
- `category` is an enum of the configured categories unless `allowUnknownCategory` is true.
- The degraded search ignores accents: `cafe` finds `Café`.

### Changed

- Search rows show the whole text when it fits, otherwise a clip cut at a word boundary.
- Catalog lines no longer start with `#`.
- Node 23 needs 23.5 or later.
- A 0.2.x install refuses a schema v2 database: update every install that shares the data directory.
- The always-loaded text has no fixed ceiling any more; the suite reports its size.

### Removed

- `count_only` from `memory_search`.

### Fixed

- The degraded search missed entries that differ only by an accent.
- The next write could reuse the id of a deleted entry.
- Degraded search showed the wrong fragment for some Hangul, ligature and decomposed-accent text.

## [0.2.0] - 2026-11-13

### Added

- `skills/memory-lite/SKILL.md`: when to write, when to search and what never goes in, shipped with the package.
- A README section on the skill.

### Changed

- `memory_write` says a write needs no permission.

## [0.1.0] - 2026-11-13

First version: global memory for pi as four tools, with no npm dependencies and no memory content in the system prompt.

### Added

- `memory_write`, `memory_search`, `memory_read` and `memory_delete`.
- SQLite store with ranked FTS5 search, and a degraded search for builds without FTS5.
- Settings for the data directory, the category vocabulary and the exposure mode.
- Three exposure modes: `direct`, `codemode` and `deferred`.
- A prompt section that tells the model how to reach the tools when they are not declared.
- TUI renderers for calls and results.
- A warning when another extension registers a `memory_*` tool.
- A readable error on Node older than 22.14.
- Size caps on every answer that can grow, each saying what it left out.
- README, DEVELOPER guide and test suites.

### Changed

- The default data directory is `<agentDir>/lite-memories`; memories in the old `<agentDir>/memories` are not read.
- The default categories go from five to ten, and the vocabulary stays closed by default.
