import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSubagentResultText, DIVIDER } from "../../src/render-result.ts";
import type { RunUsage } from "../../src/usage.ts";

const fakeTheme = {
  fg: (c: string, t: string) => `<${c}>${t}</${c}>`,
};

const sampleUsage: RunUsage = {
  input: 12500, output: 840, cacheRead: 1_200_000, cacheWrite: 3000,
  cost: 0.4123, isSubscription: false,
  context: { percent: 12.34, window: 200000 },
};
const sampleUsageFooter = "\u219113k \u2193840 R1.2M W3.0k CH98.7% $0.412 12.3%/200k";

test("buildSubagentResultText: collapsed renders nothing at all", () => {
  const result = buildSubagentResultText({ expanded: false, content: "the full agent output" }, fakeTheme);
  assert.equal(result, "");
});

test("buildSubagentResultText: expanded renders divider + full content", () => {
  const result = buildSubagentResultText({ expanded: true, content: "the full agent output" }, fakeTheme);
  assert.equal(result, `<muted>${DIVIDER}</muted>\n<toolOutput>the full agent output</toolOutput>`);
});

test("buildSubagentResultText: expanded with empty content renders nothing", () => {
  const result = buildSubagentResultText({ expanded: true, content: "" }, fakeTheme);
  assert.equal(result, "");
});

test("buildSubagentResultText: expanded with the run's usage appends a footer line after the content", () => {
  const result = buildSubagentResultText(
    { expanded: true, content: "the full agent output", run: { agent: "scout", usage: sampleUsage } },
    fakeTheme,
  );
  assert.equal(
    result,
    `<muted>${DIVIDER}</muted>\n<toolOutput>the full agent output</toolOutput>\n`
      + `<accent>scout</accent> <dim>${sampleUsageFooter}</dim>`,
  );
});

test("buildSubagentResultText: a run with a defined but all-zero usage is treated the same as no usage (footer omitted)", () => {
  const emptyRunUsage: RunUsage = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, isSubscription: false, context: undefined,
  };
  const result = buildSubagentResultText(
    { expanded: true, content: "the full agent output", run: { agent: "scout", usage: emptyRunUsage } },
    fakeTheme,
  );
  assert.equal(result, `<muted>${DIVIDER}</muted>\n<toolOutput>the full agent output</toolOutput>`);
});

test("buildSubagentResultText: expanded with a run that has no usage renders identical output to no run at all", () => {
  const withoutRun = buildSubagentResultText({ expanded: true, content: "the full agent output" }, fakeTheme);
  const withRunNoUsage = buildSubagentResultText(
    { expanded: true, content: "the full agent output", run: { agent: "scout" } },
    fakeTheme,
  );
  assert.equal(withRunNoUsage, withoutRun);
});

test("buildSubagentResultText: collapsed with the run's usage renders just the footer line, no divider or content", () => {
  const result = buildSubagentResultText(
    { expanded: false, content: "the full agent output", run: { agent: "scout", usage: sampleUsage } },
    fakeTheme,
  );
  assert.equal(result, `<accent>scout</accent> <dim>${sampleUsageFooter}</dim>`);
});

test("buildSubagentResultText: collapsed with a run but no usage renders nothing, same as no run at all", () => {
  const result = buildSubagentResultText(
    { expanded: false, content: "the full agent output", run: { agent: "scout" } },
    fakeTheme,
  );
  assert.equal(result, "");
});
