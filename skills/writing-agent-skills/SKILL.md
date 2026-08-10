---
name: writing-agent-skills
description: >
  Use when authoring, reviewing, or refactoring an agent Skill — writing SKILL.md
  frontmatter/body, structuring scripts/references/assets folders, tightening a
  trigger description, or evaluating a skill before shipping it. Do NOT use for
  general coding, prose writing, or non-skill documentation.
---

# Writing Agent Skills

When writing the skill, one rule overrides all others:

- [NEVER] write meta references, self-thoughts, or anything that isn't an instruction
- [ALWAYS] keep it simple stupid (KISS principle)
- [Always] short and easy to follow *directives*

## 1. Basic skill structure

A skill is a folder: `SKILL.md` (required) + optional `scripts/`, `references/`, `assets/`, `stages/`.
Three loading layers:
- Always loaded: `name` + `description` frontmatter.
- Loaded on trigger: the `SKILL.md` body.
- Loaded on demand: files under `scripts/`, `references/`, `assets/`, `stages/`.
- [ALWAYS] use relative paths for referencing these files (ie. "read `stages/first.md`")

## 2. Description

The `description` is the trigger. Write both the **what** the skill does and the **when** to use it. Also add a negative case: when *NOT* to trigger. For example:

- {BAD} "Helps with documents" / "API helper"
- {GOOD} "Create, edit, and analyze .docx files; tracks changes, comments, formatting, text
  extraction. Triggers whenever the user is working with docx files. [DO NOT] trigger when working with any other file types"

If a skill is only ever invoked by explicit name (never auto-triggered), say so plainly in the
body — the description then only needs to be accurate, not optimized for triggering.

## 3. Writing format

- Use directives ("[Always] use X")
- Be direct, less is more
- Lead with a short example over a long explanation.
- When a rule needs a reason, give one short line — don't pad it into a paragraph.
- KISS principle: simplicity is the primary goal, not a side effect; easier to read for
  both humans users and agents.
- Write impersonally, third person neutral. Skills are written for LLM agents to use directly.
- Highlight keywords with `**` and/or `[]` brackets to increase the weight of the instruction.
  - Enforcement keys: [ALWAYS], [MUST], [DO], [FOLLOW]
  - Negative rules: [NEVER], [DO NOT]
  - Combine `**` and `[]` for an even stronger petition; other verbs are allowed too.
- Add variance to both sentence length and structure. Generated prose has low
  **burstiness** (uniform sentence rhythm) and low **perplexity** (too-predictable
  word choice); detectors combine both signals with vocabulary markers, so surface
  synonym-swapping does not fool them.
- [NEVER] use AI-tell vocabulary:
  - EN: delve, tapestry, realm, landscape, journey, nuanced, multifaceted,
    transformative, pivotal, robust, seamless, invaluable, moreover, additionally,
    notably, crucially, "not only... but also", "in conclusion", "in summary",
    "paving the way", "shed light on"
  - ES: cabe destacar, es importante señalar, en el panorama actual, juega un
    papel fundamental, sin lugar a dudas, no obstante, asimismo, por otra parte,
    en conclusión, en resumen, en definitiva, desafíos, perspectivas futuras,
    multifacético, transformador
- [NEVER] use em-dashes (—) as an emphasis shortcut; connect ideas with periods,
  commas, or semicolons.
- [NEVER] close with formula phrases ("in conclusion", "en conclusión") or add
  meta-comments about the text itself ("as a language model", "espero que esto sirva").

## 4. Keep it lean

Every line carries weight: it costs tokens, affects model behavior, and has a maintenance cost.
- Body of `SKILL.md` under ~500 lines.
- Split multi-topic skills into separate `references/*.md` files the agent loads only when needed.
- If a reference file exceeds 500 lines, put a table of contents with line hints at the top.
- If the skill is multi-staged, separate the stages in files `stages/*.md` and reference them from the main SKILL.md with relative path.

## 5. Set the right level of freedom

**Describe the goal**, not a rigid step sequence, unless order genuinely matters:
- {BAD} "Step 1: read the file. Step 2: parse JSON. Step 3: update the port. Step 4: write it back."
- {GOOD} "Update the database port in the config file to the value the user specifies."

**Prefer constraints over procedures**: "Always run tests before opening a PR. Never push to main" —
not a scripted checklist of git commands.

If exact step order is truly critical (fragile if step 3 runs before step 2), that's not a
skill problem — **write a script** and have the skill call it. Scripts live in `scripts/*.*`

## 6. Naming the skill

- Propose 3 alternatives to the user, [NEVER] pick one yourself (but give your recommendation)
- Name in frontmatter and directory [MUST] be equal (eg. `my-test-skill/SKILL.md` → "name: my-test-skill")
- Use kebab-case: lowercase letters and hyphens

## Source

Distilled from Philipp Schmid, "8 Tips for Writing Agent Skills",
https://www.philschmid.de/agent-skills-tips (published 2026-04-13). Read the original for the
full prose, examples, and the linked companion piece on evaluating skills.
