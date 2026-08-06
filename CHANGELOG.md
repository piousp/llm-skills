# Changelog

All notable changes to this repository are documented here.

## [Unreleased]

### Added
- `skills/thesis-planning/SKILL.md` — staged planning process for a thesis/dissertation:
  exploratory reading through a research question, a thematic literature map, a working
  table of contents, per-chapter drafting (skeleton → full draft), a reviewer/tutor feedback
  loop with lightweight versioning, and reverse-outline verification. Includes
  `lens/literature-scout-lens.md` and `lens/chapter-drafting-lens.md`, `scripts/state.py` and
  `scripts/validate_sources.py`, and a layer-1 eval suite (`evals/`).
- `pi-simple-agents/` — minimal Claude-Code-compatible subagent delegation tool for pi
  (`subagent` tool: single/parallel invocation, agent frontmatter parsing/validation,
  output parsing, result formatting), with unit tests.
- `skills/iterative-design/scripts/state.py` — advisory, read-only script deriving pipeline
  phase/gate status/checkpoint from `.design/*.md` and git HEAD; used at phase boundaries
  instead of re-deriving state from context.
- `skills/iterative-design/stages/goal-discovery.md` — Phase 1 extracted into its own stage file.
- `skills/iterative-design/stages/qa.md` — Phase 5 extracted into its own stage file.
- `skills/logical-fallacies-analysis/SKILL.md` (EN) and `SKILL.es.md` (ES) — bilingual skill
  for detecting logical fallacies in text: 20-fallacy catalog with detection signals, 5-step
  analysis procedure, severity classification, and argumentative soundness verdict. First
  non-coding skill and first bilingual (`.es.md`) skill in the repo.
- `pi-themes/monokai-soda.json` — Monokai-inspired dark theme for pi's interactive TUI.
- `README.md` describing repo layout and skill/agent index.
- `agents/code-review-checklist/AGENT.md` — read-only reviewer agent (checklist-based).
- `agents/qa-adversary/AGENT.md` — read-only adversarial QA critic agent.
- `skills/iterative-design/SKILL.md` (with `stages/planner.md`, `stages/refactor.md`,
  `stages/tdd.md`) — coordinator method tying planning, TDD, and refactor phases together.
- `agents/pablo-planner/AGENT.md` — read-only design subagent for `iterative-design` Phase 2.
- `agents/pablo-implementer/AGENT.md` — code-writing subagent for `iterative-design` Phases 3–4.
- `agents/pablo-oracle/AGENT.md` — high-context, forked-context decision-consistency oracle
  subagent, ported from `pi-subagents`' `oracle`.
- `skills/writing-agent-skills/SKILL.md` — authoring/reviewing/refactoring guidance for agent
  Skills, adapted from Philipp Schmid's "8 Tips for Writing Agent Skills"; includes an `evals/`
  suite (`judge.py`, `prompt_set.json`, `run_layer2_probes.py`, `README.md`).
- `skills/iterative-design/evals/` — eval suite for the coordinator skill: `judge.py`,
  `run_layer2_probes.py`, `run_layer2b_pipeline.py`, `test_state.py`, `README.md`.
- `skills/code-review-checklist/SKILL.md` and `skills/qa-adversary/SKILL.md` — the
  `agents/code-review-checklist` and `agents/qa-adversary` doctrine, extracted into reusable
  lens files so generic agents (`analyst`) can apply them via `Lens: <path>` invocations; the
  standalone agents are unchanged.
- `skills/iterative-design/lens/planner-lens.md` and `lens/code-implementer-lens.md` — the
  method-specific output contracts (design markers, seam sizing, refactor-mode rules) that used
  to live inside `pablo-planner`/`pablo-implementer`'s own system prompts, now passed by path to
  the generic `planner`/`code-implementer` agents.
- `skills/prompt-generator/evals/` — eval suite (`judge.py`, `run_layer2_probes.py`,
  `prompt_set.json`, `README.md`).
- `skills/refactor-identification/evals/` — eval suite, including trigger probes
  (`run_trigger_probes.py`, `trigger_prompt_set.json`) since this skill has a real "when" clause
  and negative cases (`judge.py`, `run_layer2_probes.py`, `prompt_set.json`, `test_harness.py`,
  `README.md`).
- `agents/critical-thinker/references/decision-checks.md` — 14-entry detection vocabulary for
  the decision-consistency role, adapted from the `falacias` / `defectos-epistemicos` catalogs
  of `skills/revisor-textos` to the decision domain: one-line definition, decision-domain
  diagnostic question, adapted detection signals, source-catalog reference, and native-category
  mapping (`drift` / `contradiction` / `hidden assumption` / `pivot risk`) per entry.

### Changed
- `pi-simple-agents/` — version bumped to 0.3.0. Migrated from child-process-based subagent
  spawning to SDK-based execution (`runAgentViaSdk`). Added caching with TTL for agent discovery
  and overrides (`discoverAgents`, `loadOverrides`). New agent fields: `thinking`, `inheritSkills`,
  `defaultContext`, `skills`. Support for `subagents` config key as alias for `pi-simple-agents`.
  Concurrency limit (4) via `mapWithConcurrencyLimit`. Removed `src/parse-output.ts` (no longer
  needed with SDK runner). Dropped pi extension manifest and peerDependencies; now a standalone
  library with `glob` and `zod` as dependencies.
- `skills/iterative-design/SKILL.md` — Phases 1 and 5 moved out into `stages/goal-discovery.md`
  and `stages/qa.md` for consistency with Phases 2–4; phase sequencing/gate logic now delegates
  to `scripts/state.py` instead of being re-derived from context each turn; documents the
  `decisions.md` marker contract (`phase3-green`, gate headers, Phase 4/5 completion markers)
  that `state.py` parses; dropped the now-redundant "resist the urge to start coding" line.
- `skills/iterative-design/stages/refactor.md`, `stages/qa.md` — require an explicit completion
  marker in `.design/decisions.md` (`## Phase 4 — complete`, `## Phase 5 — complete` on PASS) so
  `state.py` can detect phase completion.
- `.gitignore` — added `.design/` and `node_modules/`.
- `skills/iterative-design/SKILL.md`, `stages/refactor.md`, `stages/tdd.md` — coordinator no
  longer mutates git; captures read-only checkpoint hashes instead of tagging/committing on the
  user's behalf, and asks the user to commit if HEAD is dirty at freeze time.
- Reorganized all skills under a consistent `skills/<name>/` layout:
  `functional-programming`, `gof-design-patterns`, `pablo-code-philosophy`,
  `prompt-generator`, `refactor-identification`, `tdd` moved from repo root into `skills/`.
- `agents/pablo-planner/AGENT.md`, `agents/pablo-implementer/AGENT.md` — added attribution notes
  crediting the `pi-subagents` package (`planner`/`worker`) they were adapted from.
- `skills/iterative-design/` — durable design artifacts moved from repo-root `.design/` to a
  per-launch temp dir (`$DESIGN_DIR`, under `${TMPDIR}/iterative-design/<basename(cwd)>/<PPID>`),
  never committed to the repo. `scripts/state.py` gained `--design-dir` and a `sessions`
  subcommand; Phase 0 now resolves `$DESIGN_DIR` and offers prior sessions to resume instead of
  auto-resuming; `stages/*.md` updated accordingly.
- `pi-simple-agents/` — version bumped to 0.3.3. Migrated `modelRuntime` → `modelRegistry`
  throughout (`RunAgentViaSdkOptions`, the extension, and the `subagent` tool), using the SDK's
  typed `CreateAgentSessionOptions`/`CreateAgentSessionResult` instead of `unknown`/hand-rolled
  inline types; `clampThinkingLevel` now returns a typed `ThinkingLevel | undefined`. Restored
  `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox` as peerDependencies
  (with matching devDependencies). Added `test:types` and `test:e2e` scripts, plus a live,
  opt-in end-to-end smoke test (`PI_LIVE_E2E=1 npm run test:e2e`) that drives the real `subagent`
  tool through `pi`.
- `pi-simple-agents/` — version bumped from 0.3.3 to 0.9.4 (not logged release-by-release here;
  see `pi-simple-agents/CHANGELOG.md` for the full version-by-version detail). Highlights across
  that range: Claude Code compatibility warnings for model aliases and inert frontmatter fields
  (0.5.x–0.7.x era); invocation-level `model`/`tools`/`skills` overrides on the `subagent` tool
  (0.8.0–0.9.0); a fix so an unresolvable `model` warns instead of failing silently (0.9.2); and,
  the main new capability, directory-style agent discovery — `<agentsDir>/<name>/AGENT.md`
  alongside the existing flat `<name>.md` files, with name-fallback-to-basename, first-wins dedup
  backed by a throttled duplicate warning, and deterministic collision ordering via sorted
  `readdir` entries (0.9.3–0.9.4).
- `agents/critical-thinker/AGENT.md` — the local addendum's hardcoded `/home/pablo/...` path
  replaced with a home-relative `~/LLMs/...` path, for portability across machines/users.
- `.gitignore` — removed `.design/` and `.pi-subagents/` (no longer created inside the repo now
  that `iterative-design` writes to `$DESIGN_DIR`); added `__pycache__/`.
- `agents/analyst.md`, `agents/planner.md` — both gain a "Lens-mode invocations" section:
  when the prompt supplies `Lens: <path>`, read and apply it, replacing the default output
  format/heuristics entirely; fail-closed if the named lens is unreadable. `analyst` additionally
  gains the `subagent` tool (read-only recon delegation only). `planner`'s `thinking` dropped from
  `xhigh` to `high`.
- `skills/iterative-design/` — subagent cast migrated off the named `pablo-planner` /
  `pablo-implementer` / `code-review-checklist` / `qa-adversary` agents onto the generic
  `planner` / `code-implementer` / `analyst` agents, each invocation now passing its lens by
  path (`lens/planner-lens.md`, `lens/code-implementer-lens.md`,
  `skills/code-review-checklist/SKILL.md`, `skills/qa-adversary/SKILL.md`) plus an explicit
  `model` (and `tools`/`skills: []` where noted) instead of relying on a named agent's built-in
  tier/skills. `scripts/state.py`'s `actor` fields, `stages/*.md`, and `SKILL.md`'s "Subagent
  cast" section updated accordingly.
- `skills/iterative-design/scripts/state.py` — `gate_answer()` now takes the LAST matching gate
  header when `decisions.md` has more than one (append-only log, later block can reopen/revise an
  earlier one); Phase 4/5 completion checks now match only `## `-header lines via a new
  `_header_matches()` helper, not any prose mention elsewhere in the file; `SKILL.md` documents
  the literal `Decision: run|skip|finish` contract `gate_answer()` parses.
- `skills/prompt-generator/SKILL.md` — reformulation proposals loop (re-propose after every user
  adjustment, never jump straight to the final block); added an "Ask vs. assume" section (ask for
  scope-changing ambiguity, assume-and-flag for low-impact ambiguity) and a worked example;
  clarified the fenced verbatim block is reserved for the confirmed final deliverable only.
- `skills/refactor-identification/SKILL.md` — P1/P2 priority now keyed on the smell's
  root-cause line (declaration/definition/dispatch site), not any call/check site referencing
  it; added a tie-break rule (root cause wins over occurrence count).
- `skills/revisor-textos/` — session resume via a new `state.py sessions` subcommand +
  `ask_user_question` (never auto-resumes; ambiguous/omitted answer starts a fresh session under
  a new PPID); no-subagent fallback rule consolidated into one section; typo fixes.
- `agents/pablo-oracle/` renamed to `agents/critical-thinker/` — description now reads
  "Pensador crítico de alta consistencia: protege el estado heredado y previene la deriva
  de decisiones"; tool box reduced to `read, grep, find, ls` (no `bash`; the ported body's
  bash working rule dropped); and a marked local addendum
  (`--- LOCAL ADDENDUM (no sync upstream) ---`) requiring the agent to unconditionally
  consult `references/decision-checks.md` when building the Diagnosis, Drift / contradiction
  check and Risks sections, attach mechanism descriptors to native categories,
  qualify certainty coarsely (high/low), and never treat a label as a veto. The ported
  body and output template remain verbatim.

- `agents/scout.md`, `agents/worker.md`, `agents/critical-thinker/AGENT.md` — gain a
  "Lens-mode invocations" section, matching `analyst`/`planner`/`web-scout`: a `Lens: <path>`
  (or pasted labeled) lens replaces the agent's default output contract, with a per-agent
  invariant list no lens may widen (`scout`: read-only recon, no interpretation, no invented
  findings; `worker`: fixed tools, coordinator-owned scope, mandatory disclosure of every
  filesystem change; `critical-thinker`: no writes, inherited context stays the baseline
  contract, unconditional decision-checks read, "Need from main agent" always reachable).
  `scout`/`worker` frontmatter `description` now advertises lens support; `critical-thinker`'s
  addendum-only change keeps its frontmatter and ported body untouched.
- `README.md` — agent table corrected: dropped five agents no longer present
  (`pablo-planner`, `pablo-implementer`, `code-review-checklist`, `qa-adversary`,
  `pablo-oracle`); added the previously-missing `scout`, `web-scout`, `critical-thinker` rows.

### Removed
- `skills/revisor-textos/run_tests.py` — superseded by `evals/test_state.py`.

## [0.1.0] - Initial skills

### Added
- `functional-programming`, `gof-design-patterns`, `tdd` skills (FP, GoF and TDD guidance).

## [0.0.1] - Initial import

### Added
- Initial repository import.
