// Scores the labeled episodes of the dry-run measurement. Usage:
//   node scripts/score-labels.ts [file.jsonl | directory]...
// With no argument it reads every *.jsonl of <agentDir>/sri/labeling. It only reads and prints.
import fs from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { formatLabelingReport, parseLabelingText, scoreLabels, type ParsedLabeling } from "../src/observe/labeling.ts";
import { labelingDir, writeBase } from "../src/write-base.ts";

function jsonlFilesOf(target: string): string[] {
  if (!fs.statSync(target).isDirectory()) return [target];
  return fs
    .readdirSync(target)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .map((name) => path.join(target, name));
}

const targets = process.argv.slice(2);
const sources = targets.length > 0 ? targets : [labelingDir(writeBase(getAgentDir()))];
const files = sources.flatMap(jsonlFilesOf);

if (files.length === 0) {
  console.error("no labeling files found");
  process.exit(1);
}

const merged: ParsedLabeling = { labeled: [], unlabeled: 0, invalid: [] };
for (const file of files) {
  const parsed = parseLabelingText(fs.readFileSync(file, "utf8"));
  merged.labeled.push(...parsed.labeled);
  merged.unlabeled += parsed.unlabeled;
  merged.invalid.push(...parsed.invalid);
}

process.stdout.write(`files: ${files.length}\n${formatLabelingReport(scoreLabels(merged.labeled), merged)}`);
