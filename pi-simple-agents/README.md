# pi-simple-agents

[![npm version](https://badge.fury.io/js/pi-simple-agents.svg)](https://badge.fury.io/js/pi-simple-agents)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**pi-simple-agents** is a sub-agent system for [pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent). It lets you define reusable agents as `.md` files and run them from any pi skill or session via the `subagent` tool.

## Installation

```bash
npm install pi-simple-agents
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
| `description` | string | — **(required)** | Short description visible in the UI. |
| `tools` | list | `[]` | Tools the agent is allowed to use. Comma-separated in YAML. |
| `model` | string | *inherited from parent session* | Model to use. E.g. `claude-sonnet-4-20250514`, `openrouter/gpt-4o`. |
| `systemPromptMode` | `append` or `replace` | `append` | `append`: the agent's system prompt is added to the parent session context. `replace`: replaces the entire system context. |
| `inheritProjectContext` | boolean | `true` | If `false`, the agent starts without loading project context files (AGENTS.md, CLAUDE.md, etc.). |
| `inheritSkills` | boolean | `true` | If `false`, the agent does not inherit the parent's active skills. |
| `inheritExtensions` | boolean | `true` | If `false`, the agent starts without loading pi extensions. |
| `defaultReads` | list | `[]` | Files to pre-load into the agent's context on startup. |
| `defaultContext` | `forked` or `fresh` | `forked` | `forked`: copies the parent session's conversation history. `fresh`: starts with an empty conversation. |
| `thinking` | string | *inherited* | Thinking budget level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `skills` | list | *inherited* | Explicit list of skills to load. When set, overrides automatic inheritance. |

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
        "model": "claude-sonnet-4-20250514",
        "thinking": "high"
      }
    }
  }
}
```

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
model: claude-haiku-4-5
---
...
```

**User override** (`~/.pi/agent/settings.json`):

```json
{
  "pi-simple-agents": {
    "agentOverrides": {
      "scout": {
        "model": "claude-sonnet-4-20250514",
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