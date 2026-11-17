import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatLabelingReport,
  labelingRecordOf,
  parseLabelingText,
  ratioValue,
  scoreLabels,
  type LabeledEpisode,
} from "../../src/observe/labeling.ts";
import type { Episode } from "../../src/observe/types.ts";
import { readLabeledEpisodes, readLabelingExpectation } from "./observe-fixtures.ts";

function labeled(flagged: boolean, judgeFound: boolean, label: boolean, id = "ep-x"): LabeledEpisode {
  return { episodeId: id, flagged, judgeFound, label };
}

test("scoreLabels over the fixture matches the hand-counted ratios", () => {
  const expected = readLabelingExpectation();
  const score = scoreLabels(readLabeledEpisodes());
  assert.deepEqual(score, {
    n: expected.n,
    judgePrecision: expected.judgePrecision,
    judgeRecall: expected.judgeRecall,
    prefilterRecall: expected.prefilterRecall,
  });
});

test("precision counts judged episodes only, recall and prefilter recall count labeled positives only", () => {
  const score = scoreLabels([
    labeled(true, true, true),
    labeled(true, true, false), // false positive of the judge
    labeled(false, false, true), // missed by both
    labeled(true, false, false), // true negative: counts nowhere
  ]);
  assert.deepEqual(score.judgePrecision, { num: 1, den: 2 });
  assert.deepEqual(score.judgeRecall, { num: 1, den: 2 });
  assert.deepEqual(score.prefilterRecall, { num: 1, den: 2 });
});

test("an empty denominator is reported as undefined, not as zero or one", () => {
  const score = scoreLabels([labeled(false, false, false)]);
  assert.equal(ratioValue(score.judgePrecision), null);
  assert.equal(ratioValue(score.judgeRecall), null);
  assert.equal(ratioValue({ num: 1, den: 4 }), 0.25);
  assert.equal(scoreLabels([]).n, 0);
});

test("labelingRecordOf carries the shape of the labeled record plus pointers, unlabeled", () => {
  const episode = { id: "ep-1", sessionFile: "/s/a.jsonl", startEntryId: "abc12345" } as Episode;
  assert.deepEqual(labelingRecordOf(episode, true, false), {
    episodeId: "ep-1",
    flagged: true,
    judgeFound: false,
    label: null,
    sessionFile: "/s/a.jsonl",
    startEntryId: "abc12345",
  });
});

test("parseLabelingText separates labeled, unlabeled and invalid lines", () => {
  const text = [
    JSON.stringify({ episodeId: "ep-1", flagged: true, judgeFound: true, label: true }),
    JSON.stringify({ episodeId: "ep-2", flagged: true, judgeFound: false, label: null }),
    "",
    "not json",
    JSON.stringify({ episodeId: "ep-3", flagged: "yes", judgeFound: true, label: true }),
    JSON.stringify({ episodeId: "ep-4", flagged: true, judgeFound: true, label: "true" }),
    "null",
  ].join("\n");
  const parsed = parseLabelingText(text);
  assert.deepEqual(parsed.labeled, [labeled(true, true, true, "ep-1")]);
  assert.equal(parsed.unlabeled, 1);
  assert.deepEqual(parsed.invalid, [4, 5, 6, 7]);
});

test("a record missing the label field is invalid, never read as unlabeled or false", () => {
  const parsed = parseLabelingText(JSON.stringify({ episodeId: "ep-1", flagged: true, judgeFound: true }));
  assert.equal(parsed.labeled.length, 0);
  assert.equal(parsed.unlabeled, 0);
  assert.deepEqual(parsed.invalid, [1]);
});

test("the fixture file parses as fully labeled and scores like the direct read", () => {
  const records = readLabeledEpisodes();
  const parsed = parseLabelingText(records.map((record) => JSON.stringify(record)).join("\n"));
  assert.deepEqual(parsed.labeled, records);
  assert.equal(parsed.unlabeled, 0);
});

test("formatLabelingReport shows percentages and fractions, and only mentions unlabeled and invalid when present", () => {
  const score = scoreLabels(readLabeledEpisodes());
  const clean = formatLabelingReport(score, { unlabeled: 0, invalid: [] });
  assert.match(clean, /n: 10/);
  assert.match(clean, /judge precision: 80\.0% \(4\/5\)/);
  assert.match(clean, /judge recall: 66\.7% \(4\/6\)/);
  assert.match(clean, /prefilter recall: 83\.3% \(5\/6\)/);
  assert.doesNotMatch(clean, /unlabeled|invalid/);
  const dirty = formatLabelingReport(score, { unlabeled: 3, invalid: [2, 9] });
  assert.match(dirty, /unlabeled \(not scored\): 3/);
  assert.match(dirty, /invalid lines: 2, 9/);
  assert.match(formatLabelingReport(scoreLabels([]), { unlabeled: 0, invalid: [] }), /judge precision: n\/a \(0\/0\)/);
});
