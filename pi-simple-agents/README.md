# pi-simple-agents

Minimal subagent delegation for pi. Spawns Claude-Code-compatible agent `.md`
files as subprocesses, in single or parallel mode, and blocks until results
are ready. No chains, no coordinators, no TUI-heavy orchestration — just run
agents and get their answers back.

## Installation

```sh
pi install npm:pi-simple-agents
```

## Capabilities

- **`subagent` tool** — extension tool that registers automatically in pi.
  Runs agent `.md` files as subprocesses.

- **Single / Parallel** — one agent at a time (`{ agent, task }`) or multiple
  in parallel (`{ tasks: [{ agent, task }, ...] }`). In parallel mode, all
  agents run concurrently and results are returned together.

- **Streaming progress** — in parallel mode, each agent's text output is
  streamed as real-time partial progress of the tool.

- **Claude Code compatible agent format** — `name`, `description`, `tools`,
  `model` work as-is. Optional pi-simple-agents extensions:
  `systemPromptMode`, `inheritProjectContext`, `defaultReads`.

- **Agent overrides** — override `model` or other fields per agent from
  `settings.json` without editing the `.md` file.

- **Validation** — parses and validates frontmatter, input parameters, and
  agent resolution before execution.

## Tools

### `subagent`

Tool registered by the extension. Two modes:

**Single:**

```json
{
  "agent": "scout",
  "task": "Find documentation for the payment API"
}
```

**Parallel:**

```json
{
  "tasks": [
    { "agent": "scout", "task": "Find payment API docs" },
    { "agent": "worker", "task": "Implement auth stub" }
  ]
}
```

## Agent file format

Agents live in `~/.pi/agent/agents/` and use YAML frontmatter plus a body
that becomes the system prompt:

```yaml
---
name: scout                    # required
description: ...                # required
tools: read, grep, find, ls     # optional, comma-separated
model: claude-haiku-4-5         # optional
systemPromptMode: append        # optional: "append" | "replace" (default: append)
inheritProjectContext: true     # optional: boolean (default: true)
defaultReads: path/one, path/two # optional, comma-separated
---
Body text becomes the system prompt.
```

`name`, `description`, `tools`, `model` are Claude Code compatible. The rest
are pi-simple-agents extensions, ignored by plain Claude Code.

See `agents-examples/scout.md` and `agents-examples/worker.md` for working
examples.

## Installing an example agent

```sh
ln -sf "$(pwd)/agents-examples/scout.md" ~/.pi/agent/agents/scout.md
```

## Agent overrides

Override per-agent fields from `settings.json` without editing the `.md`:

```json
{
  "pi-simple-agents": {
    "agentOverrides": {
      "scout": { "model": "claude-sonnet-5" }
    }
  }
}
```

- User-level: `~/.pi/agent/settings.json`
- Project-level: `<project>/.pi/settings.json` (wins over user-level)

## Changelog

### 0.1.1  — 2025-07-23

- Update README.md

### 0.1.0 — 2025-07-23

- Initial npm release as `pi-simple-agents`.
- `subagent` tool with single and parallel modes.
- YAML frontmatter parsing and validation for agent files.
- Claude Code compatible agent format + pi-simple-agents extensions
  (`systemPromptMode`, `inheritProjectContext`, `defaultReads`).
- Agent overrides from `settings.json`.
- Streaming progress for parallel execution.
- Unit tests.