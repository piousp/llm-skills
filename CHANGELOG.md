# Changelog

All notable changes to this repository are documented here.

## [Unreleased]

### Added
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
