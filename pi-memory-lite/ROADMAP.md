# pi-memory-lite — deferred work

What 0.1.0 deliberately does not build, in the order the work would be taken up. This file is tracked by git and left
out of the `files` list of `package.json`, so it never ships to npm.

Three things are parked here: project-scoped databases, export/import from markdown, and the usage skill that the
non-`direct` exposures need. The first two are a single stage, because the second is only worth designing once the
first says where a memory lives.

## Stage 2 — project-scoped memory

The reason: a global memory is readable from every project, with `memory_delete` as the only way out and `env` as the
category to watch. The README documents that caveat instead of solving it.

Decisions already taken:

- 0.1.0 keeps one global database at `<agentDir>/memories/memory.db`. Nothing in the resolution changes now.
- Project-scoped databases are a later stage, and export/import travels with them, not before.
- The schema does not have to change. What changes is where `dbPath` points, so the three levels of `resolveDir`
  (`src/config.ts:210-229`: environment, then the settings block, then the default) have to make room for a fourth.

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
7. **Tools or a CLI command.** Two more tools cost permanent prompt on a budget already 148 characters from its
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

- `codemode` and `deferred` tools stay callable and findable, so they are not lost. `hidden` is the only value that
  makes a tool unreachable, and `resolveExposure` does not accept it.
- pi does not turn on `tool_search` or `codemode` for extension tools; only the MCP extension activates them, and
  only for MCP servers that need them (`docs/mcp.md:206`). `tool_search` is off by default and is enabled with
  `"defaultTools": ["+tool_search"]` or `--tools` (`docs/cli.md:184`). Whoever selects `deferred` does that
  themselves, or the tools are unreachable in practice.

The skill exists for that second point: it is the only channel that survives with the tools out of the prompt. Its
description stays in `<skills>` permanently (85–140 estimated tokens) and its body is read on demand, so the chain is
skill description, `SKILL.md`, then whichever mechanism the exposure left available. The open decision is whether the
package ships that skill or documents how to write one, and it waits on the measurement it was always meant to depend
on: how many writes a session really makes, and how many of them are noise.
