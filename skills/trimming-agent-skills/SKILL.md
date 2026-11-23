---
name: trimming-agent-skills
description: >
  Use when shortening an existing agent skill (`SKILL.md` and its `references/`)
  without losing any rule, condition or precision: "trim this skill", "reduce
  this skill", "this skill is too long". Proposes a diff plus a rule-coverage
  check; never edits. [DO NOT] trigger for writing a new skill (use
  writing-agent-skills), summarizing text, or editing non-skill prose.
---

# Trimming Agent Skills

Trimming is **not** summarizing. Same rules, fewer words.

- [NEVER] edit the skill. Propose a diff and wait for approval.
- [NEVER] drop a rule to hit a length. If the target needs a lost rule, say so and ask.
- [ALWAYS] follow `writing-agent-skills` for the style of the result.

## 1. Inventory before cutting

List every item below found in the skill, one line each, numbered:

- Trigger conditions and [DO NOT] cases (description and body).
- Directives: [ALWAYS], [NEVER], [MUST], [DO NOT], and their exceptions.
- Conditionals ("only if", "unless", "when", "except").
- Step order, when order matters.
- Literal strings: commands, paths, flags, names, numbers, units, thresholds.
- Output formats and required fields.
- Cross-references to other skills or files.
- Examples that disambiguate a rule.
- The reason behind a rule, when removing it would make the rule look optional.

## 2. Cut

Cut only what carries none of the items above:

- Throat-clearing and restatement; say each rule once, in the best place.
- Padding qualifiers ("essentially", "basically", "very").
- Meta-comments, self-references, motivational text.
- Examples that repeat a rule already clear.
- Content another loaded skill already holds: point to it by name.

Keep a hedge when it states real uncertainty or a condition. Keep the "why" when
it stops the rule from reading as optional.

Moving a block to `references/` counts as keeping it. Add the relative path
where the block was.

## 3. Verify

- [MUST] Map each inventory item to its line in the trimmed version.
- Any item with no match: restore it.
- Any item whose wording got weaker (a [NEVER] turned into advice, a condition
  dropped, a number rounded): restore the original wording.
- [NEVER] re-run the trim on its own output.

## 4. Output

1. Unified diff for each file touched.
2. Coverage table: `# | item | old line | new line | status` (kept, moved, reworded, cut). Every `cut` row names why it carried no rule.
3. Line counts before and after per file.
4. Open questions: rules that cannot shrink further without a decision from the user.

The frontmatter `description` is the trigger. Touch it only when the user asks,
and show the old and new text side by side.
