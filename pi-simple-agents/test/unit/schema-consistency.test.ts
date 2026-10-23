import { test } from "node:test";
import assert from "node:assert/strict";
import { SubagentParams, SubagentJobParams } from "../../extensions/index.ts";

// Structural drift guard: extensions/index.ts's typebox `SubagentParams`
// schema (what the calling LLM sees) and src/validate.ts's hand-written
// `SubagentParams` type/validator are two independently-maintained shape
// definitions with no compiler link between them. This test reads the
// typebox schema's own key sets and asserts them against a literal list —
// the same list a human updates by hand alongside either shape definition —
// so adding/removing a field on one side without the other fails loudly.

const EXPECTED_TOP_LEVEL_KEYS = ["agent", "task", "model", "tools", "skills", "thinking", "maxTurns", "timeoutMs"];

test("SubagentParams schema top-level keys match the hand-written validator's known fields", () => {
  assert.deepStrictEqual(
    Object.keys(SubagentParams.properties).sort(),
    [...EXPECTED_TOP_LEVEL_KEYS].sort(),
  );
});

test("SubagentParams schema requires exactly agent and task", () => {
  assert.deepStrictEqual([...SubagentParams.required].sort(), ["agent", "task"]);
});

// Same drift guard for the job tool: the schema the model sees, the seven
// action names extensions/index.ts dispatches on, and the description all
// have to describe one shape.
test("SubagentJobParams schema exposes exactly action/id/message and requires action", () => {
  assert.deepStrictEqual(Object.keys(SubagentJobParams.properties), ["action", "id", "message"]);
  assert.deepStrictEqual([...SubagentJobParams.required], ["action"]);
});
