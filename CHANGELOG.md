# Changelog

All notable changes to this repository are documented here.

## [Unreleased]

### Added
- `README.md` describing repo layout and skill/agent index.
- `agents/code-review-checklist/AGENT.md` — read-only reviewer agent (checklist-based).
- `agents/qa-adversary/AGENT.md` — read-only adversarial QA critic agent.
- `skills/iterative-design/SKILL.md` (with `stages/planner.md`, `stages/refactor.md`,
  `stages/tdd.md`) — coordinator method tying planning, TDD, and refactor phases together.

### Changed
- Reorganized all skills under a consistent `skills/<name>/` layout:
  `functional-programming`, `gof-design-patterns`, `pablo-code-philosophy`,
  `prompt-generator`, `refactor-identification`, `tdd` moved from repo root into `skills/`.

## [0.1.0] - Initial skills

### Added
- `functional-programming`, `gof-design-patterns`, `tdd` skills (FP, GoF and TDD guidance).

## [0.0.1] - Initial import

### Added
- Initial repository import.
