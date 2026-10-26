import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SUBAGENT_BASE_DESCRIPTION,
  SUBAGENT_JOB_DESCRIPTION,
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

// Interventions moved from the /subagents command line to the subagent_job
// tool: the base description names that tool, allows interventions with no
// per-job cap, and keeps a settled job unreachable.
test("SUBAGENT_BASE_DESCRIPTION: interventions go through subagent_job with no per-job cap, with settled jobs unreachable", () => {
  assert.match(SUBAGENT_BASE_DESCRIPTION, /`subagent_job` tool/);
  assert.match(SUBAGENT_BASE_DESCRIPTION, /no per-job cap/i);
  assert.match(SUBAGENT_BASE_DESCRIPTION, /read-only and always allowed/i);
  assert.match(SUBAGENT_BASE_DESCRIPTION, /already settled can no longer be messaged/i);
  // The old self-imposed restriction is gone.
  assert.doesNotMatch(SUBAGENT_BASE_DESCRIPTION, /only when the user explicitly asks/i);
  // The retired one-intervention cap and the tool's refusal are gone with it.
  assert.doesNotMatch(SUBAGENT_BASE_DESCRIPTION, /once per job/i);
  assert.doesNotMatch(SUBAGENT_BASE_DESCRIPTION, /refuses/i);
});

// Pins the retry/continue nuance to its current wording: recorded params
// when the launch acknowledgment persisted them, agent defaults otherwise.
test("SUBAGENT_BASE_DESCRIPTION: retry/continue relaunch recorded params when persisted, agent defaults otherwise", () => {
  assert.match(SUBAGENT_BASE_DESCRIPTION, /`subagent_job` action `retry`/);
  assert.match(SUBAGENT_BASE_DESCRIPTION, /with action `continue`/);
  assert.match(
    SUBAGENT_BASE_DESCRIPTION,
    /both relaunch with the original call's recorded parameters when the launch acknowledgment persisted them, and with the agent's own defaults otherwise/,
  );
  // The replaced sentence must stay gone.
  assert.doesNotMatch(SUBAGENT_BASE_DESCRIPTION, /overrides are not carried over/);
  // Both old "user explicitly asks" clauses stay gone.
  assert.doesNotMatch(SUBAGENT_BASE_DESCRIPTION, /both are allowed only when the user explicitly asks/);
  assert.doesNotMatch(SUBAGENT_BASE_DESCRIPTION, /never retry or continue/i);
});

// The job tool's own description is what the model reads when it decides
// between a read-only look and an intervention.
test("SUBAGENT_JOB_DESCRIPTION: names all seven actions and the unlimited-intervention rule", () => {
  for (const action of ["status", "list", "cancel", "steer", "followUp", "retry", "continue"]) {
    assert.ok(SUBAGENT_JOB_DESCRIPTION.includes(action), `expected the action ${action} in the description`);
  }
  assert.match(SUBAGENT_JOB_DESCRIPTION, /no per-job cap/i);
  assert.match(SUBAGENT_JOB_DESCRIPTION, /read-only and always allowed/i);
  assert.match(SUBAGENT_JOB_DESCRIPTION, /subagent tool/);
  // The retired cap and the refusal sentence are gone.
  assert.doesNotMatch(SUBAGENT_JOB_DESCRIPTION, /once per job/i);
  assert.doesNotMatch(SUBAGENT_JOB_DESCRIPTION, /refused/i);
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
