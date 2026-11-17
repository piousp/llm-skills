import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EPISODE_ATTRIBUTIONS,
  GATE_KINDS,
  GATE_OUTCOME_CLASSES,
  JUDGED_OUTCOMES,
  MAX_PREPARE_FAILED_REASON_CHARS,
  MAX_SUMMARY_CHARS,
  OBSERVATION_SOURCES,
  OBSERVE_EVENT_TYPES,
  OBSERVE_FORMAT,
  PREFILTER_FLAG_KINDS,
  PROMPT_ANSWERS,
  PROMPT_STAGES,
  PROVENANCES,
  TOMBSTONE_REASONS,
  observeId,
} from "../../src/observe/types.ts";
import type { ObserveEvent } from "../../src/observe/types.ts";
import { sha256Digest } from "../../src/hash.ts";
import { isPlainObject } from "../../src/values.ts";
import { loadObserveEventSchema, validateAgainstObserveEventSchema } from "./schema-reader.ts";

// schemas/observe-event.schema.json describes one line of state/observe.jsonl. The positive cases are typed as
// ObserveEvent, so a field the union gains and the schema does not know fails to compile or to validate; the negative
// cases are one injected fault per case, so a keyword the reader does not know shows up as a case nobody could make fail.

const AT = "2026-11-02T14:03:22.481Z";
const HASH = `sha256:${"a".repeat(64)}`;
const SKILL_HASH = sha256Digest("the SKILL.md of pdf-tools");
const EPISODE_ID = observeId("ep", ["pdf-tools", "e1"]);
const OBSERVATION_ID = observeId("ob", ["judge", EPISODE_ID, "e3", "wrong-tool"]);
const PATTERN_ID = observeId("pt", ["pdf-tools", OBSERVATION_ID]);
const PROPOSAL_ID = observeId("pr", [PATTERN_ID, HASH]);
const BASE = { format: OBSERVE_FORMAT, at: AT } as const;

const EVENTS: readonly ObserveEvent[] = [
  { ...BASE, type: "opt-in" },
  {
    ...BASE,
    type: "episode",
    id: EPISODE_ID,
    skill: "pdf-tools",
    sessionId: "s1",
    sessionFile: "/sessions/s1.jsonl",
    cwd: "/work/project",
    startEntryId: "e1",
    endEntryId: "e9",
    anchorEntryIds: ["e1", "e3"],
    startedAt: AT,
    attribution: "explicit",
    providers: ["anthropic"],
    flags: ["correction"],
    clean: false,
  },
  { ...BASE, type: "judged", episodeId: EPISODE_ID, model: "anthropic/claude", outcome: "findings" },
  { ...BASE, type: "judged", episodeId: EPISODE_ID, model: "anthropic/claude", outcome: "failed", reason: "timeout" },
  {
    ...BASE,
    type: "observation",
    id: OBSERVATION_ID,
    episodeId: EPISODE_ID,
    sessionId: "s1",
    skill: "pdf-tools",
    source: "judge",
    kind: "wrong-tool",
    summary: "the user asked for lattice mode",
    confidence: 0.8,
    weight: 0.48,
    anchorEntryId: "e3",
    patternId: PATTERN_ID,
  },
  {
    ...BASE,
    type: "observation",
    id: OBSERVATION_ID,
    episodeId: null,
    sessionId: "s1",
    skill: "pdf-tools",
    source: "user-note",
    kind: "note",
    summary: "always use lattice mode",
    confidence: null,
    weight: 1,
    anchorEntryId: "e3",
    patternId: PATTERN_ID,
  },
  {
    ...BASE,
    type: "proposal",
    id: PROPOSAL_ID,
    patternId: PATTERN_ID,
    skill: "pdf-tools",
    stagingPath: "staging/20261102T140322481Z/pdf-tools",
    candidateHash: HASH,
    gate: "bank",
    bankPath: "banks/pdf-tools.json",
    provenance: "auto",
    cwd: "/work/project",
    skillContentHash: SKILL_HASH,
  },
  {
    ...BASE,
    type: "proposal",
    id: PROPOSAL_ID,
    patternId: PATTERN_ID,
    skill: "pdf-tools",
    stagingPath: "staging/20261102T140322481Z/pdf-tools",
    candidateHash: HASH,
    gate: "probation",
    bankPath: null,
    provenance: null,
    cwd: "/work/project",
    skillContentHash: SKILL_HASH,
  },
  { ...BASE, type: "prepare-failed", skill: "pdf-tools", patternId: PATTERN_ID, reason: "bank selection pending: too few cases" },
  { ...BASE, type: "prompt", proposalId: PROPOSAL_ID, stage: "a", answer: "later" },
  { ...BASE, type: "gate-outcome", proposalId: PROPOSAL_ID, class: "retryable", status: "gate-abstained", reason: null },
  { ...BASE, type: "tombstone", patternId: PATTERN_ID, skill: "pdf-tools", reason: "user-rejected", candidateHash: null },
  { ...BASE, type: "tombstone", patternId: PATTERN_ID, skill: "pdf-tools", reason: "gate-rejected", candidateHash: HASH },
  { ...BASE, type: "tombstone", patternId: PATTERN_ID, skill: "pdf-tools", reason: "accepted", candidateHash: HASH },
  { ...BASE, type: "tombstone", patternId: PATTERN_ID, skill: "pdf-tools", reason: "stale", candidateHash: HASH },
  { ...BASE, type: "forget", skill: "pdf-tools" },
];

function fromEvent(type: ObserveEvent["type"], index = 0): Record<string, unknown> {
  const found = EVENTS.filter((event) => event.type === type)[index];
  assert.ok(found, `no sample event of type ${type}`);
  return { ...found };
}

function without(line: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...line };
  delete copy[key];
  return copy;
}

for (const event of EVENTS) {
  test(`the schema accepts the ${event.type} event the store writes`, () => {
    assert.deepEqual(validateAgainstObserveEventSchema(event), []);
  });
}

test("every event type the union has appears as a sample", () => {
  for (const type of OBSERVE_EVENT_TYPES) {
    assert.ok(
      EVENTS.some((event) => event.type === type),
      `no sample for ${type}`,
    );
  }
});

interface NegativeCase {
  name: string;
  line: () => Record<string, unknown>;
  messagePart: string;
}

const NEGATIVE_CASES: readonly NegativeCase[] = [
  { name: "a key the format does not declare", line: () => ({ ...fromEvent("forget"), extra: 1 }), messagePart: '"extra"' },
  { name: "a line of another format", line: () => ({ ...fromEvent("forget"), format: "pi-simple-sri/observe@2" }), messagePart: "observe@2" },
  { name: "a type outside the union", line: () => ({ ...fromEvent("forget"), type: "pattern" }), messagePart: "0 branches of the oneOf matched" },
  { name: "an at that is not a date-time", line: () => ({ ...fromEvent("forget"), at: "2026-11-02" }), messagePart: "is not a date-time" },
  { name: "a forget without its skill", line: () => without(fromEvent("forget"), "skill"), messagePart: 'the required property "skill" is missing' },
  { name: "an opt-in carrying a payload", line: () => ({ ...fromEvent("opt-in"), skill: "pdf-tools" }), messagePart: '"skill"' },
  { name: "an episode id with another prefix", line: () => ({ ...fromEvent("episode"), id: `ob-${"0".repeat(12)}` }), messagePart: "/^ep-[0-9a-f]{12}$/" },
  { name: "an episode id with fewer hex digits", line: () => ({ ...fromEvent("episode"), id: "ep-abc" }), messagePart: "/^ep-[0-9a-f]{12}$/" },
  { name: "an attribution outside the enum", line: () => ({ ...fromEvent("episode"), attribution: "guessed" }), messagePart: "guessed" },
  { name: "a flag outside the enum", line: () => ({ ...fromEvent("episode"), flags: ["vibes"] }), messagePart: "vibes" },
  { name: "an episode without its clean marker", line: () => without(fromEvent("episode"), "clean"), messagePart: 'the required property "clean" is missing' },
  { name: "a startedAt that is not a date-time", line: () => ({ ...fromEvent("episode"), startedAt: "yesterday" }), messagePart: "is not a date-time" },
  { name: "a judged outcome outside the enum", line: () => ({ ...fromEvent("judged"), outcome: "maybe" }), messagePart: "maybe" },
  { name: "a judged line pointing at a non-episode id", line: () => ({ ...fromEvent("judged"), episodeId: PATTERN_ID }), messagePart: "/^ep-[0-9a-f]{12}$/" },
  { name: "an observation source outside the enum", line: () => ({ ...fromEvent("observation"), source: "oracle" }), messagePart: "oracle" },
  {
    name: `a summary over ${MAX_SUMMARY_CHARS} characters`,
    line: () => ({ ...fromEvent("observation"), summary: "x".repeat(MAX_SUMMARY_CHARS + 1) }),
    messagePart: `longer than ${MAX_SUMMARY_CHARS}`,
  },
  { name: "an empty summary", line: () => ({ ...fromEvent("observation"), summary: "" }), messagePart: "shorter than 1" },
  { name: "a negative weight", line: () => ({ ...fromEvent("observation"), weight: -0.1 }), messagePart: "below the minimum 0" },
  { name: "a string confidence", line: () => ({ ...fromEvent("observation"), confidence: "high" }), messagePart: "expected number or null" },
  { name: "an observation without its pattern", line: () => without(fromEvent("observation"), "patternId"), messagePart: 'the required property "patternId" is missing' },
  { name: "a numeric episodeId", line: () => ({ ...fromEvent("observation"), episodeId: 7 }), messagePart: "expected string or null" },
  { name: "a candidate hash without the sha256 prefix", line: () => ({ ...fromEvent("proposal"), candidateHash: "a".repeat(64) }), messagePart: "/^sha256:[0-9a-f]{64}$/" },
  { name: "a gate outside the enum", line: () => ({ ...fromEvent("proposal"), gate: "skip" }), messagePart: "skip" },
  { name: "a provenance outside the enum", line: () => ({ ...fromEvent("proposal"), provenance: "guess" }), messagePart: "guess" },
  { name: "a proposal without its cwd", line: () => without(fromEvent("proposal"), "cwd"), messagePart: 'the required property "cwd" is missing' },
  { name: "a proposal without the hash of the skill it was staged against", line: () => without(fromEvent("proposal"), "skillContentHash"), messagePart: 'the required property "skillContentHash" is missing' },
  { name: "a skill hash that is not 64 hex digits", line: () => ({ ...fromEvent("proposal"), skillContentHash: "sha256:abc" }), messagePart: "/^sha256:[0-9a-f]{64}$/" },
  { name: "a skill hash in bare hex, without the sha256 prefix the writer gives it", line: () => ({ ...fromEvent("proposal"), skillContentHash: "b".repeat(64) }), messagePart: "/^sha256:[0-9a-f]{64}$/" },
  { name: "a prepare-failed without its pattern", line: () => without(fromEvent("prepare-failed"), "patternId"), messagePart: 'the required property "patternId" is missing' },
  {
    name: `a prepare-failed reason over ${MAX_PREPARE_FAILED_REASON_CHARS} characters`,
    line: () => ({ ...fromEvent("prepare-failed"), reason: "x".repeat(MAX_PREPARE_FAILED_REASON_CHARS + 1) }),
    messagePart: `longer than ${MAX_PREPARE_FAILED_REASON_CHARS}`,
  },
  { name: "a prompt stage outside the enum", line: () => ({ ...fromEvent("prompt"), stage: "c" }), messagePart: '"c"' },
  { name: "a prompt answer outside the enum", line: () => ({ ...fromEvent("prompt"), answer: "yes" }), messagePart: '"yes"' },
  { name: "a gate outcome class outside the enum", line: () => ({ ...fromEvent("gate-outcome"), class: "unknown" }), messagePart: "unknown" },
  { name: "a gate outcome without its reason", line: () => without(fromEvent("gate-outcome"), "reason"), messagePart: 'the required property "reason" is missing' },
  { name: "a tombstone reason outside the enum", line: () => ({ ...fromEvent("tombstone"), reason: "bored" }), messagePart: "bored" },
];

for (const negative of NEGATIVE_CASES) {
  test(`the schema refuses ${negative.name}`, () => {
    const violations = validateAgainstObserveEventSchema(negative.line());

    assert.notEqual(violations.length, 0, "the line had to be refused and it was not");
    assert.ok(
      violations.some((violation) => violation.includes(negative.messagePart)),
      `expected a violation naming ${JSON.stringify(negative.messagePart)}, got ${JSON.stringify(violations)}`,
    );
  });
}

// The vocabularies of the union and the enums of the schema are two spellings of the same sets; nothing else ties them.
function branchProperties(type: string): Record<string, unknown> {
  const schema: unknown = loadObserveEventSchema();
  assert.ok(isPlainObject(schema), "the schema must be a JSON object");
  const branches = schema.oneOf;
  assert.ok(Array.isArray(branches), "the format is a oneOf of its events");
  const branch = branches.find((candidate: unknown) => {
    if (!isPlainObject(candidate) || !isPlainObject(candidate.properties)) return false;
    const typeNode = candidate.properties.type;
    return isPlainObject(typeNode) && typeNode.const === type;
  });
  assert.ok(isPlainObject(branch) && isPlainObject(branch.properties), `no branch for ${type}`);
  return branch.properties;
}

function enumOf(properties: Record<string, unknown>, key: string): unknown[] {
  let node = properties[key];
  assert.ok(isPlainObject(node), `no property ${key}`);
  if (isPlainObject(node.items)) node = node.items;
  assert.ok(isPlainObject(node) && Array.isArray(node.enum), `no enum on ${key}`);
  // The nullable property of the schema lists null in its enum; the union spells it as `| null`.
  return node.enum.filter((value: unknown) => value !== null);
}

test("the schema declares one branch per event type, and the format", () => {
  const schema: unknown = loadObserveEventSchema();
  assert.ok(isPlainObject(schema) && Array.isArray(schema.oneOf));
  assert.equal(schema.oneOf.length, OBSERVE_EVENT_TYPES.length);
  for (const type of OBSERVE_EVENT_TYPES) {
    const properties = branchProperties(type);
    const format = properties.format;
    assert.ok(isPlainObject(format));
    assert.equal(format.const, OBSERVE_FORMAT);
  }
});

test("the enums of the schema are the vocabularies of the union", () => {
  assert.deepEqual(enumOf(branchProperties("episode"), "attribution"), [...EPISODE_ATTRIBUTIONS]);
  assert.deepEqual(enumOf(branchProperties("episode"), "flags"), [...PREFILTER_FLAG_KINDS]);
  assert.deepEqual(enumOf(branchProperties("judged"), "outcome"), [...JUDGED_OUTCOMES]);
  assert.deepEqual(enumOf(branchProperties("observation"), "source"), [...OBSERVATION_SOURCES]);
  assert.deepEqual(enumOf(branchProperties("proposal"), "gate"), [...GATE_KINDS]);
  assert.deepEqual(enumOf(branchProperties("proposal"), "provenance"), [...PROVENANCES]);
  assert.deepEqual(enumOf(branchProperties("prompt"), "stage"), [...PROMPT_STAGES]);
  assert.deepEqual(enumOf(branchProperties("prompt"), "answer"), [...PROMPT_ANSWERS]);
  assert.deepEqual(enumOf(branchProperties("gate-outcome"), "class"), [...GATE_OUTCOME_CLASSES]);
  assert.deepEqual(enumOf(branchProperties("tombstone"), "reason"), [...TOMBSTONE_REASONS]);
});

test("the schema cuts the prepare-failed reason at MAX_PREPARE_FAILED_REASON_CHARS", () => {
  const reason = branchProperties("prepare-failed").reason;
  assert.ok(isPlainObject(reason));
  assert.equal(reason.maxLength, MAX_PREPARE_FAILED_REASON_CHARS);
});

test("the schema cuts the summary at MAX_SUMMARY_CHARS", () => {
  const summary = branchProperties("observation").summary;
  assert.ok(isPlainObject(summary));
  assert.equal(summary.maxLength, MAX_SUMMARY_CHARS);
});

test("observeId: prefix plus 12 hex of the hash of the parts, stable and sensitive to every part", () => {
  const id = observeId("ep", ["pdf-tools", "e1"]);

  assert.match(id, /^ep-[0-9a-f]{12}$/);
  assert.equal(observeId("ep", ["pdf-tools", "e1"]), id);
  assert.notEqual(observeId("ep", ["pdf-tools", "e2"]), id);
  assert.notEqual(observeId("ep", ["pdf-tool", "se1"]), observeId("ep", ["pdf-tools", "e1"]));
  assert.notEqual(observeId("pt", ["pdf-tools", "e1"]), id);
});
