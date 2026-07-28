# pi-simple-agents

[![npm version](https://badge.fury.io/js/pi-simple-agents.svg)](https://badge.fury.io/js/pi-simple-agents)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Simple agent system for pi-coding-agent. Provides agent discovery, configuration
overrides, and SDK-based agent execution for the pi ecosystem.

## Installation

```bash
npm install pi-simple-agents
```

## Usage

```typescript
import {
  createAgent,
  loadOverrides,
  applyOverrides,
  readOverridesFile,
  discoverAgents,
  type AgentConfig,
} from "pi-simple-agents";
```

## API

### `AgentConfig`

```typescript
interface AgentConfig {
  name: string;
  description: string;
  tools: string[];
  model?: string;
  systemPrompt?: string;
  systemPromptMode?: "append" | "replace";
  inheritProjectContext?: boolean;
  defaultReads?: string[];
  source: "user";
  filePath: string;
  thinking?: string;
  inheritSkills?: boolean;
  defaultContext?: "forked" | "fresh";
  skills?: string[];
}
```

### `discoverAgents(agentsDir: string, cache?: Map<string, CacheEntry<AgentConfig[]>>): AgentConfig[]`

Scans a directory for agent `.md` files with YAML frontmatter. Supports an
optional in-memory cache (TTL: 5s) to avoid redundant filesystem reads.

### `loadOverrides(userSettingsPath: string, projectSettingsPath?: string, cache?: Map<string, CacheEntry<AgentOverrides>>): AgentOverrides`

Loads agent overrides from `settings.json`. Supports both `pi-simple-agents`
and `subagents` config keys. Project-level overrides take precedence over
user-level.

### `applyOverrides(base: AgentConfig[], overrides: AgentOverrides): AgentConfig[]`

Merges per-agent overrides into the base agent configurations.

### `readOverridesFile(configPath: string): AgentConfig`

Reads a single settings file and extracts agent overrides.

### `createAgent(name: string, config: Partial<AgentConfig>): AgentConfig`

Creates a new agent configuration with defaults.

## Changelog

### 0.3.0 — 2025-07-31

- **SDK-based execution.** Replaced child-process spawning (`runAgent`) with
  SDK-based runner (`runAgentViaSdk`). Agent sessions now run through the pi
  SDK with proper resource loading, skill inheritance, and context management.
- **Caching.** `discoverAgents` and `loadOverrides` now accept an optional
  cache (TTL: 5s) to avoid redundant filesystem reads on repeated calls.
- **New agent fields.** Added `thinking` (thinking budget level), `inheritSkills`
  (control skill inheritance), `defaultContext` (`"forked"` | `"fresh"`), and
  `skills` (explicit skill list) to `AgentConfig`.
- **`subagents` config key.** `settings.json` now accepts a `subagents` key as
  an alias for `pi-simple-agents` for agent overrides.
- **Concurrency control.** Parallel task execution is now capped at 4 concurrent
  agents via `mapWithConcurrencyLimit`.
- **Removed `parse-output.ts`.** Incremental stdout parsing is no longer needed
  with the SDK runner.
- **Dependency changes.** Dropped `@earendil-works/pi-coding-agent` and
  `@earendil-works/pi-tui` peer dependencies. Now a standalone library with
  `glob` and `zod` as runtime dependencies.

### 0.2.2 — 2025-07-27

- **Perf: eliminate TUI re-renders during subagent execution.** Removed all
  `onUpdate` calls during progress — the `subagent` tool no longer calls
  `onUpdate` incrementally. The TUI shows a lightweight "Running..." indicator
  by default.
- **Perf: skip incremental JSON parsing when no progress listener.**
  `wireOutputHandlers` now skips `parseAgentOutputIncremental` entirely when
  `onProgress` is undefined.
- **Simplify `renderSubagentResult`.** Returns empty `Text` for partial updates;
  only renders content on the final result.

### 0.2.1 — 2025-07-27

- **Fix: TUI freeze on large tool output.** Two-layer fix:
  `lastProgress` truncated to 500 characters at the parser level, and
  `renderSubagentResult` also truncates when `isPartial === true`.

### 0.2.0 — 2025-07-25

- **Performance: incremental stdout parsing.** `parseAgentOutputIncremental()`
  only processes new lines since the last complete `\n`.
- **100ms throttle on `onUpdate`.** Progress updates are batched with a 100ms
  throttle.
- **Custom `renderResult` that reuses `Text`.** Avoids render tree rebuilds on
  every progress update.

### 0.1.2 — 2025-07-23

- Fix: add `pi` manifest to `package.json` and move extension to `extensions/`.

### 0.1.1 — 2025-07-23

- Update README.md.

### 0.1.0 — 2025-07-23

- Initial npm release as `pi-simple-agents`.
- `subagent` tool with single and parallel modes.
- YAML frontmatter parsing and validation.
- Claude Code compatible agent format + pi-simple-agents extensions.
- Agent overrides from `settings.json`.
- Streaming progress for parallel execution.
- Unit tests.

## License

MIT