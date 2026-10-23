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

The package exposes exactly one public entry point to integrators: `extensions/index.ts` (the pi extension registered via `"pi": { "extensions" }` in package.json; there is no `main`/`exports`). `src/*` is internal (1.1.0 precedent) — its named exports are per-module, e.g.:

```typescript
// src is internal; these are the dev-facing module homes, not package exports
import { discoverAgents, loadSettings, applyOverrides, applyInvocationOverride } from "../src/agents.ts"; // re-exports from src/overrides.ts
import { runAgentViaSdk, clampThinkingLevel, type AgentRunResult } from "../src/run.ts";
import { validateSubagentParams, resolveAgent, invocationOverrideOf } from "../src/validate.ts";
import { createAgentRegistry } from "../src/agent-registry.ts";
```

### Module map (1.2.0)

- `extensions/index.ts` — the published extension: typebox schema, registrations, job wiring,
  `deliverJobResult`, `SubagentToolDetails` re-export, `runSingleTask` re-export. Thin wiring only.
- `src/render-extensions.ts` — the renderers (call/result/message), with the agent registry
  injected as a `GetAgents(cwd)` parameter instead of a closure over the entry's module state.
- `src/task-runner.ts` — task orchestration: `RunTaskOptions`, `RUN_INDEX`, `SESSION_MANAGER_FACTORY`,
  `runSingleTask`. Loader warnings are emitted here, in ONE point, right after the loader's
  `reload()` resolves (Q2: previously the unknown-skills warning fired mid-reload via a direct
  `console.warn`; texts unchanged, ordering deliberately changed).
- `src/overrides.ts` — the single home for override semantics: `InvocationOverride`, `OVERRIDE_KEYS`,
  `invocationOverrideOf`, `applyInvocationOverride`/`applyOverrides` (moved verbatim), the settings
  field whitelists (`SETTINGS_EXCLUDED_FIELDS`/`SETTINGS_OVERRIDABLE_FIELDS`),
  `validateAgentOverridesEntry`, and the shared field guards (`isValidModelRef`, `isValidMaxTurns`,
  `MAX_TURNS_LIMIT` — moved here so `run.ts`/`frontmatter.ts`/`validate.ts` all import one module
  and the runtime import graph stays acyclic). `validate.ts`/`agents.ts` re-export the moved symbols
  so existing import sites stay valid.
- `src/run.ts` — `runAgentViaSdk` keeps its `new Promise` + async-IIFE shape on purpose: `settleOnce`
  must be externally callable by timeout/maxTurns/abort listeners. The two abort checks are
  phase-distinct (pre-bind, post-prompt) and live apart deliberately.
- `src/transcript.ts` — bounded in-memory transcript of a background job's live activity
  (`TranscriptEntry`/`TranscriptState`, pure `applySessionEvent` reducer, one `createTranscriptSink`
  factory). Fed through `runSingleTask`'s `onSessionEvent` seam (`src/run.ts` → `src/task-runner.ts` →
  `src/background-jobs.ts`, which exposes it as `jobs.getTranscript(id)`); append-only, render-free —
  capturing costs nothing unless a peek window renders it.
- `src/peek-window.ts` — the `/subagents peek` overlay: pure `buildPeekLines` (transcript tail —
  text, 5-line thinking cap, tool starts/ends, elision, frozen settled result), the
  `PeekOverlayComponent` (owns the 250 ms pulse that stops itself once the job settles), and
  `createPeekManager` (fire-and-forget `ctx.ui.custom` overlay, floating-first with `w` cycling to
  fullscreen, warn-path on rejection). Structural `Peek*` theme/keybindings/tui subsets keep it
  testable without pi-tui.
- `src/session-reconcile.ts` — pure reconciliation of a session's subagent spend from disk
  (backing `/subagents session`): structural shapes for pi `.jsonl` entries, ports of pi's
  `getSessionStats`/`getUsageCostBreakdown`/`computeCacheWaste`, and `buildSubagentSessionReport`
  (see its section below). FS access is injected (`ReconcileFs`), so all aggregation is testable
  with in-memory fixtures; the only node I/O lives in one wiring adapter.

### Defensive optionality (test seams)

Several optionals in `runAgentViaSdk`/`runSingleTask`/`loadSettings` are always passed by the only
production caller yet stay optional deliberately (Q5): `tracker`/`onProgressEvent` (runSingleTask),
`getModel` (run options), `cache`/`projectSettingsPath` (loadSettings). Each dead-in-production
branch is a pinned test seam — a unit test exercises it and pins a guarantee (e.g. the run still
settles with an accurate usage snapshot when no event collector is passed; settings load works
without a cache). Removing the optionality would delete the branch the corresponding test exercises
and lose the guarantee; don't make them required without re-cutting those test plans.

### SubagentJobMessageDetails union (1.2.0)

The completion-message details are a `status`-keyed discriminated union: `failed` carries no
`run`/`usage` keys at all; `completed`/`cancelled` always carry `run` (usage optional, mirroring
`AgentRunResult.usage`'s deliberated optionality for legacy persisted sessions). The persisted
message JSON is byte-identical to pre-union output (`run: undefined` keys were never serialized),
and renderers keep their defensive `details?.` chains because the host hydrates persisted sessions
verbatim with no validation or migration.

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
  `resolveTimeoutMs`.
- `timeoutMs` — optional wall-clock bound (ms) on a run's prompt execution, now parsed from
  frontmatter too (previously settings-only). Resolvable from frontmatter, settings-level
  `agentOverrides`, or a per-invocation override, in that ascending precedence. Range/ceiling is
  enforced solely at the `resolveTimeoutMs` use site in `src/run.ts` (see below), not during
  frontmatter parsing or override merging — both of those layers just pass the raw value through.

## InvocationOverride and applyInvocationOverride

Per-invocation override applied on top of an already-configured `AgentConfig`, distinct from the
settings-level `AgentOverrides` merged by `applyOverrides` above: this one comes from the
`subagent` tool call's own arguments (`{model, tools, skills, thinking, maxTurns, timeoutMs}`), not
from `settings.json`.

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
- `mapClaudeTools(names): { tools, inert }` — maps a tool-name list through `CLAUDE_TOOL_MAP`,
  dedupes the result, and separately reports which input names were inert.
- `normalizeClaudeModel(model): { model? }` — turns `"inherit"` into `undefined`; everything else
  passes through verbatim. No model aliases exist (removed with the strict-model change, 1.2.0):
  form and resolvability are enforced strictly at `resolveModel` (`src/run.ts`), where a malformed
  or unresolvable model FAILS the run instead of falling back.
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
  fields/tools) to once per 60 seconds. There is no default/shared fallback —
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

Replaces the deleted `loadOverrides` (`loadOverrides` no longer exists). Loads `agentOverrides`
from `settings.json`.

```typescript
interface SubagentSettings {
  agentOverrides: AgentOverrides;
}

function loadSettings(
  userSettingsPath: string,
  projectSettingsPath?: string,
  cache?: Map<string, CacheEntry<Promise<SubagentSettings>>>,
): Promise<SubagentSettings>;
```

Reads `settings.json` via `fs/promises`. `agentOverrides` is resolved as `primary?.agentOverrides ??
legacy?.agentOverrides` between the top-level `pi-simple-agents` key and the legacy `subagents`
key — when both keys set it, `pi-simple-agents`'s value wins.

Whenever the `subagents` key is present in a file AT ALL, one deprecation `console.warn` fires
(once per file) recommending `pi-simple-agents` instead — `subagents` still works fully, this is a
warning only, not a functional restriction.

A `concurrency` key under either `pi-simple-agents` or `subagents`, if present, is silently
ignored: not read onto `SubagentSettings`, not validated, no warning.

`agentOverrides` gets a plain-object guard: if a resolved (non-`undefined`) `agentOverrides` value
isn't a plain object (e.g. a string, array, or `null`), it's ignored with a warning and treated as
`{}` — a fix for a silent-corruption bug where a malformed value used to flow through and produce
garbage per-agent merges with zero warning.

When both paths are provided, the project file's `agentOverrides` is merged over the user file's.
Malformed JSON in one file doesn't poison the other — each file's own parse/read failure only
affects that file's contribution. Cache key: `` `${userSettingsPath}::${projectSettingsPath ?? ""}` ``.
Never rejects.

```typescript
const settings = await loadSettings(
  "~/.pi/agent/settings.json",
  "/path/to/project/.pi/settings.json",
);
// settings.agentOverrides
```

### Settings JSON contract

```json
{
  "pi-simple-agents": {
    "agentOverrides": { "scout": { "model": "..." } }
  }
}
```

Project settings (`{cwd}/.pi/settings.json`) override user settings (`~/.pi/agent/settings.json`)
per field when the project value is defined.

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
  onProgressEvent?: (event: SubagentProgressEvent) => void;
  getModel?: (provider: string, modelId: string) => CreateAgentSessionOptions["model"];
  mode?: "tui" | "rpc" | "json" | "print";
}
```

`CreateAgentSessionOptions`/`CreateAgentSessionResult` come from
`@earendil-works/pi-coding-agent`, so `session` (`prompt`, `subscribe`, `getLastAssistantText`,
`dispose`, `abort`) is typed against the real SDK shape rather than a hand-rolled inline type.

- `createSession` — factory wrapping pi's `createAgentSession`. The library calls it with the resolved model, thinking level, `tools`, and `excludeTools` (from `agent.disallowedTools`).
- `getModel` — resolver for `provider/modelId` syntax. Called when `agent.model` contains a `/`.
  In the extension, this is `(provider, modelId) => modelRuntime.getModel(provider, modelId)`. If it
  returns `undefined` for a well-formed `provider/modelId`, the run FAILS (`resolveModel` returns
  `{ ok: false, error }` and `runAgentViaSdk` settles the error before `createSession` — no
  session, no tokens). There is no silent fallback (Q1/1.2.0): the only way to the session default
  model is no `model` value or `"inherit"`. A malformed `model` value (no `/`, empty side) fails
  the same way, with an error naming the agent and the expected form.
- `signal` — `AbortSignal` for cancellation. Aborting before the session starts resolves immediately with an error.
- `onProgressEvent` — receives `SubagentProgressEvent`s from the run's single subscription (`src/progress.ts` for the type): tool lifecycle via `toSubagentToolEvent` (`tool_start` carries a `summary: string` pre-formatted by `formatToolCall` in `src/format-tool-call.ts`), the model's streaming phase via `toStreamPhaseEvent` (one event per `thinking_*`/`text_*` delta, deduplicated downstream), and a live `{ type: "usage" }` snapshot whenever the usage accumulator changed (at most one per `message_end`). Every event passes the tracker's single `onEvent`, which owns the post-`done` guard. The events never capture results: `toolName` and the formatted `args` summary are all that flow through, so a long-running subagent's tool output (e.g. a full `read`'s file contents) never accumulates in `TaskProgress.history` (`src/progress.ts`).
- `mode` — the top-level host's run mode (pi's `ExtensionContext.mode`, not re-exported at the SDK's package root so it's inlined here as a literal union, `ExtensionMode` in `src/extension-binding.ts`). Passed through to the subagent's nested `bindExtensions({ mode })` call (see `bindExtensionsIfNeeded`/`shutdownExtensionsIfBound` below) so a nested subagent that itself invokes another subagent (depth 2+) sees the real host mode, not the SDK's own default. Optional; when omitted, `bindExtensions({ mode: undefined })` is still called (binding no longer depends on `mode` at all — see the mode-gate removal note below), and the SDK's own default applies downstream. The extension itself always passes the real `ctx.mode` through `RunTaskOptions`/`runSingleTask`.
- `extensionBindTimeoutMs` — overrides `EXTENSION_BIND_TIMEOUT_MS` (60s). Test seam; production callers should leave it unset.
- `toolGraceMs` — overrides `REQUESTED_TOOL_GRACE_MS` (10s), the post-bind wait for background MCP registration. Test seam; production callers should leave it unset.

### AgentRunResult

```typescript
type AgentRunResult =
  | { status: "success"; agent: string; task: string; durationMs: number; usage?: RunUsage; sessionFile?: string; finalText?: string }
  | { status: "error";   agent: string; task: string; durationMs: number; usage?: RunUsage; sessionFile?: string; error: string };
```

Session disposal is guaranteed in a `finally` block regardless of success or error.

`usage` (`RunUsage`, see [src/usage.ts](#srcusagets)) is attached in the single `settleOnce`
chokepoint, so it's present on every settlement path — success, error, timeout, maxTurns, and
abort — not just success. It reflects only the tokens/cost accumulated *during this run*, via a
plain `agentSession.subscribe` listener registered unconditionally alongside the tool-event and
turn-counter subscriptions (not via the SDK's `AgentSession.getSessionStats()`, which would
include the caller's forked history for `defaultContext: "forked"` agents). `getContextUsage()` is
read from the session before it's disposed.

`sessionFile` is attached in that same chokepoint, from `options.sessionManager?.getSessionFile?.()`
— the run's own persisted session path (see `childSessionDir`, below), or `undefined` when the
run ended up in-memory (no persisted caller session to nest under). The optional chaining exists
because test doubles for `sessionManager` are not always a full `SessionManager`; a real one
never lacks `getSessionFile`.

The extension promotes `sessionFile` and `usage` from each run into the subagent tool's own
result (`details.results[]` and the top-level `AgentToolResult.usage`, see
`buildSubagentToolResult` below) so usage-tracking tools that reconcile nested sessions by path
can attribute the run's cost to its real model.

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

### bindExtensionsIfNeeded / shutdownExtensionsIfBound

A nested `AgentSession` created for a subagent never receives `session_start` unless something
explicitly calls `agentSession.bindExtensions(...)` — `createAgentSession` loads extensions (so
their tools appear in the registry) but never binds them. Without that call, any extension whose
initialization depends on `session_start` (notably pi's built-in MCP extension, which connects
configured MCP servers and registers their `mcp__*` tools there) never runs its init: its tools never
appear, and other extensions' tools may fail on every call
inside a subagent — even though the tool exists in the registry.

`runAgentViaSdk` calls a private helper, `bindExtensionsIfNeeded(agentSession, mode, bindTimeoutMs,
signal, agent.tools)`, immediately after `session = agentSession` and before the pre-prompt abort check (so an
abort during the bind is observed by the existing check, rather than opening a second abort
window). It has a single gate before calling `agentSession.bindExtensions({ mode })`:

- **Tool gate** — `needsExtensionBinding(agentSession.getAllTools(), agent.tools)` is `true` if,
  ignoring this package's own `subagent` tool (`SUBAGENT_TOOL_NAME`, `src/extension-binding.ts`),
  any of these holds before the bind:
  - a registered tool has `sourceInfo.origin === "package"` (came from an installed extension
    package, e.g. `pi-search-hub` or `rpiv-advisor`, which both listen to `session_start`);
  - a registered tool comes from pi's built-in `mcp`, `tool-search` or `codemode` extension. Every
    built-in, base tools like `read` included, is `origin: "top-level", source: "builtin"`, so the
    only distinguishing field is `sourceInfo.path` (`builtin:mcp` vs `builtin:read`), matched against
    an explicit allowlist rather than inferred;
  - a name in `agent.tools` isn't registered yet. pi's built-in MCP registers `mcp__<server>__<tool>`
    only once the server connects, during `session_start`, so a pre-bind registry never contains
    them; a requested-but-missing name can only still come from an extension. A misspelled name
    also triggers a bind, which only costs connection time. Inert Claude Code tool names
    (`CLAUDE_INERT_TOOLS`, `src/claude-compat.ts`) stay in `agent.tools` but no extension ever
    supplies them, so they are excluded from this check.

  `getAllTools()` is already filtered by the SDK according to `agent.tools`/`agent.disallowedTools`,
  so this reuses that filtering rather than duplicating it. A subagent restricted to base built-ins
  whose requested tools are all registered, or one whose only package-origin tool is its own
  `subagent` tool (needed to nest another subagent call, which says nothing about needing MCP),
  skips the bind. Does not cover a top-level `~/.pi/agent/extensions/*.ts` file (not an installed
  package) whose tools are already registered, and can't detect an extension that depends on
  `session_start` but registers no tools at all.

  The built-in extensions only exist in the child at all because `buildLoaderOptions`
  (`src/loader-config.ts`) passes them as `extensionFactories`: pi's CLI injects them into its own
  loader (`main.js`: `builtInExtensions`), but SDK loaders get none unless supplied. They're marked
  `builtin: true, replaceable: true` like the CLI's, so `-builtin:<name>` settings, `noExtensions`
  (`inheritExtensions: false`) and an extension registering the same tool/command behave as in the host.

**There is no mode gate.** An earlier version of this mechanism only bound in `"tui"`/`"rpc"`
mode, reasoning that binding spawns a real MCP server child process the SDK has no public API to
shut down, and that a live child left behind would hang `"print"`/`"json"` (`pi -p`, `--mode
json`) forever — those modes rely on Node's event loop draining naturally to exit, which a live
child prevents, where `"tui"`/`"rpc"` call `process.exit()` unconditionally regardless. That
premise turned out to be wrong: a public counterpart to `bindExtensions()` **does** exist —
`AgentSession.extensionRunner` is a public getter, `ExtensionRunner` is exported from the SDK's
package root, and its `emit()`/`hasHandlers()` methods are public (`SessionShutdownEvent` isn't
excluded from what `emit()` accepts). pi's own CLI already uses exactly this in `"print"`/`"json"`
mode on its own exit path (`dist/modes/print-mode.js` → `dist/core/agent-session-runtime.js`),
which is why `pi -p` itself stays clean today. `shutdownExtensionsIfBound` (below) does the same
thing for a subagent's nested session, which is what makes binding in every mode safe.

`bindExtensionsIfNeeded` bounds the bind call with `awaitAtMost` (`EXTENSION_BIND_TIMEOUT_MS`,
60s default, overridable via `RunAgentViaSdkOptions.extensionBindTimeoutMs` — a test seam,
production callers should leave it unset) and the subagent's own `AbortSignal`, so a hung MCP
handshake can't block the run indefinitely or escape an external abort the way the earlier,
unbounded `await agentSession.bindExtensions(...)` could. It returns `true` iff
`bindExtensions` was actually issued — including when it rejected, since `session_start` was
still emitted and some servers may have partially started — so the caller knows whether the
symmetric shutdown is owed. A `bindExtensions` failure or timeout is logged via `console.warn`
(`WARN_PREFIX` + `toErrorMessage`, `src/warn.ts`) rather than propagated — the subagent still
runs, same degraded-but-alive behavior as before this mechanism existed.

After the bind, `runAgentViaSdk` grants a grace window for background MCP registration: pi
connects the configured servers when session_start fires but does not await them (pi 1.0.4
verified, 1.1.0 documented), so `bindExtensions()` resolves before any server has registered a
tool. When `missingRequestedTools` (the same shared predicate that feeds the bind gate, now
pattern-aware via `matchesToolEntries` in `src/extension-binding.ts`) reports anything
unsatisfied right after the bind, `waitForRequestedTools` polls `getAllTools()` every 100 ms
until every requested name or pattern registers, for at most `REQUESTED_TOOL_GRACE_MS` (10 s —
the same wait the host's own first prompt grants direct-tool servers; overridable via
`RunAgentViaSdkOptions.toolGraceMs`, a test seam production callers should leave unset). The
wait is skipped entirely when everything already registered, is wrapped in `awaitAtMost` so the
job's abort signal cancels it (landing in the existing `signal.aborted` check right after,
which settles "run was aborted"), and an unmatched request after the grace reaches the
unchanged fail-loud check, whose error message now notes the wait
(`waited ${graceMs}ms for the requested tools to register — background MCP connects at session
start`).

`shutdownExtensionsIfBound(agentSession, bound)` is the symmetric counterpart, called in
`runAgentViaSdk`'s `finally` block before `session.dispose()`. When `bound` is `true`, it checks
`agentSession.extensionRunner.hasHandlers("session_shutdown")` and, if so, emits
`{ type: "session_shutdown", reason: "quit" }` — the same event and reason pi's own
`AgentSessionRuntime.dispose()` emits on its own exit path. pi's built-in MCP implements this
handler by stopping the MCP server child process(es) and OAuth/UI state they started for *this
nested session specifically* — each extension's state is scoped to each extension factory
invocation (for the built-in: the `(pi) => {...}` closure `createMcpExtension()` returns), not shared across sessions, so this only ever stops the subagent's own connections,
never the host's. No timeout is applied to the shutdown emit itself (unlike the bind); a
shutdown handler that hangs is a known residual risk, accepted rather than mitigated with another
timeout layer, since removing the mode restriction already eliminated the far more common
failure mode (a live child left running by design, not by a hang).

`bindExtensions` also triggers `extendResourcesFromExtensions` (`core/agent-session.js`), which
re-discovers and merges resources (skills, prompt templates) any bound extension contributes,
passing through the same `skillsOverride` filter `buildLoaderOptions` already applies
(`src/loader-config.ts`). No extension installed in this environment implements the
`resources_discover` hook today (checked pi's built-in extensions and the other configured packages), so
this isn't exploitable currently — but the mechanism is reachable the moment one does, and it
runs on every bind, not just the ones this package intentionally triggers.

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
and [runAgentViaSdk turn counting](#turn-counting) below). Resolves to `undefined` (no limit)
instead of a default, since the absence of a cap is itself a valid configuration. `undefined` →
`undefined`. An integer in `[1, MAX_TURNS_LIMIT]` → returned unchanged. Anything else (`0`,
negative, `> 100`, `NaN`, `Infinity`, non-integer, non-number) → `console.warn` naming the invalid
value, then `undefined` (= no limit). No hard error — same warn-and-fall-through discipline as
`resolveTimeoutMs`.

## clampThinkingLevel

Validates a thinking budget level against the allowed set.

```typescript
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

function clampThinkingLevel(level: string): ThinkingLevel | undefined;
```

Valid levels: `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`. Returns `undefined` with a `console.warn` for invalid values.

## validateSubagentParams

Validates the single accepted call shape for the `subagent` tool.

```typescript
function validateSubagentParams(raw: unknown): ValidationResult<SubagentParams>;
```

### SubagentParams

```typescript
type SubagentParams = { agent: string; task: string } & InvocationOverride;
```

`agent`/`task` are both required — no alternate batch shape exists anymore. `SubagentParams`
intersects `InvocationOverride` (see above): `model`/`tools`/`skills`/`thinking`/`maxTurns`/
`timeoutMs` sit directly on the top-level object. `invocationOverrideOf(t)` (`src/validate.ts`)
extracts just the present override fields off the validated args into a plain
`InvocationOverride`, for feeding to `applyInvocationOverride`.

Validation rules:
- `agent` and `task` are both required, non-empty strings.
- `model` must be a `"provider/modelId"` string (rejected otherwise with a message naming the
  required format); `tools`/`skills` must each be an array of strings. `[]` is a valid value for
  `tools`/`skills` and is distinct from omitting the field: omitted means "inherit the agent's
  configured value", `[]` means "override to empty".
- `thinking`/`maxTurns`/`timeoutMs` get a minimal type guard (`typeof` check) at this same seam
  — an ill-typed value is warned and dropped, not a hard validation error; range/level checks
  live at each field's own use site (`resolveMaxTurns`, `resolveTimeoutMs`, `clampThinkingLevel`),
  not here.

### ValidationResult

```typescript
type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };
```

## resolveAgent

Resolves one agent name to its full `AgentConfig` entry.

```typescript
function resolveAgent(
  name: string,
  agents: AgentConfig[],
): ValidationResult<AgentConfig>;
```

Unknown name → `{ ok: false, error: "Unknown agent: <name>. Available agents: a, b" }`
(singular wording — no more `(s)`).

```typescript
const agents = await discoverAgents("~/.pi/agent/agents");
const resolved = resolveAgent("scout", agents);
if (resolved.ok) {
  // resolved.value: AgentConfig
}
```

## formatRunResult

Converts one `AgentRunResult` into a human-readable string.

```typescript
function formatRunResult(result: AgentRunResult): FormattedResults;
```

```typescript
interface FormattedResults {
  text: string;
  isError: boolean;
}
```

Always renders inline (final text or error message) — the "numbered sections for multiple
results" behavior is gone; there is only ever one result. `isError` is `true` when the result is
an error.

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
behind one `load`/`peek` API, and is what the extension actually uses — see
[Extension internals](#extension-internals) below.

```typescript
interface LoadedAgents {
  /** Overrides already applied. Treat as immutable. */
  agents: readonly AgentConfig[];
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
serialize them), applies `applyOverrides`, stores the result keyed by `cwd` in an internal
snapshot map (for `peek`), and returns it.

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

const { agents } = await registry.load(process.cwd());
// later, synchronously, e.g. inside renderCall:
const snapshot = registry.peek(process.cwd());
```

## Extension internals

The extension at `extensions/index.ts` registers the `subagent` tool with pi's `ExtensionAPI`. Its
default export is now `async function (pi: ExtensionAPI): Promise<void>` (was sync); activation
awaits `registry.load(process.cwd())` before building the tool description and calling
`pi.registerTool(...)`. It:

1. Loads agents and settings via one `createAgentRegistry({ agentsDir, userSettingsPath })`
   instance created **inside the factory** (per session — a nested child session loading this
   extension again gets its own instance, with its own caches and warn-throttle registry;
   construction is I/O-free). The module-level `AGENTS_DIR`/`USER_SETTINGS_PATH` consts are the
   production defaults. Its `registry.load(cwd)` — this composes `discoverAgents` (the agents dir) and
   `loadSettings` (`~/.pi/agent/settings.json` + `{cwd}/.pi/settings.json`) plus `applyOverrides`,
   replacing the old module-level `agentCache`/`overridesCache`/
   `loadAvailableAgents` helpers, which combined `discoverAgents` + `loadOverrides` +
   `applyOverrides` by hand — those are gone.
2. `registry.peek(cwd)` is used wherever a synchronous, zero-I/O read of the last completed load
   is needed (e.g. `renderCall`, which must stay synchronous per the SDK's `renderCall` contract).
3. Validates parameters via `validateSubagentParams`.
4. Resolves the agent name via `resolveAgent`.
5. Creates a `DefaultResourceLoader` per agent (from `@earendil-works/pi-coding-agent`) with field-to-behavior mapping:

```typescript
function createMinimalResourceLoader(agent: AgentConfig, cwd: string): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd,
    agentDir: path.join(os.homedir(), ".pi", "agent"),
    noExtensions: agent.inheritExtensions === false,
    extensionFactories: BUILTIN_EXTENSION_FACTORIES, // pi's codemode, tool-search, mcp
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

6. Resolves the model via `modelRuntime.getModel(provider, modelId)` (passed through as `getModel`)
   and runs the agent via `runAgentViaSdk`. Every call runs as its own independent background job
   — there is no batch/concurrency layer anymore. A separate, extension-level `ModelRuntime` — built once,
   eagerly, via `ModelRuntime.create()` at extension load — is what's forwarded to
   `runAgentViaSdk`/`createSession` as `modelRuntime`, and is also used to build the `getModel`
   resolver (resolving `"provider/modelId"` config strings) passed to `createSession`. Because
   this `ModelRuntime` snapshot is frozen at extension-load time, a `/login` performed later in
   the session requires a `/reload` before subagents pick up the new credentials.
7. **Does not await step 6 to completion.** Instead, it hands the actual run (everything step 6
   describes) to `jobs.start({ runId: toolCallId, task, run })` (`src/background-jobs.ts`,
   `createJobRegistry`), a per-session, in-memory registry living in the extension factory's
   closure (not module-level — a nested child session loads this extension again and must get its
   own independent registry, never the parent's). `start()` returns a `JobSnapshot` synchronously
   and launches `run` on a later microtask, so a synchronous throw inside it is also caught as an
   `errored` job rather than an unhandled rejection. `execute()` then returns immediately via
   `buildSubagentAckResult(job)` (`src/job-messages.ts`): a job id (`S1001`, `S1002`, …,
   `FIRST_JOB_NUMBER = 1001`), the agent/task, and explicit model-facing instructions not to
   call `subagent` again to poll. The tool call's own `signal` is deliberately **not** passed to
   the job — the job gets its own `AbortController` from the registry, so the job survives past
   the end of the turn that launched it. (Esc no longer cancels a subagent run; only
   `/subagents cancel <id>` and a session shutdown do.)

   When the job settles (`JobState` becomes `completed`/`cancelled`/`failed`/`errored`), the registry's
   `onSettled` hook builds a completion message via `buildJobCompletionMessage(job)` and delivers
   it with `pi.sendMessage(message, options)`: a `subagent-result`-typed `CustomMessage` carrying
   a `runId`/`run`/aggregate-`usage` assembly built directly in `buildJobCompletionMessage`
   (not via `buildSubagentToolResult`, which still exists and is still re-exported from
   `extensions/index.ts` as a public API, but is no longer called anywhere in this package — the
   completion message only needs a subset of that function's shape). `cancelled` jobs deliver with
   `{ triggerTurn: false }` (informational,
   doesn't wake the model); `completed`/`failed`/`errored` jobs deliver with
   `{ triggerTurn: true, deliverAs: "followUp" }` (queued until the model's current turn ends, then
   starts a new one). See [Background jobs](#background-jobs) below for the full architecture
   (registry, settle barrier, widget, `/subagents`). The `onSettled` hook itself is a one-line call
   to `deliverJobResult(pi, job)`, exported from `extensions/index.ts` for the same reason
   `runSingleTask` is below — so this wiring (build the message, hand it to `pi.sendMessage` with
   the right options) is unit-testable with a fake `pi` and a synthetic `SettledJob`, without a real
   job ever running.

   The default export also takes a third parameter,
   `createSessionOverride?: RunAgentViaSdkOptions["createSession"]`, threaded all the way down into
   every job's `runSingleTask` call. It's a test-only seam (always `undefined` in production, where
   `runSingleTask`'s own default — the real `createAgentSession` — applies): it's what lets a
   test substitute a fake `AgentSession` for every job this extension instance launches, so
   `execute()`'s actual happy path, the lifecycle handlers' effect on a real (if fake-backed) job,
   and the `/subagents` command against a real job are all exercisable without a network/model call.
   See `test/unit/extensions-index.test.ts`'s `fakeAgentSession`/`waitUntil` helpers.

A fourth optional parameter, `pathsOverride?: AgentRegistryPaths` (from `src/agent-registry.ts`),
is a test seam mirroring `createSessionOverride`: always `undefined` in production, it points the
registry at fixture paths (agents dir + user settings) instead of the real ~/.pi/agent layout.
`test/unit/extensions-index.test.ts`'s `makeAgentFixture(t)` builds the per-test tmpdir home
(`<home>/.pi/agent/agents/scout.md` + empty `<home>/.pi/agent/settings.json` + an empty project
`<home>/.pi/settings.json` at the fixture cwd — the registry derives project settings from the
context's cwd), passed as the 4th argument. The entry also derives the nested loader's home root
from the effective agents dir's `<home>/.pi/agent/agents` layout, so the nested
`DefaultResourceLoader` follows the override for free. **Policy: the wiring unit tests are
hermetic — no test reads the real `~/.pi/agent` configuration; validating against real
machine-local config is the live e2e smoke's job (`PI_LIVE_E2E=1 npm run test:e2e`).** A hermetic
suite passes with an empty home: `HOME="$(mktemp -d)" npm test` (POSIX-only gate; `os.homedir()`
uses `USERPROFILE` on Windows).

The job's per-run worker, `runSingleTask(t, agent, tracker, options)` (resource loader
creation/reload, session manager creation, the SDK run, and progress-tracker teardown), is
exported from `extensions/index.ts` (was module-private) purely so its unit tests can call it
directly — not part of a stable public API, just a visibility change for testability. It no
longer takes an `index: number` parameter — a module constant `RUN_INDEX = 0` is used internally
for `childSessionDir` instead, since a job now always runs exactly one task. `runSingleTask`
computes ONE `effectiveAgent = applyInvocationOverride(agent, invocationOverrideOf(t))` and
reuses that single reference across all three of its call sites — `createMinimalResourceLoader`,
`createSubagentSessionManager`, and `runAgentViaSdk` — so a per-invocation `model`/`tools`/`skills`/
`thinking`/`maxTurns`/`timeoutMs` override (the task's own override fields, see
[InvocationOverride](#invocationoverride-and-applyinvocationoverride) above) applies consistently
to resource loading, session naming/forking, and the actual SDK run — not just to model
resolution.

As of the fields connected below, `createMinimalResourceLoader`'s body is glue over
`buildLoaderOptions` (`src/loader-config.ts`), which composes `resolveDefaultReads` and
`filterSkillsByName`; and `runSingleTask`'s session manager is glue over
`createSubagentSessionManager` (`src/subagent-session.ts`). The modules below are internal to
`src/`, not exported from the package entry point — including the four behind background jobs
(`background-jobs.ts`, `job-messages.ts`, `job-view.ts`, `job-widget.ts`), covered together in
their own section, [Background jobs](#background-jobs), right after this list.

## Background jobs

Four modules implement everything step 7 above hands off to: the in-memory job registry, the
messages a settled job delivers, the text views (widget + `/subagents`), and the widget's own
render/ticker controller. None of them touch the SDK directly — `jobs.start()`'s `run` callback,
supplied from `extensions/index.ts`, is the only place that calls `runSingleTask`/`runAgentViaSdk`.

### src/background-jobs.ts

```typescript
interface JobTask { readonly agent: string; readonly task: string }

// "user" = a specific /subagents cancel <id>; "system" = cancelAll() (shutdown,
// or a headless safety net). Carried from "cancelling" into "cancelled" so
// buildJobCompletionMessage can word the two differently.
type CancelReason = "user" | "system";

// Settled-state semantics (1.2.0 remap): `failed` = the run settled with an
// error result (kept in `result`, with its usage — tokens were spent);
// `errored` = the job's promise rejected (infrastructure) — exception message
// only, no run.
type JobState =
  | { readonly status: "running" }
  | { readonly status: "cancelling"; readonly reason: CancelReason }
  | { readonly status: "completed"; readonly settledAt: number; readonly result: AgentRunResult }
  | { readonly status: "cancelled"; readonly settledAt: number; readonly result: AgentRunResult; readonly reason: CancelReason }
  | { readonly status: "failed"; readonly settledAt: number; readonly result: AgentRunResult }
  | { readonly status: "errored"; readonly settledAt: number; readonly error: string };

interface JobSnapshot {
  readonly id: string;        // "S1001", "S1002", … sequential, FIRST_JOB_NUMBER = 1001
  readonly runId: string;     // the launching tool call's toolCallId → childSessionDir
  readonly startedAt: number;
  readonly task: JobTask;
  readonly progress: TaskProgress;
  readonly state: JobState;
}
type SettledJob = JobSnapshot & { readonly state: Extract<JobState, { settledAt: number }> };

type JobRun = (io: { signal: AbortSignal; tracker: ProgressTracker }) => Promise<AgentRunResult>;

interface JobRegistryDeps {
  now: () => number;
  onSettled: (job: SettledJob) => void;
  onChange: (jobs: readonly JobSnapshot[]) => void;
  maxRecent?: number; // default MAX_RECENT_JOBS = 50
}

type CancelResult =
  | { readonly kind: "cancelling"; readonly job: JobSnapshot }
  | { readonly kind: "not-running"; readonly job: JobSnapshot }
  | { readonly kind: "not-found"; readonly id: string };

interface JobRegistry {
  start(input: { runId: string; task: JobTask; run: JobRun }): JobSnapshot;
  get(id: string): JobSnapshot | undefined; // undefined for unknown ids and for ids pruned by maxRecent
  cancel(id: string): CancelResult;
  cancelAll(): void;
  shutdown(): void;
  list(): readonly JobSnapshot[];
  hasRunning(): boolean;
  whenIdle(): Promise<void>;
  clearFinished(): number;
}

function createJobRegistry(deps: JobRegistryDeps): JobRegistry;
function createSettleBarrier(
  jobs: Pick<JobRegistry, "hasRunning" | "whenIdle" | "cancelAll">,
): (event: unknown, ctx: { hasUI: boolean; signal: AbortSignal | undefined }) => Promise<void>;
```

`createJobRegistry` is a per-extension-factory-invocation closure (never module-level — a nested
child session loads this extension again and must get its own independent registry, invisible to
the parent's). `start()` always returns synchronously with a `running` snapshot; `run` itself is
invoked on a later microtask (`Promise.resolve().then(...)`), so even a synchronous throw inside it
is caught and turned into a `failed` job rather than an unhandled rejection or a thrown `start()`.
Settling picks `cancelled` over `completed` when the job's state was `cancelling` at the moment
`run` resolved, regardless of whether `run` itself noticed the abort (a `run` that ignores its
`signal` entirely still gets recorded as `cancelled`, not `completed`, once cancel was requested).

`cancel()`/`cancelAll()` are idempotent (a second cancel never re-aborts the same
`AbortController`) and symmetric with `shutdown()`, which calls `cancelAll()` then sets an internal
`closed` flag: once closed, further settles still update the job's own state (so a late `list()`
call reports it correctly) but never call `onSettled`/`onChange` again — nothing should message a
session that's already being replaced. `clearFinished()` drops every settled job (running ones
untouched), returning the count removed; `maxRecent` (default 50) does the same pruning
automatically on every settle, oldest finished job first, never touching running ones.

`cancel(id)` tags the transition with `reason: "user"`; `cancelAll()` tags it `"system"` and only
ever touches a job whose state is still exactly `"running"` — re-processing an already-`cancelling`
job (e.g. a second `cancelAll()` call, or the settle barrier's abort path firing after a user
cancel) is a no-op, not a redundant `onChange`. `whenIdle()` waiters are released on every settle
regardless of `closed`: only the `onSettled`/`onChange` *notifications* are suppressed post-shutdown
(`emitChange` already no-ops internally when `closed`) — a `whenIdle()` caller (the settle barrier,
mid-wait during a shutdown) must still resolve once the job it's waiting on actually finishes.

`createSettleBarrier` is what makes background jobs safe in a context with no interactive UI
(`pi -p`, `--mode json`, or a nested child session — `ctx.hasUI` is false in all three). Wired to
`agent_before_settle`, it's a no-op when `ctx.hasUI` is true (the widget/`/subagents` are enough
there) or when nothing is running; otherwise it awaits `jobs.whenIdle()`, racing it against
`ctx.signal` aborting (which calls `jobs.cancelAll()` and resolves immediately rather than waiting
forever, removing its own abort listener once `whenIdle` wins the race so a later abort of that
same signal — e.g. a shutdown right after the jobs finished — doesn't call `cancelAll()` again
pointlessly). `extensions/index.ts` also wires `agent_settled` to call `jobs.cancelAll()` whenever
`!ctx.hasUI` — a safety net for a run that aborts mid-tool-call and skips the boundary event
entirely (`cancelAll()` is already a no-op when nothing is running, so there's no separate
`hasRunning()` guard at the call site).

### src/job-messages.ts

```typescript
function buildSubagentToolResult(result: AgentRunResult, runId: string): AgentToolResult<...>;

function buildSubagentAckResult(job: JobSnapshot, params?: InvocationOverride): AgentToolResult<...>;
// `params` (the launch call's requested override, passed as
// invocationOverrideOf(params) by the tool's execute()) rides in details so
// retry/continue can relaunch faithfully. Omitted from the details object
// (the key is ABSENT, not undefined-valued) when the call carried no
// overrides, so legacy consumers see the pre-params shape exactly.

const SUBAGENT_RESULT_MESSAGE_TYPE = "subagent-result";
type SubagentJobMessageDetails =
  | (SubagentJobMessageDetailsBase & { status: "completed" | "cancelled"; run: AgentRunResult; usage?: AggregatedUsage })
  | (SubagentJobMessageDetailsBase & { status: "failed"; run: AgentRunResult; usage?: AggregatedUsage; isError: true })
  | (SubagentJobMessageDetailsBase & { status: "errored"; isError: true });
// failed = run-level error (carries the errored run result, so the usage
// footer keeps working); errored = infrastructure crash (no run — exception
// message only). Base members: jobId, runId, task, isError.
function buildJobCompletionMessage(job: SettledJob): {
  message: { customType: "subagent-result"; content: string; display: true; details: SubagentJobMessageDetails };
  options: { triggerTurn: true; deliverAs: "followUp" } | { triggerTurn: false };
};
```

`ChildResult` is gone — `buildSubagentToolResult` now takes one `AgentRunResult`, not an array,
and returns `{ content, details: { runId, run: result }, usage: toAggregatedUsage(result.usage),
isError }`. This is a deliberate breaking change in 1.0.0 (see CHANGELOG.md's 1.0.0 entry), not a
TODO. `buildSubagentToolResult` lives here (moved from `extensions/index.ts`, still re-exported
from there as a public API) but `buildJobCompletionMessage` below does not call it: that
function's full tool-result shape would be built only to be taken apart again for the subset of
fields the completion message needs, so the message is assembled directly from
`formatRunResult`/`toAggregatedUsage` instead. `buildSubagentToolResult` is still exercised by its
own tests (and remains available to whatever external call site re-exporting it from the package's
entry point is for). `buildSubagentAckResult` is the *other* tail: the launch tool result, built
from a `JobSnapshot` alone (no run result exists yet), explicitly telling the model not to poll
and naming the `/subagents cancel <id>` escape hatch; its text and `details` (`{jobId, runId,
task}`) no longer carry a `(N task/tasks)` count suffix — there's always exactly one task now.
The details also carry `params?: InvocationOverride` (the launch call's REQUESTED per-call
override, like `model` or `maxTurns`; `execute()` passes `invocationOverrideOf(params)`, so only
actually-overridden keys are present) when the call overrode anything, with the key omitted
entirely otherwise (request the ABSENT key, never a present-but-undefined one: persisted
diff-shapes and exact-shape pinning depend on it). What is recorded is deliberately the
REQUESTED values, not the effective resolution: the effective agent config materializes inside
the run, after the ack is returned, so it can never ride on the ack — fidelity is instead
preserved because a relaunch re-enters the exact same `runSingleTask → applyInvocationOverride`
pipeline a first launch does, so the requested overrides resolve the same way twice.

`buildJobCompletionMessage` picks the header text from `job.state.status` (also without a
`(N task/tasks)` suffix now), and the delivery `options` from a `DELIVERY_OPTIONS_BY_STATUS` table
keyed by that same status: `completed`/`failed` map to `{ triggerTurn: true, deliverAs: "followUp"
}` (queued if the model is mid-turn, otherwise starts a new one); `cancelled` maps to
`{ triggerTurn: false }` (delivered, but doesn't wake the model — the user asked for the cancel,
there's nothing to react to). A `failed` job has no `result` to assemble (the job never produced
an `AgentRunResult`), so its `details` is hand-built with `run` absent and `isError: true`; every
other status builds `details` from the job's own `result` via `formatRunResult`/`toAggregatedUsage`.

### src/job-view.ts

```typescript
function formatElapsed(ms: number): string; // "0s", "1m 00s", "1h 00m"
function buildJobsWidgetLines(jobs: readonly JobSnapshot[], now: number, theme: ProgressTheme): string[] | undefined;
function buildJobListText(jobs: readonly JobSnapshot[], now: number, theme: ProgressTheme): string;
function buildJobStatusText(job: JobSnapshot, now: number, theme: ProgressTheme): string;
function buildHelpText(): string; // bare /subagents and /subagents help
function jobNotFoundText(id: string): string;

type SubagentsCommand =
  | { readonly kind: "list" }
  | { readonly kind: "help" }
  | { readonly kind: "cancel"; readonly id?: string }
  | { readonly kind: "status"; readonly id?: string }
  | { readonly kind: "peek"; readonly id?: string }
  | { readonly kind: "steer"; readonly id?: string; readonly message: string }
  | { readonly kind: "followUp"; readonly id?: string; readonly message: string }
  | { readonly kind: "retry"; readonly id?: string }
  | { readonly kind: "continue"; readonly id?: string }
  | { readonly kind: "clear" }
  | { readonly kind: "session" }
  | { readonly kind: "usage-error"; readonly message: string };
function parseSubagentsCommand(args: string): SubagentsCommand;
function buildSubagentSessionText(report: SubagentSessionReport, theme: ProgressTheme): string;
function buildSubagentStatusText(acc: SubagentStatusAccumulator): string;

// --- /subagents retry | continue ---
const NO_RETRYABLE_RUNS_TEXT = "No retryable runs found in this session.";
const NO_CONTINUABLE_RUNS_TEXT = "No continuable runs found in this session.";
function relaunchNotFoundText(token: string): string;
function notContinuableText(candidate: SubagentRelaunchCandidate): string;
function consumedOrphanText(runId: string): string;
function noTaskText(candidate: SubagentRelaunchCandidate): string;
function agentNameNotOnDiskText(candidate: SubagentRelaunchCandidate): string;
function buildRelaunchCandidatesText(candidates: readonly SubagentRelaunchCandidate[], theme: ProgressTheme, verb: "retryable" | "continuable"): string;
function buildRelaunchResultText(kind: RelaunchKind, candidate: SubagentRelaunchCandidate, jobId: string, newRunId: string, droppedFields: readonly ("maxTurns" | "timeoutMs")[]): string;
function isContinuable(candidate: SubagentRelaunchCandidate): boolean;
function isConsumedOrphan(candidate: SubagentRelaunchCandidate, consumedSegments: ReadonlySet<string>): boolean;
function outOfRangeRelaunchFields(params: { maxTurns?: number; timeoutMs?: number } | undefined): ("maxTurns" | "timeoutMs")[];
type RelaunchKind = "retry" | "continue";
type RelaunchTargetResolution =
  | { kind: "candidate"; candidate: SubagentRelaunchCandidate }
  | { kind: "ambiguous"; candidates: readonly SubagentRelaunchCandidate[] }
  | { kind: "not-found"; token: string }
  | { kind: "none" };
function resolveRelaunchTarget(kind: RelaunchKind, id: string | undefined, candidates: readonly SubagentRelaunchCandidate[]): RelaunchTargetResolution;

type SubagentStatusAccumulator = { runs: number } & UsageTotals;

function describeCancelResult(result: CancelResult): { text: string; level: "info" | "warning" };
function describeInjectResult(kind: InjectKind, result: InjectResult): { text: string; level: "info" | "warning" };
function describeClearResult(removed: number): string;
```

Pure text builders, no UI/SDK dependency. `buildJobsWidgetLines` returns `undefined` when no job is
`running`/`cancelling` (the caller clears the widget instead of showing an empty panel); otherwise
one line per still-unfinished task across every active job (`◯` running, `◌` cancelling), elapsed
time ticking from `now - job.startedAt`, plus a trailing hint line. `buildJobListText` (used by the
`/subagents` command, not the widget) reuses `buildProgressLine` (`src/progress.ts`) for a running
job's body and a local per-task renderer (agent, success/`FAILED`, usage footer) for a finished
one; it does not re-sort — callers pass `jobs.list()`, already newest-first. `buildHelpText` backs
bare `/subagents` and `/subagents help` (a plain-text man page); the listing moved there from the
bare view in 1.5.1.

`buildJobStatusText` backs `/subagents status <id>`. Settled jobs reuse `buildJobListEntry` directly (the
module-local renderer a list entry is built from), so a finished job reports identically in both. A
running job gets the live extras: its header, the activity word, the last `history` entry (the most
recently *started* call, which may already have ended), the history capped to the last 10 with
`… (+N earlier)` eliding older entries, and the live usage snapshot when one has arrived. Unknown ids
report `jobNotFoundText`, the single shared wording that `describeCancelResult`'s `not-found` case also uses.
Since 1.3.0 bare `status`/`cancel`/`peek` carry `id?: string` and auto-select like `peek` does. Since 1.4.0 `steer`/`followUp` carry `id?: string` plus `message: string`, parsed deterministically: two or more remaining tokens are id-then-message (whitespace runs collapse via the `/\s+/` split), a single token is the message and the target auto-resolves (active jobs only, like bare `cancel` — a one-token message with an explicit id is not expressible), and zero tokens is a usage error. Since 1.5.0 `retry`/`continue` carry `id?: string` with the first-token-is-the-id rule of `cancel` (extra tokens ignored; bare auto-resolves from the relaunch candidates on disk). `describeInjectResult` mirrors `describeCancelResult` for the injection guard chain (`not-found`/`not-running`/`cancelling`/`not-live` warnings, `failed` on a throwing live session) and reports a successful injection's SDK disposition (`queued`/`handled`) verbatim as an info notify.

The relaunch helpers are pure text, like everything else in the module. `resolveRelaunchTarget` resolves retry/continue targets from the `SubagentRelaunchCandidate[]` built by `buildRelaunchCandidates` (`src/session-reconcile.ts`) with one precedence — explicit token (runId or jobId, matched against the whole candidate list) > exactly one candidate > several (ambiguous: an id must be picked) > none — while `buildRelaunchCandidatesText` renders the one-line-per-candidate ambiguity listing (`runId (jobId) · agent · status · task preview`, the status words being `failed`/`errored`/`cancelled`/`interrupted`) under a verb-shaped header (`Several retryable|continuable runs — specify an id:`). The text helpers (`relaunchNotFoundText`, `notContinuableText`, `consumedOrphanText`, `noTaskText`, `agentNameNotOnDiskText`) cover each explicit-id precondition. The bare/auto candidate sets differ by verb: bare retry excludes candidates settled as `cancelled` (user intent), bare continue excludes candidates with no `sessionFile` — and, in symmetry with retry, also runs settled as `cancelled`; `notContinuableText` can therefore only fire on an explicit continue id. `isContinuable`/`isConsumedOrphan` are the shared pool predicates (continue-worthiness; consumed-once-in-this-session, matching the wiring's consumed segments by `runIdDirName`), and `buildRelaunchResultText` renders the completed-relaunch success text for either verb, including the cancelled note both verbs show for an explicit id on a cancelled run and the out-of-range degrade note naming the recorded fields the wiring dropped (`droppedFields`, from `outOfRangeRelaunchFields`: maxTurns outside 1..100, timeoutMs non-positive/above the 2h ceiling — the launch then runs without them and the agent's own value applies).

`buildSubagentSessionText` backs `/subagents session`: it renders a `SubagentSessionReport`
(see `src/session-reconcile.ts` below) in the layout of pi's own `/session` command — token totals
with the cached/uncached split and hit rate, the per-model cost breakdown only when there is more
than one bucket, `Cache Re-billed` with pi's $0.0001 threshold, and the per-agent rows. Locale for
the counters is pinned to `en-US` so the rendered text is byte-identical across machines. With no
runs and no Main it renders a single short message instead of the layout. Since 1.5.0 the layout
is three blocks built by one shared tokens/cost renderer (`renderUsageBlock`, local to the
module): **Main Session** (the parent's own stats, present only when the wiring supplied the
session's in-memory entries), **Subagents** (the reconciled child runs, its header renamed from
"Subagent Totals"), and **Total (Main + Subagents)** at the end — MAIN is rendered first and
TOTAL last, and a session that launched zero subagents still shows Main and Total while the
all-zero Subagents block is omitted. TOTAL's cache waste is summed at render time from
`main.cacheWaste + report.cacheWaste` (plain additive counters, no combined field needed).

`buildSubagentStatusText` renders the footer status line the wiring updates on every job settle:
`sub: 3 runs, 1.2M tok, $0.980` (singular/plural; the cost segment drops at zero, e.g.
subscription-accounted sessions). Tokens are the full volume across all four buckets, formatted
with the same `formatTokens` (`src/usage.ts`) the report uses.

### src/session-reconcile.ts

```typescript
export function parseSessionEntries(text: string): SessionEntry[];
export function sumUsageTotals(entries: readonly SessionEntry[]): UsageTotals;
export function addUsageToTotals(totals: UsageTotals,
  usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: number } | undefined): void;
export function danglingToolCalls(entries: readonly SessionEntry[]): DanglingToolCall[];
// DanglingToolCall { toolCallId: string; toolName: string }
export function usageCostBreakdown(entries: readonly SessionEntry[]): UsageBreakdownRow[];
export function computeCacheWaste(entries: readonly SessionEntry[],
  readPerTokenFallback?: (provider: string, model: string) => number | undefined): CacheWaste;
export function assistantTurnCount(entries: readonly SessionEntry[]): number;
export function buildSubagentSessionReport(rootSessionFile: string, fs: ReconcileFs,
  activeRunIds?: ReadonlySet<string>, readPerTokenFallback?: ReadPerTokenResolver,
  mainEntries?: readonly SessionEntry[]): SubagentSessionReport;

export interface ReconcileFs {
  readTextFile(path: string): string | undefined; // undefined = missing/unreadable
  listDir(path: string): string[] | undefined;    // undefined = missing
}
```

Pure reconciliation of `/subagents session`: pi's `/session` only counts the parent session's own
entries, and background subagent runs are separate SDK sessions it never sees. `buildSubagentSessionReport`
closes that gap entirely from already-persisted data — nothing new is written:

- **Parse**: `parseSessionEntries` reads the parent `.jsonl` with pi's own tolerance (blank and
  malformed lines are skipped), and structural entry shapes mirror `docs/session-format.md`
  (pi does not export its session types; the same "structural shape" pattern as `MessageUsage` in
  `src/usage.ts`).
- **Algorithms are ports of pi** (verified against 0.84.2's `dist/core/`): `sumUsageTotals`
  reproduces `getSessionStats` (assistant usage + toolResult usage + compaction/branch_summary
  usage + `type:"usage"` entries); `usageCostBreakdown` reproduces `getUsageCostBreakdown`
  (grouping by `provider/responseModel ?? model`, toolResult/compaction under `Tools/summaries`,
  `tokens = input + output + cacheRead + cacheWrite`); `computeCacheWaste` reproduces
  `detectMiss`/`scan` (`min(prev.promptTokens, promptTokens) - cacheRead`, 1024-token noise floor,
  compaction reset, Unix-ms message timestamps). The only asset not derivable is contextUsage —
  it needs the live model registry, so the report omits it.
- **Attribution**: the whole descendant tree is walked under the `childSessionDir` path convention
  (`<parent-without-ext>/<runId>/run-N/`, deep-nesting collapse included), each resolved child
  path visited once (dedupe also neutralizes the `deep-<hash16>` collision case). A child dir is
  attributed via `runIdDirName` (`src/subagent-session.ts`) to the matching `subagent-result`
  completion message in its immediate parent `.jsonl`; nested runs resolve themselves because
  level-N+1 completion messages live in the level-N child's own file. Grandchildren count toward
  the session total exactly once.
- **Disk-first effective usage**: when the child's `session.jsonl` exists, its parsed stats are
  canonical (per-model breakdown, turns from assistant messages, cache waste); otherwise the
  completion message's aggregate `details.usage` feeds an `unattributed` breakdown bucket. A
  completion whose status is `errored` (no `run`, no usage) counts as a run at zero usage; a
  child dir with no matching completion message is an orphan — agent `unknown`, task recovered
  from the child's first user message, `running` when its runId is in `activeRunIds` (the only
  use of the in-memory job registry, for labeling — never a usage source), else `unknown (orphaned)`.
- **Branches**: the whole parent file is read, no branch filtering — the same scope as pi's
  `/session` (`getSessionStats` iterates every entry), and a run billed in an abandoned branch
  still happened.
- **Persistence limits**: pi flushes the parent session file synchronously per entry, so anything
  a settled job reported is on disk. With `--no-session` neither parent nor child files exist:
  child runs and their aggregate usage stay in memory and the spend is unrecoverable after a
  restart. When forking the caller session fails (`forkFrom`/`atPath` throws), a child falls back
  to an in-memory session; the only trace left is the parent's aggregate `details.usage`, which
  lands in the report's `unattributed` bucket without a per-model breakdown. The timestamped
  `<ts>_<id>.jsonl` files a `continue` fork writes next to a child are never walked by the report:
  the continued run is attributed from its completion message's `details.usage` (the fork replays
  the seed's history without re-calling the LLM) and the seed run exactly once from its own
  `session.jsonl`. A provider that never reports usage shows zero; that spend is irrecoverable.

The report shape is `SubagentSessionReport { runs, totals, breakdown, cacheWaste, byAgent, counts }`;
`buildSubagentSessionText` (`src/job-view.ts`) renders it. The wiring passes
`ReconcileFs` built from `node:fs` with per-call try/catch (throwing never crashes the command;
an unreadable child is just skipped).

A fifth optional parameter, `mainEntries`, adds the Main/Combined fields (1.5.0): when supplied,
the report gains `main` (the parent session's own stats — the same `buildSessionUsageStats` port
of pi's `getSessionStats` used for every child file, called on the parent's entries), `combined`
(`main.totals + totals`, folded field by field through the shared `addUsageToTotals` export), and `combinedBreakdown` (main's rows merged with the
subagent rows by key, sorted by cost desc). There is no dedupe guard, deliberately: nothing
injects subagent usage into the parent's countable entries (the settled run's completion message
is a `custom_message`, which `usageSourceOf` ignores, and the launch ack's toolResult carries no
usage), so MAIN and the subagent totals never overlap and a guard would be dead code. Without
`mainEntries` the report keeps exactly its old shape. TOTAL's cache waste is not stored: the
fields are additive, so the renderer sums `main.cacheWaste + report.cacheWaste` itself.
The wiring (extensions/index.ts) adapts the host's `SessionEntry` union through
`toReconcileEntries` — a documented cast, since the host-validated entries are not directly
assignable to this module's permissive `GenericSessionEntry` union — and reads the parent's
entries in memory via `sessionManager.getEntries()`; the persisted-session guard runs first, so
a session that never reached disk gets no report (and no MAIN) at all.

`buildRelaunchCandidates` (1.5.0) is the disk-side provider for `/subagents retry|continue`:
`SubagentRelaunchCandidate { runId, jobId?, agent, task?, status, sessionFile?, usage?, params? }`,
one entry per settled/orphaned run (`params` is the ack's recorded copy of the original call's
invocation override, present only when the candidate's launch ack recorded one — the key is
omitted, never undefined-valued, because candidates are pinned by full deepEqual). It reuses the SAME `buildSubagentSessionReport` walk (one
descent over the child tree, statuses from the completion messages) and keeps depth-1 runs
that settled `failed`/`errored`/`cancelled` or orphaned with status `unknown` — the `running`
orphan (a live job in THIS session, via the same `activeRunIds` argument) is never a
candidate, and deeper descendants/completed runs never qualify. Orphans display as
`interrupted`: crash, kill, and disconnect are indistinguishable from disk. Orphan
enrichment reads the parent file a SECOND time (tiny files, accepted cost) for the launch
acks — `subagentAckEntryOf` reads the persisted `toolResult` of the `subagent` launch (the
`details: { jobId, runId, task: { agent, task }, params? }` shape `buildSubagentAckResult`
writes; old pre-1.2.0 acks with their `details.runs` array are tolerated and ignored), giving the
resume candidate its real `jobId`, agent, and task where `makeRun`'s orphan branch only knew
`unknown`. The `params` extraction is structural only — it iterates the shared per-key type table
(`OVERRIDE_TYPE_SPEC`/`overrideValueMatches`, src/overrides.ts: model/thinking:
string, tools/skills: string[], maxTurns/timeoutMs: number) and drops ill-typed keys of a
corrupted ack silently, and a blob whose every key is ill-typed counts as nothing-recorded — while the
semantic checks (model ref form, maxTurns range) stay at the relaunch-time
`validateSubagentParams` chokepoint, the layering this module shares with validate.ts. Message-driven candidates get their `jobId` from the completion messages the same
way. `sessionFile` rides on `ReconciledRun.sessionFile` (set only when the child yielded
entries), so an errored run that never persisted a child is a candidate with none —
continueable-by-id but flagged, retryable always. `danglingToolCalls` (pure, same module)
reports the assistant toolCall pairs with no toolResult anywhere in the entries —
`{ toolCallId, toolName }`, the name read from the same assistant block that opened the pair
(an "unknown" fallback keeps every dangling pair closable when that block is malformed): the
open pairs a continue-seeded fork must close before its first prompt (see `src/task-runner.ts`).
Consumed-orphan bookkeeping lives in the command wiring, never here — this module is pure
and stateless over `ReconcileFs`.

### src/progress.ts

```typescript
type StreamPhase = "thinking" | "output";

interface RunningTool { toolCallId: string; toolName: string }

interface TaskProgress {
  agent: string;
  runningTools: RunningTool[];
  history: readonly string[];
  done: boolean;
  usage?: RunUsage;          // live snapshots while running; the final one rides on markTaskDone
  streamPhase?: StreamPhase; // the only stored signal; the activity word is derived, never stored
}

type SubagentToolEvent =
  | { type: "tool_start"; toolCallId: string; toolName: string; summary: string }
  | { type: "tool_end"; toolCallId: string };

type SubagentProgressEvent =
  | SubagentToolEvent
  | { type: "stream_phase"; phase: StreamPhase }
  | { type: "usage"; usage: RunUsage };

function toSubagentToolEvent(event: AgentSessionEvent): SubagentToolEvent | undefined;
function toStreamPhaseEvent(event: AgentSessionEvent): SubagentProgressEvent | undefined;
function applyToolEvent(progress: TaskProgress, event: SubagentToolEvent): TaskProgress;
function applyProgressEvent(progress: TaskProgress, event: SubagentProgressEvent): TaskProgress;
function markDone(progress: TaskProgress, usage?: RunUsage): TaskProgress;
function shortToolName(toolName: string): string;
function activityWord(progress: TaskProgress): string;
function buildProgressLine(progress: TaskProgress, theme: ProgressTheme): string;
function createProgressTracker(agent: string, emit: (progress: TaskProgress) => void): ProgressTracker;
// ProgressTracker.onEvent(event: SubagentProgressEvent) — also markTaskDone(usage?)
```

`createProgressTracker` is the only stateful piece here: a closure-local `TaskProgress` replaced by
value, emitted on every change. Three decisions keep it cheap and honest:

- The word behind both `buildProgressLine` (the list view's `running: read, grep` / `thinking` /
  `working…`) and `activityWord` (the widget's one word, and `status`'s `activity:`) is derived at
  render time, from `runningTools` and `streamPhase`. Storing it would go stale the moment `tool_end`
  emptied `runningTools` while the stored word still named a tool. `activityWord`'s order: `done`,
  then the most recently started running tool through `shortToolName` (an MCP `mcp__<server>__<tool>`
  collapses to `<server>` via `format-tool-call.ts`'s exported `MCP_TOOL_NAME`, no second regex),
  then `streamPhase`, then `waiting`. A running tool always wins over a lingering phase.
- Dedupe lives in `applyProgressEvent`, not in timers or buffers: a `stream_phase` event for the
  already-stored phase returns the same object, and the tracker skips the emit for an identical
  reference. Streaming deltas arrive one per token; that is what keeps the widget from repainting
  with them.
- `onEvent` owns the single post-`done` guard, so late events (usage snapshots riding on the settle
  path, a lost delta) can no longer bring a finished job's progress back.

### src/job-widget.ts

```typescript
const JOBS_WIDGET_KEY = "pi-simple-agents:jobs";
interface JobWidgetUi {
  setWidget(key: string, lines: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
  theme: ProgressTheme;
}
interface JobWidgetDeps {
  getUi: () => JobWidgetUi | undefined; // undefined in a context with no UI
  now: () => number;
  schedule: (fn: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
}
function createJobWidget(deps: JobWidgetDeps): { refresh(jobs: readonly JobSnapshot[]): void; dispose(): void };
```

Wraps `buildJobsWidgetLines` with a self-rescheduling ticker: `refresh()` renders immediately and,
only while at least one line is showing, schedules the next tick a second later; a tick that finds
nothing left to show stops rescheduling itself rather than ticking forever. `extensions/index.ts`
wires the real `schedule`/`cancel` to `setTimeout`/`clearTimeout` (the handle `unref()`'d, so it can
never by itself keep the process alive) and `getUi` to whatever `ExtensionContext` was last
captured from any handler call, gated on `ctx.hasUI` — there is no "current context" otherwise
reachable from the registry's async `onChange` callback.

## Extension wiring (background jobs)

`extensions/index.ts`'s default export wires all four modules above into the two registered tools,
the message renderer, the `/subagents` command, and three event handlers — all scoped inside the factory function's closure
(per-session, like the job registry itself, never module-level):

- `pi.registerMessageRenderer(SUBAGENT_RESULT_MESSAGE_TYPE, renderSubagentResultMessage)`: renders
  a settled job's completion message. Styled to match a native tool result — same `Box` +
  `toolSuccessBg`/`toolErrorBg` background the host's own `ToolExecutionComponent` uses, same
  `toolTitle` header convention — and wrapped in its own `MouseRegion` so it's individually
  clickable to toggle expand, independent of the global Ctrl+O toggle. `CustomMessageComponent`
  (the generic host wrapper every `registerMessageRenderer` output gets) provides neither of these
  on its own: no box styling for a *custom* renderer's output, and no click handling at all, only
  the global toggle. The closure-local `expanded` this introduces is reset to the current global
  value every time the host rebuilds this component (on the global toggle itself, a resize, or a
  theme change) — a click only persists until the next such rebuild.
- `pi.registerCommand("subagents", ...)`: `/subagents` (list), `/subagents status <id>`,
  `/subagents cancel <id>`, `/subagents retry|continue [id]`, `/subagents clear`, dispatched
  through `parseSubagentsCommand`; the `status` case looks the snapshot up with `jobs.get(id)`
  and renders it with `buildJobStatusText`. The `retry`/`continue` cases (1.5.0) are a thin
  dispatch into ONE shared factory closure, `handleRelaunch(spec, command, ctx)`, where each
  verb's per-candidate choices come from a module-scope spec table:
  `RELAUNCH_SPECS = { retry: RETRY_SPEC, continue: CONTINUE_SPEC }` — `RelaunchSpec`
  `{ kind, noneText, verb ("retryable"|"continuable"), taskOf(candidate), seedSessionFileOf(candidate) }`,
  with retry's `taskOf` returning the candidate's original task and continue's returning
  `CONTINUATION_PROMPT`, retry's `seedSessionFileOf` always `undefined` and continue's the
  candidate's `sessionFile`. Inside the closure, the chain is guarded by
  the same persisted-session precondition `session` uses, resolved from
  `buildRelaunchCandidates(sessionFile, nodeReconcileFs(), activeRunIds-from-jobs)`
  (`src/session-reconcile.ts`) via `resolveRelaunchTarget` (`src/job-view.ts`), through the
  SAME `registry.load(ctx.cwd)` + `resolveAgent` path a tool call resolves its agent with
  (verbatim error text, warning, no launch). Closure-scoped state mirrors the registry:
  `consumedOrphanSegments` (each orphaned child is consumed once per session — only
  interrupted candidates are ever added, via `isConsumedOrphan`) and `relaunchAttempts` (one
  counter per source runId, feeding `relaunchRunId`). A relaunch reconstructs the original
  call's REQUESTED overrides from the launch ack's recorded `details.params`, re-validates the
  assembled `{agent, task, ...params}` through `validateSubagentParams` (a failure is a warning
  naming the run and nothing is launched), drops recorded fields `outOfRangeRelaunchFields`
  reports as out of their allowed range (the launch runs without them, the agent's own value
  applies, and the success output says so), and passes the validated params to the SAME launch
  closure — so the relaunch flows through `runSingleTask → applyInvocationOverride` exactly like
  a tool call, only with a fresh runId. Legacy acks (no recorded params: pre-persistence
  sessions, a crash before the ack flush, or a launch that was itself a retry/continue) run the
  agent's own defaults, and both commands' success outputs (one shared renderer per verb,
  `buildRelaunchResultText`) say which of the two happened.
- `pi.registerTool(SUBAGENT_JOB_TOOL_NAME, ...)`: the `subagent_job` tool, registered beside
  `subagent`. It carries `SUBAGENT_JOB_DESCRIPTION`, the `SubagentJobParams` TypeBox schema
  (`action`, optional `id`, optional `message`), `executionMode: "sequential"` (sibling calls in
  one batch are serialized, so two interventions on the same job cannot both pass the budget
  check), and no `renderCall`/`renderResult` (the host's default rendering). Its `execute`
  validates the params (`validateJobParams`) and delegates to the SAME `handleJobAction` closure
  the command uses, passing `PLAIN_THEME` instead of `ctx.ui.theme` (the model reads plain text)
  and the closure-scoped `toolInterventions` set. A structural problem is an `errorResult`; every
  guard outcome is a normal result carrying the action's text. `handleJobAction(action, id,
  message, ctx, budget?)` was extracted in 1.5.2 from the command handler's
  `list|status|cancel|steer|followUp|retry|continue` branches: it resolves the target, runs the
  registry call, and returns `{ text, level }`, which the command notifies and the tool returns.
  `budget` is `undefined` on the command path, so a user-typed action is never refused. The
  budget is a `Set<string>` of spent run ids, checked before an intervention and appended only
  on success (`cancelling`, `injected`, a completed relaunch), so a failed guard costs nothing;
  `handleRelaunch` checks it against the candidate before the consumed-orphan check and adds the
  source run id after a successful launch. A relaunch mints a new run id, which is budget-fresh
  by construction.
- `pi.on("agent_before_settle", ...)`: the settle barrier (see `createSettleBarrier` above).
- `pi.on("agent_settled", ...)`: the `!ctx.hasUI` safety-net cleanup, see above.
- `pi.on("session_shutdown", ...)`: `uiRef?.ui?.setStatus(STATUS_KEY, undefined)` (the accumulated
  spend is per-session, so the footer line resets on every shutdown reason), then `jobs.shutdown()`
  plus `widget.dispose()`.

Launching a run of one task lives in ONE closure, `launchSubagentJob(input: { params; agent;
runId; cwd; mode; callerSessionFile; seedSessionFile? }): JobSnapshot` — the subagent tool's
`execute()` and the `/subagents retry|continue` commands are the two call sites. A relaunch
there carries exactly the same job plumbing a tool-launched one does (the tracker/transcript/live-
session taps, the delivery hook, the footer accumulator): `execute()` resolves its agent through
the registry and returns `buildSubagentAckResult(job, invocationOverrideOf(params))` — the ack
records the call's requested overrides in `details.params`; the relaunch commands resolve theirs
through the shared `handleRelaunch` closure (spec table, precondition texts in `src/job-view.ts`,
consumed-orphan bookkeeping) — `CONTINUATION_PROMPT` (the fixed continuation prompt, the
`relaunchRunId` namespace) exported at module scope next to `deliverJobResult`.

A `uiRef`/`captureUi(ctx)` pair — scoped inside the factory closure, like everything else above,
never module-level — updated at the top of `execute()`, the `/subagents`
handler, and every one of the three event handlers above, is what lets the job registry's
`onChange`/`onSettled` callbacks (which can fire well after any single handler call returns) reach
`ctx.ui` at all — there is no "current context" otherwise available to them.

The `onSettled` hook also drives the footer status line (`ctx.ui.setStatus`, always on, key
`pi-simple-agents:subagents`): after `deliverJobResult`, it increments the closure-local
`SubagentStatusAccumulator` (`{ runs } & UsageTotals`, folded by the shared `addUsageToTotals`
export of `src/session-reconcile.ts`) by one run (errored settles count a run at zero tokens; a settle with
a result adds its `result.usage`, and the registry fires onSettled exactly once per settle, so
accumulation is idempotent) and re-renders the line with `buildSubagentStatusText`
(`sub: 3 runs, 1.2M tok, $0.980`). `setStatus` is a no-op outside the TUI (the host's non-
interactive UI context is a no-op), so no mode guard is needed; before the first settle the
accumulator stays untouched, so the line appears only once a run actually settled.
`/subagents clear` does not reset the accumulator — it is effective session spend, the same scope
`/subagents session` reports; only shutdown clears the line.

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

The returned `options` also always include `extensionFactories: BUILTIN_EXTENSION_FACTORIES`:
pi's built-in `codemode`, `tool-search` and `mcp` extensions, built with the SDK's public
`createCodemodeExtension()`, `createToolSearchExtension()` and `createMcpExtension()`. pi's CLI adds
these to its own loader (`main.js`, `builtInExtensions`), but a `DefaultResourceLoader` gets none
unless they are supplied, so without this no subagent would ever see MCP, `tool_search` or
`codemode`. Each entry is `builtin: true, replaceable: true`, the same flags the CLI uses:

- `builtin` makes it load as the `builtin:<name>` extension path, so `-builtin:<name>` in the
  `extensions` setting and `noExtensions` (`inheritExtensions: false`) disable it as in the host.
- `replaceable` lets pi drop it when an installed extension registers the same tool or command
  (`codemode`, `tool_search`, `/mcp`), as the host does, instead of loading both and colliding.

`llama.cpp` is left out: its factory isn't exported, and it registers a provider, not tools. The
factory instances are module-level and shared by every subagent loader. That is safe because each
one keeps its state inside the `(pi) => {...}` closure it returns, so every nested session gets its
own.

The returned `options` also unconditionally include `noThemes: true` — themes are only consumed by
interactive mode, and subagent sessions are headless, so this skips theme loading/resolution work
on every subagent's `resourceLoader.reload()`.

Never throws.

### src/render-call.ts

```typescript
type SubagentCallArgs = { agent?: string; task?: string } & InvocationOverride;

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
while/after the tool call renders (one `agent`/`task`; there is no parallel/batch mode anymore).
`buildSubagentCallText` looks up the named agent in `paramAgents` and, when found, appends a dim
parameter line built by `formatAgentParams`. `RenderTaskEntry`, `describeTask`,
`buildParallelCallText` and `buildExpandedParallelCallText` are gone along with the removed
`tasks[]` call shape.

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
  there would defeat the point of not capturing tool results (see the `onProgressEvent` note above).
- Pure, total, never throws (`args` that isn't an object is treated as `{}` for the known-tool
  formatters, and `safeJson` catches non-serializable `args` for the fallback).

### src/usage.ts

```typescript
interface UsageAccumulator {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cost: number;
  readonly provider: string | undefined;
}

interface RunUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cost: number;
  readonly isSubscription: boolean;
  readonly context: { readonly percent: number | null; readonly window: number } | undefined;
}

function emptyUsage(): UsageAccumulator;
function applyUsageEvent(acc: UsageAccumulator, event: AgentSessionEvent): UsageAccumulator;
function toRunUsage(
  acc: UsageAccumulator,
  context: ContextUsage | undefined,
  isUsingSubscription: (provider: string) => boolean,
): RunUsage;
function formatTokens(count: number): string;
function formatRunUsage(usage: RunUsage): string;

interface AggregatedUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}
function toAggregatedUsage(usage: RunUsage | undefined): AggregatedUsage | undefined;
```

Pure functions backing the per-subagent-run consumption footer (tokens, cache, cost, context %).

- `applyUsageEvent` is a fold over `AgentSessionEvent`s, mirroring `applyToolEvent`
  (`src/progress.ts`)'s shape: only `message_end` carries a message's *final* usage.
  `message_start`/`turn_end` re-emit the same message and are ignored to avoid double-counting.
  Both `assistant` and `toolResult` messages contribute; the accumulator's `provider` tracks the
  last assistant message seen (used later for the subscription-cost tag).
- `toRunUsage` maps the accumulator plus the session's `ContextUsage` (read via
  `AgentSession.getContextUsage()`, see [AgentRunResult](#agentrunresult)) into the immutable
  `RunUsage` snapshot attached to `AgentRunResult`. The subscription predicate
  (`ModelRuntime.isUsingSubscription`) is injected as a plain function and is only invoked when a
  provider was actually captured — a run with zero assistant messages never calls it.
- `formatTokens` is a local reimplementation of pi's own footer-formatting helper. It isn't
  importable: it lives in an internal, non-exported path of `@earendil-works/pi-coding-agent`
  (`dist/modes/interactive/components/footer.js`).
- `formatRunUsage` renders `RunUsage` into the one-line footer string:
  `↑<input> ↓<output> R<cacheRead> W<cacheWrite> CH<hit%>% $<cost>[ (sub)] <ctx%>/<window>`.
  Each field is included only when non-zero (`$` also shows when `isSubscription` is true even at
  zero cost); an all-zero, no-context `RunUsage` formats to `""`. Cache-hit % is
  `cacheRead / (input + cacheRead + cacheWrite)`, computed over the **whole run's** accumulated
  totals — not just the last turn, unlike pi's own status-bar footer (a deliberate deviation: pi's
  version mixes cumulative token counts with a last-turn-only hit rate in the same line, which this
  module avoids).

`MessageUsage` is a structural (not imported) shape matching the SDK's `Usage` type
(`@earendil-works/pi-ai`), which isn't resolvable from this package (nested under
`pi-coding-agent`'s own `node_modules`). `AggregatedUsage` is the same not-importable situation,
for the same real type — it's what the background job's **completion message** carries as
`details.usage` (see `buildSubagentToolResult`/`buildJobCompletionMessage`,
[Background jobs](#background-jobs) below), not the launch tool call's own `AgentToolResult.usage`
(which is unset — there is nothing to report yet at launch time).

`toAggregatedUsage` takes one optional `RunUsage` (there is only ever one run per job now) and maps
its `input`/`output`/`cacheRead`/`cacheWrite`/`cost` into an `AggregatedUsage`; `undefined` in
(e.g. a run that failed before a session existed) maps to `undefined` out. `RunUsage` only tracks `cost` as a single total
(see `addUsage` above), so the returned `cost`'s per-kind breakdown (`input`/`output`/`cacheRead`/
`cacheWrite`) is always `0`; the real `Usage` type's only consumers here read `cost.total`.

### src/render-result.ts

```typescript
export const DIVIDER = "\u2500\u2500\u2500"; // ───

interface ResultTheme {
  fg(color: "accent" | "dim" | "muted" | "toolOutput", text: string): string;
}

interface RunUsageSource {
  agent: string;
  usage?: RunUsage;
}

interface SubagentResultView {
  expanded: boolean;
  content: string;
  runs?: readonly RunUsageSource[];
}

function buildSubagentResultText(view: SubagentResultView, theme: ResultTheme): string;
```

Pure function deciding a collapsible block's body text for the host's `expanded` flag (Ctrl+O /
`app.tools.expand`, or an individual click — see [Background jobs](#background-jobs)). Used from
two call sites in `extensions/index.ts`: `renderSubagentResult`'s `{error}`/no-details fallback
branch, and `renderSubagentResultMessage`'s body for a settled job's completion message.

| `expanded` | Body |
|---|---|
| `false` | One `formatRunUsage` footer line per entry in `runs` that has non-empty usage — empty string if `runs` is absent or every run's usage is empty. No divider, no `content`. |
| `true` | The subagent's/subagents' full `content` (colored `toolOutput`), preceded by the divider, followed by the same per-run footer lines as the collapsed case. |

`RunUsageSource` is a deliberately minimal structural view (`agent` + `usage`) rather than
importing `AgentRunResult`'s full union — this module only ever reads those two fields. The usage
footer is visible in **both** collapsed and expanded states; only the full `content` is gated
behind the `expanded` toggle — a one-line consumption summary isn't the large payload the toggle
exists to hide. In the `true` row, the body is prefixed with a divider line.

`execute()`'s own tool result never streams partial updates — the launch ack is the tool's only
result. Live per-task progress feeds the running-jobs widget and `/subagents` instead, both built
on `buildProgressLine`/the `TaskProgress` shape from `src/progress.ts`, consumed by
`src/job-view.ts`/`src/job-widget.ts`. `TaskProgress.history` is collected there (its length feeds
`buildProgressLine`'s `tools: N` segment) but never rendered entry by entry.

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
function childSessionDir(
  callerSessionFile: string | undefined,
  runId: string,
  resultIndex: number,
): string | undefined;

function createSubagentSessionManager<S>(
  agent: Pick<AgentConfig, "name" | "defaultContext">,
  callerSessionFile: string | undefined,
  cwd: string,
  childDir: string | undefined,
  factory: SessionManagerFactory<S>,
  seedFile?: string,
): SubagentSessionResult<S>;

interface SessionManagerFactory<S> {
  forkFrom(sourcePath: string, targetCwd: string, sessionDir: string): S; // may throw
  atPath(sessionFile: string, cwd: string): S; // may throw
  inMemory(cwd: string): S;
}

interface SubagentSessionResult<S> {
  manager: S;
  warnings: string[];
}
```

`childSessionDir` is a pure helper. Below `MAX_LITERAL_NESTING_DEPTH` (4) levels of subagent
nesting, it's `<dirname(callerSessionFile)>/<basename(callerSessionFile) without .jsonl>/<sanitized
runId>/run-<resultIndex>`, or `undefined` when there's no persisted caller session to nest under.
`runId` is sanitized (`[^A-Za-z0-9._-]` → `_`; a result that's empty or only dots/underscores —
including `.`/`..`, which would otherwise resolve outside the intended directory — falls back to
the literal `"run"`), then capped at `MAX_RUN_ID_SEGMENT_LENGTH` (64 chars): most filesystems
reject a single path component over 255 bytes (`NAME_MAX`) with `ENAMETOOLONG`, and nothing
guarantees the host's own `toolCallId` stays short. A runId over the cap is truncated and has an
8-hex-char `sha1` suffix of the sanitized (pre-truncation) string appended, so two long runIds
sharing a common prefix still land in distinct directories.

**Nesting depth cap.** Each level of subagent-calling-subagent nesting adds one more
`<runId>/run-N/session` segment to the path (since the immediate parent's own session file is
always named `session.jsonl`, so its `basename(..., ".jsonl")` is literally `"session"`). This
compounds: real session paths with ~20 nesting levels were found at 1005-1016 bytes, right at
macOS's `PATH_MAX` (1024), causing `createSubagentSessionManager`'s `factory.atPath` to throw
`ENAMETOOLONG` and silently fall back to an in-memory session. `nestingDepth(callerSessionFile)`
counts `/run-\d+` occurrences in the caller's path to detect this. At or past the cap,
`truncateAtDepth` finds the end of the `MAX_LITERAL_NESTING_DEPTH`-th `/run-\d+` segment and uses
everything up to there as a stable anchor — identical for every descendant of the same branch,
regardless of how much deeper the real call chain goes, since truncating to the same Nth
occurrence always yields the same prefix. The rest of that (arbitrarily long) ancestor chain, plus
this run's own `runId`, collapses into one `deep-<16-hex-char-sha1>` segment under that anchor, so
the resulting path's length is bounded independent of nesting depth. Tradeoff: a run past the cap
no longer has its full ancestor chain readable from its own session path — acceptable, since
those runs weren't being persisted at all before this fix (the directory create failed outright).

This is the path convention several usage-tracking tools already know how to reconcile a
nested-agent tool call's child session against: when a session file exists at that path, they
attribute the run's cost to its real model instead of a generic bucket. `runId` is the subagent
tool call's own `toolCallId`; `resultIndex` is always `0` now (the module constant `RUN_INDEX =
0`, see `runSingleTask` below), since a job runs exactly one task.

`createSubagentSessionManager` decides which manager backs a subagent's session. When a
`seedFile` is set (ONLY the `/subagents continue` path, `src/task-runner.ts`), it takes
precedence over `defaultContext` entirely: the new session is `factory.forkFrom(seedFile,
cwd, childDir)` — branching from the interrupted run's own child session rather than the
caller's — with the same catch-and-fall-back-to-`inMemory(cwd)` shape as the forked branch
(a warning naming the agent plus the seed error; `seedFile` without a `childDir`, an
unpersisted caller, falls straight to in-memory with a warning too). Every
`defaultContext` branch, unchanged since 1.1.0, applies when no seed is given:
`defaultContext === "forked"`: without a `callerSessionFile` (the caller session isn't
persisted), falls back to `inMemory(cwd)` with a warning naming the agent; with one, calls
`factory.forkFrom(callerSessionFile, cwd, childDir ?? "")` (catching and falling back to
`inMemory(cwd)` with a warning that includes the underlying error message if that throws — never
throws itself, forking a subagent's session never aborts the run). Otherwise (including
`undefined` — the effective default is `fresh`): without a `childDir` (no persisted caller
session), returns `factory.inMemory(cwd)`, no warnings; with one, calls
`factory.atPath(join(childDir, "session.jsonl"), cwd)`, with the same catch-and-fall-back-to-
`inMemory` behavior on throw. Generic over `S` with an injected `factory`, mirroring the injection
pattern already used by `RunAgentViaSdkOptions.createSession` in `src/run.ts`, so it's testable
with fakes without touching disk.

Wired in `runSingleTask` with `childDir = childSessionDir(callerSessionFile, options.runId, RUN_INDEX)`
and `callerSessionFile = ctx.sessionManager.getSessionFile()` — replacing the previous fixed
`~/.pi/agent/sessions/subagents/` directory, which every `"forked"` agent shared regardless of
caller or task. The real factory's `atPath` is `SessionManager.open(sessionFile,
dirname(sessionFile), cwd)`; opening a not-yet-existing path starts a fresh, empty session
(`SessionManager.open` never loads content from a path that doesn't exist yet) and persists it
lazily, on the first assistant message — so a run that errors or aborts before producing one
never creates a file. Since 1.5.0, `RunTaskOptions.seedSessionFile` (set only by the
`/subagents continue` wiring) threads into `createSubagentSessionManager`'s `seedFile`
argument, and after seeding `runSingleTask` closes the forked copy's dangling tool-call pairs:
`danglingToolCalls(manager.getEntries())` (`src/session-reconcile.ts`) reports the assistant
toolCall pairs without a matching toolResult in one pass, each as `{ toolCallId, toolName }`
(named from the block that opened the pair), and one synthetic toolResult per pair is appended
(`content: [{ type: "text", text: "[interrupted: the previous attempt ended before this tool
call returned a result]" }]`), all via the SDK's `SessionManager.appendMessage`. Only the
forked copy is repaired; the old file on disk is never touched, and the repair runs nothing
when no seed was given.

### src/tool-description.ts

```typescript
const SUBAGENT_BASE_DESCRIPTION =
  "Launch a subagent in the background. Returns immediately with a job id; the job's result is delivered later as a message in this conversation. Do not call this tool again to poll for or wait on a result — it arrives automatically. To run several subagents concurrently, call this tool once per task (each call starts its own independent background job). A running job can be cancelled, steered, or queued a follow-up with the `subagent_job` tool, or with the user's `/subagents` command; a job that has already settled can no longer be messaged. A run that settled as failed or errored, or was interrupted mid-run, can be re-dispatched with `subagent_job` action `retry` or, when it left a persisted child session, continued from that point with action `continue` — both relaunch with the original call's recorded parameters when the launch acknowledgment persisted them, and with the agent's own defaults otherwise. Interventions (cancel, steer, followUp, retry, continue) are allowed once per job on your own initiative; a second intervention on the same job requires asking the user first — the `subagent_job` tool refuses it and says so. `status` and `list` are read-only and always allowed.";

const SUBAGENT_JOB_DESCRIPTION =
  "Manage a background subagent job launched by the subagent tool. Actions: status (detail one job; without an id it auto-targets the single active job), list (all running/recent jobs, newest first), cancel (stop a running job), steer (inject a message into a running job's live session to redirect it; needs message), followUp (queue a message for the end of the run; it extends the run; needs message), retry (re-dispatch a settled run as a NEW job), continue (relaunch an interrupted run from its persisted child session, keeping its partial work; the agent re-verifies half-done work first). status and list are read-only and always allowed. The other five are interventions: allowed once per job on your own initiative; a second intervention on the same job is refused, and needs the user to ask for it. Target by job id (from the subagent acknowledgment, e.g. S1002); retry/continue also accept a run id, and without an id they resolve their target from settled runs on disk (cancelled runs are user intent and need an explicit id).";

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

`SUBAGENT_JOB_DESCRIPTION` is the `subagent_job` tool's static description: the seven actions,
which two are read-only, and the one-intervention-per-job rule with the refusal wording. No
agents section, since actions are not agents. Also pure.

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
npm test          # unit tests (node:test); hermetic — see the pathsOverride seam note above
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

Two live cases cover MCP:

- `test/e2e/extension-binding.integration.test.ts` needs no model call. It builds a session with the
  same loader a subagent gets (`buildLoaderOptions`), checks that the gate fires before any
  `mcp__*` tool exists, binds, waits for `builtin:mcp` tools and a real child process, then checks
  that `session_shutdown` stops it. It skips unless `~/.pi/agent/mcp.json` has an enabled stdio
  server.
- The `mcp__mde-build__mvn` case in `test/e2e/subagent.e2e.test.ts` runs `pi -p`, has a `worker`
  call `mcp__mde-build__mvn` through a per-call `tools` override, and expects a real Maven result.
  It skips unless `mcp.json` has an enabled `mde-build` server with `"exposure": "direct"`.

Either one runs alone with `--test-name-pattern`, or by passing the single file to
`node --experimental-strip-types --test`.

## License

MIT