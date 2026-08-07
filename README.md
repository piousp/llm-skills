# LLMs

Public skills and agents for coding agents (Claude Code, pi, and similar harnesses). Everything
here is harness-agnostic reference material — no project- or employer-specific content.

Skills live under `skills/<name>/SKILL.md`; agents live under `agents/<name>/AGENT.md`. Symlink
(or copy) the ones you want into your harness's discovery path (e.g. `~/.claude/skills/`,
`~/.claude/agents/`).

## Skills

| Skill | Purpose |
|---|---|
| [`pablo-code-philosophy`](skills/pablo-code-philosophy/SKILL.md) | Core code philosophy: simplicity, readability, YAGNI, data-first design. The lens most other skills/agents here delegate to. |
| [`functional-programming`](skills/functional-programming/SKILL.md) | Mechanical FP guidance for Java/Scala — immutability, composition, typed error handling (Option/Either) — plus a when-NOT-to-apply table. |
| [`gof-design-patterns`](skills/gof-design-patterns/SKILL.md) | Curated subset of 12 GoF patterns with a code-smell → pattern table and an over-engineering guard. |
| [`refactor-identification`](skills/refactor-identification/SKILL.md) | Evidence-based detection of structural refactor candidates in a branch diff (missing abstractions, weak encapsulation, poor data types, flag-modeled variants). Identifies direction only. |
| [`tdd`](skills/tdd/SKILL.md) | Reference for the red → green loop: what a good test is, where tests go, anti-patterns. |
| [`iterative-design`](skills/iterative-design/SKILL.md) | Coordinator method tying the above together: TODO list → goal discovery → planner (`plan.md`) → one vertical TDD loop → one combined refactor phase → QA gate. Invoked by explicit name only — never auto-triggered. The lead agent only delegates, never implements. Delegates to the generic `planner`/`code-implementer`/`analyst` agents, each invocation naming its lens by skill-relative path (`lens/planner-lens.md`, `lens/code-implementer-lens.md`, `code-review-checklist/SKILL.md`, `qa-adversary/SKILL.md`); no hardcoded model names — the harness picks the tier. |
| [`code-review-checklist`](skills/code-review-checklist/SKILL.md) | Code-review lens: validates a diff against Pablo's coding-philosophy checklist and flags test-coverage gaps. Never modifies code. Apply directly, or hand to a read-only agent (e.g. `analyst`) as its lens. |
| [`qa-adversary`](skills/qa-adversary/SKILL.md) | Adversarial QA lens: hunts correctness bugs, regressions, and business-rule violations in a diff; assesses integration-test coverage by reading tests, never running them. Complements `code-review-checklist` (does not judge style). Never modifies code. |
| [`prompt-generator`](skills/prompt-generator/SKILL.md) | Sharpens a vague ask into a precise, portable prompt before any exploration or spec work begins. |
| [`logical-fallacies-analysis`](skills/logical-fallacies-analysis/SKILL.md) | Detects logical fallacies in text (20-fallacy catalog, severity classification, soundness verdict). Bilingual: EN (`SKILL.md`) and ES (`SKILL.es.md`). |
| [`writing-agent-skills`](skills/writing-agent-skills/SKILL.md) | Authoring, reviewing, or refactoring an agent Skill's `SKILL.md` and supporting files, adapted from Philipp Schmid's "8 Tips for Writing Agent Skills", with an `evals/` suite. |
| [`evaluating-agent-skills`](skills/evaluating-agent-skills/SKILL.md) | Building an eval suite for an existing skill — success criteria, prompt set, and layered checks (offline tests, live CLI trajectory probes, LLM-as-judge). Expansion of `writing-agent-skills`' "test it before you ship it" step. |
| [`revisor-textos`](skills/revisor-textos/SKILL.md) (ES) | Coordinator method for reviewing/correcting Spanish-language texts via delegated `analyst`/`worker` subagents; never evaluates or corrects directly. |
| [`thesis-planning`](skills/thesis-planning/SKILL.md) | Staged planning process for a thesis/dissertation: exploratory reading → research question (proposals delegated to `planner`, user selects) → thematic literature map → working table of contents → per-chapter drafting (skeleton → draft, `[Author, year](url)` citations traced to `sources.json`) → reviewer-feedback loop with a strict `## YYYY-MM-DD | reviewer | vNN | status` header contract → reverse-outline verification. Includes `literature-scout`/`chapter-drafting` lenses, state/source-validation scripts, and a layer-1 eval suite plus an end-to-end smoke test. |

## Agents

Two layouts coexist: generic role agents live flat under `agents/<name>.md`; named, self-contained
agents live under `agents/<name>/AGENT.md`.

| Agent | Purpose |
|---|---|
| [`analyst`](agents/analyst.md) | General-purpose, read-only analysis agent for any domain. Supports lens-mode invocations (`Lens: <path>`) — used as the vehicle for the `code-review-checklist` and `qa-adversary` skills in `iterative-design`, and standalone. |
| [`planner`](agents/planner.md) | General-purpose, read-only planning agent for any domain; self-selects an internal lens (code/research/writing/task) or applies an external `Lens: <path>` when the invocation supplies one. |
| [`worker`](agents/worker.md) | General-purpose executor agent for any delegated task — code, writing, research, shell. Supports lens-mode invocations (`Lens: <path>`) that override its default method and output contract. |
| [`scout`](agents/scout.md) | Fast, read-only codebase recon agent — finds files, symbols, patterns, and references without analysis or evaluation. Supports lens-mode invocations (`Lens: <path>`) that replace its default output format. |
| [`web-scout`](agents/web-scout.md) | Fast web searcher — runs parallelizable queries, picks the best source, returns direct results. Accepts an optional lens file for structured multi-source output. |
| [`critical-thinker`](agents/critical-thinker/AGENT.md) | Forked-context, antagonistic-but-unbiased critic of another agent's decisions — catches hidden, conflicting, or inconsistent choices without making decisions itself. Ported from `pi-subagents`; local addendum adds lens-mode invocations. |

All agents also work standalone in chat, independent of `iterative-design`.

## Other

`pi-simple-agents/` is a standalone npm package (Claude-Code-compatible subagent delegation tool for
pi) with its own `README.md`/`CHANGELOG.md` — not a skill or agent file.

## Using these files

Frontmatter (`tools`, `model`, turn limits, etc.) is harness-specific — the files here use a
generic placeholder and a portability note. Adjust to your harness's conventions when you copy or
symlink them in.

`pi-themes/monokai-soda.json` is the one exception to the harness-agnostic rule above — it's a
pi-specific interactive-TUI theme, not a skill or agent.
