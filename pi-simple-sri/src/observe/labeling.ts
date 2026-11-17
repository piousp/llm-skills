import type { Episode } from "./types.ts";

// The labeled episodes of the dry-run measurement (WP16): the dry-run writes one record per sampled episode with
// `label: null`, a human fills `label` in, and scoreLabels turns the labeled records into the judge's precision and
// recall and the prefilter's recall. The record carries pointers and flags only, never content.

export interface LabelingRecord {
  episodeId: string;
  // The prefilter raised a flag.
  flagged: boolean;
  // The judge reported a finding.
  judgeFound: boolean;
  // A human says the episode holds a correction; null until they have labeled it.
  label: boolean | null;
  sessionFile: string;
  startEntryId: string;
}

export interface LabeledEpisode {
  episodeId: string;
  flagged: boolean;
  judgeFound: boolean;
  label: boolean;
}

// Kept as a fraction so a ratio is exact and the denominator says when it is undefined.
export interface Ratio {
  num: number;
  den: number;
}

export interface LabelingScore {
  n: number;
  judgePrecision: Ratio;
  judgeRecall: Ratio;
  prefilterRecall: Ratio;
}

export function labelingRecordOf(episode: Episode, flagged: boolean, judgeFound: boolean): LabelingRecord {
  return {
    episodeId: episode.id,
    flagged,
    judgeFound,
    label: null,
    sessionFile: episode.sessionFile,
    startEntryId: episode.startEntryId,
  };
}

function count(records: readonly LabeledEpisode[], predicate: (record: LabeledEpisode) => boolean): number {
  return records.filter(predicate).length;
}

export function scoreLabels(records: readonly LabeledEpisode[]): LabelingScore {
  const judged = records.filter((record) => record.judgeFound);
  const positives = records.filter((record) => record.label);
  return {
    n: records.length,
    judgePrecision: { num: count(judged, (record) => record.label), den: judged.length },
    judgeRecall: { num: count(positives, (record) => record.judgeFound), den: positives.length },
    prefilterRecall: { num: count(positives, (record) => record.flagged), den: positives.length },
  };
}

export function ratioValue(ratio: Ratio): number | null {
  return ratio.den === 0 ? null : ratio.num / ratio.den;
}

export interface ParsedLabeling {
  labeled: LabeledEpisode[];
  // Records still holding `label: null`.
  unlabeled: number;
  // 1-based line numbers that are not a record.
  invalid: number[];
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

export function parseLabelingText(text: string): ParsedLabeling {
  const parsed: ParsedLabeling = { labeled: [], unlabeled: 0, invalid: [] };
  text.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      parsed.invalid.push(index + 1);
      return;
    }
    const record = value as Record<string, unknown> | null;
    if (
      typeof record !== "object" ||
      record === null ||
      typeof record["episodeId"] !== "string" ||
      !isBoolean(record["flagged"]) ||
      !isBoolean(record["judgeFound"])
    ) {
      parsed.invalid.push(index + 1);
      return;
    }
    const label = record["label"];
    if (label === null) {
      parsed.unlabeled += 1;
    } else if (isBoolean(label)) {
      parsed.labeled.push({
        episodeId: record["episodeId"],
        flagged: record["flagged"],
        judgeFound: record["judgeFound"],
        label,
      });
    } else {
      parsed.invalid.push(index + 1);
    }
  });
  return parsed;
}

function percentOf(ratio: Ratio): string {
  const value = ratioValue(ratio);
  const shown = value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
  return `${shown} (${ratio.num}/${ratio.den})`;
}

export function formatLabelingReport(score: LabelingScore, parsed: Pick<ParsedLabeling, "unlabeled" | "invalid">): string {
  const lines = [
    `n: ${score.n}`,
    `judge precision: ${percentOf(score.judgePrecision)}`,
    `judge recall: ${percentOf(score.judgeRecall)}`,
    `prefilter recall: ${percentOf(score.prefilterRecall)}`,
  ];
  if (parsed.unlabeled > 0) lines.push(`unlabeled (not scored): ${parsed.unlabeled}`);
  if (parsed.invalid.length > 0) lines.push(`invalid lines: ${parsed.invalid.join(", ")}`);
  return `${lines.join("\n")}\n`;
}
