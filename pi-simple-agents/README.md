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
description: Fast codebase recon — finds files, symbols, and patterns
tools: read, grep, find, ls
model: claude-haiku-4-5
thinking: low
---

You are a fast recon scout. Search the codebase efficiently to answer the
question you were given — prefer grep/find over reading whole files, and
read only the specific lines or sections you need. Report compressed
findings: file paths, line numbers, and short excerpts, not full file
dumps. Do not implement or edit anything; your job is to locate and
summarize, then hand the findings back.
```

### Example: worker agent (`~/.pi/agent/agents/worker.md`)

```markdown
---
name: worker
description: General-purpose implementation agent
tools: read, bash, edit, write, grep, find, ls
model: claude-sonnet-5
---

You are a general-purpose implementation agent. Given a task, implement it
directly: read the relevant code first, make the necessary edits, and run
whatever commands are needed to verify your change. When done, report
exactly what you changed and why, referencing the files touched.
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
  agent: "worker", task: "Add tests for the auth module"
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

### Code reviewer agent

```markdown
---
name: reviewer
description: Reviews code for quality, security, and performance issues
tools: read, grep, find
model: claude-sonnet-4-20250514
thinking: high
---

You are a thorough code reviewer. Examine the code for:
1. Security issues (SQL injection, XSS, hardcoded credentials)
2. Performance problems (N+1 queries, unnecessary loops)
3. Code quality (cyclomatic complexity, dead code, naming)
4. Missing tests

Be specific: point out the file, line, and why it's a problem. Do not
suggest implementations, only flag what needs fixing.
```

### Documentation writer agent

```markdown
---
name: docwriter
description: Writes and updates technical documentation
tools: read, write, grep, find
model: claude-sonnet-4-20250514
systemPromptMode: replace
inheritProjectContext: false
---

You are a technical writer. Your task is to create clear, useful
documentation. Focus on: what each module does, how to use it, code
examples, and edge case warnings. Use a professional but accessible
tone. Do not document trivial or self-evident code.
```

## Limits

- **Maximum 8 tasks** per call in parallel mode.
- **Maximum 4 agents** running concurrently.
- Agents run inside a pi SDK session with proper resource handling, context management, and cleanup.

## License

MIT