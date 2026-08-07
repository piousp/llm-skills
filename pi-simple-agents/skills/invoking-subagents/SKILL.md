---
name: invoking-subagents
description: "How to invoke the subagent tool that runs pre-defined agents: single mode ({agent, task}), parallel mode ({tasks: [...]}, up to 8 tasks), and forcing a model, tool whitelist, skill whitelist, or turn-count cap for one invocation via the optional model/tools/skills/maxTurns parameters. Use when delegating work to a subagent, fanning tasks out in parallel, or overriding which model, tools, skills, or maxTurns a single subagent run uses. Not for defining new agents or configuring persistent overrides — see the pi-simple-agents README for that."
---

# Invoking subagents

The `subagent` tool runs pre-defined agents; the list of available agents and their
descriptions is injected into the tool's own description at call time, not repeated
here — check it before picking an `agent` value.

## Single mode

```json
{"agent": "sbt-test", "task": "Run the unit tests under core/src/test/scala/foo"}
```

One agent, one task, per call. The result is returned when that agent's run settles.

## Parallel mode

```json
{
  "tasks": [
    {"agent": "sbt-compile", "task": "Compile the core module"},
    {"agent": "sbt-test", "task": "Run tests in the api module"}
  ]
}
```

Up to 8 entries per call, run with limited concurrency. Never mix a top-level
`agent`/`task` with `tasks` in the same call — it's one or the other.

## Forcing a model for one invocation

Add the optional `model` param — in single mode at the top level, in parallel mode
per `tasks[]` entry:

```json
{"agent": "sbt-test", "task": "Run the full suite", "model": "anthropic/claude-opus-4-8"}
```

- Format is `provider/modelId`; multi-slash IDs are valid (e.g.
  `"openrouter/anthropic/claude-sonnet-4-5"`).
- Precedence: invocation `model` > project settings > user settings > agent
  frontmatter > session default.
- Bare aliases without a `/` (`sonnet`, `opus`) are the malformed-format case below —
  they're rejected with a validation error, not silently ignored.

## Forcing tools or skills for one invocation

Add the optional `tools` and/or `skills` params (arrays of strings) — in single mode
at the top level, in parallel mode per `tasks[]` entry:

```json
{"agent": "scout", "task": "List files with no write access", "tools": ["read", "grep"], "skills": ["tdd"]}
```

- Both `tools` and `skills` are **total replacement**, not merge, of whatever the
  agent would otherwise resolve.
- `tools`: native pi tool names only — no Claude Code tool-name aliasing (e.g.
  `Read`→`read`) in this invocation path.
- `skills`: whitelist by exact case-sensitive name against the inherited skill set.
- `[]` is a valid explicit value meaning "none" for that call; omitting the field
  means "inherit whatever settings.json/frontmatter already resolved" — these are
  different things.
- Same placement rule as `model`: single mode top-level, or per `tasks[]` entry —
  never mixed with a top-level `agent`/`task` plus `tasks`.

## Limiting subagent turns

Add the optional `maxTurns` param — an integer from 1 to 100 that bounds how many
model turns the call may run. A turn is one model response plus its batch of tool
calls. When the limit is exceeded, the run settles as an error
(`"reached maxTurns limit of N"`) and the session is aborted.

In single mode, `maxTurns` is a top-level param:

```json
{"agent": "scout", "task": "Find all functions that use fetch() in src/", "maxTurns": 5}
```

In parallel mode, `maxTurns` goes inside each entry of `tasks[]`:

```json
{
  "tasks": [
    {"agent": "scout", "task": "List all .ts files in src/", "maxTurns": 5},
    {"agent": "web-scout", "task": "Find the latest version of the API docs"}
  ]
}
```

- Precedence: invocation `maxTurns` > settings `agentOverrides[agent].maxTurns` >
  agent frontmatter `maxTurns` > no limit.
- Out-of-range or non-integer values (≤ 0, > 100, `NaN`, `Infinity`, non-integer
  like 2.5, or non-numeric) are warned and treated as "no limit" for that call.
- Top-level `maxTurns` together with `tasks` is rejected; place it inside each
  `tasks[]` entry, the same way as `model`/`tools`/`skills`.

## Errors and how to fix them

- Top-level `model` together with `tasks` → rejected; put `model` inside each
  `tasks[]` entry instead.
- Unknown `agent` name → error lists the available agents.
- `model` not in `provider/modelId` form → validation error.
- Mixing top-level `agent`/`task` with `tasks` → rejected; use exactly one mode.
- Top-level `tools`/`skills` together with `tasks` → rejected; put them inside
  each `tasks[]` entry instead.
- `tools`/`skills` not an array of strings → validation error.
- Top-level `maxTurns` together with `tasks` → rejected; put `maxTurns` inside each
  `tasks[]` entry instead.

## Not covered here

Defining new agents, persistent model/tool overrides, timeouts, and concurrency
tuning — see the [README](../../README.md).
