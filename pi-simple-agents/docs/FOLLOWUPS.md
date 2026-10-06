# Follow-ups: deferred refactor candidates

Produced by a `pablo-code-simplify` pass over `src/` + `extensions/` (production code,
no tests) in its current state. These candidates failed the mechanical-change gate — each
needs a deliberate decision, a dedicated planning pass, or external evidence before it can be
safely scheduled. None of them are implemented by the corresponding mechanical plan (22 steps,
implemented in the same pass that produced this file).

## Needs its own `pablo-code-planning` pass (structural, large surface)

- **`extensions/index.ts:185-231,240-250,300-332,396-441`** — the entry point carries real
  orchestration (`runSingleTask`/`runTasks`) and rendering (`renderSubagentResultMessage`)
  logic. Moving these into dedicated `src/` modules is plausible but large enough to deserve
  its own planning pass, not a line-item in a mechanical gate.

- **`src/run.ts:330-447`** (`runAgentViaSdk`) — wraps an async IIFE inside `new Promise`, keeps
  4 mutable closure locals, nests ~5 levels deep, copies its abort check in two places. This is
  the core SDK session runner; a deep restructuring risks subtly changing the observable timing
  of abort/usage/settle. Needs characterization tests first (`pablo-tdd`), not a blind rewrite.

- **`src/frontmatter.ts:154-208`** (`normalizeFrontmatterFields`) — 6 separate loops/blocks,
  each field with its own normalization semantics. A `field → normalizer` table is plausible but
  needs field-by-field review, not a blanket mechanical pass.

- **`src/render-call.ts:46-60,84-144`** — a 2×2 matrix of builders (parallel/single ×
  collapsed/expanded) chosen by two booleans. Treating single mode as a 1-entry task list would
  remove one axis, but touches rendering output across all 4 combinations — needs snapshot tests
  of all 4 branches before changing.

## Disqualified: would change observable behavior, not a refactor

- **`src/loader-config.ts:82-86` vs `:121`** — one warning path uses `console.warn` directly
  (immediate side effect); every other loader warning is returned via `warnings[]` (deferred,
  caller decides when/how to surface it). Unifying these changes *when* a side effect fires —
  disqualified by the mechanical gate's "added/removed/reordered side effect" rule.

- **`src/validate.ts:38-43` vs `src/run.ts:191-192`** — the `"provider/modelId"` format is
  validated with two different rules today (validate.ts requires both sides non-empty; run.ts
  only requires ≥2 parts). Unifying them changes which inputs get accepted or rejected — that's
  a behavior decision, not a pure refactor. Needs a product decision on which rule is correct.

## Needs a deliberate type-safety decision (not a drop-in refactor)

- **`src/agents.ts:296-305,384-388`** — settings JSON cast to `Partial<AgentConfig>` and spread
  into agent config with no per-field validation (contrast: the frontmatter path validates every
  field). Fixing this may surface currently-silent bugs where downstream code already
  compensates (e.g. `tool-description.ts:15`'s redundant `typeof === "string"` check).

- **`src/agents.ts:8-34` / `src/progress.ts:31`** — `AgentConfig`'s array fields (`tools`,
  `skills`, `defaultReads`) and `TaskProgress.runningTools` are mutable types shared through a
  TTL cache and registry snapshots; immutability is enforced only by a comment
  ("Treat as immutable", `agent-registry.ts:13`). Needs a decision on whether to introduce
  readonly views, and where.

- **`src/validate.ts:66-87`** (`warnAndDropIllTypedOverrides<T>`) — needs 3 `as unknown as T`
  casts to work; the generic costs more type-safety workarounds than it saves. Redesigning this
  is an internal-API decision, not mechanical.

- **`src/validate.ts:89-183`** — validators return an error string instead of a parsed value,
  so correctness is restored afterwards with casts at 3 sites. Parsing into the domain type
  instead would change return types across the whole validation pipeline and its consumers —
  bigger scope than a mechanical step.

## Resolved in 1.0.0's `tasks:[...]` removal

- **`extensions/index.ts:69-72`** (`export { buildSubagentToolResult }`) — this re-export's
  signature was deliberately collapsed to single-result shape as part of removing `tasks:[...]`
  (see CHANGELOG.md 1.0.0). The public-API tradeoff below was judged, not avoided.

- **`src/render-call.ts:98-99`** (`buildParallelCallText`'s redundant `t.agent &&` check) —
  moot: the whole function was deleted along with parallel-mode rendering.

## Needs a deliberate decision (defensive code kept for testability vs. YAGNI)

- **`extensions/index.ts:189,219,229` / `src/run.ts:172,279`** (`tracker`/`onToolEvent`) —
  `tracker` is optional in `runSingleTask`, but the only production caller always passes one
  (`RunTaskOptions.tracker` is required). That makes `subscribeToolEvents`'s
  `if (!onToolEvent) return` (`run.ts:279`) dead in production, exercised only by tests.

- **`src/agents.ts:54,58-60,209,316-317,323-325`** (`cache`/`projectSettingsPath`) — both
  optional, but the only production caller (`agent-registry.ts:47-48`) always passes both; the
  `!cache`/`!projectSettingsPath` branches never run outside tests.

- **`src/run.ts:173,190`** (`getModel`) — optional and checked with `!getModel`, but production
  always passes it (`extensions/index.ts:218`).

  Removing the optionality in any of these three would delete the branch the corresponding unit
  test exercises — a deliberate call on whether that defensive path is worth keeping for
  testability, not a blind mechanical step.

## Dropped mid-implementation: reads worse once you account for the type checker

- **`src/subagent-session.ts:13-82`** (`childDir`/`callerSessionFile` passed separately, the
  `childDir ?? ""` sentinel at the fork call site) — deriving `childDir` internally from
  `callerSessionFile` would require changing `createSubagentSessionManager`'s signature (7+ call
  sites in `subagent-session.test.ts` alone), and TypeScript still can't connect "`callerSessionFile`
  is narrowed to defined here" to "`childSessionDir`'s return is therefore defined" without either
  a `!` assertion or a function overload on `childSessionDir`. Either way trades one sentinel for
  another code smell, for real signature churn — not a net simplification. Dropped; the existing
  `?? ""` is harmless (the branch is unreachable when `callerSessionFile` is truthy, which is
  already guaranteed by the caller at that point).

- **`src/render-call.ts:98-99`** (`buildParallelCallText`) — `if (t.agent && params)` is
  logically redundant: `paramsSuffix` only ever returns a defined value when `agentName` was
  truthy, so `params` truthy already implies `t.agent` truthy. But removing the `t.agent &&`
  check requires a `t.agent!` non-null assertion at the next line for TypeScript to accept it
  (it can't infer the implication across the two statements). Trading a redundant-but-safe
  runtime check for a `!` assertion is not a net readability win — dropped.

## Needs external evidence before it can be judged

- **`extensions/index.ts`** (`renderSubagentResultMessage`'s `details?.task?.agent ?? "result"`) —
  the optional chain guards against both a missing `details` and a dev session persisted with the
  pre-1.0.0 array-shaped `tasks` field instead of `task`. Whether the host
  (`@earendil-works/pi-coding-agent`) can invoke `MessageRenderer` with `details` missing entirely
  is still an open question (needs inspection of its `MessageRenderer`/`CustomMessage`
  declarations), but the `tasks`-vs-`task` compatibility case is intentional and should stay.

- **`src/run.ts:13`** (`AgentRunResult.usage?: RunUsage`) — the only producer always sets it,
  yet 2 callers still check for absence. Same class of question: does the host ever hydrate a
  persisted `subagent-result` message written by an older version where `usage` was missing?

- **`src/loader-config.ts:33-37,106`** (`extensionFactories` array passed by reference into
  every `DefaultResourceLoader`) — whether this is actually a mutability hazard depends on
  whether `DefaultResourceLoader` mutates or retains a reference to it; needs inspection of that
  class in the host package.

## From the `tasks:[]` removal pass (pi-simple-agents 1.0.0)

Produced by a `pablo-code-simplify` pass over the diff that removed the `tasks:[]` parallel-launch
mode and collapsed the result types to single-value shape. Two cheap, clearly mechanical findings
(an unused `RunTaskOptions.tracker` field; three repeated header-line expressions in
`buildJobListEntry`) were applied directly in that same pass. The rest need a deliberate decision
or a dedicated planning pass:

- **`src/agents.ts:354-372` / `src/validate.ts:9-16`** (`copyOverrideKey`/`invocationOverrideOf`) —
  the same "copy defined override keys onto a target type" loop exists twice, once generic with a
  cast, once inline. Collapsing them needs `applyInvocationOverride` to spread `invocationOverrideOf`'s
  result over `agent`, which moves logic across the `agents.ts`/`validate.ts` import boundary —
  a design call, not a mechanical extraction.

- **`src/job-messages.ts:44-52`** (`SubagentJobMessageDetails.run?`/`usage?`) — both fields are
  optional only because `status === "failed"` never sets them. A discriminated union keyed on
  `status` (failed member without `run`/`usage`) would make the type say this outright, but
  touches every consumer of the completion message's `details` (renderer, tests) — needs its own
  pass, not a drive-by.

- **`src/job-messages.ts:50,96-117`** (`SubagentJobMessageDetails.usage`/`isError`) — both are
  derivable from `run` (`toAggregatedUsage(run.usage)`, `run.status === "error"`), and no code in
  this repo reads `details.usage`/`details.isError` directly. Dropping them is a public-shape
  change to a message `details` object that may already be persisted in session files by earlier
  1.0.0 builds — same class of question as the `tasks`-vs-`task` compatibility note above, not a
  mechanical step.

- **`extensions/index.ts`** (`SubagentToolDetails` as a 2-member union narrowed by `"jobId" in`,
  and the `/subagents` command handler's if-chain over `SubagentsCommand.kind` instead of the
  exhaustive `switch` used elsewhere in `job-view.ts`) — both read fine as-is; flagged only
  because the rest of the diff is consistently more pattern-matched. Not worth the churn alone.

- **External, not this package:** `~/.pi/agent/agents/grep-across-repos.md` still describes the
  old synchronous `subagent` contract (expects an inline result) in places. The settle barrier
  keeps it working end-to-end, but its wording needs a pass to stop describing a result that
  "returns" instead of one that arrives later as a message. Not in this package's own CHANGELOG
  (it's outside `pi-simple-agents`), tracked here only as a pointer.

- **`src/background-jobs.ts:62-68`** (`isSettled`/`isActive` as two independently-written literal
  status lists, echoed again by `"settledAt" in state` in `job-view.ts:56`) — deriving the
  complement from one source of truth is straightforward in isolation, but touches the exported
  `isActive` and its only consumers; scope it with the rest of a `background-jobs.ts` pass rather
  than alone.

- **`src/progress.ts:29-35`** (`TaskProgress`'s mutable fields, including a mutable
  `runningTools` array, handed out read-only-in-practice via `JobSnapshot.progress`) — marking
  it `readonly` is cheap in isolation but the type is shared with the mutating reducers in the
  same file; needs a pass over `progress.ts` as a whole, not a one-line add.
