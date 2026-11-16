# pi-memory-lite

Global memory for [pi](https://pi.dev) that never enters the system prompt. It holds the durable facts, preferences
and decisions a later session would otherwise rediscover, in one SQLite database the model reaches through four tools.
Nothing the memory holds is injected: under the default exposure the declarations of those four tools are the whole of
what the model is told (1410 characters at 0.3.0, plus 120 for the skill's name and description).

[![npm version](https://badge.fury.io/js/pi-memory-lite.svg)](https://badge.fury.io/js/pi-memory-lite)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Install

```bash
pi install npm:pi-memory-lite
```

The four tools — `memory_write`, `memory_search`, `memory_read` and `memory_delete` — are then available in every
session on the machine, whichever project it runs in. `pi list` shows what is installed, and `pi update --extensions`
moves every installed package to its latest version.

## Configuration

Settings live in the `pi-memory-lite` block of `~/.pi/agent/settings.json`:

```json
{
  "pi-memory-lite": {
    "dir": "/home/you/lite-memories",
    "categories": [
      "general", "decision", "preference", "env", "project",
      "gotcha", "convention", "workflow", "reference", "person"
    ],
    "allowUnknownCategory": false,
    "exposure": "direct"
  }
}
```

The block is optional and so is every field in it. `categories` replaces the default vocabulary, which is the ten
slugs above, in that order. With `allowUnknownCategory` off, the `category` of `memory_write` is an enum of the
configured categories in the tool schema, and a value outside it is refused with an error that lists the valid ones;
with it on, any category that normalizes to a non-empty slug is accepted and created. A direct call to the executor
still normalizes the category to a slug before it checks it.
A malformed field falls back to its default and reports a warning in the session instead of stopping the extension.
A change applies to the next session, or immediately after `/reload`.

## Exposure

`exposure` decides how the four tools reach the model, never what the memory holds.

`direct`, the default, declares them the way built-in tools are declared. That is the 1410 characters above.

`codemode` and `deferred` keep those four declarations out of `<tools>`, at the price of the model having to discover
them. The tools stay registered either way: what changes is what the prompt says about them. With `codemode` active they
are listed inside the `codemode` description, within a 3000-token budget that every MCP server shares, so the listing can
drop them; with `deferred` nothing lists them at all.

That is what the `<memory_lite>` section is for. On a turn whose prompt does not declare the four, it names them and the
mechanism that reaches them in the running session. `tool_search` is named only when the exposure is `codemode` or
`deferred`: that tool indexes exactly those two and never `direct`, so in a session whose declarations were taken away
another way a search could not return them. It is also named only when the session registry holds the four, since it can
find nothing the registry does not list: an explicit `-t` allowlist that leaves them out lands in the unreachable case
instead, even with `tool_search` active. A codemode script is named instead when `codemode` is active, since
`searchTools("memory")` and `ALL_TOOLS` find them there, and it is the only one of the two that reaches a `direct` tool
that the prompt does not declare. When neither can reach them the section says that they are unreachable, and names the
ways out: enable `tool_search` (`"defaultTools": ["+tool_search"]`), enable `codemode`
(`"defaultTools": ["+codemode"]`), set `exposure` back to `direct`, or check the `tools` allowlist of the session. The
allowlist is the case no exposure setting repairs: a `-t` list that leaves one of the four out removes it from the
session registry, so it is neither declared, nor callable from a script, nor visible to `tool_search`.

The section is added on the turn it is needed and removed once the four are declared, so it costs one patch to the system
message and nothing per turn. It never carries memory content: it names the tools, and the memory itself enters the
context only when a tool is called and answers.

A session with no way in is not repaired by the package. It is reported: the section in the prompt, and once per instance
a warning with the same words. That is the promise — never silently unusable — and it is why the two non-default modes
are opt-in.

## Where the data lives

One SQLite database at `<agentDir>/lite-memories/memory.db`, in WAL mode, where `agentDir` is pi's agent directory:
`~/.pi/agent` unless `PI_CODING_AGENT_DIR` says otherwise. The directory is created the first time a tool opens the
database, with mode 0700; a directory that already exists is left as it is. `PI_MEMORY_LITE_DIR` overrides the directory and so does the `dir` setting; the environment wins over the
setting, and the setting wins over the default. Since the memory is global, deleting that file deletes the memory.

## What to save

Durable facts a later session would otherwise have to rediscover, preferences of the person you work with, decisions
with the reason behind them, and notes about the environment: paths, versions, the shape of a machine.

Never secrets. Not tokens, not passwords, not keys, not anything that would be a problem in a transcript you might
share. `memory_write` rejects a text that looks like an AWS key, a GitHub token, a private key, a Slack token or a
`password=value` pair, and never echoes the match back. The password value must be 6 or more characters and include a
digit or a symbol, so a note saying where a password lives ("password: stored in Vault") is still saved; a password
made only of letters is not caught. It is a safety net for the obvious cases, not a scanner.

The memory is curated by hand. There is no automatic write at the end of a turn, no summarisation and no
consolidation: what is in it is what someone chose to put there. Correcting an entry means deleting it and writing it
again, which gives it a new id. From schema version 2 on, an id is never handed out twice, so an id quoted in an older part of a transcript is either
still the entry it named or absent; it never points at a different text. The one exception is a database migrated from
version 1 (see Upgrading).

A write whose text is already stored writes nothing new: the keys it brings are merged into the existing entry, and
the reply names the keys added and any cut by the limit of 8. After a new entry is saved, the reply may end with
`Similar: #a, #b` (up to three entries that share keys with it), so a redundant one can be read and deleted.

The skill that ships with the package carries the triggers behind that list, for the model rather than for the person
reading this: see [The skill](#the-skill).

## The skill

`skills/memory-lite/SKILL.md` travels with the package. It holds when to write without being asked, when to search
before starting or before writing, what never goes in, and the mechanics of a write: one fact per entry, the session's
category vocabulary, one to three slug keys, a soft ceiling of ten unrequested writes per session, one line announced
per write. The four tools say what a call takes and returns; the skill says when to make one, so the two do not repeat
each other.

A skill is advertised by its name and its description, and that pair stays in the system prompt of every session that
has the package installed. The cost is paid by all of them: by `codemode` and `deferred`, where the guidance is worth
something, and by `direct` too, where the four tools are already declared and the skill changes nothing about how they
arrive. The body is only read on demand, and `/skill:memory-lite` forces it when a session has to be sure. Like the
tool descriptions, the skill adds no memory content to the prompt.

## Privacy

The memory is global, in the sense that every session of every project on the machine can read it. That is the point,
and it is also the risk: a fact saved while working on one project is visible while working on another.

The `env` category is the natural place for paths, versions and machine notes, and the wrong place for anything that
authenticates. `memory_search` with no query shows at a glance what the memory knows, with the count of each category, and `memory_delete` removes an
entry for good: there is no trash and no undo.

## Search

`memory_search` with a query matches every word, and a word of three or more characters also matches as a prefix
(`deploy` finds `deployments`). When no entry matches all the words, it falls back to entries that match any word and
says so in a note. A result row carries the whole text when it fits and otherwise a clip cut at a word boundary with an
ellipsis; ranked snippets are 32 tokens and the degraded fragment 240 characters. There is no `count_only`: the catalog
(no query) already shows the counts. Catalog lines do not start with `#`, which is left to ids. A `memory_read` that
hits its cap ends with a marker asking to read fewer ids at once.

## Upgrading

0.3.0 moves the database to schema version 2 (`AUTOINCREMENT`, so an id is never handed out twice from then on). The migration copies the
tables and marks the index for a rebuild on the next open with FTS5. A version 1 file keeps no record of deleted ids, so
numbering continues after the highest id still present: an entry deleted before the upgrade whose id was above every
remaining one can get that id again, once, exactly as it could under version 1. A 0.2.x build refuses a version 2 database, so
update every install that shares the directory.

## Requirements

Node 22.14 or newer, which is what `node:sqlite` needs; the 23 line needs 23.5, because 23.0 to 23.4 still hide the
module behind a flag a session does not pass. On an older Node the four tools are still registered, and every call
answers with a message naming the version it found instead of failing while the extension loads.

FTS5 is not required. It is detected at runtime on a throwaway in-memory connection, because some Node builds carry
the flag in `compile_options` and not the module. When the binary lacks FTS5, search degrades to a scan over the text
and the keys that folds accents with a deterministic SQL function: results come newest first instead of by relevance, and everything else, including finding an entry by a
key its text does not contain, keeps working. Writes made in that window are indexed automatically the next time a
binary with FTS5 opens the database.

There are no npm dependencies, no native addon, no server and no background process.

## Why another memory package

The packages found first take a different route: `pi-memory` writes memory into the system prompt, `pi-hermes-memory`
depends on a native addon, and `gentle-engram` runs a local HTTP server. This package does none of the three.

## License

MIT. The source is at [github.com/piousp/llm-skills](https://github.com/piousp/llm-skills), in `pi-memory-lite/`.
