# pi-simple-agents

[![npm version](https://badge.fury.io/js/pi-simple-agents.svg)](https://badge.fury.io/js/pi-simple-agents)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Subagents for [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent). Write an agent as a Markdown file, then call it from any pi session with the `subagent` tool.

## Install

```bash
pi install npm:pi-simple-agents
```

Needs pi 1.0.4 or later.

## Define an agent

Put a Markdown file in `~/.pi/agent/agents/`. The frontmatter sets the name and the tools; the body is the system prompt.

```markdown
---
name: scout
description: Codebase explorer
tools: read, grep, find, ls
---
Explore the codebase and report findings, compressed and read-only.
```

## Use it

Ask for it in plain words:

```
Use the agent scout to find all the functions that use fetch in src
```

Or call the tool directly:

```
subagent agent: "scout", task: "Find all functions that use fetch() in src/"
```

Each call starts its own background job (see below), so running several at once just means calling `subagent` once per task:

```
subagent agent: "scout", task: "List all .ts files in src/"
subagent agent: "web-scout", task: "Find the latest version of the API docs"
```

A call can override `model`, `tools`, `skills`, `thinking`, `maxTurns` and `timeoutMs` for that run only.

## Background jobs

`subagent` never waits for a run to finish. A call answers in the same turn with a job id (`S1001`, `S1002`, …) and runs the task in the background. When the run settles, its result arrives as its own message and the model gets a follow-up turn to act on it, unless the job was cancelled.

Jobs live in memory: nothing carries over after a restart. While at least one is running, a panel below the editor shows a line per job with a one-word status. The word is the tool currently executing (`read`, or `playwright` for `mcp__playwright__navigate`), `thinking` or `output` while only the model streams, `waiting` before the first signal. The panel disappears once nothing is running.

## The /subagents command

With no id, `status` and `peek` pick the single active job on their own (several actives ask for an id); `status` also falls back to the newest finished one when nothing is active.

- `/subagents` lists running and recently finished jobs, newest first, with a usage footer once a job settles.
- `/subagents status [id]` details one job: the current activity, the last tool calls of the run, and usage so far.
- `/subagents peek [id]` opens a live window over one job: streamed text, the tail of the agent's thinking, and tool calls with their results. `w` alternates between the floating window and fullscreen; Esc or `q` closes it. Needs an interactive TUI session; other modes get a warning.
- `/subagents cancel [id]` stops a running job.
- `/subagents clear` drops finished jobs from the list.
- `/subagents session` reports what the session's subagent runs spent, reconstructed from the child sessions persisted on disk: token totals with a cache hit rate, cost per model, and one line per agent, like `scout: 3 runs, 1.2M tokens, $0.980`. The current session must be persisted to disk; otherwise the command warns and exits.

## MCP tools

Subagents use pi's built-in MCP (`~/.pi/agent/mcp.json`). `pi-mcp-adapter` is not supported.

If the agent has a `tools` list, name each MCP tool exactly as pi registers it, `mcp__<server>__<tool>`. `mcp__<server>__*` brings in every tool of that server. A tool left off the list doesn't exist for that agent, not even through `tool_search` or `codemode`:

```
subagent agent: "worker", task: "Compile the project", tools: ["read", "mcp__mde-build__mvn"]
```

A server with `"exposure": "deferred"` also needs `tool_search` in the list, and one with the default `codemode` exposure needs `codemode`. An agent with no `tools` list gets every tool the session has. [docs/REFERENCE.md](docs/REFERENCE.md#mcp-tools-in-subagents) has the details.

## More

- [docs/REFERENCE.md](docs/REFERENCE.md): frontmatter fields, per-call overrides, `settings.json` overrides, Claude Code compatibility, limits.
- [DEVELOPER.md](DEVELOPER.md): internals and tests.
- `agents-examples/` ships two sample agents, `scout` and `web-scout`.
- The bundled `invoking-subagents` skill teaches the model how to call the tool (`/skill:invoking-subagents`).

## License

MIT
