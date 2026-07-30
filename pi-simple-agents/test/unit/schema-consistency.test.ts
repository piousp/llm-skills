import { test } from "node:test";
import assert from "node:assert/strict";
import { SubagentParams } from "../../extensions/index.ts";

// Structural drift guard: extensions/index.ts's typebox `SubagentParams`
// schema (what the calling LLM sees) and src/validate.ts's hand-written
// `SubagentParams` type/validator are two independently-maintained shape
// definitions with no compiler link between them. This test reads the
// typebox schema's own key sets and asserts them against a literal list —
// the same list a human updates by hand alongside either shape definition —
// so adding/removing a field on one side without the other fails loudly.

const EXPECTED_TOP_LEVEL_KEYS = ["agent", "task", "model", "tools", "skills", "tasks"];
const EXPECTED_TASKS_ITEM_KEYS = ["agent", "task", "model", "tools", "skills"];

test("SubagentParams schema top-level keys match the hand-written validator's known fields", () => {
  assert.deepStrictEqual(
    Object.keys(SubagentParams.properties).sort(),
    [...EXPECTED_TOP_LEVEL_KEYS].sort(),
  );
});

test("SubagentParams schema's tasks[] item keys match the hand-written validator's TaskEntry fields", () => {
  const tasksItemSchema = SubagentParams.properties.tasks.items;
  assert.deepStrictEqual(
    Object.keys(tasksItemSchema.properties).sort(),
    [...EXPECTED_TASKS_ITEM_KEYS].sort(),
  );
});
