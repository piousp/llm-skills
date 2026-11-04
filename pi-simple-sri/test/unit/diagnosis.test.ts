import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { attemptSignature } from "../../src/attempts.ts";
import { CASE_BANK_FORMAT, type CaseBank, type CaseBankCase } from "../../src/case-bank.ts";
import type { CaseCheck } from "../../src/checks.ts";
import {
  buildBaselineDiagnosis,
  buildDefectDiagnosis,
  buildDiagnosis,
  describeExpectation,
  expectationViolation,
  SriDiagnosisError,
} from "../../src/diagnosis.ts";
import type { EvidenceContext } from "../../src/evidence.ts";
import type { EvidenceItem, EvidenceKind, Expectation, SkillRef } from "../../src/types.ts";

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

// M1c, S8: the materials of the branch of the defect, as the two files give them -- the evidence read from an artifact and
// the bank whose cases measure it. The bank is a literal because the reader of the format has its own suite: what is under
// test here is the diagnosis built from it.
const DEFECT_CASES: readonly CaseBankCase[] = [
  {
    id: "keeps-history",
    prompt: "rebase the branch onto main",
    checks: [{ kind: "not-contains", value: "--squash-all" }],
  },
  {
    id: "interactive",
    prompt: "rebase the branch onto main and keep both commits",
    checks: [{ kind: "contains", value: "--interactive" }],
  },
];

function defectItem(overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    id: "ev-7d1e2f44",
    kind: "quality_defect",
    timestamp: 1_762_082_602_481,
    source: "persisted",
    excerpt: "the answer used --squash-all",
    origin: {
      kind: "review-finding",
      path: "/work/reports/review.md",
      contentHash: `sha256:${"d".repeat(64)}`,
    },
    ...overrides,
  };
}

function defectBank(cases: readonly CaseBankCase[] = DEFECT_CASES): CaseBank {
  return {
    format: CASE_BANK_FORMAT,
    origin: {
      kind: "review-finding",
      path: "/work/reports/review.md",
      excerpt: "the answer used --squash-all",
    },
    cases,
  };
}

test("buildDiagnosis: zero evidence throws instead of inventing a diagnosis", () => {
  assert.throws(
    () => buildDiagnosis([], contextsOf([]), SKILL, CWD),
    (error: unknown) => error instanceof SriDiagnosisError,
  );
});

// M1c, S7: relaxing the record does not relax the base that needs the items. buildDiagnosis is still the constructor of
// the transcript, and a run of it that cannot replay anything is refused instead of producing an empty diagnosis --
// which is why the diagnosis of the bank is built by its own constructor and not by this one.
test("buildDiagnosis: the base of the transcript still requires a replay item", () => {
  const error = evidenceItem("ev-00000061", "tool_error", "bash");

  // Evidence the diagnosis names and cannot replay: a prompt nobody recorded.
  assert.throws(
    () => buildDiagnosis([error], contextsOf([]), SKILL, CWD),
    (thrown: unknown) => thrown instanceof SriDiagnosisError,
  );

  // The same evidence with its turn is one item, and the guard is what those two answers differ by.
  const replayable = buildDiagnosis([error], contextsOf([["ev-00000061", { prompt: "extract the table" }]]), SKILL, CWD);
  assert.equal(replayable.replayItems.length, 1);
});

// M1c, S7 (OA2): a directional attempt has no failure of this session to point at, so its diagnosis is the ask -- the
// skill and the focus -- and it carries no replay item. It is not built through buildDiagnosis, whose guard belongs to
// the other base, and the signature is the digest of the attempt's own identity.
test("buildBaselineDiagnosis: the diagnosis of a directional attempt names the ask and replays nothing", () => {
  const diagnosis = buildBaselineDiagnosis({ surface: "command", focus: "merged cells" }, SKILL);

  assert.deepEqual(diagnosis, {
    summary: 'Directional improvement of skill "pdf-tools": the focus asked for was "merged cells".',
    failureSignature: attemptSignature("directional_improvement", "pdf-tools", "merged cells"),
    replayItems: [],
  });
});

// The summary is determined by the trigger and never invented: with no focus it says exactly that, instead of filling the
// sentence with a subject the user did not give.
test("buildBaselineDiagnosis: an absent focus is said and not filled in", () => {
  const fromCommand = buildBaselineDiagnosis({ surface: "command", focus: null }, SKILL);
  const fromTool = buildBaselineDiagnosis({ surface: "tool", focus: null }, SKILL);

  assert.equal(fromCommand.summary, 'Directional improvement of skill "pdf-tools": no focus was asked for.');
  assert.deepEqual(fromCommand.replayItems, []);
  // The surface is not part of the sentence, so the two surfaces that can ask for the same thing derive the same
  // diagnosis -- the record already says which of them asked.
  assert.deepEqual(fromTool, fromCommand);
});

// The signature of the ask: two directional attempts that ask for the same thing on the same skill are the same failure
// for a reader of the index, and a different focus or another skill is a different one.
test("buildBaselineDiagnosis: the signature is stable per skill and focus and changes with either", () => {
  const signatureFor = (skillName: string, focus: string | null): string =>
    buildBaselineDiagnosis({ surface: "command", focus }, { ...SKILL, name: skillName }).failureSignature;

  assert.match(signatureFor("pdf-tools", "merged cells"), HASH_PATTERN);
  assert.equal(signatureFor("pdf-tools", "merged cells"), signatureFor("pdf-tools", "merged cells"));
  assert.notEqual(signatureFor("pdf-tools", "merged cells"), signatureFor("pdf-tools", "another focus"));
  assert.notEqual(signatureFor("pdf-tools", "merged cells"), signatureFor("other-skill", "merged cells"));
  // Asking for nothing is one ask and not a wildcard: it has a signature of its own.
  assert.notEqual(signatureFor("pdf-tools", null), signatureFor("pdf-tools", "merged cells"));
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

test("buildDiagnosis: a tool_error replay item carries the prompt, the cwd, the model and the tool expectation", () => {
  const error = evidenceItem("ev-3f9a1c02", "tool_error", "bash");
  const contextById = contextsOf([
    ["ev-3f9a1c02", { prompt: "extract the merged-cell table", assistantCycleIndex: 2 }],
  ]);

  const diagnosis = buildDiagnosis([error], contextById, SKILL, CWD, { model: MODEL });

  assert.deepEqual(diagnosis.replayItems, [
    {
      prompt: "extract the merged-cell table",
      cwd: CWD,
      expectation: { class: "tool_error", version: 1, tool: "bash" },
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

// Q13, OA5: the model of the failing turn wins over the model of the session that runs the
// diagnosis, because what a replay pins is the model that produced the failure.
test("buildDiagnosis: the model of the failing turn wins over the session model", () => {
  const error = evidenceItem("ev-3f9a1c02", "tool_error", "bash");
  const contextById = contextsOf([
    ["ev-3f9a1c02", { prompt: "extract the table", model: "anthropic/claude-opus-4-1" }],
  ]);

  const [replayItem] = buildDiagnosis([error], contextById, SKILL, CWD, { model: "otro/modelo" }).replayItems;

  assert.equal(replayItem.model, "anthropic/claude-opus-4-1");
});

// The fallback exists for a transcript that recorded no AssistantMessage: the item still pins one
// model, and it is the session's, in the same "provider/model" spelling the evidence uses.
test("buildDiagnosis: the session model is the fallback when the context names no model", () => {
  const error = evidenceItem("ev-3f9a1c02", "tool_error", "bash");
  const contextById = contextsOf([["ev-3f9a1c02", { prompt: "extract the table", assistantCycleIndex: 0 }]]);

  const [replayItem] = buildDiagnosis([error], contextById, SKILL, CWD, { model: "openai/gpt-5" }).replayItems;

  assert.equal(replayItem.model, "openai/gpt-5");
  assert.equal(replayItem.assistantCycleIndex, 0);
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
    onlyCorrection.replayItems.map((item) => item.expectation),
    [{ class: "user_correction", version: 1 }],
  );

  const both = buildDiagnosis([errorWithoutPrompt, errorWithPrompt, correction], contextById, SKILL, CWD);
  assert.deepEqual(
    both.replayItems.map((item) => item.expectation),
    [{ class: "tool_error", version: 1, tool: "read" }],
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
    onlyRetryLoop.replayItems.map((item) => item.expectation),
    [{ class: "retry_loop", version: 1, tool: "bash" }],
  );

  const both = buildDiagnosis([toolError, retryLoop], contextById, SKILL, CWD);
  assert.equal(both.replayItems.length, 1);
  assert.equal(both.replayItems[0].failureSignature, expectedSignature(["ev-00000004"]));
});

test("buildDiagnosis: a user correction is replayed with the expectation of its class", () => {
  const correction = evidenceItem("ev-00000005", "user_correction", "bash");
  const contextById = contextsOf([["ev-00000005", { prompt: "extract the table", assistantCycleIndex: 0 }]]);

  const diagnosis = buildDiagnosis([correction], contextById, SKILL, CWD);

  // The tool the evidence carries does not travel with the expectation: what has to stop is the user
  // objecting, and the check watches the turn and not the tool.
  assert.deepEqual(
    diagnosis.replayItems.map((item) => item.expectation),
    [{ class: "user_correction", version: 1 }],
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

// M5 sibling: an item that yields no expectation is as unreplayable as one without a prompt, so it
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
    diagnosis.replayItems.map((item) => item.expectation),
    [{ class: "user_correction", version: 1 }],
  );
});

// S3: the sentence a human reads is derived from the descriptor and is no longer the contract. These three
// cases are the whole text the package can produce from an expectation, worded exactly as the prose
// predicate was: the migration changed where the sentence comes from, not what it says.
test("describeExpectation: a tool class names the tool that must stop failing", () => {
  assert.equal(
    describeExpectation({ class: "tool_error", version: 1, tool: "bash" }),
    "the tool bash does not return an error again",
  );
  // The two tool classes say the same thing because Q18 checks the same thing for both: the tool is
  // invoked again and none of its invocations returned isError.
  assert.equal(
    describeExpectation({ class: "retry_loop", version: 1, tool: "bash" }),
    "the tool bash does not return an error again",
  );
});

test("describeExpectation: a correction is described without a tool", () => {
  assert.equal(
    describeExpectation({ class: "user_correction", version: 1 }),
    "the user does not correct the model again",
  );
  // A correction whose record carries a tool keeps the sentence of its class: the check watches the turn
  // and not the tool, so the name is not part of what the user is told.
  assert.equal(
    describeExpectation({ class: "user_correction", version: 1, tool: "bash" }),
    "the user does not correct the model again",
  );
});

test("describeExpectation: a tool class without a tool name still describes its class", () => {
  // src/diagnosis.ts never writes this shape -- a tool class without a tool name is not replayable -- so
  // the sentence exists for a record written by something else, and it names no tool it does not have.
  assert.equal(
    describeExpectation({ class: "tool_error", version: 1 }),
    "the failing tool does not return an error again",
  );
});

// M1c: the fourth class is a row of the table like the other three, which is what "the table is the only place this
// module names a class" means. EVERY_KIND is the totality device of the block below: a class added to EvidenceKind
// loses a member here and this suite stops compiling, so no test here can go on covering three of four.
const EVERY_KIND: { readonly [K in EvidenceKind]: K } = {
  tool_error: "tool_error",
  retry_loop: "retry_loop",
  user_correction: "user_correction",
  quality_defect: "quality_defect",
};

test("buildDiagnosis: the class table names the fourth class last in the summary", () => {
  const items = [
    evidenceItem("ev-00000041", "quality_defect"),
    evidenceItem("ev-00000042", "user_correction"),
    evidenceItem("ev-00000043", "retry_loop", "bash"),
    evidenceItem("ev-00000044", "tool_error", "bash"),
  ];
  const contextById = contextsOf([
    ["ev-00000041", { prompt: "which flags does git rebase accept" }],
    ["ev-00000042", { prompt: "no, use the interactive mode" }],
    ["ev-00000043", { prompt: "list the flags" }],
    ["ev-00000044", { prompt: "list the flags" }],
  ]);

  const diagnosis = buildDiagnosis(items, contextById, SKILL, CWD);

  assert.equal(
    diagnosis.summary,
    'Observed 1 tool error, 1 retry loop, 1 user correction and 1 quality defect in this session for tool "bash".',
  );
  // The tool error is the strongest class present, and the defect is not replayable from a transcript at all.
  assert.deepEqual(
    diagnosis.replayItems.map((item) => item.expectation.class),
    ["tool_error"],
  );
});

// The predicate of a defect is the list of checks its bank carries, and that list travels with the evidence: an
// expectation built from the class alone would be a condition nobody wrote. The class therefore yields no replay item,
// and a diagnosis over it alone is refused like a diagnosis with nothing replayable.
test("buildDiagnosis: a quality_defect alone yields no replay item", () => {
  const defect = evidenceItem("ev-00000051", "quality_defect");
  const contextById = contextsOf([["ev-00000051", { prompt: "which flags does git rebase accept" }]]);

  assert.throws(
    () => buildDiagnosis([defect], contextById, SKILL, CWD),
    (error: unknown) => error instanceof SriDiagnosisError,
  );
});

// The same reading a tool class without a tool name gets: a class that yields no expectation is unreplayable, and
// being unreplayable does not let it displace a weaker class that can be replayed.
test("buildDiagnosis: a quality_defect does not shadow a replayable correction", () => {
  const defect = evidenceItem("ev-00000052", "quality_defect");
  const correction = evidenceItem("ev-00000053", "user_correction");
  const contextById = contextsOf([
    ["ev-00000052", { prompt: "which flags does git rebase accept" }],
    ["ev-00000053", { prompt: "no, use the interactive mode", assistantCycleIndex: 0 }],
  ]);

  const diagnosis = buildDiagnosis([defect, correction], contextById, SKILL, CWD);

  assert.deepEqual(
    diagnosis.replayItems.map((item) => item.expectation),
    [{ class: "user_correction", version: 1 }],
  );
});

// M1c, S8: the branch of the defect has a constructor of its own, because its items are the cases of a bank and not the
// turns of a session. One item per case, the checks of the case are what the replayed answer is judged by, and every item
// names the one failure the evidence declares -- which is the signature the gate pairs the two by.
test("buildDefectDiagnosis: every case of the bank is one replay item judged by its checks", () => {
  const evidence = defectItem();

  const diagnosis = buildDefectDiagnosis(evidence, defectBank(), SKILL, CWD, MODEL);

  assert.deepEqual(diagnosis, {
    summary:
      'Quality defect of skill "pdf-tools" read from "/work/reports/review.md" ("review-finding"): "the answer used --squash-all".',
    failureSignature: expectedSignature([evidence.id]),
    replayItems: [
      {
        prompt: "rebase the branch onto main",
        cwd: CWD,
        model: MODEL,
        expectation: {
          class: "quality_defect",
          version: 1,
          checks: [{ kind: "not-contains", value: "--squash-all" }],
        },
        skills: [SKILL.name],
        failureSignature: expectedSignature([evidence.id]),
      },
      {
        prompt: "rebase the branch onto main and keep both commits",
        cwd: CWD,
        model: MODEL,
        expectation: {
          class: "quality_defect",
          version: 1,
          checks: [{ kind: "contains", value: "--interactive" }],
        },
        skills: [SKILL.name],
        failureSignature: expectedSignature([evidence.id]),
      },
    ],
  });
});

// The predicate of a case is the list of checks it carries, so a case with no check is a condition nobody wrote: it yields
// no item instead of an expectation src/checks.ts would have nothing to execute for.
test("buildDefectDiagnosis: a case without checks produces no replay item", () => {
  const bank = defectBank([{ id: "keeps-history", prompt: "rebase the branch onto main", checks: [] }, DEFECT_CASES[1]]);

  const diagnosis = buildDefectDiagnosis(defectItem(), bank, SKILL, CWD, MODEL);

  assert.deepEqual(
    diagnosis.replayItems.map((item) => item.prompt),
    ["rebase the branch onto main and keep both commits"],
  );
  // The failure is still the one evidence item, whatever the cases that survived say.
  assert.equal(diagnosis.failureSignature, expectedSignature([defectItem().id]));
});

// The summary is the artifact and its entry, never an invented one: another kind of origin is another sentence, and an
// artifact whose entry was not recorded says exactly that instead of describing a finding nobody wrote.
test("buildDefectDiagnosis: the summary is the origin and is not invented", () => {
  const review = buildDefectDiagnosis(defectItem(), defectBank(), SKILL, CWD);
  const draft = buildDefectDiagnosis(
    defectItem({
      excerpt: "the draft dropped the second commit",
      origin: { kind: "rejected-draft", path: "/work/reports/draft.md", contentHash: `sha256:${"e".repeat(64)}` },
    }),
    defectBank(),
    SKILL,
    CWD,
  );
  const silent = buildDefectDiagnosis(defectItem({ excerpt: undefined }), defectBank(), SKILL, CWD);

  assert.equal(
    review.summary,
    'Quality defect of skill "pdf-tools" read from "/work/reports/review.md" ("review-finding"): "the answer used --squash-all".',
  );
  assert.equal(
    draft.summary,
    'Quality defect of skill "pdf-tools" read from "/work/reports/draft.md" ("rejected-draft"): "the draft dropped the second commit".',
  );
  assert.equal(
    silent.summary,
    'Quality defect of skill "pdf-tools" read from "/work/reports/review.md" ("review-finding"): no entry was recorded.',
  );
  // With no model of the invocation the item pins none, and the gate answers `no-model` instead of inventing one.
  assert.equal(review.replayItems[0].model, undefined);
});

// The constructor belongs to the branch, so evidence of another class -- or a defect with no artifact behind it -- is
// refused instead of being diagnosed as something it is not.
test("buildDefectDiagnosis: evidence that is not a defect read from an artifact is refused", () => {
  assert.throws(
    () => buildDefectDiagnosis(evidenceItem("ev-00000071", "tool_error", "bash"), defectBank(), SKILL, CWD),
    (thrown: unknown) => thrown instanceof SriDiagnosisError,
  );
  assert.throws(
    () => buildDefectDiagnosis(defectItem({ origin: undefined }), defectBank(), SKILL, CWD),
    (thrown: unknown) => thrown instanceof SriDiagnosisError,
  );
});

test("describeExpectation: a quality_defect names the condition of its class", () => {
  assert.equal(
    describeExpectation({
      class: "quality_defect",
      version: 1,
      checks: [{ kind: "not-contains", value: "--squash-all" }],
    }),
    "the answer passes every check the defect carries",
  );
  // The sentence does not read the checks: it says what the answer must satisfy, and the list is data the gate runs.
  // As with the tool class without a tool name above, this package never writes the shape below -- the invariant at the
  // end of this file refuses it -- so the sentence exists for a record written by something else.
  assert.equal(
    describeExpectation({ class: "quality_defect", version: 1 }),
    "the answer passes every check the defect carries",
  );
});

// The two relations between an expectation and its class that the schema cannot state: `tool` is present exactly on
// the two tool classes, and `checks` is present and non-empty exactly on quality_defect. The product is small enough
// to walk whole -- four classes, a tool or none, three shapes of checks -- and walking it whole is the difference
// between a rule and a sample of one.
const TOOLS: readonly (string | undefined)[] = [undefined, "bash"];
const CHECK_SHAPES: readonly (readonly CaseCheck[] | undefined)[] = [
  undefined,
  [],
  [{ kind: "not-contains", value: "--squash-all" }],
];

test("expectationViolation: tool is present exactly on the tool classes and checks exactly on the defect", () => {
  let walked = 0;

  for (const kind of Object.values(EVERY_KIND)) {
    for (const tool of TOOLS) {
      for (const checks of CHECK_SHAPES) {
        const expectation: Expectation = {
          class: kind,
          version: 1,
          ...(tool === undefined ? {} : { tool }),
          ...(checks === undefined ? {} : { checks }),
        };
        const toolClass = kind === "tool_error" || kind === "retry_loop";
        const wantsChecks = kind === "quality_defect";
        const consistent =
          (tool !== undefined) === toolClass && wantsChecks === (checks !== undefined && checks.length > 0);
        const caseName = `${kind}, ${tool === undefined ? "no tool" : "with a tool"}, ${
          checks === undefined ? "no checks" : `${checks.length} checks`
        }`;

        assert.equal(expectationViolation(expectation) === undefined, consistent, caseName);
        walked += 1;
      }
    }
  }

  // Four classes by two tools by three shapes: the walk covered the whole product and not a prefix of it.
  assert.equal(walked, Object.keys(EVERY_KIND).length * TOOLS.length * CHECK_SHAPES.length);
});

test("expectationViolation: names the class and what is missing or extra", () => {
  const check: CaseCheck = { kind: "contains", value: "--interactive" };

  assert.equal(
    expectationViolation({ class: "tool_error", version: 1 }),
    'a "tool_error" expectation needs the name of the failing tool',
  );
  assert.equal(
    expectationViolation({ class: "retry_loop", version: 1 }),
    'a "retry_loop" expectation needs the name of the failing tool',
  );
  assert.equal(
    expectationViolation({ class: "user_correction", version: 1, tool: "bash" }),
    'a "user_correction" expectation names no tool, got "bash"',
  );
  assert.equal(
    expectationViolation({ class: "quality_defect", version: 1, tool: "bash", checks: [check] }),
    'a "quality_defect" expectation names no tool, got "bash"',
  );
  assert.equal(
    expectationViolation({ class: "quality_defect", version: 1 }),
    'a "quality_defect" expectation needs at least one check',
  );
  assert.equal(
    expectationViolation({ class: "quality_defect", version: 1, checks: [] }),
    'a "quality_defect" expectation needs at least one check',
  );
  assert.equal(
    expectationViolation({ class: "tool_error", version: 1, tool: "bash", checks: [check] }),
    'a "tool_error" expectation carries no checks, got 1',
  );

  // The four well-formed shapes, one per class: nothing to report.
  assert.equal(expectationViolation({ class: "tool_error", version: 1, tool: "bash" }), undefined);
  assert.equal(expectationViolation({ class: "retry_loop", version: 1, tool: "bash" }), undefined);
  assert.equal(expectationViolation({ class: "user_correction", version: 1 }), undefined);
  assert.equal(expectationViolation({ class: "quality_defect", version: 1, checks: [check] }), undefined);
});
