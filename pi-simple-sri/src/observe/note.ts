import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readObserveConfigOf, readSriConfigOf, type ObserveConfigReader } from "../config.ts";
import { eligibilityOfSkill } from "../eligibility.ts";
import { sha256Hex } from "../hash.ts";
import { listEligibleSkills, type ImproveFlowContext, type ImproveFlowDeps } from "../improve-flow.ts";
import { findSkill, listSkills } from "../skills-inventory.ts";
import type { NotEligibleReason, SkillRef } from "../types.ts";
import { currentTime, cutCodePoints } from "../values.ts";
import { writeBase } from "../write-base.ts";
import { redactSecrets } from "./redact.ts";
import { appendObserveEvents, foldObserveState, readObserveLog } from "./store.ts";
import { MAX_SUMMARY_CHARS, OBSERVE_FORMAT, SOURCE_WEIGHTS, observeId, type ObservationEvent, type ObserveEvent } from "./types.ts";

// The observation a user note (the command) or a self-report (the tool) appends to the observer log, from one place so the
// two sources cannot disagree about the weight, the anchor or the pattern. The anchor is the last user message of the
// branch, steering included: the note is about what the user just asked for. The text is redacted and cut before it is
// stored. The id covers the source, the session, the anchor and the text, so the same note on the same message is recorded
// once and a second, different note on it is not lost. A note joins the latest pattern of the same skill and source, which
// is what lets notes of several sessions add up; with none it opens one. Appends take no lock (the log is O_APPEND).
export interface ObservationLog {
  read(base: string): Promise<ObserveEvent[]>;
  append(base: string, events: readonly ObserveEvent[]): Promise<void>;
}

export interface ObservationDeps extends ImproveFlowDeps {
  readObserveConfig?: ObserveConfigReader;
  observeLog?: ObservationLog;
}

export interface ObservationInput {
  source: "user-note" | "self-report";
  skillName: string;
  text: string;
}

export type RecordObservationResult =
  | { kind: "recorded"; event: ObservationEvent }
  | { kind: "observe-disabled" }
  | { kind: "no-user-message" }
  | { kind: "unknown-skill"; skillName: string; standalone: SkillRef | null; eligible: readonly SkillRef[] }
  | { kind: "not-eligible"; skill: SkillRef; reason: NotEligibleReason };

function lastUserEntryId(branch: ReturnType<ImproveFlowContext["sessionManager"]["getBranch"]>): string | null {
  for (const entry of [...branch].reverse()) {
    if (entry.type === "message" && entry.message.role === "user") return entry.id;
  }
  return null;
}

export async function recordObservation(
  input: ObservationInput,
  ctx: ImproveFlowContext,
  deps: ObservationDeps,
): Promise<RecordObservationResult> {
  const agentDir = deps.agentDir ?? getAgentDir();
  if (!readObserveConfigOf(agentDir, deps.readObserveConfig).enabled) return { kind: "observe-disabled" };

  const anchorEntryId = lastUserEntryId(ctx.sessionManager.getBranch());
  if (anchorEntryId === null) return { kind: "no-user-message" };

  const skills = await (deps.listSkills ?? listSkills)({ cwd: ctx.cwd, agentDir });
  const skill = findSkill(skills, input.skillName);
  if (skill === undefined) {
    const standalone = skills.find((entry) => entry.kind === "standalone" && entry.name === input.skillName) ?? null;
    return { kind: "unknown-skill", skillName: input.skillName, standalone, eligible: await listEligibleSkills(ctx, deps) };
  }

  const eligibility = eligibilityOfSkill(skill, deps.config ?? readSriConfigOf(agentDir, deps.readConfig));
  if (!eligibility.eligible) return { kind: "not-eligible", skill, reason: eligibility.reason };

  const now = (deps.now ?? currentTime)();
  const base = deps.base ?? writeBase(agentDir);
  const log: ObservationLog = deps.observeLog ?? { read: readObserveLog, append: appendObserveEvents };

  const summary = cutCodePoints(redactSecrets(input.text.trim()).text, MAX_SUMMARY_CHARS);
  const sessionId = ctx.sessionManager.getSessionId();
  const kind = `${input.source}:${sha256Hex(summary).slice(0, 8)}`;
  const id = observeId("ob", [input.source, sessionId, anchorEntryId, kind]);

  const state = foldObserveState(await log.read(base), now);
  const known = state.observations.find((observation) => observation.id === id);
  if (known !== undefined) return { kind: "recorded", event: known };

  const event: ObservationEvent = {
    format: OBSERVE_FORMAT,
    type: "observation",
    at: now.toISOString(),
    id,
    episodeId: null,
    sessionId,
    skill: skill.name,
    source: input.source,
    kind,
    summary,
    confidence: null,
    weight: SOURCE_WEIGHTS[input.source],
    anchorEntryId,
    patternId:
      state.observations.filter((o) => o.skill === skill.name && o.source === input.source).at(-1)?.patternId ??
      observeId("pt", [skill.name, id]),
  };
  await log.append(base, [event]);
  return { kind: "recorded", event };
}
