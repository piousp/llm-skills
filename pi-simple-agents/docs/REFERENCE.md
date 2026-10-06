# pi-simple-agents: Reference

Detailed usage notes for pi-simple-agents. The short introduction lives in [README.md](../README.md).

## How it works

Agents are defined as Markdown files with YAML frontmatter. Each file describes an agent: its name, which tools it can use, which model runs it, and the system prompt that defines its behavior.

pi-simple-agents looks for these files in `~/.pi/agent/agents/` and exposes them as the `subagent` tool.

## Directory-style agents

`<agentsDir>/<name>/AGENT.md` is discovered directly, no symlink required. The agent's name comes from frontmatter `name:`, falling back to the directory's basename if absent. You can also symlink a directory into `agentsDir` to reuse an agent defined elsewhere. If both a flat `<name>.md` and a directory `<name>/AGENT.md` resolve to the same name, one is kept and a warning is logged: don't define an agent both ways. The winner is deterministic: entries are sorted alphabetically by filename before dedup, so the alphabetically-first source always wins, regardless of the filesystem's raw directory-listing order. The duplicate-agent warning is throttled the same way as other pi-simple-agents warnings, so repeated discovery calls within the throttle window won't spam repeated warnings for the same collision.

Note: the manifest filename (`AGENT.md`) is matched case-sensitively by design. Name it exactly `AGENT.md`, since a typo'd case (e.g. `agent.md`) can silently fail to match on case-sensitive filesystems (Linux) even though it appears to work on case-insensitive ones (macOS/Windows).

## Per-call overrides, in detail

The `subagent` tool accepts optional per-invocation overrides: `model`, `tools`, `skills`, `thinking`, `maxTurns`, and `timeoutMs`. They apply to one call and take precedence over every other configuration layer.

### Overriding the model per invocation

`subagent` accepts an optional `model` param, in `provider/modelId` form (e.g. `"anthropic/claude-opus-4-8"`). Multiple slashes are valid: the first segment is the provider, the rest is the model ID (e.g. `"openrouter/anthropic/claude-sonnet-4-5"`).

```
subagent agent: "scout", task: "Find all functions that use fetch() in src/", model: "anthropic/claude-opus-4-8"
```

It can also be done by natural language:

```
Use the agent scout with model "anthropic/claude-opus-4-8" to find all the functions that use fetch in src
```

As with frontmatter `model`, registry existence isn't checked. A well-formed but unknown model falls back to the session default, logging a `pi-simple-agents: ` warning naming the model and provider. A bare alias without a `/` (e.g. `"sonnet"`) is rejected outright: the whole `subagent` call fails with a validation error before any agent runs. Always use the full `provider/modelId` form. See [Model aliases](#model-aliases).

### Overriding tools per invocation

`subagent` accepts an optional `tools` param: an array of pi tool names. Unlike frontmatter `tools`, this does **not** accept Claude Code tool-name aliases (`Read`, `Grep`, etc.): that mapping is frontmatter-only. See [Claude Code compatibility](#claude-code-compatibility). Names are exact pi tool names: built-ins (`read`, `grep`, `find`, `ls`, `write`, `edit`, `bash`, ...), tools from installed extensions, and MCP tools (`mcp__<server>__<tool>`, see [MCP tools in subagents](#mcp-tools-in-subagents)).

```
subagent agent: "scout", task: "Find all functions that use fetch() in src/", tools: ["read", "grep"]
```

`tools` is a **total replacement**, not a merge. It does not add to or subtract from the agent's configured tool list; it replaces it outright for that call. An explicit `tools: []` means "no tools for this call"; omitting `tools` entirely means "use whatever settings.json/frontmatter already resolved". These are two different things. The `subagent` tool's call display always shows the effective (post-override) tool list, so a call with `tools: []` renders as `tools: none` in that line, never the agent's configured tools.

### Overriding skills per invocation

`subagent` accepts an optional `skills` param: an array of skill names, matched the same way as frontmatter `skills`: an explicit whitelist, by exact case-sensitive name against the inherited set.

```
subagent agent: "scout", task: "Find all functions that use fetch() in src/", skills: ["tdd"]
```

As with `tools`, `skills` is a **total replacement**, not a merge. An explicit `skills: []` means "no skills for this call"; omitting `skills` means "inherit whatever settings.json/frontmatter already resolved". This has the same limitation as the frontmatter `skills` field (see [Frontmatter fields](#frontmatter-fields)): the whitelist narrows *which* skills are available, but doesn't preload the named skills' content into the subagent's context.

### Overriding maxTurns per invocation

`subagent` accepts an optional `maxTurns` param: an integer from 1 to 100 that bounds the number of model turns (one model response + its batch of tool calls = 1 turn) for that call. When the limit is exceeded, the run settles as an error (`"reached maxTurns limit of N"`) and the session is aborted.

```
subagent agent: "scout", task: "Find all functions that use fetch() in src/", maxTurns: 5
```

Invocation-level `maxTurns` takes precedence over the agent's configured value (frontmatter or settings-level `agentOverrides`). An invalid value (0, negative, > 100, `NaN`, `Infinity`, non-integer, or non-numeric) is warned and treated as "no limit" for that call: same fallback as at the frontmatter layer.

### Overriding thinking per invocation

`subagent` accepts an optional `thinking` param: one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, which sets the thinking-budget level for that call.

```
subagent agent: "scout", task: "Find all functions that use fetch() in src/", thinking: "high"
```

Invocation-level `thinking` takes precedence over the agent's configured value (frontmatter or settings-level `agentOverrides`). It's a free string, not validated at the tool boundary. An unrecognized level is warned and ignored at run time, falling back to the agent's otherwise-resolved thinking level: the same fallback the frontmatter/settings layers already use.

### Overriding timeoutMs per invocation

`subagent` accepts an optional `timeoutMs` param: a positive number of milliseconds bounding how long that call may run before it's aborted.

```
subagent agent: "scout", task: "Find all functions that use fetch() in src/", timeoutMs: 120000
```

Invocation-level `timeoutMs` takes precedence over the agent's configured value (frontmatter or settings-level `agentOverrides`), and over the 10-minute default when nothing else sets it. A value above the 2-hour ceiling (`7200000` ms) is **clamped** to that ceiling with a `console.warn`, not rejected. A non-number, `<= 0`, `NaN`, or `Infinity` value is warned and falls back to the 10-minute default. On expiry, the run settles as an error (`"timed out after <N>ms"`) and any partial output is discarded.

## Background jobs

`subagent` never waits for a run to finish. Calling it launches one job for that one `{agent, task}` call and returns almost immediately with an acknowledgment: a job id (`S1001`, `S1002`, ...), the agent, and the task. The model is told explicitly not to call `subagent` again to poll for that job's result.

The job keeps running in the background. When it settles, its result is delivered automatically as a new message in the conversation — the model sees it without needing to ask, and (unless the job was cancelled) it wakes the model up with a follow-up turn so it can act on the result. A job the user cancels via `/subagents cancel` still delivers a message, but quietly: it doesn't trigger a new turn.

This means a subagent call never blocks the conversation: the model can keep working, and the user can keep typing, while one or more jobs run underneath. Running several agents at once means calling `subagent` once per task, in the same turn — each call gets its own independent job, and there is no overall limit on how many jobs run at once.

Jobs are **in-memory only, per pi session**: nothing persists across a restart, and a nested subagent (one `subagent` call dispatching another) gets its own independent job set, invisible to the parent's. A session with no interactive UI (`pi -p`, `--mode json`, or a nested child session) still waits for its own background jobs to finish before the run settles — it just doesn't show the widget or `/subagents` below, since there's nothing to render them into.

### The `/subagents` command

`/subagents` lists every running and recently-finished job in the current session (newest first): its id, status, elapsed time, and per-task detail (live tool activity for a running job, success/failure and a usage footer for a finished one).

`/subagents cancel <id>` cancels a running job. `/subagents clear` drops every finished job from the list (running ones are untouched) — useful after a long session accumulates a lot of history; by default the 50 most recent finished jobs are kept automatically even without clearing.

### The running-jobs widget

While at least one job is running, a persistent panel appears below the editor: one line per still-running task, with its agent, a truncated preview of the task, and elapsed time, ticking once a second. It disappears automatically once nothing is running. This is how you keep track of a job that outlives whatever else the conversation moves on to — the same thing `/subagents` shows on demand, kept visible without asking.

### Expanding a job's result (Ctrl+O)

A background job shows up as **two** separate blocks in the transcript, each collapsible/expandable independently, both styled and behaving like a native tool result (same themed background, same `toolTitle` header convention, individually clickable to toggle):

- **The launch itself** (`subagent <agent>[...]`): collapsed, a one-line `backgrounded job <id>` summary; expanded, the full acknowledgment text.
- **The result**, once it arrives (`subagent <agent> · job <id> · <status>`): collapsed, just a one-line usage footer per task; expanded, the full output — same divider + content convention the tool used to show inline before background jobs existed.

Ctrl+O (`app.tools.expand`) toggles every expandable block in the transcript at once, including both of the above. Clicking directly on either block toggles just that one, independent of the global toggle, the same way a plain tool result already worked.

### Usage footer

A job's result block carries a one-line consumption footer per task, in the same format as pi's own status-bar footer: `↑<input> ↓<output> R<cache-read> W<cache-write> CH<hit%>% $<cost>[ (sub)] <ctx%>/<window>`. Fields at zero are omitted (no cache activity means no `R`/`W`/`CH`); `$` only shows when cost is non-zero or the model is subscription-backed. Cache-hit % is cumulative over the whole run, not just the last turn. The footer is visible in both collapsed and expanded views. It also appears on error/timeout/maxTurns runs: the tokens were spent regardless of the outcome.

```
scout ↑13k ↓840 R1.2M W3.0k CH98.7% $0.412 12.3%/200k
```

This usage is **not** on the launch tool call's own result (there is nothing to report yet at launch time) — see [Session persistence](#session-persistence) below for where it lives once the job settles.

### Session persistence

When the caller's own pi session is persisted to disk, each subagent run now persists its
session too, at `<parent-session-file-without-.jsonl>/<toolCallId>/run-0/session.jsonl`
— next to the parent's own session file, not in a separate shared directory. The `run-0` segment
is a fixed convention (each job now runs exactly one task): this is the same path several
usage-tracking tools already know how to reconcile a nested-agent tool call's child session
against, so a session file there still attributes the run's cost to its real model (e.g. a
different, more expensive model than the caller's) instead of a generic bucket. It doesn't show
up in `pi --continue`/`/resume`'s own listing (those only look one level deep), and it doesn't
change what conversation history the subagent starts with — that's `defaultContext`, above.

When the caller's own session isn't persisted (e.g. it's running in-memory), a subagent run has
no parent path to nest under and falls back to running fully in-memory, as before — no file is
written, and no warning either: this is normal, not a degraded case.

The launch tool call's own result carries no `usage` field — there is nothing to report yet,
since the run hasn't started. The usage is on the **completion message**'s own `details.usage`
field instead, once the job settles, alongside the run itself at `details.run`.

## Frontmatter fields

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | string | — **(required)** | Agent name. Used to reference it in `subagent`. |
| `description` | string | — **(required)** | Short description visible in the UI. Also used to build the `subagent` tool's description shown to the model (a `name: description` line per discovered agent), computed once when the pi session starts: agents added or renamed while pi is running aren't reflected until restart. |
| `tools` | list | `[]` | Tools the agent is allowed to use, by exact name. Comma-separated in YAML. Accepts pi tool names, MCP tools as `mcp__<server>__<tool>` (see [MCP tools in subagents](#mcp-tools-in-subagents)), or Claude Code tool names (see [Claude Code compatibility](#claude-code-compatibility)). |
| `disallowedTools` | list | `[]` | Tools the agent is denied, applied after `tools`. Comma-separated in YAML. Same name compatibility as `tools`. Forwarded to the SDK as `excludeTools`. |
| `model` | string | *inherited from parent session* | Model to use, in `provider/modelId` form, e.g. `openrouter/gpt-4o`. Claude Code model aliases (`sonnet`, `opus`, `haiku`, `fable`, `inherit`) are also accepted but have no effect on model resolution. See [Claude Code compatibility](#claude-code-compatibility). |
| `systemPromptMode` | `append` or `replace` | `append` | `append`: the agent's system prompt is added to the parent session context. `replace`: replaces the entire system context. |
| `inheritProjectContext` | boolean | `true` | If `false`, the agent starts without loading project context files (AGENTS.md, CLAUDE.md, etc.). |
| `inheritSkills` | boolean | `true` | If `false`, the agent does not inherit the parent's active skills. |
| `inheritExtensions` | boolean | `true` | If `false`, the agent starts without loading pi extensions, including pi's built-in `mcp`, `tool-search` and `codemode` extensions (same as `pi --no-extensions`): no MCP tools, `tool_search` or `codemode` in that agent. |
| `defaultReads` | list | `[]` | Files to pre-load into the agent's context on startup. Relative paths resolve against the **invocation's cwd** (not the agent's `.md` file location); `~`/`~/...` expands to the home directory; absolute paths pass through unchanged. A missing, unreadable, or non-regular-file entry produces a warning and is skipped: the rest of the list still loads. Duplicate entries (same resolved path) are deduped, first occurrence wins. |
| `defaultContext` | `forked` or `fresh` | `fresh` | `fresh`: starts with an empty conversation (default). `forked`: attempts to copy the parent session's conversation history via a real persisted session. If the parent session isn't persisted, or the fork fails, it falls back to `fresh` with a warning: a subagent run never fails because of this. Either way, when the parent session is persisted, the run's own session now persists too (see [Session persistence](#session-persistence) below); it doesn't affect what context the subagent starts with, only whether its transcript is written to disk. |
| `thinking` | string | *inherited* | Thinking budget level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `skills` | list | *inherited* | Explicit whitelist of skills to load, matched by exact, case-sensitive name against the inherited set. When set, overrides automatic inheritance; requested names with no match produce a warning per run. Setting `skills` together with `inheritSkills: false` is contradictory config: it produces a warning and the filter is ignored. **Limitation:** the filter narrows *which* skills are available, but still doesn't preload the named skills' content into the subagent's context. This is not the same as Claude Code's skill-preload semantics. |
| `maxTurns` | integer 1–100 | *no limit* | Max number of model turns (one model response + its batch of tool calls = 1 turn) before the run settles as an error (`"reached maxTurns limit of N"`) and the session is aborted. Out-of-range or non-integer values (≤ 0, > 100, `NaN`, `Infinity`, non-integer like 2.5) are warned and ignored, falling back to no limit. |
| `timeoutMs` | number (ms) | `600000` (10 min) | Bounds how long a subagent run may take before it's aborted. A value above the 2-hour ceiling (`7200000` ms) is clamped to it with a warning. A non-number, `<= 0`, `NaN`, or `Infinity` value falls back to the 10-minute default with a warning. On expiry, the run settles as an error (`"timed out after <N>ms"`) and any partial output is discarded. |

## MCP tools in subagents

Subagents get MCP through pi's built-in MCP support, configured in `~/.pi/agent/mcp.json` (or a trusted project's `mcp.json`). This needs pi 0.99.0 or later. `pi-mcp-adapter` is not supported.

pi's CLI loads its built-in `mcp`, `tool-search` and `codemode` extensions on its own; an SDK session, which is what a subagent runs in, doesn't. pi-simple-agents adds them to every subagent, so they follow the same settings as the host: `-builtin:<name>` in the `extensions` setting turns one off, and `inheritExtensions: false` turns all three off.

### Tool names and the `tools` list

MCP tools are registered as `mcp__<server>__<tool>`, e.g. `mcp__mde-build__mvn` for the `mvn` tool of a server named `mde-build`. `pi mcp list` shows the servers.

When an agent has a `tools` list (frontmatter, `settings.json` override, or per call), pi filters by exact name before anything else:

- A tool that isn't on the list is never registered in that subagent. `tool_search` can't find it and `codemode` can't call it.
- Entries can be exact names or `*` patterns, where `*` matches any characters, e.g. `mcp__mde-build__*` matches every tool of the `mde-build` server (requires pi >=1.0.4; pin pi-simple-agents's `@earendil-works/pi-coding-agent` peer dep to that floor).
- `disallowedTools` removes tools by exact name or pattern after `tools` is applied.
- A per-call `tools` replaces the agent's list, it doesn't add to it. Repeat the agent's own tools if it still needs them.

An agent with no `tools` list gets every tool the session has, every MCP tool included.

### Exposure

Each server's `exposure` in `mcp.json` (default `codemode`) decides how the model reaches its tools, once they pass the `tools` list:

| `exposure` | What the model sees | What `tools` needs |
|---|---|---|
| `direct` | The tool, declared right away | The MCP tool name |
| `deferred` | Nothing until `tool_search` loads it | `tool_search` and the MCP tool name |
| `codemode` (default) | Only through `codemode` scripts | `codemode` and the MCP tool name |
| `hidden` | Nothing | Unreachable |

`toolExposure` in `mcp.json` can override the exposure of single tools; the same table applies per tool. See pi's [MCP docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md) for the config format.

Measured against a real `mcp.json` with `mde-build` (`direct`: `mvn`, `sbt`, `npm`) and `codegraph` (`deferred`: `codegraph_explore`):

| `tools` | What the subagent ends up with |
|---|---|
| `[read, tool_search]` | `tool_search`, and no MCP tools |
| `[read, tool_search, mcp__codegraph__codegraph_explore]` | `tool_search`, plus `codegraph_explore` for it to load |
| `[read, codemode]` | `codemode`, and no MCP tools |
| `[read, codemode, mcp__mde-build__mvn]` | `codemode` and `mvn`, both active |
| `[read, codemode, mcp__mde-build__*]` | `codemode` and every `mde-build` tool (`mvn`, `sbt`, `npm`), all active |
| none | Every MCP tool, `tool_search` active, `codemode` registered but inactive |

`codemode` is only active by default when some server uses `codemode` or `codemode-deferred` exposure, or when `defaultTools` in `settings.json` includes `"+codemode"`. Listing it in `tools` activates it.

### When MCP connects

MCP servers connect when a session emits `session_start`. A subagent emits its own only when it needs one, to skip the connection cost otherwise. It does when, before connecting, it has:

- a tool from an installed extension package (`sourceInfo.origin === "package"`), e.g. `pi-search-hub`;
- a tool from the built-in `mcp`, `tool-search` or `codemode` extension (`sourceInfo.path` `builtin:mcp`, `builtin:tool-search`, `builtin:codemode`);
- a `tools` entry that isn't registered yet. MCP tools only appear once their server connects, so an `mcp__...` name always counts. So does a misspelled name, which only costs connection time. Inert Claude Code tools (`Task`, `TodoWrite`, ...) and this package's own `subagent` tool are ignored.

The subagent emits `session_shutdown` before it is disposed, which stops the servers it started. The host's own connections are untouched: each subagent gets its own instance of the MCP extension. This works in every host mode, `tui`, `rpc`, `print` (`pi -p`) and `json`.

## Claude Code compatibility

Frontmatter values are parsed as real YAML. If a scalar value (like `description`) contains an unquoted colon followed by a space (e.g. `description: Use when: X happens`), strict YAML parsing fails on that colon; pi-simple-agents then auto-quotes the offending line and retries once, so the agent still loads, with a warning naming the recovered field. The safe/recommended practice is to quote such values yourself to avoid the warning: `description: "Use when: X happens"`. Similarly, an unquoted `#` inside a value is treated as a YAML comment and silently truncates everything after it. This is detected (not auto-repaired, since a `#` might be intentional) and produces a warning; quote the value if the `#` is meant to be literal text.

Agent files written for Claude Code's subagent frontmatter format (`.claude/agents/*.md`) load and run unchanged as pi-simple-agents agents. Compatibility is **one-directional**: Claude → pi. The reverse isn't guaranteed: pi's own extension fields (`systemPromptMode`, `inheritProjectContext`, `defaultReads`, `thinking`, `inheritSkills`, `inheritExtensions`, `defaultContext`) have no Claude Code equivalent and are ignored by Claude Code.

### Tool name mapping

`tools` and `disallowedTools` accept Claude Code's capitalized tool names and map them to pi's tool names. Any other name (already a lowercase pi name, or unrecognized) passes through unchanged. Duplicates after mapping are deduped.

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

Some Claude Code tool names have no pi equivalent (`Task`, `TodoWrite`, `NotebookEdit`, `SlashCommand`, `KillShell`, `BashOutput`, `ExitPlanMode`, `AskUserQuestion`). They pass through in the `tools`/`disallowedTools` array unchanged (harmless: the SDK is unlikely to ever match them) and are reported in the aggregated inert-fields warning below, not per file.

### Model aliases

`model` accepts Claude Code's model aliases (`sonnet`, `opus`, `haiku`, `fable`) and `inherit`. `inherit` normalizes to using the session's default model, same as omitting `model` entirely. Aliases are **not** resolved to a real model ID: pi has no such registry lookup, they pass through as literal strings. Model resolution only acts on values containing a `/` (`provider/modelId` form), so a bare alias like `sonnet` degrades gracefully to "use the session's default model", the same mechanism as `inherit`. **To force a specific model, use pi's `provider/modelId` format, not a bare Claude Code alias**: e.g. `openrouter/anthropic/claude-sonnet-4-20250514` instead of `sonnet` or `claude-sonnet-4-20250514`.

### Inert fields

These Claude Code frontmatter fields are accepted without error and their values are preserved on the parsed frontmatter, but they have no functional effect in pi: `permissionMode`, `mcpServers`, `hooks`, `memory`, `background`, `isolation`, `color`, `effort`, `initialPrompt`.

Inert fields, inert tool names, and model aliases are reported together in one aggregated `console.warn`, at most once per 60 seconds (not per file), e.g.:

```
pi-simple-agents: accepted but inert in pi — fields: permissionMode, hooks; tools: Task;
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

> `model` must use pi's `provider/modelId` form to actually take effect. A bare Claude Code model name or alias (no `/`) is accepted without error but has no effect on model resolution. See [Claude Code compatibility](#claude-code-compatibility).

> `timeoutMs` (number, milliseconds) bounds how long a subagent run may take before it's aborted. It can be set at any layer: frontmatter, settings-level `agentOverrides`, or per invocation (see [Overriding timeoutMs per invocation](#overriding-timeoutms-per-invocation)). Default when unset: `600000` (10 minutes). A ceiling of `7200000` ms (2 hours) applies everywhere: a finite value above it is clamped to the ceiling with a `console.warn`, not rejected. An invalid value (`0`, negative, `NaN`, `Infinity`, or a non-numeric value from raw JSON) falls back to the default with a `console.warn`. On expiry, the run settles as an error (`"timed out after <N>ms"`) and any partial output is discarded: it is not returned as a truncated success. The example above raises `planner`'s timeout to 30 minutes for a heavy-thinking, long-running agent. It bounds only the model/prompt execution phase: session creation and resource-loader setup happen before the timer starts and are not covered.

### Precedence rules

```
Invocation (subagent call)  >  Project settings  >  User settings  >  Frontmatter (.md file)
```

Merge is field-level: each present field replaces independently, and any field left absent falls through to the next-lower precedence layer. Invocation-level overrides cover `model` (see [Overriding the model per invocation](#overriding-the-model-per-invocation)), `tools` (see [Overriding tools per invocation](#overriding-tools-per-invocation)), `skills` (see [Overriding skills per invocation](#overriding-skills-per-invocation)), `thinking` (see [Overriding thinking per invocation](#overriding-thinking-per-invocation)), `maxTurns` (see [Overriding maxTurns per invocation](#overriding-maxturns-per-invocation)), and `timeoutMs` (see [Overriding timeoutMs per invocation](#overriding-timeoutms-per-invocation)): each overrides only its own field for that one call. `disallowedTools` is the only field **not** overridable at invocation level: it can only be changed via settings-level `agentOverrides` or frontmatter, which can override any field, including that one.

### Complete example

**Base definition** (`~/.pi/agent/agents/scout.md`):

```markdown
---
name: scout
description: Code explorer
tools: read, grep, find, ls
model: openrouter/anthropic/claude-haiku-4-5
maxTurns: 10
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
- `maxTurns` → `10` (from frontmatter, no override modified it)
- `tools`, `description`, etc. → from frontmatter (no override modified them)

## Limits

- **No limit on concurrent background jobs.** Each `subagent` call gets its own independent job; calling it N times in a row starts N jobs running at once, with no cap.
- Agents run inside a pi SDK session with proper resource handling, context management, and cleanup.

## Known limitations

- A background job's own abort signal is independent of the launching tool call's. Pressing Esc on the turn that launched a job (or that job's own turn otherwise ending) does **not** cancel it \u2014 only `/subagents cancel <id>`, a session shutdown, or the headless safety nets (the settle barrier's abort path, `agent_settled`) do. This is intentional: coupling them would cancel every job the instant its launching turn ends, defeating the point of running in the background.
- Background jobs are in-memory only, scoped to the current pi process. There is no persistence across a restart or reload: an in-flight job is simply gone, with no completion message ever delivered for it. `/subagents clear` and the default 50-job retention also only ever affect the current process's history.
- Subagents share a `ModelRuntime` snapshot taken when the extension loads. This affects two things: (a) performing `/login` later in the same session requires running `/reload` before subagents will see the new credentials, and (b) resolving an agent's `model: "provider/modelId"` config value against a provider or model that only became available after extension load (e.g. a provider registered after load, or a newly available model) also won't resolve until `/reload`: both share the same frozen `ModelRuntime` snapshot.
- MCP in subagents has its own section, [MCP tools in subagents](#mcp-tools-in-subagents). The two limitations below are its residual risks.
- A `~/.pi/agent/extensions/*.ts` file that registers tools and also depends on `session_start` won't have it fire in a subagent, since it isn't an installed package. An extension that listens for `session_start` but registers no tools is never detected either.
- A hung MCP handshake during bind is bounded to `EXTENSION_BIND_TIMEOUT_MS` (60s by default) and is abortable via the job's own cancellation (`/subagents cancel`, not the launching tool call's signal \u2014 see [Background jobs](#background-jobs)): it can't block the run indefinitely, but a handshake that never resolves still delays that job's result by up to that bound.
- The symmetric shutdown stops the MCP connections *this subagent's own nested session* opened; it never touches the host's own MCP state (each nested session gets an independent instance of the MCP extension's factory). A shutdown that itself hangs (no timeout is applied to it) is a known residual risk. See `DEVELOPER.md` for the reasoning and the mitigation this took instead (removing the artificial mode restriction, not adding another timeout layer).

## For developers

If you're integrating `pi-simple-agents` programmatically (importing its internal functions, contributing to the package, or just want the low-level API reference), see [DEVELOPER.md](../DEVELOPER.md).
