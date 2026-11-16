# Changelog

## 1.5.11

- Fix: an errored or retried message no longer pastes its partial text onto the retry or drops the next block.
- Fix: the live context percentage catches up at the next tool start.
- Packaging: `docs/REFERENCE.md` ships with the package.
- Internal: `buildSubagentSessionReport` takes a `Map` (runId to agent) instead of a `Set`. Callers passing a `Set` must switch.

## 1.5.10

- Fix: the package no longer installs the unused `glob` dependency, which cleared the `npm audit` warnings.
- Dev dependencies on `@earendil-works/pi-coding-agent` and `pi-tui` move to `^1.5.1`. The published package is unchanged.

## 1.5.9

- Performance: the peek window renders much faster (same state 5.72 ms → ~0 ms, one new entry 5.83 → 0.58 ms).
- Performance: an idle peek window repaints once per second instead of four times.
- Performance: the running-jobs widget skips redundant updates (105 → 6 calls over 100 progress events).
- Performance: tool wildcard matching is faster (127 → 11.7 µs per `missingRequestedTools` call).
- Performance: the live context-usage read runs at most once per second while a job runs.
- Performance: startup loads the model runtime and agent discovery concurrently.
- Performance: `retry` and `continue` read the session tree less (38.4 → 18.7 ms on a 5 MB root).
- Performance: the session report reads each child once (100 → 50 reads).
- Packaging: the npm package ships only what runs, via a `files` allowlist (83 → 42 files). Adds the MIT `LICENSE` file.
- Fix: live transcript segments no longer split words across entries in the peek window.
- Behavior change: a closed transcript entry that ends in a newline no longer renders a trailing blank line.
- Fix: `/subagents session` labels a running job with its agent instead of `unknown … (orphaned)`.

## 1.5.8

- New: every job view (`/subagents list`, `status`, the widget, the peek window) shows the model the run uses.
- Behavior change: the tool call's parameter line shows where each value came from (`settings.json`, `frontmatter`), and `none` replaces `inherited`.
- Behavior change: the peek window is always fullscreen and the `w` key is gone. Each open starts at the tail.

## 1.5.7

- Fix: a subagent whose `model` names a provider registered by another extension now starts.
- Fix: `retry` and `continue` resolve such models the same way as a first launch.

## 1.5.6

- Internal: 22 deduplications across `src/`, with no change to behavior beyond the two items below.
- Behavior change: `agent` and `task` must be non-blank, not just non-empty. Whitespace-only values are rejected.
- Behavior change: a non-object tool argument (such as `[]`) gets the shape error `Provide an object with "agent" and "task".`

## 1.5.5

- Behavior change: the one-intervention-per-job limit is gone. The model can `cancel`, `steer`, `followUp`, `retry` or `continue` a job as often as needed.
- The `subagent_job` tool no longer registers `executionMode: "sequential"`.

## 1.5.4

- Package gallery: the pi.dev page gets a real description, the MIT license and a preview image.
- `package.json` gains `description`, `license` and `pi.image`, and more `keywords`.
- No code changes.

## 1.5.3

- Fix: drop the unused `zod` dependency, which `npm audit` reported as high severity.
- No code changes.

## 1.5.2

- New: the `subagent_job` tool lets a model act on jobs it started: `status`, `list`, `cancel`, `steer`, `followUp`, `retry`, `continue`.
- New: the tool allows one intervention per job on the model's own initiative. The `/subagents` command is never limited.
- Behavior change: the model-facing description no longer forbids acting on jobs.
- Fix: `subagent_job` no longer triggers extension binding and MCP connections for nothing.
- The bundled `invoking-subagents` skill is rewritten to teach the tool.

## 1.5.1

- Behavior change: bare `/subagents` prints a help text. The job listing moved to `/subagents list`.
- `/subagents help` is an alias of the bare view, and `list` takes no arguments.
- The command `description` is now one compact line.

## 1.5.0

- New: `/subagents retry [id]` re-dispatches a failed, errored, cancelled or interrupted run as a new job.
- New: `/subagents continue [id]` re-launches an interrupted run from its saved child session.
- Both reuse the original call's per-call overrides when recorded, and fall back to the agent's defaults otherwise.
- Cancelled runs are never auto-picked and need an explicit id.
- New: `/subagents session` shows Main, Subagents and Total blocks.
- New: a footer status line shows running subagent spend, such as `sub: 3 runs, 1.2M tok, $0.980`.

## 1.4.1

- Docs only: new override example in the README, separate `steer` and `followUp` bullets, and a steering section in the skill.
- No code changes.

## 1.4.0

- New: `/subagents steer <id> <message>` redirects a running job after its current turn.
- New: `/subagents followUp <id> <message>` queues a message and extends the run until it is processed.
- Bare `steer` and `followUp` auto-select the single active job, like bare `cancel`.
- A follow-up can push a run past `timeoutMs`, and follow-up turns count toward `maxTurns`.
- The widget footer hint lists the new commands.

## 1.3.3

- Behavior change: an externally aborted child run now settles as aborted instead of completed. `/subagents session` counts it as failed.
- New: the peek window shows per-tool durations, such as `▪ read a.ts: ok · 420ms` (pi 1.1.0 or newer).
- New: Ctrl+O toggles tool output while the peek window is open.
- Ctrl+T is not supported inside the peek window. Close it and press Ctrl+T in the main UI.

## 1.3.2

- Fix: an agent requesting MCP tools no longer fails or runs without them before the server connects.
- Runs wait up to 10 s for requested tools and `*` patterns to register. A pattern that matches nothing fails the run.

## 1.3.1 — 2026-10-12

- Docs only: README trimmed from 865 to 654 words.
- Fix: the README now states pi 1.0.4 as the minimum, and says MCP `tools` entries accept `*` patterns.
- No code changes.

## 1.3.0 — 2026-10-12

- New: `/subagents peek [id]` opens a live window over a background job's transcript, read-only.
- The window scrolls with `↑/↓`, PgUp/PgDn or the mouse wheel. `w` toggles fullscreen, Esc or `q` closes. It needs a TUI session.
- New: bare `/subagents status` and `cancel` auto-select the single active job, like `peek`.
- New: `/subagents session` reports usage and cost per subagent for the current session, rebuilt from disk.
- The report needs a persisted session. It includes token totals, a per-model cost breakdown and a per-agent summary.
- Runs that died mid-run still count, shown as `unknown (orphaned)`.

## 1.2.1

- Fix: subagent sessions no longer lose user package tools (`web_search`, `web_read`, ...). Broken in 1.2.0.
- Behavior change: a run fails with an error naming the tools when an explicitly requested tool never registered.
- Behavior change: a run that ends with no assistant text fails with an error instead of `completed` with an empty result.

## 1.2.0

- Behavior change: `model` must be `provider/modelId` that resolves in the registry, or `inherit`. Otherwise the run errors.
- Behavior change: the `sonnet`/`opus`/`haiku`/`fable` aliases are removed. A bare word is now an invalid model.
- Behavior change: a run that settles with an error marks the job `failed`. A crashed run marks it `errored`.
- Behavior change: all loader warnings, including unknown skills, are emitted together right after the loader reloads.
- New: settings `agentOverrides` are validated per field. Bad types and identity fields are dropped with a warning.
- Internal: entry point split into `src/render-extensions.ts` and `src/task-runner.ts`; tests no longer read the real home.

## 1.1.0

- New: `/subagents status <id>` shows one job in detail: current activity, last 10 tool calls and live usage.
- New: the running-jobs widget shows a one-word activity per job (tool name, `thinking`, `output` or `waiting`).
- Internal: run option `onToolEvent` is now `onProgressEvent`. No change for integrating callers.

## 1.0.0

- Raise the `pi` dependency floor to `>=1.0.4`.
- Breaking: `subagent` no longer waits. It starts a background job and returns a job id (`S1001`, ...) right away.
- Breaking: a finished job's result arrives as a new message that wakes the model. Cancelled jobs are delivered quietly.
- Breaking: the `tasks:[...]` parallel mode and the `concurrency` setting are removed. Call `subagent` once per task.
- Breaking: `agent` and `task` are required top-level fields.
- Breaking: `buildSubagentToolResult` and the result types take a single result. `details` is now `{runId, run}`.
- Breaking: `formatRunResults` is now `formatRunResult`, and `aggregateRunUsage` is now `toAggregatedUsage`.
- New: `/subagents` lists jobs. `/subagents cancel <id>` cancels one and `/subagents clear` drops finished ones.
- Esc no longer cancels a subagent run. Use `/subagents cancel`.
- New: a widget below the editor lists running jobs with a ticking elapsed time.
- New: a job's result renders like a native tool result, and each one expands on click.
- Headless and nested sessions wait for their own background jobs before settling.
- Usage moved from the launch result to the completion message's `details.usage`.
- Background jobs live in memory only, per pi session.
- `tools`/`disallowedTools` accept `*` patterns, e.g. `mcp__mde-build__*`.
- Fix: deeply nested subagents no longer fail session persistence with `ENAMETOOLONG`. Long paths are shortened.

## 0.20.1

- New: Ctrl+O or a click shows the full task under each agent in the call title.
- Progress lines for `mcp__<server>__<tool>`, `tool_search` and `codemode` calls are readable instead of raw JSON.

## 0.20.0

- Breaking: requires pi `>=0.99.0`.
- Subagents can use pi's built-in MCP, `tool_search` and `codemode`.
- Breaking: `pi-mcp-adapter` is no longer supported. Use pi's built-in MCP (`~/.pi/agent/mcp.json`).
- `inheritExtensions: false` also turns off the built-in `mcp`, `tool-search` and `codemode` extensions.

## 0.15.0

- New: each subagent run saves its own session to disk, under the parent session path (`<runId>/run-<n>/session.jsonl`).
- `defaultContext: "forked"` agents save at the same path instead of `~/.pi/agent/sessions/subagents/`.
- The tool result reports usage on `AgentToolResult.usage`. `details` gains `runId` and `results`.

## 0.14.1

- Rewrite the README for new users and move advanced usage to `docs/REFERENCE.md`.

## 0.14.0

- New: subagents can use MCP tools and other extensions that need `session_start`.
- Extensions bind only when the agent has an active package tool, and shut down with the session.
- The bind times out after 60s by default.

## 0.13.1

- New: each subagent run shows a one-line usage footer (tokens, cache, cost, context %), including on errors and aborts.
- The footer shows collapsed and expanded, one per task, with no total.

## 0.13.0

- The `subagent` call display follows the `expanded` flag (Ctrl+O).
- Running and expanded: shows one line per tool call (name and args, never the output).
- A finished result is empty when collapsed and shows the full output when expanded.
- A muted divider separates header and body when the body has content.

## 0.12.0

- New: `thinking` param on `subagent` calls. It overrides settings and frontmatter.
- New: `timeoutMs` param on `subagent` calls, and a `timeoutMs` agent frontmatter field.
- New: `timeoutMs` is capped at 2 hours. Larger values are clamped with a warning.
- Fix: the call display shows the effective `thinking` after overrides, and a new `timeoutMs` segment.
- Fix: the `SubagentParams` type was missing `maxTurns` in the tasks-mode branch. Type only.

## 0.11.0 — 2026-08-07

- Breaking: requires pi `>=0.83`. No support for older releases.
- Breaking: `peerDependencies` floor for `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` is now `>=0.84.1`.
- Behavior change: subagents share one `ModelRuntime`, created when the extension loads. Fixes a bug where the registry was ignored.
- If `ModelRuntime.create()` fails at load, every `subagent` call returns an error until `/reload`.
- A `/login` or new provider after load is not seen by subagents until `/reload`.

## 0.10.0 — 2026-08-06

- New: `maxTurns` is now a real per-agent turn limit (integer 1..100). Invalid values warn and mean no limit.
- Set `maxTurns` in agent frontmatter, in `agentOverrides` in `settings.json`, or per call on the `subagent` tool.
- Per-call `maxTurns` goes top-level in single mode, or inside each `tasks[]` item in parallel mode.
- Precedence: invocation > project settings > user settings > frontmatter > no limit.
- When the limit is reached, the run ends with `error: "reached maxTurns limit of N"`.
- One model response plus its tool calls counts as one turn.
- The `subagent` call display shows `maxTurns: <N>` (or `inherited`).
- `maxTurns` is no longer listed as an inert Claude field, so it no longer triggers the inert-usage warning.

## 0.9.4 — 2026-08-06

- Fix: discovery order of same-named agents is now deterministic (entries sorted by name).
- The duplicate-agent warning is now throttled like other inert-usage warnings.

## 0.9.3 — 2026-08-06

- New: directory-style agents, `<agentsDir>/<name>/AGENT.md`, alongside flat `<name>.md` files.
- The agent name comes from the manifest `name:`, or the directory name if absent. `description` is still required.
- New: when two agents resolve to the same name, the first wins and a warning names both paths.
- Behavior change: two same-named flat files used to resolve to the last one. Now the first one wins.
- Public API unchanged.

## 0.9.2 — 2026-08-05

- Fix: an unknown `provider/modelId` now warns before falling back to the session default model.

## 0.9.1 — 2026-07-30

- README restructure: agent examples now link to `examples/`, plus new usage examples for the `subagent` tool.

## 0.9.0 — 2026-07-30

- New: optional `tools` and `skills` params on the `subagent` tool, in single mode or per `tasks[]` item.
- Both replace the agent's resolved values. `[]` means none, and omitting the field inherits.
- `tools` takes native pi tool names only. `disallowedTools` stays settings and frontmatter only.
- Precedence for `model`, `tools` and `skills`: invocation > project settings > user settings > frontmatter > session default.
- Fix: the `subagent` call display now shows the effective `tools`/`skills` after overrides, and a new `skills` segment.
- Fix: an invocation `skills` override now reaches resource loading instead of being silently ignored.
- Known gap: with `inheritSkills: false`, a `skills` override shows in the display but is dropped at runtime with a warning.

## 0.8.1 — 2026-07-30

- Internal cleanup and extra tests. No change to the `subagent` tool contract.

## 0.8.0 — 2026-07-29

- New: optional `model` param on the `subagent` tool, as `provider/modelId`, in single mode or per `tasks[]` item.
- Precedence: invocation `model` > project settings > user settings > frontmatter > session default.
- A bare alias without `/` (e.g. `sonnet`) is rejected as a validation error.
- New: bundled `invoking-subagents` skill, also available as `/skill:invoking-subagents`.

## 0.7.0 — 2026-07-29

- Behavior change: `discoverAgents` is now async and returns a `Promise`. Call sites must `await` it.
- Behavior change: `loadOverrides` is replaced by `loadSettings`, which also returns `concurrency`.
- Fix: `agentOverrides` and `concurrency` now fall back between `pi-simple-agents` and `subagents` keys per field.
- Fix: a malformed `agentOverrides` value is ignored with a warning.
- Using the legacy `subagents` settings key now logs a deprecation warning. It still works.
- New: `concurrency` setting, default `4`, capped at 8 by the parallel task limit. Invalid values warn and use the default.
- New: `createAgentRegistry` module that loads agents, settings and overrides in one call.
- Performance: skip theme loading in subagent sessions (`noThemes: true`).

## 0.6.0 — 2026-07-29

- Behavior change: subagent runs now time out after 10 minutes by default. Before, they could hang forever.
- New: `timeoutMs` per agent, set through `agentOverrides`. Invalid values warn and use the default.
- A timed-out run ends with `status: "error"` and `"timed out after <N>ms"`. Partial output is discarded.
- New: live progress line per task in the `subagent` tool box: `<agent> · tools: <N> · <status>`.

## 0.5.0 — 2026-07-29

- `defaultReads`, `defaultContext`, `skills` and `description` now have real effect. They were parsed before but ignored.
- `defaultReads` preloads files into the agent context. Bad or missing entries warn and are skipped.
- `defaultContext` default is documented as `fresh`, which is what it always did. `forked` now works, with fallback to `fresh`.
- `skills` filters the inherited skills by exact name. Unmatched names warn. It does not preload skill content.
- `description` now builds the `subagent` tool description. New agents show up after a pi restart.
- Fix: fresh sessions record the real invocation cwd.

## 0.4.1 — 2026-07-28

- New: the `subagent` call title shows a second line with the agent's `model`, `thinking` and `tools`.
- Unset fields show `inherited`, empty tools show `none`, and more than 5 tools are cut with `+k more`.
- Parallel mode shows one line per task entry. Unknown agents are omitted.
- Fix: a partial `tasks` entry while streaming no longer crashes the renderer.

## 0.4.0 — 2026-07-28

- Frontmatter is now parsed with the `yaml` package (new dependency).
- New: `disallowedTools` field, a denylist applied after `tools`.
- New: Claude Code agent files in `.claude/agents/*.md` load and run unchanged.
- `tools` and `disallowedTools` accept Claude Code tool names (`Read`, `Bash`, `Edit`, ...) and map them to pi names.
- Claude-only tools with no pi equivalent pass through and are reported in one aggregated warning per 60 seconds.
- `model` accepts Claude aliases (`sonnet`, `opus`, `haiku`, `fable`, `inherit`), which fall back to the session default model.
- Claude fields with no effect in pi (e.g. `permissionMode`, `maxTurns`, `hooks`) are accepted and ignored, with one aggregated warning.
- `thinking`, `inheritSkills`, `inheritExtensions`, `defaultContext` and `skills` are now actually parsed.
- Fix: an invalid `systemPromptMode` or `defaultContext` now falls back to the default with a warning.
- Fix: values like `description: Use when: X` no longer drop the agent. They are recovered with a warning.
- New: warning when an unquoted `#` truncates a scalar value.
- Existing pi-native agent files behave as before.

## 0.3.3 — 2026-07-28

- Internal: the extension now uses `modelRegistry` directly, with typed SDK options.
- New: live e2e smoke test, run with `PI_LIVE_E2E=1 npm run test:e2e`.
- New scripts: `test:types` and `test:e2e`.
- Packaging: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui` and `typebox` are peer dependencies again.

## 0.3.2 — 2025-07-27

- New: `inheritExtensions` field (default `true`). When `false`, the agent starts without pi extensions.
- README split into user guide (`README.md`) and developer guide (`DEVELOPER.md`), both in English.

## 0.3.1 — 2025-07-27

- New: `inheritExtensions` field on `AgentConfig`.
- The extension uses `DefaultResourceLoader` for field-to-behavior mapping.

## 0.3.0 — 2025-07-31

- Subagents now run through the pi SDK (`runAgentViaSdk`) instead of child processes.
- `discoverAgents` and `loadOverrides` accept an optional 5s cache.
- New agent fields: `thinking`, `inheritSkills`, `defaultContext` and `skills`.
- `settings.json` accepts a `subagents` key as an alias for `pi-simple-agents`.
- Parallel tasks are capped at 4 at a time.
- Removed `parse-output.ts`.
- Packaging: the pi peer dependencies are dropped. `glob` and `zod` are now runtime dependencies.

## 0.2.2 — 2025-07-27

- Performance: no TUI re-renders during subagent runs. A light "Running..." indicator shows instead.
- Performance: no incremental JSON parsing when nothing listens for progress.
- Partial results render empty. Content shows only on the final result.

## 0.2.1 — 2025-07-27

- Fix: TUI freeze on large tool output. Progress text is cut to 500 characters.

## 0.2.0 — 2025-07-25

- Performance: stdout is parsed incrementally, only new lines.
- Progress updates are throttled to 100ms.
- Custom `renderResult` reuses `Text` to avoid render tree rebuilds.

## 0.1.2 — 2025-07-23

- Fix: add the `pi` manifest to `package.json` and move the extension to `extensions/`.

## 0.1.1 — 2025-07-23

- Update README.md.

## 0.1.0 — 2025-07-23

- Initial npm release as `pi-simple-agents`.
- `subagent` tool with single and parallel modes.
- YAML frontmatter parsing and validation.
- Claude Code compatible agent format, plus pi-simple-agents extensions.
- Agent overrides from `settings.json`.
- Streaming progress for parallel execution.
