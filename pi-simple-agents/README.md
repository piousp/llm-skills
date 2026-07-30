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

You can also symlink claude-styled agents (directory/AGENT.md)
See the `scout.md` example agent in [agents-examples/scout.md](agents-examples/scout.md)


## Using the `subagent` tool

Once installed and your agents are defined, you can invoke them from any pi session.

### Single mode — one agent, one task

```bash
subagent agent: "scout", task: "Find all functions that use fetch() in src/"
```

The `scout` agent runs, does its work, and returns the result.

You can of course, just talk to the LLM:

```bash
Use the agent scout to find all the functions that use fetch in src
```

### Parallel mode — multiple agents simultaneously

```bash
subagent tasks: [
  agent: "scout", task: "List all .ts files in src/"
  agent: "web-scout", task: "Find the latest version of the API docs"
]
```

Natural language example:

```bash
Use 2 agents in parallel: one scout to find all .ts files in src and one web-scoutto find the latest version of the API docs
```

pi-simple-agents runs agents in parallel and returns all results.

### Overriding the model per invocation

Both modes accept an optional `model` param, in `provider/modelId` form (e.g.
`"anthropic/claude-opus-4-8"`). Multiple slashes are valid — the first segment is the provider,
the rest is the model ID (e.g. `"openrouter/anthropic/claude-sonnet-4-5"`).

In single mode, `model` is a top-level param:

```bash
subagent agent: "scout", task: "Find all functions that use fetch() in src/", model: "anthropic/claude-opus-4-8"
```

It can also be done by natural language:

```bash
Use the agent scout with model "anthropic/claude-opus-4-8" to find all the functions that use fetch in src
```

In parallel mode, `model` goes inside each entry of `tasks[]` — a top-level `model` alongside
`tasks` is rejected:

```bash
subagent tasks: [
  agent: "scout", task: "List all .ts files in src/", model: "anthropic/claude-haiku-4-5"
  agent: "web-scout", task: "Find the latest version of the API docs"
]
```

As with frontmatter `model`, registry existence isn't checked — a well-formed but unknown model
silently falls back to the session default. A bare alias without a `/` (e.g. `"sonnet"`) is
rejected outright — the whole `subagent` call fails with a validation error before any agent
runs. Always use the full `provider/modelId` form — see [Model aliases](#model-aliases).

### Overriding tools per invocation

Both modes accept an optional `tools` param — an array of pi tool names. Unlike frontmatter
`tools`, this does **not** accept Claude Code tool-name aliases (`Read`, `Grep`, etc.) — that
mapping is frontmatter-only, see [Claude Code compatibility](#claude-code-compatibility). Only
native pi tool names (`read`, `grep`, `find`, `ls`, `write`, `edit`, `bash`, ...) are recognized
here.

In single mode, `tools` is a top-level param:

```
subagent agent: "scout", task: "Find all functions that use fetch() in src/", tools: ["read", "grep"]
```

In parallel mode, `tools` goes inside each entry of `tasks[]` — a top-level `tools` alongside
`tasks` is rejected:

```
subagent tasks: [
  agent: "scout", task: "List all .ts files in src/", tools: ["find", "ls"]
  agent: "web-scout", task: "Find the latest version of the API docs"
]
```

`tools` is a **total replacement**, not a merge — it does not add to or subtract from the agent's
configured tool list, it replaces it outright for that call. An explicit `tools: []` means "no
tools for this call"; omitting `tools` entirely means "use whatever settings.json/frontmatter
already resolved" — these are two different things. The `subagent` tool's call display always
shows the effective (post-override) tool list, so a call with `tools: []` renders as `tools: none`
in that line, never the agent's configured tools.

### Overriding skills per invocation

Both modes accept an optional `skills` param — an array of skill names, matched the same way as
frontmatter `skills`: an explicit whitelist, by exact case-sensitive name against the inherited
set.

In single mode, `skills` is a top-level param:

```
subagent agent: "scout", task: "Find all functions that use fetch() in src/", skills: ["tdd"]
```

In parallel mode, `skills` goes inside each entry of `tasks[]` — a top-level `skills` alongside
`tasks` is rejected:

```
subagent tasks: [
  agent: "scout", task: "List all .ts files in src/", skills: ["tdd"]
  agent: "web-scout", task: "Find the latest version of the API docs"
]
```

As with `tools`, `skills` is a **total replacement**, not a merge. An explicit `skills: []` means
"no skills for this call"; omitting `skills` means "inherit whatever settings.json/frontmatter
already resolved." This has the same limitation as the frontmatter `skills` field (see
[Frontmatter fields](#frontmatter-fields) above): the whitelist narrows *which* skills are
available, but doesn't preload the named skills' content into the subagent's context.

### Bundled skill: `invoking-subagents`

The package ships a self-discovering Agent Skill at
[skills/invoking-subagents/SKILL.md](./skills/invoking-subagents/SKILL.md) that teaches single and
parallel invocation and the `model`, `tools`, and `skills` overrides. It loads automatically once
the package is installed, and can also be invoked explicitly as `/skill:invoking-subagents`.

While a subagent runs, the `subagent` tool's call display shows a live status line per task:
`<agent> · tools: <N> · <status>`, where `<status>` is `working…` (no tool started yet),
`running: <tool1, tool2, ...>` (tools currently executing, in start order — parallel tool calls
within one agent are possible), or `done` (the task has settled).

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
      },
      "planner": {
        "thinking": "xhigh",
        "timeoutMs": 1800000
      }
    }
  }
}
```

> `model` must use pi's `provider/modelId` form to actually take effect. A bare Claude Code model
> name or alias (no `/`) is accepted without error but has no effect on model resolution — see
> [Claude Code compatibility](#claude-code-compatibility).

> `timeoutMs` (number, milliseconds) bounds how long a subagent run may take before it's aborted.
> It's settings-only — there's no frontmatter equivalent. Default when unset: `600000` (10
> minutes). An invalid value (`0`, negative, `NaN`, `Infinity`, or a non-numeric value from raw
> JSON) falls back to the default with a `console.warn`. On expiry, the run settles as an error
> (`"timed out after <N>ms"`) and any partial output is discarded — it is not returned as a
> truncated success. The example above raises `planner`'s timeout to 30 minutes for a
> heavy-thinking, long-running agent. It bounds only the model/prompt execution phase — session
> creation and resource-loader setup happen before the timer starts and are not covered.

### Concurrency

The `pi-simple-agents.concurrency` (or `subagents.concurrency`) key, set alongside
`agentOverrides` in the same `settings.json` files, controls how many subagent tasks a single
`subagent` tool call runs in parallel. Default when unset: `4`. It's effectively capped at `8`,
since a call can't have more than `MAX_PARALLEL_TASKS` (8) tasks to begin with — `concurrency`
only throttles how many of those run at once, it isn't a separate, independent limit. An invalid
value (not a positive integer) falls back to the default with a `console.warn`.

```json
{
  "pi-simple-agents": {
    "concurrency": 6
  }
}
```

Same precedence as `agentOverrides`: project settings (`{project-folder}/.pi/settings.json`)
override user settings (`~/.pi/agent/settings.json`) when both set it.

### Precedence rules

```
Invocation (subagent call)  >  Project settings  >  User settings  >  Frontmatter (.md file)
```

Merge is field-level: each present field replaces independently, and any field left absent falls
through to the next-lower precedence layer. Invocation-level overrides cover `model` (see
[Overriding the model per invocation](#overriding-the-model-per-invocation)), `tools` (see
[Overriding tools per invocation](#overriding-tools-per-invocation)), and `skills` (see
[Overriding skills per invocation](#overriding-skills-per-invocation)) — each overrides only its
own field for that one call. `thinking` and `disallowedTools` are **not** overridable at
invocation level — they can only be changed via settings-level `agentOverrides` or frontmatter,
which can override any field, including those two.

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

- **Maximum 8 tasks** per call in parallel mode (`MAX_PARALLEL_TASKS`).
- **Up to 8 agents running concurrently** — controlled by the `concurrency` setting (default 4,
  see [Concurrency](#concurrency)); it can never exceed the 8-task-per-call limit above.
- Agents run inside a pi SDK session with proper resource handling, context management, and cleanup.

## For developers

If you're integrating `pi-simple-agents` programmatically (importing its internal functions,
contributing to the package, or just want the low-level API reference), see
[DEVELOPER.md](./DEVELOPER.md).

## License

MIT
