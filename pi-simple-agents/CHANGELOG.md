# Changelog

## 0.12.0

- **New optional `thinking` param on the `subagent` tool invocation.** Same placement rule as
  `model`/`tools`/`skills`/`maxTurns`: a top-level field in single mode, per-entry inside each
  `tasks[]` item in parallel mode (top-level `thinking` alongside `tasks` is rejected). A free
  string, not validated at the tool boundary — an unrecognized level is warned and ignored at run
  time by the existing `clampThinkingLevel` (`src/run.ts`), falling back to the agent's
  otherwise-resolved level, not a validation error. Precedence: invocation `thinking` > settings
  `agentOverrides[agent].thinking` > agent frontmatter `thinking` > session default.
- **New optional `timeoutMs` param on the `subagent` tool invocation**, same placement rule as the
  other five override fields. Precedence: invocation `timeoutMs` > settings
  `agentOverrides[agent].timeoutMs` > agent frontmatter `timeoutMs` > the existing 10-minute
  default (`DEFAULT_TIMEOUT_MS`).
- **`timeoutMs` is no longer settings-only — it's now also a real agent frontmatter field.**
  Parsed and normalized by `src/frontmatter.ts`, populated onto `AgentConfig.timeoutMs` the same
  way `maxTurns` was connected in 0.10.0.
- **New 2-hour ceiling on `timeoutMs`: `MAX_TIMEOUT_MS = 7_200_000` ms, enforced once at the
  `resolveTimeoutMs` chokepoint (`src/run.ts`) for every layer** (frontmatter, settings,
  invocation). A finite value above the ceiling is **clamped** to it with a `console.warn`, not
  dropped to the default — the caller's intent to run long is honored up to the ceiling. The
  existing fallback for non-number/`<= 0`/`NaN`/`Infinity` values (warn, fall back to the
  10-minute default) is unchanged.
- **Fix: the `subagent` tool's call display (`src/render-call.ts`) now renders the effective
  (post-invocation-override) `thinking` value, and gains a new `timeoutMs: ...` segment.**
  Previously `thinking` had no `InvocationOverride` field and was always read directly off the
  agent's raw configured value, so a call overriding `thinking` rendered the *pre-override*
  level — the same class of bug already fixed for `model`/`tools`/`skills` in 0.9.0 and for
  `maxTurns` in 0.10.0. `thinking` now merges through `applyInvocationOverride` like every other
  field; `timeoutMs` was not rendered at all before this release.
- **Fix: `SubagentParams`' tasks-mode branch (`src/validate.ts`) was silently missing `maxTurns`
  since 0.10.0.** The hand-written union that forbids top-level override fields alongside a
  top-level `tasks` array listed only `model`/`tools`/`skills` as `?: undefined`, so `maxTurns`
  never actually appeared in that type even though the runtime check in `validateTasksMode`
  always rejected it correctly — a type-only drift, not a runtime bug. Replaced with a
  self-maintaining `Partial<Record<keyof InvocationOverride, undefined>>` mapped type, so this
  class of drift can't recur as new override fields (like this release's `thinking`/`timeoutMs`)
  are added to `InvocationOverride`.
- Docs updated: README.md (new "Overriding thinking per invocation" / "Overriding timeoutMs per
  invocation" sections, `timeoutMs` added to the frontmatter field table, corrected
  precedence-rules paragraph, corrected `agentOverrides.timeoutMs` note), `skills/
  invoking-subagents/SKILL.md` (restructured per-param sections into one "Per-invocation
  parameters" section covering all six fields), DEVELOPER.md (`AgentConfig.timeoutMs`,
  `InvocationOverride.thinking`/`timeoutMs`, new `resolveTimeoutMs` section, corrected
  `render-call.ts`/`SubagentParams` descriptions).

## 0.11.0 — 2026-08-07

- **Requires pi `>= 0.83`.** The SDK renamed `CreateAgentSessionOptions.modelRegistry` to
  `modelRuntime`; this plugin now requires the new shape. This is a hard cut — no dual-version
  support for older pi releases.
- **`peerDependencies` floor raised to `>=0.84.1`** for `@earendil-works/pi-coding-agent` and
  `@earendil-works/pi-tui` (previously `*`). Breaking for consumers pinned below that version.
- **Behavior change: subagents now share one `ModelRuntime`, constructed once when the
  extension loads,** instead of a registry object that was silently ignored by the SDK on pi
  >=0.83 (i.e. this fixes a real bug, not just a type error — subagents were already
  unknowingly building their own runtime from disk on affected pi versions; now that's explicit
  and shared instead of ignored). If `ModelRuntime.create()` fails at load, the `subagent` tool
  still registers but every invocation returns a clear "failed to initialize model runtime: ..."
  error until `/reload`.
- **User-facing caveat: a `/login` performed after this extension loads is not picked up by
  subagents until `/reload`** (the extension's `ModelRuntime` snapshot is frozen at load time).
  This same frozen snapshot is also used for model-name resolution (`getModel`, the
  `provider/modelId` lookup path), so a provider or model that only became available after load
  won't resolve until `/reload` either.

## 0.10.0 — 2026-08-06

- **`maxTurns` is no longer inert — it is a real per-agent turn limit, configurable at every
  layer the agent's config flows through.** Valid range is integer 1..100; any other value
  (non-integer, `<= 0`, `> 100`, `NaN`, `Infinity`, non-numeric) resolves to "no limit" with a
  `console.warn` (same warn-and-drop pattern as `resolveTimeoutMs`/`resolveConcurrency`).
  Canonical constant `MAX_TURNS_LIMIT = 100` exported from `src/run.ts`. Precedence now covers
  `maxTurns` alongside `model`/`tools`/`skills`: invocation > project settings
  (`agentOverrides`) > user settings (`agentOverrides`) > frontmatter > no limit.
  - **Frontmatter:** `maxTurns: 5` in an agent's `.md` is a hard per-run cap. Previously
    (since 0.4.0) it was accepted but listed among the Claude-compat inert fields. Parsed
    and normalized in `src/frontmatter.ts`; populated onto `AgentConfig.maxTurns` in
    `src/agents.ts`.
  - **Settings:** `agentOverrides[agent].maxTurns` in `settings.json` overrides the
    frontmatter value through the existing `applyOverrides` merge (same channel as
    `model`/`thinking`/`timeoutMs`).
  - **Subagent tool invocation:** new optional `maxTurns` parameter on `subagent`, in single
    mode as a top-level param, in parallel mode per-entry inside each `tasks[]` item
    (top-level `maxTurns` alongside `tasks` is rejected, same placement rule as
    `model`/`tools`/`skills`). Per-invocation `maxTurns` takes precedence over the agent's
    configured value. `validate.ts` propagates the value through with a minimal
    `typeof === "number"` type guard (non-numbers warn + drop); range checks live at the
    use site.
  - **On exceed:** when the resolved limit is reached, the run settles as
    `status: "error"` with `error: "reached maxTurns limit of N"`, then
    `agentSession.abort()`. Composes with timeout and `signal.abort()` through the existing
    `settleOnce` dedupe (whichever fires first wins).
  - **Turn counting is by model turn.** One `turn_start` event = one model response + its
    tool batch = 1 turn (matches Claude Code's `maxTurns` semantics; counting tool starts
    would be off by N on parallel-tool-batching runs). New `subscribeTurnCounter` helper in
    `src/run.ts` (parallel to the existing `subscribeToolEvents`) subscribes only when the
    limit resolves to a number, so agents with no `maxTurns` pay no extra overhead.
- **`formatAgentParams` (the `subagent` tool's call display) gains a `maxTurns: <N>` segment**
  (or `maxTurns: inherited` when unset), in the same shape as `model`/`thinking`/`tools`/
  `skills`.
- **`maxTurns` removed from `CLAUDE_INERT_FIELDS`** (`src/claude-compat.ts`); an agent that
  sets it no longer triggers the aggregated inert-usage warning.
- Docs updated: README.md (removed from the inert-fields list, added to the frontmatter field
  table, new "Overriding maxTurns per invocation" section parallel to `model`/`tools`/`skills`,
  precedence-rules paragraph updated, complete example extended), `skills/invoking-subagents/
  SKILL.md` (new "Limiting subagent turns" section with precedence and error/edge-case
  bullets), DEVELOPER.md (`AgentConfig.maxTurns` / `InvocationOverride.maxTurns` fields,
  `applyInvocationOverride` presence-gated description, new `resolveMaxTurns` section, new
  `runAgentViaSdk` turn-counting section, precedence section updated).

## 0.9.4 — 2026-08-06

Follow-up fixes to 0.9.3's directory-style agent discovery.

- **Fix: deterministic collision order.** `discoverAgents` (`src/agents.ts`) now sorts `readdir`
  entries by name before resolving sources, so which of two colliding same-named agents wins
  first-in-order is deterministic across filesystems. **Closes 0.9.3's "Known, documented gap"**
  (collision winner depended on OS-dependent `readdir` ordering) — that gap is resolved as of
  this release.
- **Closed a 0.9.3 QA gap:** added a flat-vs-flat dedup test (two flat `.md` files sharing the
  same frontmatter `name`), previously only the flat-vs-directory collision case was covered.
- **The duplicate-agent warning is now throttled.** `dedupeByResolvedName`'s `console.warn` now
  goes through the existing `warnRegistry`/`claimUnwarned` mechanism, same as other inert-usage
  warnings, instead of firing unconditionally on every cache miss.
- Docs: README.md/DEVELOPER.md updated to describe the deterministic ordering, the throttled
  warning, and that `AGENT.md` matching is case-sensitive by design (not an oversight) — a
  typo'd filename fails silently on Linux even if it happened to match on macOS/Windows.

## 0.9.3 — 2026-08-06

- **New: directory-style agent discovery.** `discoverAgents` (`src/agents.ts`) now also
  discovers agents laid out as `<agentsDir>/<name>/AGENT.md` (a directory containing a manifest
  file), alongside the existing flat `<agentsDir>/<name>.md` files. `name` resolves from the
  manifest's frontmatter `name:`, falling back to the directory's basename when absent —
  `description` still has no fallback, so a manifest without `description` is skipped exactly as
  a flat file would be. Symlinking a directory into `agentsDir` also works, since the underlying
  `fs/promises` `stat` follows symlinks.
- **New: first-wins dedup by resolved agent name, with a warning.** When two sources (flat file
  and/or directory manifest) resolve to the same agent `name`, `discoverAgents` now keeps only
  the first one encountered (in `readdir` order) and logs a `console.warn` naming both file paths
  of the duplicate. Previously, two same-named flat files would both be returned and the *last*
  one silently won downstream (via `validate.ts`'s name-keyed `Map`) — this is a small, disclosed
  behavior change on the pre-existing flat-file path. Not covered by a dedicated flat-vs-flat unit
  test: only the flat-vs-directory collision case is tested (`test/unit/agents.test.ts`'s dedup
  test), plus a direct unit test of the extracted `dedupeByResolvedName` helper.
- **New (module-private, noted for maintainers):** `MANIFEST_FILENAME` constant, `AgentSource`
  interface, and `resolveAgentSource` function in `src/agents.ts`, plus an exported
  `dedupeByResolvedName` helper.
- Docs: README.md gained a "Directory-style agents" subsection.
- Public API unchanged: `discoverAgents`'s signature and `AgentConfig`'s shape are identical to
  0.9.2.
- **Known, documented gap:** the collision winner between two same-named sources depends on
  OS-dependent `readdir` ordering — disclosed via the warning and in README, not made
  deterministic.

## 0.9.2 — 2026-08-05

- **An unknown `provider/modelId` model no longer fails silently.** `resolveModel`
  (`src/run.ts`) now emits a `console.warn` (with the `pi-simple-agents: ` prefix) when
  `getModel` returns `undefined` for a well-formed `provider/modelId` value, then falls back to
  the session default model as before — the fallback previously happened without any
  indication. Bare Claude Code aliases without a `/` (`sonnet`, `inherit`, ...) are unaffected:
  they short-circuit before the registry lookup and never warn. Two new unit tests cover the
  warn-and-fallback path and the no-warning path when the model resolves
  (`test/unit/run.test.ts`).

## 0.9.1 — 2026-07-30

- README restructure: inline agent definitions replaced with links to the `examples/`
  directory; new natural-language usage examples for the `subagent` tool. Version bump only —
  no package code changes.

## 0.9.0 — 2026-07-30

- **New optional `tools`/`skills` params on the `subagent` tool invocation**, extending the
  0.8.0 `model` override to the same two fields. Same placement rule as `model`: single mode
  top-level, or per-entry inside each `tasks[]` item (top-level `tools`/`skills` alongside `tasks`
  is rejected, same as `model`). Both are arrays of strings, **total replacement** (not merge) of
  whatever the agent would otherwise resolve. `tools` accepts native pi tool names only — no
  Claude Code tool-name aliasing in this invocation path (frontmatter `tools` still maps Claude
  Code names, unchanged). `skills` is a whitelist by exact case-sensitive name against the
  inherited set, same semantics as frontmatter `skills`. `[]` is a valid explicit value meaning
  "none" for that call, distinct from omitting the field ("inherit whatever settings.json/
  frontmatter already resolved"). Precedence now covers `model`, `tools`, and `skills`:
  invocation > project settings > user settings > frontmatter > session default. `disallowedTools`
  remains settings/frontmatter-only, out of scope for invocation-level override.
- **`applyModelOverride` generalized into `applyInvocationOverride(agent, {model?, tools?,
  skills?})`** (`src/agents.ts`) — one pure, presence-gated merge function now shared by both the
  runtime path (`extensions/index.ts::runSingleTask`, which computes a single `effectiveAgent` and
  reuses it for resource-loader creation, session-manager creation, and the SDK run — a fix in
  itself, see below) and the render path (`src/render-call.ts::formatAgentParams`).
- **Fix: the `subagent` tool's call display now renders effective (post-invocation-override)
  `tools`/`skills`, not the agent's configured values.** Previously (and still true for `model`
  as of 0.8.0) the render showed the agent's *configured* values regardless of any invocation
  override — e.g. a call with `tools: []` would render the agent's full configured tool list.
  `formatAgentParams` now merges via `applyInvocationOverride` internally before rendering. The
  call display also gained a new `skills: ...` segment (previously not rendered at all).
- **Fix: an invocation-level `skills` override no longer reaches only `runAgentViaSdk`.** An
  earlier draft of this change applied the override just before the SDK call, leaving
  `createMinimalResourceLoader`'s resource loading (the only real consumer of `agent.skills`, via
  `buildSkillsOverride`) working off the pre-override agent — silently inert. Fixed by hoisting the
  merge to the top of `runSingleTask` and reusing one `effectiveAgent` everywhere.
- **Known, documented gap:** no unit test directly exercises `runSingleTask`'s wiring of the
  effective agent into `createMinimalResourceLoader`/`createSubagentSessionManager`/
  `runAgentViaSdk` (ESM named imports aren't mockable without `--experimental-test-module-mocks`,
  not enabled in this repo — same limitation already accepted for the `model` override). Covered
  by composition (`agents.test.ts`, `run.test.ts`, `loader-config.test.ts`) plus manual live
  validation.
- **Known, documented gap:** an agent with `inheritSkills: false` combined with an invocation
  `skills` override renders the requested skills as if effective, but the loader discards them
  all at runtime per the existing contradictory-config rule — surfaced only via `console.warn`,
  not in the render. Latent: no shipped agent currently sets `inheritSkills: false`.
- Docs updated: README.md (`Overriding tools per invocation` / `Overriding skills per invocation`
  sections, corrected precedence-rules paragraph), `skills/invoking-subagents/SKILL.md`
  (`Forcing tools or skills for one invocation` section, extended description, new error cases),
  DEVELOPER.md (new `InvocationOverride`/`applyInvocationOverride` section, corrected
  `SubagentParams`/`TaskEntry` reference — this closes a doc gap left over from 0.8.0's `model`
  override too — and a new `src/render-call.ts` module section).

## 0.8.1 — 2026-07-30

Internal tech-debt paydown from a strict `pablo-code-philosophy` review. No changes to the
`subagent` tool's public contract (schema, invocation shape, or output format) — everything below
is an implementation-detail refactor plus added test coverage.

- **Removed a hidden shared-state footgun in Claude-compat warning dedupe.** `claimUnwarned` and
  `reportInertUsage` (`src/claude-compat.ts`) no longer default their `registry` param to a
  module-level singleton `Map` — it's now a required argument, same as `discoverAgents`'s
  `warnRegistry` (`src/agents.ts`). The only production call site (`agent-registry.ts`) already
  passed its own registry explicitly, so there's no behavior change; this only removes an
  implicit fallback that could have silently shared TTL-dedupe state across unrelated callers that
  omitted the argument.
- **New `toErrorMessage(error: unknown): string` in `src/warn.ts`**, replacing 4 duplicated
  `error instanceof Error ? error.message : String(error)` ternaries across `agents.ts`,
  `frontmatter.ts`, `subagent-session.ts`, and `run.ts`. No behavior change.
- **Reduced complexity in two hot-path functions**, both extractions with no behavior change:
  - `runAgentViaSdk` (`src/run.ts`) now delegates its abort-listener/timeout wiring to a new
    `runWithTimeoutAndAbort` helper.
  - `parseFrontmatter` (`src/frontmatter.ts`) now delegates its four field-group normalization
    passes (list/scalar/enum/boolean fields, plus model-alias resolution) to a new
    `normalizeFrontmatterFields` helper.
- **New unit test coverage for `extensions/index.ts`** (`test/unit/extensions-index.test.ts`,
  previously untested at the unit level): the tool's `execute` validation-error branches,
  `renderSubagentCall`'s incomplete-args short-circuit, `renderSubagentResult`'s partial-render
  path, and `runSingleTask`'s progress-tracking `finally` guarantee. `runSingleTask` is now
  exported from `extensions/index.ts` (was module-private) to make this last case testable
  directly — visibility-only change, no behavior change.

## 0.8.0 — 2026-07-29

- **New optional `model` param on the `subagent` tool invocation.** In single mode it's a
  top-level param; in parallel mode it's per-entry, inside each `tasks[]` item (a top-level
  `model` alongside `tasks` is rejected). Format is `provider/modelId`, same as frontmatter
  `model`. Precedence: invocation `model` > project settings (`agentOverrides`) > user settings
  (`agentOverrides`) > frontmatter `model` > session default. As with the existing settings-level
  `model`, registry existence isn't checked — a well-formed but unknown model silently falls back
  to the session default. A bare alias without a `/` (e.g. `"sonnet"`) is rejected outright as a
  validation error, not silently ignored.
- **New bundled Agent Skill `invoking-subagents`** (`skills/invoking-subagents/SKILL.md`),
  declared via `package.json`'s `pi.skills` manifest entry. Teaches single/parallel `subagent`
  invocation and the new `model` override; loads automatically once the package is installed, and
  is also invocable explicitly as `/skill:invoking-subagents`.

## 0.7.0 — 2026-07-29

- **`discoverAgents` is now async.** Returns `Promise<AgentConfig[]>` instead of `AgentConfig[]`,
  backed by `fs/promises` (parallel `stat`/`readFile` fan-out, deterministic warning order).
  Never rejects: an unreadable directory or an unexpected pipeline error resolves to `[]` (logged
  via `console.warn`) rather than rejecting, so a rejected promise can't sit poisoned in the cache
  for the 5s TTL.
  - **Behavior change:** every call site must now `await discoverAgents(...)`.
- **`loadOverrides` is deleted, replaced by `loadSettings`.** New shape,
  `SubagentSettings { agentOverrides: AgentOverrides; concurrency?: unknown }`, adding the new
  `concurrency` field alongside the existing `agentOverrides`.
  - **Behavior change:** `loadOverrides` no longer exists; update call sites to `loadSettings`.
  - **Fix:** `agentOverrides` and `concurrency` now fall back between the `pi-simple-agents` and
    legacy `subagents` settings keys **independently, per field**, instead of all-or-nothing —
    previously a file mixing both keys across different fields could silently lose one field's
    value.
  - **Fix:** a malformed (non-plain-object) `agentOverrides` value is now ignored with a warning
    instead of silently flowing through and producing garbage per-agent merges.
  - Using the `subagents` key at all (regardless of which fields it supplies) now emits one
    deprecation `console.warn` per file recommending `pi-simple-agents` instead; `subagents`
    still works fully, this is a warning only.
- **New configurable `concurrency` setting**, default `4` (`DEFAULT_CONCURRENCY`, `src/run.ts`),
  validated by the new `resolveConcurrency(value: unknown): number` (invalid values warn and fall
  back to the default). Effective cap of 8, since the `subagent` tool's own `MAX_PARALLEL_TASKS`
  bounds how many tasks one call can have. Replaces the previously hardcoded `4` passed to
  `mapWithConcurrencyLimit` for the subagent batch.
- **New `createAgentRegistry`/`AgentRegistry` module** (`src/agent-registry.ts`), composing
  `discoverAgents` + `loadSettings` + `applyOverrides` + `resolveConcurrency` behind one
  `load(cwd): Promise<LoadedAgents>` / `peek(cwd): LoadedAgents | undefined` API. `load` runs
  discovery and settings loading in parallel and never rejects; `peek` is synchronous/zero-I/O for
  use in the SDK's synchronous `renderCall` contract. Now used internally by
  `extensions/index.ts`, replacing the old module-level `agentCache`/`overridesCache`/
  `loadAvailableAgents` helpers.
- **`noThemes: true` added to the loader config** (`buildLoaderOptions`, `src/loader-config.ts`).
  Perf: skips theme loading/resolution on every subagent's `resourceLoader.reload()`, since themes
  are only consumed by interactive mode and subagent sessions are headless.
- Primarily an internal/perf-focused release. End-user-facing behavior is meant to be equivalent
  except for the new `concurrency` knob and the `subagents` deprecation warning.

## 0.6.0 — 2026-07-29

- **Subagent runs are now bounded by a timeout.** New `AgentConfig.timeoutMs?: number`
  (settings-only, override via the existing `agentOverrides` channel, same as `model`/`thinking`).
  Default when unset: `DEFAULT_TIMEOUT_MS = 600_000` (10 minutes), exported from `src/run.ts`.
  Invalid values (`0`, negative, `NaN`, `Infinity`, non-numeric values from raw JSON) fall back to
  the default with a `console.warn`. On expiry, the run settles as `status: "error"` with message
  `"timed out after <N>ms"`; any partial output is discarded rather than returned as a truncated
  success.
  - **Behavior change:** previously a subagent run had no timeout at all and could hang forever;
    every run is now bounded, 10 minutes by default unless overridden via `timeoutMs`.
- **Live progress feed in the `subagent` tool_box.** While a subagent runs, the call body now
  shows a per-task status line: `<agent> · tools: <N> · <status>`, where `<status>` is
  `working…` (no tool started yet), `running: <tool1, tool2, ...>` (tools currently executing, in
  start order — parallel tool calls are possible), or `done` (task settled). Replaces the
  previously-static "Running..." placeholder. New module `src/progress.ts`.

## 0.5.0 — 2026-07-29

- **`defaultReads`, `defaultContext`, `skills`, and `description` are now connected to the
  runtime.** All four fields were already parsed onto `AgentConfig` but had no effect; they now
  drive real behavior, via 6 new internal modules: `src/default-reads.ts`, `src/loader-config.ts`,
  `src/skills-filter.ts`, `src/subagent-session.ts`, `src/tool-description.ts`, `src/warn.ts`.
  - **`defaultReads`** pre-loads files into the agent's context on startup via the SDK's
    `agentsFilesOverride`. Relative paths resolve against the invocation's cwd (not the agent's
    `.md` file); `~`/`~/...` expands to the home directory. A missing/unreadable/non-regular-file
    entry produces a warning and is skipped, the rest of the list still loads; duplicate entries
    (same resolved path) are deduped, first occurrence wins.
  - **`defaultContext`'s documented default is corrected from `forked` to `fresh`.** The runtime
    always ran `fresh` regardless of what the README said; the README now matches reality instead
    of the behavior silently changing for every existing agent. An explicit `defaultContext:
    forked` is now honored for real: it forks the caller's session into a dedicated
    `~/.pi/agent/sessions/subagents/` directory (kept out of `pi --continue`'s recent-session
    lookup); if the caller session isn't persisted, or the fork fails, it falls back to `fresh`
    with a warning — a subagent run never fails because of this.
  - **`skills`** now filters the inherited skill set down to the named subset (exact,
    case-sensitive match), via the SDK's `skillsOverride`. Requested names with no match produce a
    warning per run. `skills` combined with `inheritSkills: false` is contradictory config: it
    warns and the filter is ignored. Still doesn't preload the named skills' content into context
    — not the same as Claude Code's skill-preload semantics.
  - **`description`** now builds the `subagent` tool's description shown to the model (a
    `name: description` line per discovered agent), computed once at extension registration time;
    agents added or renamed while pi is running aren't reflected until restart.
  - **Fix:** the fresh session path now uses `SessionManager.inMemory(cwd)` instead of
    `SessionManager.inMemory()`, so a subagent's session header records the actual invocation cwd
    instead of the SDK's `process.cwd()` default.

## 0.4.1 — 2026-07-28

- **Subagent toolbox now shows agent parameters.** The `subagent` tool's call title displays a
  second line with `model`/`thinking`/`tools` for the resolved agent, in addition to the existing
  agent name + task preview. New `src/render-call.ts` module (`formatAgentParams`,
  `buildSubagentCallText`). Resolved at render time only once tool args are complete
  (`context.argsComplete`), so no extra I/O happens while args are still streaming.
  - Unset fields render as `inherited`; an empty `tools: []` renders as `none`; more than 5 tools
    show the first 5 plus a `+k more` suffix.
  - Parallel mode (`tasks: [...]`) shows one parameter line per resolving task entry, in order;
    unresolved/unknown agent names are silently omitted (no placeholder).
  - Fixes a pre-existing crash hazard: a partial/streaming `tasks` entry missing `agent` or `task`
    previously could throw inside the renderer; it now falls back to `"?"`/empty text.

## 0.4.0 — 2026-07-28

- **Real YAML frontmatter parsing.** `src/frontmatter.ts` now parses frontmatter with the `yaml`
  package instead of a hand-rolled line-by-line parser. New runtime dependency: `yaml` (`^2.9.0`).
- **New `disallowedTools` field.** Denylist counterpart to `tools`, applied after it. Comma string
  or YAML list, same Claude Code tool-name compatibility as `tools`. Forwarded to the SDK's
  `createSession` as `excludeTools`.
- **Claude Code frontmatter compatibility.** `.claude/agents/*.md` files now load and run unchanged
  as pi-simple-agents agents (Claude → pi only):
  - `tools`/`disallowedTools` accept Claude Code's capitalized tool names (`Read`, `Grep`, `Glob`,
    `Bash`, `Write`, `Edit`, `MultiEdit`, `LS`, `WebSearch`, `WebFetch`) and map them to pi's tool
    names (`src/claude-compat.ts`, `CLAUDE_TOOL_MAP`); unrecognized/already-lowercase names pass
    through unchanged; duplicates after mapping are deduped.
  - Claude-only tool names with no pi equivalent (`Task`, `TodoWrite`, `NotebookEdit`,
    `SlashCommand`, `KillShell`, `BashOutput`, `ExitPlanMode`, `AskUserQuestion`) pass through
    harmlessly and are reported once per 60 seconds via an aggregated `console.warn`.
  - `model` accepts Claude Code's model aliases (`sonnet`, `opus`, `haiku`, `fable`) and `inherit`.
    Aliases are not resolved to a real model ID; they pass through as literal strings, which
    degrade gracefully to the session's default model since model resolution only acts on values
    containing a `/`. Documented limitation: use pi's `provider/modelId` form to force a specific
    model.
  - Claude fields with no functional effect in pi (`permissionMode`, `maxTurns`, `mcpServers`,
    `hooks`, `memory`, `background`, `isolation`, `color`, `effort`, `initialPrompt`) are accepted
    without error, values preserved but inert, and reported once per 60 seconds via one aggregated
    `console.warn` grouped with inert tool names and model aliases.
- **Newly wired pi-native fields.** `thinking`, `inheritSkills`, `inheritExtensions`,
  `defaultContext`, and `skills` were previously declared on `AgentConfig` but silently dropped
  during frontmatter parsing; they are now actually parsed and populated. `skills` is parsed and
  stored but still not wired to preload skill content into the subagent's context — a known
  limitation for both pi-native and Claude-imported agent files.
- **Fix: invalid `systemPromptMode`/`defaultContext` normalize to the default instead of breaking
  silently.** An invalid `systemPromptMode` previously dropped the entire system prompt silently;
  it and an invalid `defaultContext` now fall back to their default value with a per-file warning.
- **Backward compatible.** Existing pi-native agent files, including `agents-examples/scout.md` and
  `web-scout.md`, parse and behave identically to before (covered by a golden-file regression test).
- **Fix: an unquoted `": "` in a scalar frontmatter value (e.g. `description: Use when: X`) used to
  fail strict YAML parsing, silently emptying the frontmatter and dropping the agent from discovery
  entirely — no `name`/`description` means the file is skipped.** This regression was introduced (and
  caught) by this same real-YAML-parsing change above, during its own QA pass, not a pre-existing
  issue. `parseFrontmatter` now retries once with a failure-scoped lenient recovery pass: unindented
  plain-scalar lines containing `": "` are auto-quoted and reparsed; on success the agent loads
  normally with one warning naming the recovered field(s) (quote the value in the source file to
  silence it). If recovery also fails, prior behavior (empty frontmatter, warning, file skipped)
  applies unchanged. Never triggered for frontmatter that already parses on the first try.
- **Warn-only: unquoted `#` in a scalar value.** A `#` following whitespace inside a scalar value is
  valid YAML for "start of comment," silently truncating the value. This is now detected (not
  auto-repaired — a `#` may be intentional) and reported with a per-file warning.

## 0.3.3 — 2026-07-28

- **`modelRuntime` → `modelRegistry` migration.** The extension now passes `ctx.modelRegistry`
  straight through to `runAgentViaSdk` instead of reaching into `(ctx.modelRegistry as any).runtime`.
  Model resolution uses `modelRegistry.find(provider, modelId)` in place of `modelRuntime.getModel`.
- **Typed SDK option surfaces.** `RunAgentViaSdkOptions` now derives its `modelRegistry`,
  `resourceLoader`, `sessionManager`, and `getModel` return type from the SDK's
  `CreateAgentSessionOptions`/`CreateAgentSessionResult`, replacing the previous `unknown` and
  hand-rolled inline session-shape types. `clampThinkingLevel` returns a typed
  `ThinkingLevel | undefined` instead of `string | undefined`.
- **Live e2e smoke test.** `test/e2e/subagent.e2e.test.ts` spawns real `pi` with the extension
  loaded from this repo and drives the `subagent` tool end-to-end against a real model. Opt-in
  only: `PI_LIVE_E2E=1 npm run test:e2e` (skipped otherwise; not part of `npm test`).
- **New scripts.** `test:types` (`tsc --noEmit`) and `test:e2e`.
- **Dependency changes.** Restored `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`,
  and `typebox` as `peerDependencies`, with matching `devDependencies` pinned for local
  development/type-checking.
- **tsconfig.** `noEmit: true`; `include` now covers `extensions/**/*` and `test/**/*` in addition
  to `src/**/*`; added `allowImportingTsExtensions`; dropped `rootDir`.

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