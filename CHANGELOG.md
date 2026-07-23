# Changelog

All notable changes to this repository are documented here.

## [Unreleased]

### Added
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

### Changed
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

## [0.1.0] - Initial skills

### Added
- `functional-programming`, `gof-design-patterns`, `tdd` skills (FP, GoF and TDD guidance).

## [0.0.1] - Initial import

### Added
- Initial repository import.
