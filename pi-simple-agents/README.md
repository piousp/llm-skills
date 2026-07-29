# pi-simple-agents

[![npm version](https://badge.fury.io/js/pi-simple-agents.svg)](https://badge.fury.io/js/pi-simple-agents)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**pi-simple-agents** is a sub-agent system for [pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent). It lets you define reusable agents as `.md` files and run them from any pi skill or session via the `subagent` tool.

## Installation

```bash
pi install npm:pi-simple-agents
```

Once installed, pi automatically loads the extension and registers the `subagent` tool. No additional configuration is required.

## How it works

Agents are defined as Markdown files with YAML frontmatter. Each file describes an agent: its name, which tools it can use, which model runs it, and the system prompt that defines its behavior.

pi-simple-agents looks for these files in `~/.pi/agent/agents/` and exposes them as the `subagent` tool.

## Defining agents

Create a `.md` file in `~/.pi/agent/agents/`. The YAML frontmatter defines the configuration, and the body is the system prompt.

### Example: scout agent (`~/.pi/agent/agents/scout.md`)

```markdown
---
name: scout
description: >
  Fast codebase recon — finds files, symbols, patterns, and references.
  No analysis, no evaluation, no implementation. Returns compressed
  findings (file paths, line numbers, excerpts) to the caller.
tools: read, grep, find, ls
systemPromptMode: append
inheritProjectContext: false
---

You are **scout**, a fast codebase reconnaissance agent. Your job is to
receive a search query and return compressed findings: file paths, line
numbers, and relevant excerpts. You do not analyze, evaluate, or implement
— you only locate and report.

## How you work

1. **Understand what to search for.** Read the prompt. Identify:
   - What files, symbols, patterns, or references you need to find
   - Where to look (directories, extensions, file names)
   - How to narrow results (avoid noise)

2. **Search intelligently.** Prefer search tools over reading entire files:
   - `grep` for text patterns, symbols, imports, references
   - `find` / `glob` for locating files by name or extension
   - `read` only to confirm specific lines you need
   - `ls` to explore directory structure

3. **Compress findings.** Do not return full files or extensive dumps.
   Report only:
   - File path and line number
   - Relevant excerpt (1-5 lines of context)
   - What you found there

## Rules

- **Read-only and search only.** Do not edit, write, or execute commands
  that alter the system. Only use `read`, `grep`, `find`, `ls`.
- **One task at a time.** The prompt contains exactly one query. Do not
  invent additional searches or anticipate next steps.
- **Prefer precision over exhaustiveness.** Better 3 exact results than 30
  with noise. If the query is ambiguous, ask for clarification before
  searching blindly.
- **Do not interpret or evaluate.** Report what you found, not what you
  think.
- **If you find nothing, say so.** "No results found" is a valid answer.

## Output format

Always end with a structured summary:

```
## Search Results

**Query:** <one line restating what was asked to find>

**Files found:** <N>

**Findings:**

<path/file>:<line>
  <code snippet>
  → <what it is>

**Status:** FOUND | NOT_FOUND | PARTIAL
```
```

### Example: web-scout agent (`~/.pi/agent/agents/web-scout.md`)

```markdown
---
name: web-scout
description: Fast web searcher — runs 2 parallelizable queries, picks the best source, returns direct results
tools: web_search, web_read
systemPromptMode: replace
inheritProjectContext: false
---

You are a fast web search agent. Your task is to find information on the
web and return it directly and concisely.

- Short answers, no filler, no generic introductions.
- No emojis, no embellishments.

## Process

1. Run **2 web_search** queries with different angles on the topic.
2. Review both result sets and pick the most promising URL (the one
   giving the most direct, current, and authoritative answer).
3. Read that URL with **web_read**.
4. Return the information found. No report structure, no source metadata.
   Just the data.

## Rules

- Do not fabricate sources or URLs.
- No second pass or additional searches.
- If nothing useful is found, say so clearly.
- Prefer depth over breadth: one well-read source over three snippets.

## Hard limits

- Only use web_search and web_read. Do not use write, bash, or any other
  tool.
- Do not modify any files.
- Maximum 2 web_search and 1 web_read per invocation.
```

## Using the `subagent` tool

Once installed and your agents are defined, you can invoke them from any pi session.

### Single mode — one agent, one task

```
subagent agent: "scout", task: "Find all functions that use fetch() in src/"
```

The `scout` agent runs, does its work, and returns the result.

### Parallel mode — multiple agents simultaneously

```
subagent tasks: [
  agent: "scout", task: "List all .ts files in src/"
  agent: "web-scout", task: "Find the latest version of the API docs"
]
```

pi-simple-agents runs agents in parallel (max 4 concurrent) and returns all results.

## Frontmatter fields

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | string | — **(required)** | Agent name. Used to reference it in `subagent`. |
| `description` | string | — **(required)** | Short description visible in the UI. Also used to build the `subagent` tool's description shown to the model (a `name: description` line per discovered agent), computed once when the pi session starts — agents added or renamed while pi is running aren't reflected until restart. |
| `tools` | list | `[]` | Tools the agent is allowed to use. Comma-separated in YAML. Accepts pi tool names or Claude Code tool names (see [Claude Code compatibility](#claude-code-compatibility)). |
| `disallowedTools` | list | `[]` | Tools the agent is denied, applied after `tools`. Comma-separated in YAML. Same name compatibility as `tools`. Forwarded to the SDK as `excludeTools`. |
| `model` | string | *inherited from parent session* | Model to use, in `provider/modelId` form, e.g. `openrouter/gpt-4o`. Claude Code model aliases (`sonnet`, `opus`, `haiku`, `fable`, `inherit`) are also accepted but have no effect on model resolution — see [Claude Code compatibility](#claude-code-compatibility). |
| `systemPromptMode` | `append` or `replace` | `append` | `append`: the agent's system prompt is added to the parent session context. `replace`: replaces the entire system context. |
| `inheritProjectContext` | boolean | `true` | If `false`, the agent starts without loading project context files (AGENTS.md, CLAUDE.md, etc.). |
| `inheritSkills` | boolean | `true` | If `false`, the agent does not inherit the parent's active skills. |
| `inheritExtensions` | boolean | `true` | If `false`, the agent starts without loading pi extensions. |
| `defaultReads` | list | `[]` | Files to pre-load into the agent's context on startup. Relative paths resolve against the **invocation's cwd** (not the agent's `.md` file location); `~`/`~/...` expands to the home directory; absolute paths pass through unchanged. A missing, unreadable, or non-regular-file entry produces a warning and is skipped — the rest of the list still loads. Duplicate entries (same resolved path) are deduped, first occurrence wins. |
| `defaultContext` | `forked` or `fresh` | `fresh` | `fresh`: starts with an empty conversation (default). `forked`: attempts to copy the parent session's conversation history via a real persisted session under `~/.pi/agent/sessions/subagents/`. If the parent session isn't persisted, or the fork fails, it falls back to `fresh` with a warning — a subagent run never fails because of this. |
| `thinking` | string | *inherited* | Thinking budget level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `skills` | list | *inherited* | Explicit whitelist of skills to load, matched by exact, case-sensitive name against the inherited set. When set, overrides automatic inheritance; requested names with no match produce a warning per run. Setting `skills` together with `inheritSkills: false` is contradictory config — it produces a warning and the filter is ignored. **Limitation:** the filter narrows *which* skills are available, but still doesn't preload the named skills' content into the subagent's context — this is not the same as Claude Code's skill-preload semantics. |

## Claude Code compatibility

Frontmatter values are parsed as real YAML. If a scalar value (like `description`) contains an
unquoted colon followed by a space (e.g. `description: Use when: X happens`), strict YAML parsing
fails on that colon; pi-simple-agents then auto-quotes the offending line and retries once, so the
agent still loads, with a warning naming the recovered field. The safe/recommended practice is to
quote such values yourself to avoid the warning: `description: "Use when: X happens"`. Similarly,
an unquoted `#` inside a value is treated as a YAML comment and silently truncates everything after
it — this is detected (not auto-repaired, since a `#` might be intentional) and produces a warning;
quote the value if the `#` is meant to be literal text.

Agent files written for Claude Code's subagent frontmatter format (`.claude/agents/*.md`) load and
run unchanged as pi-simple-agents agents. Compatibility is **one-directional**: Claude → pi. The
reverse isn't guaranteed — pi's own extension fields (`systemPromptMode`, `inheritProjectContext`,
`defaultReads`, `thinking`, `inheritSkills`, `inheritExtensions`, `defaultContext`) have no Claude
Code equivalent and are ignored by Claude Code.

### Tool name mapping

`tools` and `disallowedTools` accept Claude Code's capitalized tool names and map them to pi's
tool names. Any other name (already a lowercase pi name, or unrecognized) passes through
unchanged. Duplicates after mapping are deduped.

| Claude Code name | pi name |
|---|---|
| `Read` | `read` |
| `Grep` | `grep` |
| `Glob` | `find` |
| `Bash` | `bash` |
| `Write` | `write` |
| `Edit` | `edit` |
| `MultiEdit` | `edit` |
| `LS` | `ls` |
| `WebSearch` | `web_search` |
| `WebFetch` | `web_read` |

Some Claude Code tool names have no pi equivalent (`Task`, `TodoWrite`, `NotebookEdit`,
`SlashCommand`, `KillShell`, `BashOutput`, `ExitPlanMode`, `AskUserQuestion`). They pass through in
the `tools`/`disallowedTools` array unchanged (harmless — the SDK is unlikely to ever match them)
and are reported in the aggregated inert-fields warning below, not per file.

### Model aliases

`model` accepts Claude Code's model aliases (`sonnet`, `opus`, `haiku`, `fable`) and `inherit`.
`inherit` normalizes to using the session's default model, same as omitting `model` entirely.
Aliases are **not** resolved to a real model ID — pi has no such registry lookup — they pass
through as literal strings. Model resolution only acts on values containing a `/`
(`provider/modelId` form), so a bare alias like `sonnet` degrades gracefully to "use the session's
default model," the same mechanism as `inherit`. **To force a specific model, use pi's
`provider/modelId` format, not a bare Claude Code alias** — e.g. `openrouter/anthropic/claude-sonnet-4-20250514`
instead of `sonnet` or `claude-sonnet-4-20250514`.

### Inert fields

These Claude Code frontmatter fields are accepted without error and their values are preserved on
the parsed frontmatter, but they have no functional effect in pi: `permissionMode`, `maxTurns`,
`mcpServers`, `hooks`, `memory`, `background`, `isolation`, `color`, `effort`, `initialPrompt`.

Inert fields, inert tool names, and model aliases are reported together in one aggregated
`console.warn`, at most once per 60 seconds (not per file), e.g.:

```
pi-simple-agents: accepted but inert in pi — fields: maxTurns, permissionMode; tools: Task;
model aliases: sonnet (Claude Code compatibility)
```

## Overriding agent configuration (overrides)

You can change any agent field from `settings.json` without modifying the original `.md` file. This is useful for, say, using a more powerful model in a specific project without altering the shared agent definition.

### Configuration files

pi-simple-agents looks for overrides at two levels, merging them:

1. **User level:** `~/.pi/agent/settings.json`
2. **Project level:** `{project-folder}/.pi/settings.json`

Project values take precedence over user values.

### Format

Use either the `pi-simple-agents.agentOverrides` or `subagents.agentOverrides` key (both work):

```json
{
  "pi-simple-agents": {
    "agentOverrides": {
      "scout": {
        "model": "openrouter/anthropic/claude-sonnet-4-20250514",
        "thinking": "high"
      }
    }
  }
}
```

> `model` must use pi's `provider/modelId` form to actually take effect. A bare Claude Code model
> name or alias (no `/`) is accepted without error but has no effect on model resolution — see
> [Claude Code compatibility](#claude-code-compatibility).

### Precedence rules

```
Project  >  User  >  Frontmatter (.md file)
```

Merge is field-level. If the project override only changes `model`, the rest of the fields defined in the user override or frontmatter are preserved.

### Complete example

**Base definition** (`~/.pi/agent/agents/scout.md`):

```markdown
---
name: scout
description: Code explorer
tools: read, grep, find, ls
model: openrouter/anthropic/claude-haiku-4-5
---
...
```

**User override** (`~/.pi/agent/settings.json`):

```json
{
  "pi-simple-agents": {
    "agentOverrides": {
      "scout": {
        "model": "openrouter/anthropic/claude-sonnet-4-20250514",
        "thinking": "low"
      }
    }
  }
}
```

**Project override** (`{project}/.pi/settings.json`):

```json
{
  "subagents": {
    "agentOverrides": {
      "scout": {
        "model": "openrouter/gpt-4o"
      }
    }
  }
}
```

**Final result for scout:**
- `model` → `openrouter/gpt-4o` (from project, wins by precedence)
- `thinking` → `low` (from user, project didn't touch it)
- `tools`, `description`, etc. → from frontmatter (no override modified them)

## Example agents

The package ships two ready-to-use example agents in `agents-examples/`:

- **`scout.md`** — fast codebase reconnaissance agent (read-only, compressed findings)
- **`web-scout.md`** — fast web search agent (web_search + web_read)

You can symlink them into your agents directory, or use them as templates
for your own agents:

```bash
ln -s /path/to/pi-simple-agents/agents-examples/scout.md ~/.pi/agent/agents/scout.md
ln -s /path/to/pi-simple-agents/agents-examples/web-scout.md ~/.pi/agent/agents/web-scout.md
```

For more examples, see the [agents-examples](./agents-examples) directory
in this repository.

## Limits

- **Maximum 8 tasks** per call in parallel mode.
- **Maximum 4 agents** running concurrently.
- Agents run inside a pi SDK session with proper resource handling, context management, and cleanup.

## License

MIT
