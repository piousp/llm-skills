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
  loadSettings,
  applyOverrides,
  applyInvocationOverride,
  runAgentViaSdk,
  mapWithConcurrencyLimit,
  resolveConcurrency,
  DEFAULT_CONCURRENCY,
  clampThinkingLevel,
  validateSubagentParams,
  resolveAgents,
  formatRunResults,
  createAgentRegistry,
  type AgentConfig,
  type AgentOverrides,
  type InvocationOverride,
  type AgentRunResult,
  type CacheEntry,
  type RunAgentViaSdkOptions,
  type SubagentParams,
  type ValidationResult,
  type FormattedResults,
  type SubagentSettings,
  type AgentRegistry,
  type LoadedAgents,
  type AgentRegistryPaths,
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
  timeoutMs?: number;
  maxTurns?: number;
}
```

Fields are resolved from YAML frontmatter with defaults filled in by `discoverAgents`, then merged with overrides via `applyOverrides` (settings-level) and, per invocation, via `applyInvocationOverride` (see below).

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
- `maxTurns` — optional turn-count cap, integer 1..100 (constant `MAX_TURNS_LIMIT` in
  `src/run.ts`). Parsed from frontmatter by `parseFrontmatter` and validated at the use site by
  `resolveMaxTurns` (see below); a `0`, negative, non-integer, `NaN`/`Infinity`, or out-of-range
  value is warned-and-dropped (resolves to `undefined` = no limit), mirroring
  `resolveTimeoutMs`/`resolveConcurrency`.
- `timeoutMs` — optional wall-clock bound (ms) on a run's prompt execution, now parsed from
  frontmatter too (previously settings-only). Resolvable from frontmatter, settings-level
  `agentOverrides`, or a per-invocation override, in that ascending precedence. Range/ceiling is
  enforced solely at the `resolveTimeoutMs` use site in `src/run.ts` (see below), not during
  frontmatter parsing or override merging — both of those layers just pass the raw value through.

## InvocationOverride and applyInvocationOverride

Per-invocation override applied on top of an already-configured `AgentConfig`, distinct from the
settings-level `AgentOverrides` merged by `applyOverrides` above: this one comes from the
`subagent` tool call's own arguments (single-mode `{model, tools, skills, thinking, maxTurns,
timeoutMs}`, or a `tasks[]` entry's own copy of the same six fields), not from `settings.json`.

```typescript
interface InvocationOverride {
  model?: string;
  tools?: string[];
  skills?: string[];
  thinking?: string;
  maxTurns?: number;
  timeoutMs?: number;
}

function applyInvocationOverride(
  agent: AgentConfig,
  override: InvocationOverride,
): AgentConfig;
```

Pure merge, presence-gated per field: only fields actually present (not `undefined`) on `override`
replace the corresponding field on `agent` — `tools: []`/`skills: []` are valid and replace with an
empty array; only `undefined` means "leave this field alone". When `override` has no fields set at
all (all six of `model`, `tools`, `skills`, `thinking`, `maxTurns`, `timeoutMs` `undefined`),
`applyInvocationOverride` returns the SAME `agent` reference, not a copy.

`thinking` and `timeoutMs` are presence-gated the same way as the other four fields, but do no
range/level validation of their own here: an out-of-range `timeoutMs` or an unrecognized
`thinking` level still overrides the agent's field at this layer, and is only caught downstream
at its own resolution chokepoint (`resolveTimeoutMs`, `clampThinkingLevel`, both in `src/run.ts`)
when the run actually executes.

Used at two call sites: `extensions/index.ts`'s `runSingleTask`, which computes one
`effectiveAgent` reused for the whole run (see [Extension internals](#extension-internals)), and
`src/render-call.ts`'s `formatAgentParams`, which computes the effective values shown in the
tool_box call line (see [src/render-call.ts](#srcrender-callts) below).

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
- Field normalization (the `LIST_FIELDS`/`SCALAR_FIELDS`/model-alias/`ENUM_FIELDS`/`BOOLEAN_FIELDS`
  passes) is factored into a module-private `normalizeFrontmatterFields` helper (not exported),
  called once per `parseFrontmatter` invocation. Same order, same warnings, no behavior change —
  extracted purely to keep `parseFrontmatter` itself readable.
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
- `claimUnwarned(keys, registry, ttlMs = 60_000): string[]` — generic once-per-TTL dedup: given a
  list of keys, returns only the ones not "claimed" (warned about) within the last `ttlMs`
  milliseconds, recording a claim timestamp for each returned key. Used to throttle the aggregated
  inert-fields/tools/model-alias warning to once per 60 seconds across an entire `discoverAgents`
  call, independent of how many files triggered it. `registry` is a **required** parameter (no
  default) — there used to be a module-level singleton `Map` fallback; it was removed because it
  was dead in production (the only real caller always supplied its own registry) and, being
  shared across every call that omitted the argument, was a latent cross-call TTL-leak risk.
  `reportInertUsage`'s own `registry` parameter is required for the same reason.

## discoverAgents

Scans a directory for `.md` files with YAML frontmatter and returns `AgentConfig[]`. Two discovery
sources are scanned per directory entry: flat `<agentsDir>/<name>.md` files, and directory-style
agents at `<agentsDir>/<name>/AGENT.md` (a directory containing a manifest file named by the
`MANIFEST_FILENAME` constant). `MANIFEST_FILENAME` (`"AGENT.md"`) is matched case-sensitively by
design — this is deliberate, not an oversight: case-insensitive filesystems (macOS, Windows) would
otherwise silently mask a typo'd filename (e.g. `agent.md`) that then fails to match on
case-sensitive filesystems (Linux).

```typescript
export function discoverAgents(
  agentsDir: string,
  cache: Map<string, CacheEntry<Promise<AgentConfig[]>>> | undefined,
  warnRegistry: Map<string, number>,
): Promise<AgentConfig[]>;
```

**Behavior change: now async (was sync).** Backed by `fs/promises` — `readdir` plus a per-file
`stat`/`readFile` fanned out via `Promise.all`. Before any async fan-out, `readdir` entries are
sorted alphabetically by `entry.name` (plain string sort); that sorted order is what's preserved
through `Promise.all` and into the emitted warnings, not the OS-dependent raw `readdir` order.
Warnings collected per file are emitted sequentially after `Promise.all` settles, so their order
stays deterministic despite the parallel I/O.

- Skips files missing `name` or `description` (logs a warning). For a directory-manifest source,
  `name` resolves as `frontmatter.name ?? fallbackName` (the directory's basename); `description`
  has no such fallback, so a manifest without `description` is skipped exactly like a flat file.
- Directory sources are resolved by the module-private `resolveAgentSource(agentsDir, entry):
  Promise<AgentSource | undefined>` helper, which returns `{ filePath, fallbackName? }` for both
  flat files and directory manifests (`fallbackName` set only for the latter).
- Symlinks are supported (per-file `stat` follows symlinks) — this also covers a symlinked
  directory pointing at a directory-style agent, since `stat` follows the link to resolve the
  manifest.
- **Dedup by resolved name.** After per-file parsing, candidate agents are passed through the
  exported `dedupeByResolvedName(agents: AgentConfig[], warnRegistry: Map<string, number>):
  AgentConfig[]`: first-wins by resolved `name`, in the sorted-by-filename order established
  before the `Promise.all` fan-out (see above). Every later duplicate (whether flat-vs-flat,
  flat-vs-directory, or directory-vs-directory) is dropped and logged via one `console.warn`
  naming both file paths (the kept one and the skipped one). Because entries are sorted by
  filename first, which source wins a same-name collision is now deterministic and
  platform-independent — the alphabetically-first filename always wins. The duplicate warning is
  throttled per resolved name via `claimUnwarned(['duplicate-agent:<name>'], warnRegistry)`, the
  same mechanic and default 60s TTL `reportInertUsage` uses below — a repeat collision for the
  same name within the window is silently deduped without a repeat `console.warn`.
- Defaults: `systemPromptMode: "append"`, `inheritProjectContext: true`, `defaultReads: []`.
- An invalid `systemPromptMode` or `defaultContext` value normalizes to that field's default (with
  a per-file `console.warn`) instead of silently breaking the rest of the config — previously an
  invalid `systemPromptMode` silently dropped the entire system prompt.
- `warnRegistry` — **required** `Map<string, number>` used by `claimUnwarned` (via
  `reportInertUsage`) to throttle the aggregated Claude-compatibility warning (inert
  fields/tools/model aliases) to once per 60 seconds. There is no default/shared fallback —
  every caller owns its own registry's lifetime explicitly (`createAgentRegistry` creates one per
  registry instance; pass your own `Map` in tests to isolate throttling).
- **Never rejects.** An unreadable directory resolves to `[]`; an unexpected error anywhere in the
  pipeline is caught at the top level, logged via `console.warn` (prefixed, naming the directory
  and the error message), and resolves to `[]` rather than rejecting — so a rejected promise never
  sits poisoned in the cache for the 5s TTL. Per-file failures (unreadable file, missing
  `name`/`description`) still skip just that file with a warning, same as before.

### Cache

Pass a `Map<string, CacheEntry<Promise<AgentConfig[]>>>` to cache results for 5 seconds (TTL).
Subsequent calls within the TTL return the SAME cached in-flight/resolved promise (dedupe),
skipping filesystem reads.

```typescript
const cache = new Map<string, CacheEntry<Promise<AgentConfig[]>>>();
const agents = await discoverAgents("~/.pi/agent/agents", cache);
const agentsAgain = await discoverAgents("~/.pi/agent/agents", cache); // cached
```

## loadSettings

Replaces the deleted `loadOverrides` (`loadOverrides` no longer exists). Loads both
`agentOverrides` and `concurrency` from `settings.json`.

```typescript
interface SubagentSettings {
  agentOverrides: AgentOverrides;
  /** Raw value from settings JSON; validated at use site by resolveConcurrency. */
  concurrency?: unknown;
}

function loadSettings(
  userSettingsPath: string,
  projectSettingsPath?: string,
  cache?: Map<string, CacheEntry<Promise<SubagentSettings>>>,
): Promise<SubagentSettings>;
```

Reads `settings.json` via `fs/promises`. `agentOverrides` and `concurrency` are resolved as
**independent per-field fallbacks** between the top-level `pi-simple-agents` key and the legacy
`subagents` key: `primary?.field ?? legacy?.field`, evaluated separately for EACH field — so one
file can use `pi-simple-agents` for one field and `subagents` for another, and both are honored
(a real bug, fixed during QA: this is the correct independent-per-field behavior, not an
all-or-nothing key choice). When both keys set the same field, `pi-simple-agents`'s value wins.

Whenever the `subagents` key is present in a file AT ALL (regardless of which fields it supplies),
one deprecation `console.warn` fires (once per file, not once per field) recommending
`pi-simple-agents` instead — `subagents` still works fully, this is a warning only, not a
functional restriction.

`agentOverrides` gets a plain-object guard: if a resolved (non-`undefined`) `agentOverrides` value
isn't a plain object (e.g. a string, array, or `null`), it's ignored with a warning and treated as
`{}` — a fix for a silent-corruption bug where a malformed value used to flow through and produce
garbage per-agent merges with zero warning.

`concurrency` is **not** validated here — it's passed through as `unknown` raw JSON; validation
happens at the consuming site via `resolveConcurrency` (see below), the same division of
responsibility as the pre-existing `timeoutMs` field.

When both paths are provided, the project file overrides the user file per-field:
`agentOverrides` is merged, `concurrency` takes the project's value if defined, else the user's.
Malformed JSON in one file doesn't poison the other — each file's own parse/read failure only
affects that file's contribution. Cache key: `` `${userSettingsPath}::${projectSettingsPath ?? ""}` ``.
Never rejects.

```typescript
const settings = await loadSettings(
  "~/.pi/agent/settings.json",
  "/path/to/project/.pi/settings.json",
);
// settings.agentOverrides, settings.concurrency
```

### Settings JSON contract

```json
{
  "pi-simple-agents": {
    "concurrency": 6,
    "agentOverrides": { "scout": { "model": "..." } }
  }
}
```

`concurrency` controls the max number of subagent tasks run in parallel within one `subagent` tool
call (a BATCH-level setting, not per-agent). Default `4` (via `DEFAULT_CONCURRENCY`/
`resolveConcurrency`). Effective ceiling of 8, because the tool's own `MAX_PARALLEL_TASKS` bounds
how many tasks one call can even have. Read from either `pi-simple-agents.concurrency` (preferred)
or the legacy `subagents.concurrency` (deprecated, still works, warns). Project settings
(`{cwd}/.pi/settings.json`) override user settings (`~/.pi/agent/settings.json`) when the project
value is defined — same precedence pattern as `agentOverrides`.

## applyOverrides

Merges overrides into discovered agent configurations. Returns a new array; does not mutate the input.

```typescript
function applyOverrides(
  agents: AgentConfig[],
  overrides: AgentOverrides,
): AgentConfig[];
```

```typescript
const agents = await discoverAgents("~/.pi/agent/agents");
const { agentOverrides } = await loadSettings("~/.pi/agent/settings.json", ".pi/settings.json");
const configured = applyOverrides(agents, agentOverrides);
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
  "modelRuntime" | "model" | "thinkingLevel" | "tools" | "excludeTools" | "resourceLoader" | "sessionManager"
>;

export interface RunAgentViaSdkOptions {
  modelRuntime: NonNullable<CreateAgentSessionOptions["modelRuntime"]>;
  createSession: (opts: CreateSessionOpts) => Promise<Pick<CreateAgentSessionResult, "session">>;
  resourceLoader: CreateAgentSessionOptions["resourceLoader"];
  sessionManager: CreateAgentSessionOptions["sessionManager"];
  signal?: AbortSignal;
  onToolEvent?: (event: SubagentToolEvent) => void;
  getModel?: (provider: string, modelId: string) => CreateAgentSessionOptions["model"];
}
```

`CreateAgentSessionOptions`/`CreateAgentSessionResult` come from
`@earendil-works/pi-coding-agent`, so `session` (`prompt`, `subscribe`, `getLastAssistantText`,
`dispose`, `abort`) is typed against the real SDK shape rather than a hand-rolled inline type.

- `createSession` — factory wrapping pi's `createAgentSession`. The library calls it with the resolved model, thinking level, `tools`, and `excludeTools` (from `agent.disallowedTools`).
- `getModel` — resolver for `provider/modelId` syntax. Called when `agent.model` contains a `/`.
  In the extension, this is `(provider, modelId) => modelRuntime.getModel(provider, modelId)`. If it
  returns `undefined` for a well-formed `provider/modelId`, `resolveModel` logs a
  `pi-simple-agents: ` warning and the session falls back to its default model.
- `signal` — `AbortSignal` for cancellation. Aborting before the session starts resolves immediately with an error.
- `onToolEvent` — receives `SubagentToolEvent`s derived from the session's subscription mechanism (via `toSubagentToolEvent`), used to drive progress reporting. The `tool_start` variant now also carries a `summary: string`, pre-formatted by `formatToolCall` (`src/format-tool-call.ts`) from the tool's `toolName`/`args`. The event's underlying `result`/`partialResult` is never captured — only `toolName` and the formatted `args` summary flow through `SubagentToolEvent` — so a long-running subagent's tool output (e.g. a full `read`'s file contents) never accumulates in `TaskProgress.history` (`src/progress.ts`).

### AgentRunResult

```typescript
type AgentRunResult =
  | { status: "success"; agent: string; task: string; durationMs: number; finalText?: string }
  | { status: "error";   agent: string; task: string; durationMs: number; error: string };
```

Session disposal is guaranteed in a `finally` block regardless of success or error.

Internally, the abort-listener registration, timeout scheduling, and the `agentSession.prompt(task)`
call are factored into a module-private `runWithTimeoutAndAbort` helper (not exported) — extracted
out of `runAgentViaSdk` to keep the outer function's own promise-settlement/dispose logic
readable. No behavior change; not part of the public API.

### Turn counting

`runAgentViaSdk` enforces `agent.maxTurns` (resolved once at the top of the function via
`resolveMaxTurns`, see [resolveMaxTurns](#resolvemaxturns) above) by attaching a small
`subscribeTurnCounter(session, maxTurns, onLimit)` helper alongside the existing
`subscribeToolEvents` helper. The two helpers are deliberately separate: each subscribes to the
session's event stream for one purpose only, matching the single-responsibility shape of
`subscribeToolEvents`. `subscribeTurnCounter` keeps a closure-local `turnCount` and listens for
`turn_start` events on the session's subscription — one `turn_start` per model response (a turn
is "one model response + its batch of tool calls", per Claude Code's `maxTurns` semantics), so
counting `turn_start` matches the spec exactly and stays correct under parallel tool batching
(counting `tool_execution_start` would be off by N when the model emits multiple tool calls in one
turn). When `turnCount > maxTurns`, the helper fires `onLimit`; `runAgentViaSdk` then
settle-then-aborts:

```typescript
settleOnce(errorResult(ctx, `reached maxTurns limit of ${maxTurns}`));
Promise.resolve(agentSession.abort()).catch(() => { /* ignore */ });
```

This mirrors the existing `onTimeout` callback's settle-then-abort sequence inside
`runWithTimeoutAndAbort` exactly — same `settleOnce` first, then the same `agentSession.abort()`
fire-and-forget — so the three termination paths (timeout, maxTurns, signal-abort) compose via
the same `settleOnce` dedupe: whichever path fires first wins, and the others become no-ops. The
`resolveMaxTurns` return of `undefined` short-circuits the entire subscriber, so a run without a
cap adds zero overhead (no extra `subscribe` call).

Because the abort listener registered by `runWithTimeoutAndAbort` unblocks
`agentSession.prompt()` via `agentSession.abort()` but does not itself settle the run, a second
`options.signal?.aborted` check runs immediately after `runWithTimeoutAndAbort` resolves. This
mirrors the pre-prompt abort check (which settles the run before the prompt is even issued) and
guarantees that a signal aborted mid-prompt settles as the same `"run was aborted"` error rather
than falling through to the success block. The `settleOnce` guard keeps this safe against races
with the timeout or maxTurns paths — an already-settled run is a no-op.

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

## resolveConcurrency

```typescript
const DEFAULT_CONCURRENCY = 4;

function resolveConcurrency(value: unknown): number;
```

Validates the raw `concurrency` value read from settings (see `loadSettings` above).
`undefined` → `DEFAULT_CONCURRENCY` (4). A finite integer ≥ 1 → returned unchanged. Anything else
(`0`, negative, `NaN`, `Infinity`, non-integer, non-number) → `console.warn` naming the invalid
value, then `DEFAULT_CONCURRENCY`. No upper cap of its own — `mapWithConcurrencyLimit` already
clamps to `[1, items.length]`, and the `subagent` tool's own `MAX_PARALLEL_TASKS` (8) bounds
`items.length`, so an effective ceiling of 8 applies at the tool layer, not inside this function.

## resolveTimeoutMs

```typescript
const DEFAULT_TIMEOUT_MS = 600_000; // 10 min
const MAX_TIMEOUT_MS = 7_200_000;   // 2h ceiling

function resolveTimeoutMs(value: unknown): number;
```

Pure use-site validation of the `timeoutMs` value on an `AgentConfig` (frontmatter, settings
`agentOverrides`, or invocation override — all three flow through the same `AgentConfig.timeoutMs`
field by the time this runs). `undefined` → `DEFAULT_TIMEOUT_MS`. A finite number `> 0` and
`<= MAX_TIMEOUT_MS` → returned unchanged. A finite number `> 0` but exceeding `MAX_TIMEOUT_MS`
→ **clamped** to `MAX_TIMEOUT_MS` with a `console.warn` (not dropped to the default — the caller's
intent to run long is honored up to the ceiling). Anything else (non-number, `<= 0`, `NaN`,
`Infinity`) → `console.warn` naming the invalid value, then `DEFAULT_TIMEOUT_MS`. `MAX_TIMEOUT_MS`
is enforced only here, so every layer that can set `timeoutMs` (frontmatter, settings, invocation)
inherits the same 2-hour ceiling for free.

## resolveMaxTurns

```typescript
const MAX_TURNS_LIMIT = 100;

function resolveMaxTurns(value: unknown): number | undefined;
```

Pure use-site validation of the `maxTurns` value on an `AgentConfig` (see [AgentConfig](#agentconfig)
and [runAgentViaSdk turn counting](#turn-counting) below). Mirrors `resolveConcurrency` above but
resolves to `undefined` (no limit) instead of a default, since the absence of a cap is itself a
valid configuration. `undefined` → `undefined`. An integer in `[1, MAX_TURNS_LIMIT]` → returned
unchanged. Anything else (`0`, negative, `> 100`, `NaN`, `Infinity`, non-integer, non-number) →
`console.warn` naming the invalid value, then `undefined` (= no limit). No hard error — same
warn-and-fall-through discipline as `resolveTimeoutMs` and `resolveConcurrency`.

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
type TaskEntry = { agent: string; task: string } & InvocationOverride;

type SubagentParams =
  | ({ agent: string; task: string; tasks?: undefined } & InvocationOverride)
  | ({ agent?: undefined; task?: undefined; tasks: TaskEntry[] }
      & Partial<Record<keyof InvocationOverride, undefined>>);
```

The tasks-mode branch's override side is now a **self-maintaining mapped type**
(`Partial<Record<keyof InvocationOverride, undefined>>`) instead of a hand-written list of
`field?: undefined` lines. This closes a real drift bug: the hand-written union had been missing
`maxTurns` in this branch since 0.10.0 added it to `InvocationOverride` (only `model`/`tools`/
`skills` were listed), so tasks-mode's type never actually forbade a stray top-level `maxTurns`
at the type level, even though the runtime check in `validateTasksMode` always rejected it
correctly. Mapping the type off `InvocationOverride`'s own keys means every future field added to
`InvocationOverride` (like this release's `thinking`/`timeoutMs`) is automatically reflected here
too, with no separate list to keep in sync.

Both call shapes intersect `InvocationOverride` (see above): single mode carries `model`/`tools`/
`skills`/`thinking`/`maxTurns`/`timeoutMs` directly on the top-level object, `tasks` mode carries
them per entry via `TaskEntry`. `invocationOverrideOf(t)` (`src/validate.ts`) extracts just the
present override fields off either shape (a `TaskEntry`, or validated single-mode args) into a
plain `InvocationOverride`, for feeding to `applyInvocationOverride`.

Validation rules:
- Exactly one of `{agent, task, ...}` or `{tasks: [...]}` must be provided (not both, not neither).
- `tasks` array must have between 1 and 8 entries (`MAX_PARALLEL_TASKS`).
- Each entry must be `{ agent: string, task: string }` with non-empty strings, plus optional
  per-entry `model` (a `"provider/modelId"` string, same format/validation as single-mode `model`
  below), `tools` (an array of strings), and `skills` (an array of strings). `[]` is a valid value
  for `tools`/`skills` and is distinct from omitting the field: omitted means "inherit the agent's
  configured value", `[]` means "override to empty".
- In single mode, a top-level `model` must be a `"provider/modelId"` string (rejected otherwise
  with a message naming the required format); top-level `tools`/`skills` must each be an array of
  strings. `thinking`/`maxTurns`/`timeoutMs` get a minimal type guard (`typeof` check) at this
  same seam — an ill-typed value is warned and dropped, not a hard validation error; range/level
  checks live at each field's own use site (`resolveMaxTurns`, `resolveTimeoutMs`,
  `clampThinkingLevel`), not here.
- In `tasks` mode, top-level `model`/`tools`/`skills`/`thinking`/`maxTurns`/`timeoutMs` are
  rejected outright (checked via a small loop over all six fields before validating `tasks`
  itself) with an error naming the field and pointing at the per-entry equivalent — overrides
  only apply per task in this mode.

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
const agents = await discoverAgents("~/.pi/agent/agents");
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

Both `discoverAgents` and `loadSettings` accept an optional `Map` cache with `CacheEntry<T>` values.

```typescript
interface CacheEntry<T> {
  timestamp: number;
  data: T;
}
```

The cached value is now promise-valued (`CacheEntry<Promise<T>>`, not `CacheEntry<T>`): a cache hit
within the 5s TTL returns the SAME cached promise, giving in-flight dedupe (concurrent callers
sharing one cache never trigger duplicate filesystem reads) in addition to the TTL itself.

The cache TTL is **5 seconds** (constant: `CACHE_TTL_MS`). The cache key for `loadSettings` is a
composite of both settings paths.

## createAgentRegistry

New module `src/agent-registry.ts`. Composes `discoverAgents` + `loadSettings` + `applyOverrides`
+ `resolveConcurrency` behind one `load`/`peek` API, and is what the extension actually uses — see
[Extension internals](#extension-internals) below.

```typescript
interface LoadedAgents {
  /** Overrides already applied. Treat as immutable. */
  agents: readonly AgentConfig[];
  /** Already resolved via resolveConcurrency; always a valid integer ≥ 1. */
  concurrency: number;
}

interface AgentRegistry {
  /** Async, TTL-cached (5s, inherited from the underlying loaders),
      in-flight-deduped, never rejects. Updates the peek snapshot for `cwd`
      on completion. */
  load(cwd: string): Promise<LoadedAgents>;
  /** Sync, zero I/O. Last COMPLETED load for exactly this cwd, or undefined.
      May be arbitrarily stale; freshness is driven by load() callers. */
  peek(cwd: string): LoadedAgents | undefined;
}

interface AgentRegistryPaths {
  agentsDir: string;
  userSettingsPath: string;
}

function createAgentRegistry(paths: AgentRegistryPaths): AgentRegistry;
```

`createAgentRegistry` does no I/O at construction. `load(cwd)` derives
`projectSettingsPath = path.join(cwd, ".pi", "settings.json")` internally (no injection point —
deliberate, one implementation, YAGNI), runs `discoverAgents` and `loadSettings` in PARALLEL via
`Promise.all` (both are independent I/O and neither rejects, so there's no fail-fast reason to
serialize them), applies `applyOverrides`, resolves concurrency via `resolveConcurrency`, stores
the result keyed by `cwd` in an internal snapshot map (for `peek`), and returns it.

`peek(cwd)` is purely synchronous/zero-I/O: it returns the last COMPLETED `load(cwd)` result for
that exact `cwd`, or `undefined` if none completed yet — used by the extension's `renderCall`
(which must stay synchronous per the SDK's `renderCall` contract).

The registry owns ALL its instance state internally (agents cache, settings cache, a
`warnRegistry` for Claude-compat inert-field warning dedup, and the peek snapshots) — no
module-level globals, so two `createAgentRegistry()` instances never share caching/dedup state
with each other.

`load` never rejects (it composes only never-rejecting primitives).

```typescript
const registry = createAgentRegistry({
  agentsDir: "~/.pi/agent/agents",
  userSettingsPath: "~/.pi/agent/settings.json",
});

const { agents, concurrency } = await registry.load(process.cwd());
// later, synchronously, e.g. inside renderCall:
const snapshot = registry.peek(process.cwd());
```

## Extension internals

The extension at `extensions/index.ts` registers the `subagent` tool with pi's `ExtensionAPI`. Its
default export is now `async function (pi: ExtensionAPI): Promise<void>` (was sync); activation
awaits `registry.load(process.cwd())` before building the tool description and calling
`pi.registerTool(...)`. It:

1. Loads agents and settings via one `createAgentRegistry({ agentsDir: AGENTS_DIR, userSettingsPath: ... })`
   instance's `registry.load(cwd)` — this composes `discoverAgents` (`~/.pi/agent/agents/`) and
   `loadSettings` (`~/.pi/agent/settings.json` + `{cwd}/.pi/settings.json`) plus `applyOverrides`
   and `resolveConcurrency`, replacing the old module-level `agentCache`/`overridesCache`/
   `loadAvailableAgents` helpers, which combined `discoverAgents` + `loadOverrides` +
   `applyOverrides` by hand — those are gone.
2. `registry.peek(cwd)` is used wherever a synchronous, zero-I/O read of the last completed load
   is needed (e.g. `renderCall`, which must stay synchronous per the SDK's `renderCall` contract).
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

6. Resolves models via `modelRuntime.getModel(provider, modelId)` (passed through as `getModel`)
   and runs agents via `runAgentViaSdk` with a configurable concurrency (default 4, resolved via
   `resolveConcurrency`) via `mapWithConcurrencyLimit` — no longer a hardcoded `4`. The value comes
   from `registry.load(ctx.cwd)`'s resolved `concurrency` field, threaded through
   `RunTasksOptions.concurrency: number`. A separate, extension-level `ModelRuntime` — built once,
   eagerly, via `ModelRuntime.create()` at extension load — is what's forwarded to
   `runAgentViaSdk`/`createSession` as `modelRuntime`, and is also used to build the `getModel`
   resolver (resolving `"provider/modelId"` config strings) passed to `createSession`. Because
   this `ModelRuntime` snapshot is frozen at extension-load time, a `/login` performed later in
   the session requires a `/reload` before subagents pick up the new credentials.
7. Formats results via `formatRunResults`.

`runTasks`'s per-task worker, `runSingleTask` (resource loader creation/reload, session manager
creation, the SDK run, and progress-tracker teardown), is exported from `extensions/index.ts`
(was module-private) purely so its unit tests can call it directly — not part of a stable public
API, just a visibility change for testability. `runSingleTask` computes ONE
`effectiveAgent = applyInvocationOverride(agent, invocationOverrideOf(t))` per task and reuses
that single reference across all three of its call sites — `createMinimalResourceLoader`,
`createSubagentSessionManager`, and `runAgentViaSdk` — so a per-invocation `model`/`tools`/`skills`/
`thinking`/`maxTurns`/`timeoutMs` override (the task's own override fields, see
[InvocationOverride](#invocationoverride-and-applyinvocationoverride) above) applies consistently
to resource loading, session naming/forking, and the actual SDK run — not just to model
resolution.

As of the fields connected below, `createMinimalResourceLoader`'s body is glue over
`buildLoaderOptions` (`src/loader-config.ts`), which composes `resolveDefaultReads` and
`filterSkillsByName`; and `runTasks`'s per-task session manager is glue over
`createSubagentSessionManager` (`src/subagent-session.ts`). The 7 modules below are internal to
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

The returned `options` also unconditionally include `noThemes: true` — themes are only consumed by
interactive mode, and subagent sessions are headless, so this skips theme loading/resolution work
on every subagent's `resourceLoader.reload()`.

Never throws.

### src/render-call.ts

```typescript
type RenderTaskEntry = { agent?: string; task?: string } & InvocationOverride;

type SubagentCallArgs = {
  agent?: string;
  task?: string;
  tasks?: RenderTaskEntry[];
} & InvocationOverride;

interface CallTheme {
  fg(color: "toolTitle" | "accent" | "dim", text: string): string;
  bold(text: string): string;
}

function buildSubagentCallText(
  args: SubagentCallArgs,
  theme: CallTheme,
  paramAgents: ReadonlyMap<string, AgentConfig>,
): string;

function formatAgentParams(agent: AgentConfig, override?: InvocationOverride): string;
```

Builds the `tool_box` call display text for the `subagent` tool — the one/two-line summary shown
while/after the tool call renders in single mode (one `agent`/`task`) or parallel mode (a `tasks`
array). `buildSubagentCallText` dispatches on whether `args.tasks` is non-empty; each branch looks
up the named agent(s) in `paramAgents` and, when found, appends a dim parameter line built by
`formatAgentParams`.

- `formatAgentParams` merges `agent` with `override` via `applyInvocationOverride` first, then
  renders the *effective* (post-invocation-override) `model`/`thinking`/`tools`/`skills`/
  `maxTurns`/`timeoutMs` — not the agent's raw configured values. This is deliberate: before this
  module took its current shape, the render showed the agent's configured values even when an
  invocation override changed what would actually run, which was misleading. `thinking` now goes
  through the same merge as the other fields — it has its own `InvocationOverride.thinking` field
  (added alongside `timeoutMs` in this release), so it is no longer read directly off
  `agent.thinking`.
- The rendered param line has the fixed shape
  `model: ... · thinking: ... · tools: ... · skills: ... · maxTurns: ... · timeoutMs: ...`.
- `formatList` (private, generalized from an earlier `formatTools`) renders both the `tools` and
  `skills` segments: `undefined` → `"inherited"`, empty array → `"none"`, otherwise the first
  `MAX_ITEMS_SHOWN` items comma-joined, with `+N more` appended when the list is longer.
- In parallel mode (`buildSubagentCallText` → `buildParallelCallText`), each task's own
  `tools`/`skills`/`model` override is looked up via `invocationOverrideOf(t)` and merged via
  `applyInvocationOverride` independently per task/line — one task's override never bleeds into
  another task's rendered line.

### src/format-tool-call.ts

```typescript
function formatToolCall(toolName: string, args: unknown): string;
```

Formats a single tool call into a short, bounded (≤80 chars, via `render-call.ts`'s exported
`truncate`) human-readable line, used to build `TaskProgress.history` entries for the expanded
in-progress stream (see [src/render-result.ts](#srcrender-resultts) below).

- Known tools get a purpose-built one-liner: `read path:offset-limit` (or `path:offset+` /
  `path:1-limit` when only one of `offset`/`limit` is set, or bare `path` when neither is set),
  `write path`, `edit path (N edits)`, `$ <first line of command>` (via `firstLine`, for `bash`),
  `grep /pattern/ in path (glob)` (path/glob segments omitted when absent), `find pattern in path`
  (or bare `find pattern` without a path), `ls path` (defaults to `.` when no path is given).
- Any other tool name falls back to `toolName + JSON.stringify(args)` (dropped entirely, leaving
  just `toolName`, if `args` doesn't stringify or stringifies to nothing).
- **`write`'s `content` and `edit`'s `edits[].oldText`/`newText` are never read or included** —
  only `path` and, for `edit`, the edit count. This is deliberate: these summaries are retained in
  `TaskProgress.history` for the lifetime of a running subagent, so including full file contents
  there would defeat the point of not capturing tool results (see the `onToolEvent` note above).
- Pure, total, never throws (`args` that isn't an object is treated as `{}` for the known-tool
  formatters, and `safeJson` catches non-serializable `args` for the fallback).

### src/render-result.ts

```typescript
export const DIVIDER = "\u2500\u2500\u2500"; // ───

interface ResultTheme {
  fg(color: "accent" | "dim" | "muted" | "toolOutput", text: string): string;
}

interface SubagentResultView {
  isPartial: boolean;
  expanded: boolean;
  progress: readonly TaskProgress[] | undefined;
  content: string;
}

function buildSubagentResultText(view: SubagentResultView, theme: ResultTheme): string;
```

Pure function that decides the `subagent` tool box's body text — everything below the header
built by `buildSubagentCallText` (`src/render-call.ts`) — for the host's `expanded` flag (Ctrl+O /
`app.tools.expand`). `extensions/index.ts`'s `renderSubagentResult` delegates to this function
instead of carrying its own `isPartial`/`expanded` branching, so the four-state matrix below lives
in one tested, side-effect-free place.

| `isPartial` | `expanded` | Body |
|---|---|---|
| `true` | `false` | `buildProgressLines(progress, theme)` — one status line per agent (unchanged from before this change). |
| `true` | `true` | `buildProgressStream(progress, theme)` (`src/progress.ts`) — the status line per agent, each followed by its indented `history` of tool-call summaries. |
| `false` | `false` | Empty string — no output shown. |
| `false` | `true` | The subagent's/subagents' full `content`, colored `toolOutput`. |

In every case except the `false`/`false` row (and the `true` row with no `progress` at all, which
also returns `""`), the body is prefixed with `${theme.fg("muted", DIVIDER)}\n` — the divider only
appears when there's something to separate it from the header.

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
function toErrorMessage(error: unknown): string;
```

`emitWarnings` prefixes and `console.warn`s each warning in a list. Used by the glue in
`extensions/index.ts` to emit the warnings collected from `buildLoaderOptions` and
`createSubagentSessionManager`, keeping the `src/` warning-returning modules (which never call
`console.warn` for run-level warnings themselves) consistent with the emission convention already
used by `parseFrontmatter`.

`toErrorMessage` normalizes a caught `unknown` value to a display string: `error.message` when
it's an `Error` instance, `String(error)` otherwise. Never throws. Used by every `catch` block
across `src/` that needs to log/report an error message (`agents.ts`, `frontmatter.ts`,
`subagent-session.ts`, `run.ts`), replacing 4 previously-duplicated inline ternaries.

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