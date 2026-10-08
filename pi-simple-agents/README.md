# pi-simple-agents

[![npm version](https://badge.fury.io/js/pi-simple-agents.svg)](https://badge.fury.io/js/pi-simple-agents)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Subagents for [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent). Write an agent as a Markdown file, then call it from any pi session with the `subagent` tool.

## Install

```bash
pi install npm:pi-simple-agents
```

Needs pi 0.99.0 or later.

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

`subagent` never waits for a run to finish. A call answers in the same turn with a job id (`S1001`, `S1002`, …) and hands the task to a background job. When the job settles, the result is delivered as its own message, and unless the job was cancelled the model gets a follow-up turn to act on it.

## The /subagents command

- `/subagents` lists running and recently finished jobs, newest first. A running entry shows the tools in flight (`running: read, grep`) or the model's streaming phase (`thinking`, `output`); a finished one shows success or failure with the usage footer.
- `/subagents status <id>` details one job. A running job shows status, elapsed time, the current activity word, the last tool call with its arguments, the last ten tool calls of the run, and usage so far. A finished job prints the same entry the list shows. An unknown id warns the same way `cancel` does.
- `/subagents cancel <id>` stops a running job.
- `/subagents clear` drops the finished ones; the 50 most recent are kept automatically anyway.

While a job runs, a panel below the editor shows one line per running job with a one-word live status: the executing tool by its own name (`read`), an MCP tool by its server name (`mcp__playwright__navigate` shows as `playwright`), `thinking` or `output` when only the model streams, `waiting` before the run emits its first signal. The word comes from real-time session events and the repaint happens only when the word changes, not per token. See [docs/REFERENCE.md](docs/REFERENCE.md#background-jobs) for formats and edge cases.

## MCP tools

Subagents use pi's built-in MCP (`~/.pi/agent/mcp.json`). `pi-mcp-adapter` is not supported.

If the agent has a `tools` list, name each MCP tool exactly as pi registers it, `mcp__<server>__<tool>`. There are no wildcards, and a tool left off the list doesn't exist for that agent, not even through `tool_search` or `codemode`:

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
