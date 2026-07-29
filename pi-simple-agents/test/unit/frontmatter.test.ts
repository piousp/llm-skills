import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter } from "../../src/frontmatter.ts";

test("valid frontmatter with all 4 Claude-Code fields parses into correct object and body", () => {
  const content = `---
name: my-agent
description: Does a thing
tools: read, grep
model: sonnet
---
# Body

Rest of the content.
`;
  const { frontmatter, body } = parseFrontmatter(content);

  assert.equal(frontmatter.name, "my-agent");
  assert.equal(frontmatter.description, "Does a thing");
  assert.deepEqual(frontmatter.tools, ["read", "grep"]);
  assert.equal(frontmatter.model, "sonnet");
  assert.equal(body, "# Body\n\nRest of the content.\n");
});

test("tools list is split on comma and trimmed", () => {
  const content = `---
tools: read, grep, find
---
body`;
  const { frontmatter } = parseFrontmatter(content);

  assert.deepEqual(frontmatter.tools, ["read", "grep", "find"]);
});

test("tools given as a YAML sequence (inline or block-list) normalizes to string[]", () => {
  const inlineContent = `---
tools: [" read", "grep "]
---
body`;
  const blockContent = `---
tools:
  - " read"
  - "grep "
---
body`;

  assert.deepEqual(parseFrontmatter(inlineContent).frontmatter.tools, ["read", "grep"]);
  assert.deepEqual(parseFrontmatter(blockContent).frontmatter.tools, ["read", "grep"]);
});

test("tools with no value (null) normalizes to an empty array", () => {
  const content = `---
tools:
---
body`;
  const { frontmatter } = parseFrontmatter(content);

  assert.deepEqual(frontmatter.tools, []);
});

test("tools given as a YAML mapping (invalid type) normalizes to undefined with a warning", () => {
  const content = `---
tools:
  a: 1
---
body`;
  const { frontmatter, warnings } = parseFrontmatter(content);

  assert.equal(frontmatter.tools, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /tools/);
});

test("content with no frontmatter block returns empty frontmatter and unchanged body", () => {
  const content = "# Just a heading\n\nNo frontmatter here.\n";
  const { frontmatter, body } = parseFrontmatter(content);

  assert.deepEqual(frontmatter, {});
  assert.equal(body, content);
});

test("unknown extra field is parsed but does not break known field extraction", () => {
  const content = `---
name: my-agent
description: Does a thing
foo: bar
---
body`;
  const { frontmatter } = parseFrontmatter(content);

  assert.equal(frontmatter.name, "my-agent");
  assert.equal(frontmatter.description, "Does a thing");
  assert.equal(frontmatter.foo, "bar");
});

test("inheritProjectContext false string is parsed as boolean false", () => {
  const content = `---
inheritProjectContext: false
---
body`;
  const { frontmatter } = parseFrontmatter(content);

  assert.equal(frontmatter.inheritProjectContext, false);
  assert.equal(typeof frontmatter.inheritProjectContext, "boolean");
});

test("folded scalar description parses into the full joined multi-line text", () => {
  const content = `---
description: >
  line one
  line two
---
body`;
  const { frontmatter } = parseFrontmatter(content);

  assert.equal(frontmatter.description, "line one line two\n");
});

test("nested mapping under an unknown key is preserved as-is via the catch-all", () => {
  const content = `---
name: my-agent
hooks:
  onStart: foo
  onStop: bar
---
body`;
  const { frontmatter } = parseFrontmatter(content);

  assert.equal(frontmatter.name, "my-agent");
  assert.deepEqual(frontmatter.hooks, { onStart: "foo", onStop: "bar" });
});

test("syntactically invalid YAML never throws, returns empty frontmatter, full original body, and a warning", () => {
  const content = `---
tools: [read, grep
---
body`;

  const result = parseFrontmatter(content);

  assert.deepEqual(result.frontmatter, {});
  assert.equal(result.body, content);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /./);
});

test("frontmatter block that parses to a non-mapping (bare sequence) is treated as invalid", () => {
  const content = `---
- a
- b
---
body`;

  const result = parseFrontmatter(content);

  assert.deepEqual(result.frontmatter, {});
  assert.equal(result.body, content);
  assert.equal(result.warnings.length, 1);
});

// --- S6: scalar fields (name, description, model, thinking) coerce via String(v).trim(),
// non-scalar values drop to undefined with a warning ---

test("name given as a YAML number coerces to its string form", () => {
  const content = `---
name: 123
---
body`;
  const { frontmatter } = parseFrontmatter(content);

  assert.equal(frontmatter.name, "123");
  assert.equal(typeof frontmatter.name, "string");
});

test("non-scalar name (YAML sequence) normalizes to undefined with a warning", () => {
  const content = `---
name:
  - a
  - b
---
body`;
  const { frontmatter, warnings } = parseFrontmatter(content);

  assert.equal(frontmatter.name, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /name/i);
});

test("non-scalar model value also normalizes to undefined with a warning (same rule as name)", () => {
  const content = `---
model:
  provider: anthropic
  id: opus
---
body`;
  const { frontmatter, warnings } = parseFrontmatter(content);

  assert.equal(frontmatter.model, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /model/i);
});

// --- S7: systemPromptMode/defaultContext are enums; unrecognized values drop to undefined ---

test("systemPromptMode with an unrecognized value normalizes to undefined with a warning", () => {
  const content = `---
systemPromptMode: banana
---
body`;
  const { frontmatter, warnings } = parseFrontmatter(content);

  assert.equal(frontmatter.systemPromptMode, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /systemPromptMode/);
});

test("defaultContext with an unrecognized value normalizes to undefined with a warning", () => {
  const content = `---
defaultContext: banana
---
body`;
  const { frontmatter, warnings } = parseFrontmatter(content);

  assert.equal(frontmatter.defaultContext, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /defaultContext/);
});

test("valid systemPromptMode and defaultContext values pass through unchanged", () => {
  const content = `---
systemPromptMode: replace
defaultContext: fresh
---
body`;
  const { frontmatter, warnings } = parseFrontmatter(content);

  assert.equal(frontmatter.systemPromptMode, "replace");
  assert.equal(frontmatter.defaultContext, "fresh");
  assert.equal(warnings.length, 0);
});

// --- S8: boolean fields (inheritProjectContext, inheritSkills, inheritExtensions) coerce
// native booleans and "true"/"false" strings; anything else drops to undefined ---

test("inheritSkills given as a native YAML boolean stays a boolean", () => {
  const content = `---
inheritSkills: true
---
body`;
  const { frontmatter, warnings } = parseFrontmatter(content);

  assert.equal(frontmatter.inheritSkills, true);
  assert.equal(typeof frontmatter.inheritSkills, "boolean");
  assert.equal(warnings.length, 0);
});

test("inheritExtensions given as a quoted \"false\" string coerces to boolean false", () => {
  const content = `---
inheritExtensions: "false"
---
body`;
  const { frontmatter, warnings } = parseFrontmatter(content);

  assert.equal(frontmatter.inheritExtensions, false);
  assert.equal(typeof frontmatter.inheritExtensions, "boolean");
  assert.equal(warnings.length, 0);
});

test("inheritSkills with a non-boolean, non-boolean-string value normalizes to undefined with a warning", () => {
  const content = `---
inheritSkills: maybe
---
body`;
  const { frontmatter, warnings } = parseFrontmatter(content);

  assert.equal(frontmatter.inheritSkills, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /inheritSkills/);
});

// --- S12: claude-compat wiring — tools/disallowedTools mapped through mapClaudeTools,
// model normalized through normalizeClaudeModel, inert fields reported from CLAUDE_INERT_FIELDS ---

test("tools given as Claude-Code names are mapped to pi tool names and deduped", () => {
  const content = `---
tools: Read, Edit, MultiEdit
---
body`;
  const { frontmatter } = parseFrontmatter(content);

  assert.deepEqual(frontmatter.tools, ["read", "edit"]);
});

test("disallowedTools is normalized and mapped through the same Claude tool-name pipeline as tools", () => {
  const content = `---
disallowedTools: Bash, Write
---
body`;
  const { frontmatter } = parseFrontmatter(content);

  assert.deepEqual(frontmatter.disallowedTools, ["bash", "write"]);
});

test("inert Claude tool names found in tools or disallowedTools are collected into inertTools, deduped across both fields", () => {
  const content = `---
tools: Read, Task
disallowedTools: TodoWrite, Task
---
body`;
  const { inertTools } = parseFrontmatter(content);

  assert.deepEqual(inertTools, ["Task", "TodoWrite"]);
});

test("model given as a Claude alias stays resolved to itself and records the alias", () => {
  const content = `---
model: opus
---
body`;
  const { frontmatter, modelAlias } = parseFrontmatter(content);

  assert.equal(frontmatter.model, "opus");
  assert.equal(modelAlias, "opus");
});

test("model: inherit normalizes to undefined with no alias recorded", () => {
  const content = `---
model: inherit
---
body`;
  const { frontmatter, modelAlias } = parseFrontmatter(content);

  assert.equal(frontmatter.model, undefined);
  assert.equal(modelAlias, undefined);
});

test("model given as a full model id (not a Claude alias) passes through with no alias recorded", () => {
  const content = `---
model: claude-3-5-sonnet-20241022
---
body`;
  const { frontmatter, modelAlias } = parseFrontmatter(content);

  assert.equal(frontmatter.model, "claude-3-5-sonnet-20241022");
  assert.equal(modelAlias, undefined);
});

test("Claude-only keys present in the frontmatter are reported in inertFields, sorted, without altering their raw values", () => {
  const content = `---
permissionMode: acceptEdits
maxTurns: 5
foo: bar
---
body`;
  const { frontmatter, inertFields } = parseFrontmatter(content);

  assert.deepEqual(inertFields, ["maxTurns", "permissionMode"]);
  assert.equal(frontmatter.permissionMode, "acceptEdits");
  assert.equal(frontmatter.maxTurns, 5);
});

test("a pi-native agent file (lowercase tool names, no Claude-only fields) reports no inert fields or tools", () => {
  const content = `---
name: my-agent
tools: read, grep
model: claude-3-5-sonnet-20241022
---
body`;
  const { inertFields, inertTools } = parseFrontmatter(content);

  assert.deepEqual(inertFields, []);
  assert.deepEqual(inertTools, []);
});

// --- Regression: defaultReads/skills must go through the same list-shape normalization as
// tools/disallowedTools, but must NOT go through Claude tool-name mapping ---

test("defaultReads given a comma-separated string splits into string[]", () => {
  const content = `---
defaultReads: README.md, docs/guide.md
---
body`;
  const { frontmatter } = parseFrontmatter(content);

  assert.deepEqual(frontmatter.defaultReads, ["README.md", "docs/guide.md"]);
});

test("defaultReads given a YAML mapping (invalid type) normalizes to undefined with a warning", () => {
  const content = `---
defaultReads:
  a: 1
---
body`;
  const { frontmatter, warnings } = parseFrontmatter(content);

  assert.equal(frontmatter.defaultReads, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /defaultReads/);
});

test("skills given a comma-separated string splits into string[]", () => {
  const content = `---
skills: code-review, testing
---
body`;
  const { frontmatter } = parseFrontmatter(content);

  assert.deepEqual(frontmatter.skills, ["code-review", "testing"]);
});

test("skills given a non-string, non-array value normalizes to undefined with a warning", () => {
  const content = `---
skills:
  a: 1
---
body`;
  const { frontmatter, warnings } = parseFrontmatter(content);

  assert.equal(frontmatter.skills, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /skills/);
});

test("defaultReads and skills are NOT passed through Claude tool-name mapping (Read stays literal, not lowercased/mapped)", () => {
  const content = `---
defaultReads: Read
skills: Read
---
body`;
  const { frontmatter } = parseFrontmatter(content);

  assert.deepEqual(frontmatter.defaultReads, ["Read"]);
  assert.deepEqual(frontmatter.skills, ["Read"]);
});

// --- S18–S21: failure-scoped lenient recovery for unquoted colon-in-value plain scalars,
// plus a separate warn-only '#'-comment-truncation detector on successfully-parsed scalars ---

test("S18: an unquoted colon-in-value description that fails strict YAML parsing is recovered leniently, with a warning naming the field", () => {
  const content = `---
name: my-agent
description: Use when: X happens
---
body`;
  const { frontmatter, warnings } = parseFrontmatter(content);

  assert.equal(frontmatter.name, "my-agent");
  assert.equal(frontmatter.description, "Use when: X happens");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /description/);
  assert.match(warnings[0], /leniently|recover/);
});

test("S19: an already-quoted colon-containing description parses cleanly on the first try — recovery is never entered, zero warnings", () => {
  const content = `---
name: my-agent
description: 'Use when: X happens'
---
body`;
  const { frontmatter, warnings } = parseFrontmatter(content);

  assert.equal(frontmatter.name, "my-agent");
  assert.equal(frontmatter.description, "Use when: X happens");
  assert.equal(warnings.length, 0);
});

test("S20: a plain scalar followed by a genuine YAML comment marker parses on the first try (no recovery) but warns about possible truncation", () => {
  const content = `---
description: cost is 50% off #1 pick
---
body`;
  const { frontmatter, warnings } = parseFrontmatter(content);

  assert.equal(frontmatter.description, "cost is 50% off");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /description/);
  assert.match(warnings[0], /truncation/);
});

test("S21: YAML that is still broken after the lenient recovery attempt falls back to today's exact empty-frontmatter behavior", () => {
  const content = `---
description: Use when: X happens
tools: [read, grep
---
body`;

  const result = parseFrontmatter(content);

  assert.deepEqual(result.frontmatter, {});
  assert.equal(result.body, content);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /./);
});
