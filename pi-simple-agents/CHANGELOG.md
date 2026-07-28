# Changelog

## 0.3.2 — 2025-07-27

- **New `inheritExtensions` field.** `AgentConfig` now supports `inheritExtensions` (boolean, default `true`). When `false`, the agent starts without loading pi extensions. The extension previously hardcoded `noExtensions: true`; it now respects the agent's field.
- **Documentation overhaul.** Split README into user-facing (`README.md`) and developer-facing (`DEVELOPER.md`) documents. Both are now in English. The user guide covers agent definitions, frontmatter fields, the `subagent` tool, and configuration overrides with full precedence examples. The developer guide covers the programmatic API: `discoverAgents`, `loadOverrides`, `applyOverrides`, `runAgentViaSdk`, `mapWithConcurrencyLimit`, `validateSubagentParams`, `resolveAgents`, `formatRunResults`, and extension internals.

## 0.3.1 — 2025-07-27

- New `inheritExtensions` field on `AgentConfig` to control extension loading per agent.
- Extension uses `DefaultResourceLoader` with full field-to-behavior mapping.
- Full test coverage for all public APIs.

## 0.3.0 — 2025-07-31

- **SDK-based execution.** Replaced child-process spawning (`runAgent`) with SDK-based runner (`runAgentViaSdk`). Agent sessions now run through the pi SDK with proper resource loading, skill inheritance, and context management.
- **Caching.** `discoverAgents` and `loadOverrides` now accept an optional cache (TTL: 5s) to avoid redundant filesystem reads on repeated calls.
- **New agent fields.** Added `thinking`, `inheritSkills`, `defaultContext`, and `skills` to `AgentConfig`.
- **`subagents` config key.** `settings.json` now accepts a `subagents` key as an alias for `pi-simple-agents` for agent overrides.
- **Concurrency control.** Parallel task execution is now capped at 4 concurrent agents via `mapWithConcurrencyLimit`.
- **Removed `parse-output.ts`.** Incremental stdout parsing is no longer needed with the SDK runner.
- **Dependency changes.** Dropped `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` peer dependencies. Now a standalone library with `glob` and `zod` as runtime dependencies.

## 0.2.2 — 2025-07-27

- **Perf: eliminate TUI re-renders during subagent execution.** Removed all `onUpdate` calls during progress. The TUI shows a lightweight "Running..." indicator by default.
- **Perf: skip incremental JSON parsing when no progress listener.** `wireOutputHandlers` now skips `parseAgentOutputIncremental` entirely when `onProgress` is undefined.
- **Simplify `renderSubagentResult`.** Returns empty `Text` for partial updates; only renders content on the final result.

## 0.2.1 — 2025-07-27

- **Fix: TUI freeze on large tool output.** Two-layer fix: `lastProgress` truncated to 500 characters at the parser level, and `renderSubagentResult` also truncates when `isPartial === true`.

## 0.2.0 — 2025-07-25

- **Performance: incremental stdout parsing.** `parseAgentOutputIncremental()` only processes new lines since the last complete `\n`.
- **100ms throttle on `onUpdate`.** Progress updates are batched with a 100ms throttle.
- **Custom `renderResult` that reuses `Text`.** Avoids render tree rebuilds on every progress update.

## 0.1.2 — 2025-07-23

- Fix: add `pi` manifest to `package.json` and move extension to `extensions/`.

## 0.1.1 — 2025-07-23

- Update README.md.

## 0.1.0 — 2025-07-23

- Initial npm release as `pi-simple-agents`.
- `subagent` tool with single and parallel modes.
- YAML frontmatter parsing and validation.
- Claude Code compatible agent format + pi-simple-agents extensions.
- Agent overrides from `settings.json`.
- Streaming progress for parallel execution.
- Unit tests.