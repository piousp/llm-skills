import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSubagentResultText, DIVIDER } from "../../src/render-result.ts";
import { buildProgressLines, buildProgressStream, type TaskProgress } from "../../src/progress.ts";
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

test("buildSubagentResultText: partial+collapsed renders divider + today's progress lines", () => {
  const progress: TaskProgress[] = [
    { agent: "scout", runningTools: [{ toolCallId: "a", toolName: "read" }], history: ["read foo.ts"], done: false },
  ];

  const result = buildSubagentResultText(
    { isPartial: true, expanded: false, progress, content: "" },
    fakeTheme,
  );

  assert.equal(
    result,
    `<muted>${DIVIDER}</muted>\n${buildProgressLines(progress, fakeTheme)}`,
  );
});

test("buildSubagentResultText: partial+expanded renders divider + full tool-call stream", () => {
  const progress: TaskProgress[] = [
    { agent: "scout", runningTools: [{ toolCallId: "a", toolName: "read" }], history: ["read foo.ts", "grep /x/"], done: false },
  ];

  const result = buildSubagentResultText(
    { isPartial: true, expanded: true, progress, content: "" },
    fakeTheme,
  );

  assert.equal(
    result,
    `<muted>${DIVIDER}</muted>\n${buildProgressStream(progress, fakeTheme)}`,
  );
});

test("buildSubagentResultText: partial with no progress renders nothing, regardless of expanded", () => {
  assert.equal(buildSubagentResultText({ isPartial: true, expanded: false, progress: undefined, content: "" }, fakeTheme), "");
  assert.equal(buildSubagentResultText({ isPartial: true, expanded: true, progress: undefined, content: "" }, fakeTheme), "");
});

test("buildSubagentResultText: final+collapsed renders nothing at all", () => {
  const result = buildSubagentResultText(
    { isPartial: false, expanded: false, progress: undefined, content: "the full agent output" },
    fakeTheme,
  );
  assert.equal(result, "");
});

test("buildSubagentResultText: final+expanded renders divider + full content", () => {
  const result = buildSubagentResultText(
    { isPartial: false, expanded: true, progress: undefined, content: "the full agent output" },
    fakeTheme,
  );
  assert.equal(result, `<muted>${DIVIDER}</muted>\n<toolOutput>the full agent output</toolOutput>`);
});

test("buildSubagentResultText: final+expanded with empty content renders nothing", () => {
  const result = buildSubagentResultText(
    { isPartial: false, expanded: true, progress: undefined, content: "" },
    fakeTheme,
  );
  assert.equal(result, "");
});

test("buildSubagentResultText: final+expanded with one run's usage appends a footer line after the content", () => {
  const result = buildSubagentResultText(
    {
      isPartial: false, expanded: true, progress: undefined, content: "the full agent output",
      runs: [{ agent: "scout", usage: sampleUsage }],
    },
    fakeTheme,
  );
  assert.equal(
    result,
    `<muted>${DIVIDER}</muted>\n<toolOutput>the full agent output</toolOutput>\n`
      + `<accent>scout</accent> <dim>${sampleUsageFooter}</dim>`,
  );
});

test("buildSubagentResultText: final+expanded with two runs renders one footer line per run, in order", () => {
  const result = buildSubagentResultText(
    {
      isPartial: false, expanded: true, progress: undefined, content: "combined output",
      runs: [
        { agent: "scout", usage: sampleUsage },
        { agent: "planner", usage: sampleUsage },
      ],
    },
    fakeTheme,
  );
  assert.equal(
    result,
    `<muted>${DIVIDER}</muted>\n<toolOutput>combined output</toolOutput>\n`
      + `<accent>scout</accent> <dim>${sampleUsageFooter}</dim>\n`
      + `<accent>planner</accent> <dim>${sampleUsageFooter}</dim>`,
  );
});

test("buildSubagentResultText: final+expanded with a mix of runs with and without usage renders only the ones with usage, in order", () => {
  const result = buildSubagentResultText(
    {
      isPartial: false, expanded: true, progress: undefined, content: "combined output",
      runs: [
        { agent: "scout", usage: sampleUsage },
        { agent: "planner" },
        { agent: "web-scout", usage: sampleUsage },
      ],
    },
    fakeTheme,
  );
  assert.equal(
    result,
    `<muted>${DIVIDER}</muted>\n<toolOutput>combined output</toolOutput>\n`
      + `<accent>scout</accent> <dim>${sampleUsageFooter}</dim>\n`
      + `<accent>web-scout</accent> <dim>${sampleUsageFooter}</dim>`,
  );
});

test("buildSubagentResultText: a run with a defined but all-zero usage is treated the same as no usage (footer omitted)", () => {
  const emptyRunUsage: RunUsage = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, isSubscription: false, context: undefined,
  };
  const result = buildSubagentResultText(
    {
      isPartial: false, expanded: true, progress: undefined, content: "the full agent output",
      runs: [{ agent: "scout", usage: emptyRunUsage }],
    },
    fakeTheme,
  );
  assert.equal(result, `<muted>${DIVIDER}</muted>\n<toolOutput>the full agent output</toolOutput>`);
});

test("buildSubagentResultText: final+expanded with runs that have no usage renders identical output to no runs at all", () => {
  const withoutRuns = buildSubagentResultText(
    { isPartial: false, expanded: true, progress: undefined, content: "the full agent output" },
    fakeTheme,
  );
  const withRunsNoUsage = buildSubagentResultText(
    {
      isPartial: false, expanded: true, progress: undefined, content: "the full agent output",
      runs: [{ agent: "scout" }],
    },
    fakeTheme,
  );
  assert.equal(withRunsNoUsage, withoutRuns);
});

test("buildSubagentResultText: final+collapsed with one run's usage renders just the footer line, no divider or content", () => {
  const result = buildSubagentResultText(
    {
      isPartial: false, expanded: false, progress: undefined, content: "the full agent output",
      runs: [{ agent: "scout", usage: sampleUsage }],
    },
    fakeTheme,
  );
  assert.equal(result, `<accent>scout</accent> <dim>${sampleUsageFooter}</dim>`);
});

test("buildSubagentResultText: final+collapsed with two runs renders one footer line per run, in order", () => {
  const result = buildSubagentResultText(
    {
      isPartial: false, expanded: false, progress: undefined, content: "combined output",
      runs: [
        { agent: "scout", usage: sampleUsage },
        { agent: "planner", usage: sampleUsage },
      ],
    },
    fakeTheme,
  );
  assert.equal(
    result,
    `<accent>scout</accent> <dim>${sampleUsageFooter}</dim>\n`
      + `<accent>planner</accent> <dim>${sampleUsageFooter}</dim>`,
  );
});

test("buildSubagentResultText: final+collapsed with runs but no usage renders nothing, same as no runs at all", () => {
  const result = buildSubagentResultText(
    {
      isPartial: false, expanded: false, progress: undefined, content: "the full agent output",
      runs: [{ agent: "scout" }],
    },
    fakeTheme,
  );
  assert.equal(result, "");
});

test("buildSubagentResultText: partial with runs does not render footers (live view owns progress, not runs)", () => {
  const progress: TaskProgress[] = [
    { agent: "scout", runningTools: [], history: [], done: true, usage: sampleUsage },
  ];
  const result = buildSubagentResultText(
    {
      isPartial: true, expanded: true, progress, content: "",
      runs: [{ agent: "scout", usage: sampleUsage }],
    },
    fakeTheme,
  );
  // Same as the existing partial+expanded case: driven by progress, runs ignored.
  assert.equal(result, `<muted>${DIVIDER}</muted>\n${buildProgressStream(progress, fakeTheme)}`);
});
