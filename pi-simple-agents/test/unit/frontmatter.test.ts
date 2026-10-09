import { test } from "node:test";
import assert from "node:assert/strict";
import { parse as parseYaml } from "yaml";
import { parseFrontmatter, normalizeFrontmatterFields } from "../../src/frontmatter.ts";

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

test("normalizeFrontmatterFields maps model inherit to undefined and passes full refs through", () => {
  const warnings: string[] = [];
  const inherit = normalizeFrontmatterFields({ model: "inherit" }, warnings);

  assert.equal(inherit.normalized.model, undefined);

  const full = normalizeFrontmatterFields({ model: "anthropic/claude-opus-4-8" }, warnings);

  assert.equal(full.normalized.model, "anthropic/claude-opus-4-8");
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

// --- timeoutMs (number, ms) — a typeof-guard only; range/ceiling is
// resolveTimeoutMs's job, not this layer's ---

test("normalizeFrontmatterFields normalizes timeoutMs: valid number passes through with no warning, including values above the 2h ceiling (ceiling is not this layer's concern)", () => {
  const cases = [900_000, 999_999_999];

  for (const input of cases) {
    const warnings: string[] = [];
    const { normalized } = normalizeFrontmatterFields({ timeoutMs: input }, warnings);

    assert.equal(normalized.timeoutMs, input, `${input}: should pass through unchanged`);
    assert.equal(warnings.length, 0, `${input}: should produce no warnings`);
  }
});

test("normalizeFrontmatterFields normalizes timeoutMs: non-number value drops to undefined with one warning naming the field", () => {
  const warnings: string[] = [];
  const { normalized } = normalizeFrontmatterFields({ timeoutMs: "900000" }, warnings);

  assert.equal(normalized.timeoutMs, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /timeoutMs/);
});

// --- S1.3: maxTurns (integer 1..100) — valid values pass through; invalid values
// drop to undefined with one warning naming the field and the value ---

test("normalizeFrontmatterFields normalizes maxTurns: valid integer passes through; out-of-range, non-integer, and non-number values drop to undefined with one warning each", () => {
  const cases: Array<{ name: string; input: unknown; valid: boolean }> = [
    { name: "valid 5", input: 5, valid: true },
    { name: "0 (below range)", input: 0, valid: false },
    { name: "-1 (below range)", input: -1, valid: false },
    { name: "101 (above range)", input: 101, valid: false },
    { name: "2.5 (non-integer)", input: 2.5, valid: false },
    { name: '"5" (string, not number)', input: "5", valid: false },
  ];

  for (const { name, input, valid } of cases) {
    const warnings: string[] = [];
    const { normalized } = normalizeFrontmatterFields({ maxTurns: input }, warnings);

    if (valid) {
      assert.equal(
        normalized.maxTurns,
        input,
        `${name}: normalized.maxTurns should equal input`,
      );
      assert.equal(warnings.length, 0, `${name}: valid value should produce no warnings`);
    } else {
      assert.equal(
        normalized.maxTurns,
        undefined,
        `${name}: invalid value should normalize to undefined`,
      );
      assert.equal(
        warnings.length,
        1,
        `${name}: invalid value should produce exactly one warning, got: ${JSON.stringify(warnings)}`,
      );
      assert.match(warnings[0], /maxTurns/, `${name}: warning should name the field`);
      assert.ok(
        warnings[0].includes(String(input)),
        `${name}: warning should include the invalid value, got: ${JSON.stringify(warnings[0])}`,
      );
    }
  }
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

test("model given as a bare word passes through untouched (fails later, at resolveModel)", () => {
  const content = `---
model: opus
---
body`;
  const { frontmatter } = parseFrontmatter(content);

  assert.equal(frontmatter.model, "opus");
});

test("model: inherit normalizes to undefined", () => {
  const content = `---
model: inherit
---
body`;
  const { frontmatter } = parseFrontmatter(content);

  assert.equal(frontmatter.model, undefined);
});

test("model given as a full model id passes through", () => {
  const content = `---
model: claude-3-5-sonnet-20241022
---
body`;
  const { frontmatter } = parseFrontmatter(content);

  assert.equal(frontmatter.model, "claude-3-5-sonnet-20241022");
});

test("Claude-only keys present in the frontmatter are reported in inertFields, sorted, without altering their raw values", () => {
  const content = `---
permissionMode: acceptEdits
maxTurns: 5
foo: bar
---
body`;
  const { frontmatter, inertFields } = parseFrontmatter(content);

  assert.deepEqual(inertFields, ["permissionMode"]);
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

// --- Golden characterization: normalizeFrontmatterFields over YAML-authored fixtures —
// every field, valid + invalid variants, pinned as complete { normalized, inertTools }
// objects plus the exact ordered warnings array. The expected literals are
// hand-computed worked examples (independent of the implementation), never recomputed
// from the function's output. Three fixtures because a field holds one value per fixture:
// A pins the well-formed shapes, B the invalid shapes, C the remaining variants
// (null tools, bare-word model passthrough, non-mapped defaultReads, non-integer maxTurns).
// Model semantics per 3e: no aliases anywhere — "inherit" → undefined; full refs and bare
// words pass through untouched (a bare word fails later, at resolveModel). ---

test("normalizeFrontmatterFields golden: one fixture exercising every field's valid and invalid variants, pinned as a complete object", () => {
  // Fixture A — well-formed values: block-list tools (with a Claude name mapped),
  // comma-string disallowedTools (Claude mapping + inert collection + dedupe),
  // comma-string defaultReads/skills (NOT Claude-mapped), number-coerced name,
  // full provider/modelId model ref, valid enums, native/string-coerced/invalid booleans,
  // valid maxTurns and timeoutMs.
  const rawA: Record<string, unknown> = parseYaml(`name: 42
description: Golden scout agent
tools:
  - Read
  - grep
disallowedTools: Bash, TodoWrite, bash
defaultReads: README.md, docs/PLAN-FOLLOWUPS.md
skills: code-review, testing
model: anthropic/claude-opus-4-8
thinking: medium
systemPromptMode: replace
defaultContext: fresh
inheritProjectContext: true
inheritSkills: "false"
inheritExtensions: maybe
maxTurns: 5
timeoutMs: 900000
`);

  const warningsA: string[] = [];
  const resultA = normalizeFrontmatterFields(rawA, warningsA);

  assert.deepEqual(resultA, {
    normalized: {
      tools: ["read", "grep"],
      disallowedTools: ["bash", "TodoWrite"],
      defaultReads: ["README.md", "docs/PLAN-FOLLOWUPS.md"],
      skills: ["code-review", "testing"],
      name: "42",
      description: "Golden scout agent",
      model: "anthropic/claude-opus-4-8",
      thinking: "medium",
      systemPromptMode: "replace",
      defaultContext: "fresh",
      inheritProjectContext: true,
      inheritSkills: false,
      inheritExtensions: undefined,
      maxTurns: 5,
      timeoutMs: 900000,
    },
    inertTools: ["TodoWrite"],
  });
  assert.deepEqual(warningsA, [
    'Field "inheritExtensions" must be a boolean or "true"/"false" string; got "maybe" - value ignored.',
  ]);

  // Fixture B — invalid values: mapping-typed tools/defaultReads, number-typed skills,
  // non-scalar name/thinking, number-coerced description, "inherit" model (→ undefined),
  // invalid enums, invalid boolean string, out-of-range maxTurns,
  // string-typed timeoutMs.
  const rawB: Record<string, unknown> = parseYaml(`name:
  - a
  - b
description: 7
tools:
  a: 1
disallowedTools: write, edit
defaultReads:
  path: 1
skills: 3
model: inherit
thinking:
  enabled: true
systemPromptMode: banana
defaultContext: whenever
inheritProjectContext: false
inheritSkills: "true"
inheritExtensions: "yes"
maxTurns: 101
timeoutMs: "900000"
`);

  const warningsB: string[] = [];
  const resultB = normalizeFrontmatterFields(rawB, warningsB);

  assert.deepEqual(resultB, {
    normalized: {
      tools: undefined,
      disallowedTools: ["write", "edit"],
      defaultReads: undefined,
      skills: undefined,
      name: undefined,
      description: "7",
      model: undefined,
      thinking: undefined,
      systemPromptMode: undefined,
      defaultContext: undefined,
      inheritProjectContext: false,
      inheritSkills: true,
      inheritExtensions: undefined,
      maxTurns: undefined,
      timeoutMs: undefined,
    },
    inertTools: [],
  });
  assert.deepEqual(warningsB, [
    'Field "tools" must be a string, list, or omitted; got {"a":1} - value ignored.',
    'Field "defaultReads" must be a string, list, or omitted; got {"path":1} - value ignored.',
    'Field "skills" must be a string, list, or omitted; got 3 - value ignored.',
    'Field "name" must be a scalar value; got ["a","b"] - value ignored.',
    'Field "thinking" must be a scalar value; got {"enabled":true} - value ignored.',
    'Field "systemPromptMode" must be one of append, replace; got "banana" - value ignored.',
    'Field "defaultContext" must be one of forked, fresh; got "whenever" - value ignored.',
    'Field "inheritExtensions" must be a boolean or "true"/"false" string; got "yes" - value ignored.',
    'Field "maxTurns" must be an integer between 1 and 100; got 101 - value ignored.',
    'Field "timeoutMs" must be a number; got "900000" - value ignored.',
  ]);

  // Fixture C — remaining variants: null tools (→ []), empty-list disallowedTools,
  // block-list defaultReads keeping the literal "Read" (not Claude-mapped), non-scalar
  // description, bare-word model "opus" (passthrough; fails later at run),
  // number-coerced thinking, "true"-string boolean, non-integer maxTurns.
  const rawC: Record<string, unknown> = parseYaml(`name: web-scout
description:
  - nope
tools:
disallowedTools: []
defaultReads:
  - Read
skills:
  a: 1
model: opus
thinking: 70
systemPromptMode: append
defaultContext: forked
inheritProjectContext: "true"
inheritSkills: false
inheritExtensions: true
maxTurns: 2.5
timeoutMs: 1800000
`);

  const warningsC: string[] = [];
  const resultC = normalizeFrontmatterFields(rawC, warningsC);

  assert.deepEqual(resultC, {
    normalized: {
      tools: [],
      disallowedTools: [],
      defaultReads: ["Read"],
      skills: undefined,
      name: "web-scout",
      description: undefined,
      model: "opus",
      thinking: "70",
      systemPromptMode: "append",
      defaultContext: "forked",
      inheritProjectContext: true,
      inheritSkills: false,
      inheritExtensions: true,
      maxTurns: undefined,
      timeoutMs: 1800000,
    },
    inertTools: [],
  });
  assert.deepEqual(warningsC, [
    'Field "skills" must be a string, list, or omitted; got {"a":1} - value ignored.',
    'Field "description" must be a scalar value; got ["nope"] - value ignored.',
    'Field "maxTurns" must be an integer between 1 and 100; got 2.5 - value ignored.',
  ]);
});
