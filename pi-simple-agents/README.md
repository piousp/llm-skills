# pi-simple-agents

[![npm version](https://badge.fury.io/js/pi-simple-agents.svg)](https://badge.fury.io/js/pi-simple-agents)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A subagent plugin for [pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent). Define reusable agents as Markdown files and call them from any pi session with the `subagent` tool.

## Install

```bash
pi install npm:pi-simple-agents
```

That's it. The extension loads and registers the `subagent` tool.

## Define an agent

Drop a Markdown file in `~/.pi/agent/agents/`. The YAML frontmatter sets the name, the tools, and the model. The body is the system prompt.

```markdown
---
name: scout
description: Codebase explorer
tools: read, grep, find, ls
---
Explore the codebase and report findings, compressed and read-only.
```

Every agent in that directory shows up in the `subagent` tool, ready to call.

## Use it

Single agent, single task:

```
subagent agent: "scout", task: "Find all functions that use fetch() in src/"
```

Or just say it:

```
Use the agent scout to find all the functions that use fetch in src
```

Parallel: several agents in one call, all results come back together:

```
subagent tasks: [
  agent: "scout", task: "List all .ts files in src/"
  agent: "web-scout", task: "Find the latest version of the API docs"
]
```

## Per-call options

Both modes accept optional overrides: `model`, `tools`, `skills`, `thinking`, `maxTurns`, `timeoutMs`. They apply to that one call and beat anything configured elsewhere.

```
subagent agent: "scout", task: "...", model: "anthropic/claude-opus-4-8", maxTurns: 5
```

In parallel mode, the options go inside each task entry.

## Example agents

The package ships two: `scout` (read-only codebase recon) and `web-scout` (web search). Symlink them into your agents folder to try them:

```bash
ln -s /path/to/pi-simple-agents/agents-examples/scout.md ~/.pi/agent/agents/scout.md
ln -s /path/to/pi-simple-agents/agents-examples/web-scout.md ~/.pi/agent/agents/web-scout.md
```

## Bundled skill

`invoking-subagents` loads automatically with the package. It covers both modes and every override. Run `/skill:invoking-subagents` to read it.

## Configuration

Agents are plain files, so any field can be overridden per project from `settings.json` without touching the `.md`. See [docs/REFERENCE.md](docs/REFERENCE.md) for the full field list and precedence rules. That file also holds the Claude Code compatibility notes: agents written for Claude Code's `.claude/agents/*.md` format load unchanged, and its tool names and model aliases are accepted.

## Limits

Up to 8 agents per call, up to 8 running at once (default 4 concurrent).

## License

MIT

---

Frontmatter fields, Claude Code compatibility, settings.json overrides, known limitations, and the live-stream and usage-footer UI live in [docs/REFERENCE.md](docs/REFERENCE.md).
