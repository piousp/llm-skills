import fs from "node:fs";
import path from "node:path";
import { readCaseBank } from "../case-bank.ts";
import { readLedger } from "../ledger.ts";
import { OBSERVE_FILE, SIGNALS_FILE } from "../names.ts";
import { isDirectory, isMissingPathError, isPlainObject } from "../values.ts";
import { banksDir, relativeToBase, stagingDir, stateDir } from "../write-base.ts";
import { appendObserveLine, clearDecisionFocus, clearHistoryDecisionFocus, eraseStagingBank, eraseStagingContent, removeFileIn, removeStagingDir, writePrivateFile } from "../writer.ts";
import { bankPathOf } from "./banks.ts";
import { withScanLock } from "./lock.ts";
import { OBSERVE_FORMAT } from "./types.ts";

// `--forget <skill>`: erases what the observer and the signal collector hold about one skill, under the lock of the scan.
//
// It removes the skill's events from state/observe.jsonl (and what hangs from its episodes and proposals), every signal of
// state/signals.jsonl whose id was consumed for that skill, the content of its candidates that were never accepted (lessons,
// bank copy and the raw runs of the gate), the bank copy and the raw runs of the accepted ones (they hold verbatim prompts and
// replay transcripts), the drafts of banks generated for it (staging/observer-banks) and the bank banks/<skill>.json when its
// provenance is auto. It keeps attempts.jsonl, the history of accepted lessons, the lesson copy of accepted candidates, user and
// skill-shipped banks, and the decision.json of every candidate, the record of an accepted one in the history of the skill
// included -- with `trigger.focus` and `diagnosis.summary` (which quotes it) set to null, because the focus names the pattern:
// what was decided is an audit, what was said is not. It appends the `forget` event FIRST, under the lock, so a failure later
// never leaves a half-forgotten skill without its cutoff: a session older than the forget that is scanned again does not bring
// the skill back (foldObserveState). A history record that cannot be cleared (a path outside the .history of the skill, a
// moved skill, a missing file) is reported in `historySkipped` and never thrown.

export type ForgetReport =
  | { status: "locked" }
  | {
      status: "forgotten";
      observeRemoved: number;
      signalsRemoved: number;
      // Relative to the base, sorted.
      stagingErased: string[];
      // There is no staging directory at all (nothing was ever staged, or it was cleaned): not an error.
      stagingMissing: boolean;
      // Relative to the base. A bank is removed only when the observer generated it; the others are kept and listed.
      banksRemoved: string[];
      banksKept: string[];
      // Directories of generated-bank drafts removed from staging/observer-banks.
      draftsRemoved: number;
      // Files of the raw runs of the gate (gate/runs) removed from the candidates nobody accepted.
      runsRemoved: number;
      // decision.json files whose focus/summary were nulled: staging and history.
      recordsCleared: number;
      // Absolute paths of accepted records that could not be cleared (outside .history, missing, moved skill), sorted.
      historySkipped: string[];
    };

interface Rewrite {
  removed: number;
}

const OBSERVER_BANKS_DIR = "observer-banks";
const GATE_DIR = "gate";
const RUNS_DIR = "runs";

// A skill name is a path segment of its bank and its drafts; a name that is not one has neither.
function isOwnName(skill: string): boolean {
  return skill !== "" && path.basename(skill) === skill;
}

// Rewrites `file` keeping the lines `keep` accepts. `plan` reads the whole text once and answers the predicate for it; a
// text that changed between that read and the one right before the write -- somebody appended -- is planned again, so the
// rename does not drop the line. What remains is the instant between that read and the rename, which is accepted. A line
// that is not JSON is dropped: it is unusable and may hold what is being forgotten. Nothing is written when nothing goes.
async function rewriteFile(file: string, root: string, plan: (lines: unknown[]) => (line: unknown) => boolean): Promise<Rewrite> {
  const read = async (): Promise<string | null> => {
    try {
      return await fs.promises.readFile(file, "utf8");
    } catch (error) {
      if (isMissingPathError(error)) return null;
      throw error;
    }
  };

  const filtered = (text: string): { kept: string[]; removed: number } => {
    const raw = text.split("\n");
    raw.pop();
    const parsed = raw.map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return undefined;
      }
    });
    const keep = plan(parsed);
    const kept: string[] = [];
    for (const [index, line] of raw.entries()) {
      if (parsed[index] !== undefined && keep(parsed[index])) kept.push(line);
    }
    return { kept, removed: raw.length - kept.length };
  };

  const first = await read();
  if (first === null) return { removed: 0 };
  let result = filtered(first);

  const latest = await read();
  if (latest !== null && latest !== first) result = filtered(latest);
  if (result.removed === 0) return { removed: 0 };

  await writePrivateFile(file, result.kept.map((line) => `${line}\n`).join(""), root);
  return { removed: result.removed };
}

function idsWhere(lines: readonly unknown[], pick: (line: Record<string, unknown>) => string | undefined): Set<string> {
  const ids = new Set<string>();
  for (const line of lines) {
    if (!isPlainObject(line)) continue;
    const id = pick(line);
    if (id !== undefined) ids.add(id);
  }
  return ids;
}

// What observe.jsonl holds of the skill: its episodes, observations, proposals, prepare failures and tombstones, the `judged` of those
// episodes, and the prompts and gate outcomes of those proposals. The `forget` events stay.
function observePlan(skill: string): (lines: unknown[]) => (line: unknown) => boolean {
  return (lines) => {
    const episodes = idsWhere(lines, (line) => (line.type === "episode" && line.skill === skill ? String(line.id) : undefined));
    const proposals = idsWhere(lines, (line) => (line.type === "proposal" && line.skill === skill ? String(line.id) : undefined));

    return (line) => {
      if (!isPlainObject(line)) return true;
      switch (line.type) {
        case "episode":
        case "observation":
        case "proposal":
        case "tombstone":
        case "prepare-failed":
          return line.skill !== skill;
        case "judged":
          return !episodes.has(String(line.episodeId));
        case "prompt":
        case "gate-outcome":
          return !proposals.has(String(line.proposalId));
        default:
          return true;
      }
    };
  };
}

// The signals the user confirmed for the skill: every line of an id that has a `consumed` line naming it.
function signalsPlan(skill: string): (lines: unknown[]) => (line: unknown) => boolean {
  return (lines) => {
    const ids = idsWhere(lines, (line) =>
      line.event === "consumed" && line.skill === skill && typeof line.id === "string" ? line.id : undefined,
    );
    return (line) => !(isPlainObject(line) && typeof line.id === "string" && ids.has(line.id));
  };
}

// The candidates of the skill the index names: every staging directory, and the ones nobody accepted -- the lines whose hash
// an `accepted` line of the same skill does not carry (the staged candidate of an accepted lesson is its provenance).
interface HistoryRecord {
  skillRealDir: string;
  decisionPath: string;
}

// `histories` are the records of the acceptances of the skill (.history/<ts>/decision.json) the index names and the ledger could read: the
// skill directory comes from the record, the one thing that says where its history is.
async function candidatesOf(base: string, skill: string): Promise<{
  all: string[];
  unaccepted: string[];
  accepted: string[];
  histories: HistoryRecord[];
  unreadable: string[];
}> {
  const { lines } = await readLedger(base);
  const own = lines.filter((entry) => entry.line.targetSkill === skill);
  const histories = new Map<string, HistoryRecord>();
  const unreadable = new Set<string>();
  for (const entry of own) {
    if (entry.line.event !== "accepted" || entry.recordPath === null) continue;
    if (entry.record !== null) histories.set(entry.recordPath, { skillRealDir: entry.record.skill.realDir, decisionPath: entry.recordPath });
    else unreadable.add(entry.recordPath);
  }
  const accepted = new Set(own.filter((entry) => entry.line.event === "accepted").map((entry) => entry.line.candidateHash));

  const all = new Set<string>();
  const unaccepted = new Set<string>();
  const kept = new Set<string>();
  for (const { line } of own) {
    // The lines of an acceptance or a retirement name the history of the skill, not a staging directory.
    if (line.event === "accepted" || line.event === "retired") continue;
    const named = line.stagingPath ?? (line.decisionPath === undefined ? undefined : path.dirname(line.decisionPath));
    if (typeof named !== "string" || named === "") continue;
    all.add(named);
    if (accepted.has(line.candidateHash)) kept.add(named);
    else unaccepted.add(named);
  }
  return {
    all: [...all],
    unaccepted: [...unaccepted].filter((named) => !kept.has(named)),
    accepted: [...kept],
    histories: [...histories.values()],
    unreadable: [...unreadable],
  };
}

// The drafts of the banks the observer generated for the skill wait in staging/observer-banks/<skill>-<12 hex>. The suffix is
// matched whole, so the drafts of a skill whose name starts with this one's (`demo` and `demo-skill`) are never taken.
function draftDirsOf(base: string, skill: string): string[] {
  const root = path.join(stagingDir(base), OBSERVER_BANKS_DIR);
  if (!isDirectory(root)) return [];
  const own = new RegExp(`^${skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-[0-9a-f]{12}$`);
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && own.test(entry.name))
    .map((entry) => path.join(root, entry.name))
    .sort();
}

interface BanksForgotten {
  removed: string[];
  kept: string[];
}

// The bank of the user for the skill goes only when the observer generated it (provenance auto): a bank the user wrote or the
// skill ships is theirs, and a bank that cannot be read is not known to be generated, so it stays. Both are reported.
async function forgetBank(base: string, skill: string): Promise<BanksForgotten> {
  const report: BanksForgotten = { removed: [], kept: [] };
  const bankPath = bankPathOf(base, skill);
  const read = await readCaseBank(bankPath, "baseline");
  if (!read.ok && read.error.error === "absent") return report;

  if (read.ok && (read.value.bank.provenance ?? "user") === "auto") {
    await removeFileIn(bankPath, banksDir(base));
    report.removed.push(relativeToBase(base, bankPath));
  } else {
    report.kept.push(relativeToBase(base, bankPath));
  }
  return report;
}

export interface ArtifactsDiscarded {
  draftsRemoved: number;
  runsRemoved: number;
  stagingErased: string[];
  banksRemoved: string[];
  banksKept: string[];
  recordsCleared: number;
  historySkipped: string[];
}

// The artifact half of `--forget`: drafts, the content of candidates nobody accepted, trigger.focus and the generated bank. It
// touches neither observe.jsonl nor signals.jsonl and appends no event, so it needs no scan lock: a cycle that already holds
// it (or `--forget` itself) can call it.
export async function discardSkillArtifacts(base: string, skill: string): Promise<ArtifactsDiscarded> {
  const resolvedBase = path.resolve(base);
  const stagingErased: string[] = [];
  let runsRemoved = 0;
  let draftsRemoved = 0;

  let recordsCleared = 0;
  const historySkipped: string[] = [];
  const { all, unaccepted, accepted, histories, unreadable } = await candidatesOf(resolvedBase, skill);

  // eraseStagingContent refuses a base with no staging directory, and a base that never staged anything is a normal base.
  if (isDirectory(stagingDir(resolvedBase))) {
    for (const candidate of unaccepted) {
      stagingErased.push(...(await eraseStagingContent(resolvedBase, candidate)));
      runsRemoved += await removeStagingDir(resolvedBase, path.join(candidate, GATE_DIR, RUNS_DIR));
    }
    // An accepted candidate keeps its lesson and decision.json, but its bank copy and gate runs hold verbatim prompts and transcripts.
    for (const candidate of accepted) {
      stagingErased.push(...(await eraseStagingBank(resolvedBase, candidate)));
      runsRemoved += await removeStagingDir(resolvedBase, path.join(candidate, GATE_DIR, RUNS_DIR));
    }
    // The pattern the candidate was proposed for is in its decision.json, accepted or not.
    for (const candidate of all) if (await clearDecisionFocus(resolvedBase, candidate)) recordsCleared += 1;

    if (isOwnName(skill)) {
      for (const draft of draftDirsOf(resolvedBase, skill)) {
        await removeStagingDir(resolvedBase, draft);
        draftsRemoved += 1;
      }
    }
  }

  // The record of an acceptance is in the skill and outlives staging. One that cannot be cleared is reported, never thrown, and a
  // path that leaves the history of the skill is refused by the writer, never followed.
  historySkipped.push(...unreadable);
  for (const history of histories) {
    try {
      if (await clearHistoryDecisionFocus(history.skillRealDir, history.decisionPath)) recordsCleared += 1;
      else if (!fs.existsSync(history.decisionPath)) historySkipped.push(history.decisionPath);
    } catch {
      historySkipped.push(history.decisionPath);
    }
  }

  const banks = isOwnName(skill) ? await forgetBank(resolvedBase, skill) : { removed: [], kept: [] };

  return {
    draftsRemoved,
    runsRemoved,
    stagingErased: stagingErased.sort(),
    banksRemoved: banks.removed,
    banksKept: banks.kept,
    recordsCleared,
    historySkipped: [...new Set(historySkipped)].sort(),
  };
}

export async function forgetSkill(base: string, skill: string, now: Date): Promise<ForgetReport> {
  const resolvedBase = path.resolve(base);

  const locked = await withScanLock(resolvedBase, async (): Promise<Exclude<ForgetReport, { status: "locked" }>> => {
    const root = stateDir(resolvedBase);
    await appendObserveLine(resolvedBase, { format: OBSERVE_FORMAT, type: "forget", at: now.toISOString(), skill });
    const observe = await rewriteFile(path.join(root, OBSERVE_FILE), root, observePlan(skill));
    const signals = await rewriteFile(path.join(root, SIGNALS_FILE), root, signalsPlan(skill));

    const stagingMissing = !isDirectory(stagingDir(resolvedBase));
    const discarded = await discardSkillArtifacts(resolvedBase, skill);

    return { status: "forgotten", observeRemoved: observe.removed, signalsRemoved: signals.removed, stagingMissing, ...discarded };
  });

  return locked.ok ? locked.value : { status: "locked" };
}
