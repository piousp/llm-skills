# pi-simple-agents

[![npm version](https://badge.fury.io/js/pi-simple-agents.svg)](https://badge.fury.io/js/pi-simple-agents)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Subagents for [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent). Write an agent as a Markdown file, then call it from any pi session with the `subagent` tool.

## Install

```bash
pi install npm:pi-simple-agents
```

Needs pi 1.0.4 or later. Per-tool durations in the peek window and precise abort labeling (an externally aborted run settling as failed instead of completed) need pi 1.1.0 or later; on older hosts both degrade gracefully to the previous behavior.

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

A call can override `model`, `tools`, `skills`, `thinking`, `maxTurns` and `timeoutMs` for that run only:

```
subagent agent: "scout", task: "Find the latest version of the API docs", model: "anthropic/claude-opus-4-8", thinking: "high", maxTurns: 5
```

Omit them all by default: the agent's own frontmatter/settings resolution is what runs, and an override belongs in the call only when the user asks for it by name.

## Background jobs

`subagent` never waits for a run to finish. A call answers in the same turn with a job id (`S1001`, `S1002`, …) and runs the task in the background. When the run settles, its result arrives as its own message and the model gets a follow-up turn to act on it, unless the job was cancelled. While it runs, the user can redirect the job with `/subagents steer <id> <message>` or queue a follow-up with `/subagents followUp <id> <message>` (see below).

Jobs live in memory: nothing carries over after a restart. A run that settled as failed or errored, or was interrupted mid-run (its process died while working), can always be brought back with `/subagents retry [id]` or, when it left a persisted child session, `/subagents continue [id]`. While at least one is running, a panel below the editor shows a line per job with a one-word status. The word is the tool currently executing (`read`, or `playwright` for `mcp__playwright__navigate`), `thinking` or `output` while only the model streams, `waiting` before the first signal. The panel disappears once nothing is running.

Once a job settles, the footer's status area also carries a running total of settled subagent spend: `sub: 3 runs, 1.2M tok, $0.980` (the cost segment is omitted when it is zero, as happens with subscription models). The line stays until the session shuts down. `/subagents clear` leaves it alone: it reports actual session spend, the same scope as `/subagents session`.

## The /subagents command

With no id, `status` and `peek` pick the single active job on their own (several actives ask for an id); `status` also falls back to the newest finished one when nothing is active. `steer` and `followUp` take a single token as the message and resolve the target the same way `cancel` does: only running jobs are candidates.

- `/subagents` lists running and recently finished jobs, newest first, with a usage footer once a job settles.
- `/subagents status [id]` details one job: the current activity, the last tool calls of the run, and usage so far.
- `/subagents peek [id]` opens a live window over one job: streamed text, the tail of the agent's thinking, and tool calls with their results and per-tool durations. `w` alternates between the floating window and fullscreen; Esc or `q` closes it; `Ctrl+O` toggles tool output expansion, following the host keybinding. `Ctrl+T` (thinking visibility) is not supported while the window is open — close it (Esc/q) and press `Ctrl+T` in the main UI. Needs an interactive TUI session; other modes get a warning.
- `/subagents cancel [id]` stops a running job.
- `/subagents steer <id> <message>` injects a message into a running job's live session. It lands after the current turn's tool calls finish, before the next model call, so the agent reads it and adjusts the work still pending.
- `/subagents followUp <id> <message>` queues a message for the end of the run. It enters after the job finishes its pending work and extends the run: the job settles only after the follow-up is processed, and the run can still hit its `timeoutMs` or `maxTurns` along the way.
- `/subagents retry [id]` re-dispatches a settled run as a NEW job (the same agent, the same task, a runId of its own). The original call's per-call overrides run when the launch acknowledgment recorded them; otherwise the agent's own defaults run, and the output says which. The not-recorded arm covers older sessions whose acks predate persistence, a crash before the ack was flushed to disk, and runs whose launch was itself a retry or a continue.
- `/subagents continue [id]` re-launches a run that died mid-run from its persisted child session: the new job's session branches from the interrupted one and the agent is first told to re-verify half-done work. Runs that settled with no persisted child session have nothing to continue from; `retry` re-dispatches them instead. When a run failed by hitting `maxTurns` or `timeoutMs`, `continue` is usually the better choice: the forked history keeps the partial work, while a retry re-does it from zero. With recorded parameters the continuation runs the same ones (the fresh-maxTurns note in the output means exactly that: the fork restarts the turn counter at zero, and the timeout window is fresh, not a remainder); an ack without recorded parameters falls back to the agent's own defaults and the output says so.
- Both steer/followUp and retry/continue resolve the target on their own when given a single token, but with different candidate sets: steer/followUp consider only running jobs, retry every retryable settled run except those settled as cancelled, and continue only runs with a persisted child session that did not settle as cancelled either (an explicit id still targets a cancelled run, with a note). The model is told it may use any of them only when you explicitly ask, never on its own initiative, and a settled job can no longer be messaged.
- `/subagents clear` drops finished jobs from the list.
- `/subagents session` reports the session's combined subagent spend in three blocks: **Main Session** (the parent session's own tokens and cost, from its in-memory entries), **Subagents** (the reconciled child runs: token totals with a cache hit rate, cost per model, and one line per agent, like `scout: 3 runs, 1.2M tokens, $0.980`), and **Total (Main + Subagents)**. Main comes from the live session entries; Subagents comes from the child sessions persisted on disk. The current session must be persisted to disk; otherwise the command warns and exits.

## Where subagent usage is persisted

The combined report above is only as complete as what reached disk:

- With a persisted session, everything survives: pi flushes the session file synchronously per entry, and each child run persists its own `session.jsonl` under the parent's directory.
- With `--no-session`, child runs and their aggregate usage exist only in memory — nothing is persisted, so the spend is unrecoverable after a restart.
- On a crash, the in-flight turn and the parent's `subagent-result` completion message are lost, but a partial child session stays on disk and `/subagents session` reconciles it as an orphan (agent `unknown`, task recovered from the child's first user message).
- If forking the parent session fails (`forkFrom`/`atPath`), a child falls back to an in-memory session: the only trace left is the parent's aggregate `details.usage`, which lands in the report's `unattributed` bucket without a per-model breakdown.
- `/subagents continue` forks the interrupted run's child session into a fresh timestamped `<ts>_<id>.jsonl` next to it (the new job's own session file). The fork is safe to repeat: retrying the same run twice, from two relaunches or from two pi processes racing on the same directory, creates two distinct files (they carry a timestamp), and `forkFrom`'s exclusive-create flag turns a true collision into a graceful in-memory fallback. The report's disk walk only ever reads a run's `run-N/session.jsonl` — it never reads those timestamped fork files — so the continued run's spend is attributed from its completion message's `details.usage` (the fork replays the seed's history without re-calling the LLM) and the seed run is attributed exactly once from its own `session.jsonl`: never double-counted, by construction. If the fork fails, the only trace is in the `unattributed` bucket, same as above.
- A provider that does not report usage shows zero; that spend is irrecoverable.

pi's native `/session` command and footer count only the Main session: subagent runs are separate SDK sessions invisible to its countable entries, so `/subagents session` is the only place the combined total is visible.

## MCP tools

Subagents use pi's built-in MCP (`~/.pi/agent/mcp.json`). `pi-mcp-adapter` is not supported.

If the agent has a `tools` list, name each MCP tool exactly as pi registers it, `mcp__<server>__<tool>`. `mcp__<server>__*` brings in every tool of that server. A tool left off the list doesn't exist for that agent, not even through `tool_search` or `codemode`:

```
subagent agent: "worker", task: "Compile the project", tools: ["read", "mcp__mde-build__mvn"]
```

A server with `"exposure": "deferred"` also needs `tool_search` in the list, and one with the default `codemode` exposure needs `codemode`. An agent with no `tools` list gets every tool the session has. pi connects MCP servers in the background at session start; the subagent waits up to 10 s for the requested tools (names or patterns) to register before starting, and fails naming whatever never appeared. [docs/REFERENCE.md](docs/REFERENCE.md#mcp-tools-in-subagents) has the details.

## More

- [docs/REFERENCE.md](docs/REFERENCE.md): frontmatter fields, per-call overrides, `settings.json` overrides, Claude Code compatibility, limits.
- [DEVELOPER.md](DEVELOPER.md): internals and tests.
- `agents-examples/` ships two sample agents, `scout` and `web-scout`.
- The bundled `invoking-subagents` skill teaches the model how to call the tool (`/skill:invoking-subagents`).

## License

MIT
