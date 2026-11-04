import fs from "node:fs";
import path from "node:path";
import { assertWritable } from "../perimeter.ts";
import type {
  GateArm,
  GateArmTally,
  GateTokenTally,
  GateTokens,
  ReplayItemRecord,
  ReplayRunRecord,
} from "../types.ts";
import { relativeToBase } from "../write-base.ts";
import { evaluateExpectation } from "./expectation.ts";
import type { GateRequest, GateSeams } from "./flow.ts";
import type { OverlayArms } from "./overlay.ts";
import type { GatePlan, GatePlanItem, ReplayRun, RunVerdict } from "./types.ts";

// The paired budget of the gate (M1, S8; M1c, S4): the order item -> rep -> (incumbent, candidate), the raw
// JSONL of every run persisted under the candidate, and the reading of each run against the expectation of its
// item. The verdict of the budget is not here: the scorer decides on the runs, and the flow writes them.
//
// It is its own module because the order and the persistence are the auditable contract of the gate: the two
// bases of M1c spend the same budget through this file, so a rule about where a stream is kept or which arm of
// a pair is started second cannot exist twice and cannot drift. Nothing here reads a decision.json, names a
// verdict, or writes a line of the index -- the flow keeps that sequence.
//
// Nothing here resolves a seam: every dependency arrives in BudgetInput with its production default already
// filled by the flow (GateDeps), and no function of this module starts a process the caller did not allow.

// OA9: the two caps of the plan, and neither is a setting. 180 s is the life of one run -- the runner stops
// the child at the deadline and insists five seconds later -- and 20 min is the life of the whole gate, which
// is checked between runs below, so an interruption costs at most the run that is in flight.
const RUN_TIMEOUT_MS = 180_000;
const GATE_TIMEOUT_MS = 20 * 60 * 1000;

// Where the raw stream of every run is kept, inside the candidate directory of staging:
// <candidate>/gate/runs/<item>-<rep>-<arm>.jsonl. The coordinates are the ones the run carried, so a reader
// of the record can find the bytes of any row without a second index.
const GATE_DIR = "gate";
const RUNS_DIR = "runs";
const RUN_STREAM_EXT = ".jsonl";

// What the budget of one gate produced: the verdicts the scorer reads, the items as the record shows them,
// how many runs were started, and the moment the gate gave up (null when it did not).
export interface BudgetResult {
  runs: RunVerdict[];
  items: ReplayItemRecord[];
  usedRuns: number;
  interruptedAt: number | null;
}

// One planned item, before its runs: the coordinates of the item and the expectation it is judged by, which are the
// fields the flow knows before the first run. The repetitions are what the budget adds.
export type PlannedItem = Omit<ReplayItemRecord, "reps">;

export interface BudgetInput {
  request: GateRequest;
  seams: GateSeams;
  plan: GatePlan;
  selected: readonly GatePlanItem[];
  models: readonly string[];
  sharedDirs: readonly (readonly string[])[];
  items: readonly PlannedItem[];
  candidateDir: string;
  arms: OverlayArms;
}

// Step 5 of the sequence: item -> rep -> (incumbent, candidate), which keeps the two arms of one pair
// adjacent in time, so a difference between them is about the section and not about the hour.
//
// The budget stops at the first run nobody can read (OA3): the arm it broke in is the baseline the other arm
// is compared against, so the rest of the twelve would be spent on a comparison the scorer has already
// refused. It stops the same way for an interruption, before starting a child.
export async function spendBudget(input: BudgetInput): Promise<BudgetResult> {
  const runsDir = prepareRunsDir(input.candidateDir);
  const arms: Record<GateArm, string> = {
    incumbent: input.arms.incumbentDir,
    candidate: input.arms.candidateDir,
  };
  const startedAt = input.seams.now().getTime();
  const runs: RunVerdict[] = [];
  // The records this function answers with: the item as the flow planned it, with the runs started here appended
  // to it in the order they were asked for. The array of the caller is read and never written.
  const items: ReplayItemRecord[] = input.items.map((planned) => ({ ...planned, reps: [] }));
  let usedRuns = 0;

  for (const [index, entry] of input.selected.entries()) {
    const item = items[index];

    for (let rep = 1; rep <= input.plan.design.reps; rep += 1) {
      for (const arm of input.plan.design.arms) {
        // OA9: the twenty minutes of the gate are checked between runs, so an interruption costs at most the
        // run that is in flight, and a caller that already gave up starts no child at all.
        const interruptedAt = interruptionOf(input.request.signal, startedAt, input.seams.now);
        if (interruptedAt !== null) return { runs, items, usedRuns, interruptedAt };

        // The order of `skillDirs` is the order pi loads them in: the arm first, then the rest of the set the
        // session had, so the skill under test is the copy and the others are the skills themselves (OA6).
        const run: ReplayRun = await input.seams.runReplay({
          item: index,
          rep,
          arm,
          prompt: entry.item.prompt,
          skillName: input.request.skill.name,
          skillDirs: [arms[arm], ...input.sharedDirs[index]],
          cwd: entry.item.cwd,
          model: input.models[index],
          timeoutMs: RUN_TIMEOUT_MS,
          ...(input.request.signal === undefined ? {} : { signal: input.request.signal }),
        });

        usedRuns += 1;
        const verdict = evaluateExpectation(entry.item.expectation, run);
        runs.push(verdict);

        // OA10: the raw stream is persisted before the next run starts, so an interruption leaves the bytes of
        // the run it cut on disk, and the record points at them.
        const stream = await persistStream({
          seams: input.seams,
          base: input.request.base,
          runsDir,
          run,
        });
        item.reps.push(runRecordOf(verdict, run, stream));

        if (run.outcome === "invalid") {
          const interrupted = run.invalidReason === "interrupted" ? input.seams.now().getTime() : null;
          return { runs, items, usedRuns, interruptedAt: interrupted };
        }
      }
    }
  }

  return { runs, items, usedRuns, interruptedAt: null };
}

// The gate's own directory inside the candidate: created here, so it is checked before it exists (I10), and
// guarded by the candidate directory, which is the narrowest root a run stream belongs to.
function prepareRunsDir(candidateDir: string): string {
  const runsDir = path.join(candidateDir, GATE_DIR, RUNS_DIR);
  assertWritable(runsDir, [candidateDir]);
  fs.mkdirSync(runsDir, { recursive: true });
  return runsDir;
}

// OA10: the bytes of one run, under the coordinates it carried. A run that wrote nothing has no file -- there
// are no bytes to keep and no path to point at -- and the record then carries no `stream` for it.
async function persistStream(input: {
  seams: GateSeams;
  base: string;
  runsDir: string;
  run: ReplayRun;
}): Promise<string | undefined> {
  const { request, rawStream } = input.run;
  if (rawStream === "") return undefined;

  const target = path.join(input.runsDir, `${request.item}-${request.rep}-${request.arm}${RUN_STREAM_EXT}`);
  await input.seams.writeStream(target, rawStream, input.runsDir);
  return relativeToBase(input.base, target);
}

// One run as the record shows it. The outcome is the verdict's and not the runner's: the runner can only say
// the process answered, and whether that answer passes is the reading of the expectation. The two fields the
// runner added are copied when it has them: the bytes the cap cut (OA10) and the cause the process gave. The checks
// the evaluator found failing travel the same way (M1c): the verdict declares a readonly list and the record a mutable
// one, so the copy is what keeps the record from aliasing a value the budget still holds.
function runRecordOf(verdict: RunVerdict, run: ReplayRun, stream: string | undefined): ReplayRunRecord {
  return {
    arm: run.request.arm,
    rep: run.request.rep,
    outcome: verdict.outcome,
    ...(verdict.invalidReason === undefined ? {} : { invalidReason: verdict.invalidReason }),
    ...(verdict.checkFailures === undefined ? {} : { checkFailures: [...verdict.checkFailures] }),
    ...(run.invalidDetail === undefined ? {} : { invalidDetail: run.invalidDetail }),
    stopReason: run.stopReason,
    skillLoaded: run.skillLoaded,
    usage: run.usage,
    durationMs: run.durationMs,
    exitCode: run.exitCode,
    ...(stream === undefined ? {} : { stream }),
    ...(run.truncatedAt === undefined ? {} : { truncatedAt: run.truncatedAt }),
  };
}

// The moment the gate has to stop, or null while it may keep spending. A caller that gave up outranks the
// clock: both are the same answer, and the run that was in flight is the interruption.
function interruptionOf(
  signal: AbortSignal | undefined,
  startedAt: number,
  now: () => Date,
): number | null {
  const at = now().getTime();
  if (signal?.aborted === true) return at;
  return at - startedAt >= GATE_TIMEOUT_MS ? at : null;
}

// What the whole decision spent, split by where it went. `total` is the sum of the three (Q6): a reader never
// adds them again, and the proposal is the number the record already carried before the gate ran.
export function tokenTallyOf(
  proposal: GateTokens,
  arms: { incumbent: GateArmTally; candidate: GateArmTally },
): GateTokenTally {
  const incumbent = arms.incumbent.tokens;
  const candidate = arms.candidate.tokens;

  return {
    proposal,
    incumbent,
    candidate,
    total: {
      input: proposal.input + incumbent.input + candidate.input,
      output: proposal.output + incumbent.output + candidate.output,
    },
  };
}
