import { test } from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { CASE_BANK_FORMAT, MAX_PROMPT_CODE_POINTS, loadCaseBank } from "../../src/case-bank.ts";
import type { CompleteFn } from "../../src/proposer.ts";
import { BANK_MAX_TOKENS, createBankGenerator, hasPositiveCheck } from "../../src/observe/auto-bank.ts";
import type { BankGeneratorInput } from "../../src/observe/auto-bank.ts";
import { FAKE_SECRETS, FIXTURE_NOW, fixturePath } from "./observe-fixtures.ts";

// WP9: the generator of the bank. The model is a scripted CompleteFn; what is pinned is what code decides -- ids,
// prompts, provenance, the positive-check rule -- and what the model is never shown.

const NOW = new Date(FIXTURE_NOW);

interface Call {
  context: Context;
  options: { signal?: AbortSignal; maxTokens: number };
}

function message(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: NOW.getTime(),
  };
}

function scripted(reply: string | Error, stopReason: AssistantMessage["stopReason"] = "stop") {
  const calls: Call[] = [];
  const complete: CompleteFn = async (context, options) => {
    calls.push({ context, options });
    if (reply instanceof Error) throw reply;
    return message(reply, stopReason);
  };
  return { complete, calls };
}

function inputOf(prompts: string[] = ["summarise the changelog", "summarise the release notes"]): BankGeneratorInput {
  return {
    skill: { name: "demo-skill", description: "Summarises changelogs." },
    cases: prompts.map((prompt) => ({ prompt, expectation: "wanted the breaking changes only" })),
    now: NOW,
  };
}

const GOOD_REPLY = JSON.stringify({
  cases: [
    { case: 1, checks: [{ kind: "contains", value: "breaking" }, { kind: "not-contains", value: "Added" }] },
    { case: 2, checks: [{ kind: "regex", pattern: "breaking", flags: "i" }] },
  ],
});

test("createBankGenerator: the prompts are the verbatim user text, the ids and the provenance are set by code", async () => {
  const fake = scripted(`Here you go:\n${GOOD_REPLY}`);

  const result = await createBankGenerator(fake.complete)(inputOf());

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.format, CASE_BANK_FORMAT);
  assert.equal(result.value.provenance, "auto");
  assert.deepEqual(
    result.value.cases.map((entry) => [entry.id, entry.prompt]),
    [
      ["case-1", "summarise the changelog"],
      ["case-2", "summarise the release notes"],
    ],
  );
  assert.deepEqual(result.value.cases[0]?.checks, [
    { kind: "contains", value: "breaking" },
    { kind: "not-contains", value: "Added" },
  ]);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0]?.options.maxTokens, BANK_MAX_TOKENS);
});

test("createBankGenerator: a prompt the model rewrote in its reply does not reach the bank", async () => {
  const reply = JSON.stringify({
    cases: [
      { case: 1, prompt: "something else", id: "mine", checks: [{ kind: "contains", value: "x" }] },
      { case: 2, checks: [{ kind: "contains", value: "y" }] },
    ],
  });

  const result = await createBankGenerator(scripted(reply).complete)(inputOf());

  assert.equal(result.ok && result.value.cases[0]?.prompt, "summarise the changelog");
  assert.equal(result.ok && result.value.cases[0]?.id, "case-1");
});

test("createBankGenerator: the model sees the requests and what was wanted, and nothing about a lesson", async () => {
  const fake = scripted(GOOD_REPLY);

  await createBankGenerator(fake.complete)(inputOf());

  const context = fake.calls[0]?.context;
  const seen = JSON.stringify(context);
  assert.match(seen, /summarise the changelog/);
  assert.match(seen, /wanted the breaking changes only/);
  assert.doesNotMatch(seen, /lesson/i);
});

test("createBankGenerator: a case with only negative checks is refused, like the invalid fixture", async () => {
  const reply = JSON.stringify({
    cases: [
      { case: 1, checks: [{ kind: "not-contains", value: "Added" }] },
      { case: 2, checks: [{ kind: "not-regex", pattern: "^Here is" }] },
    ],
  });

  const result = await createBankGenerator(scripted(reply).complete)(inputOf());

  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.error : "", /"case-1" has no positive check/);
});

test("hasPositiveCheck: every case of the auto fixture has one and the first case of the invalid fixture has none", async () => {
  const auto = await loadCaseBank(fixturePath("banks", "auto.json"), "baseline");
  const invalid = await loadCaseBank(fixturePath("banks", "invalid-no-positive-check.json"), "baseline");

  assert.equal(auto.ok && auto.value.cases.every(hasPositiveCheck), true);
  assert.equal(invalid.ok && hasPositiveCheck(invalid.value.cases[0]!), false);
});

test("createBankGenerator: prose with a brace after the object, and one with a brace before it, still parse", async () => {
  const wrapped = `Here is the bank {as asked}:\n\`\`\`json\n${GOOD_REPLY}\n\`\`\`\nThat is all } thanks`;

  const result = await createBankGenerator(scripted(wrapped).complete)(inputOf());

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value.cases.length, 2);
});

test("createBankGenerator: a reply with no balanced object says there is no object", async () => {
  const result = await createBankGenerator(scripted("{ cases: [").complete)(inputOf());

  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.error : "", /does not contain a JSON object/);
});

test("createBankGenerator: a prompt with a secret is excluded, never sent and never redacted into a case", async () => {
  const fake = scripted(GOOD_REPLY);
  const prompts = ["summarise the changelog", `deploy with ${FAKE_SECRETS.awsKey}`, "summarise the release notes"];

  const result = await createBankGenerator(fake.complete)(inputOf(prompts));

  assert.equal(result.ok, true);
  assert.doesNotMatch(JSON.stringify(fake.calls[0]?.context), new RegExp(FAKE_SECRETS.awsKey));
  assert.deepEqual(
    result.ok && result.value.cases.map((entry) => entry.prompt),
    ["summarise the changelog", "summarise the release notes"],
  );
});

test("createBankGenerator: a prompt over the limit is dropped and not cut", async () => {
  const fake = scripted(GOOD_REPLY);
  const long = "p".repeat(MAX_PROMPT_CODE_POINTS + 1);

  const result = await createBankGenerator(fake.complete)(inputOf([long, "summarise the changelog", "summarise the release notes"]));

  assert.deepEqual(
    result.ok && result.value.cases.map((entry) => entry.prompt),
    ["summarise the changelog", "summarise the release notes"],
  );
});

test("createBankGenerator: cases that fall to one session after the prompts are filtered spend no call", async () => {
  const fake = scripted(GOOD_REPLY);
  const input: BankGeneratorInput = {
    skill: { name: "demo-skill", description: "d" },
    cases: [
      { prompt: "summarise the changelog", expectation: "x", sessionId: "s1" },
      { prompt: "summarise the notes", expectation: "x", sessionId: "s1" },
      { prompt: `deploy with ${FAKE_SECRETS.awsKey}`, expectation: "x", sessionId: "s2" },
    ],
    now: NOW,
  };

  const result = await createBankGenerator(fake.complete)(input);

  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.error : "", /1 session/);
  assert.equal(fake.calls.length, 0);
});

test("createBankGenerator: two sessions among the surviving cases are enough", async () => {
  const input: BankGeneratorInput = {
    skill: { name: "demo-skill", description: "d" },
    cases: [
      { prompt: "summarise the changelog", expectation: "x", sessionId: "s1" },
      { prompt: "summarise the notes", expectation: "x", sessionId: "s2" },
    ],
    now: NOW,
  };

  assert.equal((await createBankGenerator(scripted(GOOD_REPLY).complete)(input)).ok, true);
});

test("createBankGenerator: fewer than two usable cases spend no call", async () => {
  const fake = scripted(GOOD_REPLY);

  const result = await createBankGenerator(fake.complete)(inputOf(["summarise", `key ${FAKE_SECRETS.githubToken}`]));

  assert.equal(result.ok, false);
  assert.equal(fake.calls.length, 0);
});

test("createBankGenerator: an aborted signal spends no call", async () => {
  const fake = scripted(GOOD_REPLY);
  const controller = new AbortController();
  controller.abort();

  const result = await createBankGenerator(fake.complete)(inputOf(), controller.signal);

  assert.equal(result.ok, false);
  assert.equal(fake.calls.length, 0);
});

test("createBankGenerator: the signal travels to the call", async () => {
  const fake = scripted(GOOD_REPLY);
  const controller = new AbortController();

  await createBankGenerator(fake.complete)(inputOf(), controller.signal);

  assert.equal(fake.calls[0]?.options.signal, controller.signal);
});

const BAD_REPLIES: [string, string | Error, AssistantMessage["stopReason"]?][] = [
  ["a reply with no JSON", "no checks today", undefined],
  ["a reply that is not valid JSON", "{ cases: [", undefined],
  ["a reply without the cases array", '{"checks": []}', undefined],
  ["a reply missing a case", JSON.stringify({ cases: [{ case: 1, checks: [{ kind: "contains", value: "x" }] }] }), undefined],
  [
    "a check outside the vocabulary",
    JSON.stringify({ cases: [{ case: 1, checks: [{ kind: "equals", value: "x" }] }, { case: 2, checks: [{ kind: "contains", value: "y" }] }] }),
    undefined,
  ],
  [
    "a regex that does not compile",
    JSON.stringify({ cases: [{ case: 1, checks: [{ kind: "regex", pattern: "(" }] }, { case: 2, checks: [{ kind: "contains", value: "y" }] }] }),
    undefined,
  ],
  ["a reply cut by the budget", GOOD_REPLY, "length"],
  ["a provider that fails", new Error("provider down"), undefined],
];

for (const [name, reply, stopReason] of BAD_REPLIES) {
  test(`createBankGenerator: refuses ${name}`, async () => {
    const result = await createBankGenerator(scripted(reply, stopReason).complete)(inputOf());

    assert.equal(result.ok, false);
  });
}
