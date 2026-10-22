---
name: invoking-subagents
description: "How to invoke the subagent tool that runs pre-defined agents: single mode ({agent, task}) and the six optional per-invocation overrides (model, tools, skills, thinking, maxTurns, timeoutMs) for one call. Each call starts its own independent background job and returns a job id immediately; the result arrives later as a message. Running several agents at once means calling the tool once per task, in the same turn. Job management via /subagents: steer, followUp, and cancel only at the user's explicit request; retry and continue a run that failed, errored, or was interrupted on your own initiative. Use when delegating work to a subagent, running several subagents concurrently, overriding which model, tools, skills, thinking level, turn cap, or timeout a single subagent run uses, recovering a failed subagent run, or redirecting or stopping a running job at the user's request. [DO NOT] use this for defining new agents or configuring persistent overrides; see the pi-simple-agents README for that."
---

# Invoking subagents

The `subagent` tool runs pre-defined agents; the list of available agents and their
descriptions is injected into the tool's own description at call time, not repeated
here; check it before picking an `agent` value.

## Single mode

```json
{"agent": "sbt-test", "task": "Run the unit tests under core/src/test/scala/foo"}
```

One agent, one task, per call. The call returns almost immediately with a job id, not the
agent's final output. The result is delivered later as its own message in the conversation, and
(unless cancelled) wakes the model up with a follow-up turn to act on it. **Do not call
`subagent` again to poll** for that job's result; it arrives automatically.

A result can also reflect what the user injected into the run while it was in flight (see
[Steering a running job](#steering-a-running-job)): a job that answers something other than its
original task may have been redirected; that is by design, not a malfunction.

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
work is done. Don't call `subagent` again to check on them.

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

[ALWAYS] omit `model`: the agent's inherited model, resolved through frontmatter/settings
before the call even starts, is what runs unless the caller overrides it. Set `model` [ONLY]
when the user explicitly names one for that call (e.g. "run scout with opus"); if the user asks
for a model change without naming it, confirm the exact `provider/modelId` before passing it.
Never pick a model on your own initiative.

Format `provider/modelId`; multi-slash IDs are valid (e.g.
`"openrouter/anthropic/claude-sonnet-4-5"`). Precedence: invocation `model` > project settings >
user settings > agent frontmatter > session default. A bare alias without a `/` (`sonnet`,
`opus`) is rejected with a validation error, not silently ignored.

### `tools` / `skills`

Arrays of strings. Both are **total replacement**, not merge, of whatever the agent would
otherwise resolve. `tools` takes exact pi tool names or `*` patterns (e.g.
`mcp__<server>__*`), MCP tools included as `mcp__<server>__<tool>` (a deferred server also
needs `tool_search`, a `codemode` one needs `codemode`); no Claude Code tool-name aliasing
(e.g. `Read`→`read`) in this invocation path. `skills` whitelists by exact case-sensitive name
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

## Steering a running job

While a job is running, the user can inject a message into its live session via the
`/subagents` command: `/subagents steer <id> <message>` (delivered after the job's current
assistant turn, redirects the in-flight work) or `/subagents followUp <id> <message>`
(queued until the run finishes its pending work; it extends the run, so the job settles only
after it is processed). The extension is not free: the extra turn counts toward `maxTurns`,
and the run can still hit its `timeoutMs` while processing the follow-up. The coordinator (you)
may run these commands too, but [ALWAYS] and [ONLY] when the user explicitly asks for it:
never steer or follow up a subagent on your own initiative. A settled job can no longer be
messaged.

## Cancelling a running job

The user can stop a running job with `/subagents cancel [id]`; without an id the
command picks the single active job on its own (several actives ask for one).
Cancellation is not free of consequences: whatever the run had half-done (files
written, commands fired) stays as it is, and the job settles as `cancelled`,
delivering a quiet message that does not wake the model up. Run `cancel` [ALWAYS]
and [ONLY] when the user explicitly asks for it; never on your own initiative. A
settled job cannot be cancelled (there is nothing running); a run that already
finished cannot be undone, only retried.

## Retrying or continuing a settled run

A job that settled as failed or errored, and one interrupted mid-run (its process
died or was killed while working, showing up as `interrupted`), can be brought
back in two ways:

- `/subagents retry [id]` re-dispatches the SAME agent and task as a NEW job
  (new run id, no memory of the old conversation).
- `/subagents continue [id]` starts a job whose session branches from the
  interrupted run's persisted child session, then sends a fixed continuation
  prompt: the agent first re-verifies the state of files or operations the
  previous attempt may have left half-done, then completes the task.

When a subagent run fails this way, act on it without waiting to be told: run
`retry` or `continue` on your own initiative, then report to the user what you
relaunched and why. Two limits hold. A run that settled as `cancelled` is user
intent, not a failure; relaunch it [ALWAYS] and [ONLY] at the user's explicit
request. And never retry the same run more than once on your own: if the second
attempt fails the same way, stop and surface the error to the user instead of
looping.

Both relaunch with the original call's recorded per-call overrides
(`model`, `tools`, `skills`, `thinking`, `maxTurns`, `timeoutMs`) when the
launch acknowledgment of the original call persisted them, and with the
agent's own resolved defaults otherwise (older sessions, a crash before the
ack was flushed, and runs whose launch was itself a retry or a continue
leave nothing recorded). A run can be continued only when it left a
persisted child session; retry works for every settled
failed/errored/cancelled/interrupted run that names an agent and a task on
disk. A settled run cannot be messaged (see above), but it can still be
retried or continued. Bare `continue` (no id) also skips runs settled as
cancelled, like bare `retry` does; an explicit id still targets one.

The coordinator (you) runs these commands; the two user-intent limits above are
the only brakes. Do not pick between `retry` and `continue` at random either:
when the failure came from hitting `maxTurns` or `timeoutMs`, `continue` is
usually the better choice: the forked history keeps the partial work, while a
retry re-does it from zero.

## Errors and how to fix them

- Unknown `agent` name → error lists the available agents.
- Missing or empty `agent`/`task` → validation error naming the missing field.
- `model` not in `provider/modelId` form → validation error.
- `tools`/`skills` not an array of strings → validation error.

## Not covered here

Defining new agents, persistent model/tool overrides, and the rest of `/subagents` job
management (listing/clearing, peek/status, usage reporting); see the
[README](../../README.md).
