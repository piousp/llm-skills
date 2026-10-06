import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SUBAGENT_BASE_DESCRIPTION,
  buildSubagentToolDescription,
} from "../../src/tool-description.ts";

test("buildSubagentToolDescription: no agents returns the base description unchanged", () => {
  const result = buildSubagentToolDescription([]);

  assert.equal(result, SUBAGENT_BASE_DESCRIPTION);
});

test("SUBAGENT_BASE_DESCRIPTION: tells the model it's backgrounded and not to poll", () => {
  assert.match(SUBAGENT_BASE_DESCRIPTION, /background/i);
  assert.match(SUBAGENT_BASE_DESCRIPTION, /job id/i);
  assert.match(SUBAGENT_BASE_DESCRIPTION, /delivered later/i);
  assert.match(SUBAGENT_BASE_DESCRIPTION, /do not call this tool again to poll/i);
  assert.match(SUBAGENT_BASE_DESCRIPTION, /\/subagents/);
});

test("SUBAGENT_BASE_DESCRIPTION: tells the model to call once per task for concurrency, with no leftover parallel-mode wording", () => {
  assert.match(SUBAGENT_BASE_DESCRIPTION, /once per task/i);
  assert.doesNotMatch(SUBAGENT_BASE_DESCRIPTION, /\btasks\b/);
  assert.doesNotMatch(SUBAGENT_BASE_DESCRIPTION, /one or more/i);
});

test("buildSubagentToolDescription: single agent appends an available-agents section", () => {
  const result = buildSubagentToolDescription([{ name: "scout", description: "Finds things" }]);

  assert.equal(
    result,
    `${SUBAGENT_BASE_DESCRIPTION}\n\nAvailable agents:\n- scout: Finds things`,
  );
});

test("buildSubagentToolDescription: agents are listed in alphabetical order regardless of input order", () => {
  const result = buildSubagentToolDescription([
    { name: "zebra", description: "Z agent" },
    { name: "alpha", description: "A agent" },
  ]);

  assert.equal(
    result,
    `${SUBAGENT_BASE_DESCRIPTION}\n\nAvailable agents:\n- alpha: A agent\n- zebra: Z agent`,
  );
});

test("buildSubagentToolDescription: only outer whitespace is trimmed from a description", () => {
  const result = buildSubagentToolDescription([{ name: "scout", description: "  multi\nline  " }]);

  assert.equal(
    result,
    `${SUBAGENT_BASE_DESCRIPTION}\n\nAvailable agents:\n- scout: multi\nline`,
  );
});

test("buildSubagentToolDescription: a description that is empty after trimming still renders its line", () => {
  const result = buildSubagentToolDescription([{ name: "scout", description: "   " }]);

  assert.equal(
    result,
    `${SUBAGENT_BASE_DESCRIPTION}\n\nAvailable agents:\n- scout: `,
  );
});

test("buildSubagentToolDescription: a non-string description (e.g. from an unvalidated agentOverrides JSON value) does not throw and renders as empty", () => {
  const result = buildSubagentToolDescription([
    { name: "scout", description: 42 as unknown as string },
  ]);

  assert.equal(
    result,
    `${SUBAGENT_BASE_DESCRIPTION}\n\nAvailable agents:\n- scout: `,
  );
});
