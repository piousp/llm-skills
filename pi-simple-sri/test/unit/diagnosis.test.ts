import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildDiagnosis, SriDiagnosisError } from "../../src/diagnosis.ts";
import type { EvidenceContext } from "../../src/evidence.ts";
import type { EvidenceItem, EvidenceKind, SkillRef } from "../../src/types.ts";

const SKILL: SkillRef = {
  name: "pdf-tools",
  description: "Extract tables from PDFs",
  dir: "/skills/pdf-tools",
  realDir: "/skills/pdf-tools",
  hasLessons: false,
  kind: "declared",
};
const CWD = "/work/reports";
const MODEL = "claude-sonnet-4-5";
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

function evidenceItem(id: string, kind: EvidenceKind, toolName?: string): EvidenceItem {
  const item: EvidenceItem = { id, kind, timestamp: 1_762_082_602_481, source: "transcript" };
  if (toolName !== undefined) item.toolName = toolName;
  return item;
}

function contextsOf(entries: [string, EvidenceContext][]): ReadonlyMap<string, EvidenceContext> {
  return new Map(entries);
}

// The documented rule, computed independently: sha256 over the sorted ids joined by a newline.
function expectedSignature(ids: readonly string[]): string {
  const material = [...ids].sort().join("\n");
  return `sha256:${createHash("sha256").update(material, "utf8").digest("hex")}`;
}

test("buildDiagnosis: zero evidence throws instead of inventing a diagnosis", () => {
  assert.throws(
    () => buildDiagnosis([], contextsOf([]), SKILL, CWD),
    (error: unknown) => error instanceof SriDiagnosisError,
  );
});

test("buildDiagnosis: the failure signature names the set of evidence ids", () => {
  const first = evidenceItem("ev-00000001", "tool_error", "bash");
  const second = evidenceItem("ev-00000002", "tool_error", "bash");
  const contextById = contextsOf([
    ["ev-00000001", { prompt: "extract the table" }],
    ["ev-00000002", { prompt: "extract the table" }],
  ]);

  const diagnosis = buildDiagnosis([first, second], contextById, SKILL, CWD);

  assert.match(diagnosis.failureSignature, HASH_PATTERN);
  assert.equal(diagnosis.failureSignature, expectedSignature(["ev-00000001", "ev-00000002"]));
});

test("buildDiagnosis: the signature is stable for the same set and changes with another one", () => {
  const first = evidenceItem("ev-00000001", "tool_error", "bash");
  const second = evidenceItem("ev-00000002", "tool_error", "bash");
  const other = evidenceItem("ev-00000003", "tool_error", "bash");
  const contextById = contextsOf([
    ["ev-00000001", { prompt: "extract the table" }],
    ["ev-00000002", { prompt: "extract the table" }],
    ["ev-00000003", { prompt: "extract the table" }],
  ]);

  const inOrder = buildDiagnosis([first, second], contextById, SKILL, CWD).failureSignature;
  const reversed = buildDiagnosis([second, first], contextById, SKILL, CWD).failureSignature;
  const different = buildDiagnosis([first, other], contextById, SKILL, CWD).failureSignature;

  assert.equal(inOrder, reversed);
  assert.notEqual(inOrder, different);
});

test("buildDiagnosis: a tool_error replay item carries the prompt, the cwd, the model and the tool predicate", () => {
  const error = evidenceItem("ev-3f9a1c02", "tool_error", "bash");
  const contextById = contextsOf([
    ["ev-3f9a1c02", { prompt: "extract the merged-cell table", assistantCycleIndex: 2 }],
  ]);

  const diagnosis = buildDiagnosis([error], contextById, SKILL, CWD, { model: MODEL });

  assert.deepEqual(diagnosis.replayItems, [
    {
      prompt: "extract the merged-cell table",
      cwd: CWD,
      predicate: "the tool bash does not return an error again",
      skills: ["pdf-tools"],
      failureSignature: expectedSignature(["ev-3f9a1c02"]),
      model: MODEL,
      assistantCycleIndex: 2,
      failingToolCall: "bash",
    },
  ]);
});

// Nothing is invented: the optional fields appear only when the caller had the value.
test("buildDiagnosis: a replay item without a model and without a cycle index omits both", () => {
  const error = evidenceItem("ev-3f9a1c02", "tool_error", "bash");
  const contextById = contextsOf([["ev-3f9a1c02", { prompt: "extract the table" }]]);

  const [replayItem] = buildDiagnosis([error], contextById, SKILL, CWD).replayItems;

  assert.equal("model" in replayItem, false);
  assert.equal("assistantCycleIndex" in replayItem, false);
  assert.equal(replayItem.failingToolCall, "bash");
});

test("buildDiagnosis: a failure without a prompt produces no replay item", () => {
  const withPrompt = evidenceItem("ev-00000001", "tool_error", "bash");
  const withoutPrompt = evidenceItem("ev-00000002", "tool_error", "bash");
  const contextById = contextsOf([["ev-00000001", { prompt: "extract the table" }]]);

  const diagnosis = buildDiagnosis([withPrompt, withoutPrompt], contextById, SKILL, CWD);

  assert.deepEqual(
    diagnosis.replayItems.map((item) => item.prompt),
    ["extract the table"],
  );
});

// M5: the prompt filter runs before the class priority. A tool error that cannot be replayed must
// not displace a correction that can, and once both can be replayed the tool error wins again.
test("buildDiagnosis: a replayable correction survives a tool_error without a prompt", () => {
  const errorWithoutPrompt = evidenceItem("ev-00000010", "tool_error", "bash");
  const errorWithPrompt = evidenceItem("ev-00000011", "tool_error", "read");
  const correction = evidenceItem("ev-00000012", "user_correction", "bash");
  const contextById = contextsOf([
    ["ev-00000011", { prompt: "extract the table" }],
    ["ev-00000012", { prompt: "no, the table is on page 4", assistantCycleIndex: 0 }],
  ]);

  const onlyCorrection = buildDiagnosis([errorWithoutPrompt, correction], contextById, SKILL, CWD);
  assert.deepEqual(
    onlyCorrection.replayItems.map((item) => item.predicate),
    ["the user does not correct the model again"],
  );

  const both = buildDiagnosis([errorWithoutPrompt, errorWithPrompt, correction], contextById, SKILL, CWD);
  assert.deepEqual(
    both.replayItems.map((item) => item.predicate),
    ["the tool read does not return an error again"],
  );
});

test("buildDiagnosis: a whitespace-only prompt is no prompt", () => {
  const error = evidenceItem("ev-00000001", "tool_error", "bash");
  const contextById = contextsOf([["ev-00000001", { prompt: "   " }]]);

  assert.throws(
    () => buildDiagnosis([error], contextById, SKILL, CWD),
    (thrown: unknown) => thrown instanceof SriDiagnosisError,
  );
});

test("buildDiagnosis: retry loops are replayed only when there is no tool error", () => {
  const retryLoop = evidenceItem("ev-00000003", "retry_loop", "bash");
  const toolError = evidenceItem("ev-00000004", "tool_error", "bash");
  const contextById = contextsOf([
    ["ev-00000003", { prompt: "extract the table" }],
    ["ev-00000004", { prompt: "extract the table" }],
  ]);

  const onlyRetryLoop = buildDiagnosis([retryLoop], contextById, SKILL, CWD);
  assert.deepEqual(
    onlyRetryLoop.replayItems.map((item) => item.predicate),
    ["the tool bash does not return an error again"],
  );

  const both = buildDiagnosis([toolError, retryLoop], contextById, SKILL, CWD);
  assert.equal(both.replayItems.length, 1);
  assert.equal(both.replayItems[0].failureSignature, expectedSignature(["ev-00000004"]));
});

test("buildDiagnosis: a user correction is replayed with the user predicate", () => {
  const correction = evidenceItem("ev-00000005", "user_correction", "bash");
  const contextById = contextsOf([["ev-00000005", { prompt: "extract the table", assistantCycleIndex: 0 }]]);

  const diagnosis = buildDiagnosis([correction], contextById, SKILL, CWD);

  assert.deepEqual(
    diagnosis.replayItems.map((item) => item.predicate),
    ["the user does not correct the model again"],
  );
});

test("buildDiagnosis: the summary names the tool and the failure classes present", () => {
  const items = [
    evidenceItem("ev-00000006", "tool_error", "bash"),
    evidenceItem("ev-00000007", "user_correction", "bash"),
  ];
  const contextById = contextsOf([["ev-00000006", { prompt: "extract the table" }]]);

  const diagnosis = buildDiagnosis(items, contextById, SKILL, CWD);

  assert.equal(diagnosis.summary, 'Observed 1 tool error and 1 user correction in this session for tool "bash".');
});

test("buildDiagnosis: the summary lists the tools in a stable order", () => {
  const items = [
    evidenceItem("ev-00000009", "retry_loop", "read"),
    evidenceItem("ev-00000008", "tool_error", "bash"),
  ];
  const contextById = contextsOf([["ev-00000008", { prompt: "extract the table" }]]);

  const diagnosis = buildDiagnosis(items, contextById, SKILL, CWD);

  assert.equal(
    diagnosis.summary,
    'Observed 1 tool error and 1 retry loop in this session for tools "bash", "read".',
  );
});

// Every label in the class table pluralizes with "s"; a count above one is the only way to see it.
test("buildDiagnosis: the summary pluralizes a count above one", () => {
  const items = [
    evidenceItem("ev-00000020", "tool_error", "bash"),
    evidenceItem("ev-00000021", "tool_error", "bash"),
  ];
  const contextById = contextsOf([
    ["ev-00000020", { prompt: "extract the table" }],
    ["ev-00000021", { prompt: "extract the table" }],
  ]);

  const diagnosis = buildDiagnosis(items, contextById, SKILL, CWD);

  assert.equal(diagnosis.summary, 'Observed 2 tool errors in this session for tool "bash".');
});

// The class table is also the order the summary names the classes in: the strongest failure first.
test("buildDiagnosis: the summary lists every class present in priority order", () => {
  const items = [
    evidenceItem("ev-00000030", "user_correction", "bash"),
    evidenceItem("ev-00000031", "retry_loop", "bash"),
    evidenceItem("ev-00000032", "tool_error", "bash"),
  ];
  const contextById = contextsOf([["ev-00000032", { prompt: "extract the table" }]]);

  const diagnosis = buildDiagnosis(items, contextById, SKILL, CWD);

  assert.equal(
    diagnosis.summary,
    'Observed 1 tool error, 1 retry loop and 1 user correction in this session for tool "bash".',
  );
});

// M5 sibling: an item that yields no predicate is as unreplayable as one without a prompt, so it
// must not shadow a weaker class that can be replayed.
test("buildDiagnosis: a tool_error without a tool name does not shadow a replayable correction", () => {
  const namelessError = evidenceItem("ev-00000030", "tool_error");
  const correction = evidenceItem("ev-00000031", "user_correction");
  const contextById = contextsOf([
    ["ev-00000030", { prompt: "extract the table", assistantCycleIndex: 0 }],
    ["ev-00000031", { prompt: "no, the table is on page 4", assistantCycleIndex: 0 }],
  ]);

  const diagnosis = buildDiagnosis([namelessError, correction], contextById, SKILL, CWD);

  assert.deepEqual(
    diagnosis.replayItems.map((item) => item.predicate),
    ["the user does not correct the model again"],
  );
});
