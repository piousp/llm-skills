import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSubagentResultText, DIVIDER } from "../../src/render-result.ts";
import { buildProgressLines, buildProgressStream, type TaskProgress } from "../../src/progress.ts";

const fakeTheme = {
  fg: (c: string, t: string) => `<${c}>${t}</${c}>`,
};

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
