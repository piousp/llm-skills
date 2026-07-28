# pi-simple-agents — Developer Guide

[![npm version](https://badge.fury.io/js/pi-simple-agents.svg)](https://badge.fury.io/js/pi-simple-agents)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Low-level API reference for developers integrating `pi-simple-agents` programmatically — agent discovery, configuration overrides, SDK-based execution, validation, and caching.

> For end-user documentation (defining agents, using the `subagent` tool, configuring overrides), see [README.md](./README.md).

## Installation

```bash
npm install pi-simple-agents
```

## Exported functions

```typescript
import {
  discoverAgents,
  loadOverrides,
  applyOverrides,
  runAgentViaSdk,
  mapWithConcurrencyLimit,
  clampThinkingLevel,
  validateSubagentParams,
  resolveAgents,
  formatRunResults,
  type AgentConfig,
  type AgentOverrides,
  type AgentRunResult,
  type CacheEntry,
  type RunAgentViaSdkOptions,
  type SubagentParams,
  type ValidationResult,
  type FormattedResults,
} from "pi-simple-agents";
```

## AgentConfig

The core type representing an agent's full configuration.

```typescript
interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPromptMode: "append" | "replace";
  inheritProjectContext: boolean;
  defaultReads: string[];
  source: "user";
  filePath: string;
  systemPrompt: string;
  thinking?: string;
  inheritSkills?: boolean;
  inheritExtensions?: boolean;
  defaultContext?: "forked" | "fresh";
  skills?: string[];
}
```

Fields are resolved from YAML frontmatter with defaults filled in by `discoverAgents`, then merged with overrides via `applyOverrides`.

## discoverAgents

Scans a directory for `.md` files with YAML frontmatter and returns `AgentConfig[]`.

```typescript
function discoverAgents(
  agentsDir: string,
  cache?: Map<string, CacheEntry<AgentConfig[]>>,
): AgentConfig[];
```

- Skips files missing `name` or `description` (logs a warning).
- Symlinks are supported.
- Defaults: `systemPromptMode: "append"`, `inheritProjectContext: true`, `defaultReads: []`.

### Cache

Pass a `Map<string, CacheEntry<AgentConfig[]>>` to cache results for 5 seconds (TTL). Subsequent calls within the TTL skip filesystem reads.

```typescript
const cache = new Map<string, CacheEntry<AgentConfig[]>>();
const agents = discoverAgents("~/.pi/agent/agents", cache);
const agentsAgain = discoverAgents("~/.pi/agent/agents", cache); // cached
```

## loadOverrides

Loads agent overrides from `settings.json`. Supports both `pi-simple-agents` and `subagents` top-level JSON keys, checked in that order.

```typescript
function loadOverrides(
  userSettingsPath: string,
  projectSettingsPath?: string,
  cache?: Map<string, CacheEntry<AgentOverrides>>,
): AgentOverrides;
```

When both paths are provided, project-level overrides take precedence over user-level overrides. Merge is field-level (not whole-object replacement).

```typescript
const overrides = loadOverrides(
  "~/.pi/agent/settings.json",
  "/path/to/project/.pi/settings.json",
);
```

## applyOverrides

Merges overrides into discovered agent configurations. Returns a new array; does not mutate the input.

```typescript
function applyOverrides(
  agents: AgentConfig[],
  overrides: AgentOverrides,
): AgentConfig[];
```

```typescript
const agents = discoverAgents("~/.pi/agent/agents");
const overrides = loadOverrides("~/.pi/agent/settings.json", ".pi/settings.json");
const configured = applyOverrides(agents, overrides);
```

## runAgentViaSdk

Runs an agent through the pi SDK's session API. Handles model resolution, thinking level, tool injection, resource loading, and cleanup.

```typescript
function runAgentViaSdk(
  agent: AgentConfig,
  task: string,
  options: RunAgentViaSdkOptions,
): Promise<AgentRunResult>;
```

### RunAgentViaSdkOptions

```typescript
type CreateSessionOpts = Pick<
  CreateAgentSessionOptions,
  "modelRegistry" | "model" | "thinkingLevel" | "tools" | "resourceLoader" | "sessionManager"
>;

interface RunAgentViaSdkOptions {
  modelRegistry: CreateAgentSessionOptions["modelRegistry"];
  createSession: (opts: CreateSessionOpts) => Promise<Pick<CreateAgentSessionResult, "session">>;
  resourceLoader: CreateAgentSessionOptions["resourceLoader"];
  sessionManager: CreateAgentSessionOptions["sessionManager"];
  signal?: AbortSignal;
  onProgress?: (text: string) => void;
  getModel?: (provider: string, modelId: string) => CreateAgentSessionOptions["model"];
}
```

`CreateAgentSessionOptions`/`CreateAgentSessionResult` come from
`@earendil-works/pi-coding-agent`, so `session` (`prompt`, `subscribe`, `getLastAssistantText`,
`dispose`, `abort`) is typed against the real SDK shape rather than a hand-rolled inline type.

- `createSession` — factory wrapping pi's `createAgentSession`. The library calls it with the resolved model, thinking level, and tools.
- `getModel` — resolver for `provider/modelId` syntax. Called when `agent.model` contains a `/`.
  In the extension, this is `(provider, modelId) => modelRegistry.find(provider, modelId)`.
- `signal` — `AbortSignal` for cancellation. Aborting before the session starts resolves immediately with an error.
- `onProgress` — receives text delta events from the session's subscription mechanism.

### AgentRunResult

```typescript
type AgentRunResult =
  | { status: "success"; agent: string; task: string; durationMs: number; finalText?: string }
  | { status: "error";   agent: string; task: string; durationMs: number; error: string };
```

Session disposal is guaranteed in a `finally` block regardless of success or error.

## mapWithConcurrencyLimit

Processes an array with a configurable concurrency cap. Preserves input order.

```typescript
function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]>;
```

The concurrency value is clamped to `[1, items.length]`. Empty input returns an immediately resolved empty array.

## clampThinkingLevel

Validates a thinking budget level against the allowed set.

```typescript
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

function clampThinkingLevel(level: string): ThinkingLevel | undefined;
```

Valid levels: `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`. Returns `undefined` with a `console.warn` for invalid values.

## validateSubagentParams

Validates the two accepted call shapes for the `subagent` tool.

```typescript
function validateSubagentParams(raw: unknown): ValidationResult<SubagentParams>;
```

### SubagentParams

```typescript
type SubagentParams =
  | { agent: string; task: string; tasks?: undefined }
  | { agent?: undefined; task?: undefined; tasks: Array<{ agent: string; task: string }> };
```

Validation rules:
- Exactly one of `{agent, task}` or `{tasks: [...]}` must be provided (not both, not neither).
- `tasks` array must have between 1 and 8 entries (`MAX_PARALLEL_TASKS`).
- Each entry must be `{ agent: string, task: string }` with non-empty strings.

### ValidationResult

```typescript
type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };
```

## resolveAgents

Resolves agent names to their full `AgentConfig` entries. Reports all unknown names in a single error message.

```typescript
function resolveAgents(
  names: string[],
  agents: AgentConfig[],
): ValidationResult<AgentConfig[]>;
```

```typescript
const agents = discoverAgents("~/.pi/agent/agents");
const resolved = resolveAgents(["scout", "worker"], agents);
if (resolved.ok) {
  // resolved.value: AgentConfig[]
}
```

## formatRunResults

Converts one or more `AgentRunResult` into a human-readable string.

```typescript
function formatRunResults(results: AgentRunResult[]): FormattedResults;
```

```typescript
interface FormattedResults {
  text: string;
  isError: boolean;
}
```

- Single result: renders inline (final text or error message).
- Multiple results: renders as markdown sections with agent name and status label.
- `isError` is `true` when **all** results are errors.

## Caching

Both `discoverAgents` and `loadOverrides` accept an optional `Map` cache with `CacheEntry<T>` values.

```typescript
interface CacheEntry<T> {
  timestamp: number;
  data: T;
}
```

The cache TTL is **5 seconds** (constant: `CACHE_TTL_MS`). The cache key for `loadOverrides` is a composite of both settings paths.

## Extension internals

The extension at `extensions/index.ts` registers the `subagent` tool with pi's `ExtensionAPI`. It:

1. Scans `~/.pi/agent/agents/` via `discoverAgents` (with caching).
2. Loads overrides from `~/.pi/agent/settings.json` and `{cwd}/.pi/settings.json` (with caching).
3. Validates parameters via `validateSubagentParams`.
4. Resolves agent names via `resolveAgents`.
5. Creates a `DefaultResourceLoader` per agent (from `@earendil-works/pi-coding-agent`) with field-to-behavior mapping:

```typescript
function createMinimalResourceLoader(agent: AgentConfig, cwd: string): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd,
    agentDir: path.join(os.homedir(), ".pi", "agent"),
    noExtensions: agent.inheritExtensions === false,
    noSkills: agent.inheritSkills === false,
    noContextFiles: agent.inheritProjectContext === false,
    systemPromptOverride:
      agent.systemPromptMode === "replace" && agent.systemPrompt
        ? () => agent.systemPrompt
        : undefined,
    appendSystemPromptOverride:
      agent.systemPromptMode === "append" && agent.systemPrompt
        ? (base) => [...base, agent.systemPrompt]
        : undefined,
  });
}
```

6. Resolves models via `ctx.modelRegistry.find(provider, modelId)` (passed through as `getModel`)
   and runs agents via `runAgentViaSdk` with concurrency cap of 4 via `mapWithConcurrencyLimit`.
   `ctx.modelRegistry` is forwarded to `runAgentViaSdk` unchanged as `modelRegistry`.
7. Formats results via `formatRunResults`.

## Running tests

```bash
npm test          # unit tests (node:test)
npm run test:types # tsc --noEmit type check
```

Tests use Node's built-in test runner (`node:test`) with `node --experimental-strip-types`.

### Live e2e smoke test

`test/e2e/subagent.e2e.test.ts` spawns a real `pi` process with the extension loaded straight
from this repo's `extensions/` directory and drives the actual `subagent` tool against a real
model. It's slow, costs tokens, is non-deterministic, and depends on a machine-local
`~/.pi/agent/agents` config (an agent named `pablo-planner` with a model override). It is **not**
part of `npm test` and must be opted into explicitly:

```bash
PI_LIVE_E2E=1 npm run test:e2e
```

## License

MIT