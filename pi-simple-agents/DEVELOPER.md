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
  disallowedTools?: string[];
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

- `disallowedTools` — denylist, forwarded to the SDK's `createSession` as `excludeTools`, applied
  after `tools`. Accepts the same Claude Code tool-name compatibility as `tools` (see
  `src/claude-compat.ts` below).
- `thinking`, `inheritSkills`, `inheritExtensions`, `defaultContext`, `skills` are parsed from
  frontmatter and populated onto `AgentConfig` by `discoverAgents` (previously declared on the
  type but silently dropped during parsing).
- `skills` is populated and now consumed via `skillsOverride` in `src/loader-config.ts` (see
  below): it filters the inherited skill set down to the named subset. It still does not preload
  the named skills' content into the subagent's context — not the same as Claude Code's
  skill-preload semantics.

## parseFrontmatter

Internal to `src/frontmatter.ts` (not exported from the package entry point, but documented here
since `discoverAgents` is a thin wrapper over it). Parses a `.md` file's YAML frontmatter block
using the `yaml` package (replacing the previous hand-rolled line-by-line parser) and normalizes
fields, applying Claude Code compatibility mapping along the way.

```typescript
function parseFrontmatter(content: string): FrontmatterResult;

interface FrontmatterResult {
  frontmatter: ParsedFrontmatter;
  body: string;
  inertFields: string[];
  inertTools: string[];
  modelAlias?: string;
  warnings: string[];
}
```

- `frontmatter` — the normalized field map. `tools`/`disallowedTools` have Claude Code tool names
  already mapped to pi names (via `mapClaudeTools`); `model` has Claude Code aliases/`inherit`
  normalized (via `normalizeClaudeModel`); enums (`systemPromptMode`, `defaultContext`) and
  booleans are validated, falling back to `undefined` (and thus to `discoverAgents`'s defaults) on
  an invalid value rather than silently corrupting the whole frontmatter.
- `inertFields` — Claude Code fields present in this file's frontmatter that have no functional
  effect in pi (`CLAUDE_INERT_FIELDS`).
- `inertTools` — Claude Code tool names present in `tools`/`disallowedTools` that have no pi
  equivalent (`CLAUDE_INERT_TOOLS`); they still pass through unchanged in the returned array.
- `modelAlias` — set when `model` was a recognized Claude Code alias (`sonnet`, `opus`, `haiku`,
  `fable`); the normalized `frontmatter.model` still holds the literal alias string (or
  `undefined` for `inherit`).
- `warnings` — per-file messages (invalid enum/boolean/scalar values, YAML parse failures) that
  `discoverAgents` prefixes with the file path and forwards to `console.warn`.
- The initial `yaml.parse` call is wrapped in try/catch with a second-chance retry, not a straight
  catch-and-empty: on failure, `attemptLenientRecovery` auto-quotes unindented plain-scalar lines
  containing an unquoted `": "` and reparses once; only if that also throws does
  `parseFrontmatter` fall back to `emptyResult` (empty frontmatter, warning, file skipped). This
  path is never entered when the first `yaml.parse` succeeds. A separate warn-only check
  (`detectCommentTruncation`), run only on first-try successes, flags an unquoted `#` inside a
  scalar value (YAML comment truncation) without rewriting anything.

`discoverAgents` aggregates `inertFields`/`inertTools`/`modelAlias` across all files in a directory
and reports them via one `console.warn`, throttled to once per 60 seconds by `claimUnwarned`
(`src/claude-compat.ts`) — see [Claude Code compatibility](./README.md#claude-code-compatibility)
in the README for the user-facing behavior and warning format.

## src/claude-compat.ts

Internal module (not part of the package's public exports) holding the Claude Code compatibility
data and helpers used by `parseFrontmatter` and `discoverAgents`:

- `CLAUDE_TOOL_MAP` — capitalized Claude Code tool name → lowercase pi tool name.
- `CLAUDE_INERT_TOOLS` — Claude Code tool names with no pi equivalent.
- `CLAUDE_INERT_FIELDS` — Claude Code frontmatter fields with no functional effect in pi.
- `CLAUDE_MODEL_ALIASES` — recognized Claude Code model aliases (`sonnet`, `opus`, `haiku`, `fable`).
- `mapClaudeTools(names): { tools, inert }` — maps a tool-name list through `CLAUDE_TOOL_MAP`,
  dedupes the result, and separately reports which input names were inert.
- `normalizeClaudeModel(model): { model?, alias? }` — turns `"inherit"` into `undefined`; tags
  recognized aliases with `alias` while passing the literal string through as `model`.
- `claimUnwarned(keys, registry?, ttlMs = 60_000): string[]` — generic once-per-TTL dedup: given a
  list of keys, returns only the ones not "claimed" (warned about) within the last `ttlMs`
  milliseconds, recording a claim timestamp for each returned key. Used to throttle the aggregated
  inert-fields/tools/model-alias warning to once per 60 seconds across an entire `discoverAgents`
  call, independent of how many files triggered it.

## discoverAgents

Scans a directory for `.md` files with YAML frontmatter and returns `AgentConfig[]`.

```typescript
function discoverAgents(
  agentsDir: string,
  cache?: Map<string, CacheEntry<AgentConfig[]>>,
  warnRegistry?: Map<string, number>,
): AgentConfig[];
```

- Skips files missing `name` or `description` (logs a warning).
- Symlinks are supported.
- Defaults: `systemPromptMode: "append"`, `inheritProjectContext: true`, `defaultReads: []`.
- An invalid `systemPromptMode` or `defaultContext` value normalizes to that field's default (with
  a per-file `console.warn`) instead of silently breaking the rest of the config — previously an
  invalid `systemPromptMode` silently dropped the entire system prompt.
- `warnRegistry` — optional override for the `Map<string, number>` used by `claimUnwarned` to
  throttle the aggregated Claude-compatibility warning (inert fields/tools/model aliases) to once
  per 60 seconds. Defaults to a module-level registry shared across calls; pass your own `Map` to
  isolate throttling (e.g. per test).

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
  "modelRegistry" | "model" | "thinkingLevel" | "tools" | "excludeTools" | "resourceLoader" | "sessionManager"
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

- `createSession` — factory wrapping pi's `createAgentSession`. The library calls it with the resolved model, thinking level, `tools`, and `excludeTools` (from `agent.disallowedTools`).
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

As of the fields connected below, `createMinimalResourceLoader`'s body is glue over
`buildLoaderOptions` (`src/loader-config.ts`), which composes `resolveDefaultReads` and
`filterSkillsByName`; and `runTasks`'s per-task session manager is glue over
`createSubagentSessionManager` (`src/subagent-session.ts`). The 6 modules below are internal to
`src/`, not exported from the package entry point.

### src/default-reads.ts

```typescript
function resolveDefaultReads(
  defaultReads: readonly string[],
  cwd: string,
  homeDir: string,
): ResolvedDefaultReads;

interface ResolvedDefaultReads {
  files: Array<{ path: string; content: string }>; // path: resolved absolute path
  warnings: string[];
}
```

Resolves and eagerly reads the `defaultReads` frontmatter field. Per entry: `~`/`~/...` expands
against `homeDir`; a non-absolute path resolves against `cwd` (the invocation's cwd, not the
agent's `.md` location); an absolute path passes through unchanged. `files` preserves frontmatter
order; duplicate entries (same resolved path) are deduped, first occurrence wins, including when
the first occurrence fails to read (the dedupe check happens before the read). A missing,
unreadable, or non-regular-file (e.g. a directory) entry produces one warning naming both the raw
and resolved path, and is omitted from `files` — the rest of the list still loads. Never throws.
Warnings are unprefixed (the caller adds `pi-simple-agents: `, per the `parseFrontmatter`
convention). Pure given its parameters: no internal `os.homedir()`/`process.cwd()`.

### src/loader-config.ts

```typescript
function buildLoaderOptions(
  agent: AgentConfig,
  cwd: string,
  homeDir: string,
): LoaderOptionsResult;

interface LoaderOptionsResult {
  options: MinimalLoaderOptions; // ConstructorParameters<typeof DefaultResourceLoader>[0]
  warnings: string[];
}
```

Builds the full `DefaultResourceLoader` options object, extracted out of
`createMinimalResourceLoader` (the `inherit*` → `no*`/prompt-override mapping shown above is
unchanged) and extended with two new overrides:

- `agentsFilesOverride`, set iff `agent.defaultReads.length > 0`. Reads the files eagerly at
  build time via `resolveDefaultReads` (its warnings flow into `result.warnings`); the returned
  callback appends the resolved extras after the SDK's base `agentsFiles`, skipping any extra
  whose resolved path already appears in the base.
- `skillsOverride`, set iff `agent.skills !== undefined && agent.inheritSkills !== false`. The
  callback filters the base skill set via `filterSkillsByName`, keeps `diagnostics` untouched, and
  `console.warn`s any missing requested names — this happens inside the SDK's reload path, which
  can't return warnings up through `result.warnings`, so it warns directly on every subagent run
  that hits it (not once per process).
- `agent.skills !== undefined && agent.inheritSkills === false` is contradictory config: it
  produces a warning in `result.warnings` and no `skillsOverride` is attached.

Never throws.

### src/skills-filter.ts

```typescript
function filterSkillsByName<T extends { name: string }>(
  base: readonly T[],
  requested: readonly string[],
): SkillsFilterResult<T>;

interface SkillsFilterResult<T extends { name: string }> {
  skills: T[];       // base order preserved
  missing: string[]; // requested names with no match, request order, deduplicated
}
```

Exact, case-sensitive whitelist filter over a `{ name: string }`-shaped collection. Generic over
`T` since the algorithm doesn't depend on the SDK's `Skill` type (which isn't re-exported from the
package's public entry point). Pure, total, never throws.

### src/subagent-session.ts

```typescript
function createSubagentSessionManager<S>(
  agent: Pick<AgentConfig, "name" | "defaultContext">,
  callerSessionFile: string | undefined,
  cwd: string,
  sessionDir: string,
  factory: SessionManagerFactory<S>,
): SubagentSessionResult<S>;

interface SessionManagerFactory<S> {
  forkFrom(sourcePath: string, targetCwd: string, sessionDir: string): S; // may throw
  inMemory(cwd: string): S;
}

interface SubagentSessionResult<S> {
  manager: S;
  warnings: string[];
}
```

Decides fork-vs-fresh for a subagent's session. `defaultContext !== "forked"` (including
`undefined` — the effective default is `fresh`) returns `factory.inMemory(cwd)`, no warnings.
`"forked"` without a `callerSessionFile` (the caller session isn't persisted) falls back to
`inMemory(cwd)` with a warning naming the agent. `"forked"` with a file calls
`factory.forkFrom(callerSessionFile, cwd, sessionDir)`; if that throws (e.g. the source file was
deleted or is empty/invalid), it catches and falls back to `inMemory(cwd)` with a warning that
includes the underlying error message. Never throws itself — forking a subagent's session never
aborts the run. Generic over `S` with an injected `factory`, mirroring the injection pattern
already used by `RunAgentViaSdkOptions.createSession` in `src/run.ts`, so it's testable with fakes
without touching disk.

Wired in `runTasks` with `sessionDir = ~/.pi/agent/sessions/subagents/` (a dedicated directory, not
the project's default session dir, so a forked subagent session never becomes the "most recent"
session that `pi --continue` would resume) and `callerSessionFile = ctx.sessionManager.getSessionFile()`.

### src/tool-description.ts

```typescript
const SUBAGENT_BASE_DESCRIPTION = "Run one or more subagents and wait for their results";

function buildSubagentToolDescription(
  agents: ReadonlyArray<Pick<AgentConfig, "name" | "description">>,
): string;
```

Builds the `subagent` tool's description shown to the model. No agents → exactly
`SUBAGENT_BASE_DESCRIPTION` (unchanged from before this field was wired up). One or more agents →
base description + `"Available agents:"` + one `- name: description` line per agent, sorted by
name for determinism (`readdirSync` order isn't guaranteed), each description `trim()`med (a
non-string description, e.g. from a hand-edited override file, is treated as empty rather than
throwing). Computed once, at extension registration time, against `process.cwd()` — the SDK has no
API to re-describe an already-registered tool, so agents added or renamed while pi is running don't
appear until restart. Pure.

### src/warn.ts

```typescript
const WARN_PREFIX = "pi-simple-agents: ";

function emitWarnings(warnings: string[]): void;
```

Shared helper: prefixes and `console.warn`s each warning in a list. Used by the glue in
`extensions/index.ts` to emit the warnings collected from `buildLoaderOptions` and
`createSubagentSessionManager`, keeping the `src/` warning-returning modules (which never call
`console.warn` for run-level warnings themselves) consistent with the emission convention already
used by `parseFrontmatter`.

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