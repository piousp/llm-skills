---
name: writing-agent-skills
description: >
  Use when authoring, reviewing, or refactoring an agent Skill — writing SKILL.md
  frontmatter/body, structuring scripts/references/assets folders, tightening a
  trigger description, or evaluating a skill before shipping it. Do NOT use for
  general coding, prose writing, or non-skill documentation.
---

# Writing Agent Skills

Adapted from Philipp Schmid's "8 Tips for Writing Agent Skills" —
https://www.philschmid.de/agent-skills-tips (2026-04-13). See Source at the bottom.

## 1. Know what a skill is

A skill is a folder: `SKILL.md` (required) + optional `scripts/`, `references/`, `assets/`.
Three loading layers:
- Always loaded: `name` + `description` frontmatter.
- Loaded on trigger: the `SKILL.md` body.
- Loaded on demand: files under `scripts/`, `references/`, `assets/`.

Classify the skill before writing it:
- **Capability skill** — teaches a task the base model can't do consistently (e.g. PDF form
  filling). Expect it to become unnecessary as models improve; re-eval periodically (see §8).
- **Preference skill** — encodes a specific workflow/process. Durable, but must stay in sync
  with the actual process it encodes.

## 2. Nail the description

The `description` is the trigger. Write both the **what** and the **when**, and a negative case
if the topic is easily confused with something adjacent.

- ❌ "Helps with documents" / "API helper"
- ✅ "Create, edit, and analyze .docx files — tracked changes, comments, formatting, text
  extraction"

If a skill is only ever invoked by explicit name (never auto-triggered), say so plainly in the
body — the description then only needs to be accurate, not optimized for triggering.

## 3. Write instructions, not essays

State what the agent doesn't already know. Use directives ("Always use X"), not trivia ("X is
recommended"). Lead with a short example over a long explanation. When a rule needs a reason,
give one short line — don't pad it into a paragraph. Don't overfit instructions to pass a
handful of test prompts; they must generalize.

## 4. Keep it lean

Body of `SKILL.md` under ~500 lines. Split multi-topic skills into separate `references/*.md`
files the agent loads only when needed. If a reference file exceeds 500 lines, put a table of
contents with line hints at the top.

## 5. Set the right level of freedom

Describe the goal, not a rigid step sequence, unless order genuinely matters:
- ❌ "Step 1: read the file. Step 2: parse JSON. Step 3: update the port. Step 4: write it back."
- ✅ "Update the database port in the config file to the value the user specifies."

Prefer constraints over procedures: "Always run tests before opening a PR. Never push to main" —
not a scripted checklist of git commands.

**If exact step order is truly load-bearing (fragile if step 3 runs before step 2), that's not a
skill problem — write a script** and have the skill call it.

## 6. Don't skip negative cases

State explicitly when the skill should NOT fire, especially if its topic overlaps something
broader — e.g. "Use for PDF files. Do NOT use for general document editing, spreadsheets, or
plain text." A skill with no negative case risks hijacking unrelated requests.

## 7. Test it before you ship it

- Run it manually a handful of times with varied prompts; watch for skipped steps or assumed
  dependencies.
- Define measurable success per prompt (compiles? right API used? steps followed?) — grade
  outcomes, not the path taken.
- Build 10–20 test prompts: mix "should trigger", "should not trigger", and edge cases.
- Run 3–5 trials per prompt (agents are nondeterministic) — look at the distribution, not one
  pass/fail.
- Isolate each run in a clean environment; don't let context bleed between trials.
- If something's wrong, fix the description first — most failures are trigger failures, not
  instruction failures.

## 8. Know when to retire a skill

Periodically run the skill's eval prompts *without* the skill loaded. If they still pass, the
base model has absorbed the capability — retire the skill. Applies mainly to capability skills;
preference skills don't get obsoleted by model improvement, only by process changes.

## Source

Distilled from Philipp Schmid, "8 Tips for Writing Agent Skills",
https://www.philschmid.de/agent-skills-tips (published 2026-04-13). Read the original for the
full prose, examples, and the linked companion piece on evaluating skills.
