# pi-simple-agents

Minimal subagent delegation for pi. Spawns Claude-Code-compatible agent `.md`
files as subagent processes, in single or parallel mode, and blocks until
their result is ready. No chains, no coordinators, no TUI-heavy
orchestration — just run agents and get their results back.

## Tools

- **`subagent`** — run one or more subagents and wait for their results.
  - Single: `{ agent: string, task: string }` — blocks until the agent
    finishes and returns its final answer.
  - Parallel: `{ tasks: [{ agent: string, task: string }, ...] }` — runs all
    tasks concurrently and blocks until every task finishes, returning all
    results together.

## Agent file format

Agent `.md` files live in `~/.pi/agent/agents/` and use YAML frontmatter plus
a body that becomes the agent's system prompt:

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

`name`, `description`, `tools`, and `model` are Claude Code compatible — an
unmodified Claude Code agent file works as-is. `systemPromptMode`,
`inheritProjectContext`, and `defaultReads` are pi-simple-agents extensions;
they're optional and ignored by plain Claude Code.

See `agents-examples/scout.md` and `agents-examples/worker.md` for working
examples.

## Installing an example agent

Copy or symlink an example into your agents directory:

```sh
ln -sf "$(pwd)/agents-examples/scout.md" ~/.pi/agent/agents/scout.md
```

## Overriding agent config

Override any agent field per-user or per-project without editing the `.md`
file, via `settings.json`:

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

## Installing the package

Two options, either works:

- Reference this directory from your `packages` array in `settings.json`
  using a `file:` path.
- Symlink this directory into `~/.pi/agent/npm/node_modules/pi-simple-agents/`.
