# pi-memory-lite — deferred work

What 0.1.0 deliberately does not build, in the order the work would be taken up. This file is tracked by git and left
out of the `files` list of `package.json`, so it never ships to npm.

Two things are parked here: project-scoped databases, and export/import from markdown. They are a single stage, because
the second is only worth designing once the first says where a memory lives. The usage skill that the non-`direct`
exposures need was parked here with them and 0.2.0 ships it, so it is recorded at the end of this file as a decision
taken rather than as work to take up.

## Stage 2 — project-scoped memory

The reason: a global memory is readable from every project, with `memory_delete` as the only way out and `env` as the
category to watch. The README documents that caveat instead of solving it.

Decisions already taken:

- 0.1.0 keeps one global database at `<agentDir>/lite-memories/memory.db`. Nothing in the resolution changes now.
- Project-scoped databases are a later stage, and export/import travels with them, not before.
- The schema does not have to change. What changes is where `dbPath` points, so the three levels of `resolveDir`
  (`src/config.ts:221-241`: environment, then the settings block, then the default) have to make room for a fourth.

Decisions still open, with a recommendation for each:

1. **Identity of a project.** A hash of the git toplevel is what a repository move survives and what a monorepo
   package does not confuse; outside a repository it falls back to the hash of the working directory, which does not
   survive a move. Do not use the package name: two repositories with the same name collide.
2. **Identity of an entry, which is the blocking one.** `entries.id` is `INTEGER PRIMARY KEY` (`src/db.ts:182-183`),
   a rowid that repeats in every database. With two databases open, `memory_read` and `memory_delete` lose an
   unambiguous identifier. Either the id is qualified (a database prefix on what `memory_write` and `memory_search`
   return), or each tool grows a database parameter. Recommend the qualified id: no schema change, and the answer to a
   duplicate keeps naming the row that exists.
3. **Search semantics.** Project first and global after, with the database of each result visible, because the global
   memory is the cross-project knowledge by definition. Global alone only behind an explicit flag.
4. **The budget with two databases.** The 800 characters of a search result split between the two result sets rather
   than doubling per turn. The caps are per result, not per database.
5. **Precedence.** Today it is environment, settings block, default. A project level enters between the settings block
   and the default, without changing the meaning of the three that exist.
6. **Migration.** Entries already in the global database stay there and stay visible through the fallback of decision
   3. No migration command in the first cut.

## Stage 3 — export and import from markdown

The door out of `AGENTS.md`. Two different products hide behind one name, and only the first is promised:

- **Round trip of this package's own format.** A file the package writes and reads back, verifiable with tests.
- **Ingestion of arbitrary markdown** such as an `AGENTS.md` section. This is the expensive one: it needs splitting
  heuristics and it is where imports silently lose half the content.

Decisions still open:

1. **Which of the two is the product.** Recommend the round trip first, and treat arbitrary ingestion as a separate
   proposal.
2. **Granularity.** One file with one block per entry, not one file per category: the diff stays readable.
3. **Where the metadata goes.** An HTML comment, so the file reads as plain markdown and the metadata does not render.
4. **What is preserved.** `ts` yes, because the catalog and `delete` reason about it. `id` no: it is internal and
   local, so an import assigns new ones.
5. **The derived columns.** `terms` and `keys` are recomputed at import from the text and the keys of the file, with
   `toSlug` and `distinctSlugs` (`src/query.ts`). An index that disagrees with the text is the failure mode this
   avoids. This is an obligation, not a choice.
6. **Duplicates at import.** Report how many rows were skipped. A silent import that drops half is indistinguishable
   from one that worked.
7. **Tools or a CLI command.** Two more tools cost permanent prompt on a budget already 97 characters from its
   ceiling. A `pi memory export` command costs nothing per turn. Recommend the CLI.

## The usage skill and the non-`direct` exposures

`exposure` ships as `direct` by default. The other two values keep the four tools out of the prompt, which buys
permanent prompt savings and costs discoverability:

| Exposure | Permanent cost | How the model gets to a tool |
|---|---|---|
| `direct` | 338–386 estimated tokens (snippet, description, schema) | Declared while active |
| `codemode` | Its declaration sits inside the `codemode` description, within a 3000-token budget shared with every MCP server | Active `codemode`, then `searchTools()` or `ALL_TOOLS` |
| `deferred` | None in declarations | Active `tool_search`, which finds and activates it |

Two mechanics that the decision depends on, both from the host:

- `codemode` and `deferred` tools stay callable and findable, so they are not lost. `hidden` is the only exposure that
  makes a tool unreachable, and `resolveExposure` does not accept it. The session's `tools` allowlist is the other way
  there: it filters the tool out of the registry altogether, which is why the section reads the registry and reports
  that case as unreachable.
- pi does not turn on `tool_search` or `codemode` for extension tools; only the MCP extension activates them, and
  only for MCP servers that need them (`docs/mcp.md:206`). `tool_search` is off by default and is enabled with
  `"defaultTools": ["+tool_search"]` or `--tools` (`docs/cli.md:184`). Whoever selects `deferred` does that
  themselves, or the tools are unreachable in practice.

The skill exists for that second point, and it is shipped. 0.2.0 adds `skills/memory-lite/SKILL.md`, declared in the
`pi` manifest as `"skills": ["./skills"]` and carried in the tarball by the `files` list of `package.json`. Its
description stays in `<skills>` permanently (85–140 estimated tokens) and its body is read on demand, so the chain is
skill description, `SKILL.md`, then whichever mechanism the exposure left available.

The objection that kept it out of 0.1.0 was its cost, and the cost is accepted rather than argued away: a shipped
description is paid by every session of every install, the `direct` ones included, where it changes nothing. The table
above counts declarations only, so every row now carries that description on top. The alternative, a personal skill
under `~/.pi/agent/skills`, keeps the guidance with the person who wrote it and leaves the `deferred` and `codemode`
users, the ones who need it, without it.

What the decision was meant to depend on is measurement, and it moves to the work that follows: how many writes a
session really makes, how many of them are noise, and whether the catalog (`memory_search` with no query, which returns
counts per category and the most used keys) shows one key repeated across entries. That measurement no longer gates the
skill; it adjusts what the skill says. The cheap remedy stays first on the list: tighten the four tool descriptions,
which have 97 characters of margin in the 1500-character budget, and change the skill only where the numbers ask for
it.
