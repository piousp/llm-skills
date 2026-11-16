---
name: memory-lite
description: "When to write to global memory unprompted, when to search it, what never goes in, and how to reach its tools."
---

# Memory lite

Global memory outlives the session, and every project on the machine reads it. This file covers **when** to call it. What a call takes and what it returns is in the tool descriptions.

## Write on your own initiative

[ALWAYS] write when one of these holds and no entry already carries it:

- A working preference of the user that is not in `AGENTS.md` or in the repository.
- A design decision with its reason, when the repository records neither.
- An environment gotcha: a command that fails in a non-obvious way, a version pin, a non-standard path, a workaround that took work to find.
- A convention nobody wrote down, seen in the code or in a review comment.
- The location of an external resource that the repository does not reveal.
- A stable fact about the user's setup that changed how something was done.

## Search on your own initiative

- At the start of a task on a project or a technology the memory may have touched before. Search before investigating from zero.
- When the user says something was already discussed or already done.
- Before proposing an environment or a configuration change that may have been decided already.
- When no query word is obvious, search with no query and read the catalog: the categories, their counts, the most used keys.

## Never save

- **Secrets.** Tokens, keys, passwords, anything that authenticates, anything a shared transcript would expose.
- What the repository or `AGENTS.md` already states.
- Task state that dies with the session: what is open, what comes next.
- Long dumps: logs, file contents, whole documents.
- An assumption dressed as a fact. Write what was verified.

## Mechanics

- **One fact per entry.** Two facts in one entry cannot be corrected or deleted apart.
- **Category** from the vocabulary in force in this session.
- **One to three keys**, slugs, reusing the keys that already exist.
- Soft ceiling: **0 to 10 unrequested writes per session**. Past that, either one entry is carrying several facts or the fact is not durable.
- [ALWAYS] announce each write in one line, with the category and the keys. Permission is not asked.
- After a write, if `Similar:` lists ids, read them; if one already holds the fact, delete the redundant one. An exact duplicate only merges its new keys into the existing entry and writes nothing else.
- Correcting is delete then write. There is no update, and ids are never reused, so the corrected entry gets a new id.

## Reach the tools

The four may be missing from the prompt. Under `codemode` a script reaches them (`searchTools("memory")`, `ALL_TOOLS`); under `deferred`, `tool_search`. The `<memory_lite>` prompt section names the mechanism in force, so read it instead of guessing.
