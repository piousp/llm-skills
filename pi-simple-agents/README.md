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

`subagent` returns right away with a job id, not the result — the result is delivered later as its own message, and (unless cancelled) wakes the model up to act on it. A persistent panel shows jobs still running; `/subagents` lists running and recent ones, `/subagents cancel <id>` stops one, `/subagents clear` drops finished ones. See [docs/REFERENCE.md](docs/REFERENCE.md#background-jobs) for the full behavior.

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
