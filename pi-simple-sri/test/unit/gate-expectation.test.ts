import { test } from "node:test";
import assert from "node:assert/strict";
import { CASE_CHECK_KINDS } from "../../src/checks.ts";
import { hashOfArguments } from "../../src/evidence.ts";
import { evaluateExpectation, isIntrinsicFailure } from "../../src/gate/expectation.ts";
import { sha256Digest } from "../../src/hash.ts";
import type { CaseCheck } from "../../src/checks.ts";
import type { Expectation, ReplayItem } from "../../src/types.ts";
import type { ReplayRun, ReplayRunRequest, ReplayToolCall } from "../../src/gate/types.ts";

// The mechanical evaluator of the gate (Q18, OA2, OA3, OA7): a completed run and the expectation of its item
// in, one verdict out. Every run here is a literal the suite builds -- no process, no stream, no clock --
// because the reading is a function of the record and nothing else.

const SKILL_NAME = "demo-skill";
const MODEL = "opencode-go/deepseek-v4.1-flash";
const PROMPT = "read the file missing-probe.txt and tell me what it says";
const CWD = "/work/reports";
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

// Two real digests of arguments, computed with the package's own rule: the repetition of a call is equality of
// these values, so a test cannot fake it with a string that only looks like a digest.
const ARGS_READ = hashOfArguments({ path: "missing-probe.txt" });
const ARGS_OTHER = hashOfArguments({ path: "another-probe.txt" });

// An argsHash of "" is what the runner records for a tool result whose call is not in the stream: the
// arguments are unknown. A real digest always starts with "sha256:", so the two can never be confused.
const UNKNOWN_ARGS = "";

const TOOL_ERROR: Expectation = { class: "tool_error", version: 1, tool: "read" };
const RETRY_LOOP: Expectation = { class: "retry_loop", version: 1, tool: "read" };
const CORRECTION: Expectation = { class: "user_correction", version: 1 };

// M1c: the fourth class. Its condition is a list of predicates over the final answer of the turn, so a test of it
// writes the checks it is about and the answer they are read against.
const DEFECT: Expectation = {
  class: "quality_defect",
  version: 1,
  checks: [
    { kind: "contains", value: "PROBE-OK" },
    { kind: "not-contains", value: "--squash-all" },
  ],
};

// The answer a replayed turn ended with. Only the fourth class reads it, and its tests are the ones that write it; the
// default is a non-empty answer, so a turn that said nothing is a case a test has to ask for.
const ANSWER = "PROBE-OK";

function defect(checks: readonly CaseCheck[]): Expectation {
  return { class: "quality_defect", version: 1, checks };
}

function request(overrides: Partial<ReplayRunRequest> = {}): ReplayRunRequest {
  return {
    item: 0,
    rep: 1,
    arm: "incumbent",
    prompt: PROMPT,
    skillName: SKILL_NAME,
    skillDirs: [`/staging/arms/incumbent/${SKILL_NAME}`],
    cwd: CWD,
    model: MODEL,
    timeoutMs: 180_000,
    ...overrides,
  };
}

// The run the executor hands over. `pass` here means "the process answered and the stream is usable", the
// only verdict the runner can prove on its own; every field is a parameter of the reading, so a test writes
// the one it is about and leaves the rest at a passing default.
function run(overrides: Partial<ReplayRun> = {}): ReplayRun {
  return {
    request: request(),
    outcome: "pass",
    stopReason: "stop",
    toolCalls: [],
    finalText: ANSWER,
    usage: { input: 10, output: 2 },
    durationMs: 0,
    exitCode: 0,
    skillLoaded: true,
    rawStream: "",
    ...overrides,
  };
}

function call(toolName: string, isError: boolean, argsHash: string = ARGS_READ): ReplayToolCall {
  return { toolName, isError, argsHash };
}

function item(expectation: Expectation, failureSignature = sha256Digest("ev-00000001")): ReplayItem {
  return { prompt: PROMPT, cwd: CWD, expectation, failureSignature };
}

test("evaluateExpectation: a tool class passes when the failing tool is invoked again and does not fail", () => {
  // OA2, first branch: the loop is repeated in the replay and the repetition does not error.
  const verdict = evaluateExpectation(TOOL_ERROR, run({ toolCalls: [call("read", false), call("read", false)] }));

  assert.equal(verdict.outcome, "pass");
  assert.equal(verdict.invalidReason, undefined);
});

test("evaluateExpectation: not re-invoking the tool is a pass, never an invalid run (OA2)", () => {
  // OA2, second branch: the turn ended normally without repeating the failure. `tool-not-reinvoked` does not
  // exist as a reason, so the run is judged and it passes.
  const verdict = evaluateExpectation(TOOL_ERROR, run({ toolCalls: [] }));

  assert.equal(verdict.outcome, "pass");
  assert.equal(verdict.invalidReason, undefined);
});

test("evaluateExpectation: an isError of the named tool is a fail of that run (OA3)", () => {
  const verdict = evaluateExpectation(TOOL_ERROR, run({ toolCalls: [call("read", true)] }));

  assert.equal(verdict.outcome, "fail");
  // A run that showed the failure is counted, not discarded: invalid is reserved for infrastructure.
  assert.equal(verdict.invalidReason, undefined);
});

test("evaluateExpectation: an isError of another tool is not the failure the item measures", () => {
  // The expectation names the tool it watches. A bash that failed in the same turn says nothing about the read
  // the lesson is about, and the item is judged on the call it names.
  const verdict = evaluateExpectation(TOOL_ERROR, run({ toolCalls: [call("bash", true), call("read", false)] }));

  assert.equal(verdict.outcome, "pass");
});

test("evaluateExpectation: the last stop reason decides whether the turn ended", () => {
  // OA2 asks for a turn that ends; `error` and `aborted` are the two reasons that say it did not.
  const cases: readonly { stopReason: string | null; outcome: string }[] = [
    { stopReason: "stop", outcome: "pass" },
    { stopReason: "toolUse", outcome: "pass" },
    { stopReason: null, outcome: "pass" },
    { stopReason: "error", outcome: "fail" },
    { stopReason: "aborted", outcome: "fail" },
  ];

  for (const expected of cases) {
    const verdict = evaluateExpectation(TOOL_ERROR, run({ stopReason: expected.stopReason }));
    assert.equal(verdict.outcome, expected.outcome, `stopReason ${expected.stopReason}`);
  }
});

test("evaluateExpectation: a user_correction passes with a normal stop and no tool error", () => {
  const verdict = evaluateExpectation(CORRECTION, run({ stopReason: "stop", toolCalls: [] }));

  assert.equal(verdict.outcome, "pass");
});

test("evaluateExpectation: a user_correction does not pass when the answer did not finish on its own", () => {
  // Stricter than a tool class on purpose: the class is "the user does not correct the model again", and a turn
  // cut short, or one still waiting for a tool, is not an answer.
  for (const stopReason of ["length", "toolUse", "error", "aborted", null]) {
    const verdict = evaluateExpectation(CORRECTION, run({ stopReason }));
    assert.equal(verdict.outcome, "fail", `stopReason ${stopReason}`);
  }
});

test("evaluateExpectation: a user_correction fails on any tool error of the turn", () => {
  const verdict = evaluateExpectation(CORRECTION, run({ toolCalls: [call("bash", true)] }));

  assert.equal(verdict.outcome, "fail");
});

test("evaluateExpectation: a retry loop is counted by argsHash and a call without arguments never joins one", () => {
  // The digests are the package's own, and the empty one is distinguishable from them: that is what lets the
  // record show the same call twice (OA2, Q1) without ever grouping an unjoinable result with a real call.
  assert.match(ARGS_READ, HASH_PATTERN);
  assert.match(ARGS_OTHER, HASH_PATTERN);
  assert.notEqual(ARGS_READ, ARGS_OTHER);
  assert.equal(HASH_PATTERN.test(UNKNOWN_ARGS), false);

  // The same call repeated and not failing: the loop the item names stopped failing.
  const repeated = evaluateExpectation(
    RETRY_LOOP,
    run({ toolCalls: [call("read", false, ARGS_READ), call("read", false, ARGS_READ)] }),
  );
  assert.equal(repeated.outcome, "pass");

  // The same call repeated and failing on the second attempt: the loop reproduced its failure.
  const failingAgain = evaluateExpectation(
    RETRY_LOOP,
    run({ toolCalls: [call("read", false, ARGS_READ), call("read", true, ARGS_READ)] }),
  );
  assert.equal(failingAgain.outcome, "fail");

  // A result whose arguments are unknown is not comparable, so it is never grouped with a real call; the error
  // it reports is still an error of the named tool and is never dropped for having no digest.
  const unknownArguments = evaluateExpectation(RETRY_LOOP, run({ toolCalls: [call("read", true, UNKNOWN_ARGS)] }));
  assert.equal(unknownArguments.outcome, "fail");

  // Two different calls, neither failing: nothing to reproduce.
  const differentCalls = evaluateExpectation(
    RETRY_LOOP,
    run({ toolCalls: [call("read", false, ARGS_READ), call("read", false, ARGS_OTHER)] }),
  );
  assert.equal(differentCalls.outcome, "pass");
});

test("evaluateExpectation: a quality_defect passes when every check passes over the answer", () => {
  // M1c: the truth of the case is a text, so the run is judged on the final answer of the turn and nothing else.
  const verdict = evaluateExpectation(DEFECT, run({ finalText: `El archivo no existe. ${ANSWER}` }));

  assert.equal(verdict.outcome, "pass");
  // Nothing failed, so the verdict names no failure at all: an empty list and an absent one are two readings, and the
  // record shows the absent one.
  assert.equal(verdict.checkFailures, undefined);
});

test("evaluateExpectation: a check that does not pass fails the run with its own coordinates", () => {
  // The answer carries the token and also the flag the case forbids: the second check is the one that failed, and it
  // names the position and the kind the bank gave it.
  const verdict = evaluateExpectation(DEFECT, run({ finalText: `${ANSWER} --squash-all` }));

  assert.equal(verdict.outcome, "fail");
  assert.deepEqual(verdict.checkFailures, ["1:not-contains"]);

  // A regex that does not match and a substring that must not be there are read the same way: the list is every check
  // that did not pass, in the order of the item.
  const both = evaluateExpectation(
    defect([
      { kind: "regex", pattern: "^PROBE-OK$" },
      { kind: "not-contains", value: ANSWER },
    ]),
    run({ finalText: `${ANSWER} de mas` }),
  );

  assert.equal(both.outcome, "fail");
  assert.deepEqual(both.checkFailures, ["0:regex", "1:not-contains"]);
});

test("evaluateExpectation: an isError in any tool fails a quality_defect whatever the answer says", () => {
  // The predicate is the condition of the case and not a pardon: a turn that broke a tool did not answer, so a check
  // that matches its text must never count it as evidence that the defect is gone.
  const verdict = evaluateExpectation(DEFECT, run({ finalText: ANSWER, toolCalls: [call("bash", true)] }));

  assert.equal(verdict.outcome, "fail");
  // The class watches no tool, so every call of the turn counts, not only the ones of a named tool.
  assert.equal(verdict.checkFailures, undefined);

  // And an error of a call whose arguments are unknown counts the same: the mark is the error, never the digest.
  const unknownArguments = evaluateExpectation(
    DEFECT,
    run({ finalText: ANSWER, toolCalls: [call("read", true, UNKNOWN_ARGS)] }),
  );
  assert.equal(unknownArguments.outcome, "fail");
});

test("evaluateExpectation: a turn with no answer fails with its own coordinate (M1c)", () => {
  // The vacuous pass this closes: `not-contains` over "" passes because "" does not contain the needle, so a turn
  // nobody answered would have counted as a corrected defect.
  const vacuous = defect([{ kind: "not-contains", value: "--squash-all" }]);

  const empty = evaluateExpectation(vacuous, run({ finalText: "" }));
  assert.equal(empty.outcome, "fail");
  assert.deepEqual(empty.checkFailures, ["0:no-text"]);

  // Whitespace is not an answer either: a blank line says as little as nothing.
  const blank = evaluateExpectation(vacuous, run({ finalText: " \n\t " }));
  assert.equal(blank.outcome, "fail");
  assert.deepEqual(blank.checkFailures, ["0:no-text"]);

  // The coordinate is not one of the four kinds src/checks.ts executes, so a reader can never read the turn that said
  // nothing as a check that failed.
  const kinds: readonly string[] = CASE_CHECK_KINDS;
  assert.equal(kinds.includes("no-text"), false);
});

test("evaluateExpectation: a defect that carries no predicate cannot pass", () => {
  // src/diagnosis.ts refuses to build such an item, so this is the guard that keeps a hand-written record from reading
  // as a pass: asserting nothing is not asserting a pass. Emptiness stays a property of the value and not of the type
  // (M2, S5: the branch requires the list, and a list is not a tuple), which is why the guard is still here.
  const verdict = evaluateExpectation({ class: "quality_defect", version: 1, checks: [] }, run({ finalText: ANSWER }));

  assert.equal(verdict.outcome, "fail");
  assert.equal(verdict.checkFailures, undefined);
});

test("evaluateExpectation: an invalid run wins over any other reading", () => {
  // OA3: the runner already decided the run proved nothing, and its reason is the one the record keeps. The
  // calls below would read as a pass; a killed run is not a pass.
  const timeout = evaluateExpectation(
    TOOL_ERROR,
    run({ outcome: "invalid", invalidReason: "timeout", toolCalls: [call("read", false)] }),
  );

  assert.equal(timeout.outcome, "invalid");
  assert.equal(timeout.invalidReason, "timeout");

  // A run the runner refused without naming a reason is still invalid: the evaluator does not invent one.
  const anonymous = evaluateExpectation(TOOL_ERROR, run({ outcome: "invalid" }));
  assert.equal(anonymous.outcome, "invalid");
  assert.equal(anonymous.invalidReason, undefined);

  // And an invalid run of a correction is invalid too: the class never upgrades a broken run.
  assert.equal(evaluateExpectation(CORRECTION, run({ outcome: "invalid", invalidReason: "exit-code" })).outcome, "invalid");

  // The fourth class neither: a run nobody can read has no answer to read, so it produces no check failure at all.
  const defectInvalid = evaluateExpectation(
    DEFECT,
    run({ outcome: "invalid", invalidReason: "stream-unparseable", finalText: ANSWER }),
  );
  assert.equal(defectInvalid.outcome, "invalid");
  assert.equal(defectInvalid.invalidReason, "stream-unparseable");
  assert.equal(defectInvalid.checkFailures, undefined);
});

test("evaluateExpectation: the verdict carries the coordinates and the cost of the run", () => {
  // The scorer aggregates verdicts and never re-reads a stream, so the whole verdict is asserted: a field added
  // to RunVerdict breaks this test instead of travelling unnoticed.
  const verdict = evaluateExpectation(
    TOOL_ERROR,
    run({
      request: request({ item: 2, rep: 2, arm: "candidate" }),
      toolCalls: [call("read", false)],
      usage: { input: 120, output: 30 },
    }),
  );

  assert.deepEqual(verdict, {
    item: 2,
    rep: 2,
    arm: "candidate",
    outcome: "pass",
    usage: { input: 120, output: 30 },
  });
});

test("isIntrinsicFailure: the closed list, only for the tools that read (OA7)", () => {
  const read = item({ class: "tool_error", version: 1, tool: "read" });
  const correction = item(CORRECTION);

  // Every marker of the closed list excludes the item when the failing tool is one of the readers.
  assert.equal(isIntrinsicFailure(read, "read missing-probe.txt: ENOENT: no such file or directory"), true);
  assert.equal(isIntrinsicFailure(read, "grep: No such file or directory: missing-probe.txt"), true);
  assert.equal(isIntrinsicFailure(read, "the path ./missing-probe.txt does not exist"), true);
  assert.equal(isIntrinsicFailure(read, "Path not found: missing-probe.txt"), true);
  for (const tool of ["grep", "find", "ls"]) {
    assert.equal(isIntrinsicFailure(item({ class: "tool_error", version: 1, tool }), "ENOENT"), true, tool);
  }

  // The same text under a tool that writes is not intrinsic: a wrong path in an edit is worth a lesson, and
  // excluding it would hide exactly the failures the gate exists to measure.
  for (const tool of ["bash", "edit", "write", "web_fetch"]) {
    assert.equal(isIntrinsicFailure(item({ class: "tool_error", version: 1, tool }), "ENOENT"), false, tool);
  }

  // A correction has no tool, and an excerpt nobody has is not an intrinsic failure: both keep the item.
  assert.equal(isIntrinsicFailure(correction, "ENOENT"), false);
  assert.equal(isIntrinsicFailure(read, undefined), false);

  // The list is closed and the match is exact: a marker spelled otherwise is replayed, never guessed into the
  // list from here.
  assert.equal(isIntrinsicFailure(read, "enoent: missing-probe.txt"), false);
  assert.equal(isIntrinsicFailure(read, "the tool returned an error"), false);
  assert.equal(isIntrinsicFailure(read, ""), false);

  // M3c: the two markers of a permission the machine refuses, measured by the humo that planned a gate with two
  // of them. The tool still decides: the same sentence under a `write` is replayed, because a skill can name a
  // path the machine allows.
  assert.equal(
    isIntrinsicFailure(read, "EACCES: permission denied, access '/tmp/sri-humo-m3c/sellado/pedido-3.md'"),
    true,
  );
  assert.equal(isIntrinsicFailure(item({ class: "tool_error", version: 1, tool: "ls" }), "permission denied"), true);
  for (const tool of ["bash", "edit", "write"]) {
    assert.equal(isIntrinsicFailure(item({ class: "tool_error", version: 1, tool }), "EACCES"), false, tool);
  }
  // The spelling is the one the tools of this package emit, and the list is exact: another case is replayed.
  assert.equal(isIntrinsicFailure(read, "PERMISSION DENIED"), false);
});
