---
name: invoking-subagents
description: "How to invoke the subagent tool that runs pre-defined agents: single mode ({agent, task}) and the six per-call overrides (model, tools, skills, thinking, maxTurns, timeoutMs), plus the subagent_job tool that acts on the background jobs each call starts (status, list, cancel, steer, followUp, retry, continue). Each call returns a job id immediately and the result arrives later as a message. Interventions are on the model's own initiative, with no per-job limit; when a second attempt fails the same way, the model stops and reports. Use when delegating work to a subagent, running several concurrently, overriding model/tools/skills/thinking/maxTurns/timeoutMs for one run, recovering a failed or interrupted run, or redirecting, stopping, or checking on a running job. [DO NOT] use for defining new agents or configuring persistent overrides."
---

# Invoking subagents

`subagent` runs a pre-defined agent. The available agents and their descriptions sit inside the
tool's own description at call time; read that list before picking an `agent` value.

## One call, one task

```json
{"agent": "sbt-test", "task": "Run the unit tests under core/src/test/scala/foo"}
```

The call answers in the same turn with a job id, not the agent's output. The result arrives
later as its own message and wakes the model up to act on it. [NEVER] call `subagent` again to
poll: nothing new comes back, and the result lands on its own.

No batch mode exists. Several agents at once means several calls in the same turn, and no cap
limits how many run together:

```json
{"agent": "scout", "task": "List all .ts files in src/"}
```
```json
{"agent": "web-scout", "task": "Find the latest API docs version"}
```

Wait for every result before declaring the work done. A result that answers something other
than its original task was probably redirected mid-run, by the user or by the model itself; that
is by design.

## Managing a job: `subagent_job`

`subagent_job` acts on the jobs `subagent` starts. One `action` field, an optional `id`, and a
`message` for the two inject verbs.

```json
{"action": "list"}
```
```json
{"action": "status", "id": "S1001"}
```
```json
{"action": "cancel", "id": "S1001"}
```
```json
{"action": "steer", "id": "S1001", "message": "Skip the benchmarks; report the totals only."}
```
```json
{"action": "followUp", "id": "S1001", "message": "Then summarize what changed."}
```
```json
{"action": "retry", "id": "S1001"}
```
```json
{"action": "continue", "id": "S1001"}
```

What each one does:

- `status` and `list` are read-only, always allowed, and change nothing. Bare `status` picks the
  single active job, or the newest settled one.
- `cancel` stops a running job. Files already written and commands already fired stay as they
  are.
- `steer` injects into the run's live session after its current tool calls, so the agent reads it
  before the next model call. That is how a run gets redirected without restarting it.
- `followUp` queues a message for the end of the run and extends it. The run can still hit
  `maxTurns` or `timeoutMs` while processing the follow-up.
- `retry` re-dispatches the same agent and task as a NEW job, from zero.
- `continue` relaunches an interrupted run from its persisted child session, keeping the partial
  work; the agent re-verifies half-done files first.

Without an `id`, `cancel`, `steer` and `followUp` target the single active job and report the
ids to pick from when several are active. `retry` and `continue` resolve their target from
settled runs on disk. [ALWAYS] prefer the explicit id from the launch acknowledgment.

### Interventions on your own initiative

`cancel`, `steer`, `followUp`, `retry` and `continue` are interventions. [ALWAYS] act on your own
initiative: a run that failed with a network error, hit `maxTurns`, or is heading the wrong way
gets a recovery without waiting to be asked, and there is no per-job limit on how many
interventions you make. A guard failure (unknown id, settled job, no live session yet) means
nothing happened. When the job needs something only the user can judge, [ALWAYS] tell them what
is left and let them decide.

The case that matters most: a job comes back `failed` with `ECONNRESET`, or with `reached
maxTurns limit of 5` while half its files are already written. Do not start a new `subagent`
call and do not hand the user a shell command. Make the tool call yourself
(`{"action": "continue", "id": "S1001"}`), then say what was relaunched and why. The relaunched
run keeps the id in its own acknowledgment, which is the id the next intervention would use.

`retry` and `continue` mint a new job id, so the relaunched run is a fresh target. That is not
licence to loop: when the second attempt fails the same way, stop and report instead of
relaunching again.

### Retry or continue

- `continue` when the run hit `maxTurns` or `timeoutMs`, or left files half-done. The forked
  history keeps that work.
- `retry` when the partial state is worthless.

Both re-apply the original call's recorded overrides when the launch acknowledgment persisted
them, and the agent's own defaults otherwise. A run settled as `cancelled` is user intent, not a
failure: relaunch it [ONLY] when the user asks.

## Per-call overrides

Six fields sit alongside `agent`/`task`: `model`, `tools`, `skills`, `thinking`, `maxTurns`,
`timeoutMs`. **[ALWAYS]** omit them. Each one overrides the agent's resolved configuration for
that single call, so pass one [ONLY] at the user's explicit request.

- **`model`**: `provider/modelId`, multi-slash allowed. A bare alias (`sonnet`) is rejected.
  [NEVER] choose a model on your own initiative; when the user asks for a model without naming
  it, ask for the exact id first.
- **`tools`**, **`skills`**: string arrays, and both replace rather than merge. `[]` means none;
  omitting the field means inherit. MCP tools are `mcp__<server>__<tool>` or `mcp__<server>__*`.
- **`thinking`**: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. An unknown level is
  warned and ignored for that call.
- **`maxTurns`**: integer 1 to 100. One turn is a model response plus its tool calls. Overflow
  settles the run as an error.
- **`timeoutMs`**: positive milliseconds, 10-minute default; values above 7,200,000 clamp to the
  2-hour ceiling. Expiry settles the run as an error.

Precedence for all six: invocation > settings `agentOverrides` > agent frontmatter > session
default.

## Errors

- Unknown `agent`: the error lists the available agents.
- Missing or empty `agent`/`task`: validation error naming the field.
- `model` without `provider/`, or `tools`/`skills` that are not string arrays.
- Unknown `action`, or `steer`/`followUp` without a non-empty `message`: tool error.
- A guard stops an intervention before it reaches the job (unknown id, settled job, no live
  session yet): the warning names the state, and nothing happened.

## Out of scope

Defining new agents, persistent overrides in `settings.json`, and the `/subagents` extras with no
tool equivalent (`peek`, `clear`, `session`).
