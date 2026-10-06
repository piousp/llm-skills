---
name: invoking-subagents
description: "How to invoke the subagent tool that runs pre-defined agents: single mode ({agent, task}) and the six optional per-invocation overrides (model, tools, skills, thinking, maxTurns, timeoutMs) for one call. Each call starts its own independent background job and returns a job id immediately; the result arrives later as a message. Running several agents at once means calling the tool once per task, in the same turn. Use when delegating work to a subagent, running several subagents concurrently, or overriding which model, tools, skills, thinking level, turn cap, or timeout a single subagent run uses. [DO NOT] use this for defining new agents or configuring persistent overrides; see the pi-simple-agents README for that."
---

# Invoking subagents

The `subagent` tool runs pre-defined agents; the list of available agents and their
descriptions is injected into the tool's own description at call time, not repeated
here; check it before picking an `agent` value.

## Single mode

```json
{"agent": "sbt-test", "task": "Run the unit tests under core/src/test/scala/foo"}
```

One agent, one task, per call. The call returns almost immediately with a job id — not the
agent's final output. The result is delivered later as its own message in the conversation, and
(unless cancelled) wakes the model up with a follow-up turn to act on it. **Do not call
`subagent` again to poll** for that job's result; it arrives automatically.

## Running several at once

There is no parallel-batch mode. Each `subagent` call starts its own independent background job,
so running N agents concurrently just means issuing N separate calls, ideally in the same turn:

```json
{"agent": "scout", "task": "List all .ts files in src/"}
```
```json
{"agent": "web-scout", "task": "Find the latest API docs version"}
```

Both jobs run at once; there is no cap on how many background jobs can be running at the same
time. Wait for all of their results to arrive (each one as its own message) before concluding the
work is done — don't call `subagent` again to check on them.

## Per-invocation parameters

Six optional params can override an agent's resolved configuration for one call: `model`,
`tools`, `skills`, `thinking`, `maxTurns`, `timeoutMs`. [ALWAYS] omit a param by default, so the
settings → frontmatter → inherited resolution wins; pass a param only at the user's explicit
request (e.g. "run scout with high thinking" or "cap this at 5 turns").

Each is a top-level field alongside `agent`/`task`:

```json
{"agent": "scout", "task": "Find fetch() callers", "model": "anthropic/claude-opus-4-8", "thinking": "high", "maxTurns": 5}
```

### `model`

Format `provider/modelId`; multi-slash IDs are valid (e.g.
`"openrouter/anthropic/claude-sonnet-4-5"`). Precedence: invocation `model` > project settings >
user settings > agent frontmatter > session default. A bare alias without a `/` (`sonnet`,
`opus`) is rejected with a validation error, not silently ignored.

### `tools` / `skills`

Arrays of strings. Both are **total replacement**, not merge, of whatever the agent would
otherwise resolve. `tools` takes exact pi tool names, MCP tools included as
`mcp__<server>__<tool>` (no wildcards; a deferred server also needs `tool_search`, a `codemode`
one needs `codemode`); no Claude Code tool-name aliasing (e.g. `Read`→`read`) in this invocation
path. `skills` whitelists by exact case-sensitive name
against the inherited skill set. `[]` is a valid explicit value meaning "none" for that call;
omitting the field means "inherit whatever settings.json/frontmatter already resolved"; these
are different things.

### `thinking`

A thinking-budget level string: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.
Precedence: invocation `thinking` > settings `agentOverrides[agent].thinking` > agent frontmatter
`thinking` > session default. An unrecognized level is warned and ignored for that call, falling
back to the agent's otherwise-resolved level; it is not a validation error.

### `maxTurns`

An integer from 1 to 100 that bounds how many model turns the call may run. A turn is one model
response plus its batch of tool calls. When the limit is exceeded, the run settles as an error
(`"reached maxTurns limit of N"`) and the session is aborted. Precedence: invocation `maxTurns` >
settings `agentOverrides[agent].maxTurns` > agent frontmatter `maxTurns` > no limit.
Out-of-range or non-integer values (≤ 0, > 100, `NaN`, `Infinity`, non-integer like 2.5, or
non-numeric) are warned and treated as "no limit" for that call.

### `timeoutMs`

A positive number of milliseconds bounding how long the call may run before it's aborted.
Precedence: invocation `timeoutMs` > settings `agentOverrides[agent].timeoutMs` > agent
frontmatter `timeoutMs` > the 10-minute default. Values above the 2-hour ceiling
(7,200,000 ms) are clamped to it with a warning, not rejected. Non-number, `≤ 0`, `NaN`, or
`Infinity` values are warned and fall back to the 10-minute default. On expiry, the run settles
as an error (`"timed out after <N>ms"`).

## Errors and how to fix them

- Unknown `agent` name → error lists the available agents.
- Missing or empty `agent`/`task` → validation error naming the missing field.
- `model` not in `provider/modelId` form → validation error.
- `tools`/`skills` not an array of strings → validation error.

## Not covered here

Defining new agents, persistent model/tool overrides, and `/subagents` job management
(listing/cancelling/clearing); see the [README](../../README.md).
