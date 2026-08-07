---
name: pablo-coding
description: >
  Coordinator-driven coding workflow split into 5 standalone functions
  (goal-discovery, planning, tdd, code-refactor, qa-adversary) — each
  invocable in any order, no wizard, no gates. Use when the user names
  pablo-coding or one of its functions to drive a code change end to end.
  [DO NOT] use for non-code work, [DO NOT] auto-trigger — this skill
  only runs on explicit name; the description is informational, not a
  trigger. Coexists with iterative-design.
---

# pablo-coding — coordinator hub

Coordinator-driven coding workflow: 5 standalone functions, each invocable in
any order, no wizard, no gates. This file is the hub — dispatch, the design
directory and `state.md`, reporting rule S1–S6, subagent cast, hard limits.
Function specs live in `functions/*.md`; lenses in `lens/*.md`. This skill runs
only on explicit name (or a strong keyword the user confirms in the same turn)
— it never auto-triggers; the description is informational, not a trigger.

## 1. The role of the coordinator

Coordinator, not executor. The coordinator delegates the actual work to the
subagent cast and owns the artifacts, the state, and the reporting.

**The relaxed rule (default preserved, carve-out narrow).** Direct execution is
allowed for read-only work the coordinator can do itself: reading files,
parsing artifacts, writing the carved-out artifacts (`goal.md`, `plan.md`,
`technical.md`, `spec.md`, `refactor-candidates.md`, `state.md`), presenting
syntheses, asking the user.

Delegation is required for: writing or editing code, writing or editing tests,
running builds, running tests, applying refactors, performing code review,
performing QA.

**The ask.** [ALWAYS] at every delegation point, ask: "I can delegate this to
`<agent>` or do it directly. Which?" The user answers per-call, or globally
with "delegate all remaining calls for this function", which sets a per-session
flag. The flag [DO NOT] persist across sessions — the question restarts per
session.

**Build/test verification is frozen.** Even in direct-execution mode, the
coordinator [NEVER] compiles or runs tests itself; it delegates to the
build/test agent (MCP or harness equivalent). This is non-negotiable — the one
rule the relaxed carve-out does not touch.

**Parallelism.** When the current function has a plan or a spec with N buckets,
the coordinator suggests, and the user decides: "I can dispatch N
`code-implementer`s in parallel (one per bucket). Confirm or pick a smaller
count, or do them sequentially." [NEVER] auto-spawn parallelism — the user
always confirms the count. Each subagent gets a fresh context, an explicit
bucket boundary, and the same `Lens:` path. The coordinator collects the
per-bucket verdicts, emits a combined verdict (S3), and updates `state.md` once
with all buckets summarized.

## 2. Dispatch mechanism

Three-tier ladder, in priority order. It applies at the start of every user
turn that contains a new request. Once a function is running, the user names
the next function — chaining is user-driven, not coordinator-inferred.

1. **Explicit function name** — the user wrote "do pablo-coding goal-discovery
   on X", "pablo-coding: planning", "I want to do code-refactor on Y".
   Dispatch immediately. Confirm in the same turn what the function will do and
   what artifacts it will write.
2. **Strong keyword** — an unambiguous pointer to one function: "review my
   changes" → `qa-adversary`; "refactor this" → `code-refactor`; "test this" →
   `tdd`; "design this" → `planning`; "what is the goal here" →
   `goal-discovery`. Dispatch and confirm in the same turn: "I'm reading this
   as `code-refactor` (branch diff scope). Confirm or pick a different
   function."
3. **Ambiguous / no pointer** — ask with the five-item list (one line per
   function), in the order `goal-discovery`, `planning`, `tdd`,
   `code-refactor`, `qa-adversary`. [NEVER] silently pick a function.

## 3. The design directory (`$DESIGN_DIR`)

Resolved once per session, keyed by `basename(cwd)`. Path scheme (same as
iterative-design, swapped to a `pablo-coding/` subdir):
`/tmp/pablo-coding/<basename(cwd)>/<PPID>/` (or `$TMPDIR` fallback).

First-run check: if a `state.md` already exists for this repo key, offer
**resume** / **start fresh** / **pick a function** (see State.md and resume).

## 4. Artifact catalog

| Artifact | Contents | Writer |
|---|---|---|
| `goal.md` | confirmed goal: original prompt + discovery decisions + constraints | coordinator (carve-out) |
| `plan.md` | PLAN section from the planner: seams in numbered buckets | coordinator (carve-out) |
| `technical.md` | TECHNICAL section from the planner: interfaces, contracts, tradeoffs, gotchas | coordinator (carve-out) |
| `spec.md` | seam contracts for `tdd`; co-designed, or materialized from the `tdd-no-plan` report | coordinator (carve-out) |
| `decisions.md` | append-only, the why: load-bearing decisions, gate answers, rejected alternatives | coordinator (carve-out) |
| `refactor-candidates.md` | code-refactor's output: the user-approved candidate set | coordinator (carve-out) |
| `state.md` | per-function history + current state | coordinator (carve-out) |

[NEVER] a subagent writes into `$DESIGN_DIR` — the coordinator is the single
writer of every artifact there.

## 5. State.md format + resume

**Location:** `$DESIGN_DIR/state.md` (per-session, alongside the other
artifacts). Initialized on session start if absent. Append-friendly, not
strictly append-only: the coordinator can rewrite the `## Current state` block
at the top — history below it is append-only.

```
# state.md — pablo-coding session

## Current state
- session_started: <iso>
- repo: <basename(cwd)>
- last_function: <name | "none">
- last_function_date: <iso | "none">
- delegate_mode: <"ask-each" | "delegate-all-remaining">
- artifacts_on_disk: <list of files in $DESIGN_DIR>
- open_deferrals: <list of unresolved items the user chose to defer>
- last_verdict: <verdict text or "n/a">

## History (append-only, one entry per function invocation)

### <iso> — <function-name> (mode: <direct | delegated>)
- artifacts_written: <list with status: created | modified>
- changed_files: <tree-view, status + one-line reason; "n/a" if no code change>
- key_findings: <1-3 lines; anti-noise collapses to a single line for trivial changes>
- result: <done | blocked | needs-info | user-deferred>
- verdict: <verdict text or "n/a">
- next_suggestion: <one-line hint of the natural follow-up; user decides>
```

**Deferrals.** When the user defers an open item at a checkpoint or
mid-function, the coordinator [ALWAYS] records it in `open_deferrals` in the
`## Current state` block and names it in the chat report. A resumed session
re-asks the deferred items before starting a new function.

**Key maintenance.** At each function close, the coordinator refreshes
`last_function`, `last_function_date`, and `artifacts_on_disk` in the
`## Current state` block before appending the history entry.

**Resume mechanics.** On session start, after resolving `$DESIGN_DIR`, check
for an existing `state.md`. If found, parse the `## Current state` block and
offer: **resume** (re-read the `decisions.md` chain and re-derive what was last
done), **start fresh** (new `$DESIGN_DIR`; the old one stays on disk for
archive), **pick a new function** (treat the existing artifacts as read-only
context and dispatch). [ALWAYS] initialize `delegate_mode: "ask-each"` on
session start — the "delegate-all-remaining" flag never carries across
sessions; resume never restores it.

`state.md` is not `decisions.md`: `decisions.md` is append-only (the why);
`state.md` is append-friendly (the what — per-function history).

## 6. Reporting rule (S1–S6)

Durable: survives across functions within a session; the user can re-invoke it
at any turn ("report per the rule"). Not a per-function preference.

- **S1 — key-findings after every artifact/code change.** After writing any
  artifact or after any implementer delegation completes, the chat must contain
  a synthesis of key findings, decisions, and changed files. Bare "done,
  continue" is forbidden. Example: "Seam 1 green: `add` handles the empty-cart
  case; spec.md entry appended; changed files below."
- **S2 — tree-view of changed files.** When code changes, present the changed
  files as a tree (or flattened list for small sets), each with status
  (`created`/`modified`/`deleted`) and a one-line reason. Implemented in the
  `code-implementer` lens's "Changed files" section. Example: "src/cart.rs
  (modified) — added total(); tests/cart_test.rs (created) — empty-cart test."
- **S3 — verdict after every build/test verification.** The build/test agent
  returns a verdict; the coordinator reports it first — the verdict line comes
  before any other text — followed by the key finding. The verdict is recorded
  in the `verdict:` field of the next `state.md` history entry; when the
  function closes, the coordinator updates `last_verdict:` in the `## Current
  state` block. Example:
  "VERDICT: RED as predicted — empty-cart assertion fails before the
  implementation."
- **S4 — every chat report synced to state.md.** Every chat synthesis,
  key-findings block, and verdict is mirrored into a `state.md` history entry.
  The coordinator is the single writer of `state.md`; the implementer never
  touches it.
- **S5 — anti-noise threshold.** Trivial changes (one-file rename, one-line
  tweak) get a single-line history entry and a single-line chat synthesis. The
  full tree-view and full key-findings treatment kicks in only for non-trivial
  changes.
- **S6 — the rule itself.** The rule is durable: it survives across functions
  within a session, and the user can re-invoke it at any turn. The rule is not
  a per-function preference.

## 7. Subagent cast

Three generic agents, five functions, two lens paths:

| Function | Delegation |
|---|---|
| `goal-discovery` | none (coordinator-only) — fact lookups via `scout` / `web-scout` |
| `planning` | `planner` + `lens/planner-lens.md` (design mode) |
| `tdd` | `code-implementer` + `lens/code-implementer-lens.md` (`tdd` / `tdd-no-plan` / `repair`) |
| `code-refactor` | `planner` + `lens/planner-lens.md` (refactor-candidates); `code-implementer` + `lens/code-implementer-lens.md` (`refactor`); `analyst` + `code-review-checklist/SKILL.md` (post-apply review) |
| `qa-adversary` | `analyst` + `qa-adversary/SKILL.md` |

**Delegation mechanics.** [ALWAYS] pass `skills: []` on every lens-by-path
delegation — the lens arrives by path, never by skill discovery; a harness
that auto-attaches skills could otherwise load a competing lens alongside it.

**Path resolution rule.** Every reference is resolved to an absolute path
**once at session start**, then passed verbatim into every delegation prompt —
the subagent's cwd is the working repo, not the skill dir. [NEVER] pass
relative paths in delegation prompts. Two bases: internal references
(`functions/`, `lens/`) resolve against the skill dir
(`/home/pablo/.pi/agent/skills/pablo-coding/`); references to sibling skills
(`qa-adversary/`, `code-review-checklist/`, `refactor-identification/`,
`pablo-code-philosophy/`, `tdd/`) resolve against the skills root of the
harness (in this install, `/home/pablo/.pi/agent/skills/`). Lens-internal
references to sibling skills (e.g. the planner lens reading
`pablo-code-philosophy/SKILL.md`) resolve by skill name where the harness
supports it; otherwise the lens's built-in fallback (embedded copy, or
stop-and-say-so) is the accepted behavior.

## 8. Hard limits

- [NEVER] edit any file under `iterative-design/` — the two skills coexist by
  separation, sharing agents but not artifacts; there is no migration path
  between them.
- [NEVER] reintroduce `state.py` — state is markdown.
- [NEVER] auto-trigger this skill; it runs only on explicit name (or a strong
  keyword the user confirms).
- [NEVER] scope-creep past the user's named function. The functions never call
  each other — the coordinator presents chains, the user confirms.
- Build/test verification is [ALWAYS] the coordinator's; the relaxed rule does
  not skip it, and the implementer never runs builds or tests.
- [NEVER] version-control bookkeeping: no commits, no hashes, no freeze via
  git. Read-only git analysis (`git diff`, `git log`, `git show`) is permitted
  where the function needs it — `code-refactor` candidate detection and
  `qa-adversary` diff derivation.
- [NEVER] a state machine that infers a "next phase" — the user names the next
  function explicitly.
- Skill files are in English; no emojis anywhere in the skill files.

## 9. Anti-patterns

- Running the five functions as a hidden cascade — chaining is user-driven.
- The coordinator writing design content — only the carve-out artifacts.
- The implementer running builds/tests.
- The planner (or any agent) picking a function the user didn't name.
- Locking `state.md` against edits — it is append-friendly, not append-only.
- The coordinator silently picking a function on an ambiguous prompt.

## 10. Function index

- `functions/goal-discovery.md` — mattpocock grilling to a confirmed `goal.md` + first `decisions.md` entry.
- `functions/planning.md` — `planner` design mode to `plan.md` + `technical.md`.
- `functions/tdd.md` — per-seam TDD, with plan or in `tdd-no-plan` mode.
- `functions/code-refactor.md` — detect / detect-then-apply / apply structural refactors on explicit scope.
- `functions/qa-adversary.md` — adversarial QA verdict on explicit scope + intent source.
